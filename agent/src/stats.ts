import type { Vector3 } from "@xmultiplayer/protocol";

/** Running counters for the agent's periodic debug output. */
export interface StreamStats {
  received: number;
  gaps: number;
  lastSeq: number | null;
  lastPosition: Vector3 | null;
}

export function createStats(): StreamStats {
  return { received: 0, gaps: 0, lastSeq: null, lastPosition: null };
}

/** Records one received state_update sequence number, detecting gaps (skipped seq values). */
export function recordSeq(stats: StreamStats, seq: number): void {
  stats.received += 1;
  if (stats.lastSeq !== null && seq > stats.lastSeq + 1) {
    stats.gaps += seq - stats.lastSeq - 1;
  }
  stats.lastSeq = seq;
}
