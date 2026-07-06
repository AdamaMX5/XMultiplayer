import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPipeLine } from "../src/pipeMessage.js";

const base = { v: 1 as const, seq: 1, ts: 1_720_000_000_000 };

test("appends the given linkLatencyMs to a state_update", () => {
  const msg = {
    ...base,
    type: "state_update" as const,
    shipId: "ship-1",
    position: { x: 1, y: 2, z: 3 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    velocity: { x: 0, y: 0, z: 0 },
  };
  const line = buildPipeLine(msg, 120);
  const parsed = JSON.parse(line);
  assert.equal(parsed.linkLatencyMs, 120);
  assert.equal(parsed.shipId, "ship-1");
});

test("does not append linkLatencyMs to non-state_update messages, even if a value is passed", () => {
  const msg = { ...base, type: "spawn" as const, objectId: "ship-1", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice" };
  const line = buildPipeLine(msg, 500);
  const parsed = JSON.parse(line);
  assert.equal("linkLatencyMs" in parsed, false);
});

test("does not append linkLatencyMs to a state_update when no value is passed", () => {
  const msg = {
    ...base,
    type: "state_update" as const,
    shipId: "ship-1",
    position: { x: 0, y: 0, z: 0 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    velocity: { x: 0, y: 0, z: 0 },
  };
  const line = buildPipeLine(msg);
  assert.equal("linkLatencyMs" in JSON.parse(line), false);
});

test("passes through whatever value the caller computed, including 0", () => {
  const msg = {
    ...base,
    type: "state_update" as const,
    shipId: "ship-1",
    position: { x: 0, y: 0, z: 0 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    velocity: { x: 0, y: 0, z: 0 },
  };
  const line = buildPipeLine(msg, 0);
  assert.equal(JSON.parse(line).linkLatencyMs, 0);
});

test("output is still a valid canonical message (fields unaffected beyond the addition)", () => {
  const msg = { ...base, type: "despawn" as const, objectId: "ship-1", reason: "disconnect" };
  const line = buildPipeLine(msg);
  const parsed = JSON.parse(line);
  assert.deepEqual(parsed, { v: 1, type: "despawn", seq: 1, ts: base.ts, objectId: "ship-1", reason: "disconnect" });
});
