import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "../src/parse.js";
import { serializeCanonical } from "../src/canonical.js";
import { simulateMdExtractField } from "./helpers/mdExtractFieldSimulation.js";

const base = { v: 1 as const, seq: 1, ts: 1_720_000_000_000 };

test("strips unexpected extra top-level fields", () => {
  const withDecoy = {
    ...base,
    type: "spawn",
    objectId: "ship-1",
    shipType: "ship_arg_s_fighter_01_a_macro",
    owner: "Alice",
    __proto__evil: "ignored",
    injected: '","objectId":"FAKE',
  };
  const parsed = parseMessage(JSON.stringify(withDecoy));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const canonical = serializeCanonical(parsed.message);
  const roundTripped = JSON.parse(canonical);
  assert.deepEqual(Object.keys(roundTripped).sort(), ["objectId", "owner", "seq", "shipType", "ts", "type", "v"]);
  assert.equal(canonical.includes("injected"), false);
  assert.equal(canonical.includes("FAKE"), false);
});

test("key order is deterministic regardless of input field order", () => {
  const a = { type: "chat", from: "Alice", text: "hi", ...base };
  const b = { ...base, text: "hi", type: "chat", from: "Alice" };
  const parsedA = parseMessage(JSON.stringify(a));
  const parsedB = parseMessage(JSON.stringify(b));
  assert.equal(parsedA.ok, true);
  assert.equal(parsedB.ok, true);
  if (!parsedA.ok || !parsedB.ok) return;
  assert.equal(serializeCanonical(parsedA.message), serializeCanonical(parsedB.message));
});

