import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../src/rateLimiter.js";

test("allows up to `capacity` consumes instantly (burst), then rejects", () => {
  const bucket = new TokenBucket(3, 1);
  const now = 1_000_000;
  assert.equal(bucket.tryConsume("a", now), true);
  assert.equal(bucket.tryConsume("a", now), true);
  assert.equal(bucket.tryConsume("a", now), true);
  assert.equal(bucket.tryConsume("a", now), false, "the 4th consume within the same instant must be rejected");
});

test("refills over time at refillPerSecond", () => {
  const bucket = new TokenBucket(1, 2); // capacity 1, refills at 2/s
  const t0 = 1_000_000;
  assert.equal(bucket.tryConsume("a", t0), true);
  assert.equal(bucket.tryConsume("a", t0), false, "no tokens left immediately after");
  assert.equal(bucket.tryConsume("a", t0 + 100), false, "100ms at 2/s is only 0.2 tokens, still not enough");
  assert.equal(bucket.tryConsume("a", t0 + 600), true, "600ms at 2/s is 1.2 tokens, capped at capacity 1, enough for one more");
});

test("never refills past capacity even after a long gap", () => {
  const bucket = new TokenBucket(2, 100); // fast refill
  const t0 = 1_000_000;
  bucket.tryConsume("a", t0);
  // A huge gap would refill far more than capacity if not clamped.
  assert.equal(bucket.tryConsume("a", t0 + 60_000), true);
  assert.equal(bucket.tryConsume("a", t0 + 60_000), true);
  assert.equal(bucket.tryConsume("a", t0 + 60_000), false, "capacity is 2, a 3rd immediate consume must fail regardless of how long the gap was");
});

test("different keys have independent buckets", () => {
  const bucket = new TokenBucket(1, 1);
  const now = 1_000_000;
  assert.equal(bucket.tryConsume("a", now), true);
  assert.equal(bucket.tryConsume("a", now), false);
  assert.equal(bucket.tryConsume("b", now), true, "a different key must not be affected by 'a' being exhausted");
});

test("reset() forgets a key's bucket, so a later consume starts fresh at full capacity", () => {
  const bucket = new TokenBucket(1, 1);
  const now = 1_000_000;
  bucket.tryConsume("a", now);
  assert.equal(bucket.tryConsume("a", now), false);
  bucket.reset("a");
  assert.equal(bucket.tryConsume("a", now), true, "after reset, a fresh bucket should have full capacity again");
});

test("reset() for a key that was never used does not throw", () => {
  const bucket = new TokenBucket(1, 1);
  assert.doesNotThrow(() => bucket.reset("never-used"));
});
