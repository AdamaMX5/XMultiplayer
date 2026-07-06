import { serializeCanonical, type ProtocolMessage } from "@xmultiplayer/protocol";

/**
 * Builds the exact line the agent writes into the pipe for a message relayed from
 * the server: the canonical (re-serialized, decoy-field-free, see
 * protocol/src/canonical.ts) form, with one field appended for state_update
 * specifically: linkLatencyMs, the caller's already-smoothed link latency estimate
 * (see agent/src/latency.ts + latencyTracker.ts, wired up in index.ts). MD
 * backdates its "last received" timestamp by this amount, so Dead Reckoning's
 * extrapolation compensates for network delay as well as time elapsed locally
 * (see docs/A3-messprotokoll.md, "Position + Geschwindigkeitsvektor x Latenz").
 *
 * Takes the latency as a plain number rather than computing it itself, so this
 * function stays pure and stateless -- estimating and smoothing latency is a
 * per-sender, stateful concern (LatencyTracker) that does not belong here, and
 * serializeCanonical's own contract (only the fields the wire schema defines,
 * ever) stays simple, with no need to know about this pipe-only addition either.
 */
export function buildPipeLine(msg: ProtocolMessage, linkLatencyMs?: number): string {
  const canonical = serializeCanonical(msg);
  if (msg.type !== "state_update" || linkLatencyMs === undefined) return canonical;
  return JSON.stringify({ ...JSON.parse(canonical), linkLatencyMs });
}
