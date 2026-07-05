import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { ReconnectingWebSocket } from "../src/wsClient.js";

function once(emitter: { once: (event: string, cb: (...args: unknown[]) => void) => void }, event: string): Promise<unknown> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function startTestServer(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  return { wss, port: (wss.address() as AddressInfo).port };
}

test("connects and reports onOpen, then forwards received messages via onMessage", async () => {
  const { wss, port } = await startTestServer();
  wss.on("connection", (socket) => socket.send("hello from server"));

  const received: string[] = [];
  let opened = false;
  const client = new ReconnectingWebSocket({
    url: `ws://localhost:${port}`,
    onOpen: () => (opened = true),
    onMessage: (data) => received.push(data),
  });
  client.connect();

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(opened, true);
  assert.deepEqual(received, ["hello from server"]);

  client.close();
  wss.close();
});

test("send() forwards data to the server only once the socket is open", async () => {
  const { wss, port } = await startTestServer();
  const serverReceived: string[] = [];
  wss.on("connection", (socket) => socket.on("message", (data) => serverReceived.push(data.toString())));

  const client = new ReconnectingWebSocket({ url: `ws://localhost:${port}`, onMessage: () => {} });

  // Calling send() before connect()/open must not throw and must be a no-op.
  assert.doesNotThrow(() => client.send("too early"));

  client.connect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.send("state_update payload");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(serverReceived, ["state_update payload"]);
  client.close();
  wss.close();
});

test("close() suppresses automatic reconnect after the socket closes", async () => {
  const { wss, port } = await startTestServer();
  let opens = 0;
  let closes = 0;
  const client = new ReconnectingWebSocket({
    url: `ws://localhost:${port}`,
    onOpen: () => (opens += 1),
    onClose: () => (closes += 1),
    onMessage: () => {},
    minBackoffMs: 20,
  });
  client.connect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(opens, 1);

  client.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(closes, 1);
  assert.equal(opens, 1, "must not have reconnected after a user-initiated close");
  wss.close();
});

test("reconnects with exponentially increasing backoff, capped at maxBackoffMs, after an unexpected close", async () => {
  const delays: number[] = [];
  const originalSetTimeout = global.setTimeout;
  // Intercept scheduling to observe the requested backoff without waiting for it in
  // real time: record the delay, then fire (almost) immediately so the test stays fast.
  // Important: keep using `originalSetTimeout` (not the patched global) for the test's
  // own waiting below, or the wait itself gets short-circuited by this same patch.
  (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    delays.push(ms ?? 0);
    return originalSetTimeout(fn, 0);
  }) as typeof setTimeout;

  try {
    const client = new ReconnectingWebSocket({
      // Nothing listens here; the connection attempt fails immediately (ECONNREFUSED),
      // which triggers 'close' on the ws client the same way a server restart would.
      url: "ws://127.0.0.1:1",
      onMessage: () => {},
      minBackoffMs: 10,
      maxBackoffMs: 40,
    });
    client.connect();

    await new Promise((resolve) => originalSetTimeout(resolve, 500));
    client.close();

    assert.ok(delays.length >= 3, `expected several reconnect attempts, got ${delays.length}`);
    assert.equal(delays[0], 10);
    assert.equal(delays[1], 20);
    assert.equal(delays[2], 40);
    assert.ok(
      delays.slice(2).every((d) => d === 40),
      "backoff must not exceed maxBackoffMs"
    );
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("onClose fires and reconnect is scheduled when the server side closes the connection", async () => {
  const { wss, port } = await startTestServer();
  wss.on("connection", (socket) => socket.close());

  let closes = 0;
  const client = new ReconnectingWebSocket({
    url: `ws://localhost:${port}`,
    onClose: () => (closes += 1),
    onMessage: () => {},
    minBackoffMs: 20,
    maxBackoffMs: 20,
  });
  client.connect();

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(closes >= 1);

  client.close();
  wss.close();
});
