import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_HULL, DEFAULT_SHIELD, MAX_MESSAGE_BYTES, parseMessage, type HitReportMessage, type SessionMessage } from "@xmultiplayer/protocol";
import { SessionManager, type SessionMember } from "./sessionManager.js";
import { clampDamage, HpTracker, isDestroyed, isValidDamageClaim, isValidStartingHp } from "./hpTracker.js";

export interface RelayServerOptions {
  port: number;
}

/**
 * Relay server: groups WebSocket clients into sessions by session code and
 * broadcasts every message to the other members of the same session. Besides
 * session join/leave, the server also tracks `spawn` messages (A2) so it can
 * replay currently-spawned proxies to a newly joined member and despawn a
 * member's proxies when they disconnect. Since A4, it is also the HP authority
 * (see hpTracker.ts): `hit_report` is never broadcast raw, only processed into an
 * `hp_state` that goes to the whole session (including the attacker); every other
 * message type is still forwarded verbatim.
 */
export function startRelayServer(options: RelayServerOptions): WebSocketServer {
  // Same cap as parseMessage/NdjsonSplitter (protocol/src/limits.ts) so oversized
  // frames are rejected uniformly across the pipe and the WebSocket transport.
  const wss = new WebSocketServer({ port: options.port, maxPayload: MAX_MESSAGE_BYTES });
  const sessions = new SessionManager();
  const hp = new HpTracker();
  const sockets = new Map<string, WebSocket>();
  let messagesSinceLastLog = 0;

  wss.on("connection", (socket) => {
    const clientId = randomUUID();
    sockets.set(clientId, socket);
    socket.on("message", (data) => {
      messagesSinceLastLog += 1;
      handleMessage(data.toString(), clientId, sessions, hp, sockets);
    });
    socket.on("close", () => handleDisconnect(clientId, sessions, hp, sockets));
    // Required, not optional: ws's maxPayload rejects an oversized frame by emitting
    // an "error" on this socket (e.g. WS_ERR_UNSUPPORTED_MESSAGE_LENGTH) rather than a
    // clean close. An EventEmitter with no "error" listener re-throws as an uncaught
    // exception, which would crash the whole server process for every connected
    // client -- so this handler is what makes maxPayload safe to enable at all.
    socket.on("error", (err) => console.warn(`[server] socket error from ${clientId}: ${err.message}`));
  });

  wss.on("listening", () => console.log(`[server] relay listening on port ${options.port}`));

  const statsInterval = setInterval(() => {
    console.log(`[server stats] sessions=${sessions.sessionCount()} clients=${sockets.size} messages/5s=${messagesSinceLastLog}`);
    messagesSinceLastLog = 0;
  }, 5000);
  // Don't let the periodic stats log keep the process (or a test run) alive by itself,
  // and stop it once the server is closed (e.g. at the end of each test).
  statsInterval.unref();
  wss.on("close", () => clearInterval(statsInterval));

  return wss;
}

/**
 * A2 established the server as a trust boundary for `spawn` (shipType whitelist,
 * elsewhere) and A3's review flagged that ownership was tracked (spawnsByMember)
 * but never actually ENFORCED. A4 closes that: a client may only spawn/update/
 * despawn/fire an objectId it actually owns (per SessionManager.ownerOf), with
 * `hit_report` as the one deliberate exception -- its whole point is reporting a
 * hit on someone ELSE's objectId, so only `sourceId` (the attacker's own ship) is
 * checked, never `targetId`. An unrecognized/orphan objectId (no owner at all) is
 * rejected the same as a spoofed one belonging to someone else -- `ownerOf`
 * returning undefined must never be treated as "unclaimed, so anyone may use it".
 */
