import { StubHook, RpcPayload, RpcStub, unwrapStub, PropertyPath, PayloadStubHook, ErrorStubHook, RpcTarget } from "./core.js";
import { Devaluator, Evaluator, ExportId, ImportId, Exporter, Importer, serialize } from "./serialize.js";

// Interface for an RPC transport, which is a simple bidirectional message stream.
export interface RpcTransport {
  // Sends a message to the other end.
  send(message: string): Promise<void>;

  // Receives a message sent by the other end.
  //
  // If and when the transport becomes disconnected, this will reject. The thrown error will be
  // propagated to all outstanding calls and future calls on any stubs associated with the session.
  // If there are no outstanding calls (and none are made in the future), then the error does not
  // propagate anywhere -- this is considered a "clean" shutdown.
  receive(): Promise<string>;

  // Indicates that the RPC system has suffered an error that prevents the session from continuing.
  // The transport should ideally try to send any queued messages if it can, and then close the
  // connection. (It's not strictly necessary to deliver queued messages, but the last message sent
  // before abort() is called is often an "abort" message, which communicates the error to the
  // peer, so if that is dropped, the peer may have less information about what happened.)
  abort?(reason: any): void;
}

// Entry on the exports table.
type ExportTableEntry = {
  hook: StubHook,
  refcount: number,
  pull?: Promise<void>
};

// Entry on the imports table.
class ImportTableEntry {
  constructor(public session: RpcSessionImpl, public importId: number, pulling: boolean) {
    if (pulling) {
      this.activePull = Promise.withResolvers<void>();
    }
  }

  public localRefcount: number = 0;
  public remoteRefcount: number = 1;

  private activePull?: PromiseWithResolvers<void>;
  public resolution?: StubHook;

  resolve(resolution: StubHook) {
    // TODO: Need embargo handling here? PayloadStubHook needs to be wrapped in a
    // PromiseStubHook awaiting the embargo I suppose. Previous notes on embargoes:
    // - Resolve message specifies last call that was received before the resolve. The introducer is
    //   responsible for any embargoes up to that point.
    // - Any further calls forwarded by the introducer after that point MUST immediately resolve to
    //   a forwarded call. The caller is responsible for ensuring the last of these is handed off
    //   before direct calls can be delivered.

    this.resolution = resolution;
    this.sendRelease();

    if (this.localRefcount == 0) {
      this.resolution.dispose();
    }

    if (this.activePull) {
      this.activePull.resolve();
      this.activePull = undefined;
    }
  }

  async awaitResolution(): Promise<RpcPayload> {
    if (!this.activePull) {
      this.session.sendPull(this.importId);
      this.activePull = Promise.withResolvers<void>();
    }
    await this.activePull.promise;
    return this.resolution!.pull();
  }

  dispose() {
    if (this.resolution) {
      this.resolution.dispose();
    } else {
      this.abort(new Error("RPC was canceled because the RpcPromise was disposed."));
      this.sendRelease();
    }
  }

  abort(error: any) {
    if (!this.resolution) {
      this.resolution = new ErrorStubHook(error);

      if (this.activePull) {
        this.activePull.reject(error);
        this.activePull = undefined;
      }
    }
  }

  private sendRelease() {
    if (this.remoteRefcount > 0) {
      this.session.sendRelease(this.importId, this.remoteRefcount);
      this.remoteRefcount = 0;
    }
  }
};

class RpcImportHook extends StubHook {
  public entry?: ImportTableEntry;  // undefined when we're disposed

  // `pulling` is true if we already expect that this import is going to be resolved later, and
  // null if this import is not allowed to be pulled (i.e. it's a stub not a promise).
  constructor(public isPromise: boolean, entry: ImportTableEntry) {
    super();
    ++entry.localRefcount;
    this.entry = entry;
  }

  collectPath(path: PropertyPath): RpcImportHook {
    return this;
  }

  getEntry(): ImportTableEntry {
    if (this.entry) {
      return this.entry;
    } else {
      // Shouldn't get here in practice since the holding stub should have replaced the hook when
      // disposed.
      throw new Error("This RpcImportHook was already disposed.");
    }
  }

  // -------------------------------------------------------------------------------------
  // implements StubHook

  call(path: PropertyPath, args: RpcPayload): StubHook {
    let entry = this.getEntry();
    if (entry.resolution) {
      return entry.resolution.call(path, args);
    } else {
      return entry.session.sendCall(entry.importId, path, args);
    }
  }

