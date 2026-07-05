import { parseMessage } from "@xmultiplayer/protocol";
import { parseConfig, pipePath } from "./config.js";
import { PipeServer } from "./pipeServer.js";
import { ReconnectingWebSocket } from "./wsClient.js";
import { createStats, recordSeq, type StreamStats } from "./stats.js";
import { decideRelay } from "./relayFilter.js";

const config = parseConfig(process.argv.slice(2), process.env);
const stats = createStats();
let lastMdRate: number | null = null;
let windowCount = 0;
let windowStart = Date.now();
let remoteForwarded = 0;
let remoteDropped = 0;

/**
 * Locally cached copy of every currently-known remote spawn (objectId -> raw spawn
 * line), kept in sync as spawn/despawn messages arrive regardless of whether the
 * pipe write succeeded. Needed because the local pipe client (the game) can connect
 * *after* other session members' spawns already arrived -- e.g. the agent joins the
 * relay session before the game has finished loading -- and would otherwise miss
 * them permanently (a dropped state_update self-heals on the next tick 100ms later,
 * but a dropped spawn never repeats, so the game would never build a proxy for that
 * ship at all). Replayed in full every time the pipe (re)connects, which also
 * covers the game restarting mid-session. A Map, not a plain object, since keys
 * come from another player's message (see docs/A2-messprotokoll.md).
 */
const knownSpawns = new Map<string, string>();

const ws = new ReconnectingWebSocket({
  url: config.serverUrl,
  onOpen: () => {
    console.log(`[agent] connected to relay server at ${config.serverUrl}`);
    ws.send(
      JSON.stringify({
        v: 1,
        type: "session",
        action: "join",
        seq: 0,
        ts: Date.now(),
        sessionCode: config.sessionCode,
        playerName: config.playerName,
      })
    );
  },
  onClose: () => console.log("[agent] relay connection lost, retrying..."),
  // A2: other session members' spawn/despawn/state_update messages get relayed
  // down into the game via the pipe, so the mod can spawn/teleport their proxies.
  onMessage: (line) => handleRemoteMessage(line),
});
ws.connect();

const pipe = new PipeServer(pipePath(config.pipeName), {
  onListening: () => console.log(`[agent] waiting for X4 on pipe ${pipePath(config.pipeName)}`),
  onClientConnected: () => {
    console.log("[agent] X4 client connected to pipe");
    replayKnownSpawns();
  },
  onClientDisconnected: () => console.log("[agent] X4 client disconnected (game closed?), waiting for reconnect"),
  onError: (err) => console.error(`[agent] pipe error: ${err.message}`),
  onOversizedLine: (droppedBytes) => console.warn(`[agent] dropped oversized pipe line (${droppedBytes} bytes), connection stays open`),
  onLine: (line) => handleLine(line, stats, ws, (rate) => (lastMdRate = rate), () => (windowCount += 1)),
});
pipe.start();

/** Sends every currently-known remote spawn down the pipe; see `knownSpawns` above. */
function replayKnownSpawns(): void {
  if (knownSpawns.size === 0) return;
  console.log(`[agent] replaying ${knownSpawns.size} known spawn(s) to the newly connected X4 client`);
  for (const line of knownSpawns.values()) {
    pipe.write(line);
  }
}

function handleLine(
  line: string,
  streamStats: StreamStats,
  socket: ReconnectingWebSocket,
  setMdRate: (rate: number) => void,
  countWindow: () => void
): void {
  const result = parseMessage(line);
  if (!result.ok) {
    console.warn(`[agent] dropped invalid message: ${result.error}`);
    return;
  }
  const msg = result.message;
  if (msg.type === "state_update") {
    recordSeq(streamStats, msg.seq);
    streamStats.lastPosition = msg.position;
    if (msg.mdRate !== undefined) setMdRate(msg.mdRate);
    countWindow();
  }
  socket.send(line);
}

/**
 * Forwards a message received from the relay server (about another session member)
 * down into the game via the pipe. Trust boundary since A2: this data comes from
 * another player, not our own game, so it is validated (parseMessage) AND filtered
 * (decideRelay, e.g. the shipType whitelist on spawn) before ever reaching the pipe.
 */
function handleRemoteMessage(line: string): void {
  const result = parseMessage(line);
  if (!result.ok) {
    console.warn(`[agent] dropped invalid message from relay: ${result.error}`);
    remoteDropped += 1;
    return;
  }
  const decision = decideRelay(result.message);
  if (!decision.forward) {
    console.warn(`[agent] dropped message from relay: ${decision.reason}`);
    remoteDropped += 1;
    return;
  }
  const msg = result.message;
  if (msg.type === "spawn") knownSpawns.set(msg.objectId, line);
  if (msg.type === "despawn") knownSpawns.delete(msg.objectId);

  if (pipe.write(line)) {
    remoteForwarded += 1;
  } else {
    remoteDropped += 1;
  }
}

setInterval(() => {
  const elapsedSec = (Date.now() - windowStart) / 1000;
  const agentHz = windowCount / elapsedSec;
  console.log(
    `[agent stats] received=${stats.received} agentHz=${agentHz.toFixed(2)} ` +
      `mdRate=${lastMdRate !== null ? lastMdRate.toFixed(2) : "n/a"} gaps=${stats.gaps} ` +
      `lastPos=${stats.lastPosition ? JSON.stringify(stats.lastPosition) : "n/a"} ` +
      `remoteForwarded=${remoteForwarded} remoteDropped=${remoteDropped}`
  );
  windowCount = 0;
  windowStart = Date.now();
}, 5000);