function handleMessage(
  raw: string,
  clientId: string,
  sessions: SessionManager,
  hp: HpTracker,
  sockets: Map<string, WebSocket>
): void {
  const result = parseMessage(raw);
  if (!result.ok) {
    console.warn(`[server] dropped invalid message from ${clientId}: ${result.error}`);
    return;
  }
  const msg = result.message;
  if (msg.type === "session" && msg.action === "join") {
    joinSession(msg, clientId, sessions, sockets);
    return;
  }
  const sessionCode = sessions.sessionCodeOf(clientId);
  if (!sessionCode) {
    console.warn(`[server] message from ${clientId} outside a session, ignored`);
    return;
  }

  // hit_report is never forwarded raw -- only the hp_state it resolves into is
  // sent on, and to the WHOLE session (including the attacker), not just "others".
  if (msg.type === "hit_report") {
    if (sessions.ownerOf(msg.sourceId) !== clientId) {
      console.warn(`[server] dropped hit_report from ${clientId}: sourceId "${msg.sourceId}" is not owned by this client`);
      return;
    }
    handleHitReport(msg, sessionCode, sessions, hp, sockets);
    return;
  }

  if (msg.type === "spawn") {
    if (sessions.hasOtherActiveSpawn(clientId, msg.objectId)) {
      console.warn(`[server] dropped spawn from ${clientId}: spawn cap exceeded (already has a different active spawn)`);
      return;
    }
    const existingOwner = sessions.ownerOf(msg.objectId);
    if (existingOwner !== undefined && existingOwner !== clientId) {
      console.warn(`[server] dropped spawn from ${clientId}: objectId "${msg.objectId}" is already owned by another client`);
      return;
    }
    sessions.recordSpawn(sessionCode, clientId, msg.objectId, raw);
    // maxHull/maxShield (A4): sender-supplied starting HP, falling back to the
    // fixed defaults when absent OR out of range -- untrusted client input, same
    // trust-boundary rationale as hit_report.damage (isValidDamageClaim/
    // clampDamage below). Range-checked (not merely defaulted-when-absent), or a
    // spawn claiming e.g. maxHull: 1e308 would make that ship practically
    // unkillable; a negative value would register an already-dead ship.
    const maxHull = msg.maxHull !== undefined && isValidStartingHp(msg.maxHull) ? msg.maxHull : DEFAULT_HULL;
    const maxShield = msg.maxShield !== undefined && isValidStartingHp(msg.maxShield) ? msg.maxShield : DEFAULT_SHIELD;
    hp.register(sessionCode, msg.objectId, maxHull, maxShield);
    broadcast(sessionCode, clientId, raw, sessions, sockets);
    return;
  }

  if (msg.type === "state_update") {
    if (sessions.ownerOf(msg.shipId) !== clientId) {
      console.warn(`[server] dropped state_update from ${clientId}: shipId "${msg.shipId}" is not owned by this client (or has no known spawn)`);
      return;
    }
    broadcast(sessionCode, clientId, raw, sessions, sockets);
    return;
  }

  if (msg.type === "despawn") {
    // Not part of normal operation (despawns are server-generated, see
    // broadcastDespawns/destroyObject) -- defense in depth in case a client ever
    // sends one anyway.
    if (sessions.ownerOf(msg.objectId) !== clientId) {
      console.warn(`[server] dropped despawn from ${clientId}: objectId "${msg.objectId}" is not owned by this client`);
      return;
    }
    sessions.removeSpawn(sessionCode, msg.objectId);
    hp.remove(sessionCode, msg.objectId);
    broadcast(sessionCode, clientId, raw, sessions, sockets);
    return;
  }

  if (msg.type === "fire_event") {
    if (sessions.ownerOf(msg.sourceId) !== clientId) {
      console.warn(`[server] dropped fire_event from ${clientId}: sourceId "${msg.sourceId}" is not owned by this client`);
      return;
    }
    broadcast(sessionCode, clientId, raw, sessions, sockets);
    return;
  }

  // hp_state is server-generated only (handleHitReport/destroyObject below) -- a
  // client sending one directly would let it fabricate an arbitrary HP outcome
  // (e.g. claiming another player's ship is already destroyed) without ever
  // landing a hit_report at all. Dropped unconditionally, never broadcast.
  if (msg.type === "hp_state") {
    console.warn(`[server] dropped hp_state from ${clientId}: clients may never send this message type directly`);
    return;
  }

  broadcast(sessionCode, clientId, raw, sessions, sockets);
}

/**
 * Resolves a hit_report into an authoritative hp_state (A4 "Server ist
 * HP-Autorität"): validates the claimed damage is a plausible positive number,
 * then clamps it (untrusted client input, A2 trust boundary rationale) before
 * applying it, then broadcasts the result to every member of the session. A hull
 * that reaches 0 triggers destruction: the object's HP and spawn record are
 * forgotten and a despawn (reason "destroyed") goes out, mirroring how a
 * disconnect's despawn works (server.ts's broadcastDespawns). Caller
 * (handleMessage) has already checked sourceId ownership before this runs.
 */
