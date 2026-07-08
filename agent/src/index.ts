import { parseMessage, type SessionMessage } from "@xmultiplayer/protocol";
import { parseConfig, pipePath } from "./config.js";
import { PipeServer } from "./pipeServer.js";
import { ReconnectingWebSocket } from "./wsClient.js";
import { createStats, recordSeq } from "./stats.js";
import { decideRelay } from "./relayFilter.js";
import { buildPipeLine } from "./pipeMessage.js";
import { createRelayStats, resetWindow } from "./relayStats.js";
import { estimateLatencyMs } from "./latency.js";
import { LatencyTracker } from "./latencyTracker.js";
import { SessionState } from "./sessionState.js";
import { sanitizeForPipe } from "./pipeSanitize.js";

const config = parseConfig(process.argv.slice(2), process.env);
const stats = createStats();
const relayStats = createRelayStats();
/** Smoothed per-sender link latency (see agent/src/latencyTracker.ts); reset whenever a sender's spawn/despawn is seen, so a respawn/reconnect starts fresh. */
const latencyTracker = new LatencyTracker();
/** A5: what to resend after a WS reconnect (last session-join, last own spawn) -- see sessionState.ts. */
const sessionState = new SessionState();
/** True once the WS has connected at least once, so onOpen can tell a genuine reconnect apart from the very first connect. */
let hasConnectedBefore = false;
/**
 * C2 "Coop" self-announce: true once the explicit-session join line has been
 * successfully WRITTEN into the pipe (either from onOpen directly, or from
 * onClientConnected once the game connects later, via deliverCoopSelfJoin --
 * whichever fires first). Deliberately tracks delivery only, not whether MD
 * actually acted on it yet -- mod/md/XMP_Coop.xml's own
 * $XMP.CoopPendingSelfAnnounce/XMP_Coop_SelfAnnounceCheck independently retry
 * (poll once a second) until the player's ship exists, so this flag does not
 * need to know or care about that; it only needs to guarantee the line is
 * handed to MD AT LEAST once. Deliberately a ONE-SHOT, not repeated on every
 * later pipe reconnect: unlike knownSpawns (replayed in full on every pipe
 * reconnect, see that constant's own doc comment), a mid-session game restart
 * re-announcing itself is out of scope for C2, the same class of accepted
 * limitation C1 already documents for the sector mirror
 * (docs/C1-messprotokoll.md) -- revisit together if a later milestone needs
 * real local-reconnect continuity for either.
 */
let coopSelfAnnounceDeliveredToPipe = false;

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

/**
 * A5 "Drop-in-Arena": joining a session is no longer a fixed, connect-time
 * event by default -- the mod is expected to send its own `session` join once
 * it detects the player actually entering the Arena sector (presence-based
 * drop-in), which flows through generically via handleLine below, same as any
 * other outbound message. The one case that STILL auto-joins at connect time is
 * an explicit --session/XMP_SESSION override (config.sessionCodeExplicit):
 * needed for the simulator (agent/src/simulate.ts) and the e2e tests, neither
 * of which has a "mod" to send a join, and for an operator who wants a private/
 * fixed session regardless of presence detection.
 *
 * On a RECONNECT (not the first connect), the relay server has forgotten this
 * connection entirely -- a fresh WebSocket means a fresh clientId server-side,
 * with no session membership and no recorded spawn (server/src/sessionManager.ts
 * has no notion of "this is the same player reconnecting"). sessionState (see
 * sessionState.ts) remembers the last outbound join/spawn specifically so they
 * can be resent here, restoring session membership automatically instead of
 * leaving the agent connected but silently absent from its own session.
 */
