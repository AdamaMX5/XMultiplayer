import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, pipePath } from "../src/config.js";

test("uses hard-coded defaults when no CLI args or env vars are given", () => {
  const config = parseConfig([], {});
  assert.deepEqual(config, {
    serverUrl: "ws://localhost:8765",
    sessionCode: "arena",
    sessionCodeExplicit: false,
    pipeName: "xmultiplayer",
    playerName: "pilot",
  });
});

test("falls back to environment variables when no CLI flag is given", () => {
  const config = parseConfig([], {
    XMP_SERVER: "ws://relay.example:9000",
    XMP_SESSION: "arena-7",
    XMP_PIPE_NAME: "custom-pipe",
    XMP_PLAYER_NAME: "Nova",
  });
  assert.equal(config.serverUrl, "ws://relay.example:9000");
  assert.equal(config.sessionCode, "arena-7");
  assert.equal(config.pipeName, "custom-pipe");
  assert.equal(config.playerName, "Nova");
});

test("CLI flags take precedence over environment variables", () => {
  const config = parseConfig(
    ["--server", "ws://cli.example:1234", "--session", "cli-session"],
    { XMP_SERVER: "ws://env.example:9000", XMP_SESSION: "env-session" }
  );
  assert.equal(config.serverUrl, "ws://cli.example:1234");
  assert.equal(config.sessionCode, "cli-session");
});

test("supports all four flags together", () => {
  const config = parseConfig(
    ["--server", "ws://a", "--session", "s1", "--pipe-name", "p1", "--player-name", "Alice"],
    {}
  );
  assert.deepEqual(config, {
    serverUrl: "ws://a",
    sessionCode: "s1",
    sessionCodeExplicit: true,
    pipeName: "p1",
    playerName: "Alice",
  });
});

// --- A5: sessionCodeExplicit, which decides whether the agent auto-joins at
// connect time or waits for the mod's own session-join (presence-based drop-in).

test("sessionCodeExplicit is false when sessionCode is only the hard-coded default", () => {
  assert.equal(parseConfig([], {}).sessionCodeExplicit, false);
});

test("sessionCodeExplicit is true when --session is given on the CLI", () => {
  assert.equal(parseConfig(["--session", "arena-1"], {}).sessionCodeExplicit, true);
});

test("sessionCodeExplicit is true when XMP_SESSION is given via the environment", () => {
  assert.equal(parseConfig([], { XMP_SESSION: "arena-1" }).sessionCodeExplicit, true);
});

test("ignores a flag with no following value", () => {
  const config = parseConfig(["--server"], {});
  assert.equal(config.serverUrl, "ws://localhost:8765");
});

test("pipePath maps a logical pipe name to the SirNukes Windows named pipe convention", () => {
  assert.equal(pipePath("xmultiplayer"), "\\\\.\\pipe\\x4_xmultiplayer");
  assert.equal(pipePath("custom"), "\\\\.\\pipe\\x4_custom");
});
