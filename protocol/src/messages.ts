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

export type SessionAction = "join" | "leave" | "ready" | "countdown";

export interface SessionMessage extends EnvelopeBase {
  type: "session";
  action: SessionAction;
  sessionCode: string;
  playerName?: string;
  /** Only meaningful for action === "countdown". */
  countdownSeconds?: number;
}

export interface ChatMessage extends EnvelopeBase {
  type: "chat";
  from: string;
  text: string;
}

export type ProtocolMessage =
  | StateUpdateMessage
  | SpawnMessage
  | DespawnMessage
  | HitReportMessage
  | HpStateMessage
  | FireEventMessage
  | SessionMessage
  | ChatMessage;

export type MessageType = ProtocolMessage["type"];
