import { StubHook, RpcPayload, typeForRpc, RpcStub, RpcPromise, LocatedPromise, unwrapStub, RpcTarget, PropertyPath } from "./core.js";

export type ImportId = number;
export type ExportId = number;

// =======================================================================================

export interface Exporter {
  exportStub(hook: StubHook): ExportId;
  exportPromise(hook: StubHook): ExportId;
  getImport(hook: StubHook): ImportId | undefined;

  // If a serialization error occurs after having exported some capabilities, this will be called
  // to roll back the exports.
  unexport(ids: Array<ExportId>): void;
}

class NullExporter implements Exporter {
  exportStub(stub: StubHook): never {
    throw new Error("Cannot serialize RPC stubs without an RPC session.");
  }
  exportPromise(stub: StubHook): never {
    throw new Error("Cannot serialize RPC stubs without an RPC session.");
  }
  getImport(hook: StubHook): ImportId | undefined {
    return undefined;
  }
  unexport(ids: Array<ExportId>): void {}
}

const NULL_EXPORTER = new NullExporter();

// Maps error name to error class for deserialization.
const ERROR_TYPES: Record<string, any> = {
  Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError,
  // TODO: DOMError? Others?
};

// Converts fully-hydrated messages into object trees that are JSON-serializable for sending over
// the wire. This is used to implement serialization -- but it doesn't take the last step of
// actually converting to a string. (The name is meant to be the opposite of "Evaluator", which
// implements the opposite direction.)
export class Devaluator {
  private constructor(private exporter: Exporter,
      private source: RpcPayload | undefined, private takeOwnership: boolean) {}

  // Devaluate the given value.
  // * value: The value to devaluate.
  // * parent: The value's parent object, which would be used as `this` if the value were called
  //     as a function.
  // * exporter: Callbacks to the RPC session for exporting capabilities found in this message.
  // * source: The RpcPayload which contains the value, and therefore owns stubs within.
  // * takeOwnership: If true, then the RPC system is to take ownership of all stubs found in the
  //     message, dismantling the payload (which should NOT be subsequently disposed). Otherwise,
  //     stubs must be dup()ed.
  //
  // Returns:
  // * value: The devaluated value, ready to be JSON-serialized.
  // * deferredDisposals: Contains hooks which should be disposed immediately after the
  //     devaluated message has been sent.
  public static devaluate(value: unknown, parent?: object, exporter: Exporter = NULL_EXPORTER,
      source?: RpcPayload, takeOwnership: boolean = true)
      : { value: unknown, deferredDisposals?: StubHook[] } {
    let devaluator = new Devaluator(exporter, source, takeOwnership);
    try {
      return {
        value: devaluator.devaluateImpl(value, parent, 0),
        deferredDisposals: devaluator.deferredDisposals,
      };
    } catch (err) {
      if (devaluator.exports) {
        try {
          exporter.unexport(devaluator.exports);
        } catch (err) {
          // probably a side effect of the original error, ignore it
        }
      }
      if (devaluator.deferredDisposals) {
        devaluator.deferredDisposals.forEach(d => d.dispose());
      }
      throw err;
    }
  }

  private exports?: Array<ExportId>;
  private deferredDisposals?: StubHook[];

  private devaluateImpl(value: unknown, parent: object | undefined, depth: number): unknown {
    if (depth >= 64) {
      throw new Error(
          "Serialization exceeded maximum allowed depth. (Does the message contain cycles?)");
    }

    let kind = typeForRpc(value);
    switch (kind) {
      case "unsupported":
        throw new TypeError("cannot serialize: " + value);

      case "primitive":
        // Supported directly by JSON.
        return value;

      case "object": {
        let object = <Record<string, unknown>>value;
        let result: Record<string, unknown> = {};
        for (let key in object) {
          result[key] = this.devaluateImpl(object[key], object, depth + 1);
        }
        return result;
      }

      case "array": {
        let array = <Array<unknown>>value;
        let len = array.length;
        let result = new Array(len);
        for (let i = 0; i < len; i++) {
          result[i] = this.devaluateImpl(array[i], array, depth + 1);
        }
        // Wrap literal arrays in an outer one-element array, to "escape" them.
        return [result];
      }

      case "date":
        return ["date", (<Date>value).getTime()];

      case "error": {
        let e = <Error>value;
        // TODO:
        // - Maybe serialize stack? There are security concerns, and also it's somewhat nonstandard.
        // - Determine type by checking prototype rather than `name`, which can be overridden?
        // - Serialize cause / supressed error / etc.
        // - Serialize added properties.
        return ["error", e.name, e.message];
      }

      case "stub":
      case "rpc-promise": {
        if (!this.source) {
          throw new Error("Can't serialize RPC stubs in this context.");
        }

        let {hook, pathIfPromise} = unwrapStub(<RpcStub>value);
        return this.devaluateHook(hook, pathIfPromise);
      }

      case "function":
      case "rpc-target": {
        if (!this.source) {
          throw new Error("Can't serialize RPC stubs in this context.");
        }

        let hook = this.source.getHookForRpcTarget(<RpcTarget|Function>value, parent);
        if (!this.takeOwnership) {
          // We're not supposed to take ownership of stubs we see, so we have to dup them instead.
          hook = hook.dup();
        }

        return this.devaluateHook(hook, undefined);
      }

      default:
        kind satisfies never;
        throw new Error("unreachable");
    }
  }

