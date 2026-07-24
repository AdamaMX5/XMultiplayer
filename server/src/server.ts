import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_HULL,
  DEFAULT_SHIELD,
  isKnownShipMacro,
  isPlausibleVelocity,
  isWithinArenaBounds,
  MAX_MESSAGE_BYTES,
  MAX_NPC_SPAWNS_PER_CLIENT,
  MAX_SECTOR_OBJECTS_PER_MIRROR,
  parseMessage,
  sanitizeChatText,
  sanitizePlayerName,
  type HitReportMessage,
  type SessionMessage,
  type SpawnCategory,
} from "@xmultiplayer/protocol";
import { SessionManager, type SessionMember } from "./sessionManager.js";
import { clampDamage, HpTracker, isDestroyed, isValidDamageClaim, isValidStartingHp } from "./hpTracker.js";
import { isShipClassAllowed, type ShipClassPreset } from "./shipClassPolicy.js";
import { TokenBucket } from "./rateLimiter.js";

/** A5 "Internet-Modus": in public mode, a session code must be at least this long (on top of not being the LAN default "arena") to be accepted. Not real entropy measurement, just a minimum-length bar cheap enough to enforce without a dependency. */
export const MIN_PUBLIC_SESSION_CODE_LENGTH = 12;

export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface RelayServerOptions {
  port: number;
  /** A5 "Regel-Presets": restricts which ship classes may spawn in this session, on top of the base macro whitelist. Defaults to "all" (no additional restriction). */
  shipClassPreset?: ShipClassPreset;
  /** A5 security hardening: per-client token bucket for ALL message types. Generous defaults so normal play (10Hz telemetry plus occasional combat/chat) is never affected. */
  generalRateLimit?: RateLimitConfig;
  /** A5 security hardening: a SEPARATE, tighter per-client token bucket specifically for hit_report (combat-critical, worth its own guard beyond the general limit). */
  hitReportRateLimit?: RateLimitConfig;
  /** A5 security hardening: max simultaneous WebSocket connections, total and per remote IP. */
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  /** A5 security hardening: max simultaneous sessions. Joining an session that already exists never counts against this. */
  maxSessions?: number;
  /** A5 "Internet-Modus": when true, session join enforces MIN_PUBLIC_SESSION_CODE_LENGTH and rejects the LAN default "arena". Defaults to false (LAN behavior unchanged). */
  publicMode?: boolean;
}

