# JavaScript-native RPC

This is a JavaScript/TypeScript RPC library that supports:

* Usage from both browsers and servers.
* Object Capabilities (pass-by-reference objects and functions), to model complex stateful interactions.
* Promise Pipelining, so you can take the results of one call and send them in the arguments to the next call without actually waiting for the first call to return.
* Batch requests over HTTP *or* long-lived sessions over WebSocket.
* Absolutely minimal boilerplate.

## Example

_TODO: This is not a great example. Improve it!_

Declare your RPC interface like this:

```ts
interface MyApi {
  // Return who the user is logged in as.
  whoami(): Promise<{name: string, id: string}>;

  // Get the given user's public profile info.
  getUserProfile(userId: string): Promise<UserProfile>;
}
```

On the server, export it:

```ts
import { receiveRpcOverHttp, RpcTarget } from "jsrpc";

class MyApiImpl extends RpcTarget implements MyApi {
  // ... implement api ...
}

// Cloudflare Workers fetch handler.
//
// Note this handles both batch and WebSocket-oriented RPCs.
export default {
  async fetch(req, env, ctx) {
    let url = new URL(req.url);

    // Handle API endpoint.
    if (url.pathname === "/api") {
      return receiveRpcOverHttp(request, new MyApiImpl(env, ctx));
    }

    // ... handle other HTTP requests normally ...
  }
}
```

On the client, use it in a batch request:

```ts
let batch = rpcOverHttp<MyApi>("https://example.com/api");
let api = batch.getStub();

// Calling a function returns an RpcPromise for the result.
let whoamiPromise = api.whoami();

// `whoami()` will return the user ID. We haven't awaited the result yet,
// but we can pass the user ID to other calls in the batch. This creates a
// speculative, or "pipelined" call: on the server side, these calls will
// only be executed after `authenticate` finishes.
let profilePromise = api.getUserProfile(whoamiPromise.id);

// Send the whole batch. Note that all calls must be initiated before this
// point, but promises will not resolve until after.
batch.send();

// Now we can actually await the results from earlier. Although we made
// two calls, both promises will resolve with only one round trip.
let user = await whoamiPromise;
let profile = await profilePromise;
```

Alternatively, we can set up a persistent WebSocket connection:

```ts
let session = rpcOverWebSocket<MyApi>("https://example.com/api");
let api = session.getStub();

// Usage of `api` is the same, except there is no `sendBatch()` step.
// All calls are sent immediately. You can still send dependent calls
// without waiting for previous calls to return.
```

## RPC Basics

### Pass-by-value types

The following types can be passed over RPC (in arguments or return values), and will be passed "by value", meaning the content is serialized, producing a copy at the receiving end:

* Primitive values: strings, numbers, booleans, null, undefined
* Plain objects (e.g., from object literals)
* Arrays
* `Date`
* `Error` and its well-known subclasses

The following types are not supported as of this writing, but will be supported soon:
* `Map` and `Set`
* `ArrayBuffer` and typed arrays
* `RegExp`
* `BigInt`
* `Headers`

The following are intentionally NOT supported:
* Application-defined classes that do not extend `RpcTarget`.
* Cyclic values. Messages are serialized strictly as trees (like JSON).

### `RpcTarget`

To export an interface over RPC, you must write a class that `extends RpcTarget`. Extending `RpcTarget` tells the RPC system: instances of this class are _pass-by-reference_. When an instance is passed over RPC, the object should NOT be serialized. Instead, the RPC message will contain a "stub" that points back to the original target object. Invoking this stub calls back over RPC.

When you send someone an `RpcTarget` reference, they will be able to call any class method over RPC, including getters. They will not, however, be able to access "own" properties. In precise JavaScript terms, they can access prototype properties but not instance properties. This policy is intended to "do the right thing" for typical JavaScript code, where private members are typically stored as instance properties.

