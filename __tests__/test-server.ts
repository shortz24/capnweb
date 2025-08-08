// Implements a test RPC backend server for tests to try connecting to.
//
// This is intended to be used as a vitest `globalSetup`. That means this strictly runs under Node.
// That's OK:
// - Browsers can't be servers anyway, so it's fine if they only get tested as clients.
// - For workerd tests specifically, we can test the server side by using a service binding to
//   test Worker (test-server-workerd.js). This means the workerd server code is only exercised by
//   the workerd tests, not by any other client, but that's fine as the protocol should be
//   identical regardless.

import { WebSocketServer, AddressInfo } from 'ws'
import type { TestProject } from 'vitest/node'
import * as url from 'url'
import { newWebSocketRpcSession, RpcSession, RpcTarget } from '../src/index.js';
import { TestTarget } from './test-util.js';

let server: WebSocketServer | undefined

export async function setup(project: TestProject) {
  let ready = Promise.withResolvers<void>();

  server = new WebSocketServer({ port: 0 }, ready.resolve) // Use ephemeral port

  server.on('connection', (ws) => {
    newWebSocketRpcSession(<WebSocket><any>ws, new TestTarget());
  })

  server.on('error', (error: Error) => {
    console.error("HERE", error);
  });

  // Wait for server to be ready and get the assigned port
  await ready.promise;

  let addr = <AddressInfo>server.address();

  // We use the Node-specific `url.format` here becaues it automatically handles adding brackets to
  // IPv6 addresses. Unfortunately, the standard `URL` class doesn't seem to provide this.
  project.provide("testServerHost", url.format({hostname: addr.address, port: addr.port}));
}

export async function teardown() {
  if (server) {
    // NOTE: close() calls a callback when done, but it waits for all clients to disconnect. If
    //   we wait on it here, vitest hangs on shutdown whenever there's a client that failed to
    //   disconnect. This is annoying and pointless, so we don't wait.
    server.close();
    server = undefined;
  }
}