const ws = new ReconnectingWebSocket({
  url: config.serverUrl,
  onOpen: () => {
    console.log(`[agent] connected to relay server at ${config.serverUrl}`);
    if (hasConnectedBefore) {
      // The server is about to replay this session's current spawns as part of
      // processing our re-join below; clear the local cache first so a spawn
      // that's now stale (e.g. someone else despawned while we were
      // disconnected, so we never saw their despawn) can't survive alongside
      // the fresh replay -- the replay REPLACES this cache, it doesn't merge
      // with whatever was in it before the disconnect.
      knownSpawns.clear();
      knownObjectIds.clear();
      const resend = sessionState.resendLines();
      if (resend.length > 0) {
        console.log(`[agent] reconnect: restoring session (${resend.length} line(s): join${resend.length > 1 ? " + own spawn" : ""})`);
      }
      for (const line of resend) ws.send(line);
    } else if (config.sessionCodeExplicit) {
      const joinMsg: SessionMessage = {
        v: 1,
        type: "session",
        action: "join",
        seq: 0,
        ts: Date.now(),
        sessionCode: config.sessionCode,
        playerName: config.playerName,
      };
      const line = JSON.stringify(joinMsg);
      ws.send(line);
      sessionState.observeOutbound(joinMsg, line);
      // C2 "Coop" self-announce: an explicit-session join otherwise never
      // reaches MD at all (it goes straight to the relay over the WS, unlike
      // the mod's own Arena-presence-triggered join, which is sent FROM the
      // pipe). Looping it back down lets XMP_Coop_HandleSessionJoin recognize
      // its own join (playerName == player.name) and announce its own ship.
      // A no-op if the game hasn't connected to the pipe yet -- onClientConnected
      // below covers that ordering by retrying once the game DOES connect.
      deliverCoopSelfJoin(line);
    }
    hasConnectedBefore = true;
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
    // C2: covers the reverse connection ordering from the onOpen loopback
    // above (the game connecting to the pipe AFTER the WS join was already
    // sent) -- whichever of the two fires first successfully is the one that
    // actually reaches MD; deliverCoopSelfJoin's own guard stops this from
    // firing again on a LATER pipe reconnect (see coopSelfAnnounceDeliveredToPipe's
    // doc comment -- deliberately one-shot, unlike knownSpawns below).
    if (config.sessionCodeExplicit) {
      const joinLine = sessionState.lastJoinLine();
      if (joinLine) deliverCoopSelfJoin(joinLine);
    }
    replayKnownSpawns();
  },
  onClientDisconnected: () => console.log("[agent] X4 client disconnected (game closed?), waiting for reconnect"),
  onError: (err) => console.error(`[agent] pipe error: ${err.message}`),
  onOversizedLine: (droppedBytes) => console.warn(`[agent] dropped oversized pipe line (${droppedBytes} bytes), connection stays open`),
  onLine: (line) => handleLine(line),
});
pipe.start();

/**
 * C2 "Coop" self-announce: writes `raw` (our own explicit-session join line)
 * into the pipe at most once per WS connection, sanitized the same way any
 * other pipe-bound message is (sanitizeForPipe, normally only applied to
 * relay-origin messages in handleRemoteMessage below -- this is the one
 * pipe-bound line that originates locally instead, from `config.playerName`,
 * e.g. an operator's `--player-name`/XMP_PLAYER_NAME choice, not sanitized
 * anywhere else before this). No-op if already delivered, or if `raw` fails
 * to parse (defensive; it's always our own just-serialized SessionMessage in
 * practice, see both call sites in the `ws`/`pipe` config objects above).
 */
function deliverCoopSelfJoin(raw: string): void {
  if (coopSelfAnnounceDeliveredToPipe) return;
  const parsed = parseMessage(raw);
  if (!parsed.ok) return;
  const sanitizedLine = JSON.stringify(sanitizeForPipe(parsed.message));
  if (pipe.write(sanitizedLine)) coopSelfAnnounceDeliveredToPipe = true;
}

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
  // A5: MD sends its own session join/leave (and spawn/despawn) here once it
  // detects sector presence -- no special-casing needed, it flows through like
  // any other outbound line. sessionState just needs to see every one of them to
  // stay current for a future reconnect (see the ws onOpen handler above).
  sessionState.observeOutbound(msg, line);
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
  // A5 security hardening: playerName/chat text are free-form, player-supplied
  // strings the server only sanitizes for ITS OWN logging/broadcast purposes
  // (control chars + length); MD's naive string-search field extractor has its
  // own, additional gap (a literal '{'/'}'/',' inside a value breaks it, see
  // pipeSanitize.ts), so the agent sanitizes again, more aggressively, right
  // before anything reaches the pipe.
  const pipeLine = buildPipeLine(sanitizeForPipe(msg), linkLatencyMs);
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
