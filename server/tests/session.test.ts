import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket, type WebSocketServer } from "ws";
import { MAX_MESSAGE_BYTES } from "@xmultiplayer/protocol";
import { startRelayServer } from "../src/server.js";

function once(emitter: { once: (event: string, cb: (...args: unknown[]) => void) => void }, event: string): Promise<unknown> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function startTestServer(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = startRelayServer({ port: 0 });
  await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;
  return { wss, port };
}

function joinMessage(sessionCode: string, playerName: string) {
  return JSON.stringify({ v: 1, type: "session", action: "join", seq: 0, ts: Date.now(), sessionCode, playerName });
}

test("two clients in the same session receive each other's state_update but not their own", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-1", "Alice"));
  b.send(joinMessage("arena-1", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(b, "message");
  const stateUpdate = {
    v: 1,
    type: "state_update",
    seq: 1,
    ts: Date.now(),
    shipId: "ship-a",
    position: { x: 1, y: 2, z: 3 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    velocity: { x: 0, y: 0, z: 0 },
  };
  a.send(JSON.stringify(stateUpdate));
  const raw = await received;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.type, "state_update");
  assert.equal(parsed.shipId, "ship-a");

  a.close();
  b.close();
  wss.close();
});

test("a client outside any session is not broadcast to", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  b.send(joinMessage("arena-3", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(
    JSON.stringify({
      v: 1,
      type: "chat",
      seq: 1,
      ts: Date.now(),
      from: "Alice",
      text: "hello",
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false);

  a.close();
  b.close();
  wss.close();
});

test("a malformed message is dropped and not broadcast, without crashing the server", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-4", "Alice"));
  b.send(joinMessage("arena-4", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send("{not valid json");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false);

  // Server must still be usable afterwards: a valid message right after the bad one
  // still gets broadcast normally.
  const goodReceived = once(b, "message");
  a.send(JSON.stringify({ v: 1, type: "chat", seq: 1, ts: Date.now(), from: "Alice", text: "still alive" }));
  const raw = await goodReceived;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.text, "still alive");

  a.close();
  b.close();
  wss.close();
});

test("a message with an unsupported protocol version is dropped and not broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-5", "Alice"));
  b.send(joinMessage("arena-5", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(JSON.stringify({ v: 2, type: "chat", seq: 1, ts: Date.now(), from: "Alice", text: "wrong version" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false);

  a.close();
  b.close();
  wss.close();
});

test("members of two different sessions never see each other's messages", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-6a", "Alice"));
  b.send(joinMessage("arena-6b", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(JSON.stringify({ v: 1, type: "chat", seq: 1, ts: Date.now(), from: "Alice", text: "hello arena-6a" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "a client in a different session must not receive the message");

  a.close();
  b.close();
  wss.close();
});

test("disconnecting a client that never joined a session does not crash or broadcast anything", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  b.send(joinMessage("arena-7", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.close(); // a never joined any session
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false);

  b.close();
  wss.close();
});

test("an oversized frame closes that connection but the server stays usable for others", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-8", "Alice"));
  b.send(joinMessage("arena-8", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aClosed = once(a, "close");
  const bSeesLeave = once(b, "message"); // Alice's forced disconnect broadcasts a session "leave" to Bob
  const oversized = JSON.stringify({ v: 1, type: "chat", seq: 1, ts: Date.now(), from: "Alice", text: "x".repeat(MAX_MESSAGE_BYTES) });
  a.send(oversized);
  await aClosed; // ws's maxPayload rejects the frame, which the server turns into a clean disconnect (see server.ts's socket "error" handler)
  await bSeesLeave;

  // The server (and the other client's connection) must still work afterwards.
  const c = new WebSocket(`ws://localhost:${port}`);
  await once(c, "open");
  const bSeesJoin = once(b, "message"); // Carol's own join is broadcast to Bob too
  c.send(joinMessage("arena-8", "Carol"));
  await bSeesJoin;

  const received = once(b, "message");
  c.send(JSON.stringify({ v: 1, type: "chat", seq: 1, ts: Date.now(), from: "Carol", text: "still alive" }));
  const raw = await received;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.text, "still alive");

  b.close();
  c.close();
  wss.close();
});

test("leaving broadcasts a session leave event to remaining members", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-2", "Alice"));
  b.send(joinMessage("arena-2", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const leaveEvent = once(b, "message");
  a.close();
  const raw = await leaveEvent;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.type, "session");
  assert.equal(parsed.action, "leave");
  assert.equal(parsed.playerName, "Alice");

  b.close();
  wss.close();
});
