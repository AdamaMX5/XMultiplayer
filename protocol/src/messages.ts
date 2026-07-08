/**
 * XMultiplayer wire protocol v1.
 *
 * Every message travels as a single-line JSON object, both over the Named Pipe
 * (game <-> agent, NDJSON framed) and over the WebSocket (agent <-> relay server).
 * See protocol.md for the human-readable description of each message and field.
 *
 * Rotation representation: quaternion (qx, qy, qz, qw), not Euler angles.
 * Reason: the extrapolation math planned for A3 (Dead Reckoning) needs to
 * interpolate/extrapolate orientation without gimbal-lock artifacts, and a
 * quaternion round-trips exactly through JSON without the +/-180 degree wrap
 * problems Euler angles have. The MD side is responsible for reading the
 * ship's orientation and converting it to a quaternion before sending it.
 */

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Fields present on every message, regardless of type. */
export interface EnvelopeBase {
  /** Protocol version. Bump whenever a breaking field change is made. */
  v: 1;
  /** Monotonically increasing sequence number, per sender/shipId stream. Used to detect gaps/reordering. */
  seq: number;
  /** Milliseconds epoch timestamp at time of sending (agent/server clock, not game time). */
  ts: number;
}

export interface StateUpdateMessage extends EnvelopeBase {
  type: "state_update";
  shipId: string;
  position: Vector3;
  rotation: Quaternion;
  velocity: Vector3;
  /**
   * Measured MD tick rate (Hz) as observed by the MD script itself, included so the
   * receiving end can tell real network jitter apart from a slow MD cue (PlanMod.md 0.3).
   * Optional because non-MD senders (e.g. the agent's own heartbeats) may not have one.
   */
  mdRate?: number;
}

/**
 * C3 "NPC-Bubble mit Interest Management": distinguishes a player's own ship
 * (the only kind of `spawn` that existed through C2) from an exported NPC.
 * Optional and defaults to "player" wherever absent (protocol/src/parse.ts),
 * so every A1-C2 sender/message stays valid without change. The distinction
 * matters at the server trust boundary (server/src/server.ts,
 * server/src/sessionManager.ts): a client may have only ONE active
 * "player"-category spawn (A4's original spawn cap, unchanged), but may have
 * up to MAX_NPC_SPAWNS_PER_CLIENT (protocol/src/limits.ts) active
 * "npc"-category spawns at once -- a fundamentally different cap for a
 * fundamentally different kind of spawn, not a relaxation of the original
 * one. `shipType`'s whitelist (SHIP_MACRO_WHITELIST, shipMacros.ts) is
 * ALSO skipped for "npc" -- that whitelist is a small, hand-picked set of
 * Arena PvP starting ships, never meant to cover the real diversity of X4
 * NPC traffic (freighters, miners, capital ships, every race/faction) -- see
 * docs/C3-messprotokoll.md for the resulting trust-boundary changes.
 */
export type SpawnCategory = "player" | "npc";

export interface SpawnMessage extends EnvelopeBase {
  type: "spawn";
  objectId: string;
  shipType: string;
  /** Short-form loadout, e.g. weapon/equipment macro names. Full loadout sync is a later milestone. */
  loadout?: string[];
  owner: string;
  /**
   * Starting hull/shield for the server's HP authority (A4, server/src/hpTracker.ts).
   * Optional so older senders/tests still parse; the server falls back to
   * DEFAULT_HULL/DEFAULT_SHIELD (src/combat.ts) when absent. Letting the SENDER
   * (the mod, which knows the actual shipType) supply these is a step toward
   * per-shiptype HP instead of one fixed value for every ship -- still a client-
   * supplied value, so the server does not treat it as more trustworthy than any
   * other hit_report field, just as the starting point HP is measured from.
   */
  maxHull?: number;
  maxShield?: number;
  /** C3: "player" (default when absent, A1-C2 compatible) or "npc". See this file's own doc comment above SpawnCategory. */
  category?: SpawnCategory;
}

export interface DespawnMessage extends EnvelopeBase {
  type: "despawn";
  objectId: string;
  reason?: string;
}

export type DamageType = "hull" | "shield";

