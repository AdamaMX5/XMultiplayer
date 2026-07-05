import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRelay } from "../src/relayFilter.js";

const base = { v: 1 as const, seq: 1, ts: 1_720_000_000_000 };

test("forwards a spawn with a whitelisted shipType", () => {
  const decision = decideRelay({ ...base, type: "spawn", objectId: "ship-1", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice" });
  assert.equal(decision.forward, true);
});

test("rejects a spawn with an unknown shipType", () => {
  const decision = decideRelay({ ...base, type: "spawn", objectId: "ship-1", shipType: "totally_made_up_macro", owner: "Alice" });
  assert.equal(decision.forward, false);
  if (!decision.forward) assert.match(decision.reason, /unknown shipType/);
});

test("forwards a despawn regardless of content (no shipType to check)", () => {
  const decision = decideRelay({ ...base, type: "despawn", objectId: "ship-1" });
  assert.equal(decision.forward, true);
});

test("forwards a state_update (no shipType to check)", () => {
  const decision = decideRelay({
    ...base,
    type: "state_update",
    shipId: "ship-1",
    position: { x: 0, y: 0, z: 0 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    velocity: { x: 0, y: 0, z: 0 },
  });
  assert.equal(decision.forward, true);
});