WARNING: If you are using TypeScript, note that declaring a method `private` does not hide it from RPC, because TypeScript annotations are "erased" at runtime, so cannot be enforced. To actually make methods private, you must prefix their names with `#`, which makes them private for JavaScript (not just TypeScript). Names prefixed with `#` are never available over RPC.

### Functions

When a plain function is passed over RPC, it will be treated similarly to an `RpcTarget`. The function will be replaced by a stub which, when invoked, calls back over RPC to the original function object.

If the function has any own properties, those will be available over RPC. Note that this differs from `RpcTarget`: With `RpcTarget`, own properties are not exposed, but with functions, _only_ own properties are exposed. Generally functions don't have properties anyway, making the point moot.

### `RpcStub<T>`

When a type `T` which extends `RpcTarget` (or is a function) is sent as part of an RPC message (in the arguments to a call, or in the return value), it is replaced with a stub of type `RpcStub<T>`.

Stubs are implemented using JavaScript `Proxy`s. A stub appears to have every possible method and property name. The stub does not know at runtime which properties actually exist on the server side. If you use a property that doesn't exist, an error will not be produced until you await the results.

TypeScript, however, will know which properties exist from type parameter `T`. Thus, if you are using TypeScript, you will get full compile-time type checking, auto-complete, etc. Hooray!

To read a property from the remote object (as opposed to calling a method), simply `await` the property, like `let foo = await stub.foo;`.

A stub can be passed across RPC again, including over independent connections. If Alice is connected to Bob and Carol, and Alice receives a stub from Bob, Alice can pass the stub in an RPC to Carol, thus allowing Carol to call Bob. (As of this writing, any such calls will be proxied through Alice, but in the future we may support "three-party handoff" such that Carol can make a direct connection to Bob.)

You may construct a stub explicitly without an RPC connection, using `new RpcStub(target)`. This is sometimes useful to be able to perform local calls as if they were remote, or to help manage disposal (see below).

### `RpcPromise<T>`

