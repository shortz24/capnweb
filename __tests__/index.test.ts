import { expect, it, describe, inject } from "vitest"
import { deserialize, serialize, RpcSession, type RpcSessionOptions, RpcTransport, RpcTarget, RpcStub, newWebSocketRpcSession } from "../src/index.js"
import { Counter, TestTarget } from "./test-util.js";

let SERIALIZE_TEST_CASES: Record<string, unknown> = {
  '123': 123,
  'null': null,
  '"foo"': "foo",
  'true': true,

  '{"foo":123}': {foo: 123},
  '{"foo":{"bar":123,"baz":456},"qux":789}': {foo: {bar: 123, baz: 456}, qux: 789},

  '[[123]]': [123],
  '[[[[123,456]]]]': [[123, 456]],
  '{"foo":[[123]]}': {foo: [123]},
  '{"foo":[[123]],"bar":[[456,789]]}': {foo: [123], bar: [456, 789]},

  '["date",1234]': new Date(1234),
  '["undefined"]': undefined,
  '["error","Error","the message"]': new Error("the message"),
  '["error","TypeError","the message"]': new TypeError("the message"),
  '["error","RangeError","the message"]': new RangeError("the message"),
};

class NotSerializable {
  i: number;
  constructor(i: number) {
    this.i = i;
  }
  toString() {
    return `NotSerializable(${this.i})`;
  }
}

describe("simple serialization", () => {
  it("can serialize", () => {
    for (let key in SERIALIZE_TEST_CASES) {
      expect(serialize(SERIALIZE_TEST_CASES[key])).toBe(key);
    }
  })

  it("can deserialize", () => {
    for (let key in SERIALIZE_TEST_CASES) {
      expect(deserialize(key)).toStrictEqual(SERIALIZE_TEST_CASES[key]);
    }
  })

  it("throws an error if the value can't be serialized", () => {
    expect(() => serialize(new NotSerializable(123))).toThrowError(
      new TypeError("cannot serialize: NotSerializable(123)")
    );
  })

  it("throws an error for circular references", () => {
    let obj: any = {};
    obj.self = obj;
    expect(() => serialize(obj)).toThrowError(
      "Serialization exceeded maximum allowed depth. (Does the message contain cycles?)"
    );
  })

  it("can serialize complex nested structures", () => {
    let complex = {
      level1: {
        level2: {
          level3: {
            array: [1, 2, { nested: "deep" }],
            date: new Date(5678),
            nullVal: null,
            undefinedVal: undefined
          }
        }
      },
      top_array: [[1, 2], [3, 4]]
    };
    let serialized = serialize(complex);
    expect(deserialize(serialized)).toStrictEqual(complex);
  })

  it("throws errors for malformed deserialization data", () => {
    expect(() => deserialize('{"unclosed": ')).toThrowError();
    expect(() => deserialize('["unknown_type", "param"]')).toThrowError();
    expect(() => deserialize('["date"]')).toThrowError(); // missing timestamp
    expect(() => deserialize('["error"]')).toThrowError(); // missing type and message
  })
});

// =======================================================================================

class TestTransport implements RpcTransport {
  constructor(public name: string, private partner?: TestTransport) {
    if (partner) {
      partner.partner = this;
    }
  }

  private queue: string[] = [];
  private waiter?: () => void;
  private aborter?: (err: any) => void;
  public log = false;

  async send(message: string): Promise<void> {
    // HACK: If the string "$remove$" appears in the message, remove it. This is used in some
    //   tests to hack the RPC protocol.
    message = message.replaceAll("$remove$", "");

    if (this.log) console.log(`${this.name}: ${message}`);
    this.partner!.queue.push(message);
    if (this.partner!.waiter) {
      this.partner!.waiter();
      this.partner!.waiter = undefined;
      this.partner!.aborter = undefined;
    }
  }

  async receive(): Promise<string> {
    if (this.queue.length == 0) {
      await new Promise<void>((resolve, reject) => {
        this.waiter = resolve;
        this.aborter = reject;
      });
    }

    return this.queue.shift()!;
  }

  forceReceiveError(error: any) {
    this.aborter!(error);
  }
}

