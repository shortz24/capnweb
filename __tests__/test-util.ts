// Common RPC interfaces / implementations used in several tests.

import { RpcStub, RpcTarget } from '../src/index.js';

export class Counter extends RpcTarget {
  constructor(private i: number = 0) {
    super();
  }

  increment(amount: number = 1): number {
    this.i += amount;
    return this.i;
  }
}

// Distinct function so we can search for it in the stack trace.
function throwErrorImpl(): never {
  throw new RangeError("test error");
}

export class TestTarget extends RpcTarget {
  square(i: number) {
    return i * i;
  }

  callSquare(self: RpcStub<TestTarget>, i: number) {
    return { result: self.square(i) };
  }

  throwError() {
    throwErrorImpl();
  }

  makeCounter(i: number) {
    return new Counter(i);
  }

  incrementCounter(c: RpcStub<Counter>, i: number = 1) {
    return c.increment(i);
  }
}