export interface HitReportMessage extends EnvelopeBase {
  type: "hit_report";
  targetId: string;
  sourceId: string;
  damage: number;
  damageType: DamageType;
}

export interface HpStateMessage extends EnvelopeBase {
  type: "hp_state";
  objectId: string;
  hull: number;
  shield: number;
}

export interface FireEventMessage extends EnvelopeBase {
  type: "fire_event";
  sourceId: string;
  weapon: string;
  origin: Vector3;
  direction: Vector3;
}

/**
 * "ready"/"countdown" are vestigial: A5 ("Drop-in-Arena statt Lobby", explicit
 * developer decision) removed the lobby/ready-check/countdown UI entirely, but
 * left these two action values in the type rather than a breaking removal of a
 * wire value that costs nothing to keep. "seta_on"/"seta_off" (A5): a client
 * broadcasts these when it detects the LOCAL player activating/deactivating
 * SETA (time acceleration) or pausing, so the other session member(s) can show
 * a notification and freeze that player's proxy (real ship state elsewhere
 * stops updating meaningfully during SETA/pause, so extrapolating its motion
 * would just drift) -- see mod/md/XMP_Arena.xml's XMP_Arena_OnSetaChanged/
 * XMP_Arena_HandleSetaStatus and docs/A5-messprotokoll.md.
 */
export type SessionAction = "join" | "leave" | "ready" | "countdown" | "seta_on" | "seta_off";

export interface SessionMessage extends EnvelopeBase {
  type: "session";
  action: SessionAction;
  sessionCode: string;
  playerName?: string;
  /** Only meaningful for action === "countdown" (vestigial, see SessionAction). */
  countdownSeconds?: number;
}

export interface ChatMessage extends EnvelopeBase {
  type: "chat";
  from: string;
  text: string;
}

/**
 * C1 "Statischer Sektor-Mirror" (PlanMod.md Phase 2): one message per static
 * sector object (station/gate/asteroid field/region), sent by whichever session
 * member has that object in their own `player.sector` at the moment a `session`
 * `join` is received (see mod/md/XMP_Coop.xml's XMP_Coop_HandleSessionJoin --
 * there is no host/guest distinction anywhere in this protocol or the server, so
 * the mod treats every member symmetrically: each exports its own current
 * sector, and a member whose sector has nothing of interest -- e.g. the empty
 * Arena sector, or an as-yet-unpopulated guest sector -- simply exports zero
 * objects). Modeled as one message per object (like `spawn`) rather than a
 * single message carrying an array, since XMP_Arena_ExtractField (the MD-side
 * field extractor every inbound message is read through) only handles flat,
 * non-nested JSON values -- an array of objects would need a second, unproven
 * extraction mechanism this protocol has no existing pattern for.
 */
export type SectorObjectType = "station" | "gate" | "asteroidfield" | "region";

export interface SectorObjectMessage extends EnvelopeBase {
  type: "sector_object";
  objectId: string;
  objectType: SectorObjectType;
  macroName: string;
  position: Vector3;
  rotation: Quaternion;
}

/**
 * Brackets a burst of `sector_object` messages (C1) so the receiving end knows
 * when a sector export starts and ends, and (via `objectCount` on "begin") how
 * many `sector_object` messages to expect -- useful to detect a transfer that
 * was cut short (e.g. a mid-export disconnect) without needing its own timeout
 * logic. Deliberately its own message type rather than reusing SessionAction:
 * a sector export is about sector CONTENT, not session membership, and the two
 * are allowed to happen independently (e.g. a re-export triggered by a second
 * member joining later).
 */
export type SectorMirrorAction = "begin" | "end";

export interface SectorMirrorMessage extends EnvelopeBase {
  type: "sector_mirror";
  action: SectorMirrorAction;
  /** Only meaningful for action === "begin". */
  objectCount?: number;
}

export type ProtocolMessage =
  | StateUpdateMessage
  | SpawnMessage
  | DespawnMessage
  | HitReportMessage
  | HpStateMessage
  | FireEventMessage
  | SessionMessage
  | ChatMessage
  | SectorObjectMessage
  | SectorMirrorMessage;

export type MessageType = ProtocolMessage["type"];
