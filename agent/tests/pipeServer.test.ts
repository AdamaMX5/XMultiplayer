import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { PipeServer, type PipeServerCallbacks } from "../src/pipeServer.js";

/** Unique pipe path per test so parallel/leftover servers never collide. */
function testPipePath(): string {
  return `\\\\.\\pipe\\xmp-test-${randomUUID()}`;
}

function once(emitter: { once: (event: string, cb: (...args: unknown[]) => void) => void }, event: string): Promise<unknown> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function startServer(path: string, callbacks: PipeServerCallbacks): Promise<PipeServer> {
  const server = new PipeServer(path, callbacks);
  const listening = new Promise<void>((resolve) => {
    const original = callbacks.onListening;
    callbacks.onListening = () => {
      original?.();
      resolve();
    };
  });
  server.start();
  await listening;
  return server;
}

test("accepts a client connection and delivers a single line as-is", async () => {
  const path = testPipePath();
  const lines: string[] = [];
  const server = await startServer(path, { onLine: (line) => lines.push(line) });
  const client = connect(path);
  await once(client, "connect");

  client.write('{"a":1}\n');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(lines, ['{"a":1}']);
  client.end();
  server.stop();
});

test("reassembles a line split across two separate socket writes", async () => {
  const path = testPipePath();
  const lines: string[] = [];
  const server = await startServer(path, { onLine: (line) => lines.push(line) });
  const client = connect(path);
  await once(client, "connect");

  client.write('{"state_upda');
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.write('te":true}\n');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(lines, ['{"state_update":true}']);
  client.end();
  server.stop();
});

test("fires onClientConnected once per connecting client", async () => {
  const path = testPipePath();
  let connections = 0;
  const server = await startServer(path, {
    onLine: () => {},
    onClientConnected: () => (connections += 1),
  });
  const client = connect(path);
  await once(client, "connect");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(connections, 1);
  client.end();
  server.stop();
});

test("fires onClientDisconnected when the game closes the pipe, and the server keeps listening", async () => {
  const path = testPipePath();
  let connected = 0;
  let disconnected = 0;
  const server = await startServer(path, {
    onLine: () => {},
    onClientConnected: () => (connected += 1),
    onClientDisconnected: () => (disconnected += 1),
  });

  const first = connect(path);
  await once(first, "connect");
  first.end();
  await once(first, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disconnected, 1);

  // Reconnect: the agent must not need a restart to accept a new game session on
  // the same pipe (PlanMod.md A1 "Pipe-Verbindung Spiel <-> Agent stabil").
  const second = connect(path);
  await once(second, "connect");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(connected, 2);
  second.end();
  server.stop();
});

test("an abrupt game disconnect does not crash the server and does not surface a trailing unterminated line", async () => {
  const path = testPipePath();
  const lines: string[] = [];
  let disconnected = false;
  const server = await startServer(path, {
    onLine: (line) => lines.push(line),
    onClientDisconnected: () => (disconnected = true),
  });
  const client = connect(path);
  await once(client, "connect");

  // No trailing newline: simulates the game process dying mid-write.
  client.write('{"partial":true');
  client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(disconnected, true);
  assert.deepEqual(lines, [], "an unterminated trailing line is dropped, not delivered, on abrupt disconnect");
  server.stop();
});

test("handles two clients connecting and disconnecting in sequence without cross-talk", async () => {
  const path = testPipePath();
  const linesByClient: string[] = [];
  const server = await startServer(path, { onLine: (line) => linesByClient.push(line) });

  const a = connect(path);
  await once(a, "connect");
  a.write('{"from":"a"}\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  a.end();
  await once(a, "close");

  const b = connect(path);
  await once(b, "connect");
  b.write('{"from":"b"}\n');
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(linesByClient, ['{"from":"a"}', '{"from":"b"}']);
  b.end();
  server.stop();
});

test("write() returns false and does not throw when no game client is connected", async () => {
  const path = testPipePath();
  const server = await startServer(path, { onLine: () => {} });

  assert.equal(server.write('{"type":"spawn"}'), false);
  server.stop();
});

test("write() delivers a line to the connected game client", async () => {
  const path = testPipePath();
  const server = await startServer(path, { onLine: () => {} });
  const client = connect(path);
  await once(client, "connect");
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the server's own "connection" accept catch up

  const received = once(client, "data");
  const sent = server.write('{"type":"spawn","objectId":"ship-a"}');
  assert.equal(sent, true);
  const data = await received;
  assert.equal((data as Buffer).toString(), '{"type":"spawn","objectId":"ship-a"}\n');

  client.end();
  server.stop();
});

test("write() returns false again after the game client disconnects", async () => {
  const path = testPipePath();
  const server = await startServer(path, { onLine: () => {} });
  const client = connect(path);
  await once(client, "connect");
  client.end();
  await once(client, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(server.write('{"type":"despawn"}'), false);
  server.stop();
});

test("write() targets the new client after a reconnect", async () => {
  const path = testPipePath();
  const server = await startServer(path, { onLine: () => {} });

  const first = connect(path);
  await once(first, "connect");
  first.end();
  await once(first, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = connect(path);
  await once(second, "connect");
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the server's own "connection" accept catch up
  const received = once(second, "data");
  assert.equal(server.write('{"type":"spawn"}'), true);
  const data = await received;
  assert.equal((data as Buffer).toString(), '{"type":"spawn"}\n');

  second.end();
  server.stop();
});

test("stop() closes the server so further connection attempts fail", async () => {
  const path = testPipePath();
  const server = await startServer(path, { onLine: () => {} });
  server.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const client: Socket = connect(path);
  const result = await new Promise<"connect" | "error">((resolve) => {
    client.once("connect", () => resolve("connect"));
    client.once("error", () => resolve("error"));
  });
  assert.equal(result, "error");
});
