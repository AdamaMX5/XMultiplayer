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
 * (XMP_Arena_OnEnterSector, A5, + XMP_Telemetry_Tick) does once the player
 * enters the Arena sector. This simulator always spawns immediately on connect
 * (it has no "sector" to detect), so run it with an explicit --session (or
 * XMP_SESSION on its agent) the same way A1-A4 always did.
 *
 * Two-way since A2: also reads whatever the agent forwards back down the same pipe
 * connection (other session members' spawn/despawn/state_update, relayed from the
 * server) and logs it readably. Run two instances with different --pipe-name and
 * --object-id against the same agent/server pair to see the full A2 chain locally:
 * each instance's log shows the other's spawn and position updates.
 *
 * Since A4: pass --hit-target <objectId> (plus optionally --damage/--damage-type)
 * to fire a single hit_report at that objectId shortly after connecting (see
 * --hit-delay-ms), and every hp_state/destroyed-despawn this instance receives is
 * logged too -- so the whole combat chain (attacker's hit_report -> server ->
 * hp_state on both sides -> destruction despawn once hull reaches 0) is
 * demonstrable with two simulator instances and no X4 install, the same way A2's
 * spawn/state_update chain already is. Typical demo: start instance A with
 * --object-id ship-a, instance B with --object-id ship-b
 * --hit-target ship-a --damage 100 --damage-type hull (exactly lethal against the
 * default 100 starting hull) -- A's log shows its own hp_state hull:0 followed by
 * a remote despawn (reason=destroyed) for itself.
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
// A4: optional one-shot hit_report, see the file header for the two-instance demo.
const hitTarget = argValue(argv, "--hit-target");
const hitDamage = Number(argValue(argv, "--damage") ?? "25");
const hitDamageType = argValue(argv, "--damage-type") === "shield" ? "shield" : "hull";
const hitDelayMs = Number(argValue(argv, "--hit-delay-ms") ?? "2000");

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
  if (hitTarget) {
    console.log(`[simulate] will report a ${hitDamage} ${hitDamageType} hit on ${hitTarget} in ${hitDelayMs}ms`);
    setTimeout(() => sendHitReport(socket, hitTarget), hitDelayMs);
  }
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
    // A4: reason distinguishes a combat kill from a disconnect/manual despawn --
    // see server.ts's destroyObject vs broadcastDespawns.
    const reasonSuffix = msg.reason ? ` (reason=${msg.reason})` : "";
    console.log(`[sim] remote despawn ${msg.objectId}${reasonSuffix}`);
  } else if (msg.type === "state_update") {
    const p = msg.position;
    // linkLatencyMs is a pipe-only field (agent/src/pipeMessage.ts), not part of
    // StateUpdateMessage's own schema, hence the loose read here.
    const linkLatencyMs = (msg as { linkLatencyMs?: number }).linkLatencyMs;
    const latencySuffix = linkLatencyMs !== undefined ? ` latency=${linkLatencyMs.toFixed(0)}ms` : "";
    console.log(`[sim] remote pos ${msg.shipId} ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}${latencySuffix}`);
  } else if (msg.type === "hp_state") {
    // A4: the server-authoritative outcome of a hit_report, sent to every session
    // member including whoever sent the hit_report -- this instance sees it
    // whether it was the attacker or the victim (objectId tells them apart).
    const destroyedSuffix = msg.hull <= 0 ? " (DESTROYED)" : "";
    console.log(`[sim] hp_state ${msg.objectId} hull=${msg.hull} shield=${msg.shield}${destroyedSuffix}`);
  }
  // Other message types (chat, ...) aren't relevant to this simulator yet.
  // hit_report never arrives here at all -- the server resolves it into hp_state,
  // it never gets echoed back raw (protocol.md, "hit_report" direction).
}

function sendSpawn(socket: Socket): void {
  const message = { v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId, shipType, owner };
  socket.write(JSON.stringify(message) + "\n");
}

/**
 * A4: reports a single hit on targetId, sourced from this instance's own objectId
 * (A4 ownership authority requires sourceId to belong to the sender -- this
 * instance already announced objectId via sendSpawn above). One-shot, not
 * periodic: enough to demonstrate the chain without needing a real hit-detection
 * loop, which is exactly the piece this simulator can't stand in for (see the
 * client-side hit detection weakness, docs/A4-messprotokoll.md).
 */
function sendHitReport(socket: Socket, targetId: string): void {
  const message = {
    v: 1,
    type: "hit_report",
    seq: seq++,
    ts: Date.now(),
    targetId,
    sourceId: objectId,
    damage: hitDamage,
    damageType: hitDamageType,
  };
  console.log(`[simulate] sending hit_report: ${hitDamage} ${hitDamageType} damage on ${targetId}`);
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