const DEFAULT_GENERAL_RATE_LIMIT: RateLimitConfig = { capacity: 60, refillPerSecond: 30 };
const DEFAULT_HIT_REPORT_RATE_LIMIT: RateLimitConfig = { capacity: 20, refillPerSecond: 20 };
const DEFAULT_MAX_CONNECTIONS = 500;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 50;
const DEFAULT_MAX_SESSIONS = 1000;

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
  const shipClassPreset = options.shipClassPreset ?? "all";
  const publicMode = options.publicMode ?? false;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const generalRateLimit = options.generalRateLimit ?? DEFAULT_GENERAL_RATE_LIMIT;
  const hitReportRateLimit = options.hitReportRateLimit ?? DEFAULT_HIT_REPORT_RATE_LIMIT;
  const generalLimiter = new TokenBucket(generalRateLimit.capacity, generalRateLimit.refillPerSecond);
  const hitReportLimiter = new TokenBucket(hitReportRateLimit.capacity, hitReportRateLimit.refillPerSecond);
  // A5: connection-count limiting (total and per remote IP). ipByClient is needed
  // purely so the "close" handler can decrement the right IP's counter -- the
  // socket/request object isn't available there, only clientId.
  let totalConnections = 0;
  const connectionsByIp = new Map<string, number>();
  const ipByClient = new Map<string, string>();
  // C1 security review finding: sector_mirror.objectCount is purely self-reported
  // by the sender (protocol/src/parse.ts only range-checks it, 0..
  // MAX_SECTOR_OBJECTS_PER_MIRROR), so a client could claim `begin objectCount:1`
  // and then send an unbounded number of real sector_object messages -- the
  // claimed count on its own enforces nothing. This tracks how many
  // sector_object messages each client has ACTUALLY sent since its last
  // sector_mirror "begin" (see handleMessage's sector_object handling below),
  // independent of what it claimed, so MAX_SECTOR_OBJECTS_PER_MIRROR is a real
  // cap rather than a cosmetic one.
  const sectorMirrorCounts = new Map<string, number>();
  let messagesSinceLastLog = 0;

  wss.on("connection", (socket, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    if (totalConnections >= maxConnections) {
      console.warn(`[server] rejected connection from ${ip}: max total connections (${maxConnections}) reached`);
      socket.close(1013, "server full");
      return;
    }
    const connectionsFromThisIp = connectionsByIp.get(ip) ?? 0;
    if (connectionsFromThisIp >= maxConnectionsPerIp) {
      console.warn(`[server] rejected connection from ${ip}: max connections per IP (${maxConnectionsPerIp}) reached`);
      socket.close(1013, "too many connections from this address");
      return;
    }
    totalConnections += 1;
    connectionsByIp.set(ip, connectionsFromThisIp + 1);

    const clientId = randomUUID();
    sockets.set(clientId, socket);
    ipByClient.set(clientId, ip);
    socket.on("message", (data) => {
      messagesSinceLastLog += 1;
      handleMessage(
        data.toString(),
        clientId,
        sessions,
        hp,
        sockets,
        shipClassPreset,
        publicMode,
        maxSessions,
        generalLimiter,
        hitReportLimiter,
        sectorMirrorCounts
      );
    });
    socket.on("close", () => {
      const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) connectionsByIp.delete(ip);
      else connectionsByIp.set(ip, remaining);
      ipByClient.delete(clientId);
      totalConnections -= 1;
      generalLimiter.reset(clientId);
      hitReportLimiter.reset(clientId);
      sectorMirrorCounts.delete(clientId);
      handleDisconnect(clientId, sessions, hp, sockets);
    });
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
  sockets: Map<string, WebSocket>,
  shipClassPreset: ShipClassPreset,
  publicMode: boolean,
  maxSessions: number,
  generalLimiter: TokenBucket,
  hitReportLimiter: TokenBucket,
  sectorMirrorCounts: Map<string, number>
): void {
  // A5: applies to EVERY message, valid or not, before any parsing -- a client
  // flooding with garbage should be capped just as much as one flooding with
  // well-formed messages. Checked first, ahead of parseMessage.
  if (!generalLimiter.tryConsume(clientId)) {
    console.warn(`[server] rate limit exceeded for ${clientId} (general), message dropped`);
    return;
  }
  const result = parseMessage(raw);
  if (!result.ok) {
    console.warn(`[server] dropped invalid message from ${clientId}: ${result.error}`);
    return;
  }
  const msg = result.message;
  if (msg.type === "session" && msg.action === "join") {
    // A5 "Internet-Modus": in public mode, the LAN default "arena" and any code
    // shorter than MIN_PUBLIC_SESSION_CODE_LENGTH are rejected, forcing an
    // operator exposed to the internet to actually configure a real private
    // code rather than leaving the well-known LAN default reachable by anyone.
    if (publicMode && !isSessionCodeAllowedInPublicMode(msg.sessionCode)) {
      console.warn(`[server] rejected join from ${clientId}: sessionCode does not meet public-mode requirements`);
      return;
    }
    // A5: bounds the number of distinct sessions this server will track at
    // once. Joining a session that already has members never counts as
    // "creating a new one", so this can never lock existing players out.
    if (!sessions.hasSession(msg.sessionCode) && sessions.sessionCount() >= maxSessions) {
      console.warn(`[server] rejected join from ${clientId}: max sessions (${maxSessions}) reached`);
      return;
    }
    joinSession(msg, clientId, sessions, hp, sockets);
    return;
  }
  // A5 review fix: a client-sent "leave" (e.g. the mod detecting the player
  // exiting the Arena sector, presence-based drop-in) was previously only ever
  // broadcast to others -- decorative, since sessions.leave() was never actually
  // called for this path (only a real WebSocket disconnect called it, via
  // handleDisconnect below). The client would keep being treated as still "in"
  // that session server-side (sessionCodeOf/ownerOf etc.) despite everyone else
  // having been told they left. leaveSession() is the same cleanup
  // handleDisconnect does, just without also removing the (still open) socket.
  if (msg.type === "session" && msg.action === "leave") {
    leaveSession(clientId, sessions, hp, sockets);
    return;
  }
  if (msg.type === "chat") {
    // A5: sanitize BEFORE broadcasting, not just before logging -- the other
    // session member(s) (and eventually the mod, once chat display lands) get
    // the sanitized text too, not just this server's own console.
    const sanitizedMsg: typeof msg = { ...msg, from: sanitizePlayerName(msg.from), text: sanitizeChatText(msg.text) };
    const sessionCode = sessions.sessionCodeOf(clientId);
    if (!sessionCode) {
      console.warn(`[server] chat from ${clientId} outside a session, ignored`);
      return;
    }
    broadcast(sessionCode, clientId, JSON.stringify(sanitizedMsg), sessions, sockets);
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
    // A5: a SEPARATE, tighter rate limit than the general one -- combat-critical
    // and worth its own guard against a client that stays within the general
    // limit but still floods hit_reports specifically.
    if (!hitReportLimiter.tryConsume(clientId)) {
      console.warn(`[server] hit_report rate limit exceeded for ${clientId}, message dropped`);
      return;
    }
    if (!requireOwnership(sessions, clientId, msg.sourceId, "hit_report", "sourceId")) return;
    handleHitReport(msg, sessionCode, clientId, sessions, hp, sockets);
    return;
  }

  if (msg.type === "spawn") {
    // C3: "npc" spawns are a fundamentally different kind of thing from a
    // player's own ship (SpawnMessage.category's own doc comment,
    // protocol/src/messages.ts) and get their own, separate validation below
    // instead of the two checks in this block that only make sense for a
    // player's Arena starting ship: SHIP_MACRO_WHITELIST is a small,
    // hand-picked set of Arena PvP ships, never meant to cover real NPC
    // traffic. shipClassPreset (S/M-only Arena rule presets, meant to keep a
    // PLAYER-piloted PvP match fair) is a DELIBERATE skip too, not an
    // oversight (security review question, C3): an "npc" spawn can never be
    // piloted by a player or fire on its own initiative (no local input, no
    // fire_event unless someone else's client sends one under its own
    // sourceId ownership), and is invulnerable exactly like every other
    // proxy (XMP_Arena_HandleSpawn's set_object_invulnerable, unchanged) --
    // it has no path to actually PLAY as an oversized ship the class preset
    // would otherwise have blocked, only to exist as an inert, visible prop
    // shaped like one. See docs/C3-messprotokoll.md for the fuller
    // reasoning and the follow-up items this still leaves open (a global
    // per-session NPC cap, and clientId-scoped budgets being multipliable
    // across several connections from the same operator -- both pre-existing
    // classes of gap, not introduced by C3, just made more visible by it).
    const category = msg.category ?? "player";
    if (category === "player") {
      // A5: the server had never validated shipType at all before this -- the macro
      // whitelist only ever ran agent-side (decideRelay, for INCOMING spawns from
      // the relay), which a client connecting directly to the WebSocket instead of
      // through the agent would simply bypass. Checked here too now, plus the new
      // ship-class rule preset on top of it.
      if (!isKnownShipMacro(msg.shipType)) {
        console.warn(`[server] dropped spawn from ${clientId}: unknown shipType "${msg.shipType}"`);
        return;
      }
      if (!isShipClassAllowed(msg.shipType, shipClassPreset)) {
        console.warn(`[server] dropped spawn from ${clientId}: shipType "${msg.shipType}" not allowed under ship class preset "${shipClassPreset}"`);
        return;
      }
      // A4 spawn cap: one active PLAYER spawn per member. Does not apply to
      // "npc" spawns at all (checked in the else branch below instead) -- a
      // client legitimately owns its own ship spawn AND up to
      // MAX_NPC_SPAWNS_PER_CLIENT NPC spawns simultaneously, two independent
      // budgets, not one shared one.
      if (sessions.hasOtherActiveSpawn(clientId, msg.objectId)) {
        console.warn(`[server] dropped spawn from ${clientId}: spawn cap exceeded (already has a different active spawn)`);
        return;
      }
    } else if (category === "npc") {
      // C3 NPC budget (PlanMod.md "Budget definieren: max. Proxy-Anzahl").
      // The ownerOf() exception below does NOT let a still-active NPC
      // re-spawn past the cap (the respawn-gate a few lines down rejects
      // that unconditionally, for both categories, with a more specific
      // "still active" message) -- its only actual effect is which of the
      // two rejection reasons a client sees when BOTH would apply (at cap
      // AND re-spawning something already owned): this branch steps aside
      // so the respawn-gate's more accurate message wins instead of this
      // one's generic "cap reached".
      if (sessions.npcSpawnCount(clientId) >= MAX_NPC_SPAWNS_PER_CLIENT && sessions.ownerOf(msg.objectId) !== clientId) {
        console.warn(`[server] dropped npc spawn from ${clientId}: MAX_NPC_SPAWNS_PER_CLIENT (${MAX_NPC_SPAWNS_PER_CLIENT}) reached`);
        return;
      }
    } else {
      // Defense in depth, not currently reachable: parseMessage only ever
      // accepts "player"/"npc"/absent for category (protocol/src/parse.ts).
      // Fails CLOSED rather than silently taking the less-restricted "npc"
      // path if that enum is ever widened without updating this switch --
      // security review finding, C3: an earlier draft used a blanket `else`
      // here, which would have (harmlessly today, but fragile) treated any
      // FUTURE category value as "npc" by default.
      console.warn(`[server] dropped spawn from ${clientId}: unrecognized category "${String(msg.category)}"`);
      return;
    }
    const existingOwner = sessions.ownerOf(msg.objectId);
    if (existingOwner !== undefined && existingOwner !== clientId) {
      console.warn(`[server] dropped spawn from ${clientId}: objectId "${msg.objectId}" is already owned by another client`);
      return;
    }
    // A5 "Respawn-Gate": before this check, a client owning an objectId could
    // re-send `spawn` for it at ANY time, including while it was still alive --
    // hp.register() unconditionally resets hull/shield to max, so this was a
    // free, instant, unlimited self-heal (send `spawn` again whenever damaged).
    // `existingOwner === clientId` can only be true while the CURRENT spawn
    // record still exists, i.e. it hasn't been destroyed/despawned yet (both
    // destroyObject() and a real despawn call removeSpawn(), which clears
    // ownerByObjectId) -- so this rejects exactly the "still alive" case, while
    // a genuine respawn AFTER proper destruction (existingOwner undefined by
    // then) remains unaffected. Interacts correctly with the A5 Block 1 session-
    // switch fix: switching sessions already frees the objectId (removeSpawn +
    // hp.remove for the OLD session), so respawning under a NEW session's HP
    // tracker is a fresh registration, not a heal of the old one.
    if (existingOwner === clientId) {
      console.warn(`[server] dropped spawn from ${clientId}: objectId "${msg.objectId}" is still active, must be destroyed/despawned before respawning`);
      return;
    }
    sessions.recordSpawn(sessionCode, clientId, msg.objectId, raw, category, msg.shipType);
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
    if (!requireOwnership(sessions, clientId, msg.shipId, "state_update", "shipId")) return;
    // A5: previously only the agent checked this (decideRelay, for INCOMING
    // state_updates about OTHER players), which a client connecting directly to
    // the WebSocket instead of through the agent would simply bypass, same gap
    // as the shipType whitelist above.
    if (!isWithinArenaBounds(msg.position) || !isPlausibleVelocity(msg.velocity)) {
      console.warn(`[server] dropped state_update from ${clientId}: position/velocity outside plausible Arena bounds`);
      return;
    }
    broadcast(sessionCode, clientId, raw, sessions, sockets);
    return;
  }

  if (msg.type === "despawn") {
    // Not part of normal operation (despawns are server-generated, see
    // broadcastDespawns/destroyObject) -- defense in depth in case a client ever
    // sends one anyway.
    if (!requireOwnership(sessions, clientId, msg.objectId, "despawn", "objectId")) return;
    sessions.removeSpawn(sessionCode, msg.objectId);
    hp.remove(sessionCode, msg.objectId);
    broadcast(sessionCode, clientId, raw, sessions, sockets);
    return;
  }

  if (msg.type === "fire_event") {
    if (!requireOwnership(sessions, clientId, msg.sourceId, "fire_event", "sourceId")) return;
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

  // C1 "Statischer Sektor-Mirror": sector_object/sector_mirror need no
  // requireOwnership() check, unlike spawn/state_update/despawn/fire_event
  // above -- static sector scenery has no per-object OWNER the way a player's
  // ship does. They DO still need the sectorMirrorCounts bookkeeping below
  // (security review finding: sector_mirror.objectCount is purely
  // self-reported, protocol/src/parse.ts only range-checks it against
  // MAX_SECTOR_OBJECTS_PER_MIRROR -- without an independent server-side tally
  // a client could claim `begin objectCount:1` and then send an unbounded
  // number of real sector_object messages, since nothing would ever compare
  // the claim against reality).
  if (msg.type === "sector_mirror" && msg.action === "begin") {
    sectorMirrorCounts.set(clientId, 0);
    broadcast(sessionCode, clientId, raw, sessions, sockets);
    return;
  }
  if (msg.type === "sector_object") {
    const count = (sectorMirrorCounts.get(clientId) ?? 0) + 1;
    if (count > MAX_SECTOR_OBJECTS_PER_MIRROR) {
      console.warn(`[server] dropped sector_object from ${clientId}: exceeds MAX_SECTOR_OBJECTS_PER_MIRROR (${MAX_SECTOR_OBJECTS_PER_MIRROR}) for the current mirror, regardless of its claimed objectCount`);
      return;
    }
    sectorMirrorCounts.set(clientId, count);
    // C6 "Kommando-Relay": remembers WHO exported this station/gate/asteroid
    // field/region, so a later dock_request naming it as targetId can be
    // routed to this exact member instead of broadcast to the whole session.
    sessions.recordSectorObject(clientId, msg.objectId);
    broadcast(sessionCode, clientId, raw, sessions, sockets);
    return;
  }

  // C6: dock_request is routed point-to-point to whichever member exported
  // the target station (sectorObjectOwnerOf), never broadcast -- a docking
  // interaction concerns exactly two members, not the whole session. Only
  // requesterId's ownership is checked (A4 ownership authority, same as
  // hit_report.sourceId): the requester must own the ship they claim is
  // asking to dock, but targetId is deliberately NOT ownership-checked here
  // for the same reason hit_report.targetId isn't -- the whole point is
  // naming an object owned by someone ELSE.
  if (msg.type === "dock_request") {
    if (!requireOwnership(sessions, clientId, msg.requesterId, "dock_request", "requesterId")) return;
    const targetOwner = sessions.sectorObjectOwnerOf(msg.targetId);
    if (!targetOwner) {
      console.warn(`[server] dropped dock_request from ${clientId}: targetId "${msg.targetId}" has no known exporter`);
      return;
    }
    sendToMember(sessionCode, targetOwner, raw, sessions, sockets);
    return;
  }

  // C6: dock_response must come from whoever actually owns/exported targetId
  // (rejects a member confirming/denying a dock on a station it doesn't
  // own) and is routed point-to-point to whoever owns the requester's ship --
  // reusing ownerOf() (A2+) rather than a new "pending request" table, since
  // the requester's own ship spawn already IS the routing key. KNOWN, ACCEPTED
  // SIMPLIFICATION (protocol/protocol.md's own doc comment on this message
  // pair): the server does not track which dock_request a dock_response
  // actually answers, so an unsolicited dock_response naming a real
  // requesterId would still be routed and delivered -- harmless for now, no
  // real consequence (credits, ship-registry) is attached to `approved` yet.
  if (msg.type === "dock_response") {
    if (sessions.sectorObjectOwnerOf(msg.targetId) !== clientId) {
      console.warn(`[server] dropped dock_response from ${clientId}: targetId "${msg.targetId}" is not owned by this client`);
      return;
    }
    const requesterOwner = sessions.ownerOf(msg.requesterId);
    if (!requesterOwner) {
      console.warn(`[server] dropped dock_response from ${clientId}: requesterId "${msg.requesterId}" has no known owner`);
      return;
    }
    // A5-style sanitizing: `reason` is free-form, attacker-influenced text
    // that ends up relayed to another client and eventually through MD's
    // string-based field extractor -- same trust posture as chat.text.
    const sanitizedRaw = msg.reason !== undefined ? JSON.stringify({ ...msg, reason: sanitizeChatText(msg.reason) }) : raw;
    sendToMember(sessionCode, requesterOwner, sanitizedRaw, sessions, sockets);
    return;
  }

  // Structural validation for every other still-unhandled type (currently
  // just sector_mirror's "end" action) already happened once, uniformly, in
  // parseMessage (protocol/src/parse.ts) -- the same boundary every other
  // message type's fields are checked at. Plain pass-through broadcast is all
  // that is left to do.
  broadcast(sessionCode, clientId, raw, sessions, sockets);
}

/**
 * Consolidates the four identical "does clientId actually own this objectId"
 * checks handleMessage needed (hit_report.sourceId, state_update.shipId,
 * despawn.objectId, fire_event.sourceId) -- A5 review requirement, pure
 * refactoring, no behavior change. `ownerOf` returning undefined (no spawn at
 * all, or a fresh session-switch ghost) is rejected the same as a spoofed
 * objectId belonging to someone else; see handleMessage's own doc comment for
 * why that's deliberate. `messageType`/`field` are only used for the log line.
 */
function requireOwnership(sessions: SessionManager, clientId: string, objectId: string, messageType: string, field: string): boolean {
  if (sessions.ownerOf(objectId) !== clientId) {
    console.warn(`[server] dropped ${messageType} from ${clientId}: ${field} "${objectId}" is not owned by this client (or has no known spawn)`);
    return false;
  }
  return true;
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
  attackerClientId: string,
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
    destroyObject(msg.targetId, sessionCode, attackerClientId, sessions, hp, sockets);
  }
}