test("roundtrip parse -> serialize -> parse is stable for every message type", () => {
  const samples: Record<string, unknown> = {
    state_update: {
      ...base,
      type: "state_update",
      shipId: "ship-1",
      position: { x: 1, y: 2, z: 3 },
      rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
      velocity: { x: 4, y: 5, z: 6 },
      mdRate: 9.8,
    },
    spawn: {
      ...base,
      type: "spawn",
      objectId: "ship-1",
      shipType: "ship_arg_s_fighter_01_a_macro",
      owner: "Alice",
      loadout: ["a", "b"],
      maxHull: 120,
      maxShield: 80,
    },
    despawn: { ...base, type: "despawn", objectId: "ship-1", reason: "disconnect" },
    hit_report: { ...base, type: "hit_report", targetId: "ship-1", sourceId: "ship-2", damage: 42, damageType: "shield" },
    hp_state: { ...base, type: "hp_state", objectId: "ship-1", hull: 100, shield: 50 },
    fire_event: { ...base, type: "fire_event", sourceId: "ship-1", weapon: "weapon_x", origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    session: { ...base, type: "session", action: "join", sessionCode: "arena-1", playerName: "Alice" },
    chat: { ...base, type: "chat", from: "Alice", text: "gg" },
  };

  for (const [type, sample] of Object.entries(samples)) {
    const firstParse = parseMessage(JSON.stringify(sample));
    assert.equal(firstParse.ok, true, `${type} should parse`);
    if (!firstParse.ok) continue;

    const canonical = serializeCanonical(firstParse.message);
    const secondParse = parseMessage(canonical);
    assert.equal(secondParse.ok, true, `${type} canonical form should re-parse`);
    if (!secondParse.ok) continue;

    assert.deepEqual(secondParse.message, firstParse.message, `${type} should be stable across a second roundtrip`);
    assert.equal(serializeCanonical(secondParse.message), canonical, `${type} canonical form should be a fixed point`);
  }
});

test("omits optional fields entirely when absent, rather than serializing them as null/undefined", () => {
  const parsed = parseMessage(JSON.stringify({ ...base, type: "despawn", objectId: "ship-1" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const canonical = serializeCanonical(parsed.message);
  assert.equal(canonical.includes("reason"), false);
});

test("spawn: maxHull/maxShield (A4) are included when present, omitted (not null) when absent", () => {
  const withBoth = parseMessage(
    JSON.stringify({
      ...base,
      type: "spawn",
      objectId: "ship-1",
      shipType: "ship_arg_s_fighter_01_a_macro",
      owner: "Alice",
      maxHull: 150,
      maxShield: 60,
    })
  );
  assert.equal(withBoth.ok, true);
  if (withBoth.ok) {
    const canonical = JSON.parse(serializeCanonical(withBoth.message));
    assert.equal(canonical.maxHull, 150);
    assert.equal(canonical.maxShield, 60);
  }

  const withNeither = parseMessage(
    JSON.stringify({ ...base, type: "spawn", objectId: "ship-1", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice" })
  );
  assert.equal(withNeither.ok, true);
  if (withNeither.ok) {
    const canonical = serializeCanonical(withNeither.message);
    assert.equal(canonical.includes("maxHull"), false);
    assert.equal(canonical.includes("maxShield"), false);
  }
});

test("session: includes both optional fields when both are present, neither when both are absent", () => {
  const withBoth = parseMessage(
    JSON.stringify({ ...base, type: "session", action: "countdown", sessionCode: "arena-1", playerName: "Alice", countdownSeconds: 3 })
  );
  assert.equal(withBoth.ok, true);
  if (withBoth.ok) {
    const canonical = serializeCanonical(withBoth.message);
    assert.deepEqual(JSON.parse(canonical), {
      v: 1,
      type: "session",
      seq: 1,
      ts: base.ts,
      action: "countdown",
      sessionCode: "arena-1",
      playerName: "Alice",
      countdownSeconds: 3,
    });
  }

  const withNeither = parseMessage(JSON.stringify({ ...base, type: "session", action: "leave", sessionCode: "arena-1" }));
  assert.equal(withNeither.ok, true);
  if (withNeither.ok) {
    const canonical = serializeCanonical(withNeither.message);
    assert.equal(canonical.includes("playerName"), false);
    assert.equal(canonical.includes("countdownSeconds"), false);
  }
});

// --- Security: does fixed key order actually neutralize the MD extractor decoy attack? ---
//
// mod/md/XMP_Arena.xml's XMP_Arena_ExtractField (the MD-side field reader) does not
// parse JSON -- it does a naive linear string search for the first `"<key>":` it can
// find, then reads until whatever ends the value. simulateMdExtractField (imported
// above, see tests/helpers/mdExtractFieldSimulation.ts -- extracted into its own file
// per the A4 review so it isn't buried in this one) reproduces that algorithm
// faithfully, including all three A3 fixes: (1) fall back to the brace position when
// no comma follows (last-field-in-object), (2) detect an object-valued field (its
// first character is '{') and search only for the matching '}', never a comma
// (nested position/rotation/velocity), and (3) only quote-strip the scalar branch's
// result -- the object branch's span is returned exactly as captured, so its own
// nested "key": quotes survive for the sub-extraction that reads x/y/z etc. back out
// of it. See the cue's own header comment in XMP_Arena.xml for the full write-up.

test("a decoy \"type\" pattern embedded inside a legitimate string field can never reach the MD extractor unescaped", () => {
  // Attack shape from the A2 security review: a field value engineered to contain a
  // syntactically-plausible fake message inside it, e.g. an "owner" that reads like
  // it re-opens the object with a different type and objectId. The value below is
  // what the attacker wants `parsed.message.owner` to end up containing in memory --
  // literal, unescaped quotes -- which is why it has to be JSON.stringify'd here
  // (exactly like a real attacker's wire bytes would have to escape those quotes to
  // be valid JSON at all).
  const attack = {
    ...base,
    type: "spawn",
    objectId: "victim-ship",
    shipType: "ship_arg_s_fighter_01_a_macro",
    owner: 'Alice","type":"despawn","objectId":"victim-ship',
  };
  const parsed = parseMessage(JSON.stringify(attack));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  // Confirm the attack payload really was accepted and preserved as data in memory
  // (parseMessage doesn't and shouldn't reject an owner name just for containing
  // quote characters -- it's an opaque display string).
  assert.equal(parsed.message.type, "spawn");
  if (parsed.message.type === "spawn") {
    assert.equal(parsed.message.owner, 'Alice","type":"despawn","objectId":"victim-ship');
  }

  const canonical = serializeCanonical(parsed.message);
  // The actual defense mechanism, confirmed here: serializeCanonical re-serializes
  // via JSON.stringify, which always properly escapes embedded quotes in a string
  // value. So the decoy's `"type":"despawn"` can *only* ever appear in its escaped
  // form (`\"type\":\"despawn\"`) in the wire bytes MD receives -- never as the bare,
  // unescaped substring XMP_Arena_ExtractField's find_string searches for. This is a
  // stronger guarantee than key ordering alone: it holds regardless of where in the
  // object the decoy-carrying field sits.
  assert.equal(canonical.includes('"type":"despawn"'), false, "the unescaped decoy pattern must never appear in the wire bytes");
  assert.ok(canonical.includes('\\"type\\":\\"despawn\\"'), "the decoy content is preserved, but only in its escaped (inert) form");

  // And, as defense in depth, the extractor also recovers the REAL type/objectId
  // regardless: serializeCanonical always emits `type` before any string field that
  // could carry attacker-controlled content.
  const extractedType = simulateMdExtractField(canonical, "type");
  assert.equal(extractedType.value, "spawn");

  const extractedObjectId = simulateMdExtractField(canonical, "objectId");
  assert.equal(extractedObjectId.value, "victim-ship");
});

test("FIXED (A3 review round 2): extracting the last field before '}' no longer computes an invalid end index", () => {
  const parsed = parseMessage(
    JSON.stringify({ ...base, type: "spawn", objectId: "ship-1", shipType: "ship_arg_s_fighter_01_a_macro", owner: "Alice" })
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const canonical = serializeCanonical(parsed.message);

  // `owner` is the last key in the spawn schema (see canonical.ts): there is no
  // comma after its value before the closing brace, only `}`. The cue now checks
  // for commaPos == -1 explicitly and falls back to bracePos in that case, instead
  // of feeding the -1 "not found" sentinel into min() as if it were a real position.
  const result = simulateMdExtractField(canonical, "owner");
  assert.notEqual(result.endIndex, -1, "the last-field fix must produce a real end index, not the -1 sentinel");
  assert.equal(result.value, "Alice");
});

test(
  "FIXED (A3 review round 2): the object-branch span keeps its nested keys' quotes, " +
    "so sub-extracting x/y/z out of position/rotation/velocity works",
  () => {
    const parsed = parseMessage(
      JSON.stringify({
        ...base,
        type: "state_update",
        shipId: "ship-1",
        position: { x: 10, y: 20, z: 30 },
        rotation: { qx: 0.1, qy: 0.2, qz: 0.3, qw: 0.9 },
        velocity: { x: 1, y: 2, z: 3 },
      })
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const canonical = serializeCanonical(parsed.message);

    // Step 1: capture the exact, complete nested object including its own closing
    // brace, quotes intact (the quote-strip no longer runs on the object branch).
    const position = simulateMdExtractField(canonical, "position");
    assert.equal(
      position.value,
      '{"x":10,"y":20,"z":30}',
      "the object branch must return the span verbatim -- no quote-stripping -- so nested keys stay quoted"
    );

    // Step 2: XMP_Arena_HandleStateUpdate re-uses this same cue against the captured
    // span to pull out x/y/z. Its needle is always a QUOTED key ("x":), so it now
    // finds it correctly.
    const x = simulateMdExtractField(position.value!, "x");
    assert.equal(x.found, true);
    assert.equal(x.value, "10");

    // Same for rotation's qw and velocity's z -- this isn't specific to position,
    // it's every object-valued field, i.e. 100% of the data Dead Reckoning needs.
    const rotation = simulateMdExtractField(canonical, "rotation");
    assert.equal(simulateMdExtractField(rotation.value!, "qw").value, "0.9");
    const velocity = simulateMdExtractField(canonical, "velocity");
    assert.equal(simulateMdExtractField(velocity.value!, "z").value, "3");
  }
);

// The team lead's specific worry: does a display-name-like string VALUE that
// happens to contain a literal '{' character get misdetected as a nested object?
test("a string field whose VALUE starts with a literal '{' is never misdetected as a nested object", () => {
  // Deliberately no matching '}' inside the value here, to isolate the ONE thing
  // this test is about (object-detection false positives) from a separate, adjacent
  // issue this uncovered: a string value containing a literal '}' or ',' confuses
  // the end-boundary search regardless of branch, since neither branch is aware of
  // quoted-string boundaries. That second issue is pre-existing (true since A2's
  // original extractor too, not introduced by this round's fixes) and is
  // demonstrated separately below.
  const parsed = parseMessage(
    JSON.stringify({ ...base, type: "spawn", objectId: "ship-1", shipType: "ship_arg_s_fighter_01_a_macro", owner: "{CoolClan Alice" })
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const canonical = serializeCanonical(parsed.message);

  // The object-detection check looks at the character immediately after the colon,
  // which for ANY JSON string value is always the opening quote (") -- never the
  // string's own first content character -- so this can't false-positive as an
  // object regardless of what the string contains.
  const result = simulateMdExtractField(canonical, "owner");
  assert.equal(result.value, "{CoolClan Alice", "the literal '{' inside the string value must not trigger the object-extraction path");
});

// Pre-existing (not new to this round) but worth pinning down precisely: a string
// value containing a literal '}' breaks extraction, because the naive end-boundary
// search has no concept of quoted-string content -- it just finds the first '}' or
// ',' character anywhere after the value start, whether or not it's actually inside
// the string being extracted.
test(
  "PLAUSIBLE, pre-existing gap: a string value containing a literal '}' truncates extraction early " +
    "(not introduced by this round -- the naive scanner has never been quote-aware)",
  () => {
    const parsed = parseMessage(
      JSON.stringify({ ...base, type: "spawn", objectId: "ship-1", shipType: "ship_arg_s_fighter_01_a_macro", owner: "{CoolClan} Alice" })
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const canonical = serializeCanonical(parsed.message);

    const result = simulateMdExtractField(canonical, "owner");
    assert.notEqual(result.value, "{CoolClan} Alice", "demonstrates the truncation: the literal '}' inside the value is mistaken for the field's own end");
    assert.equal(result.value, "{CoolClan", "truncated right before the embedded '}'");
  }
);

test("full field-by-field extraction of a real state_update line: scalar fields and every nested vector field all work", () => {
  const original = {
    ...base,
    type: "state_update" as const,
    shipId: "ship-1",
    position: { x: 111.5, y: -22.25, z: 3 },
    rotation: { qx: 0, qy: 0.5, qz: 0, qw: 0.8660254 },
    velocity: { x: -4, y: 0, z: 8.5 },
    mdRate: 9.9,
  };
  const parsed = parseMessage(JSON.stringify(original));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const canonical = serializeCanonical(parsed.message);
  // linkLatencyMs is appended after serializeCanonical by agent/src/pipeMessage.ts,
  // always as the line's last field -- reproduced here without importing the agent
  // package (protocol has no dependency on agent).
  const line = JSON.stringify({ ...JSON.parse(canonical), linkLatencyMs: 42 });

  // Scalar top-level fields, including the true last-field-in-the-whole-line case
  // (linkLatencyMs): the last-field fix (bug 1).
  assert.equal(simulateMdExtractField(line, "shipId").value, "ship-1");
  assert.equal(simulateMdExtractField(line, "mdRate").value, "9.9");
  assert.equal(simulateMdExtractField(line, "linkLatencyMs").value, "42", "last field of the whole line must still extract correctly");

  // Every nested vector field (the entire payload Dead Reckoning actually needs):
  // the object-detection fix (bug 2) plus the scalar-only quote-strip fix (bug 3)
  // together mean the full round-trip now recovers every component correctly.
  function extractVectorField(objectFieldName: string, subField: string) {
    const outer = simulateMdExtractField(line, objectFieldName).value!;
    return simulateMdExtractField(outer, subField);
  }
  assert.equal(extractVectorField("position", "x").value, "111.5");
  assert.equal(extractVectorField("position", "y").value, "-22.25");
  assert.equal(extractVectorField("position", "z").value, "3");
  assert.equal(extractVectorField("rotation", "qw").value, "0.8660254");
  assert.equal(extractVectorField("velocity", "z").value, "8.5");
});

// A4 review requirement: the new hit_report/hp_state extractions used by
// mod/md/XMP_Arena.xml's XMP_Arena_OnProxyAttacked and XMP_Arena_HandleHpState must
// be exercised against the same Node mirror as state_update was above, not just
// asserted to "probably work" by analogy.

test("full field-by-field extraction of a real hit_report line", () => {
  const original = {
    ...base,
    type: "hit_report" as const,
    targetId: "ship-victim",
    sourceId: "ship-attacker",
    damage: 42.5,
    damageType: "shield" as const,
  };
  const parsed = parseMessage(JSON.stringify(original));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const line = serializeCanonical(parsed.message);

  assert.equal(simulateMdExtractField(line, "targetId").value, "ship-victim");
  assert.equal(simulateMdExtractField(line, "sourceId").value, "ship-attacker");
  assert.equal(simulateMdExtractField(line, "damage").value, "42.5");
  // damageType is the last field in the hit_report schema (canonical.ts) -- exercises
  // the last-field fix (bug 1) for this message type specifically.
  assert.equal(simulateMdExtractField(line, "damageType").value, "shield", "last field of the line must still extract correctly");
});

test("full field-by-field extraction of a real hp_state line, including hull/shield of exactly 0", () => {
  const original = { ...base, type: "hp_state" as const, objectId: "ship-victim", hull: 0, shield: 0 };
  const parsed = parseMessage(JSON.stringify(original));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const line = serializeCanonical(parsed.message);

  assert.equal(simulateMdExtractField(line, "objectId").value, "ship-victim");
  assert.equal(simulateMdExtractField(line, "hull").value, "0");
  // shield is the last field in the hp_state schema -- same last-field concern as
  // above, plus specifically checking that a value of "0" (not a truthy-looking
  // number) doesn't trip up the "not found" (-1) sentinel handling from bug 1.
  assert.equal(simulateMdExtractField(line, "shield").value, "0", "a zero value must not be confused with the not-found sentinel");
});
