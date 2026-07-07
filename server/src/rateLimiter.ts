/**
 * Simple per-key token bucket (A5 security hardening, items 9-10: a per-client
 * hit_report-specific limit and a general per-client all-message-types limit).
 * A Map keyed by an arbitrary string (clientId), not a single shared counter,
 * since the whole point is to bound one MISBEHAVING client without punishing
 * everyone else in the same session/server.
 */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  /**
   * @param capacity Maximum tokens a bucket can hold (i.e. the largest burst allowed).
   * @param refillPerSecond Tokens added back per second (i.e. the sustained rate allowed).
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number
  ) {}

  /** True and consumes one token if `key` has one available; false (and consumes nothing) otherwise. */
  tryConsume(key: string, nowMs: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSecond);
    bucket.lastRefillMs = nowMs;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Forgets a key's bucket entirely (e.g. on disconnect), so the map doesn't grow unboundedly for clients that are long gone. */
  reset(key: string): void {
    this.buckets.delete(key);
  }
}
