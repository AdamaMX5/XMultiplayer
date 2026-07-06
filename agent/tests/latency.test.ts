import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateLatencyMs, MAX_LATENCY_MS } from "../src/latency.js";

test("computes the difference between now and the sent timestamp", () => {
  assert.equal(estimateLatencyMs(1000, 1250), 250);
});

test("clamps negative differences (clock skew) to 0", () => {
  assert.equal(estimateLatencyMs(2000, 1000), 0);
});

test("returns 0 for a message that arrived instantly", () => {
  assert.equal(estimateLatencyMs(1000, 1000), 0);
});

test("defaults to the real clock when now is not supplied", () => {
  const sentAt = Date.now() - 50;
  const latency = estimateLatencyMs(sentAt);
  assert.ok(latency >= 50 && latency < 5000, `expected a small positive latency, got ${latency}`);
});

// Fixed in the A3 review: a large clock skew (sender's clock minutes ahead) is far
// more likely to be clock skew than genuine network latency, so it's now clamped to
// MAX_LATENCY_MS rather than fed as-is into Dead Reckoning's extrapolation -- see
// docs/A3-messprotokoll.md section 6 and latency.ts's doc comment.
test("clamps a very large positive difference (e.g. sender clock minutes ahead) to MAX_LATENCY_MS", () => {
  const tenMinutesMs = 10 * 60 * 1000;
  const latency = estimateLatencyMs(1000, 1000 + tenMinutesMs);
  assert.equal(latency, MAX_LATENCY_MS, "a 10-minute clock skew must be capped, not reported as a 10-minute latency");
});

test("does not clamp a value right at MAX_LATENCY_MS", () => {
  assert.equal(estimateLatencyMs(0, MAX_LATENCY_MS), MAX_LATENCY_MS);
});

// estimateLatencyMs itself stays a pure, stateless function of its two arguments
// (no smoothing here) -- smoothing across messages for the same sender is
// LatencyTracker's job (agent/src/latencyTracker.ts, see latencyTracker.test.ts),
// kept as a separate concern so this function's own contract stays simple.
test("is a pure function: back-to-back calls for the same sender are independent (smoothing lives in LatencyTracker, not here)", () => {
  const first = estimateLatencyMs(1000, 1050); // 50ms
  const second = estimateLatencyMs(1000, 1500); // 500ms, wildly different from the first
  assert.equal(first, 50);
  assert.equal(second, 500);
});
