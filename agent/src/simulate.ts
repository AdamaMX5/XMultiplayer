import { connect } from "node:net";
import { pipePath } from "./config.js";

/**
 * Fake X4 client for local end-to-end testing without the game installed.
 * Connects to the agent's Named Pipe as a client (the role SirNukes' Named_Pipes
 * API plays in-game) and streams plausible telemetry (circular flight) at 10 Hz.
 */
const pipeName = process.argv[2] ?? "xmultiplayer";
const path = pipePath(pipeName);
const RADIUS = 1000;
const ANGULAR_SPEED = 0.2; // rad/s

console.log(`[simulate] connecting to ${path}`);
const socket = connect(path, () => {
  console.log("[simulate] connected, streaming fake telemetry at 10 Hz");
  setInterval(() => sendTick(socket), 100);
});

let seq = 0;

function sendTick(socket: import("node:net").Socket): void {
  const t = seq * 0.1;
  const angle = t * ANGULAR_SPEED;
  const message = {
    v: 1,
    type: "state_update",
    seq: seq++,
    ts: Date.now(),
    shipId: "sim-ship-1",
    position: { x: Math.cos(angle) * RADIUS, y: 0, z: Math.sin(angle) * RADIUS },
    rotation: { qx: 0, qy: Math.sin(angle / 2), qz: 0, qw: Math.cos(angle / 2) },
    velocity: {
      x: -Math.sin(angle) * RADIUS * ANGULAR_SPEED,
      y: 0,
      z: Math.cos(angle) * RADIUS * ANGULAR_SPEED,
    },
    mdRate: 10,
  };
  socket.write(JSON.stringify(message) + "\n");
}

socket.on("error", (err) => {
  console.error(`[simulate] pipe error: ${err.message}`);
  process.exit(1);
});