/**
 * Destruction cleanup plus, since A5, the "kill-feed": the server is the one
 * place that actually knows a kill happened (it's the HP authority), so it
 * builds the announcement itself rather than trusting either client to report
 * their own kill. Sent as an ordinary `chat` message (`from: "server"`) so no
 * new message type/mod-side extraction is needed -- MD just needs to recognize
 * `chat` and show it as an on-screen notification (assumption, see
 * docs/A5-messprotokoll.md).
 */
function destroyObject(
  objectId: string,
  sessionCode: string,
  attackerClientId: string,
  sessions: SessionManager,
  hp: HpTracker,
  sockets: Map<string, WebSocket>
): void {
  // Captured BEFORE removeSpawn() below wipes ownerByObjectId/categoryByObjectId/
  // shipTypeByObjectId's entries for objectId. C4: category/shipType are needed
  // by broadcastKillFeed to name an NPC victim correctly (see that function's
  // own doc comment) -- same "read before removeSpawn" ordering requirement
  // ownerOf() already had for victimClientId.
  const victimClientId = sessions.ownerOf(objectId);
  const victimCategory = sessions.categoryOf(objectId);
  const victimShipType = sessions.shipTypeOf(objectId);
  hp.remove(sessionCode, objectId);
  sessions.removeSpawn(sessionCode, objectId);
  console.log(`[server] ${objectId} destroyed (hull reached 0) in session ${sessionCode}`);
  const despawnMsg = JSON.stringify({ v: 1, type: "despawn", seq: 0, ts: Date.now(), objectId, reason: "destroyed" });
  broadcastToSession(sessionCode, despawnMsg, sessions, sockets);
  broadcastKillFeed(sessionCode, attackerClientId, victimClientId, victimCategory, victimShipType, sessions, sockets);
}

