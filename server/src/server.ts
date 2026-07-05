import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_MESSAGE_BYTES, parseMessage, type SessionMessage } from "@xmultiplayer/protocol";
import { SessionManager, type SessionMember } from "./sessionManager.js";

export interface RelayServerOptions {
  port: number;
}

/**
 * Relay server: groups WebSocket clients into sessions by session code and
 * broadcasts every message to the other members of the same session. Besides
 * session join/leave, the server also tracks `spawn` messages (A2) so it can
 * replay currently-spawned proxies to a newly joined member and despawn a
 * member's proxies when they disconnect; every other message type (including
 * `state_update`) is forwarded verbatim (the server does not validate ship/HP
 * logic in A1/A2 -- that lands with the HP-authority work in A4).
 */
export function startRelayServer(options: RelayServerOptions): WebSocketServer {
  // Same cap as parseMessage/NdjsonSplitter (protocol/src/limits.ts) so oversized
  // frames are rejected uniformly across the pipe and the WebSocket transport.
  const wss = new WebSocketServer({ port: options.port, maxPayload: MAX_MESSAGE_BYTES });
  const sessions = new SessionManager();
  const sockets = new Map<string, WebSocket>();
  let messagesSinceLastLog = 0;

  wss.on("connection", (socket) => {
    const clientId = randomUUID();
    sockets.set(clientId, socket);
    socket.on("message", (data) => {
      messagesSinceLastLog += 1;
      handleMessage(data.toString(), clientId, sessions, sockets);
    });
    socket.on("close", () => handleDisconnect(clientId, sessions, sockets));
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

function handleMessage(
  raw: string,
  clientId: string,
  sessions: SessionManager,
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
  if (msg.type === "spawn") {
    sessions.recordSpawn(sessionCode, clientId, msg.objectId, raw);
  }
  broadcast(sessionCode, clientId, raw, sessions, sockets);
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

function handleDisconnect(clientId: string, sessions: SessionManager, sockets: Map<string, WebSocket>): void {
  sockets.delete(clientId);
  const left = sessions.leave(clientId);
  if (!left) return;
  console.log(`[server] ${left.member.playerName} (${clientId}) left session ${left.sessionCode}`);
  broadcastLeave(left.sessionCode, clientId, left.member, sessions, sockets);
  broadcastDespawns(left.sessionCode, clientId, sessions, sockets);
}

/** Despawns whatever proxies the disconnecting member had spawned, so they don't linger as ghosts for others. */
function broadcastDespawns(
  sessionCode: string,
  clientId: string,
  sessions: SessionManager,
  sockets: Map<string, WebSocket>
): void {
  for (const objectId of sessions.takeSpawnedObjectIds(clientId, sessionCode)) {
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
