import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket, type WebSocketServer } from "ws";
import { startRelayServer, type RelayServerOptions } from "../src/server.js";

/**
 * C6 "Kommando-Relay" (Docking only, see docs/C6-messprotokoll.md):
 * dock_request/dock_response are the first message types in this protocol
 * that are routed POINT-TO-POINT (server.ts's sendToMember) instead of
 * broadcast to the whole session -- these tests exist to pin that routing
 * down specifically, the same way sectorMirror.test.ts pins down C1's
 * broadcast-based sector_object/sector_mirror behavior.
 */

function once(emitter: { once: (event: string, cb: (...args: unknown[]) => void) => void }, event: string): Promise<unknown> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function startTestServer(options: Omit<RelayServerOptions, "port"> = {}): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = startRelayServer({ port: 0, ...options });
  await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;
  return { wss, port };
}

function joinMessage(sessionCode: string, playerName: string) {
  return JSON.stringify({ v: 1, type: "session", action: "join", seq: 0, ts: Date.now(), sessionCode, playerName });
}

function spawnMessage(objectId: string, owner: string) {
  return JSON.stringify({ v: 1, type: "spawn", seq: 0, ts: Date.now(), objectId, shipType: "ship_arg_s_fighter_01_a_macro", owner });
}

function sectorObjectMessage(objectId: string) {
  return JSON.stringify({
    v: 1,
    type: "sector_object",
    seq: 0,
    ts: Date.now(),
    objectId,
    objectType: "station",
    macroName: "station_arg_shipyard_01_macro",
    position: { x: 1, y: 2, z: 3 },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
  });
}

function dockRequestMessage(targetId: string, requesterId: string) {
  return JSON.stringify({ v: 1, type: "dock_request", seq: 0, ts: Date.now(), targetId, requesterId });
}

function dockResponseMessage(targetId: string, requesterId: string, approved: boolean, reason?: string) {
  return JSON.stringify({ v: 1, type: "dock_response", seq: 0, ts: Date.now(), targetId, requesterId, approved, ...(reason !== undefined ? { reason } : {}) });
}

test("dock_request is routed only to whoever exported the target station, not broadcast to the whole session", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  const c = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open"), once(c, "open")]);

  a.send(joinMessage("dock-1", "Alice"));
  b.send(joinMessage("dock-1", "Bob"));
  c.send(joinMessage("dock-1", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  a.send(sectorObjectMessage("station-1"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let aReceivedDockRequest = false;
  let cReceivedDockRequest = false;
  a.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "dock_request") aReceivedDockRequest = true;
  });
  c.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "dock_request") cReceivedDockRequest = true;
  });

  b.send(dockRequestMessage("station-1", "ship-bob"));
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(aReceivedDockRequest, true, "the exporter of the target station must receive the dock_request");
  assert.equal(cReceivedDockRequest, false, "a third, uninvolved member must NOT receive the dock_request");

  a.close();
  b.close();
  c.close();
  wss.close();
});

test("dock_request for an unknown/never-exported targetId is dropped, nobody receives anything", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("dock-2", "Alice"));
  b.send(joinMessage("dock-2", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  a.on("message", () => (received = true));
  b.send(dockRequestMessage("never-exported-station", "ship-bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(received, false);

  a.close();
  b.close();
  wss.close();
});

test("dock_request with a requesterId the sender does not own is rejected (A4 ownership authority)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("dock-3", "Alice"));
  b.send(joinMessage("dock-3", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(sectorObjectMessage("station-1"));
  a.send(spawnMessage("ship-alice", "Alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let aReceived = false;
  a.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "dock_request") aReceived = true;
  });
  // Bob claims Alice's own ship as the requester -- never owned it.
  b.send(dockRequestMessage("station-1", "ship-alice"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(aReceived, false, "a spoofed requesterId must not be routed at all");

  a.close();
  b.close();
  wss.close();
});

test("dock_response is routed only to whoever owns the requester's ship, not broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  const c = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open"), once(c, "open")]);

  a.send(joinMessage("dock-4", "Alice"));
  b.send(joinMessage("dock-4", "Bob"));
  c.send(joinMessage("dock-4", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(sectorObjectMessage("station-1"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let bReceivedDockResponse = false;
  let cReceivedDockResponse = false;
  b.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "dock_response") bReceivedDockResponse = true;
  });
  c.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "dock_response") cReceivedDockResponse = true;
  });

  a.send(dockResponseMessage("station-1", "ship-bob", true));
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(bReceivedDockResponse, true, "the requester's own owner must receive the dock_response");
  assert.equal(cReceivedDockResponse, false, "an uninvolved third member must NOT receive it");

  a.close();
  b.close();
  c.close();
  wss.close();
});