  private devaluateHook(hook: StubHook, pathIfPromise?: PropertyPath): unknown {
    let importId = this.exporter.getImport(hook);
    if (importId !== undefined) {
      if (pathIfPromise) {
        // It's a promise pointing back to the peer, so we are doing pipelining here.
        if (pathIfPromise.length > 0) {
          return ["pipeline", importId, pathIfPromise];
        } else {
          return ["pipeline", importId];
        }
      } else {
        if (this.takeOwnership) {
          if (!this.deferredDisposals) this.deferredDisposals = [];
          this.deferredDisposals.push(hook);
        }
        return ["import", importId];
      }
    }

    // OK, it wasn't an import, so we need to export the hook.
    if (!this.exports) this.exports = [];
    if (pathIfPromise) {
      // This is a promise. If it was passed from the app, we are not supposed to take
      // ownership of the hook.
      if ((this.source && this.source.isFromApp()) || !this.takeOwnership) {
        // Either this came directly from the app, so we are NOT supposed to take ownership of
        // it, or we've been explicitly instructed not to take ownership, so we have to
        // duplicate it (with get(), since it's a promise).
        hook = hook.get(pathIfPromise);
      } else {
        // The payload has already been deep-copied so it's not exactly what came from the app.
        // In that case, the deep-copy should have cloned this promise, and we may actually
        // take ownership of the clone. But the clone should definitely have resulted in an
        // empty path.
        if (pathIfPromise.length > 0) {
          throw new Error("RPC system bug: Unexpected uncloned promise in from-app payload.");
        }
      }

      let exportId = this.exporter.exportPromise(hook);
      this.exports.push(exportId);
      return ["promise", exportId];
    } else {
      if (!this.takeOwnership) {
        // We're not supposed to take ownership of stubs we see, so we have to dup them instead.
        hook = hook.dup();
      }

      let exportId = this.exporter.exportStub(hook);
      this.exports.push(exportId);
      return ["export", exportId];
    }
  }
}

export function serialize(value: unknown): string {
  return JSON.stringify(Devaluator.devaluate(value).value);
}

// =======================================================================================

export interface Importer {
  importStub(idx: ImportId): StubHook;
  importPromise(idx: ImportId): StubHook;
  getExport(idx: ExportId): StubHook | undefined;
}

class NullImporter implements Importer {
  importStub(idx: ImportId): never {
    throw new Error("Cannot deserialize RPC stubs without an RPC session.");
  }
  importPromise(idx: ImportId): never {
    throw new Error("Cannot deserialize RPC stubs without an RPC session.");
  }
  getExport(idx: ExportId): StubHook | undefined {
    return undefined;
  }
}

const NULL_IMPORTER = new NullImporter();

// Takes object trees parse from JSON and converts them into fully-hydrated JavaScript objects for
// delivery to the app. This is used to implement deserialization, except that it doesn't actually
// start from a raw string.
export class Evaluator {
  constructor(private importer: Importer) {}

  private stubs: RpcStub[] = [];
  private promises: LocatedPromise[] = [];

  public evaluate(value: unknown): RpcPayload {
    let payload = RpcPayload.forEvaluate(this.stubs, this.promises);
    try {
      payload.value = this.evaluateImpl(value, payload, "value");
      return payload;
    } catch (err) {
      payload.dispose();
      throw err;
    }
  }

