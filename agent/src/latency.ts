/**
 * Estimates one-way link latency for a message, using the difference between the
 * receiver's local clock and the sender's `ts` (envelope timestamp, already part
 * of every message). Chosen over a WebSocket-level ping/pong round trip because it
 * needs no new timers/reconnect-state and reuses a field every message already
 * carries; the tradeoff, documented rather than hidden, is that it assumes the two
 * machines' clocks are reasonably close (no NTP guarantee is made anywhere in this
 * project). Clamped to [0, MAX_LATENCY_MS]: negative values (clock skew in the
 * receiver's favor) clamp to 0, and anything above MAX_LATENCY_MS is far more
 * likely to be clock skew between the two machines than genuine network latency,
 * so it's capped rather than fed as-is into Dead Reckoning's extrapolation (which
 * would otherwise fly a proxy arbitrarily far on a single bad clock reading).
 */
export const MAX_LATENCY_MS = 2000;

export function estimateLatencyMs(sentAtMs: number, now: number = Date.now()): number {
  return Math.min(MAX_LATENCY_MS, Math.max(0, now - sentAtMs));
}
