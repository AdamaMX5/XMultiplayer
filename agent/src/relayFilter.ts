import {
  ARENA_BOUNDS_METERS,
  isKnownShipMacro,
  isPlausibleVelocity,
  isWithinArenaBounds,
  MAX_VELOCITY_MPS,
  type ProtocolMessage,
} from "@xmultiplayer/protocol";

export type RelayDecision = { forward: true } | { forward: false; reason: string };

/**
 * Decides whether a message received from the relay server (about another session
 * member) may be forwarded into the pipe (game). From A2 on this is a trust
 * boundary, expanded again in A4:
 *   - `spawn` naming a `shipType` outside the known-good whitelist is rejected
 *     (A2), before it ever reaches `create_ship` in the mod -- EXCEPT for
 *     `category: "npc"` spawns (C3), which skip this check entirely.
 *     SHIP_MACRO_WHITELIST is a small, hand-picked set of Arena PvP starting
 *     ships and was never meant to cover real X4 NPC traffic (freighters,
 *     miners, capital ships, every race/faction); parseMessage's
 *     MAX_MACRO_NAME_LENGTH cap on shipType (protocol/src/parse.ts, applies to
 *     every spawn regardless of category) is the one bound npc shipType gets
 *     in its place, the same trust posture C1 already established for
 *     sector_object.macroName (no whitelist there either).
 *   - `state_update` with a position/velocity outside plausible Arena bounds is
 *     rejected (A4), before it ever reaches `set_object_position`/the AI-script's
 *     Dead Reckoning math.
 *   - `state_update`/`hit_report` referencing a `shipId`/`targetId` this agent has
 *     no known spawn for is rejected (A4 "orphan filter"): besides being
 *     meaningless locally (there's no proxy to update), forwarding an
 *     ever-growing set of unknown ids into index.ts's LatencyTracker would let its
 *     internal Map grow without bound, since nothing ever calls reset() for an id
 *     that was never legitimately spawned/despawned.
 * `knownObjectIds` is the caller's current set of objectIds with a live spawn
 * (index.ts's `knownSpawns` keys); hit_report never actually arrives via this path
 * today (the server only ever sends the resolved hp_state back, never the raw
 * hit_report, see protocol.md), so that half of the orphan filter is presently
 * unreachable in practice -- kept anyway as defense in depth against the server
 * contract ever changing, and because it costs nothing to apply the same check
 * that state_update already needs.
 */
export function decideRelay(msg: ProtocolMessage, knownObjectIds: ReadonlySet<string>): RelayDecision {
  if (msg.type === "spawn" && msg.category !== "npc" && !isKnownShipMacro(msg.shipType)) {
    return { forward: false, reason: `unknown shipType "${msg.shipType}", rejected by whitelist` };
  }
  if (msg.type === "state_update") {
    if (!knownObjectIds.has(msg.shipId)) {
      return { forward: false, reason: `state_update for unknown/orphan shipId "${msg.shipId}" (no known spawn), dropped` };
    }
    if (!isWithinArenaBounds(msg.position)) {
      return { forward: false, reason: `position outside Arena bounds (±${ARENA_BOUNDS_METERS}m): ${JSON.stringify(msg.position)}` };
    }
    if (!isPlausibleVelocity(msg.velocity)) {
      return { forward: false, reason: `velocity exceeds plausible max (${MAX_VELOCITY_MPS}m/s): ${JSON.stringify(msg.velocity)}` };
    }
  }
  if (msg.type === "hit_report" && !knownObjectIds.has(msg.targetId)) {
    return { forward: false, reason: `hit_report for unknown/orphan targetId "${msg.targetId}" (no known spawn), dropped` };
  }
  return { forward: true };
}
