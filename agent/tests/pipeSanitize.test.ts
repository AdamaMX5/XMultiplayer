import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProtocolMessage } from "@xmultiplayer/protocol";
import { sanitizeForPipe } from "../src/pipeSanitize.js";

const base = { v: 1 as const, seq: 0, ts: 1_720_000_000_000 };

test("sanitizes session.playerName: strips control chars, MD-breaking characters, and truncates", () => {
  const msg: ProtocolMessage = { ...base, type: "session", action: "join", sessionCode: "arena-1", playerName: "{CoolClan}\n Alice, the Great" };
  const result = sanitizeForPipe(msg) as typeof msg;
  assert.equal(result.playerName, "CoolClan Alice the Great");
});

test("leaves a session message with no playerName untouched", () => {
  const msg: ProtocolMessage = { ...base, type: "session", action: "leave", sessionCode: "arena-1" };
  const result = sanitizeForPipe(msg);
  assert.deepEqual(result, msg);
});

test("sanitizes chat.from and chat.text", () => {
  const msg: ProtocolMessage = { ...base, type: "chat", from: "{Clan} Bob", text: "gg, well played\n" };
  const result = sanitizeForPipe(msg) as typeof msg;
  assert.equal(result.from, "Clan Bob");
  assert.equal(result.text, "gg well played");
});

test("leaves other message types completely untouched", () => {
  const msg: ProtocolMessage = {
    ...base,
    type: "spawn",
    objectId: "ship-1",
    shipType: "ship_arg_s_fighter_01_a_macro",
    owner: "Alice",
  };
  assert.deepEqual(sanitizeForPipe(msg), msg);
});

test("sanitizes both sector_object.objectId and macroName (C1) for MD-breaking characters, without touching objectType", () => {
  const msg: ProtocolMessage = {
    ...base,
    type: "sector_object",
    objectId: "station-{evil},1",
    objectType: "station",
    macroName: "station_{evil}, macro",
    position: { x: 0, y: 0, z: 0 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
  };
  const result = sanitizeForPipe(msg) as typeof msg;
  assert.equal(result.objectId, "station-evil1");
  assert.equal(result.macroName, "station_evil macro");
  assert.equal(result.objectType, "station");
});

test("leaves a clean sector_object's objectId/macroName as-is", () => {
  const msg: ProtocolMessage = {
    ...base,
    type: "sector_object",
    objectId: "station-1",
    objectType: "station",
    macroName: "station_arg_shipyard_01_macro",
    position: { x: 0, y: 0, z: 0 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
  };
  const result = sanitizeForPipe(msg) as typeof msg;
  assert.equal(result.objectId, "station-1");
  assert.equal(result.macroName, "station_arg_shipyard_01_macro");
});

test("leaves sector_mirror completely untouched (no free-form text fields)", () => {
  const msg: ProtocolMessage = { ...base, type: "sector_mirror", action: "begin", objectCount: 5 };
  assert.deepEqual(sanitizeForPipe(msg), msg);
});

// --- C3: an "npc"-category spawn's objectId/shipType are sanitized, a "player" one is not ---

test("sanitizes objectId and shipType for a spawn with category npc", () => {
  const msg: ProtocolMessage = {
    ...base,
    type: "spawn",
    objectId: "npc-{evil},1",
    shipType: "ship_{evil}, freighter_macro",
    owner: "Alice",
    category: "npc",
  };
  const result = sanitizeForPipe(msg) as typeof msg;
  assert.equal(result.objectId, "npc-evil1");
  assert.equal(result.shipType, "ship_evil freighter_macro");
  assert.equal(result.owner, "Alice", "owner is not one of the sanitized fields");
});

test("leaves a spawn with category player untouched, even with MD-breaking characters (pre-existing, out-of-scope gap for player spawns)", () => {
  const msg: ProtocolMessage = {
    ...base,
    type: "spawn",
    objectId: "ship-{evil},1",
    shipType: "ship_arg_s_fighter_01_a_macro",
    owner: "Alice",
    category: "player",
  };
  assert.deepEqual(sanitizeForPipe(msg), msg);
});

test("leaves a spawn with no category untouched (defaults to player behavior)", () => {
  const msg: ProtocolMessage = {
    ...base,
    type: "spawn",
    objectId: "ship-{evil},1",
    shipType: "ship_arg_s_fighter_01_a_macro",
    owner: "Alice",
  };
  assert.deepEqual(sanitizeForPipe(msg), msg);
});

test("does not mutate the original message object", () => {
  const msg: ProtocolMessage = { ...base, type: "chat", from: "{Clan} Bob", text: "hi" };
  const original = { ...msg };
  sanitizeForPipe(msg);
  assert.deepEqual(msg, original);
});