  get(path: PropertyPath): StubHook {
    let entry = this.getEntry();
    if (entry.resolution) {
      return entry.resolution.get(path);
    } else {
      return entry.session.sendCall(entry.importId, path);
    }
  }

  dup(): RpcImportHook {
    return new RpcImportHook(false, this.getEntry());
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    let entry = this.getEntry();

    if (!this.isPromise) {
      throw new Error("Can't pull this hook because it's not a promise hook.");
    }

    if (entry.resolution) {
      return entry.resolution.pull();
    }

    return entry.awaitResolution();
  }

  dispose(): void {
    let entry = this.entry;
    this.entry = undefined;
    if (entry) {
      if (--entry.localRefcount === 0) {
        entry.dispose();
      }
    }
  }
}

class RpcSessionImpl implements Importer, Exporter {
  private exports: Array<ExportTableEntry> = [];
  private reverseExports: Map<StubHook, ExportId> = new Map();
  private imports: Array<ImportTableEntry> = [];
  private abortReason?: any;
  private cancelReadLoop: (error: any) => void;

  // We assign positive numbers to imports we initiate, and negative numbers to exports we
  // initiate. So the next import ID is just `imports.length`, but the next export ID needs
  // to be tracked explicitly.
  private nextExportId = -1;

  constructor(private transport: RpcTransport, mainHook: StubHook) {
    // Export zero is automatically the bootstrap object.
    this.exports.push({hook: mainHook, refcount: 1});

    // Import zero is the other side's bootstrap object.
    this.imports.push(new ImportTableEntry(this, 0, false));

    let rejectFunc: (error: any) => void;;
    let abortPromise = new Promise<never>((resolve, reject) => { rejectFunc = reject; });
    this.cancelReadLoop = rejectFunc!;

    this.readLoop(abortPromise).catch(err => this.abort(err));
  }

  // Should only be called once immediately after construction.
  getMainImport(): RpcImportHook {
    return new RpcImportHook(false, this.imports[0]);
  }

  exportStub(hook: StubHook): ExportId {
    if (this.abortReason) throw this.abortReason;

    let existingExportId = this.reverseExports.get(hook);
    if (existingExportId !== undefined) {
      ++this.exports[existingExportId].refcount;
      return existingExportId;
    } else {
      let exportId = this.nextExportId--;
      this.exports[exportId] = { hook, refcount: 1 };
      this.reverseExports.set(hook, exportId);
      return exportId;
    }
  }

  exportPromise(hook: StubHook): ExportId {
    if (this.abortReason) throw this.abortReason;

    // Promises always use a new ID because otherwise the recipient could miss the resolution.
    let exportId = this.nextExportId--;
    this.exports[exportId] = { hook, refcount: 1 };
    this.reverseExports.set(hook, exportId);

    // Automatically start resolving any promises we send.
    this.ensureResolvingExport(exportId);
    return exportId;
  }

  unexport(ids: Array<ExportId>): void {
    for (let id of ids) {
      this.releaseExport(id, 1);
    }
  }

  private releaseExport(exportId: ExportId, refcount: number) {
    let entry = this.exports[exportId];
    if (!entry) {
      throw new Error(`no such export ID: ${exportId}`);
    }
    if (entry.refcount < refcount) {
      throw new Error(`refcount would go negative: ${entry.refcount} < ${refcount}`);
    }
    entry.refcount -= refcount;
    if (entry.refcount === 0) {
      delete this.exports[exportId];
      this.reverseExports.delete(entry.hook);
      entry.hook.dispose();
    }
  }