Calling an RPC method returns an `RpcPromise` rather than a regular `Promise`. You can use an `RpcPromise` in all the ways a regular `Promise` can be used, that is, you can `await` it, call `.then()`, pass it to `Promise.resolve()`, etc. (This is all possible because `RpcPromise` is a ["thenable"](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise#thenables).)

However, you can do more with `RpcPromise`. `RpcPromise` supports _Promise Pipelining_:

1. An `RpcPromise` also acts as a _stub_ for the eventual result of the promise. That means, you can access properties and invoke methods on it, without awaiting the promise first.

```ts
// In a single round trip, authenticate the user, and fetch their notifications.
let user = api.authenticate(cookie);
let notifications = await user.getNotifications();
```

2. An `RpcPromise` (or its properties) can be passed as parameters to other RPC calls.

```ts
// In a single round trip, authenticate the user, and fetch their public profile
// given their ID.
let user = api.authenticate(cookie);
let profile = await api.getUserProfile(user.id);
```

Whenever an `RpcPromise` is passed in the parameters to an RPC, or returned as part of the result, the promise will be replaced with its resolution before delivery to the receiving application. So, you can use an `RpcPromise<T>` anywhere where a `T` is required!

## Resource Management and Disposal

Unfortunately, garbage collection does not work well when remote resources are involved, for two reasons:

1. Many JavaScript runtimes only run the garbage collector when they sense "memory pressure" -- if memory is not running low, then they figure there's no need to try to reclaim any. However, the runtime has no way to know if the other side of an RPC connection is suffering memory pressure.

2. Garbage collectors need to trace the full object graph in order to detect which objects are unreachable, especially when those objects contain cyclic refereces. However, the garbage collector can only see local objects; it has no ability to trace through the remote graph to discover cycles that may cross RPC connections.

Both of these problems might be solvable with sufficient work, but the problem seems exceedingly difficult. We make no attempt to solve it in this library.

Instead, you may choose one of two strategies:

1. Explicitly dispose stubs when you are done with them. This notifies the remote end that it can release the associated resources.

2. Use short-lived sessions. When the session ends, all stubs are implicitly disposed. In particular, when using HTTP batch request, there's generally no need to dispose stubs. When using WebSocket sessions, however, disposal may be important.

### How to dispose

Stubs integrate with JavaScript's [explicit resource management](https://v8.dev/features/explicit-resource-management), which became widely available in mid-2025 (and has been supported via transpilers and polyfills going back a few years earlier). In short:

* Disposable objects (including stubs) have a method `[Symbol.dispose]`. You can call this like `stub[Symbol.dispose]()`.
* You can arrange for a stub to be disposed automatically at the end of a function scope by assigning it to a `using` variable, like `using stub = api.getStub();`. The disposer will automatically be invoked when the variable goes out-of-scope.

### Automatic disposal

This library implements several rules to help make resource management more manageable:

* Disposing an `RpcPromise` will automatically dispose the future result. (It may also cause the promise to be canceled and rejected, though this is not guaranteed.)
* When a stub is passed in the parameters or return value of an RPC, ownership is transferred to the recipient of that message. That means, the stub on the sending end is automatically disposed, but the receiving end receives a copy of the stub.
    * Note, however, that `RpcPromise`s are NOT automatically disposed when used in an RPC message.
* On the callee side of an RPC, any stubs received in the parameters will automatically be disposed when the call completes, if they have not been disposed before that. If you wish to keep the stubs beyond the return, you can `dup()` them (see below).
* If the final result of an RPC returned to the caller is an object, it will always have a disposer. Disposing it will dispose all stubs found in that response. It's a good idea to always dispose return values even if you don't expect they contain any stubs, just in case the server changes the API in the future to add stubs to the result.

### Duplicating stubs

Sometimes you need to pass a stub somewhere where it will be disposed, but also keep the stub for later use. To prevent the disposer from disabling your copy of the stub, you can duplicate the stub by calling `stub.dup()`. The stub's target will only be disposed when all duplicates of the stub have been disposed.

Hint: You can call `.dup()` on a property of a stub or promise, in order to create a stub backed by that property. This is particularly useful when you know in advance that the property is going to resolve to a stub: calling `.dup()` on it gives you a stub you can start using immediately, that otherwise behaves exactly the same as the eventual stub would if you awaited it.

### Listening for disposal

An `RpcTarget` may declare a `Symbol.dispose` method. If it does, the RPC system will automatically invoke it when a stub pointing at it (and all its duplicates) has been disposed.

Note that if you pass the same `RpcTarget` instance to RPC multiple times -- thus creating multiple stubs -- you will eventually get a separate dispose call for each one. To avoid this, you could use `new RpcStub(target)` to create a single stub upfront, and then pass that stub across multiple RPCs. In this case, you will receive only one call to the target's disposer when all stubs are disposed.

## Setting up a session

### HTTP batch client

_TODO: Not implemented yet_

### WebSocket client

_TODO: Not implemented yet_

### HTTP server on Cloudflare Workers

_TODO: Not implemented yet_

### HTTP server on Node.js

_TODO: Not implemented yet_

### Custom transports

You can implement a custom RPC transport across any bidirectional stream. To do so, implement the interface `RpcTransport`, which is defined as follows:

```ts
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
```

You can then set up a connection over it:

```ts
// Create the transport.
let transport: RpcTransport = new MyTransport();

// Create the main interface we will expose to the other end.
let localMain: RpcTarget = new MyMainInterface():

// Start the session.
let session = new RpcSession<RemoteMainInterface>(transport, localMain);

// Get a stub for the other end's main interface.
let stub: RemoteMainInterface = session.getRemoteMain();

// Now we can call methods on the stub.
```

Note that sessions are entirely symmetric: neither side is defined as the "client" nor the "server". Each side can optionally expose a "main interface" to the other. In typical scenarios with a logical client and server, the server exposes a main interface but the client does not.
