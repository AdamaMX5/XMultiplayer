import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DAMAGE_PER_HIT, MAX_STARTING_HP } from "@xmultiplayer/protocol";
import { clampDamage, HpTracker, isDestroyed, isValidDamageClaim, isValidStartingHp } from "../src/hpTracker.js";

test("register() sets the starting hull/shield for a newly tracked object", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 50);
  assert.deepEqual(hp.get("arena-1", "ship-1"), { hull: 100, shield: 50 });
});

test("applyDamage(shield) absorbed entirely by shield leaves hull untouched", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 50);
  const result = hp.applyDamage("arena-1", "ship-1", 20, "shield");
  assert.deepEqual(result, { hull: 100, shield: 30 });
});

test("applyDamage(hull) bypasses shield entirely, always applies straight to hull", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 50);
  const result = hp.applyDamage("arena-1", "ship-1", 20, "hull");
  assert.deepEqual(result, { hull: 80, shield: 50 });
});

test("applyDamage(shield) exceeding the remaining shield spills the overflow into hull (\"Shield vor Hull\")", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 30);
  // 50 damage: 30 depletes the shield entirely, the remaining 20 overflows into hull.
  const result = hp.applyDamage("arena-1", "ship-1", 50, "shield");
  assert.deepEqual(result, { hull: 80, shield: 0 });
});

test("applyDamage(shield) with an already-depleted shield applies the full amount to hull", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 0);
  const result = hp.applyDamage("arena-1", "ship-1", 25, "shield");
  assert.deepEqual(result, { hull: 75, shield: 0 });
});

test("applyDamage() clamps a pool at 0, never negative (hull bypass)", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 10, 10);
  const result = hp.applyDamage("arena-1", "ship-1", 999, "hull");
  assert.deepEqual(result, { hull: 0, shield: 10 });
});

test("applyDamage() clamps hull at 0, never negative, even with shield overflow", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 10, 5);
  const result = hp.applyDamage("arena-1", "ship-1", 999, "shield");
  assert.deepEqual(result, { hull: 0, shield: 0 });
});

test("applyDamage() accumulates across multiple hits", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 100);
  hp.applyDamage("arena-1", "ship-1", 30, "hull");
  const result = hp.applyDamage("arena-1", "ship-1", 20, "hull");
  assert.deepEqual(result, { hull: 50, shield: 100 });
});

test("applyDamage() returns undefined for an object never registered in that session", () => {
  const hp = new HpTracker();
  assert.equal(hp.applyDamage("arena-1", "never-spawned", 10, "hull"), undefined);
});

test("applyDamage() returns undefined for an object registered in a DIFFERENT session", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 100);
  assert.equal(hp.applyDamage("arena-2", "ship-1", 10, "hull"), undefined);
});

test("remove() forgets the object, so a later applyDamage returns undefined", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 100);
  hp.remove("arena-1", "ship-1");
  assert.equal(hp.applyDamage("arena-1", "ship-1", 10, "hull"), undefined);
});

test("register() overwrites prior state (respawn gets fresh HP, not leftover damage)", () => {
  const hp = new HpTracker();
  hp.register("arena-1", "ship-1", 100, 100);
  hp.applyDamage("arena-1", "ship-1", 90, "hull");
  hp.register("arena-1", "ship-1", 100, 100);
  assert.deepEqual(hp.get("arena-1", "ship-1"), { hull: 100, shield: 100 });
});

test("isDestroyed() is true once hull reaches 0, regardless of remaining shield", () => {
  assert.equal(isDestroyed({ hull: 0, shield: 100 }), true);
  assert.equal(isDestroyed({ hull: 1, shield: 0 }), false);
  assert.equal(isDestroyed({ hull: 0, shield: 0 }), true);
});

test("clampDamage() passes plausible damage through unchanged", () => {
  assert.equal(clampDamage(25), 25);
  assert.equal(clampDamage(MAX_DAMAGE_PER_HIT), MAX_DAMAGE_PER_HIT);
});

test("clampDamage() caps an implausibly large damage claim at MAX_DAMAGE_PER_HIT", () => {
  assert.equal(clampDamage(999_999_999), MAX_DAMAGE_PER_HIT);
});

test("isValidDamageClaim() accepts a plausible positive damage value", () => {
  assert.equal(isValidDamageClaim(25), true);
  assert.equal(isValidDamageClaim(0.5), true);
});

test("isValidDamageClaim() rejects zero and negative values (regeneration does not exist in v1)", () => {
  assert.equal(isValidDamageClaim(0), false);
  assert.equal(isValidDamageClaim(-10), false, "negative damage would otherwise silently heal the target");
});

test("isValidDamageClaim() rejects non-finite values", () => {
  assert.equal(isValidDamageClaim(NaN), false);
  assert.equal(isValidDamageClaim(Infinity), false);
  assert.equal(isValidDamageClaim(-Infinity), false);
});

test("isValidStartingHp() accepts a plausible positive value within range", () => {
  assert.equal(isValidStartingHp(100), true);
  assert.equal(isValidStartingHp(1), true);
  assert.equal(isValidStartingHp(MAX_STARTING_HP), true, "the upper bound itself must be accepted, not rejected");
});

test("isValidStartingHp() rejects zero, negative, and non-finite values", () => {
  assert.equal(isValidStartingHp(0), false);
  assert.equal(isValidStartingHp(-5), false);
  assert.equal(isValidStartingHp(NaN), false);
  assert.equal(isValidStartingHp(Infinity), false);
});

test("isValidStartingHp() rejects a value above MAX_STARTING_HP, however large", () => {
  assert.equal(isValidStartingHp(MAX_STARTING_HP + 1), false);
  assert.equal(isValidStartingHp(1e308), false);
});
