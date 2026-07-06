import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayStats, resetWindow } from "../src/relayStats.js";

test("createRelayStats initializes all counters to zero/null and windowStart to the given time", () => {
  const stats = createRelayStats(1_000);
  assert.deepEqual(stats, { lastMdRate: null, windowCount: 0, windowStart: 1_000, remoteForwarded: 0, remoteDropped: 0 });
});

test("createRelayStats defaults windowStart to the real clock when not supplied", () => {
  const before = Date.now();
  const stats = createRelayStats();
  const after = Date.now();
  assert.ok(stats.windowStart >= before && stats.windowStart <= after);
});

test("resetWindow zeroes windowCount and updates windowStart, without touching the other counters", () => {
  const stats = createRelayStats(1_000);
  stats.windowCount = 42;
  stats.remoteForwarded = 7;
  stats.remoteDropped = 2;
  stats.lastMdRate = 9.5;

  resetWindow(stats, 5_000);

  assert.equal(stats.windowCount, 0);
  assert.equal(stats.windowStart, 5_000);
  assert.equal(stats.remoteForwarded, 7, "resetWindow must only touch the per-window tick counter, not cumulative stats");
  assert.equal(stats.remoteDropped, 2);
  assert.equal(stats.lastMdRate, 9.5);
});

test("resetWindow defaults its timestamp to the real clock when not supplied", () => {
  const stats = createRelayStats(1_000);
  const before = Date.now();
  resetWindow(stats);
  const after = Date.now();
  assert.ok(stats.windowStart >= before && stats.windowStart <= after);
});
