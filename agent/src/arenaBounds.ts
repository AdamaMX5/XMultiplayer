import type { Vector3 } from "@xmultiplayer/protocol";

/**
 * Sanity bounds for a remote `state_update` before it is forwarded into the pipe
 * (A4 security hardening, agent-side per the team lead's directive -- "im Agent",
 * `decideRelay erweitern`). The dedicated Arena sector (A2) is a small, bounded
 * space with no other content; a position or velocity far outside these bounds is
 * either a bug on the sender's end or a spoofed/malicious value, either way not
 * something to hand to `set_object_position`/the AI-script's Dead Reckoning math
 * unchecked. Generous on purpose: these should only ever reject genuinely
 * implausible values, never a fast-but-real one.
 */
export const ARENA_BOUNDS_METERS = 500_000;
export const MAX_VELOCITY_MPS = 10_000;

/** True if every axis of position is within [-ARENA_BOUNDS_METERS, ARENA_BOUNDS_METERS]. NaN/Infinity fail this (any comparison against NaN is false). */
export function isWithinArenaBounds(position: Vector3): boolean {
  return (
    Math.abs(position.x) <= ARENA_BOUNDS_METERS &&
    Math.abs(position.y) <= ARENA_BOUNDS_METERS &&
    Math.abs(position.z) <= ARENA_BOUNDS_METERS
  );
}

/** True if the velocity vector's magnitude does not exceed MAX_VELOCITY_MPS. */
export function isPlausibleVelocity(velocity: Vector3): boolean {
  const speedSq = velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z;
  return speedSq <= MAX_VELOCITY_MPS * MAX_VELOCITY_MPS;
}
