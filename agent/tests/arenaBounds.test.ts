import { test } from "node:test";
import assert from "node:assert/strict";
import { ARENA_BOUNDS_METERS, isPlausibleVelocity, isWithinArenaBounds, MAX_VELOCITY_MPS } from "../src/arenaBounds.js";

test("isWithinArenaBounds() accepts the origin", () => {
  assert.equal(isWithinArenaBounds({ x: 0, y: 0, z: 0 }), true);
});

test("isWithinArenaBounds() accepts a position exactly at the boundary on every axis", () => {
  assert.equal(isWithinArenaBounds({ x: ARENA_BOUNDS_METERS, y: -ARENA_BOUNDS_METERS, z: ARENA_BOUNDS_METERS }), true);
});

test("isWithinArenaBounds() rejects a position just past the boundary on a single axis", () => {
  assert.equal(isWithinArenaBounds({ x: ARENA_BOUNDS_METERS + 1, y: 0, z: 0 }), false);
  assert.equal(isWithinArenaBounds({ x: 0, y: -(ARENA_BOUNDS_METERS + 1), z: 0 }), false);
  assert.equal(isWithinArenaBounds({ x: 0, y: 0, z: ARENA_BOUNDS_METERS * 2 }), false);
});

test("isWithinArenaBounds() rejects NaN/Infinity coordinates", () => {
  assert.equal(isWithinArenaBounds({ x: NaN, y: 0, z: 0 }), false);
  assert.equal(isWithinArenaBounds({ x: 0, y: Infinity, z: 0 }), false);
  assert.equal(isWithinArenaBounds({ x: 0, y: 0, z: -Infinity }), false);
});

test("isPlausibleVelocity() accepts zero velocity", () => {
  assert.equal(isPlausibleVelocity({ x: 0, y: 0, z: 0 }), true);
});

test("isPlausibleVelocity() accepts a velocity vector exactly at the max magnitude", () => {
  assert.equal(isPlausibleVelocity({ x: MAX_VELOCITY_MPS, y: 0, z: 0 }), true);
});

test("isPlausibleVelocity() rejects a velocity vector exceeding the max magnitude", () => {
  assert.equal(isPlausibleVelocity({ x: MAX_VELOCITY_MPS + 1, y: 0, z: 0 }), false);
});

test("isPlausibleVelocity() checks the combined magnitude across all three axes, not each axis independently", () => {
  // Each axis alone is well under the max, but the combined magnitude exceeds it.
  const perAxis = MAX_VELOCITY_MPS * 0.7;
  assert.equal(isPlausibleVelocity({ x: perAxis, y: perAxis, z: perAxis }), false);
});

test("isPlausibleVelocity() rejects NaN/Infinity components", () => {
  assert.equal(isPlausibleVelocity({ x: NaN, y: 0, z: 0 }), false);
  assert.equal(isPlausibleVelocity({ x: 0, y: Infinity, z: 0 }), false);
});
