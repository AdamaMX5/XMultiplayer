import { startRelayServer } from "./server.js";

function parsePort(argv: string[], env: NodeJS.ProcessEnv): number {
  const idx = argv.indexOf("--port");
  const fromArg = idx !== -1 ? Number(argv[idx + 1]) : undefined;
  return fromArg ?? Number(env.XMP_PORT ?? 8765);
}

startRelayServer({ port: parsePort(process.argv.slice(2), process.env) });
