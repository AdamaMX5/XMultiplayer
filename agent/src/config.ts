/** CLI/env configuration for the agent. Explicit CLI flags win over environment variables, which win over defaults. */
export interface AgentConfig {
  serverUrl: string;
  sessionCode: string;
  pipeName: string;
  playerName: string;
}

const DEFAULTS: AgentConfig = {
  serverUrl: "ws://localhost:8765",
  sessionCode: "default",
  pipeName: "xmultiplayer",
  playerName: "pilot",
};

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): AgentConfig {
  return {
    serverUrl: argValue(argv, "--server") ?? env.XMP_SERVER ?? DEFAULTS.serverUrl,
    sessionCode: argValue(argv, "--session") ?? env.XMP_SESSION ?? DEFAULTS.sessionCode,
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
