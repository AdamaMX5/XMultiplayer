import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket, type WebSocketServer } from "ws";
import { MAX_NPC_SPAWNS_PER_CLIENT } from "@xmultiplayer/protocol";
import { startRelayServer, type RelayServerOptions } from "../src/server.js";

/**
 * C3 "NPC-Bubble mit Interest Management": `spawn.category` splits the A4
 * one-spawn-per-client cap into two independent budgets -- these tests pin
 * down that split, plus the fact that "npc" spawns skip the player-only
 * SHIP_MACRO_WHITELIST/shipClassPreset checks entirely (see server.ts's
 * spawn handling, the `category === "player"` branch vs. the `else`).
 */

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

function spawnMessage(objectId: string, owner: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    type: "spawn",
    seq: 0,
    ts: Date.now(),
    objectId,
    shipType: "ship_arg_s_fighter_01_a_macro",
    owner,
    ...overrides,
  });
}

function despawnMessage(objectId: string) {
  return JSON.stringify({ v: 1, type: "despawn", seq: 0, ts: Date.now(), objectId });
}

test("a spawn with category npc and an unwhitelisted shipType is still broadcast (whitelist does not apply to npc)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("npc-1", "Alice"));
  b.send(joinMessage("npc-1", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(b, "message");
  a.send(spawnMessage("npc-obj-1", "Alice", { shipType: "ship_par_l_freighter_01_a_macro", category: "npc" }));
  const raw = await received;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.type, "spawn");
  assert.equal(parsed.category, "npc");
  assert.equal(parsed.shipType, "ship_par_l_freighter_01_a_macro");

  a.close();
  b.close();
  wss.close();
});

test("a spawn with no category (or category player) and an unwhitelisted shipType is still rejected (A2/A5 behavior unchanged)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("npc-2", "Alice"));
  b.send(joinMessage("npc-2", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(spawnMessage("ship-1", "Alice", { shipType: "totally_made_up_macro" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false);

  a.close();
  b.close();
  wss.close();
});

test("a client may hold one player spawn AND one npc spawn simultaneously (independent budgets)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("npc-3", "Alice"));
  b.send(joinMessage("npc-3", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const receivedTypes: string[] = [];
  b.on("message", (raw) => receivedTypes.push(JSON.parse(raw.toString()).type));

  a.send(spawnMessage("ship-alice", "Alice", { category: "player" }));
  a.send(spawnMessage("npc-1", "Alice", { category: "npc" }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(receivedTypes, ["spawn", "spawn"], "both the player ship and the npc spawn must be broadcast, neither blocked by the other's cap");

  a.close();
  b.close();
  wss.close();
});

test("a player-category spawn attempt while a DIFFERENT player spawn is active is still rejected (A4 cap unchanged)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("npc-4", "Alice"));
  b.send(joinMessage("npc-4", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const receivedTypes: string[] = [];
  b.on("message", (raw) => receivedTypes.push(JSON.parse(raw.toString()).objectId));

  a.send(spawnMessage("ship-alice-1", "Alice", { category: "player" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Spawning npc's don't count against this, but a SECOND player spawn does.
  a.send(spawnMessage("ship-alice-2", "Alice", { category: "player" }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(receivedTypes, ["ship-alice-1"], "the second, different player-category objectId must never be broadcast (A4 spawn cap)");

  a.close();
  b.close();
  wss.close();
});

test(`an npc spawn beyond MAX_NPC_SPAWNS_PER_CLIENT (${MAX_NPC_SPAWNS_PER_CLIENT}) is rejected`, async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("npc-5", "Alice"));
  b.send(joinMessage("npc-5", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const receivedObjectIds: string[] = [];
  b.on("message", (raw) => receivedObjectIds.push(JSON.parse(raw.toString()).objectId));

  for (let i = 0; i < MAX_NPC_SPAWNS_PER_CLIENT; i += 1) {
    a.send(spawnMessage(`npc-${i}`, "Alice", { category: "npc" }));
  }
  // One over the cap.
  a.send(spawnMessage(`npc-${MAX_NPC_SPAWNS_PER_CLIENT}`, "Alice", { category: "npc" }));
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(receivedObjectIds.length, MAX_NPC_SPAWNS_PER_CLIENT, "exactly the cap's worth of npc spawns must be broadcast");
  assert.ok(!receivedObjectIds.includes(`npc-${MAX_NPC_SPAWNS_PER_CLIENT}`), "the one-over-cap npc spawn must never be broadcast");

  a.close();
  b.close();
  wss.close();
});

test("despawning an npc frees a slot under MAX_NPC_SPAWNS_PER_CLIENT for a new one", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("npc-6", "Alice"));
  b.send(joinMessage("npc-6", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  for (let i = 0; i < MAX_NPC_SPAWNS_PER_CLIENT; i += 1) {
    a.send(spawnMessage(`npc-${i}`, "Alice", { category: "npc" }));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));

  a.send(despawnMessage("npc-0"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const received = once(b, "message");
  a.send(spawnMessage("npc-new", "Alice", { category: "npc" }));
  const raw = await received;
  assert.equal(JSON.parse((raw as Buffer).toString()).objectId, "npc-new");

  a.close();
  b.close();
  wss.close();
});

test("re-sending a spawn for an npc objectId the client still owns is rejected by the existing respawn-gate, not silently accepted as a fresh slot", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("npc-7", "Alice"));
  b.send(joinMessage("npc-7", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const receivedCount: string[] = [];
  b.on("message", (raw) => receivedCount.push(JSON.parse(raw.toString()).objectId));

  a.send(spawnMessage("npc-dup", "Alice", { category: "npc" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(spawnMessage("npc-dup", "Alice", { category: "npc" })); // still alive, re-spawn attempt
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(receivedCount, ["npc-dup"], "the duplicate re-spawn of a still-active npc must not be broadcast a second time");

  a.close();
  b.close();
  wss.close();
});