/**
 * C4 fix (docs/C3-messprotokoll.md section 5.6's documented "emergent, not
 * intended" flaw): before this milestone, an NPC's destruction was attributed
 * to the EXPORTING player's own name (spawn.owner is that player's clientId
 * for "npc"-category spawns the same as for their own ship, so victimClientId
 * resolved to the exporter, not the NPC). Now an "npc"-category victim is
 * named by its shipType instead of looking up a player at all -- there is no
 * player to attribute an NPC's destruction to. `victimShipType` is expected to
 * always be present for a real spawn (SpawnMessage.shipType is a required wire
 * field), the fallback is defensive only.
 */
function broadcastKillFeed(
  sessionCode: string,
  attackerClientId: string,
  victimClientId: string | undefined,
  victimCategory: SpawnCategory | undefined,
  victimShipType: string | undefined,
  sessions: SessionManager,
  sockets: Map<string, WebSocket>
): void {
  const attackerName = sessions.memberOf(sessionCode, attackerClientId)?.playerName ?? "unknown";
  const victimName =
    victimCategory === "npc"
      ? victimShipType ?? "an NPC ship"
      : (victimClientId && sessions.memberOf(sessionCode, victimClientId)?.playerName) || "unknown";
  const killFeedMsg = JSON.stringify({
    v: 1,
    type: "chat",
    seq: 0,
    ts: Date.now(),
    from: "server",
    text: `${attackerName} destroyed ${victimName}`,
  });
  broadcastToSession(sessionCode, killFeedMsg, sessions, sockets);
}

