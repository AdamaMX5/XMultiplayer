import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { isKnownShipMacro, parseMessage } from "@xmultiplayer/protocol";
import { pipePath } from "./config.js";
import { NdjsonSplitter } from "./ndjson.js";

/**
 * Fake X4 client for local end-to-end testing without the game installed.
 * Connects to the agent's Named Pipe as a client (the role SirNukes' Named_Pipes
 * API plays in-game), announces itself with a `spawn` message, then streams
 * plausible telemetry (circular flight) at 10 Hz -- mirroring what the real mod
 * (XMP_Arena_AnnounceSpawn + XMP_Telemetry_Tick) does.
 *
 * Two-way since A2: also reads whatever the agent forwards back down the same pipe
 * connection (other session members' spawn/despawn/state_update, relayed from the
 * server) and logs it readably. Run two instances with different --pipe-name and
 * --object-id against the same agent/server pair to see the full A2 chain locally:
 * each instance's log shows the other's spawn and position updates.
 */
function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

const argv = process.argv.slice(2);
const pipeName = argValue(argv, "--pipe-name") ?? "xmultiplayer";
const shipType = argValue(argv, "--ship") ?? "ship_arg_s_fighter_01_a_macro";
const owner = argValue(argv, "--owner") ?? "simulator";
const objectId = argValue(argv, "--object-id") ?? `sim-${randomUUID()}`;

if (!isKnownShipMacro(shipType)) {
  console.error(`[simulate] --ship "${shipType}" is not on the known ship macro whitelist, refusing to start.`);
  console.error("[simulate] see protocol/src/shipMacros.ts for the allowed list.");
  process.exit(1);
}

const path = pipePath(pipeName);
const RADIUS = 1000;
const ANGULAR_SPEED = 0.2; // rad/s
let seq = 0;

console.log(`[simulate] connecting to ${path} (objectId=${objectId}, ship=${shipType}, owner=${owner})`);
const socket = connect(path, () => {
  console.log("[simulate] connected, announcing spawn and streaming fake telemetry at 10 Hz");
  sendSpawn(socket);
  setInterval(() => sendTick(socket), 100);
});

const splitter = new NdjsonSplitter();
socket.on("data", (chunk) => {
  for (const line of splitter.push(chunk)) {
    handleIncomingLine(line);
  }
});

/** Logs whatever the agent relays back down the pipe (other session members), readably. */
function handleIncomingLine(line: string): void {
  const result = parseMessage(line);
  if (!result.ok) {
    console.warn(`[sim] dropped invalid line from agent: ${result.error}`);
    return;
  }
  const msg = result.message;
  if (msg.type === "spawn") {
    console.log(`[sim] remote spawn ${msg.objectId} ${msg.shipType} (owner=${msg.owner})`);
  } else if (msg.type === "despawn") {
    console.log(`[sim] remote despawn ${msg.objectId}`);
  } else if (msg.type === "state_update") {
    const p = msg.position;
    console.log(`[sim] remote pos ${msg.shipId} ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`);
  }
  // Other message types (chat, hit_report, ...) aren't relevant to this simulator yet.
}

function sendSpawn(socket: Socket): void {
  const message = { v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId, shipType, owner };
  socket.write(JSON.stringify(message) + "\n");
}

function sendTick(socket: Socket): void {
  const t = seq * 0.1;
  const angle = t * ANGULAR_SPEED;
  const message = {
    v: 1,
    type: "state_update",
    seq: seq++,
    ts: Date.now(),
    shipId: objectId,
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
