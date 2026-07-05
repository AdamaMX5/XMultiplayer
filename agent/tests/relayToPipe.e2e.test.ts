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

test(
  "the agent forwards only valid relay messages into the pipe, and drops malformed/wrong-version/oversized ones",
  { timeout: 30_000 },
  async () => {
    const { wss, port } = await startFakeRelay();
    const pipeName = `xmp-e2e-${randomUUID()}`;

    let child: ChildProcess | undefined;
    let gameSocket: Socket | undefined;
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

      const [agentSocket, gs] = await Promise.all([
        waitForConnection(wss),
        connectToPipeWithRetry(pipePath(pipeName)),
      ]);
      gameSocket = gs;
      const received = collectLines(gameSocket);

      // 1. Malformed JSON from the relay must never reach the pipe.
      agentSocket.send("{not valid json");
      // 2. Unsupported protocol version must never reach the pipe.
      agentSocket.send(JSON.stringify({ v: 2, type: "chat", seq: 1, ts: Date.now(), from: "x", text: "hi" }));
      // 3. Oversized payload (over protocol/src/limits.ts MAX_MESSAGE_BYTES) must never reach the pipe.
      agentSocket.send(JSON.stringify({ v: 1, type: "chat", seq: 1, ts: Date.now(), from: "x", text: "y".repeat(200_000) }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(received.lines, [], "invalid relay messages must not be written to the pipe");

      // 4. A valid, well-formed spawn message (whitelisted shipType, see
      //    protocol/src/shipMacros.ts) must reach the pipe verbatim.
      const validSpawn = JSON.stringify({
        v: 1,
        type: "spawn",
        seq: 1,
        ts: Date.now(),
        objectId: "remote-ship-1",
        shipType: "ship_arg_s_fighter_01_a_macro",
        owner: "RemotePlayer",
      });
      agentSocket.send(validSpawn);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(received.lines, [validSpawn], "a valid relay message must be forwarded into the pipe unchanged");
    } finally {
      gameSocket?.destroy();
      child?.kill();
      wss.close();
    }
  }
);

test(
  "a spawn with a shipType outside the whitelist is dropped before it reaches the pipe",
  { timeout: 30_000 },
  async () => {
    const { wss, port } = await startFakeRelay();
    const pipeName = `xmp-e2e-${randomUUID()}`;

    let child: ChildProcess | undefined;
    let gameSocket: Socket | undefined;
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

      const [agentSocket, gs] = await Promise.all([
        waitForConnection(wss),
        connectToPipeWithRetry(pipePath(pipeName)),
      ]);
      gameSocket = gs;
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
      assert.deepEqual(received.lines, [], "a spawn with an unwhitelisted shipType must never reach the pipe");
    } finally {
      gameSocket?.destroy();
      child?.kill();
      wss.close();
    }
  }
);

test(
  "a spawn that arrives before the game connects is replayed once the pipe client connects",
  { timeout: 30_000 },
  async () => {
    const { wss, port } = await startFakeRelay();
    const pipeName = `xmp-e2e-${randomUUID()}`;

    let child: ChildProcess | undefined;
    let gameSocket: Socket | undefined;
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

      // The agent connects to the fake relay first, with no game/pipe client yet.
      const agentSocket = await waitForConnection(wss);
      const validSpawn = JSON.stringify({
        v: 1,
        type: "spawn",
        seq: 1,
        ts: Date.now(),
        objectId: "remote-ship-1",
        shipType: "ship_arg_s_fighter_01_a_macro",
        owner: "RemotePlayer",
      });
      agentSocket.send(validSpawn);
      await new Promise((resolve) => setTimeout(resolve, 300)); // the write to the (nonexistent) pipe client is dropped here

      // The "game" connects only now -- the spawn above must not be lost forever.
      gameSocket = await connectToPipeWithRetry(pipePath(pipeName));
      const received = collectLines(gameSocket);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(received.lines, [validSpawn], "a spawn received before the game connected must be replayed once it does");
    } finally {
      gameSocket?.destroy();
      child?.kill();
      wss.close();
    }
  }
);

test(
  "a despawn clears the local replay cache, so a later pipe reconnect does not resurrect a ghost proxy",
  { timeout: 30_000 },
  async () => {
    const { wss, port } = await startFakeRelay();
    const pipeName = `xmp-e2e-${randomUUID()}`;

    let child: ChildProcess | undefined;
    let firstGame: Socket | undefined;
    let secondGame: Socket | undefined;
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

      const [agentSocket, firstConnect] = await Promise.all([
        waitForConnection(wss),
        connectToPipeWithRetry(pipePath(pipeName)),
      ]);
      firstGame = firstConnect;

      const spawnMsg = JSON.stringify({
        v: 1,
        type: "spawn",
        seq: 1,
        ts: Date.now(),
        objectId: "remote-ship-ghost-check",
        shipType: "ship_arg_s_fighter_01_a_macro",
        owner: "RemotePlayer",
      });
      agentSocket.send(spawnMsg);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const despawnMsg = JSON.stringify({ v: 1, type: "despawn", seq: 2, ts: Date.now(), objectId: "remote-ship-ghost-check" });
      agentSocket.send(despawnMsg);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Simulate the game/pipe client reconnecting (e.g. the player relogs).
      firstGame.destroy();
      await new Promise((resolve) => setTimeout(resolve, 200));
      secondGame = await connectToPipeWithRetry(pipePath(pipeName));
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
      child?.kill();
      wss.close();
    }
  }
);
