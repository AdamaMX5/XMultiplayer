import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket, type WebSocketServer } from "ws";
import { DEFAULT_HULL, MAX_DAMAGE_PER_HIT, MAX_MESSAGE_BYTES } from "@xmultiplayer/protocol";
import { startRelayServer, type RelayServerOptions } from "../src/server.js";

function once(emitter: { once: (event: string, cb: (...args: unknown[]) => void) => void }, event: string): Promise<unknown> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function startTestServer(options: Omit<RelayServerOptions, "port"> = {}): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = startRelayServer({ port: 0, ...options });
  await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;
  return { wss, port };
}

function joinMessage(sessionCode: string, playerName: string) {
  return JSON.stringify({ v: 1, type: "session", action: "join", seq: 0, ts: Date.now(), sessionCode, playerName });
}

function spawnMessage(objectId: string, owner: string) {
  return JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId, shipType: "ship_arg_s_fighter_01_a_macro", owner });
}

function hitReportMessage(targetId: string, sourceId: string, damage: number, damageType: "hull" | "shield" = "hull") {
  return JSON.stringify({ v: 1, type: "hit_report", seq: 0, ts: Date.now(), targetId, sourceId, damage, damageType });
}

function despawnMessage(objectId: string) {
  return JSON.stringify({ v: 1, type: "despawn", seq: 0, ts: Date.now(), objectId });
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

test("A5: the server itself rejects a spawn with a shipType outside the macro whitelist (not just the agent)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-9b", "Alice"));
  b.send(joinMessage("arena-9b", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "totally_made_up_macro", owner: "Alice" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "a client connecting directly to the WebSocket (bypassing the agent's own whitelist check) must still be rejected server-side");

  a.close();
  b.close();
  wss.close();
});

