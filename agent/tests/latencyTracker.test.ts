import { test } from "node:test";
import assert from "node:assert/strict";
import { LatencyTracker } from "../src/latencyTracker.js";

test("the first sample for a sender is returned as-is (no history to blend with)", () => {
  const tracker = new LatencyTracker();
  assert.equal(tracker.update("ship-1", 100), 100);
});

test("converges toward a steady stream of similar samples", () => {
  const tracker = new LatencyTracker({ alpha: 0.2 });
  let last = 0;
  for (let i = 0; i < 50; i++) {
    last = tracker.update("ship-1", 80);
  }
  assert.ok(Math.abs(last - 80) < 0.5, `expected convergence near 80, got ${last}`);
});

test("dampens a single outlier relative to the raw jump", () => {
  const tracker = new LatencyTracker({ alpha: 0.2 });
  for (let i = 0; i < 20; i++) tracker.update("ship-1", 50);
  const afterOutlier = tracker.update("ship-1", 1000); // one huge spike
  // Raw jump would be 950ms; EWMA at alpha=0.2 should only move ~190ms (0.2 * (1000-50)).
  assert.ok(afterOutlier < 300, `expected the outlier to be heavily dampened, got ${afterOutlier}`);
  assert.ok(afterOutlier > 50, "the outlier should still nudge the estimate upward somewhat");
});

test("tracks separate senders independently", () => {
  const tracker = new LatencyTracker();
  tracker.update("ship-1", 200);
  tracker.update("ship-2", 20);
  assert.equal(tracker.get("ship-1"), 200);
  assert.equal(tracker.get("ship-2"), 20);
});

test("get() returns undefined for a sender with no recorded sample", () => {
  const tracker = new LatencyTracker();
  assert.equal(tracker.get("never-seen"), undefined);
});

test("reset() forgets history, so the next sample is treated as the first again", () => {
  const tracker = new LatencyTracker({ alpha: 0.2 });
  for (let i = 0; i < 20; i++) tracker.update("ship-1", 500);
  tracker.reset("ship-1");
  assert.equal(tracker.get("ship-1"), undefined);
  assert.equal(tracker.update("ship-1", 30), 30, "post-reset sample must not be blended with pre-reset history");
});
