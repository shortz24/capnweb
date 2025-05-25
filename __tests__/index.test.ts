import { expect, it, describe } from "vitest"
import { deserialize, serialize, RpcSession, RpcTransport, RpcTarget, RpcStub, RpcPromise } from "../src/index.js"

let SERIALIZE_TEST_CASES: Record<string, unknown> = {
  '123': 123,
  'null': null,
  '"foo"': "foo",
  'true': true,

  '{"foo":123}': {foo: 123},
  '{"foo":{"bar":123,"baz":456},"qux":789}': {foo: {bar: 123, baz: 456}, qux: 789},

  '[[123]]': [123],
  '{"foo":[[123]]}': {foo: [123]},
  '{"foo":[[123]],"bar":[[456,789]]}': {foo: [123], bar: [456, 789]},

  '["date",1234]': new Date(1234),
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

  async send(message: string): Promise<void> {
    console.log(`${this.name}: ${message}`);
    this.partner!.queue.push(message);
    if (this.partner!.waiter) {
      this.partner!.waiter();
      this.partner!.waiter = undefined;
    }
  }

  async receive(): Promise<string> {
    if (this.queue.length == 0) {
      await new Promise<void>(resolve => { this.waiter = resolve; });
    }

    return this.queue.shift()!;
  }
}

class Counter extends RpcTarget {
  constructor(private i: number = 0) {
    super();
  }

  increment(amount: number = 1): number {
    this.i += amount;
    return this.i;
  }
}

class TestTarget extends RpcTarget {
  square(i: number) {
    return i * i;
  }

  callSquare(self: RpcStub<TestTarget>, i: number) {
    return { result: self.square(i) };
  }

  throwError() {
    throw new RangeError("test error");
  }

  makeCounter(i: number) {
    return new Counter(i);
  }

  incrementCounter(c: RpcStub<Counter>, i: number = 1) {
    return c.increment(i);
  }
}

function withoutDisposer(obj: any) {
  delete obj[Symbol.dispose];
  return obj;
}

class TestHarness<T extends RpcTarget> {
  client: RpcSession<T>;
  server: RpcSession;

  stub: RpcStub<T>;

  constructor(target: T) {
    let clientTransport = new TestTransport("client");
    let serverTransport = new TestTransport("server", clientTransport);

    this.client = new RpcSession<T>(clientTransport);

    // TODO: If I remove `<undefined>` here, I get a TypeScript error about the instantiation being
    //   excessively deep and possibly infinite. Why? `<undefined>` is supposed to be the default.
    this.server = new RpcSession<undefined>(serverTransport, target);

    this.stub = this.client.getRemoteMain();
  }

  checkAllDisposed() {
    expect(this.client.getStats()).toStrictEqual({imports: 1, exports: 1});
    expect(this.server.getStats()).toStrictEqual({imports: 1, exports: 1});
  }

  async [Symbol.asyncDispose]() {
    try {
      // HACK: Spin the microtask loop for a bit to make sure dispose messages have been sent
      //   and received.
      for (let i = 0; i < 16; i++) {
        await Promise.resolve();
      }

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
});
