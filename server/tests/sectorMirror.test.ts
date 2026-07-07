import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket, type WebSocketServer } from "ws";
import { MAX_SECTOR_OBJECTS_PER_MIRROR } from "@xmultiplayer/protocol";
import { startRelayServer, type RelayServerOptions } from "../src/server.js";

/**
 * C1 "Statischer Sektor-Mirror": sector_object/sector_mirror have no per-object
 * OWNERSHIP model (see server.ts's comment above its sector_mirror/sector_object
 * handling) -- these tests exist to confirm the deliberately generic pass-through
 * actually behaves as intended, the same way session.test.ts pins down
 * state_update/spawn/hit_report's more involved behavior. They DO still have
 * independent server-side COUNT enforcement (sectorMirrorCounts in server.ts,
 * added after an internal security review found sector_mirror.objectCount was
 * purely self-reported and unenforced) -- the last group of tests below pins
 * that down specifically.
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

function sectorMirrorMessage(action: "begin" | "end", objectCount?: number) {
  return JSON.stringify({ v: 1, type: "sector_mirror", seq: 0, ts: Date.now(), action, ...(objectCount !== undefined ? { objectCount } : {}) });
}

test("sector_object is broadcast to other session members but not back to the sender", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("coop-1", "Alice"));
  b.send(joinMessage("coop-1", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let aReceivedSectorObject = false;
  a.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString());
    if (parsed.type === "sector_object") aReceivedSectorObject = true;
  });

  const received = once(b, "message");
  a.send(sectorObjectMessage("station-1"));
  const raw = await received;
  const parsed = JSON.parse((raw as Buffer).toString());
  assert.equal(parsed.type, "sector_object");
  assert.equal(parsed.objectId, "station-1");
  assert.equal(parsed.objectType, "station");

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(aReceivedSectorObject, false, "the sender must not receive its own sector_object back");

  a.close();
  b.close();
  wss.close();
});

test("sector_mirror begin/end are broadcast to other session members in order", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("coop-2", "Alice"));
  b.send(joinMessage("coop-2", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const receivedMessages: unknown[] = [];
  b.on("message", (raw) => receivedMessages.push(JSON.parse(raw.toString())));

  a.send(sectorMirrorMessage("begin", 3));
  a.send(sectorObjectMessage("station-1"));
  a.send(sectorMirrorMessage("end"));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const types = receivedMessages.map((m) => (m as { type: string }).type);
  assert.deepEqual(types, ["sector_mirror", "sector_object", "sector_mirror"]);
  assert.equal((receivedMessages[0] as { action: string }).action, "begin");
  assert.equal((receivedMessages[0] as { objectCount: number }).objectCount, 3);
  assert.equal((receivedMessages[2] as { action: string }).action, "end");

  a.close();
  b.close();
  wss.close();
});

test("sector_object from a client outside any session is dropped, not broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  b.send(joinMessage("coop-3", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(sectorObjectMessage("station-1"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false);

  a.close();
  b.close();
  wss.close();
});

test("a malformed sector_object (invalid objectType) is dropped, not broadcast", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open")]);

  a.send(joinMessage("coop-4", "Alice"));
  b.send(joinMessage("coop-4", "Bob"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let received = false;
  b.on("message", () => (received = true));
  a.send(
    JSON.stringify({
      v: 1,
      type: "sector_object",
      seq: 0,
      ts: Date.now(),
      objectId: "planet-1",
      objectType: "planet",
      macroName: "some_macro",
      position: { x: 0, y: 0, z: 0 },
      rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false);

  a.close();
  b.close();
  wss.close();
});

test("sector_object reaches every OTHER member of a 3-client session", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  const c = new WebSocket(`ws://localhost:${port}`);
  await Promise.all([once(a, "open"), once(b, "open"), once(c, "open")]);

  a.send(joinMessage("coop-5", "Alice"));
  b.send(joinMessage("coop-5", "Bob"));
  c.send(joinMessage("coop-5", "Carol"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const bReceived = once(b, "message");
  const cReceived = once(c, "message");
  a.send(sectorObjectMessage("gate-1"));
  const [bRaw, cRaw] = await Promise.all([bReceived, cReceived]);
  assert.equal(JSON.parse((bRaw as Buffer).toString()).objectId, "gate-1");
  assert.equal(JSON.parse((cRaw as Buffer).toString()).objectId, "gate-1");

  a.close();
  b.close();
  c.close();
  wss.close();
});

// --- Security review follow-up: sector_mirror.objectCount is self-reported and
// on its own enforces nothing (a client could claim "begin objectCount:1" and
// then send far more real sector_object messages) -- server.ts independently
// counts actual sector_object messages per client since their last "begin" and
// caps at MAX_SECTOR_OBJECTS_PER_MIRROR regardless of the claim.

test(
  `sector_object beyond MAX_SECTOR_OBJECTS_PER_MIRROR (${MAX_SECTOR_OBJECTS_PER_MIRROR}) is dropped for the rest of the current mirror, regardless of a smaller claimed objectCount`,
  { timeout: 30_000 },
  async () => {
    // A5's general rate limiter (default 60 capacity / 30 per second) would
    // otherwise throttle this test's deliberately large burst LONG before
    // MAX_SECTOR_OBJECTS_PER_MIRROR is reached, making it impossible to tell
    // "dropped by the general limiter" apart from "dropped by the C1 cap this
    // test is actually about" -- raised generously here so the sectorMirrorCounts
    // cap is the only thing being exercised.
    const { wss, port } = await startTestServer({
      generalRateLimit: { capacity: MAX_SECTOR_OBJECTS_PER_MIRROR + 500, refillPerSecond: MAX_SECTOR_OBJECTS_PER_MIRROR + 500 },
    });
    const a = new WebSocket(`ws://localhost:${port}`);
    const b = new WebSocket(`ws://localhost:${port}`);
    try {
      await Promise.all([once(a, "open"), once(b, "open")]);

      a.send(joinMessage("coop-cap-1", "Alice"));
      b.send(joinMessage("coop-cap-1", "Bob"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      let receivedCount = 0;
      b.on("message", (raw) => {
        if (JSON.parse(raw.toString()).type === "sector_object") receivedCount += 1;
      });

      a.send(sectorMirrorMessage("begin", 1)); // lies about the count on purpose
      for (let i = 0; i < MAX_SECTOR_OBJECTS_PER_MIRROR + 5; i += 1) {
        a.send(sectorObjectMessage(`obj-${i}`));
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));

      assert.equal(receivedCount, MAX_SECTOR_OBJECTS_PER_MIRROR, "exactly the cap's worth must be broadcast, not the claimed objectCount and not the full send count");
    } finally {
      // finally, not just trailing calls: an assertion failure above must not
      // leave this test's WebSocketServer/sockets open, which would otherwise
      // keep the whole `node --test` process alive indefinitely (an actual
      // incident during C1 review -- a failing early draft of this exact test
      // hung the full server test suite instead of just failing it).
      a.close();
      b.close();
      wss.close();
    }
  }
);

test("a fresh sector_mirror \"begin\" resets the per-client sector_object counter", async () => {
  const { wss, port } = await startTestServer();
  const a = new WebSocket(`ws://localhost:${port}`);
  const b = new WebSocket(`ws://localhost:${port}`);
  try {
    await Promise.all([once(a, "open"), once(b, "open")]);

    a.send(joinMessage("coop-cap-2", "Alice"));
    b.send(joinMessage("coop-cap-2", "Bob"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    let receivedCount = 0;
    b.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "sector_object") receivedCount += 1;
    });

    a.send(sectorMirrorMessage("begin", 2));
    a.send(sectorObjectMessage("first-mirror-obj-1"));
    a.send(sectorObjectMessage("first-mirror-obj-2"));
    a.send(sectorMirrorMessage("end"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A second, later mirror from the same client must not be constrained by
    // objects already counted against the FIRST mirror -- the counter is reset
    // by "begin", not accumulated forever per client.
    a.send(sectorMirrorMessage("begin", 2));
    a.send(sectorObjectMessage("second-mirror-obj-1"));
    a.send(sectorObjectMessage("second-mirror-obj-2"));
    a.send(sectorMirrorMessage("end"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(receivedCount, 4);
  } finally {
    a.close();
    b.close();
    wss.close();
  }
});