function withoutDisposer(obj: any) {
  delete obj[Symbol.dispose];
  return obj;
}

// Spin the microtask queue a bit to give messages time to be delivered and handled.
async function pumpMicrotasks() {
  for (let i = 0; i < 16; i++) {
    await Promise.resolve();
  }
}

class TestHarness<T extends RpcTarget> {
  clientTransport: TestTransport;
  serverTransport: TestTransport;
  client: RpcSession<T>;
  server: RpcSession;

  stub: RpcStub<T>;

  constructor(target: T, serverOptions?: RpcSessionOptions) {
    this.clientTransport = new TestTransport("client");
    this.serverTransport = new TestTransport("server", this.clientTransport);

    this.client = new RpcSession<T>(this.clientTransport);

    // TODO: If I remove `<undefined>` here, I get a TypeScript error about the instantiation being
    //   excessively deep and possibly infinite. Why? `<undefined>` is supposed to be the default.
    this.server = new RpcSession<undefined>(this.serverTransport, target, serverOptions);

    this.stub = this.client.getRemoteMain();
  }

  // Enable logging of all messages sent. Useful for debugging.
  enableLogging() {
    this.clientTransport.log = true;
    this.serverTransport.log = true;
  }

  checkAllDisposed() {
    expect(this.client.getStats()).toStrictEqual({imports: 1, exports: 1});
    expect(this.server.getStats()).toStrictEqual({imports: 1, exports: 1});
  }

  async [Symbol.asyncDispose]() {
    try {
      // HACK: Spin the microtask loop for a bit to make sure dispose messages have been sent
      //   and received.
      await pumpMicrotasks();

      // Check at the end of every test that everything was disposed.
      this.checkAllDisposed();
    } catch (err) {
      // Don't throw from disposer as it may suppress the real error that caused the disposal in
      // the first place.

      // I couldn't find a better way to make vitest log a failure without throwing...
      let message: string;
      if (err instanceof Error) {
        message = err.stack || err.message;
      } else {
        message = `${err}`;
      }
      expect.soft(true, message).toBe(false);
    }
  }
}