function handleHitReport(
  msg: HitReportMessage,
  sessionCode: string,
  sessions: SessionManager,
  hp: HpTracker,
  sockets: Map<string, WebSocket>
): void {
  if (!isValidDamageClaim(msg.damage)) {
    console.warn(`[server] dropped hit_report with invalid damage ${msg.damage} for ${msg.targetId} (must be finite and > 0)`);
    return;
  }
  const damage = clampDamage(msg.damage);
  if (damage !== msg.damage) {
    console.warn(`[server] clamped implausible hit_report damage ${msg.damage} -> ${damage} for ${msg.targetId}`);
  }
  const state = hp.applyDamage(sessionCode, msg.targetId, damage, msg.damageType);
  if (!state) {
    console.warn(`[server] hit_report for untracked objectId ${msg.targetId} in session ${sessionCode}, ignored`);
    return;
  }
  const hpStateMsg = JSON.stringify({ v: 1, type: "hp_state", seq: 0, ts: Date.now(), objectId: msg.targetId, hull: state.hull, shield: state.shield });
  broadcastToSession(sessionCode, hpStateMsg, sessions, sockets);
  if (isDestroyed(state)) {
    destroyObject(msg.targetId, sessionCode, sessions, hp, sockets);
  }
}

function destroyObject(
  objectId: string,
  sessionCode: string,
  sessions: SessionManager,
  hp: HpTracker,
  sockets: Map<string, WebSocket>
): void {
  hp.remove(sessionCode, objectId);
  sessions.removeSpawn(sessionCode, objectId);
  console.log(`[server] ${objectId} destroyed (hull reached 0) in session ${sessionCode}`);
  const despawnMsg = JSON.stringify({ v: 1, type: "despawn", seq: 0, ts: Date.now(), objectId, reason: "destroyed" });
  broadcastToSession(sessionCode, despawnMsg, sessions, sockets);
}

/** Sends raw to every member of a session, nobody excluded (unlike broadcast(), which excludes the sender). */
function broadcastToSession(sessionCode: string, raw: string, sessions: SessionManager, sockets: Map<string, WebSocket>): void {
  for (const member of sessions.membersOf(sessionCode)) {
    const target = sockets.get(member.id);
    if (target && target.readyState === WebSocket.OPEN) target.send(raw);
  }
}

function joinSession(
  msg: SessionMessage,
  clientId: string,
  sessions: SessionManager,
  sockets: Map<string, WebSocket>
): void {
  const member: SessionMember = { id: clientId, playerName: msg.playerName ?? "unknown" };
  sessions.join(msg.sessionCode, member);
  console.log(`[server] ${member.playerName} (${clientId}) joined session ${msg.sessionCode}`);
  broadcast(msg.sessionCode, clientId, JSON.stringify(msg), sessions, sockets);
  replaySpawns(msg.sessionCode, clientId, sessions, sockets);
}

/** Sends previously spawned proxies (from other members) to a newly joined member, so it doesn't start blind. */
function replaySpawns(
  sessionCode: string,
  clientId: string,
  sessions: SessionManager,
  sockets: Map<string, WebSocket>
): void {
  const socket = sockets.get(clientId);
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  for (const raw of sessions.spawnsOf(sessionCode)) {
    socket.send(raw);
  }
}

function broadcast(
  sessionCode: string,
  senderId: string,
  raw: string,
  sessions: SessionManager,
  sockets: Map<string, WebSocket>
): void {
  for (const member of sessions.others(sessionCode, senderId)) {
    const target = sockets.get(member.id);
    if (target && target.readyState === WebSocket.OPEN) target.send(raw);
  }
}

function handleDisconnect(clientId: string, sessions: SessionManager, hp: HpTracker, sockets: Map<string, WebSocket>): void {
  sockets.delete(clientId);
  const left = sessions.leave(clientId);
  if (!left) return;
  console.log(`[server] ${left.member.playerName} (${clientId}) left session ${left.sessionCode}`);
  broadcastLeave(left.sessionCode, clientId, left.member, sessions, sockets);
  broadcastDespawns(left.sessionCode, clientId, sessions, hp, sockets);
}

/** Despawns whatever proxies the disconnecting member had spawned, so they don't linger as ghosts for others; also forgets their HP (A4). */
function broadcastDespawns(
  sessionCode: string,
  clientId: string,
  sessions: SessionManager,
  hp: HpTracker,
  sockets: Map<string, WebSocket>
): void {
  for (const objectId of sessions.takeSpawnedObjectIds(clientId, sessionCode)) {
    hp.remove(sessionCode, objectId);
    const despawnMsg = JSON.stringify({ v: 1, type: "despawn", seq: 0, ts: Date.now(), objectId, reason: "disconnect" });
    broadcast(sessionCode, clientId, despawnMsg, sessions, sockets);
  }
}

function broadcastLeave(
  sessionCode: string,
  clientId: string,
  member: SessionMember,
  sessions: SessionManager,
  sockets: Map<string, WebSocket>
): void {
  const leaveMsg = JSON.stringify({
    v: 1,
    type: "session",
    action: "leave",
    seq: 0,
    ts: Date.now(),
    sessionCode,
    playerName: member.playerName,
  });
  broadcast(sessionCode, clientId, leaveMsg, sessions, sockets);
}
