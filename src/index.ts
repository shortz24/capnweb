import { RpcTarget as RpcTargetImpl, RpcStub as RpcStubImpl, RpcPromise as RpcPromiseImpl } from "./core.js";
import { serialize, deserialize } from "./serialize.js";
import { RpcTransport, RpcSession as RpcSessionImpl, RpcSessionOptions } from "./rpc.js";
import { RpcTargetBranded, Serializable, Stub, Stubify, __RPC_TARGET_BRAND } from "./types.js";
import { newWebSocketRpcSession as newWebSocketRpcSessionImpl,
         newWorkersWebSocketRpcResponse } from "./websocket.js";
import { newHttpBatchRpcSession as newHttpBatchRpcSessionImpl,
         newHttpBatchRpcResponse } from "./batch.js"

// Re-export public API types.
export { serialize, deserialize, newWorkersWebSocketRpcResponse, newHttpBatchRpcResponse };
export type { RpcTransport, RpcSessionOptions };

// Hack the type system to make RpcStub's types work nicely!
export type RpcStub<T extends Serializable<T>> = Stub<T>;
export const RpcStub: {
  new <T extends Serializable<T>>(value: T): RpcStub<T>;
} = <any>RpcStubImpl;

export type RpcPromise<T extends Serializable<T>> = Stub<T> | Promise<Stubify<T>>;
export const RpcPromise: {
  // Note: Cannot construct directly!
} = <any>RpcPromiseImpl;

export interface RpcSession<T extends Serializable<T> = undefined> {
  getRemoteMain(): RpcStub<T>;
  getStats(): {imports: number, exports: number};

  // Waits until the peer is not waiting on any more promise resolutions from us. This is useful
  // in particular to decide when a batch is complete.
  drain(): Promise<void>;
}
export const RpcSession: {
  new <T extends Serializable<T> = undefined>(
      transport: RpcTransport, localMain?: any, options?: RpcSessionOptions): RpcSession<T>;
} = <any>RpcSessionImpl;

// RpcTarget needs some hackage too to brand it properly and account for the implementation
// conditionally being imported from "cloudflare:workers".
export interface RpcTarget extends RpcTargetBranded {};
export const RpcTarget: {
  new(): RpcTarget;
} = RpcTargetImpl;

interface Empty {}

export let newWebSocketRpcSession:
    <T extends Serializable<T> = Empty>
    (webSocket: WebSocket | string, localMain?: any) => Stubify<T> =
    <any>newWebSocketRpcSessionImpl;

export let newHttpBatchRpcSession:
    <T extends Serializable<T> = Empty>
    (urlOrRequest: string | Request, init?: RequestInit) => Stubify<T> =
    <any>newHttpBatchRpcSessionImpl;

// Implements inified handling of HTTP-batch and WebSocket responses for the Workers Runtime.
export function newWorkersRpcResponse(request: Request, localMain: any) {
  if (request.method === "POST") {
    return newHttpBatchRpcResponse(request, localMain);
  } else if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return newWorkersWebSocketRpcResponse(request, localMain);
  } else {
    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
  }
}