  private evaluateImpl(value: unknown, parent: object, property: string | number): unknown {
    if (value instanceof Array) {
      if (value.length == 1 && value[0] instanceof Array) {
        // Escaped array. Evaluate the contents.
        let result = value[0];
        for (let i = 0; i < result.length; i++) {
          result[i] = this.evaluateImpl(result[i], result, i);
        }
        return result;
      } else switch (value[0]) {
        case "date":
          if (typeof value[1] == "number") {
            return new Date(value[1]);
          }
          break;
        case "error":
          if (value.length >= 3 && typeof value[1] === "string" && typeof value[2] === "string") {
            let cls = ERROR_TYPES[value[1]] || Error;
            return new cls(value[2]);
          }
          break;

        case "import":
        case "pipeline":
          // It's an "import" from the perspective of the sender, so it's an export from our
          // side. In other words, the sender is passing our own object back to us.

          if (value.length < 2 || value.length > 4) {
            break;   // report error below
          }

          // First parameter is import ID (from the sender's perspective, so export ID from
          // ours).
          if (typeof value[1] != "number") {
            break;   // report error below
          }

          let hook = this.importer.getExport(value[1]);
          if (!hook) {
            throw new Error(`no such entry on exports table: ${value[1]}`);
          }

          let isPromise = value[0] == "pipeline";

          let addStub = (hook: StubHook) => {
            if (isPromise) {
              let promise = new RpcPromise(hook, []);
              this.promises.push({promise, parent, property});
              return promise;
            } else {
              let stub = new RpcPromise(hook, []);
              this.stubs.push(stub);
              return stub;
            }
          };

          if (value.length == 2) {
            // Just referencing the export itself.
            if (isPromise) {
              // We need to use hook.get([]) to make sure we get a promise hook.
              return addStub(hook.get([]));
            } else {
              // dup() returns a stub hook.
              return addStub(hook.dup());
            }
          }

          // Second parameter, if given, is a property path.
          let path = value[2];
          if (!(path instanceof Array)) {
            break;  // report error below
          }
          if (!path.every(
              part => { return typeof part == "string" || typeof part == "number"; })) {
            break;  // report error below
          }

          if (value.length == 3) {
            // Just referencing the path, not a call.
            return addStub(hook.get(path));
          }

          // Third parameter, if given, is call arguments. The sender has identified a function
          // and wants us to call it.
          //
          // Usually this is used with "pipeline", in which case we evaluate to an
          // RpcPromise. However, this can be used with "import", in which case the caller is
          // asking that the result be coerced to RpcStub. This distinction matters if the
          // result of this evaluation is to be passed as arguments to another call -- promises
          // must be resolved in advance, but stubs can be passed immediately.
          let args = value[3];
          if (!(args instanceof Array)) {
            break;  // report error below
          }

          // We need a new evaluator for the args, to build a separate payload.
          let subEval = new Evaluator(this.importer);
          args = subEval.evaluate([args]);

          return addStub(hook.call(path, args));

        case "export":
        case "promise":
          // It's an "export" from the perspective of the sender, i.e. they sent us a new object
          // which we want to import.
          //
          // "promise" is same as "export" but should not be delivered to the application. If any
          // promises appear in a value, they must be resolved and substituted with their results
          // before delivery. Note that if the value being evaluated appeared in call params, or
          // appeared in a resolve message for a promise that is being pulled, then the new promise
          // is automatically also being pulled, otherwise it is not.
          if (typeof value[1] == "number") {
            if (value[0] == "promise") {
              let hook = this.importer.importPromise(value[1]);
              let promise = new RpcPromise(hook, []);
              this.promises.push({parent, property, promise});
              return promise;
            } else {
              let hook = this.importer.importStub(value[1]);
              let stub = new RpcStub(hook);
              this.stubs.push(stub);
              return stub;
            }
          }
          break;
      }
      throw new TypeError(`unknown special value: ${JSON.stringify(value)}`);
    } else if (value instanceof Object) {
      let result = <Record<string, unknown>>value;
      for (let key in result) {
        result[key] = this.evaluateImpl(result[key], result, key);
      }
      return result;
    } else {
      // Other JSON types just pass through.
      return value;
    }
  }
}

export function deserialize(value: string): unknown {
  let payload = new Evaluator(NULL_IMPORTER).evaluate(JSON.parse(value));
  payload.dispose();  // should be no-op but just in case
  return payload.value;
}
