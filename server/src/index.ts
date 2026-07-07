import { startRelayServer } from "./server.js";
import { parseShipClassPreset } from "./shipClassPolicy.js";

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function numberOption(argv: string[], flag: string, envVar: string | undefined, fallback: number): number {
  const fromArg = argValue(argv, flag);
  if (fromArg !== undefined) return Number(fromArg);
  if (envVar !== undefined) return Number(envVar);
  return fallback;
}

function parsePort(argv: string[], env: NodeJS.ProcessEnv): number {
  return numberOption(argv, "--port", env.XMP_PORT, 8765);
}

const argv = process.argv.slice(2);
const env = process.env;

startRelayServer({
  port: parsePort(argv, env),
  // A5 "Regel-Presets": e.g. --ships s for an S-class-only arena. Defaults to
  // "all" (no additional restriction beyond the ship macro whitelist).
  shipClassPreset: parseShipClassPreset(argValue(argv, "--ships") ?? env.XMP_SHIPS),
  // A5 security hardening (items 9-11). All optional; startRelayServer's own
  // defaults are generous enough for LAN/dev use if none of these are set.
  generalRateLimit: {
    capacity: numberOption(argv, "--rate-limit-capacity", env.XMP_RATE_LIMIT_CAPACITY, 60),
    refillPerSecond: numberOption(argv, "--rate-limit-per-second", env.XMP_RATE_LIMIT_PER_SECOND, 30),
  },
  hitReportRateLimit: {
    capacity: numberOption(argv, "--hit-report-rate-limit-capacity", env.XMP_HIT_REPORT_RATE_LIMIT_CAPACITY, 20),
    refillPerSecond: numberOption(argv, "--hit-report-rate-limit-per-second", env.XMP_HIT_REPORT_RATE_LIMIT_PER_SECOND, 20),
  },
  maxConnections: numberOption(argv, "--max-connections", env.XMP_MAX_CONNECTIONS, 500),
  maxConnectionsPerIp: numberOption(argv, "--max-connections-per-ip", env.XMP_MAX_CONNECTIONS_PER_IP, 50),
  maxSessions: numberOption(argv, "--max-sessions", env.XMP_MAX_SESSIONS, 1000),
  // "Internet-Modus": enforces session-code entropy (rejects the LAN default
  // "arena" and overly short codes). Off by default, matching the LAN-first
  // convention documented in docs/A5-messprotokoll.md.
  publicMode: hasFlag(argv, "--public") || env.XMP_PUBLIC === "1" || env.XMP_PUBLIC === "true",
});
