import { parseMessage } from "@xmultiplayer/protocol";
import { parseConfig, pipePath } from "./config.js";
import { PipeServer } from "./pipeServer.js";
import { ReconnectingWebSocket } from "./wsClient.js";
import { createStats, recordSeq } from "./stats.js";
import { decideRelay } from "./relayFilter.js";
import { buildPipeLine } from "./pipeMessage.js";
import { createRelayStats, resetWindow } from "./relayStats.js";
import { estimateLatencyMs } from "./latency.js";
import { LatencyTracker } from "./latencyTracker.js";

const config = parseConfig(process.argv.slice(2), process.env);
const stats = createStats();
const relayStats = createRelayStats();
/** Smoothed per-sender link latency (see agent/src/latencyTracker.ts); reset whenever a sender's spawn/despawn is seen, so a respawn/reconnect starts fresh. */
const latencyTracker = new LatencyTracker();

/**
 * Locally cached copy of every currently-known remote spawn (objectId -> pipe-ready
 * line, i.e. already canonicalized via buildPipeLine), kept in sync as spawn/despawn
 * messages arrive regardless of whether the pipe write succeeded. Needed because the
 * local pipe client (the game) can connect *after* other session members' spawns
 * already arrived -- e.g. the agent joins the relay session before the game has
 * finished loading -- and would otherwise miss them permanently (a dropped
 * state_update self-heals on the next tick 100ms later, but a dropped spawn never
 * repeats, so the game would never build a proxy for that ship at all). Replayed in
 * full every time the pipe (re)connects, which also covers the game restarting
 * mid-session. A Map, not a plain object, since keys come from another player's
 * message (see docs/A2-messprotokoll.md).
 */
const knownSpawns = new Map<string, string>();

/**
 * Mirrors knownSpawns' keys as a Set (A4): decideRelay's orphan filter needs a
 * cheap membership check ("do we actually have a spawn for this shipId/targetId")
 * on every incoming state_update/hit_report, and rebuilding a Set from
 * knownSpawns.keys() on every single message would be wasteful. Kept in exact
 * lockstep with knownSpawns at both of its mutation points below.
 */
const knownObjectIds = new Set<string>();

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
  onLine: (line) => handleLine(line),
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

function handleLine(line: string): void {
  const result = parseMessage(line);
  if (!result.ok) {
    console.warn(`[agent] dropped invalid message: ${result.error}`);
    return;
  }
  const msg = result.message;
  if (msg.type === "state_update") {
    recordSeq(stats, msg.seq);
    stats.lastPosition = msg.position;
    if (msg.mdRate !== undefined) relayStats.lastMdRate = msg.mdRate;
    relayStats.windowCount += 1;
  }
  ws.send(line);
}

/**
 * Forwards a message received from the relay server (about another session member)
 * down into the game via the pipe. Trust boundary since A2: this data comes from
 * another player, not our own game, so it is validated (parseMessage) AND filtered
 * (decideRelay, e.g. the shipType whitelist on spawn, and since A4 the Arena
 * position/velocity bounds and the orphan-objectId filter, both in
 * agent/src/relayFilter.ts) before ever reaching the pipe. Since A3: what actually
 * gets written/cached is buildPipeLine's canonical, re-serialized form
 * (protocol/src/canonical.ts), never the original raw line -- closes the JSON
 * "decoy field" concern from the A2 security review, since MD's string-based field
 * extractor now only ever sees bytes this agent constructed from validated, typed
 * data. state_update also gets a smoothed link-latency estimate attached
 * (latencyTracker), reset whenever that sender's spawn/despawn is seen so a
 * respawn/reconnect doesn't inherit stale history; the orphan filter above is what
 * keeps that tracker's internal map from growing unboundedly for ids that were
 * never legitimately spawned.
 */
function handleRemoteMessage(line: string): void {
  const result = parseMessage(line);
  if (!result.ok) {
    console.warn(`[agent] dropped invalid message from relay: ${result.error}`);
    relayStats.remoteDropped += 1;
    return;
  }
  const decision = decideRelay(result.message, knownObjectIds);
  if (!decision.forward) {
    console.warn(`[agent] dropped message from relay: ${decision.reason}`);
    relayStats.remoteDropped += 1;
    return;
  }
  const msg = result.message;
  if (msg.type === "spawn") latencyTracker.reset(msg.objectId);
  if (msg.type === "despawn") latencyTracker.reset(msg.objectId);

  const linkLatencyMs = msg.type === "state_update" ? latencyTracker.update(msg.shipId, estimateLatencyMs(msg.ts)) : undefined;
  const pipeLine = buildPipeLine(msg, linkLatencyMs);
  if (msg.type === "spawn") {
    knownSpawns.set(msg.objectId, pipeLine);
    knownObjectIds.add(msg.objectId);
  }
  if (msg.type === "despawn") {
    knownSpawns.delete(msg.objectId);
    knownObjectIds.delete(msg.objectId);
  }

  if (pipe.write(pipeLine)) {
    relayStats.remoteForwarded += 1;
  } else {
    relayStats.remoteDropped += 1;
  }
}

setInterval(() => {
  const elapsedSec = (Date.now() - relayStats.windowStart) / 1000;
  const agentHz = relayStats.windowCount / elapsedSec;
  console.log(
    `[agent stats] received=${stats.received} agentHz=${agentHz.toFixed(2)} ` +
      `mdRate=${relayStats.lastMdRate !== null ? relayStats.lastMdRate.toFixed(2) : "n/a"} gaps=${stats.gaps} ` +
      `lastPos=${stats.lastPosition ? JSON.stringify(stats.lastPosition) : "n/a"} ` +
      `remoteForwarded=${relayStats.remoteForwarded} remoteDropped=${relayStats.remoteDropped}`
  );
  resetWindow(relayStats);
}, 5000);
