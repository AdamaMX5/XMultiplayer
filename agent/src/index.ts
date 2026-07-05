import { parseMessage } from "@xmultiplayer/protocol";
import { parseConfig, pipePath } from "./config.js";
import { PipeServer } from "./pipeServer.js";
import { ReconnectingWebSocket } from "./wsClient.js";
import { createStats, recordSeq, type StreamStats } from "./stats.js";

const config = parseConfig(process.argv.slice(2), process.env);
const stats = createStats();
let lastMdRate: number | null = null;
let windowCount = 0;
let windowStart = Date.now();

const ws = new ReconnectingWebSocket({
  url: config.serverUrl,
  onOpen: () => {
    console.log(`[agent] connected to relay server at ${config.serverUrl}`);
    ws.send(
      JSON.stringify({
        v: 1,
        type: "session",
        action: "join",
        seq: 0,
        ts: Date.now(),
        sessionCode: config.sessionCode,
        playerName: config.playerName,
      })
    );
  },
  onClose: () => console.log("[agent] relay connection lost, retrying..."),
  // A1 does not consume remote state yet -- forwarding is one-directional (pipe -> relay).
  onMessage: () => {},
});
ws.connect();

const pipe = new PipeServer(pipePath(config.pipeName), {
  onListening: () => console.log(`[agent] waiting for X4 on pipe ${pipePath(config.pipeName)}`),
  onClientConnected: () => console.log("[agent] X4 client connected to pipe"),
  onClientDisconnected: () => console.log("[agent] X4 client disconnected (game closed?), waiting for reconnect"),
  onError: (err) => console.error(`[agent] pipe error: ${err.message}`),
  onOversizedLine: (droppedBytes) => console.warn(`[agent] dropped oversized pipe line (${droppedBytes} bytes), connection stays open`),
  onLine: (line) => handleLine(line, stats, ws, (rate) => (lastMdRate = rate), () => (windowCount += 1)),
});
pipe.start();

function handleLine(
  line: string,
  streamStats: StreamStats,
  socket: ReconnectingWebSocket,
  setMdRate: (rate: number) => void,
  countWindow: () => void
): void {
  const result = parseMessage(line);
  if (!result.ok) {
    console.warn(`[agent] dropped invalid message: ${result.error}`);
    return;
  }
  const msg = result.message;
  if (msg.type === "state_update") {
    recordSeq(streamStats, msg.seq);
    streamStats.lastPosition = msg.position;
    if (msg.mdRate !== undefined) setMdRate(msg.mdRate);
    countWindow();
  }
  socket.send(line);
}

setInterval(() => {
  const elapsedSec = (Date.now() - windowStart) / 1000;
  const agentHz = windowCount / elapsedSec;
  console.log(
    `[agent stats] received=${stats.received} agentHz=${agentHz.toFixed(2)} ` +
      `mdRate=${lastMdRate !== null ? lastMdRate.toFixed(2) : "n/a"} gaps=${stats.gaps} ` +
      `lastPos=${stats.lastPosition ? JSON.stringify(stats.lastPosition) : "n/a"}`
  );
  windowCount = 0;
  windowStart = Date.now();
}, 5000);