describe("local stub", () => {
  it("supports wrapping an RpcTarget", async () => {
    let stub = new RpcStub(new TestTarget());
    expect(await stub.square(3)).toBe(9);
  });

  it("supports wrapping a function", async () => {
    // TODO: If we don't explicitly declare the type of `i` then the type system complains about
    //   too-deep recursion here. Why?
    let stub = new RpcStub((i :number) => i + 5);
    expect(await stub(3)).toBe(8);
  });

  it("supports wrapping an arbitrary object", async () => {
    let stub = new RpcStub({abc: "hello"});
    expect(await stub.abc).toBe("hello");
  });

  it("supports wrapping an object with nested stubs", async () => {
    let innerTarget = new TestTarget();
    let innerStub = new RpcStub(innerTarget);
    let outerObject = { inner: innerStub, value: 42 };
    let outerStub = new RpcStub(outerObject);

    expect(await outerStub.value).toBe(42);
    expect(await outerStub.inner.square(4)).toBe(16);
  });

  it("supports wrapping an object with nested RpcTargets", async () => {
    let innerTarget = new TestTarget();
    let outerObject = { inner: innerTarget, value: 42 };
    let outerStub = new RpcStub(outerObject);

    expect(await outerStub.value).toBe(42);
    expect(await outerStub.inner.square(4)).toBe(16);
  });

  it("supports wrapping an RpcTarget with nested stubs", async () => {
    class TargetWithStubs extends RpcTarget {
      getValue() { return 42; }

      get innerStub() {
        return new RpcStub(new TestTarget());
      }
    }

    let outerStub = new RpcStub(new TargetWithStubs());
    expect(await outerStub.getValue()).toBe(42);
    expect(await outerStub.innerStub.square(3)).toBe(9);
  });

  it("supports wrapping an RpcTarget with nested RpcTargets", async () => {
    class TargetWithTargets extends RpcTarget {
      getValue() { return 42; }

      get innerTarget() {
        return new TestTarget();
      }
    }

    let outerStub = new RpcStub(new TargetWithTargets());
    expect(await outerStub.getValue()).toBe(42);
    expect(await outerStub.innerTarget.square(3)).toBe(9);
  });

  it("throws error when accessing non-existent properties", async () => {
    let objectStub = new RpcStub({foo: "bar"});
    let arrayStub = new RpcStub([1, 2, 3]);
    let targetStub = new RpcStub(new TestTarget());

    await expect(() => (objectStub as any).nonExistent).rejects.toThrow("RPC object has no property 'nonExistent'");
    await expect(() => (arrayStub as any).nonExistent).rejects.toThrow("RPC object has no property 'nonExistent'");
    await expect(() => (targetStub as any).nonExistent).rejects.toThrow("RPC object has no property 'nonExistent'");
  });

  it("exposes only prototype properties for RpcTarget, not instance properties", async () => {
    class TargetWithProps extends RpcTarget {
      instanceProp = "instance";
      dynamicProp: string;

      constructor() {
        super();
        this.dynamicProp = "dynamic";
      }

      get prototypeProp() { return "prototype"; }
      prototypeMethod() { return "method"; }
    }

    let target = new TargetWithProps();
    let stub = new RpcStub(target);

    expect(await stub.prototypeProp).toBe("prototype");
    expect(await stub.prototypeMethod()).toBe("method");
    await expect(() => (stub as any).instanceProp).rejects.toThrow("RPC object has no property 'instanceProp'");
    await expect(() => (stub as any).dynamicProp).rejects.toThrow("RPC object has no property 'dynamicProp'");
  });

  it("does not expose private methods starting with #", async () => {
    class TargetWithPrivate extends RpcTarget {
      #privateMethod() { return "private"; }
      publicMethod() { return "public"; }
    }

    let stub = new RpcStub(new TargetWithPrivate());
    expect(await stub.publicMethod()).toBe("public");
    await expect(() => (stub as any)["#privateMethod"]).rejects.toThrow("RPC object has no property '#privateMethod'");
  });
});

describe("stub disposal", () => {
  it("disposes nested stubs and RpcTargets when wrapping an object", () => {
    class DisposableTarget extends RpcTarget {
      constructor(private disposeFlag: { value: boolean }) {
        super();
      }
      [Symbol.dispose]() { this.disposeFlag.value = true; }
    }

    let innerFlag = { value: false };
    let anotherFlag = { value: false };
    let innerStub = new RpcStub(new DisposableTarget(innerFlag));

    let outerObject = {
      stub: innerStub,
      target: new DisposableTarget(anotherFlag),
      value: 42
    };
    let outerStub = new RpcStub(outerObject);

    outerStub[Symbol.dispose]();

    expect(innerFlag.value).toBe(true);
    expect(anotherFlag.value).toBe(true);
  });

  it("only calls RpcTarget disposer when wrapping an RpcTarget with nested stubs", () => {
    let targetDisposed = false;
    let innerTargetDisposed = false;

    class InnerTarget extends RpcTarget {
      [Symbol.dispose]() { innerTargetDisposed = true; }
    }

    class TargetWithStubs extends RpcTarget {
      inner = new RpcStub(new InnerTarget());

      get innerStub() {
        return this.inner;
      }

      [Symbol.dispose]() { targetDisposed = true; }
    }

    let outerStub = new RpcStub(new TargetWithStubs());
    outerStub[Symbol.dispose]();

    expect(targetDisposed).toBe(true);
    expect(innerTargetDisposed).toBe(false); // nested stubs in RpcTarget are not auto-disposed
  });

  it("only disposes RpcTarget when all dups are disposed", () => {
    let disposed = false;
    class DisposableTarget extends RpcTarget {
      [Symbol.dispose]() { disposed = true; }
    }

    let original = new RpcStub(new DisposableTarget());
    let dup1 = original.dup();
    let dup2 = original.dup();

    original[Symbol.dispose]();
    expect(disposed).toBe(false);

    dup1[Symbol.dispose]();
    expect(disposed).toBe(false);

    dup2[Symbol.dispose]();
    expect(disposed).toBe(true);
  });

  it("makes disposal idempotent - duplicate dispose calls don't affect refcount", () => {
    let disposed = false;
    class DisposableTarget extends RpcTarget {
      [Symbol.dispose]() { disposed = true; }
    }

    let original = new RpcStub(new DisposableTarget());
    let dup1 = original.dup();

    // Dispose the duplicate twice
    dup1[Symbol.dispose]();
    dup1[Symbol.dispose]();
    expect(disposed).toBe(false);

    // Only when original is also disposed should the target be disposed
    original[Symbol.dispose]();
    expect(disposed).toBe(true);
  });
});