/** Sends raw to every member of a session, nobody excluded (unlike broadcast(), which excludes the sender). */
function broadcastToSession(sessionCode: string, raw: string, sessions: SessionManager, sockets: Map<string, WebSocket>): void {
  for (const member of sessions.membersOf(sessionCode)) {
    const target = sockets.get(member.id);
    if (target && target.readyState === WebSocket.OPEN) target.send(raw);
  }
}

/**
 * A5 review fix: joining a session while already in a DIFFERENT one (a real,
 * everyday occurrence once presence-based drop-in triggers session switches on
 * sector change, not just once at connect time) must clean up the OLD session's
 * spawns/HP exactly like a disconnect would -- otherwise the old session's other
 * members keep a ghost proxy forever, and a later joiner of the OLD session would
 * get it replayed even though its "owner" is long gone. SessionManager.join()
 * returns the old session (if any) precisely so this cleanup can run here, since
 * SessionManager itself has no access to `hp`/`sockets` to broadcast with.
 */
function joinSession(
  msg: SessionMessage,
  clientId: string,
  sessions: SessionManager,
  hp: HpTracker,
  sockets: Map<string, WebSocket>
): void {
  // A5: sanitized ONCE here, so both what's stored (SessionMember.playerName,
  // reused by the kill-feed etc.) and what's broadcast to other members are the
  // safe version, not just this server's own log lines.
  const playerName = msg.playerName !== undefined ? sanitizePlayerName(msg.playerName) : undefined;
  const member: SessionMember = { id: clientId, playerName: playerName ?? "unknown" };
  const previous = sessions.join(msg.sessionCode, member);
  if (previous && previous.sessionCode !== msg.sessionCode) {
    console.log(`[server] ${member.playerName} (${clientId}) switched from session ${previous.sessionCode} to ${msg.sessionCode}`);
    broadcastLeave(previous.sessionCode, clientId, previous.member, sessions, sockets);
    broadcastDespawns(previous.sessionCode, clientId, sessions, hp, sockets);
    // C6: same hygiene rationale as leaveSession's own cleanup call -- not
    // strictly required for safety (sendToMember's own membership check
    // already refuses to route to a clientId no longer in the OLD session),
    // but avoids leaving a stale entry pointing at a member who has moved on.
    sessions.forgetSectorObjectsOf(clientId);
  }
  console.log(`[server] ${member.playerName} (${clientId}) joined session ${msg.sessionCode}`);
  const sanitizedMsg: SessionMessage = { ...msg, playerName: member.playerName };
  broadcast(msg.sessionCode, clientId, JSON.stringify(sanitizedMsg), sessions, sockets);
  replaySpawns(msg.sessionCode, clientId, sessions, sockets);
}

