import { test } from "node:test";
import assert from "node:assert/strict";
import { NdjsonSplitter } from "../src/ndjson.js";

test("splits a single chunk containing multiple lines", () => {
  const splitter = new NdjsonSplitter();
  const lines = splitter.push('{"a":1}\n{"a":2}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"a":2}']);
});

test("buffers a partial line split across chunks", () => {
  const splitter = new NdjsonSplitter();
  assert.deepEqual(splitter.push('{"a":1}\n{"a":2'), ['{"a":1}']);
  assert.deepEqual(splitter.push("}\n"), ['{"a":2}']);
});

test("ignores empty lines", () => {
  const splitter = new NdjsonSplitter();
  assert.deepEqual(splitter.push('\n\n{"a":1}\n'), ['{"a":1}']);
});

test("flush returns a trailing partial line", () => {
  const splitter = new NdjsonSplitter();
  splitter.push('{"a":1}');
  assert.deepEqual(splitter.flush(), ['{"a":1}']);
});

test("flush returns nothing when the buffer is empty", () => {
  const splitter = new NdjsonSplitter();
  splitter.push('{"a":1}\n');
  assert.deepEqual(splitter.flush(), []);
});

test("strips a trailing carriage return", () => {
  const splitter = new NdjsonSplitter();
  assert.deepEqual(splitter.push('{"a":1}\r\n'), ['{"a":1}']);
});

test("handles a chunk split in the middle of a multi-byte-looking boundary", () => {
  const splitter = new NdjsonSplitter();
  const lines: string[] = [];
  for (const chunk of ['{"a"', ':1}\n{"b":2}', "\n"]) {
    lines.push(...splitter.push(chunk));
  }
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("drops an oversized completed line and reports it, without breaking later lines", () => {
  let dropped = 0;
  const splitter = new NdjsonSplitter({ maxLineBytes: 10, onOversizedLine: (bytes) => (dropped = bytes) });
  const lines = splitter.push('{"way too long":1}\n{"ok":1}\n');
  assert.deepEqual(lines, ['{"ok":1}']);
  assert.equal(dropped, Buffer.byteLength('{"way too long":1}', "utf8"));
});

test("drops a still-accumulating line that never finds a newline once it exceeds the cap", () => {
  let dropped = 0;
  const splitter = new NdjsonSplitter({ maxLineBytes: 10, onOversizedLine: (bytes) => (dropped = bytes) });
  assert.deepEqual(splitter.push("no newline here and it just keeps growing"), []);
  assert.ok(dropped > 10);
  // the buffer was cleared, so a fresh in-bounds line afterwards still works
  assert.deepEqual(splitter.push('{"ok":1}\n'), ['{"ok":1}']);
});

test("uses MAX_MESSAGE_BYTES as the default cap", () => {
  let dropped = 0;
  const splitter = new NdjsonSplitter({ onOversizedLine: (bytes) => (dropped = bytes) });
  splitter.push("x".repeat(100_000) + "\n");
  assert.equal(dropped, 100_000);
});