describe("basic rpc", () => {
  it("supports calls", async () => {
    await using harness = new TestHarness(new TestTarget());
    expect(await harness.stub.square(3)).toBe(9);
  });

  it("supports throwing errors", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub = harness.stub;
    await expect(() => stub.throwError()).rejects.toThrow(new RangeError("test error"));
  });

  it("supports .then(), .catch(), and .finally() on RPC promises", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub = harness.stub;

    // Test .then() with successful call
    {
      let result = await stub.square(3).then(value => {
        expect(value).toBe(9);
        return value * 2;
      });
      expect(result).toBe(18);
    }

    // Test .catch() with error
    {
      let result = await stub.throwError()
        .catch(err => {
          expect(err).toBeInstanceOf(RangeError);
          expect((err as Error).message).toBe("test error");
          return "caught";
        });
      expect(result).toBe("caught");
    }

    // Test .finally() with successful call
    {
      let finallyCalled = false;
      await stub.square(4)
        .finally(() => {
          finallyCalled = true;
        });
      expect(finallyCalled).toBe(true);
    }

    // Test .finally() with an error
    {
      let finallyCalled = false;
      let promise = stub.throwError()
        .finally(() => {
          finallyCalled = true;
        });
      await expect(() => promise).rejects.toThrow(new RangeError("test error"));
      expect(finallyCalled).toBe(true);
    }
  });

  it("throws error when trying to send non-serializable argument", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub = harness.stub;

    expect(() => stub.square(new NotSerializable(123) as any)).toThrow(
      new TypeError("cannot serialize: NotSerializable(123)")
    );
  });

  it("throws error when trying to return non-serializable result", async () => {
    class BadTarget extends RpcTarget {
      returnNonSerializable() {
        return new NotSerializable(456);
      }
    }

    await using harness = new TestHarness(new BadTarget());
    let stub = harness.stub as any;

    await expect(() => stub.returnNonSerializable()).rejects.toThrow(
      new TypeError("cannot serialize: NotSerializable(456)")
    );
  });

  it("does not expose common Object properties on RpcTarget", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub: any = harness.stub;

    // For this test we want to access properties on a remove object that are common properties of
    // all objects. However, if we just access them on the stub, we'll actually access the *local*
    // object's version of that property. We really want to generate messages sent to the other
    // end to access the remote version, but there's no legitimate way to do this via the JS-level
    // API. Fortunately, our transport implements a hack: the string "$remove$" will be excised
    // from any message. So, we can use this as a prefix on property names to create a prpoperty
    // that does not match anything locally, but by the time it reaches the remote end, will name
    // a common object property.

    // Properties of Object.prototype should not be exposed over RPC.
    await expect(() => stub.$remove$toString).rejects.toThrow("RPC object has no property 'toString'");
    await expect(() => stub.$remove$hasOwnProperty).rejects.toThrow("RPC object has no property 'hasOwnProperty'");

    // Special properties are not exposed.
    await expect(() => stub.$remove$__proto__).rejects.toThrow("RPC object has no property '__proto__'");
    await expect(() => stub.$remove$constructor).rejects.toThrow("RPC object has no property 'constructor'");
  });

  it("does not expose common Object properties on RpcTarget", async () => {
    class ObjectVendor extends RpcTarget {
      get() {
        return new RpcStub<object>({foo: 123, arr: [1, 2], func(x: number) { return 123; }});
      }
    }

    await using harness = new TestHarness(new ObjectVendor());
    using stub: any = await harness.stub.get();

    expect(await stub.foo).toBe(123);

    // Similar to previous test case, but we're operating on a stub backed by an object rather
    // than an RpcTarget now.

    // Properties of Object.prototype should not be exposed over RPC.
    await expect(() => stub.$remove$toString).rejects.toThrow("RPC object has no property 'toString'");
    await expect(() => stub.$remove$hasOwnProperty).rejects.toThrow("RPC object has no property 'hasOwnProperty'");

    // Properties of Array.prototype and Function.prototype are similarly not exposed even for
    // values of those types.
    await expect(() => stub.arr.$remove$map).rejects.toThrow("'arr' has no property 'map'");
    await expect(() => stub.func.$remove$call).rejects.toThrow("RPC object has no property 'call'");

    // Special properties are not exposed.
    await expect(() => stub.$remove$__proto__).rejects.toThrow("RPC object has no property '__proto__'");
    await expect(() => stub.$remove$constructor).rejects.toThrow("RPC object has no property 'constructor'");
  });
});

