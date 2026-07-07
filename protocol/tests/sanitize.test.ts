import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CHAT_TEXT_LENGTH,
  MAX_PLAYER_NAME_LENGTH,
  sanitizeChatText,
  sanitizeForPipeExtraction,
  sanitizePlayerName,
  stripControlChars,
  truncate,
} from "../src/sanitize.js";

test("stripControlChars() removes newlines and carriage returns", () => {
  assert.equal(stripControlChars("Alice\nFAKE LOG LINE\r\n"), "AliceFAKE LOG LINE");
});

test("stripControlChars() removes escape/other C0 control characters and DEL", () => {
  assert.equal(stripControlChars("Alice\x1b[31mRED\x7f"), "Alice[31mRED");
});

test("stripControlChars() leaves normal printable text untouched", () => {
  assert.equal(stripControlChars("Alice's Clan #1!"), "Alice's Clan #1!");
});

test("truncate() leaves a short string untouched", () => {
  assert.equal(truncate("hi", 10), "hi");
});

test("truncate() cuts a string down to exactly maxLength", () => {
  assert.equal(truncate("a".repeat(20), 10), "a".repeat(10));
});

test("sanitizePlayerName() strips control chars and truncates to MAX_PLAYER_NAME_LENGTH", () => {
  const withNewline = sanitizePlayerName("Alice\nInjected");
  assert.equal(withNewline, "AliceInjected");
  const tooLong = sanitizePlayerName("a".repeat(100));
  assert.equal(tooLong.length, MAX_PLAYER_NAME_LENGTH);
});

test("sanitizeChatText() strips control chars and truncates to MAX_CHAT_TEXT_LENGTH", () => {
  const tooLong = sanitizeChatText("a".repeat(1000));
  assert.equal(tooLong.length, MAX_CHAT_TEXT_LENGTH);
});

test("sanitizeForPipeExtraction() strips '{', '}', ',' which would break the MD extractor", () => {
  assert.equal(sanitizeForPipeExtraction("{CoolClan} Alice"), "CoolClan Alice");
  assert.equal(sanitizeForPipeExtraction("gg, well played"), "gg well played");
});

test("sanitizeForPipeExtraction() leaves other punctuation untouched", () => {
  assert.equal(sanitizeForPipeExtraction("Alice's Clan #1!"), "Alice's Clan #1!");
});
