import { test } from "node:test";
import assert from "node:assert/strict";
import { createStats, recordSeq } from "../src/stats.js";

test("counts received messages with no gaps for consecutive seq", () => {
  const stats = createStats();
  recordSeq(stats, 0);
  recordSeq(stats, 1);
  recordSeq(stats, 2);
  assert.equal(stats.received, 3);
  assert.equal(stats.gaps, 0);
});

test("detects a single missing sequence number", () => {
  const stats = createStats();
  recordSeq(stats, 0);
  recordSeq(stats, 2);
  assert.equal(stats.gaps, 1);
});

test("detects a multi-message gap", () => {
  const stats = createStats();
  recordSeq(stats, 5);
  recordSeq(stats, 10);
  assert.equal(stats.gaps, 4);
});

test("does not flag a duplicate or out-of-order seq as a gap", () => {
  const stats = createStats();
  recordSeq(stats, 5);
  recordSeq(stats, 5);
  recordSeq(stats, 3);
  assert.equal(stats.gaps, 0);
});

test("tracks the first seq without counting a gap", () => {
  const stats = createStats();
  recordSeq(stats, 42);
  assert.equal(stats.gaps, 0);
  assert.equal(stats.lastSeq, 42);
});
