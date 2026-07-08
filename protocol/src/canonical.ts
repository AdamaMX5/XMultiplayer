import type { ProtocolMessage, Quaternion, Vector3 } from "./messages.js";

/**
 * Re-serializes an already-validated ProtocolMessage into a canonical JSON string:
 * only the fields defined for that message's type, in a fixed key order, nothing
 * else. parseMessage validates that required fields exist and have the right
 * type, but it does not strip unexpected extra properties from the object it
 * returns -- a message can arrive with additional, unvalidated JSON fields riding
 * along. From A3 on, the agent uses this (not the original raw line) for
 * everything it writes into the pipe or caches in knownSpawns, specifically so
 * that what MD's XMP_Arena_ExtractField ever sees is built by us, field by field,
 * from typed values -- not forwarded byte-for-byte from another player. That
 * closes the "decoy field" concern raised in the A2 security review: since
 * XMP_Arena_ExtractField finds a field by searching for its literal `"name":`
 * text rather than doing real JSON parsing, forwarding an untrusted string
 * verbatim means its exact byte layout (nesting, field order, string contents)
 * is untrusted too. Rebuilding the JSON from the validated object removes that
 * degree of freedom entirely.
 */
export function serializeCanonical(msg: ProtocolMessage): string {
  switch (msg.type) {
    case "state_update":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        shipId: msg.shipId,
        position: canonicalVector3(msg.position),
        rotation: canonicalQuaternion(msg.rotation),
        velocity: canonicalVector3(msg.velocity),
        ...(msg.mdRate !== undefined ? { mdRate: msg.mdRate } : {}),
      });
    case "spawn":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        objectId: msg.objectId,
        shipType: msg.shipType,
        ...(msg.loadout !== undefined ? { loadout: [...msg.loadout] } : {}),
        owner: msg.owner,
        ...(msg.maxHull !== undefined ? { maxHull: msg.maxHull } : {}),
        ...(msg.maxShield !== undefined ? { maxShield: msg.maxShield } : {}),
        ...(msg.category !== undefined ? { category: msg.category } : {}),
      });
    case "despawn":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        objectId: msg.objectId,
        ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
      });
    case "hit_report":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        targetId: msg.targetId,
        sourceId: msg.sourceId,
        damage: msg.damage,
        damageType: msg.damageType,
      });
    case "hp_state":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        objectId: msg.objectId,
        hull: msg.hull,
        shield: msg.shield,
      });
    case "fire_event":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        sourceId: msg.sourceId,
        weapon: msg.weapon,
        origin: canonicalVector3(msg.origin),
        direction: canonicalVector3(msg.direction),
      });
    case "session":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        action: msg.action,
        sessionCode: msg.sessionCode,
        ...(msg.playerName !== undefined ? { playerName: msg.playerName } : {}),
        ...(msg.countdownSeconds !== undefined ? { countdownSeconds: msg.countdownSeconds } : {}),
      });
    case "chat":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        from: msg.from,
        text: msg.text,
      });
    case "sector_object":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        objectId: msg.objectId,
        objectType: msg.objectType,
        macroName: msg.macroName,
        position: canonicalVector3(msg.position),
        rotation: canonicalQuaternion(msg.rotation),
      });
    case "sector_mirror":
      return JSON.stringify({
        v: msg.v,
        type: msg.type,
        seq: msg.seq,
        ts: msg.ts,
        action: msg.action,
        ...(msg.objectCount !== undefined ? { objectCount: msg.objectCount } : {}),
      });
  }
}

function canonicalVector3(v: Vector3): Vector3 {
  return { x: v.x, y: v.y, z: v.z };
}

function canonicalQuaternion(q: Quaternion): Quaternion {
  return { qx: q.qx, qy: q.qy, qz: q.qz, qw: q.qw };
}