describe("capability-passing", () => {
  it("supports returning an RpcTarget", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub = harness.stub;
    using counter = await stub.makeCounter(4);
    expect(await counter.increment()).toBe(5);
    expect(await counter.increment(4)).toBe(9);
  });

  it("supports passing a stub back over the connection", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub = harness.stub;

    let counter = await stub.makeCounter(4);
    expect(await stub.incrementCounter(counter.dup())).toBe(5);
    expect(await stub.incrementCounter(counter, 4)).toBe(9);
  });

  it("supports three-party capability passing", async () => {
    // Create two connections: Alice and Bob
    class AliceTarget extends RpcTarget {
      getCounter() {
        return new Counter(10);
      }
    }

    class BobTarget extends RpcTarget {
      // Bob actually uses the counter, causing calls to proxy through Bob to Alice
      incrementCounter(counter: RpcStub<Counter>, amount: number) {
        return counter.increment(amount);
      }
    }

    await using aliceHarness = new TestHarness(new AliceTarget());
    await using bobHarness = new TestHarness(new BobTarget());

    let aliceStub = aliceHarness.stub;
    let bobStub = bobHarness.stub;

    // Get counter from Alice.
    using counter = await aliceStub.getCounter();

    // Bob increments the counter - this call proxies from Bob through the client to Alice
    let result = await bobStub.incrementCounter(counter, 3);
    expect(result).toBe(13);
  });
});

describe("promise pipelining", () => {
  it("supports passing a promise in arguments", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub = harness.stub;
    using promise = stub.square(2);
    expect(await stub.square(promise)).toBe(16);
  });

  it("supports calling a promise", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub = harness.stub;
    using counter = stub.makeCounter(4);
    let promise1 = counter.increment();
    let promise2 = counter.increment(4);
    expect(await promise1).toBe(5);
    expect(await promise2).toBe(9);
  });

  it("supports returning a promise", async () => {
    await using harness = new TestHarness(new TestTarget());
    let stub = harness.stub;
    expect(withoutDisposer(await stub.callSquare(stub.dup(), 3))).toStrictEqual({result: 9});
  });

  it("propagates errors to pipelined calls", async () => {
    class ErrorTarget extends RpcTarget {
      throwError(): TestTarget {
        throw new Error("pipelined error");
      }
    }

    await using harness = new TestHarness(new ErrorTarget());
    let stub = harness.stub;

    // Pipeline a call on a promise that will reject
    using errorPromise = stub.throwError();
    using pipelinedCall = errorPromise.square(5);

    await expect(() => pipelinedCall).rejects.toThrow("pipelined error");
  });

  it("propagates errors to argument-pipelined calls", async () => {
    class ErrorTarget extends RpcTarget {
      throwError(): never {
        throw new Error("pipelined error");
      }

      processValue(value: any) {
        return value * 2;
      }
    }

    await using harness = new TestHarness(new ErrorTarget());
    let stub = harness.stub;

    // Pipeline a call on a promise that will reject
    using errorPromise = stub.throwError();
    using pipelinedCall = stub.processValue(errorPromise);

    await expect(() => pipelinedCall).rejects.toThrow("pipelined error");
  });
});

