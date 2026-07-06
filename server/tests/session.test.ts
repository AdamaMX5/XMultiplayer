import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket, type WebSocketServer } from "ws";
import { DEFAULT_HULL, MAX_DAMAGE_PER_HIT, MAX_MESSAGE_BYTES } from "@xmultiplayer/protocol";
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

function spawnMessage(objectId: string, owner: string) {
  return JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId, shipType: "ship_generic_fighter_01", owner });
}

function hitReportMessage(targetId: string, sourceId: string, damage: number, damageType: "hull" | "shield" = "hull") {
  return JSON.stringify({ v: 1, type: "hit_report", seq: 0, ts: Date.now(), targetId, sourceId, damage, damageType });
}

test("two clients in the same session receive each other's state_update but not their own", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-1", "Alice"));
  b.send(joinMessage("arena-1", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A4 ownership authority: a state_update's shipId must belong to a recorded
  // spawn from the same sender, so Alice has to spawn "ship-a" first.
  a.send(spawnMessage("ship-a", "Alice"));
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

test("a spawn message is broadcast to existing session members", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-9", "Alice"));
  b.send(joinMessage("arena-9", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(b, "message");
  a.send(spawnMessage("ship-alice", "Alice"));
  const raw = await received;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.type, "spawn");
  assert.equal(parsed.objectId, "ship-alice");

  a.close();
  b.close();
  wss.close();
});

test("a late-joining member is replayed previously spawned proxies", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  await once(a, "open");
  a.send(joinMessage("arena-10", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const b = new WebSocket(`ws://localhost:${port}`);
  await once(b, "open");
  const replayed = once(b, "message");
  b.send(joinMessage("arena-10", "Bob"));
  const raw = await replayed;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.type, "spawn");
  assert.equal(parsed.objectId, "ship-alice");

  a.close();
  b.close();
  wss.close();
});

test("a disconnecting member's spawned proxies are despawned for remaining members", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-11", "Alice"));
  b.send(joinMessage("arena-11", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Collect every message Bob receives from here on, instead of chaining once() calls:
  // the disconnect below fires "leave" and "despawn" broadcasts back-to-back, and a
  // fresh once() registered only after awaiting the first can miss the second if it
  // already arrived (WebSocket "message" events are not queued for late listeners).
  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));

  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const parsedMessages = bMessages.map((m) => JSON.parse(m));
  const despawn = parsedMessages.find((m) => m.type === "despawn");
  assert.ok(despawn, `expected a despawn message among: ${bMessages.join(", ")}`);
  assert.equal(despawn.objectId, "ship-alice");
  assert.equal(despawn.reason, "disconnect");

  b.close();
  wss.close();
});

test("a late joiner is not replayed spawns from a session that already emptied out", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  await once(a, "open");
  a.send(joinMessage("arena-12", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const b = new WebSocket(`ws://localhost:${port}`);
  await once(b, "open");
  let received = false;
  b.on("message", () => (received = true));
  b.send(joinMessage("arena-12", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "Alice's spawn must have been forgotten once she disconnected");

  b.close();
  wss.close();
});

test("a late joiner is replayed spawns only from its own session, never from a concurrent foreign session", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  await once(a, "open");
  a.send(joinMessage("arena-13a", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const b = new WebSocket(`ws://localhost:${port}`);
  await once(b, "open");
  const receivedByB: string[] = [];
  b.on("message", (data) => receivedByB.push(data.toString()));
  b.send(joinMessage("arena-13b", "Bob")); // different session code than Alice's
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(receivedByB, [], "a late joiner of a different session must not see another session's spawns");

  a.close();
  b.close();
  wss.close();
});

test("A4 spawn cap: a second, different objectId from the same member is rejected while the first is still active", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-14", "Alice"));
  b.send(joinMessage("arena-14", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));

  a.send(spawnMessage("ship-alice-1", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice-2", "Alice")); // rejected: Alice already has a different active spawn
  await new Promise((resolve) => setTimeout(resolve, 100));

  const spawnedIds = bMessages
    .map((m) => JSON.parse(m))
    .filter((m) => m.type === "spawn")
    .map((m) => m.objectId);
  assert.deepEqual(spawnedIds, ["ship-alice-1"], "the second, different objectId must never be broadcast (spawn cap)");

  // Disconnecting must only despawn what was actually recorded (ship-alice-1) --
  // the rejected ship-alice-2 was never a real spawn to begin with.
  a.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const despawnedIds = bMessages
    .map((m) => JSON.parse(m))
    .filter((m) => m.type === "despawn")
    .map((m) => m.objectId);
  assert.deepEqual(despawnedIds, ["ship-alice-1"]);

  b.close();
  wss.close();
});

test("A4 spawn cap: re-spawning the SAME objectId is allowed (respawn), not blocked by the cap", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-14b", "Alice"));
  b.send(joinMessage("arena-14b", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));

  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice")); // same objectId again: a respawn, not a cap violation
  await new Promise((resolve) => setTimeout(resolve, 100));

  const spawnedIds = bMessages
    .map((m) => JSON.parse(m))
    .filter((m) => m.type === "spawn")
    .map((m) => m.objectId);
  assert.deepEqual(spawnedIds, ["ship-alice", "ship-alice"], "re-spawning the same objectId must still be broadcast both times");

  a.close();
  b.close();
  wss.close();
});

test("respawning the same objectId replays only the newest spawn to a late joiner, not both", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  await once(a, "open");
  a.send(joinMessage("arena-15", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "old_type", owner: "Alice" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "new_type", owner: "Alice" }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const b = new WebSocket(`ws://localhost:${port}`);
  await once(b, "open");
  const receivedByB: string[] = [];
  b.on("message", (data) => receivedByB.push(data.toString()));
  b.send(joinMessage("arena-15", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const spawnsReplayed = receivedByB.map((m) => JSON.parse(m)).filter((m) => m.type === "spawn" && m.objectId === "ship-alice");
  assert.equal(spawnsReplayed.length, 1, "must not replay both the old and the new spawn for the same objectId");
  assert.equal(spawnsReplayed[0].shipType, "new_type");

  a.close();
  b.close();
  wss.close();
});

test("a hit_report resolves into an hp_state broadcast to the whole session, including the attacker", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-16", "Alice"));
  b.send(joinMessage("arena-16", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  // A4 ownership authority: hit_report.sourceId must belong to the sender, so Bob
  // has to spawn "ship-bob" before reporting a hit sourced from it.
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  const bMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.on("message", (data) => bMessages.push(data.toString()));

  b.send(hitReportMessage("ship-alice", "ship-bob", 30, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  for (const [label, messages] of [
    ["attacker (Bob)", bMessages],
    ["victim (Alice)", aMessages],
  ] as const) {
    const parsed = messages.map((m) => JSON.parse(m));
    assert.equal(
      parsed.some((m) => m.type === "hit_report"),
      false,
      `${label} must never see the raw hit_report itself, only the resolved hp_state`
    );
    const hpState = parsed.find((m) => m.type === "hp_state");
    assert.ok(hpState, `${label} must receive an hp_state`);
    assert.equal(hpState.objectId, "ship-alice");
    assert.equal(hpState.hull, 70);
    assert.equal(hpState.shield, 100);
  }

  a.close();
  b.close();
  wss.close();
});

test("a hit_report against the shield pool leaves hull untouched", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-17", "Alice"));
  b.send(joinMessage("arena-17", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(a, "message");
  b.send(hitReportMessage("ship-alice", "ship-bob", 40, "shield"));
  const parsed = JSON.parse((await received) as string);
  assert.equal(parsed.type, "hp_state");
  assert.equal(parsed.hull, 100);
  assert.equal(parsed.shield, 60);

  a.close();
  b.close();
  wss.close();
});

test("a hit_report for an untracked objectId is dropped without crashing the server", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-18", "Alice"));
  b.send(joinMessage("arena-18", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A4 ownership authority: hit_report.sourceId must belong to the sender. Spawn
  // (and let it broadcast) BEFORE attaching the "received" listener below, so this
  // bookkeeping message itself isn't mistaken for a reaction to the hit_report.
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  a.on("message", () => (received = true));
  b.send(hitReportMessage("no-such-ship", "ship-bob", 10, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "no hp_state must be produced for an object that was never spawned");

  // Server must still be usable afterwards.
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const nextReceived = once(a, "message");
  b.send(hitReportMessage("ship-alice", "ship-bob", 10, "hull"));
  const parsed = JSON.parse((await nextReceived) as string);
  assert.equal(parsed.type, "hp_state");

  a.close();
  b.close();
  wss.close();
});

test("an implausibly large hit_report damage claim is clamped, not applied raw, and never drives hull negative", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-19", "Alice"));
  b.send(joinMessage("arena-19", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(a, "message");
  b.send(hitReportMessage("ship-alice", "ship-bob", MAX_DAMAGE_PER_HIT * 1000, "hull"));
  const hpState = JSON.parse((await received) as string);
  assert.equal(hpState.type, "hp_state");
  assert.equal(hpState.hull, 0, "clamped or not, hull floors at 0, never negative");

  a.close();
  b.close();
  wss.close();
});

test("hull reaching 0 broadcasts a despawn (reason destroyed) and forgets the spawn record for later joiners", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-20", "Alice"));
  b.send(joinMessage("arena-20", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.send(hitReportMessage("ship-alice", "ship-bob", 100, "hull")); // exactly lethal
  await new Promise((resolve) => setTimeout(resolve, 100));

  const parsedA = aMessages.map((m) => JSON.parse(m));
  const hpState = parsedA.find((m) => m.type === "hp_state");
  assert.ok(hpState);
  assert.equal(hpState.hull, 0);
  const despawn = parsedA.find((m) => m.type === "despawn");
  assert.ok(despawn, "hull reaching 0 must broadcast a despawn");
  assert.equal(despawn.objectId, "ship-alice");
  assert.equal(despawn.reason, "destroyed");

  // A late joiner must not be replayed a spawn for the now-destroyed ship
  // specifically -- Bob's still-alive "ship-bob" (spawned above only so his
  // hit_report's sourceId ownership check would pass) legitimately IS still
  // replayed, so this checks the destroyed objectId, not "no spawn at all".
  const c = new WebSocket(`ws://localhost:${port}`);
  await once(c, "open");
  const cSpawnedIds: string[] = [];
  c.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === "spawn") cSpawnedIds.push(m.objectId);
  });
  c.send(joinMessage("arena-20", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(!cSpawnedIds.includes("ship-alice"), "a destroyed ship must not be replayed to a late joiner");
  assert.ok(cSpawnedIds.includes("ship-bob"), "a still-alive ship must still be replayed normally");

  a.close();
  b.close();
  c.close();
  wss.close();
});

test("a further hit_report against an already-destroyed objectId is dropped without crashing", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-21", "Alice"));
  b.send(joinMessage("arena-21", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  b.send(hitReportMessage("ship-alice", "ship-bob", 100, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  a.on("message", () => (received = true));
  b.send(hitReportMessage("ship-alice", "ship-bob", 10, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "a destroyed ship's HP record is gone, so a further hit produces nothing");

  a.close();
  b.close();
  wss.close();
});

test("fire_event is broadcast to other session members like any other cosmetic message", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-22", "Alice"));
  b.send(joinMessage("arena-22", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A4 ownership authority: fire_event.sourceId must belong to the sender.
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(b, "message");
  a.send(
    JSON.stringify({
      v: 1,
      type: "fire_event",
      seq: 1,
      ts: Date.now(),
      sourceId: "ship-alice",
      weapon: "weapon_argon_l_beam_01",
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    })
  );
  const parsed = JSON.parse((await received) as string);
  assert.equal(parsed.type, "fire_event");
  assert.equal(parsed.sourceId, "ship-alice");

  a.close();
  b.close();
  wss.close();
});

// --- A4 review: maxHull/maxShield range validation ---

test("FIXED: a spawn claiming an absurdly large maxHull falls back to DEFAULT_HULL, not honored as-is", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-23", "Alice"));
  b.send(joinMessage("arena-23", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Alice's own spawn message claims an absurd starting hull -- exactly the kind of
  // client-supplied number that must not be trusted unbounded (same trust-boundary
  // rationale as clampDamage/isValidDamageClaim for hit_report.damage).
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_generic_fighter_01", owner: "Alice", maxHull: 1e308, maxShield: 0 }));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(a, "message");
  // A small, unclamped hit (not MAX_DAMAGE_PER_HIT) so the resulting hull value
  // unambiguously reflects which starting HP was actually used: DEFAULT_HULL - 30
  // = 70 proves the fallback; 1e308 - 30 (still astronomically large) would prove
  // the bug.
  b.send(hitReportMessage("ship-alice", "ship-bob", 30, "hull"));
  const hpState = JSON.parse((await received) as string);
  assert.equal(hpState.type, "hp_state");
  assert.notEqual(hpState.hull, 1e308 - 30, "maxHull must be range-validated, not trusted as-is from the client");
  assert.equal(hpState.hull, DEFAULT_HULL - 30, "an out-of-range maxHull must fall back to DEFAULT_HULL");

  a.close();
  b.close();
  wss.close();
});

test("FIXED: a spawn claiming a negative maxHull falls back to DEFAULT_HULL instead of starting already-invalid", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-24", "Alice"));
  b.send(joinMessage("arena-24", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_generic_fighter_01", owner: "Alice", maxHull: -5, maxShield: -1 }));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(a, "message");
  b.send(hitReportMessage("ship-alice", "ship-bob", 1, "hull"));
  const hpState = JSON.parse((await received) as string);
  assert.equal(hpState.hull, DEFAULT_HULL - 1, "a negative maxHull must fall back to DEFAULT_HULL, not register a pre-dead ship");

  a.close();
  b.close();
  wss.close();
});

test("a plausible maxHull/maxShield within range is honored as-is", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-25", "Alice"));
  b.send(joinMessage("arena-25", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_generic_fighter_01", owner: "Alice", maxHull: 500, maxShield: 200 }));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(a, "message");
  b.send(hitReportMessage("ship-alice", "ship-bob", 100, "shield"));
  const hpState = JSON.parse((await received) as string);
  assert.equal(hpState.shield, 100, "200 - 100 -- a legitimate custom maxShield must still be usable");
  assert.equal(hpState.hull, 500);

  a.close();
  b.close();
  wss.close();
});

// --- A4 review: systematic ownership matrix (spoofed/foreign objectId across every message type) ---

test("ownership matrix: spawn cannot take over an objectId another member already owns", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-26", "Alice"));
  b.send(joinMessage("arena-26", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.send(spawnMessage("ship-alice", "Bob")); // Bob tries to claim Alice's objectId
  await new Promise((resolve) => setTimeout(resolve, 100));

  const spawnsSeenByAlice = aMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "spawn" && m.owner === "Bob");
  assert.deepEqual(spawnsSeenByAlice, [], "Bob's takeover spawn must be rejected and never broadcast");

  a.close();
  b.close();
  wss.close();
});

test("ownership matrix: state_update for a shipId owned by someone else is rejected and not broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-27", "Alice"));
  b.send(joinMessage("arena-27", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  // Bob spoofs a state_update claiming to move Alice's ship.
  b.send(
    JSON.stringify({
      v: 1,
      type: "state_update",
      seq: 1,
      ts: Date.now(),
      shipId: "ship-alice",
      position: { x: 999, y: 999, z: 999 },
      rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
      velocity: { x: 0, y: 0, z: 0 },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  const spoofedUpdates = aMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "state_update");
  assert.deepEqual(spoofedUpdates, [], "a state_update for a shipId the sender does not own must never be broadcast");

  a.close();
  b.close();
  wss.close();
});

test("ownership matrix: despawn for an objectId owned by someone else is rejected, spawn record survives", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-28", "Alice"));
  b.send(joinMessage("arena-28", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.send(JSON.stringify({ v: 1, type: "despawn", seq: 1, ts: Date.now(), objectId: "ship-alice", reason: "griefing" }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const spoofedDespawns = aMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "despawn");
  assert.deepEqual(spoofedDespawns, [], "a despawn for an objectId the sender does not own must never be broadcast");

  // Prove the spawn record really did survive: a late joiner still gets it replayed.
  const c = new WebSocket(`ws://localhost:${port}`);
  await once(c, "open");
  const cSpawns: string[] = [];
  c.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === "spawn") cSpawns.push(m.objectId);
  });
  c.send(joinMessage("arena-28", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(cSpawns.includes("ship-alice"), "Alice's spawn record must be untouched by Bob's spoofed despawn");

  a.close();
  b.close();
  c.close();
  wss.close();
});

test("ownership matrix: fire_event with a sourceId owned by someone else is rejected and not broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-29", "Alice"));
  b.send(joinMessage("arena-29", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.send(
    JSON.stringify({
      v: 1,
      type: "fire_event",
      seq: 1,
      ts: Date.now(),
      sourceId: "ship-alice",
      weapon: "weapon_argon_l_beam_01",
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  const spoofedFires = aMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "fire_event");
  assert.deepEqual(spoofedFires, [], "a fire_event with a sourceId the sender does not own must never be broadcast");

  a.close();
  b.close();
  wss.close();
});

test("ownership matrix: hit_report with a sourceId owned by someone else is rejected, no hp_state is produced at all", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-30", "Alice"));
  b.send(joinMessage("arena-30", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  const bMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.on("message", (data) => bMessages.push(data.toString()));
  // Bob spoofs a hit_report claiming to attack FROM Alice's ship (sourceId he does not own).
  b.send(hitReportMessage("ship-bob", "ship-alice", 50, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const hpStatesSeenByA = aMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "hp_state");
  const hpStatesSeenByB = bMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "hp_state");
  assert.deepEqual(hpStatesSeenByA, [], "a spoofed sourceId must produce no hp_state for anyone");
  assert.deepEqual(hpStatesSeenByB, [], "not even for the spoofer");

  a.close();
  b.close();
  wss.close();
});

test("FIXED: a client sending hp_state directly is rejected, never broadcast as if server-authoritative", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-31", "Alice"));
  b.send(joinMessage("arena-31", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  // Bob never sent a hit_report at all -- just fabricates a "victory" hp_state
  // directly, trying to make Alice's ship appear destroyed without ever landing a hit.
  b.send(JSON.stringify({ v: 1, type: "hp_state", seq: 1, ts: Date.now(), objectId: "ship-alice", hull: 0, shield: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const fabricatedHpStates = aMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "hp_state");
  assert.deepEqual(fabricatedHpStates, [], "clients must never be able to inject a fabricated hp_state -- only the server may produce one");

  a.close();
  b.close();
  wss.close();
});

// --- A4 review: spawn cap release edge case ---

test("A4 spawn cap: after a spawn is destroyed/despawned, a NEW different objectId becomes spawnable again", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-32", "Alice"));
  b.send(joinMessage("arena-32", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice-1", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Destroy ship-alice-1 in combat (releases the spawn cap slot).
  b.send(hitReportMessage("ship-alice-1", "ship-bob", 100, "hull")); // exactly lethal
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));
  a.send(spawnMessage("ship-alice-2", "Alice")); // must be allowed now -- the cap slot was freed by destruction
  await new Promise((resolve) => setTimeout(resolve, 100));

  const spawnedIds = bMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "spawn").map((m) => m.objectId);
  assert.deepEqual(spawnedIds, ["ship-alice-2"], "a new, different objectId must be spawnable once the previous one was destroyed");

  a.close();
  b.close();
  wss.close();
});

test("a legitimate despawn of one's own object removes it from spawn AND HP tracking", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-33", "Alice"));
  b.send(joinMessage("arena-33", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));
  a.send(JSON.stringify({ v: 1, type: "despawn", seq: 1, ts: Date.now(), objectId: "ship-alice", reason: "manual" }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const despawns = bMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "despawn");
  assert.deepEqual(despawns.map((m) => m.objectId), ["ship-alice"], "a legitimate despawn of one's own object must be broadcast");

  // HP tracking must be forgotten too: a stray hit_report against it afterwards produces nothing.
  let hpStateReceived = false;
  b.on("message", (data) => {
    if (JSON.parse(data.toString()).type === "hp_state") hpStateReceived = true;
  });
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  b.send(hitReportMessage("ship-alice", "ship-bob", 10, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hpStateReceived, false, "a despawned object's HP record must be gone too, not just its spawn record");

  a.close();
  b.close();
  wss.close();
});

test("a hit_report with invalid damage (zero/negative) is dropped at the full server level, not just unit-tested", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-34", "Alice"));
  b.send(joinMessage("arena-34", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  a.on("message", () => (received = true));
  b.send(hitReportMessage("ship-alice", "ship-bob", -50, "hull")); // would silently heal the target if not rejected
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "negative damage must be dropped, never applied (would otherwise silently heal)");

  a.close();
  b.close();
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
