/** CLI/env configuration for the agent. Explicit CLI flags win over environment variables, which win over defaults. */
export interface AgentConfig {
  serverUrl: string;
  sessionCode: string;
  /**
   * True if --session/XMP_SESSION was actually given, as opposed to falling back
   * to the hard-coded default (A5 "Drop-in-Arena"). Distinguishes two very
   * different agent behaviors: an EXPLICIT session code means "join this
   * immediately at connect time" (the pre-A5 behavior, still needed for the
   * simulator/e2e tests and for an operator running a private/override
   * session), whereas no explicit code means "wait for the mod to send its own
   * session join once it detects the player actually entering the Arena
   * sector" -- the whole point of presence-based drop-in is that joining isn't
   * a fixed, connect-time event anymore.
   */
  sessionCodeExplicit: boolean;
  pipeName: string;
  playerName: string;
}

const DEFAULTS: Omit<AgentConfig, "sessionCodeExplicit"> = {
  serverUrl: "ws://localhost:8765",
  // A5: "arena" is the documented LAN convention (docs/A5-messprotokoll.md,
  // mod/md/XMP_Arena.xml's presence-triggered join uses the same literal) --
  // renamed from A1-A4's "default" for consistency now that a real mod
  // actually needs to agree with the agent on what this string is, rather than
  // it only ever appearing in tests/manual --session overrides.
  sessionCode: "arena",
  pipeName: "xmultiplayer",
  playerName: "pilot",
};

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): AgentConfig {
  const sessionCodeOverride = argValue(argv, "--session") ?? env.XMP_SESSION;
  return {
    serverUrl: argValue(argv, "--server") ?? env.XMP_SERVER ?? DEFAULTS.serverUrl,
    sessionCode: sessionCodeOverride ?? DEFAULTS.sessionCode,
    sessionCodeExplicit: sessionCodeOverride !== undefined,
    pipeName: argValue(argv, "--pipe-name") ?? env.XMP_PIPE_NAME ?? DEFAULTS.pipeName,
    playerName: argValue(argv, "--player-name") ?? env.XMP_PLAYER_NAME ?? DEFAULTS.playerName,
  };
}

/**
 * SirNukes Mod Support APIs map a logical pipe name to a concrete Windows Named
 * Pipe path of the form \\.\pipe\x4_<name> (assumption, to be validated in-game --
 * see docs/A1-messprotokoll.md).
 */
export function pipePath(pipeName: string): string {
  return `\\\\.\\pipe\\x4_${pipeName}`;
}
