import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "../src/parse.js";
import { MAX_MESSAGE_BYTES } from "../src/limits.js";

const base = { v: 1, seq: 1, ts: 1_720_000_000_000 };

test("rejects malformed JSON", () => {
  const result = parseMessage("{not json");
  assert.equal(result.ok, false);
});

test("rejects a non-object JSON value", () => {
  const result = parseMessage("42");
  assert.equal(result.ok, false);
});

test("rejects an unsupported protocol version", () => {
  const result = parseMessage(JSON.stringify({ ...base, v: 2, type: "chat", from: "a", text: "hi" }));
  assert.equal(result.ok, false);
});

test("rejects missing seq/ts", () => {
  const result = parseMessage(JSON.stringify({ v: 1, type: "chat", from: "a", text: "hi" }));
  assert.equal(result.ok, false);
});

test("rejects an unknown message type", () => {
  const result = parseMessage(JSON.stringify({ ...base, type: "does_not_exist" }));
  assert.equal(result.ok, false);
});

test("accepts a valid state_update", () => {
  const msg = {
    ...base,
    type: "state_update",
    shipId: "ship-1",
    position: { x: 1, y: 2, z: 3 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    mdRate: 8.3,
  };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.message.type, "state_update");
});

test("rejects state_update with a malformed position", () => {
  const msg = {
    ...base,
    type: "state_update",
    shipId: "ship-1",
    position: { x: 1, y: 2 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    velocity: { x: 0, y: 0, z: 0 },
  };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("accepts a valid spawn", () => {
  const msg = { ...base, type: "spawn", objectId: "obj-1", shipType: "ship_argon_s_fighter_01", owner: "player-1", loadout: ["weapon_a", "shield_b"] };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("rejects spawn with a non-string-array loadout", () => {
  const msg = { ...base, type: "spawn", objectId: "obj-1", shipType: "ship_argon_s_fighter_01", owner: "player-1", loadout: [1, 2] };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("accepts a valid despawn", () => {
  const msg = { ...base, type: "despawn", objectId: "obj-1", reason: "session_end" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("rejects despawn missing objectId", () => {
  const msg = { ...base, type: "despawn" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("accepts a valid hit_report", () => {
  const msg = { ...base, type: "hit_report", targetId: "obj-1", sourceId: "obj-2", damage: 42, damageType: "shield" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("rejects hit_report with an invalid damageType", () => {
  const msg = { ...base, type: "hit_report", targetId: "obj-1", sourceId: "obj-2", damage: 42, damageType: "armor" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("accepts a valid hp_state", () => {
  const msg = { ...base, type: "hp_state", objectId: "obj-1", hull: 100, shield: 50 };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("rejects hp_state with a non-numeric hull", () => {
  const msg = { ...base, type: "hp_state", objectId: "obj-1", hull: "full", shield: 50 };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("accepts a valid fire_event", () => {
  const msg = {
    ...base,
    type: "fire_event",
    sourceId: "obj-1",
    weapon: "weapon_argon_l_beam_01",
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
  };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("rejects fire_event with a malformed direction", () => {
  const msg = {
    ...base,
    type: "fire_event",
    sourceId: "obj-1",
    weapon: "weapon_argon_l_beam_01",
    origin: { x: 0, y: 0, z: 0 },
    direction: "forward",
  };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("accepts a valid session join", () => {
  const msg = { ...base, type: "session", action: "join", sessionCode: "arena-1", playerName: "Alice" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("accepts a valid session countdown", () => {
  const msg = { ...base, type: "session", action: "countdown", sessionCode: "arena-1", countdownSeconds: 3 };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("rejects session with an invalid action", () => {
  const msg = { ...base, type: "session", action: "teleport", sessionCode: "arena-1" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("accepts session seta_on and seta_off (A5)", () => {
  const on = parseMessage(JSON.stringify({ ...base, type: "session", action: "seta_on", sessionCode: "arena-1", playerName: "Alice" }));
  assert.equal(on.ok, true);
  const off = parseMessage(JSON.stringify({ ...base, type: "session", action: "seta_off", sessionCode: "arena-1", playerName: "Alice" }));
  assert.equal(off.ok, true);
});

test("accepts a valid chat message", () => {
  const msg = { ...base, type: "chat", from: "Alice", text: "gg" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("rejects session with a non-numeric countdownSeconds", () => {
  const msg = { ...base, type: "session", action: "countdown", sessionCode: "arena-1", countdownSeconds: "three" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("rejects spawn with a non-array, non-undefined loadout", () => {
  const msg = { ...base, type: "spawn", objectId: "obj-1", shipType: "ship_argon_s_fighter_01", owner: "player-1", loadout: "not-an-array" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

// Fixed resource-exhaustion gap: parseMessage now enforces MAX_MESSAGE_BYTES so an
// oversized line/frame is rejected outright instead of growing buffers unbounded.
// The same constant caps the NdjsonSplitter buffer (agent/src/ndjson.ts) and the
// WebSocketServer's maxPayload (server/src/server.ts).
test("rejects a payload larger than MAX_MESSAGE_BYTES", () => {
  const msg = { ...base, type: "chat", from: "Alice", text: "x".repeat(200_000) };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});

test("accepts a payload right at the MAX_MESSAGE_BYTES boundary", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, type: "chat", from: "Alice", text: "" }), "utf8");
  const text = "x".repeat(MAX_MESSAGE_BYTES - overhead);
  const msg = { ...base, type: "chat", from: "Alice", text };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, true);
});

test("rejects chat missing text", () => {
  const msg = { ...base, type: "chat", from: "Alice" };
  const result = parseMessage(JSON.stringify(msg));
  assert.equal(result.ok, false);
});