test("dock_response from a member who does NOT own targetId is rejected (spoofing protection)", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  const c = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open"), once(c, "open")]);

  a.send(joinMessage("dock-5", "Alice"));
  b.send(joinMessage("dock-5", "Bob"));
  c.send(joinMessage("dock-5", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(sectorObjectMessage("station-1")); // Alice exports/owns station-1
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let bReceived = false;
  b.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "dock_response") bReceived = true;
  });
  // Carol never exported station-1 -- must not be able to approve a dock for it.
  c.send(dockResponseMessage("station-1", "ship-bob", true));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(bReceived, false, "a dock_response from a non-owner of targetId must be dropped");

  a.close();
  b.close();
  c.close();
  wss.close();
});

test("dock_response for an unknown/never-spawned requesterId is dropped", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("dock-6", "Alice"));
  b.send(joinMessage("dock-6", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(sectorObjectMessage("station-1"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let bReceived = false;
  b.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "dock_response") bReceived = true;
  });
  a.send(dockResponseMessage("station-1", "never-spawned-ship", true));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(bReceived, false);

  a.close();
  b.close();
  wss.close();
});

test("full round trip: dock_request from the requester reaches the host, dock_response reaches back to the requester", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("dock-7", "Alice"));
  b.send(joinMessage("dock-7", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(sectorObjectMessage("station-1"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const aReceivedRequest = once(a, "message");
  b.send(dockRequestMessage("station-1", "ship-bob"));
  const requestRaw = JSON.parse((await aReceivedRequest) as string);
  assert.equal(requestRaw.type, "dock_request");
  assert.equal(requestRaw.targetId, "station-1");
  assert.equal(requestRaw.requesterId, "ship-bob");

  const bReceivedResponse = once(b, "message");
  a.send(dockResponseMessage("station-1", "ship-bob", true));
  const responseRaw = JSON.parse((await bReceivedResponse) as string);
  assert.equal(responseRaw.type, "dock_response");
  assert.equal(responseRaw.approved, true);

  a.close();
  b.close();
  wss.close();
});

test("dock_response's reason is sanitized (control characters stripped) before being relayed, same trust posture as chat.text", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("dock-8", "Alice"));
  b.send(joinMessage("dock-8", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  a.send(sectorObjectMessage("station-1"));
  b.send(spawnMessage("ship-bob", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bReceivedResponse = once(b, "message");
  a.send(dockResponseMessage("station-1", "ship-bob", false, "denied\r\ninjected"));
  const responseRaw = JSON.parse((await bReceivedResponse) as string);
  assert.equal(responseRaw.approved, false);
  assert.equal(responseRaw.reason.includes("\r"), false);
  assert.equal(responseRaw.reason.includes("\n"), false);

  a.close();
  b.close();
  wss.close();
});

test("dock_request/dock_response from a client outside any session are dropped", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  await once(a, "open");

  let received = false;
  a.on("message", () => (received = true));
  a.send(dockRequestMessage("station-1", "ship-1"));
  a.send(dockResponseMessage("station-1", "ship-1", true));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(received, false);

  a.close();
  wss.close();
});