/** A5 "Internet-Modus" entropy floor: not real entropy measurement, just cheap-to-enforce minimums (reject the well-known LAN default and anything implausibly short). */
function isSessionCodeAllowedInPublicMode(sessionCode: string): boolean {
  return sessionCode !== "arena" && sessionCode.length >= MIN_PUBLIC_SESSION_CODE_LENGTH;
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

/**
 * C6 "Kommando-Relay": sends raw to exactly ONE specific member, unlike
 * broadcast()/broadcastToSession()'s "everyone but the sender"/"everyone"
 * shape -- dock_request/dock_response are inherently two-party exchanges.
 * Confirms targetMemberId is actually a CURRENT member of sessionCode before
 * looking up a socket (defense in depth: sectorObjectOwnerOf/ownerOf are
 * global maps, not session-scoped, the same pre-existing characteristic
 * ownerOf's callers already rely on -- see docs/C6-messprotokoll.md -- so
 * without this check a wire-id collision across two unrelated sessions could
 * otherwise misroute a message cross-session). No-ops silently if the target
 * turns out not to be a member, or its socket is gone/not open (e.g. it
 * disconnected between the routing decision and this call) -- same
 * "just drop, don't error" posture broadcast()/broadcastToSession() have for
 * a missing/closed socket.
 */
function sendToMember(sessionCode: string, targetMemberId: string, raw: string, sessions: SessionManager, sockets: Map<string, WebSocket>): void {
  if (!sessions.membersOf(sessionCode).some((m) => m.id === targetMemberId)) return;
  const target = sockets.get(targetMemberId);
  if (target && target.readyState === WebSocket.OPEN) target.send(raw);
}

function handleDisconnect(clientId: string, sessions: SessionManager, hp: HpTracker, sockets: Map<string, WebSocket>): void {
  sockets.delete(clientId);
  leaveSession(clientId, sessions, hp, sockets);
}

/** Removes clientId from whatever session it's in (if any) and cleans up its spawns/HP -- shared by a real WS disconnect and an explicit client-sent "leave" (A5). */
function leaveSession(clientId: string, sessions: SessionManager, hp: HpTracker, sockets: Map<string, WebSocket>): void {
  const left = sessions.leave(clientId);
  if (!left) return;
  console.log(`[server] ${left.member.playerName} (${clientId}) left session ${left.sessionCode}`);
  broadcastLeave(left.sessionCode, clientId, left.member, sessions, sockets);
  broadcastDespawns(left.sessionCode, clientId, sessions, hp, sockets);
  // C6: forgets every sector_object this member ever exported, so a stale
  // sectorObjectOwnerOf entry can't route a later dock_request to a clientId
  // that no longer has a socket at all (sendToMember would already no-op
  // safely either way, but this avoids the entry lingering across the
  // session's lifetime for no reason, same hygiene rationale as
  // takeSpawnedObjectIds' own disconnect cleanup for spawns).
  sessions.forgetSectorObjectsOf(clientId);
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
