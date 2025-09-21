import { RpcTarget as RpcTargetImpl, RpcStub as RpcStubImpl, RpcPromise as RpcPromiseImpl } from "./core.js";
import { serialize, deserialize } from "./serialize.js";
import { RpcTransport, RpcSession as RpcSessionImpl, RpcSessionOptions } from "./rpc.js";
import { RpcTargetBranded, Serializable, Stub, Stubify, __RPC_TARGET_BRAND } from "./types.js";
import { newWebSocketRpcSession as newWebSocketRpcSessionImpl,
         newWorkersWebSocketRpcResponse } from "./websocket.js";
import { newHttpBatchRpcSession as newHttpBatchRpcSessionImpl,
         newHttpBatchRpcResponse, nodeHttpBatchRpcResponse } from "./batch.js";
import { newMessagePortRpcSession as newMessagePortRpcSessionImpl } from "./messageport.js";
import { forceInitMap } from "./map.js";

forceInitMap();

// Re-export public API types.
export { serialize, deserialize, newWorkersWebSocketRpcResponse, newHttpBatchRpcResponse,
         nodeHttpBatchRpcResponse };
export type { RpcTransport, RpcSessionOptions };

// Hack the type system to make RpcStub's types work nicely!
export type RpcStub<T extends Serializable<T>> = Stub<T>;
export const RpcStub: {
  new <T extends Serializable<T>>(value: T): RpcStub<T>;
} = <any>RpcStubImpl;

export type RpcPromise<T extends Serializable<T>> = Stub<T> & Promise<Stubify<T>>;
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
    (webSocket: WebSocket | string, localMain?: any, options?: RpcSessionOptions) => Stubify<T> =
    <any>newWebSocketRpcSessionImpl;

export let newHttpBatchRpcSession:
    <T extends Serializable<T> = Empty>
    (urlOrRequest: string | Request, init?: RequestInit) => Stubify<T> =
    <any>newHttpBatchRpcSessionImpl;

export let newMessagePortRpcSession:
    <T extends Serializable<T> = Empty>
    (port: MessagePort, localMain?: any, options?: RpcSessionOptions) => Stubify<T> =
    <any>newMessagePortRpcSessionImpl;

// Implements inified handling of HTTP-batch and WebSocket responses for the Cloudflare Workers
// Runtime.
//
// SECURITY WARNING: This function accepts cross-origin requests. If you do not want this, you
// should validate the `Origin` header before calling this, or use `newHttpBatchRpcSession()` and
// `newWebSocketRpcSession()` directly with appropriate security measures for each type of request.
// But if your API uses in-band authorization (i.e. it has an RPC method that takes the user's
// credentials as parameters and returns the authorized API), then cross-origin requests should
// be safe.
export async function newWorkersRpcResponse(request: Request, localMain: any) {
  if (request.method === "POST") {
    let response = await newHttpBatchRpcResponse(request, localMain);
    // Since we're exposing the same API over WebSocket, too, and WebScoket always allows
    // cross-origin requests, the API necessarily must be safe for cross-origin use (e.g. because
    // it uses in-band authorization, as recommended in the readme). So, we might as well allow
    // batch requests to be made cross-origin as well.
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  } else if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return newWorkersWebSocketRpcResponse(request, localMain);
  } else {
    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
  }
}