describe("stub disposal over RPC", () => {
  it("disposes remote RpcTarget when stub is disposed", async () => {
    let targetDisposed = false;
    class DisposableTarget extends RpcTarget {
      getValue() { return 42; }
      [Symbol.dispose]() { targetDisposed = true; }
    }

    class MainTarget extends RpcTarget {
      getDisposableTarget() {
        return new DisposableTarget();
      }
    }

    await using harness = new TestHarness(new MainTarget());
    let mainStub = harness.stub as any;

    {
      using disposableStub = await mainStub.getDisposableTarget();
      expect(await disposableStub.getValue()).toBe(42);
    } // disposer runs here

    // Wait a bit for the disposal message to be processed
    await pumpMicrotasks();

    expect(targetDisposed).toBe(true);
  });

  it("only disposes remote target when all RPC dups are disposed", async () => {
    let targetDisposed = false;
    class DisposableTarget extends RpcTarget {
      getValue() { return 42; }
      [Symbol.dispose]() { targetDisposed = true; }
    }

    class MainTarget extends RpcTarget {
      getDisposableTarget() {
        return new DisposableTarget();
      }
    }

    await using harness = new TestHarness(new MainTarget());
    let mainStub = harness.stub as any;

    let disposableStub = await mainStub.getDisposableTarget();
    let dup1 = disposableStub.dup();
    let dup2 = disposableStub.dup();

    disposableStub[Symbol.dispose]();
    await pumpMicrotasks();
    expect(targetDisposed).toBe(false);

    dup1[Symbol.dispose]();
    await pumpMicrotasks();
    expect(targetDisposed).toBe(false);

    dup2[Symbol.dispose]();
    await pumpMicrotasks();
    expect(targetDisposed).toBe(true);
  });

  it("makes RPC disposal idempotent", async () => {
    let targetDisposed = false;
    class DisposableTarget extends RpcTarget {
      getValue() { return 42; }
      [Symbol.dispose]() { targetDisposed = true; }
    }

    class MainTarget extends RpcTarget {
      getDisposableTarget() {
        return new DisposableTarget();
      }
    }

    await using harness = new TestHarness(new MainTarget());
    let mainStub = harness.stub as any;

    let disposableStub = await mainStub.getDisposableTarget();
    let dup1 = disposableStub.dup();

    // Dispose the duplicate twice
    dup1[Symbol.dispose]();
    dup1[Symbol.dispose]();
    await pumpMicrotasks();
    expect(targetDisposed).toBe(false);

    // Only when original is also disposed should the target be disposed
    disposableStub[Symbol.dispose]();
    await pumpMicrotasks();
    expect(targetDisposed).toBe(true);
  });

  it("disposes targets automatically on disconnect", async () => {
    let targetDisposed = false;
    class DisposableTarget extends RpcTarget {
      getValue() { return 42; }
      hangingCall(): Promise<number> {
        // This call will hang and be interrupted by disconnect
        return new Promise(() => {}); // Never resolves
      }
      [Symbol.dispose]() { targetDisposed = true; }
    }

    // Intentionally dont use `using` here because we expect the stats to be wrong after a
    // disconnect.
    let harness = new TestHarness(new DisposableTarget());
    let stub = harness.stub;
    expect(await stub.getValue()).toBe(42);

    // Start a hanging call
    let hangingPromise = stub.hangingCall();

    // Simulate disconnect by making the transport fail
    harness.clientTransport.forceReceiveError(new Error("test error"));

    // The hanging call should be rejected
    await expect(() => hangingPromise).rejects.toThrow(new Error("test error"));

    // Further calls should also fail immediately
    await expect(() => stub.getValue()).rejects.toThrow(new Error("test error"));

    // Targets should be disposed
    expect(targetDisposed).toBe(true);
  });

  it("shuts down the connection if the main capability is disposed", async () => {
    // Intentionally dont use `using` here because we expect the stats to be wrong after a
    // disconnect.
    let harness = new TestHarness(new TestTarget());
    let stub = harness.stub;

    let counter = await stub.makeCounter(0);

    stub[Symbol.dispose]();

    await expect(() => counter.increment(1)).rejects.toThrow(
      new Error("RPC session was shut down by disposing the main stub")
    );
  });
});

