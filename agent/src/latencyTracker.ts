export interface LatencyTrackerOptions {
  /** EWMA smoothing factor in (0, 1]; higher weighs new samples more heavily. */
  alpha?: number;
}

const DEFAULT_ALPHA = 0.2;

/**
 * Smooths per-sender latency samples with an exponentially weighted moving
 * average (EWMA), so a single noisy/outlier sample (a GC pause, a Wi-Fi hiccup)
 * doesn't yank Dead Reckoning's extrapolation horizon around every message. Keyed
 * by sender (shipId/objectId), since different remote ships can have meaningfully
 * different link latency. A Map, not a plain object, since keys come from
 * another player's message (same rationale as knownSpawns in index.ts).
 */
export class LatencyTracker {
  private readonly alpha: number;
  private readonly smoothed = new Map<string, number>();

  constructor(options: LatencyTrackerOptions = {}) {
    this.alpha = options.alpha ?? DEFAULT_ALPHA;
  }

  /** Feeds a new raw latency sample for a sender and returns the updated EWMA estimate. */
  update(senderId: string, rawLatencyMs: number): number {
    const previous = this.smoothed.get(senderId);
    const next = previous === undefined ? rawLatencyMs : this.alpha * rawLatencyMs + (1 - this.alpha) * previous;
    this.smoothed.set(senderId, next);
    return next;
  }

  /** Current smoothed estimate for a sender, or undefined if no sample was ever recorded. */
  get(senderId: string): number | undefined {
    return this.smoothed.get(senderId);
  }

  /** Forgets a sender's smoothed state (e.g. on despawn/respawn), so a reconnect starts fresh instead of carrying stale history. */
  reset(senderId: string): void {
    this.smoothed.delete(senderId);
  }
}
