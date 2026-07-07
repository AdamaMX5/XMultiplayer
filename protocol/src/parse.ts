import type {
  ChatMessage,
  DespawnMessage,
  FireEventMessage,
  HitReportMessage,
  HpStateMessage,
  ProtocolMessage,
  SessionMessage,
  SpawnMessage,
  StateUpdateMessage,
} from "./messages.js";
import {
  type Fields,
  isNumber,
  isOptionalNumber,
  isOptionalString,
  isQuaternion,
  isString,
  isStringArray,
  isVector3,
} from "./validators.js";
import { MAX_MESSAGE_BYTES } from "./limits.js";

export type ParseResult =
  | { ok: true; message: ProtocolMessage }
  | { ok: false; error: string };

const ok = (message: ProtocolMessage): ParseResult => ({ ok: true, message });
const fail = (error: string): ParseResult => ({ ok: false, error });

/**
 * Parses and validates a single NDJSON line / WebSocket text frame into a typed
 * ProtocolMessage. Used identically by the agent (reading from the pipe) and the
 * relay server (reading from WebSocket clients), so both sides reject the same
 * malformed input the same way.
 */
export function parseMessage(json: string): ParseResult {
  const size = Buffer.byteLength(json, "utf8");
  if (size > MAX_MESSAGE_BYTES) {
    return fail(`message exceeds max size of ${MAX_MESSAGE_BYTES} bytes (got ${size})`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return fail(`invalid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    return fail("message must be a JSON object");
  }

  const obj = raw as Fields;
  const envelopeError = validateEnvelope(obj);
  if (envelopeError) return fail(envelopeError);

  switch (obj.type) {
    case "state_update":
      return validateStateUpdate(obj);
    case "spawn":
      return validateSpawn(obj);
    case "despawn":
      return validateDespawn(obj);
    case "hit_report":
      return validateHitReport(obj);
    case "hp_state":
      return validateHpState(obj);
    case "fire_event":
      return validateFireEvent(obj);
    case "session":
      return validateSession(obj);
    case "chat":
      return validateChat(obj);
    default:
      return fail(`unknown message type: ${String(obj.type)}`);
  }
}

function validateEnvelope(obj: Fields): string | null {
  if (obj.v !== 1) return `unsupported protocol version: ${JSON.stringify(obj.v)}`;
  if (!isNumber(obj, "seq")) return "seq must be a number";
  if (!isNumber(obj, "ts")) return "ts must be a number";
  if (typeof obj.type !== "string") return "type must be a string";
  return null;
}

function validateStateUpdate(obj: Fields): ParseResult {
  if (!isString(obj, "shipId")) return fail("state_update.shipId must be a string");
  if (!isVector3(obj.position)) return fail("state_update.position must be a {x,y,z} vector");
  if (!isQuaternion(obj.rotation)) return fail("state_update.rotation must be a {qx,qy,qz,qw} quaternion");
  if (!isVector3(obj.velocity)) return fail("state_update.velocity must be a {x,y,z} vector");
  if (!isOptionalNumber(obj, "mdRate")) return fail("state_update.mdRate must be a number if present");
  return ok(obj as unknown as StateUpdateMessage);
}

function validateSpawn(obj: Fields): ParseResult {
  if (!isString(obj, "objectId")) return fail("spawn.objectId must be a string");
  if (!isString(obj, "shipType")) return fail("spawn.shipType must be a string");
  if (!isString(obj, "owner")) return fail("spawn.owner must be a string");
  if (!isStringArray(obj.loadout)) return fail("spawn.loadout must be an array of strings if present");
  if (!isOptionalNumber(obj, "maxHull")) return fail("spawn.maxHull must be a number if present");
  if (!isOptionalNumber(obj, "maxShield")) return fail("spawn.maxShield must be a number if present");
  return ok(obj as unknown as SpawnMessage);
}

function validateDespawn(obj: Fields): ParseResult {
  if (!isString(obj, "objectId")) return fail("despawn.objectId must be a string");
  if (!isOptionalString(obj, "reason")) return fail("despawn.reason must be a string if present");
  return ok(obj as unknown as DespawnMessage);
}

function validateHitReport(obj: Fields): ParseResult {
  if (!isString(obj, "targetId")) return fail("hit_report.targetId must be a string");
  if (!isString(obj, "sourceId")) return fail("hit_report.sourceId must be a string");
  if (!isNumber(obj, "damage")) return fail("hit_report.damage must be a number");
  if (obj.damageType !== "hull" && obj.damageType !== "shield") {
    return fail('hit_report.damageType must be "hull" or "shield"');
  }
  return ok(obj as unknown as HitReportMessage);
}

function validateHpState(obj: Fields): ParseResult {
  if (!isString(obj, "objectId")) return fail("hp_state.objectId must be a string");
  if (!isNumber(obj, "hull")) return fail("hp_state.hull must be a number");
  if (!isNumber(obj, "shield")) return fail("hp_state.shield must be a number");
  return ok(obj as unknown as HpStateMessage);
}

function validateFireEvent(obj: Fields): ParseResult {
  if (!isString(obj, "sourceId")) return fail("fire_event.sourceId must be a string");
  if (!isString(obj, "weapon")) return fail("fire_event.weapon must be a string");
  if (!isVector3(obj.origin)) return fail("fire_event.origin must be a {x,y,z} vector");
  if (!isVector3(obj.direction)) return fail("fire_event.direction must be a {x,y,z} vector");
  return ok(obj as unknown as FireEventMessage);
}

const SESSION_ACTIONS = new Set(["join", "leave", "ready", "countdown", "seta_on", "seta_off"]);

function validateSession(obj: Fields): ParseResult {
  if (typeof obj.action !== "string" || !SESSION_ACTIONS.has(obj.action)) {
    return fail('session.action must be one of "join", "leave", "ready", "countdown", "seta_on", "seta_off"');
  }
  if (!isString(obj, "sessionCode")) return fail("session.sessionCode must be a string");
  if (!isOptionalString(obj, "playerName")) return fail("session.playerName must be a string if present");
  if (!isOptionalNumber(obj, "countdownSeconds")) {
    return fail("session.countdownSeconds must be a number if present");
  }
  return ok(obj as unknown as SessionMessage);
}

function validateChat(obj: Fields): ParseResult {
  if (!isString(obj, "from")) return fail("chat.from must be a string");
  if (!isString(obj, "text")) return fail("chat.text must be a string");
  return ok(obj as unknown as ChatMessage);
}
