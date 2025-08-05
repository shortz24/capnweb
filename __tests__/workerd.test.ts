/// <reference types="@cloudflare/workers-types" />
import { expect, it, describe } from "vitest";
import { RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { RpcStub, RpcTarget } from "../src/index.js";

class JsCounter extends RpcTarget {
  constructor(private i: number = 0) {
    super();
  }

  increment(amount: number = 1): number {
    this.i += amount;
    return this.i;
  }
}

class NativeCounter extends RpcTarget {
  constructor(private i: number = 0) {
    super();
  }

  increment(amount: number = 1): number {
    this.i += amount;
    return this.i;
  }
}

describe("workerd compatibility", () => {
  it("allows native RpcStubs to be created using JSRPC RpcTargets", async () => {
    let stub = new NativeRpcStub(new JsCounter());
    expect(await stub.increment()).toBe(1);
    expect(await stub.increment()).toBe(2);
  })

  it("allows JSRPC RpcStubs to be created using native RpcTargets", async () => {
    let stub = new RpcStub(new NativeCounter());
    expect(await stub.increment()).toBe(1);
    expect(await stub.increment()).toBe(2);
  })
});