test("A5 ship class rule preset: a spawn outside the configured preset is rejected, one inside it is accepted", async () => {
  const { wss, port } = await startTestServer({ shipClassPreset: "s" }); // S-class only arena
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-9c", "Alice"));
  b.send(joinMessage("arena-9c", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(
    JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_arg_m_corvette_01_a_macro", owner: "Alice" })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "an M-class ship must be rejected under an S-only preset");

  const spawnReceived = once(b, "message");
  a.send(spawnMessage("ship-alice", "Alice")); // S-class, from the shared helper
  const raw = await spawnReceived;
  assert.equal(JSON.parse((raw as Buffer).toString()).type, "spawn", "an S-class ship must still be accepted under an S-only preset");

  a.close();
  b.close();
  wss.close();
});

test("A5 kill-feed: destruction broadcasts a chat message naming both the attacker and the victim", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-killfeed", "Alice"));
  b.send(joinMessage("arena-killfeed", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.send(JSON.stringify({ v: 1, type: "hit_report", seq: 0, ts: Date.now(), targetId: "ship-alice", sourceId: "ship-bob", damage: DEFAULT_HULL, damageType: "hull" }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const parsedA = aMessages.map((m) => JSON.parse(m));
  const killFeed = parsedA.find((m) => m.type === "chat");
  assert.ok(killFeed, `victim must also receive the kill-feed chat message, got: ${aMessages.join(", ")}`);
  assert.equal(killFeed.from, "server");
  assert.equal(killFeed.text, "Bob destroyed Alice");

  a.close();
  b.close();
  wss.close();
});

test("C4 kill-feed: destroying an NPC names it by shipType, not the exporting player's own name", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-npc-killfeed", "Alice"));
  b.send(joinMessage("arena-npc-killfeed", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Alice exports a nearby NPC (C3 category="npc" spawn) -- she is its "owner"
  // on the wire the same way she owns her own ship, but she never PILOTS it.
  a.send(
    JSON.stringify({
      v: 1,
      type: "spawn",
      seq: 0,
      ts: Date.now(),
      objectId: "npc-1",
      shipType: "ship_par_s_scout_01_a_macro",
      owner: "Alice",
      category: "npc",
    })
  );
  // Bob (a different member than the exporter) needs to own a spawn of his own
  // before the server accepts a hit_report with a sourceId he owns (A4
  // ownership authority, requireOwnership() in server.ts).
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));
  b.send(hitReportMessage("npc-1", "ship-bob", DEFAULT_HULL, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const parsedB = bMessages.map((m) => JSON.parse(m));
  const killFeed = parsedB.find((m) => m.type === "chat");
  assert.ok(killFeed, `attacker must also receive the kill-feed chat message, got: ${bMessages.join(", ")}`);
  assert.equal(killFeed.from, "server");
  assert.equal(
    killFeed.text,
    "Bob destroyed ship_par_s_scout_01_a_macro",
    "an NPC victim must be named by its shipType, never by the exporting player's own name (docs/C3-messprotokoll.md section 5.6)"
  );

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

test("A4 spawn cap: re-spawning the SAME objectId is allowed (respawn) after a proper despawn, not blocked by the cap", async () => {
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
  // A5 respawn gate: a still-active objectId cannot simply be re-spawned (that
  // would be a free self-heal); despawn it properly first, THEN respawn.
  a.send(despawnMessage("ship-alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const spawnedIds = bMessages
    .map((m) => JSON.parse(m))
    .filter((m) => m.type === "spawn")
    .map((m) => m.objectId);
  assert.deepEqual(spawnedIds, ["ship-alice", "ship-alice"], "respawning the same objectId after a proper despawn must still be broadcast both times");

  a.close();
  b.close();
  wss.close();
});

test("A5 respawn gate: re-spawning a STILL-ACTIVE objectId (no destruction/despawn in between) is rejected, closing a self-heal exploit", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-respawn-gate", "Alice"));
  b.send(joinMessage("arena-respawn-gate", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Damage Alice's ship first, so a successful "self-heal" would be observable
  // (hp.register() resets to full hull/shield).
  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.send(hitReportMessage("ship-alice", "ship-bob", 40, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const damagedState = aMessages.map((m) => JSON.parse(m)).find((m) => m.type === "hp_state");
  assert.ok(damagedState);
  assert.equal(damagedState.hull, 60);

  // Attempt the exploit: re-spawn the SAME still-alive objectId, hoping it resets HP.
  aMessages.length = 0;
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    !aMessages.map((m) => JSON.parse(m)).some((m) => m.type === "spawn"),
    "the re-spawn attempt on a still-active objectId must be rejected, not broadcast"
  );

  // Confirm no heal happened: a further hit must apply on top of the ALREADY
  // reduced hull (60), not on a freshly reset 100.
  aMessages.length = 0;
  b.send(hitReportMessage("ship-alice", "ship-bob", 10, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterAttemptedHeal = aMessages.map((m) => JSON.parse(m)).find((m) => m.type === "hp_state");
  assert.ok(afterAttemptedHeal);
  assert.equal(afterAttemptedHeal.hull, 50, "hull must continue from 60 (not reset to 100 by the rejected respawn), i.e. 60 - 10 = 50");

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
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // A5 respawn gate: a still-active objectId cannot simply be re-spawned; despawn first.
  a.send(despawnMessage("ship-alice"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_arg_s_fighter_02_a_macro", owner: "Alice" }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const b = new WebSocket(`ws://localhost:${port}`);
  await once(b, "open");
  const receivedByB: string[] = [];
  b.on("message", (data) => receivedByB.push(data.toString()));
  b.send(joinMessage("arena-15", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const spawnsReplayed = receivedByB.map((m) => JSON.parse(m)).filter((m) => m.type === "spawn" && m.objectId === "ship-alice");
  assert.equal(spawnsReplayed.length, 1, "must not replay both the old and the new spawn for the same objectId");
  assert.equal(spawnsReplayed[0].shipType, "ship_arg_s_fighter_02_a_macro");

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
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice", maxHull: 1e308, maxShield: 0 }));
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
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice", maxHull: -5, maxShield: -1 }));
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
  a.send(JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId: "ship-alice", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice", maxHull: 500, maxShield: 200 }));
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

test("A5 review fix: switching sessions (join a DIFFERENT session while already in one) despawns the old session's spawns for remaining members, forgets their HP, and does not leave a ghost for a late joiner of the old session", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  // Alice and Bob both start in session A (the "old sector").
  a.send(joinMessage("arena-switch-a", "Alice"));
  b.send(joinMessage("arena-switch-a", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));

  // Alice "walks into a different sector": joins session B without ever disconnecting.
  a.send(joinMessage("arena-switch-b", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const parsedByB = bMessages.map((m) => JSON.parse(m));
  const leaveMsg = parsedByB.find((m) => m.type === "session" && m.action === "leave");
  assert.ok(leaveMsg, `Bob (remaining in the old session) must see a session leave for Alice, got: ${bMessages.join(", ")}`);
  assert.equal(leaveMsg.playerName, "Alice");
  const despawnMsg = parsedByB.find((m) => m.type === "despawn");
  assert.ok(despawnMsg, `Bob must see ship-alice despawned from the old session, got: ${bMessages.join(", ")}`);
  assert.equal(despawnMsg.objectId, "ship-alice");
  assert.equal(despawnMsg.reason, "disconnect", "a session switch is modeled the same way a disconnect's cleanup is, not a combat destruction");

  // A late joiner of the OLD session must not be replayed a ghost spawn for ship-alice.
  const c = new WebSocket(`ws://localhost:${port}`);
  await once(c, "open");
  const cSpawnedIds: string[] = [];
  c.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === "spawn") cSpawnedIds.push(m.objectId);
  });
  c.send(joinMessage("arena-switch-a", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(!cSpawnedIds.includes("ship-alice"), "ship-alice must not be replayed as a ghost spawn in the old session");
  assert.ok(cSpawnedIds.includes("ship-bob"), "ship-bob (Bob never left) must still be replayed normally");

  // HP for ship-alice in the OLD session must be gone too: a hit_report against it
  // from Bob (still in session A, owns ship-bob) must produce no hp_state at all.
  let bobSawHpState = false;
  b.on("message", (data) => {
    if (JSON.parse(data.toString()).type === "hp_state") bobSawHpState = true;
  });
  b.send(hitReportMessage("ship-alice", "ship-bob", 10, "hull"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(bobSawHpState, false, "ship-alice's HP must have been forgotten along with its spawn record when Alice switched sessions");

  a.close();
  b.close();
  c.close();
  wss.close();
});

test("switching to the SAME sessionCode again is not treated as a session switch (no spurious despawn/leave)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-resame", "Alice"));
  b.send(joinMessage("arena-resame", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));

  a.send(joinMessage("arena-resame", "Alice")); // re-joins the SAME session
  await new Promise((resolve) => setTimeout(resolve, 150));

  const parsedByB = bMessages.map((m) => JSON.parse(m));
  assert.ok(!parsedByB.some((m) => m.type === "despawn"), "re-joining the same session must not despawn the member's own still-valid spawn");

  a.close();
  b.close();
  wss.close();
});

test("A5 general rate limit: a client exceeding the configured message rate has further messages dropped", async () => {
  const { wss, port } = await startTestServer({ generalRateLimit: { capacity: 2, refillPerSecond: 1 } });
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-ratelimit", "Alice")); // consumes 1 of the 2 tokens
  b.send(joinMessage("arena-ratelimit", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));

  a.send(JSON.stringify({ v: 1, type: "chat", seq: 1, ts: Date.now(), from: "Alice", text: "1" })); // consumes the 2nd token
  a.send(JSON.stringify({ v: 1, type: "chat", seq: 2, ts: Date.now(), from: "Alice", text: "2" })); // no tokens left, must be dropped
  await new Promise((resolve) => setTimeout(resolve, 100));

  const chatTexts = bMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "chat").map((m) => m.text);
  assert.deepEqual(chatTexts, ["1"], "the message beyond the rate limit must be dropped");

  a.close();
  b.close();
  wss.close();
});

test("A5 hit_report rate limit: a SEPARATE, tighter limit applies specifically to hit_report", async () => {
  const { wss, port } = await startTestServer({ hitReportRateLimit: { capacity: 1, refillPerSecond: 1 } });
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-hitratelimit", "Alice"));
  b.send(joinMessage("arena-hitratelimit", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.send(hitReportMessage("ship-alice", "ship-bob", 10, "hull")); // consumes the only token
  b.send(hitReportMessage("ship-alice", "ship-bob", 10, "hull")); // no tokens left, must be dropped
  await new Promise((resolve) => setTimeout(resolve, 100));

  const hpStates = aMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "hp_state");
  assert.equal(hpStates.length, 1, "only the first hit_report should have been processed");
  assert.equal(hpStates[0].hull, 90);

  a.close();
  b.close();
  wss.close();
});

test("A5 connection limits: a connection beyond maxConnections is rejected", async () => {
  const { wss, port } = await startTestServer({ maxConnections: 1 });
  const a = new WebSocket(`ws://localhost:${port}`);
  await once(a, "open");

  const b = new WebSocket(`ws://localhost:${port}`);
  const bClosed = once(b, "close");
  await bClosed;

  a.close();
  wss.close();
});

test("A5 connection limits: a connection beyond maxConnectionsPerIp is rejected (loopback counts as one IP)", async () => {
  const { wss, port } = await startTestServer({ maxConnectionsPerIp: 1 });
  const a = new WebSocket(`ws://localhost:${port}`);
  await once(a, "open");

  const b = new WebSocket(`ws://localhost:${port}`);
  const bClosed = once(b, "close");
  await bClosed;

  a.close();
  wss.close();
});

test("A5 max sessions: joining a NEW session beyond maxSessions is rejected, but joining an EXISTING one never is", async () => {
  const { wss, port } = await startTestServer({ maxSessions: 1 });
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  const c = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open"), once(c, "open")]);

  a.send(joinMessage("arena-first", "Alice")); // creates the one allowed session
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Bob joining the SAME session must still work even though the cap is reached.
  const aMessages: string[] = [];
  a.on("message", (data) => aMessages.push(data.toString()));
  b.send(joinMessage("arena-first", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    aMessages.map((m) => JSON.parse(m)).some((m) => m.type === "session" && m.action === "join" && m.playerName === "Bob"),
    "joining an EXISTING session must never be blocked by the session cap"
  );

  // Carol trying to create a SECOND, different session must be rejected.
  c.send(joinMessage("arena-second", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  c.send(spawnMessage("ship-carol", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // If Carol's join had succeeded, her spawn would be accepted and broadcast to
  // nobody-in-particular (she'd be alone) -- the real proof is that a late
  // joiner of "arena-second" sees nothing at all, i.e. the session never formed.
  const late = new WebSocket(`ws://localhost:${port}`);
  await once(late, "open");
  const lateMessages: string[] = [];
  late.on("message", (data) => lateMessages.push(data.toString()));
  late.send(joinMessage("arena-second", "Dave"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(lateMessages.map((m) => JSON.parse(m)).filter((m) => m.type === "spawn"), [], "arena-second must never have formed, so there is nothing to replay");

  a.close();
  b.close();
  c.close();
  late.close();
  wss.close();
});

test("A5 public mode: the LAN default sessionCode and overly short codes are rejected", async () => {
  const { wss, port } = await startTestServer({ publicMode: true });
  const a = new WebSocket(`ws://localhost:${port}`);
  await once(a, "open");

  let received = false;
  a.on("message", () => (received = true));
  a.send(joinMessage("arena", "Alice")); // the well-known LAN default
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "the LAN default sessionCode must be rejected in public mode");

  a.send(joinMessage("short", "Alice")); // shorter than MIN_PUBLIC_SESSION_CODE_LENGTH
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "an overly short sessionCode must be rejected in public mode");

  a.close();
  wss.close();
});

test("A5 public mode: a sufficiently long, non-default sessionCode is accepted", async () => {
  const { wss, port } = await startTestServer({ publicMode: true });
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("a-sufficiently-long-private-code", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(a, "message");
  b.send(joinMessage("a-sufficiently-long-private-code", "Bob"));
  const raw = await received;
  assert.equal(JSON.parse((raw as Buffer).toString()).playerName, "Bob");

  a.close();
  b.close();
  wss.close();
});

test("A5 outside public mode, the LAN default sessionCode still works normally", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(a, "message");
  b.send(joinMessage("arena", "Bob"));
  const raw = await received;
  assert.equal(JSON.parse((raw as Buffer).toString()).playerName, "Bob");

  a.close();
  b.close();
  wss.close();
});

test("A5 string sanitizing: a chat message with control characters and excessive length is sanitized before being broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-sanitize-chat", "Alice"));
  b.send(joinMessage("arena-sanitize-chat", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(b, "message");
  a.send(JSON.stringify({ v: 1, type: "chat", seq: 1, ts: Date.now(), from: "Alice\nFAKE LOG LINE", text: "hi\r\nthere" + "x".repeat(500) }));
  const raw = await received;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.from, "AliceFAKE LOG LINE");
  assert.ok(!parsed.text.includes("\n") && !parsed.text.includes("\r"));
  assert.ok(parsed.text.length <= 256);

  a.close();
  b.close();
  wss.close();
});

test("A5 string sanitizing: a playerName with control characters is sanitized both in what's stored and what's broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  b.send(joinMessage("arena-sanitize-name", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(b, "message");
  a.send(joinMessage("arena-sanitize-name", "Alice\x1b[31mInjected"));
  const raw = await received;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.playerName, "Alice[31mInjected");

  a.close();
  b.close();
  wss.close();
});

test("A5: the server itself rejects a state_update with a position outside plausible Arena bounds (not just the agent)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-serverbounds", "Alice"));
  b.send(joinMessage("arena-serverbounds", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(
    JSON.stringify({
      v: 1,
      type: "state_update",
      seq: 1,
      ts: Date.now(),
      shipId: "ship-alice",
      position: { x: 999_999_999, y: 0, z: 0 },
      rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
      velocity: { x: 0, y: 0, z: 0 },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "a state_update outside plausible Arena bounds must be rejected server-side even from an owned shipId");

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

function leaveMessage(sessionCode: string, playerName: string) {
  return JSON.stringify({ v: 1, type: "session", action: "leave", seq: 0, ts: Date.now(), sessionCode, playerName });
}

test("A5 fix: an explicit client-sent leave (not just a WS disconnect) actually removes session membership, not just a decorative broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("arena-explicit-leave", "Alice"));
  b.send(joinMessage("arena-explicit-leave", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bMessages: string[] = [];
  b.on("message", (data) => bMessages.push(data.toString()));

  a.send(leaveMessage("arena-explicit-leave", "Alice")); // still connected, just leaving the session
  await new Promise((resolve) => setTimeout(resolve, 150));

  const parsedByB = bMessages.map((m) => JSON.parse(m));
  assert.ok(parsedByB.some((m) => m.type === "session" && m.action === "leave"), "Bob must see the leave broadcast");
  const despawn = parsedByB.find((m) => m.type === "despawn");
  assert.ok(despawn, "Alice's spawn must be despawned, proving real cleanup ran, not just a decorative broadcast");
  assert.equal(despawn.objectId, "ship-alice");

  // The real proof: Alice is no longer tracked as being in this session at all
  // (before the fix, sessions.leave() was never called for this path, so a
  // subsequent state_update would still have been accepted/broadcast as if she
  // were still a member).
  let received = false;
  b.on("message", (data) => {
    if (JSON.parse(data.toString()).type === "state_update") received = true;
  });
  a.send(
    JSON.stringify({
      v: 1,
      type: "state_update",
      seq: 1,
      ts: Date.now(),
      shipId: "ship-alice",
      position: { x: 0, y: 0, z: 0 },
      rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
      velocity: { x: 0, y: 0, z: 0 },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false, "Alice must no longer be treated as a member of the session she explicitly left");

  a.close();
  b.close();
  wss.close();
});
