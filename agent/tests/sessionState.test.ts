import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProtocolMessage } from "@xmultiplayer/protocol";
import { SessionState } from "../src/sessionState.js";

const base = { v: 1 as const, seq: 0, ts: 1_720_000_000_000 };

function joinMsg(sessionCode: string): ProtocolMessage {
  return { ...base, type: "session", action: "join", sessionCode, playerName: "Alice" };
}
function leaveMsg(sessionCode: string): ProtocolMessage {
  return { ...base, type: "session", action: "leave", sessionCode, playerName: "Alice" };
}
function spawnMsg(objectId: string): ProtocolMessage {
  return { ...base, type: "spawn", objectId, shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice" };
}
function despawnMsg(objectId: string): ProtocolMessage {
  return { ...base, type: "despawn", objectId };
}

test("resendLines() is empty before anything has ever been observed", () => {
  const state = new SessionState();
  assert.deepEqual(state.resendLines(), []);
});

test("a join is remembered and returned by resendLines()", () => {
  const state = new SessionState();
  const msg = joinMsg("arena-1");
  state.observeOutbound(msg, "JOIN_LINE");
  assert.deepEqual(state.resendLines(), ["JOIN_LINE"]);
});

test("join then spawn are both remembered, join first", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("arena-1"), "JOIN_LINE");
  state.observeOutbound(spawnMsg("ship-1"), "SPAWN_LINE");
  assert.deepEqual(state.resendLines(), ["JOIN_LINE", "SPAWN_LINE"]);
});

test("a later join overwrites an earlier one (session switch)", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("arena-1"), "JOIN_A");
  state.observeOutbound(joinMsg("arena-2"), "JOIN_B");
  assert.deepEqual(state.resendLines(), ["JOIN_B"]);
});

test("a leave clears both the join and any remembered own spawn", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("arena-1"), "JOIN_LINE");
  state.observeOutbound(spawnMsg("ship-1"), "SPAWN_LINE");
  state.observeOutbound(leaveMsg("arena-1"), "LEAVE_LINE");
  assert.deepEqual(state.resendLines(), []);
});

test("a despawn for the remembered own objectId clears the spawn but not the join", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("arena-1"), "JOIN_LINE");
  state.observeOutbound(spawnMsg("ship-1"), "SPAWN_LINE");
  state.observeOutbound(despawnMsg("ship-1"), "DESPAWN_LINE");
  assert.deepEqual(state.resendLines(), ["JOIN_LINE"]);
});

test("a despawn for a DIFFERENT objectId does not clear the remembered own spawn", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("arena-1"), "JOIN_LINE");
  state.observeOutbound(spawnMsg("ship-1"), "SPAWN_LINE");
  state.observeOutbound(despawnMsg("some-other-ship"), "DESPAWN_LINE");
  assert.deepEqual(state.resendLines(), ["JOIN_LINE", "SPAWN_LINE"]);
});

test("a respawn (same or different objectId) overwrites the remembered spawn line", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("arena-1"), "JOIN_LINE");
  state.observeOutbound(spawnMsg("ship-1"), "SPAWN_OLD");
  state.observeOutbound(spawnMsg("ship-1"), "SPAWN_NEW");
  assert.deepEqual(state.resendLines(), ["JOIN_LINE", "SPAWN_NEW"]);
});

// --- C2 "Coop" self-announce: lastJoinLine() ---

test("lastJoinLine() is undefined before any join has been observed", () => {
  const state = new SessionState();
  assert.equal(state.lastJoinLine(), undefined);
});

test("lastJoinLine() returns the most recently observed join line", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("coop-1"), "JOIN_A");
  assert.equal(state.lastJoinLine(), "JOIN_A");
  state.observeOutbound(joinMsg("coop-2"), "JOIN_B");
  assert.equal(state.lastJoinLine(), "JOIN_B");
});

test("lastJoinLine() is undefined again after a leave", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("coop-1"), "JOIN_LINE");
  state.observeOutbound(leaveMsg("coop-1"), "LEAVE_LINE");
  assert.equal(state.lastJoinLine(), undefined);
});

test("lastJoinLine() is unaffected by an unrelated spawn/despawn", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("coop-1"), "JOIN_LINE");
  state.observeOutbound(spawnMsg("ship-1"), "SPAWN_LINE");
  state.observeOutbound(despawnMsg("ship-1"), "DESPAWN_LINE");
  assert.equal(state.lastJoinLine(), "JOIN_LINE");
});

test("unrelated message types (state_update, chat, hit_report) do not affect the remembered state", () => {
  const state = new SessionState();
  state.observeOutbound(joinMsg("arena-1"), "JOIN_LINE");
  state.observeOutbound(spawnMsg("ship-1"), "SPAWN_LINE");
  state.observeOutbound(
    {
      ...base,
      type: "state_update",
      shipId: "ship-1",
      position: { x: 0, y: 0, z: 0 },
      rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
      velocity: { x: 0, y: 0, z: 0 },
    },
    "STATE_UPDATE_LINE"
  );
  assert.deepEqual(state.resendLines(), ["JOIN_LINE", "SPAWN_LINE"]);
});
