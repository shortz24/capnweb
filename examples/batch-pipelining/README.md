Batch + Pipelining (Single Round Trip)

This example shows how to issue a sequence of dependent RPC calls that all execute on the server in a single HTTP round trip using batching and promise pipelining.

What it does

- Authenticates a user.
- Uses the returned user ID (without awaiting) to fetch the profile and notifications.
- Awaits all results together. Even though there are multiple calls and dependencies, they travel in one request and one response.

Run locally (Node 18+)

1) Build the library at repo root:
   npm run build

2) Start the server:
   node examples/batch-pipelining/server-node.mjs

3) In a separate terminal, run the client:
   node examples/batch-pipelining/client.mjs

Files

- server-node.mjs: Minimal Node HTTP server bridging to `newHttpBatchRpcResponse()`.
- client.mjs: Batching + pipelining client using `newHttpBatchRpcSession()`.

Why this matters

- With normal HTTP or naive GraphQL usage, each dependent call often needs another round trip. Here, dependent calls are constructed locally, sent once, and executed on the server with results streamed back — minimizing latency dramatically.
