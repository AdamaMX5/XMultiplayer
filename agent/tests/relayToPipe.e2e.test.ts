import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { pipePath } from "../src/config.js";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Black-box test of the one piece of A2's backchannel (relay -> pipe) that has no
 * unit-testable seam: `handleRemoteMessage` in src/index.ts is a private function
 * in the entrypoint script, not exported. Rather than refactor production code
 * purely for testability, this spawns the real agent process end-to-end (as the
 * game and the relay server would each see it) and observes the one behavior that
 * matters: does an invalid/oversized message from the relay ever reach the pipe?
 */
async function startFakeRelay(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  return { wss, port: (wss.address() as AddressInfo).port };
}

function waitForConnection(wss: WebSocketServer, timeoutMs = 10_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("agent never connected to fake relay")), timeoutMs);
    wss.once("connection", (socket) => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

async function connectToPipeWithRetry(path: string, deadlineMs = 10_000): Promise<Socket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(path);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (err) {
      if (Date.now() - start > deadlineMs) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function collectLines(socket: Socket): { lines: string[] } {
  const state = { lines: [] as string[] };
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    state.lines.push(...parts.filter((l) => l.length > 0));
  });
  return state;
}

/**
 * All these tests set XMP_SESSION (config.sessionCodeExplicit), purely so the
 * agent auto-joins at connect time without a real mod driving it -- an A5
 * pattern predating C2. Since C2, that same explicit join is ALSO looped back
 * into the pipe once (see index.ts's coopSelfAnnounceDeliveredToPipe), so the
 * FIRST pipe connect in every one of these tests receives a `session` `join`
 * line before whatever the test itself is actually about. Filtering it out
 * here keeps these tests' assertions about the SPAWN/DESPAWN relay behavior
 * unaffected by that unrelated, already-covered-elsewhere C2 behavior
 * (agent/tests/sessionState.test.ts's lastJoinLine() tests own that instead).
 */
function nonSessionLines(lines: string[]): string[] {
  return lines.filter((line) => JSON.parse(line).type !== "session");
}

interface AgentTestContext {
  /** The fake relay server's side of the agent's WebSocket connection -- send() on this simulates a message from the relay. */
  agentSocket: WebSocket;
  /** Pipe path for this run's agent; connect to it to act as "the game". */
  pipePath: string;
}

/**
 * Starts a fake relay server and the real agent process end-to-end against it (a
 * fresh, unique pipe name per call so parallel/leftover runs never collide), waits
 * for the agent to connect to both, hands the test a small context to drive the
 * scenario, and guarantees the child process and relay server are torn down
 * afterwards regardless of outcome. Callers connect their own "game" pipe socket(s)
 * from `ctx.pipePath` whenever their scenario needs to (before, after, or never),
 * since that timing is exactly what each of these tests is exercising.
 */
async function withAgentProcess(run: (ctx: AgentTestContext) => Promise<void>): Promise<void> {
  const { wss, port } = await startFakeRelay();
  const pipeName = `xmp-e2e-${randomUUID()}`;
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: agentDir,
      env: {
        ...process.env,
        XMP_SERVER: `ws://localhost:${port}`,
        XMP_PIPE_NAME: pipeName,
        XMP_SESSION: "e2e-session",
        XMP_PLAYER_NAME: "e2e-tester",
      },
      stdio: "pipe",
    });
    child.on("error", (err) => {
      throw err;
    });

    const agentSocket = await waitForConnection(wss);
    await run({ agentSocket, pipePath: pipePath(pipeName) });
  } finally {
    child?.kill();
    wss.close();
  }
}