  private ensureResolvingExport(exportId: ExportId) {
    let exp = this.exports[exportId];
    if (!exp) {
      throw new Error(`no such export ID: ${exportId}`);
    }
    if (!exp.pull) {
      let resolve = async () => {
        let hook = exp.hook;
        for (;;) {
          let payload = await hook.pull();
          if (payload.value instanceof RpcStub) {
            let {hook: inner, pathIfPromise} = unwrapStub(payload.value);
            if (pathIfPromise && pathIfPromise.length == 0) {
              if (this.getImport(hook) === undefined) {
                // Optimization: The resolution is just another promise, and it is not a promise
                // pointing back to the peer. So if we send a resolve message, it's just going to
                // resolve to another new promise export, which is just going to have to wait for
                // another resolve message later. This intermediate resolve message gives the peer
                // no useful information, so let's skip it and just wait for the chained
                // resolution.
                hook = inner;
                continue;
              }
            }
          }

          return payload;
        }
      };

      exp.pull = resolve().then(
        payload => {
          // We don't transfer ownership of stubs in the payload since the payload
          // belongs to the hook which sticks around to handle pipelined requests.
          let {value, deferredDisposals} = Devaluator.devaluate(
              payload.value, undefined, this, payload, /*takeOwnership=*/false);
          this.send(["resolve", exportId, value]);
          if (deferredDisposals) {
            deferredDisposals?.forEach(d => d.dispose());
          }
        },
        error => {
          this.send(["reject", exportId, Devaluator.devaluate(error).value]);
        }
      ).catch(
        error => {
          // If serialization failed, report the serialization error, which should
          // itself always be serializable.
          try {
            this.send(["reject", exportId, Devaluator.devaluate(error).value]);
          } catch (error2) {
            // TODO: Shouldn't happen, now what?
            this.abort(error2);
          }
        }
      );
    }
  }

  getImport(hook: StubHook): ImportId | undefined {
    if (hook instanceof RpcImportHook && hook.entry && hook.entry.session === this) {
      return hook.entry.importId;
    } else {
      return undefined;
    }
  }

  importStub(idx: ImportId): RpcImportHook {
    if (this.abortReason) throw this.abortReason;

    let entry = this.imports[idx];
    if (!entry) {
      entry = new ImportTableEntry(this, idx, false);
      this.imports[idx] = entry;
    }
    return new RpcImportHook(/*isPromise=*/false, entry);
  }

  importPromise(idx: ImportId): StubHook {
    if (this.abortReason) throw this.abortReason;

    if (this.imports[idx]) {
      // Can't reuse an existing ID for a promise!
      return new ErrorStubHook(new Error(
          "Bug in RPC system: The peer sent a promise reusing an existing export ID."));
    }

    // Create an already-pulling hook.
    let entry = new ImportTableEntry(this, idx, true);
    this.imports[idx] = entry;
    return new RpcImportHook(/*isPromise=*/true, entry);
  }

  getExport(idx: ExportId): StubHook | undefined {
    return this.exports[idx]?.hook;
  }

  private send(msg: any) {
    if (this.abortReason !== undefined) {
      // Ignore sends after we've aborted.
      return;
    }

    let msgText: string;
    try {
      msgText = JSON.stringify(msg);
    } catch (err) {
      // TODO: rollback refcounts
      throw err;
    }

    this.transport.send(msgText)
        // If send fails, abort the connection, but don't try to send an abort message since
        // that'll probably also fail.
        .catch(err => this.abort(err, false));
  }

  sendCall(id: ImportId, path: PropertyPath, args?: RpcPayload): RpcImportHook {
    if (this.abortReason) throw this.abortReason;

    let value: Array<any> = ["pipeline", id, path];
    let deferredDisposals: StubHook[] | undefined;
    if (args) {
      let devalue = Devaluator.devaluate(
          args.value, undefined, this, args, /*takeOwnership=*/true);
      deferredDisposals = devalue.deferredDisposals;

      // HACK: Since the args is an array, devaluator will wrap in a second array. Need to unwrap.
      // TODO: Clean this up somehow.
      value.push((<Array<unknown>>devalue.value)[0]);

      // Serializing the payload takes ownership of all stubs within, so the payload itself does
      // not need to be disposed.
    }
    this.send(["push", value]);

    if (deferredDisposals) {
      deferredDisposals?.forEach(d => d.dispose());
    }

    let entry = new ImportTableEntry(this, this.imports.length, false);
    this.imports.push(entry);
    return new RpcImportHook(/*isPromise=*/true, entry);
  }

  sendPull(id: ImportId) {
    if (this.abortReason) throw this.abortReason;

    this.send(["pull", id]);
  }

  sendRelease(id: ImportId, remoteRefcount: number) {
    if (this.abortReason) return;

    this.send(["release", id, remoteRefcount]);
    delete this.imports[id];
  }