describe("e-order", () => {
  it("maintains e-order for concurrent calls on single stub", async () => {
    let callOrder: number[] = [];
    class OrderTarget extends RpcTarget {
      recordCall(id: number) {
        callOrder.push(id);
        return id;
      }
    }

    await using harness = new TestHarness(new OrderTarget());
    let stub = harness.stub as any;

    // Make multiple concurrent calls
    let promises = [
      stub.recordCall(1),
      stub.recordCall(2),
      stub.recordCall(3),
      stub.recordCall(4)
    ];

    await Promise.all(promises);

    // Calls should arrive in the order they were made
    expect(callOrder).toEqual([1, 2, 3, 4]);
  });

  it("maintains e-order for promise-pipelined calls", async () => {
    let callOrder: number[] = [];
    class OrderTarget extends RpcTarget {
      getObject() {
        return {
          method1: (id: number) => { callOrder.push(id); return id; },
          method2: (id: number) => { callOrder.push(id); return id; }
        };
      }
    }

    await using harness = new TestHarness(new OrderTarget());
    let stub = harness.stub as any;

    // Get a promise for an object
    using objectPromise = stub.getObject();

    // Make pipelined calls on different methods of the same promise
    let promises = [
      objectPromise.method1(1),
      objectPromise.method2(2),
      objectPromise.method1(3),
      objectPromise.method2(4)
    ];

    await Promise.all(promises);

    // Calls should arrive in the order they were made, even across different methods
    expect(callOrder).toEqual([1, 2, 3, 4]);
  });
});

describe("error serialization", () => {
  it("hides the stack by default", async () => {
    await using harness = new TestHarness(new TestTarget(), {
      onSendError: (error) => {
        // default behavior
      }
    });
    let stub = harness.stub;

    let result = await stub.throwError()
      .catch(err => {
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message).toBe("test error");

        // By default, the stack isn't sent. A stack may be added client-side, though. So we
        // verify that it doesn't contain the function name `throwErrorImpl` nor the file name
        // `test-util.ts`, which should only appear on the server.
        expect((err as Error).stack).not.toContain("throwErrorImpl");
        expect((err as Error).stack).not.toContain("test-util.ts");

        return "caught";
      });
    expect(result).toBe("caught");
  });

  it("reveals the stack if the callback returns the error", async () => {
    await using harness = new TestHarness(new TestTarget(), {
      onSendError: (error) => {
        return error;
      }
    });
    let stub = harness.stub;

    let result = await stub.throwError()
      .catch(err => {
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message).toBe("test error");

        // Now the error function and source file should be in the stack.
        expect((err as Error).stack).toContain("throwErrorImpl");
        expect((err as Error).stack).toContain("test-util.ts");

        return "caught";
      });
    expect(result).toBe("caught");
  });

  it("allows errors to be rewritten", async () => {
    await using harness = new TestHarness(new TestTarget(), {
      onSendError: (error) => {
        let rewritten = new TypeError("rewritten error");
        rewritten.stack = "test stack";
        return rewritten;
      }
    });
    let stub = harness.stub;

    let result = await stub.throwError()
      .catch(err => {
        expect(err).toBeInstanceOf(TypeError);
        expect((err as Error).message).toBe("rewritten error");
        expect((err as Error).stack).toBe("test stack");
        return "caught";
      });
    expect(result).toBe("caught");
  });
});

// =======================================================================================

describe("WebSockets", () => {
  it("can open a WebSocket connection", async () => {
    let url = `ws://${inject("testServerHost")}`;

    let cap = newWebSocketRpcSession<TestTarget>(url);

    expect(await cap.square(5)).toBe(25);

    {
      let counter = cap.makeCounter(2);
      expect(await counter.increment(3)).toBe(5);
    }

    {
      let counter = new Counter(4);
      expect(await cap.incrementCounter(counter, 9)).toBe(13);
    }
  });
});
