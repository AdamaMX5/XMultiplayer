import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, pipePath } from "../src/config.js";

test("uses hard-coded defaults when no CLI args or env vars are given", () => {
  const config = parseConfig([], {});
  assert.deepEqual(config, {
    serverUrl: "ws://localhost:8765",
    sessionCode: "default",
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
    pipeName: "p1",
    playerName: "Alice",
  });
});

test("ignores a flag with no following value", () => {
  const config = parseConfig(["--server"], {});
  assert.equal(config.serverUrl, "ws://localhost:8765");
});

test("pipePath maps a logical pipe name to the SirNukes Windows named pipe convention", () => {
  assert.equal(pipePath("xmultiplayer"), "\\\\.\\pipe\\x4_xmultiplayer");
  assert.equal(pipePath("custom"), "\\\\.\\pipe\\x4_custom");
});
