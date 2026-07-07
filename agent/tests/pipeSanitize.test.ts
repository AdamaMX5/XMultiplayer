import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProtocolMessage } from "@xmultiplayer/protocol";
import { sanitizeForPipe } from "../src/pipeSanitize.js";

const base = { v: 1 as const, seq: 0, ts: 1_720_000_000_000 };

test("sanitizes session.playerName: strips control chars, MD-breaking characters, and truncates", () => {
  const msg: ProtocolMessage = { ...base, type: "session", action: "join", sessionCode: "arena-1", playerName: "{CoolClan}\n Alice, the Great" };
  const result = sanitizeForPipe(msg) as typeof msg;
  assert.equal(result.playerName, "CoolClan Alice the Great");
});

test("leaves a session message with no playerName untouched", () => {
  const msg: ProtocolMessage = { ...base, type: "session", action: "leave", sessionCode: "arena-1" };
  const result = sanitizeForPipe(msg);
  assert.deepEqual(result, msg);
});

test("sanitizes chat.from and chat.text", () => {
  const msg: ProtocolMessage = { ...base, type: "chat", from: "{Clan} Bob", text: "gg, well played\n" };
  const result = sanitizeForPipe(msg) as typeof msg;
  assert.equal(result.from, "Clan Bob");
  assert.equal(result.text, "gg well played");
});

test("leaves other message types completely untouched", () => {
  const msg: ProtocolMessage = {
    ...base,
    type: "spawn",
    objectId: "ship-1",
    shipType: "ship_arg_s_fighter_01_a_macro",
    owner: "Alice",
  };
  assert.deepEqual(sanitizeForPipe(msg), msg);
});

test("does not mutate the original message object", () => {
  const msg: ProtocolMessage = { ...base, type: "chat", from: "{Clan} Bob", text: "hi" };
  const original = { ...msg };
  sanitizeForPipe(msg);
  assert.deepEqual(msg, original);
});
