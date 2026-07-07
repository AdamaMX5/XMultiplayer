import { test } from "node:test";
import assert from "node:assert/strict";
import { ARENA_BOUNDS_METERS, MAX_VELOCITY_MPS } from "@xmultiplayer/protocol";
import { decideRelay } from "../src/relayFilter.js";

const base = { v: 1 as const, seq: 1, ts: 1_720_000_000_000 };
const noneKnown: ReadonlySet<string> = new Set();

function stateUpdate(overrides: Partial<{ shipId: string; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } }> = {}) {
  return {
    ...base,
    type: "state_update" as const,
    shipId: "ship-1",
    position: { x: 0, y: 0, z: 0 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

test("forwards a spawn with a whitelisted shipType", () => {
  const decision = decideRelay({ ...base, type: "spawn", objectId: "ship-1", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice" }, noneKnown);
  assert.equal(decision.forward, true);
});

test("rejects a spawn with an unknown shipType", () => {
  const decision = decideRelay({ ...base, type: "spawn", objectId: "ship-1", shipType: "totally_made_up_macro", owner: "Alice" }, noneKnown);
  assert.equal(decision.forward, false);
  if (!decision.forward) assert.match(decision.reason, /unknown shipType/);
});

test("forwards a despawn regardless of content (no shipType to check, no ownership filter on this path)", () => {
  const decision = decideRelay({ ...base, type: "despawn", objectId: "ship-1" }, noneKnown);
  assert.equal(decision.forward, true);
});

test("forwards a state_update for a known shipId within plausible bounds", () => {
  const decision = decideRelay(stateUpdate(), new Set(["ship-1"]));
  assert.equal(decision.forward, true);
});

// --- A4: orphan filter ---

test("rejects a state_update for a shipId with no known spawn (orphan)", () => {
  const decision = decideRelay(stateUpdate(), noneKnown);
  assert.equal(decision.forward, false);
  if (!decision.forward) assert.match(decision.reason, /orphan shipId/);
});

test("rejects a hit_report for a targetId with no known spawn (orphan)", () => {
  const decision = decideRelay(
    { ...base, type: "hit_report", targetId: "ship-unknown", sourceId: "ship-1", damage: 10, damageType: "hull" },
    noneKnown
  );
  assert.equal(decision.forward, false);
  if (!decision.forward) assert.match(decision.reason, /orphan targetId/);
});

test("forwards a hit_report for a known targetId", () => {
  const decision = decideRelay(
    { ...base, type: "hit_report", targetId: "ship-1", sourceId: "ship-2", damage: 10, damageType: "hull" },
    new Set(["ship-1"])
  );
  assert.equal(decision.forward, true);
});

// --- A4: Arena position/velocity bounds ---

test("rejects a state_update with a position outside the Arena bounds", () => {
  const decision = decideRelay(stateUpdate({ position: { x: ARENA_BOUNDS_METERS + 1, y: 0, z: 0 } }), new Set(["ship-1"]));
  assert.equal(decision.forward, false);
  if (!decision.forward) assert.match(decision.reason, /Arena bounds/);
});

test("accepts a state_update with a position exactly at the Arena bounds", () => {
  const decision = decideRelay(stateUpdate({ position: { x: -ARENA_BOUNDS_METERS, y: ARENA_BOUNDS_METERS, z: 0 } }), new Set(["ship-1"]));
  assert.equal(decision.forward, true);
});

test("rejects a state_update with an implausible velocity", () => {
  const decision = decideRelay(stateUpdate({ velocity: { x: MAX_VELOCITY_MPS * 10, y: 0, z: 0 } }), new Set(["ship-1"]));
  assert.equal(decision.forward, false);
  if (!decision.forward) assert.match(decision.reason, /velocity/);
});

test("accepts a state_update with velocity exactly at the plausible max", () => {
  const decision = decideRelay(stateUpdate({ velocity: { x: MAX_VELOCITY_MPS, y: 0, z: 0 } }), new Set(["ship-1"]));
  assert.equal(decision.forward, true);
});

// --- A4: hp_state must NOT be caught by the orphan filter ---
//
// hp_state is the server-authoritative outcome of a hit_report and is broadcast to
// the WHOLE session, including the attacker's OWN ship -- an objectId this agent
// never adds to knownObjectIds/knownSpawns, since those only ever track REMOTE
// spawns (index.ts only calls knownSpawns.set on an incoming remote `spawn`, never
// for the local player's own ship). If decideRelay ever grew an orphan check for
// hp_state symmetric to state_update's, it would silently swallow every hp_state
// about the player's own ship and combat damage would never reach the game.
test("forwards an hp_state even when its objectId is not in knownObjectIds (own ship is never a 'known remote spawn')", () => {
  const decision = decideRelay({ ...base, type: "hp_state", objectId: "own-ship-never-in-known-spawns", hull: 0, shield: 0 }, noneKnown);
  assert.equal(decision.forward, true);
});

// --- C1: sector_object/sector_mirror have no bounds/ownership/orphan filter --
// static sector scenery is not tied to a "known spawn" the way a ship is.

test("forwards a sector_object regardless of knownObjectIds content", () => {
  const decision = decideRelay(
    {
      ...base,
      type: "sector_object",
      objectId: "station-1",
      objectType: "station",
      macroName: "station_arg_shipyard_01_macro",
      position: { x: 999_999, y: 0, z: 0 },
      rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    },
    noneKnown
  );
  assert.equal(decision.forward, true);
});

test("forwards sector_mirror begin/end unconditionally", () => {
  const begin = decideRelay({ ...base, type: "sector_mirror", action: "begin", objectCount: 10 }, noneKnown);
  assert.equal(begin.forward, true);
  const end = decideRelay({ ...base, type: "sector_mirror", action: "end" }, noneKnown);
  assert.equal(end.forward, true);
});
