import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/sessionManager.js";

test("others() excludes the requesting member but includes the rest of the session", () => {
  const sessions = new SessionManager();
  sessions.join("arena-1", { id: "a", playerName: "Alice" });
  sessions.join("arena-1", { id: "b", playerName: "Bob" });
  sessions.join("arena-1", { id: "c", playerName: "Carol" });

  const others = sessions.others("arena-1", "a").map((m) => m.id).sort();
  assert.deepEqual(others, ["b", "c"]);
});

test("others() for an unknown session returns an empty list, not undefined behavior", () => {
  const sessions = new SessionManager();
  assert.deepEqual(sessions.others("no-such-session", "a"), []);
});

test("a client can only be in one session at a time: joining a new session leaves the old one", () => {
  const sessions = new SessionManager();
  sessions.join("arena-1", { id: "a", playerName: "Alice" });
  sessions.join("arena-2", { id: "a", playerName: "Alice" });

  assert.deepEqual(sessions.others("arena-1", "z"), []);
  assert.equal(sessions.sessionCodeOf("a"), "arena-2");
});

test("leave() returns the sessionCode and member, and removes an empty session", () => {
  const sessions = new SessionManager();
  sessions.join("arena-1", { id: "a", playerName: "Alice" });

  const result = sessions.leave("a");
  assert.deepEqual(result, { sessionCode: "arena-1", member: { id: "a", playerName: "Alice" } });
  assert.equal(sessions.sessionCount(), 0);
});

test("leave() keeps a session alive if other members remain", () => {
  const sessions = new SessionManager();
  sessions.join("arena-1", { id: "a", playerName: "Alice" });
  sessions.join("arena-1", { id: "b", playerName: "Bob" });

  sessions.leave("a");
  assert.equal(sessions.sessionCount(), 1);
  assert.deepEqual(sessions.others("arena-1", "z").map((m) => m.id), ["b"]);
});

test("leave() for a member that never joined returns undefined and does not throw", () => {
  const sessions = new SessionManager();
  assert.equal(sessions.leave("ghost"), undefined);
});

test("leave() twice for the same member is idempotent (second call returns undefined)", () => {
  const sessions = new SessionManager();
  sessions.join("arena-1", { id: "a", playerName: "Alice" });
  sessions.leave("a");
  assert.equal(sessions.leave("a"), undefined);
});

test("sessionCount() reflects the number of distinct, non-empty sessions", () => {
  const sessions = new SessionManager();
  assert.equal(sessions.sessionCount(), 0);
  sessions.join("arena-1", { id: "a", playerName: "Alice" });
  sessions.join("arena-2", { id: "b", playerName: "Bob" });
  assert.equal(sessions.sessionCount(), 2);
  sessions.leave("a");
  assert.equal(sessions.sessionCount(), 1);
});
