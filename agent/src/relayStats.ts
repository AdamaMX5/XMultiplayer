/**
 * Bundles the module-level counters agent/src/index.ts tracks for its 5-second
 * debug log, mirroring the StreamStats pattern (stats.ts): a plain data object
 * plus small mutator functions, instead of scattered `let`s at module scope.
 */
export interface RelayStats {
  lastMdRate: number | null;
  windowCount: number;
  windowStart: number;
  remoteForwarded: number;
  remoteDropped: number;
}

export function createRelayStats(now: number = Date.now()): RelayStats {
  return { lastMdRate: null, windowCount: 0, windowStart: now, remoteForwarded: 0, remoteDropped: 0 };
}

/** Resets the per-window tick counter and start time; called once per logged window. */
export function resetWindow(stats: RelayStats, now: number = Date.now()): void {
  stats.windowCount = 0;
  stats.windowStart = now;
}