  abort(error: any, trySendAbortMessage: boolean = true) {
    // Don't double-abort.
    if (this.abortReason !== undefined) return;

    this.cancelReadLoop(error);

    if (trySendAbortMessage) {
      try {
        this.transport.send(JSON.stringify(["abort", Devaluator
            .devaluate(error, undefined, this)]));
      } catch (err) {
        // ignore, probably the whole reason we're aborting is because the transport is broken
      }
    }

    if (error === undefined) {
      // Shouldn't happen, but if it does, avoid setting `abortReason` to `undefined`.
      error = "undefined";
    }

    this.abortReason = error;

    if (this.transport.abort) {
      // Call transport's abort handler, but guard against buggy app code.
      try {
        this.transport.abort(error);
      } catch (err) {
        // Treat as unhandled rejection.
        Promise.resolve(err);
      }
    }

    // WATCH OUT: this.imports and this.exports are sparse arrays. `for/let/of` will iterate
    // only positive indexes including deleted indexes -- bad. We need to use `for/let/in` instead.
    for (let i in this.imports) {
      this.imports[i].abort(error);
    }
    for (let i in this.exports) {
      this.exports[i].hook.dispose();
    }
  }

  private async readLoop(abortPromise: Promise<never>) {
    while (!this.abortReason) {
      let msg = JSON.parse(await Promise.race([this.transport.receive(), abortPromise]));
      if (this.abortReason) break;  // check again before processing

      if (msg instanceof Array) {
        switch (msg[0]) {
          case "push":  // ["push", Expression]
            if (msg.length > 1) {
              let payload = new Evaluator(this).evaluate(msg[1]);
              this.exports.push({
                hook: new PayloadStubHook(payload),
                refcount: 1
              });
              continue;
            }
            break;

          case "pull": {  // ["pull", ImportId]
            let exportId = msg[1];
            if (typeof exportId == "number") {
              this.ensureResolvingExport(exportId);
              continue;
            }
            break;
          }

          case "resolve":   // ["resolve", ExportId, Expression]
          case "reject": {  // ["reject", ExportId, Expression]
            let importId = msg[1];
            if (typeof importId == "number" && msg.length > 2) {
              let imp = this.imports[importId];
              if (imp) {
                if (msg[0] == "resolve") {
                  imp.resolve(new PayloadStubHook(new Evaluator(this).evaluate(msg[2])));
                } else {
                  // HACK: We expect errors are always simple values (no stubs) so we can just
                  //   pull the value out of the payload.
                  let payload = new Evaluator(this).evaluate(msg[2]);
                  payload.dispose();  // just in case -- should be no-op
                  imp.resolve(new ErrorStubHook(payload.value));
                }
              } else {
                // Import ID is not found on the table. Probably we released it already, in which
                // case we do not care about the resolution, so whatever.

                if (msg[0] == "resolve") {
                  // We need to evaluate the resolution and immediately dispose it so that we
                  // release any stubs it contains.
                  new Evaluator(this).evaluate(msg[2]).dispose();
                }
              }
              continue;
            }
            break;
          }

          case "release": {
            let exportId = msg[1];
            let refcount = msg[2];
            if (typeof exportId == "number" && typeof refcount == "number") {
              this.releaseExport(exportId, refcount);
              continue;
            }
            break;
          }

          case "abort": {
            let payload = new Evaluator(this).evaluate(msg[1]);
            payload.dispose();  // just in case -- should be no-op
            this.abort(payload, false);
            break;
          }
        }
      }

      throw new Error(`bad RPC message: ${JSON.stringify(msg)}`);
    }
  }

  getStats(): {imports: number, exports: number} {
    let result = {imports: 0, exports: 0};
    // We can't just use `.length` because the arrays can be sparse and can have negative indexes.
    for (let i in this.imports) {
      ++result.imports;
    }
    for (let i in this.exports) {
      ++result.exports;
    }
    return result;
  }
}

// Public interface that wraps RpcSession and hides private implementation details (even from
// JavaScript with no type enforcement).
export class RpcSession {
  #session: RpcSessionImpl;
  #mainStub: RpcStub;

  constructor(transport: RpcTransport, localMain?: any) {
    let mainHook: StubHook;
    if (localMain) {
      mainHook = new PayloadStubHook(RpcPayload.fromApp(localMain));
    } else {
      mainHook = new ErrorStubHook(new Error("This connection has no main object."));
    }
    this.#session = new RpcSessionImpl(transport, mainHook);
    this.#mainStub = new RpcStub(this.#session.getMainImport());
  }

  getRemoteMain(): RpcStub {
    return this.#mainStub;
  }

  getStats(): {imports: number, exports: number} {
    return this.#session.getStats();
  }
}