test(
  "the agent forwards only valid relay messages into the pipe, and drops malformed/wrong-version/oversized ones",
  { timeout: 30_000 },
  () =>
    withAgentProcess(async ({ agentSocket, pipePath: path }) => {
      let gameSocket: Socket | undefined;
      try {
        gameSocket = await connectToPipeWithRetry(path);
        const received = collectLines(gameSocket);

        // 1. Malformed JSON from the relay must never reach the pipe.
        agentSocket.send("{not valid json");
        // 2. Unsupported protocol version must never reach the pipe.
        agentSocket.send(JSON.stringify({ v: 2, type: "chat", seq: 1, ts: Date.now(), from: "x", text: "hi" }));
        // 3. Oversized payload (over protocol/src/limits.ts MAX_MESSAGE_BYTES) must never reach the pipe.
        agentSocket.send(JSON.stringify({ v: 1, type: "chat", seq: 1, ts: Date.now(), from: "x", text: "y".repeat(200_000) }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(nonSessionLines(received.lines), [], "invalid relay messages must not be written to the pipe");

        // 4. A valid, well-formed spawn message (whitelisted shipType, see
        //    protocol/src/shipMacros.ts) must reach the pipe, canonically
        //    re-serialized (see protocol/src/canonical.ts) -- same fields, same
        //    values, not necessarily the identical original bytes.
        const sentAt = Date.now();
        agentSocket.send(
          JSON.stringify({
            v: 1,
            type: "spawn",
            seq: 1,
            ts: sentAt,
            objectId: "remote-ship-1",
            shipType: "ship_arg_s_fighter_01_a_macro",
            owner: "RemotePlayer",
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        const spawnLines = nonSessionLines(received.lines);
        assert.equal(spawnLines.length, 1, "a valid relay message must be forwarded into the pipe");
        assert.deepEqual(JSON.parse(spawnLines[0]), {
          v: 1,
          type: "spawn",
          seq: 1,
          ts: sentAt,
          objectId: "remote-ship-1",
          shipType: "ship_arg_s_fighter_01_a_macro",
          owner: "RemotePlayer",
        });
      } finally {
        gameSocket?.destroy();
      }
    })
);

test(
  "a spawn with a shipType outside the whitelist is dropped before it reaches the pipe",
  { timeout: 30_000 },
  () =>
    withAgentProcess(async ({ agentSocket, pipePath: path }) => {
      let gameSocket: Socket | undefined;
      try {
        gameSocket = await connectToPipeWithRetry(path);
        const received = collectLines(gameSocket);

        agentSocket.send(
          JSON.stringify({
            v: 1,
            type: "spawn",
            seq: 1,
            ts: Date.now(),
            objectId: "remote-ship-1",
            shipType: "not_a_real_macro",
            owner: "RemotePlayer",
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(nonSessionLines(received.lines), [], "a spawn with an unwhitelisted shipType must never reach the pipe");
      } finally {
        gameSocket?.destroy();
      }
    })
);

test(
  "a spawn that arrives before the game connects is replayed once the pipe client connects",
  { timeout: 30_000 },
  () =>
    withAgentProcess(async ({ agentSocket, pipePath: path }) => {
      let gameSocket: Socket | undefined;
      try {
        const spawnPayload = {
          v: 1,
          type: "spawn",
          seq: 1,
          ts: Date.now(),
          objectId: "remote-ship-1",
          shipType: "ship_arg_s_fighter_01_a_macro",
          owner: "RemotePlayer",
        };
        // No game/pipe client connected yet at this point.
        agentSocket.send(JSON.stringify(spawnPayload));
        await new Promise((resolve) => setTimeout(resolve, 300)); // the write to the (nonexistent) pipe client is dropped here

        // The "game" connects only now -- the spawn above must not be lost forever.
        gameSocket = await connectToPipeWithRetry(path);
        const received = collectLines(gameSocket);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const spawnLines = nonSessionLines(received.lines);
        assert.equal(spawnLines.length, 1, "a spawn received before the game connected must be replayed once it does");
        assert.deepEqual(JSON.parse(spawnLines[0]), spawnPayload);
      } finally {
        gameSocket?.destroy();
      }
    })
);

test(
  "a despawn clears the local replay cache, so a later pipe reconnect does not resurrect a ghost proxy",
  { timeout: 30_000 },
  () =>
    withAgentProcess(async ({ agentSocket, pipePath: path }) => {
      let firstGame: Socket | undefined;
      let secondGame: Socket | undefined;
      try {
        firstGame = await connectToPipeWithRetry(path);

        agentSocket.send(
          JSON.stringify({
            v: 1,
            type: "spawn",
            seq: 1,
            ts: Date.now(),
            objectId: "remote-ship-ghost-check",
            shipType: "ship_arg_s_fighter_01_a_macro",
            owner: "RemotePlayer",
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 300));

        agentSocket.send(JSON.stringify({ v: 1, type: "despawn", seq: 2, ts: Date.now(), objectId: "remote-ship-ghost-check" }));
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Simulate the game/pipe client reconnecting (e.g. the player relogs).
        firstGame.destroy();
        await new Promise((resolve) => setTimeout(resolve, 200));
        secondGame = await connectToPipeWithRetry(path);
        const received = collectLines(secondGame);
        await new Promise((resolve) => setTimeout(resolve, 400));

        assert.deepEqual(
          received.lines,
          [],
          "a despawned object must not be replayed as a spawn again on a later pipe reconnect (ghost proxy)"
        );
      } finally {
        firstGame?.destroy();
        secondGame?.destroy();
      }
    })
);

/** Lines whose `type` is `session` -- the mirror image of nonSessionLines(). */
function sessionLines(lines: string[]): unknown[] {
  return lines.map((line) => JSON.parse(line)).filter((parsed) => (parsed as { type: string }).type === "session");
}

test(
  "C2: an explicit-session join is looped back into the pipe exactly once (game connects to the pipe AFTER the WS join), so MD can recognize and react to its own join",
  { timeout: 30_000 },
  () =>
    withAgentProcess(async ({ pipePath: path }) => {
      // No agentSocket interaction here at all -- withAgentProcess's XMP_SESSION
      // env var alone is what makes the agent send its own explicit join, the
      // exact scenario XMP_Coop_HandleSessionJoin's "self" branch depends on.
      // withAgentProcess always waits for the WS connection (and therefore the
      // join) before this callback runs, so connecting the pipe client here
      // deterministically exercises the onClientConnected fallback path in
      // index.ts's deliverCoopSelfJoin, NOT the onOpen direct-write path --
      // see the next test for that other ordering.
      let firstGame: Socket | undefined;
      let secondGame: Socket | undefined;
      try {
        firstGame = await connectToPipeWithRetry(path);
        const firstReceived = collectLines(firstGame);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const joinLines = sessionLines(firstReceived.lines);
        assert.equal(joinLines.length, 1, "exactly one session join must be looped back into the pipe");
        const parsed = joinLines[0] as { action: string; sessionCode: string; playerName: string };
        assert.equal(parsed.action, "join");
        assert.equal(parsed.sessionCode, "e2e-session");
        assert.equal(parsed.playerName, "e2e-tester");

        // A later pipe reconnect (e.g. the game restarting) must NOT repeat the
        // loopback -- deliberately one-shot, see index.ts's
        // coopSelfAnnounceDeliveredToPipe.
        firstGame.destroy();
        await new Promise((resolve) => setTimeout(resolve, 200));
        secondGame = await connectToPipeWithRetry(path);
        const secondReceived = collectLines(secondGame);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(sessionLines(secondReceived.lines), [], "the self-join loopback must not repeat on a later pipe reconnect");
      } finally {
        firstGame?.destroy();
        secondGame?.destroy();
      }
    })
);

test(
  "C2: an explicit-session join is looped back into the pipe when the game connects to the pipe BEFORE the WS join is sent",
  { timeout: 30_000 },
  async () => {
    // Deliberately does NOT use withAgentProcess: that helper always awaits the
    // WS connection (and therefore the join) before handing control to the
    // test, which can only ever exercise index.ts's onClientConnected fallback
    // (see the previous test). This test needs the OPPOSITE ordering --
    // connecting the pipe client before the agent's WS/join even exists yet --
    // to exercise onOpen's own direct pipe.write(line) call instead. The pipe
    // path is deterministic ahead of spawning (it's built from a pipeName this
    // test picks itself), so connectToPipeWithRetry can start racing the
    // agent's own startup immediately, without waiting on the WS at all.
    const { wss, port } = await startFakeRelay();
    const pipeName = `xmp-e2e-${randomUUID()}`;
    const path = pipePath(pipeName);
    let child: ChildProcess | undefined;
    let gameSocket: Socket | undefined;
    try {
      child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: agentDir,
        env: {
          ...process.env,
          XMP_SERVER: `ws://localhost:${port}`,
          XMP_PIPE_NAME: pipeName,
          XMP_SESSION: "e2e-session-early-pipe",
          XMP_PLAYER_NAME: "e2e-tester-early-pipe",
        },
        stdio: "pipe",
      });
      child.on("error", (err) => {
        throw err;
      });

      // Started BEFORE the pipe-connect attempt below (not awaited yet): wss's
      // "connection" event is a one-shot emitter (once()), so attaching this
      // listener only AFTER awaiting the pipe connect would risk missing an
      // event that already fired while this test was busy retrying the pipe
      // connection -- an earlier version of this test had exactly that bug
      // (agent connects to the WS while the pipe retry loop is still running,
      // the once() listener attached afterwards misses it, "agent never
      // connected to fake relay" times out even though it plainly did).
      const agentSocketPromise = waitForConnection(wss);

      // Connect to the pipe as early as possible -- before even awaiting the WS
      // connection -- so it is very likely already connected by the time
      // onOpen's explicit-session branch runs and attempts its direct write.
      gameSocket = await connectToPipeWithRetry(path);
      const received = collectLines(gameSocket);

      await agentSocketPromise; // confirms the agent's WS side did connect (and therefore did send its join)
      await new Promise((resolve) => setTimeout(resolve, 300));

      const joinLines = sessionLines(received.lines);
      assert.equal(joinLines.length, 1, "exactly one session join must be looped back into the pipe");
      const parsed = joinLines[0] as { action: string; sessionCode: string; playerName: string };
      assert.equal(parsed.action, "join");
      assert.equal(parsed.sessionCode, "e2e-session-early-pipe");
      assert.equal(parsed.playerName, "e2e-tester-early-pipe");
    } finally {
      gameSocket?.destroy();
      child?.kill();
      wss.close();
    }
  }
);
