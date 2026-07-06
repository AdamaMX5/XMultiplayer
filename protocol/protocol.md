# XMultiplayer protocol v1

Wire format: one JSON object per message, newline-delimited (NDJSON) on the Named Pipe
(game <-> agent) and as individual text frames on the WebSocket (agent <-> relay server).
The relay server forwards messages verbatim between session members; besides
`type: "session"` (join/leave bookkeeping), it also inspects `type: "spawn"` since A2,
to replay previously spawned proxies to late joiners and to despawn a member's
proxies when they disconnect (see `server/src/sessionManager.ts`).

**Correlation:** a `spawn.objectId` and subsequent `state_update.shipId` for the same
ship must be the same value -- that's how a receiver matches an incoming position
update to the proxy it already created. The sending side is responsible for this
(both are set from the same underlying entity id on the mod side).

Every message carries an envelope:

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | Protocol version. Bump on breaking changes. |
| `seq` | number | Monotonically increasing per-sender sequence number. Used to detect gaps/reordering. |
| `ts` | number | Milliseconds epoch timestamp at send time (sender's clock, not game time). |
| `type` | string | Discriminator, one of the message types below. |

Rotation is represented as a quaternion (`qx`, `qy`, `qz`, `qw`), not Euler angles --
see the doc comment on `EnvelopeBase`/`StateUpdateMessage` in `src/messages.ts` for the
reasoning (gimbal lock and wrap-around avoidance for the A3 Dead Reckoning extrapolation).

## Message types

### `state_update`
**Direction:** game -> agent -> server -> other clients in the session.
**Purpose:** Periodic export of one ship's kinematic state (A1: the local player's own ship).

| Field | Type | Notes |
|---|---|---|
| `shipId` | string | Stable identifier for the ship (A1: the sending player's ship). |
| `position` | `{x,y,z}` | World-space position. |
| `rotation` | `{qx,qy,qz,qw}` | Orientation quaternion. |
| `velocity` | `{x,y,z}` | Velocity vector, world-space. |
| `mdRate` | number (optional) | MD's own measured tick rate in Hz for this cue, so receivers can distinguish network jitter from a slow MD tick (PlanMod.md 0.3). |

### `spawn`
**Direction:** server -> clients (A2+; type exists from A1 for forward compatibility).
**Purpose:** Announce a new remote object (typically a proxy ship for another player).

| Field | Type | Notes |
|---|---|---|
| `objectId` | string | Identifier for the new object. |
| `shipType` | string | Ship macro/type name. |
| `loadout` | string[] (optional) | Short-form loadout (weapon/equipment macro names). |
| `owner` | string | Owning player's identifier/name. |

### `despawn`
**Direction:** server -> clients.
**Purpose:** Announce removal of a previously spawned object.

| Field | Type | Notes |
|---|---|---|
| `objectId` | string | Identifier of the object to remove. |
| `reason` | string (optional) | Free-form reason (`"session_end"`, `"destroyed"`, `"disconnect"`, ...). |

### `hit_report`
**Direction:** client -> server (A4).
**Purpose:** Client-authoritative report of a hit registered locally against a proxy.

| Field | Type | Notes |
|---|---|---|
| `targetId` | string | Object that was hit. |
| `sourceId` | string | Object/weapon that caused the hit. |
| `damage` | number | Raw damage value, pre-mitigation. |
| `damageType` | `"hull"` \| `"shield"` | Which pool the damage applies to. |

### `hp_state`
**Direction:** server -> clients (A4).
**Purpose:** Authoritative HP state after the server resolves a `hit_report`.

| Field | Type | Notes |
|---|---|---|
| `objectId` | string | Object the state applies to. |
| `hull` | number | Current hull value. |
| `shield` | number | Current shield value. |

### `fire_event`
**Direction:** client -> server -> other clients (A4).
**Purpose:** Cosmetic-only weapon fire notification, to drive fake projectiles on proxies.
Actual damage is never derived from this message -- only from `hit_report`/`hp_state`.

| Field | Type | Notes |
|---|---|---|
| `sourceId` | string | Firing object. |
| `weapon` | string | Weapon macro name. |
| `origin` | `{x,y,z}` | Muzzle/origin position at fire time. |
| `direction` | `{x,y,z}` | Fire direction vector. |

### `session`
**Direction:** client <-> server.
**Purpose:** Join/leave/ready/countdown lifecycle for a session (lobby).

| Field | Type | Notes |
|---|---|---|
| `action` | `"join"` \| `"leave"` \| `"ready"` \| `"countdown"` | |
| `sessionCode` | string | Session/lobby identifier both players agree on out-of-band. |
| `playerName` | string (optional) | Display name, expected on `join`. |
| `countdownSeconds` | number (optional) | Only meaningful for `action === "countdown"`. |

### `chat`
**Direction:** client -> server -> other clients in the session.
**Purpose:** Plain text chat for coordination.

| Field | Type | Notes |
|---|---|---|
| `from` | string | Sender display name. |
| `text` | string | Message body, unescaped. |

## Validation

`parseMessage(json: string)` in `src/parse.ts` is the single source of truth for
validating incoming messages; both the agent and the relay server call it on every
line/frame they receive. It is hand-written (no `ajv`/schema library) because the
message set is small and stable. `schema/v1.json` mirrors the same shapes as a
JSON Schema for documentation/external tooling, but is not used at runtime.

## Canonical re-serialization (A3)

`serializeCanonical(msg)` in `src/canonical.ts` takes an already-`parseMessage`d
object and rebuilds its JSON from scratch: only the fields that message type
defines, in a fixed key order, nothing extra carried through. `parseMessage`
validates required fields exist and are the right type, but does not strip
unexpected additional properties -- `serializeCanonical` is what does that. The
agent uses it (not the original raw line) for everything it writes into the pipe
or caches for replay (`agent/src/pipeMessage.ts`, `agent/src/index.ts`), so that
what MD's string-based field extractor (`XMP_Arena_ExtractField`) ever sees is
built field-by-field from typed, validated data, never forwarded byte-for-byte
from another player (closes the "decoy field" concern raised in the A2 security
review, since a naive text search for `"name":` is only as trustworthy as the
byte layout of the string it's searching).

## Pipe-only fields (not part of this wire schema)

The agent appends `linkLatencyMs` (an estimated, clamped, and EWMA-smoothed
one-way transit delay per sender -- see `agent/src/latency.ts` and
`agent/src/latencyTracker.ts`) to `state_update` lines specifically when writing
them into the pipe (`agent/src/pipeMessage.ts`). This field only ever exists on
that one hop (agent -> pipe); it is not part of `StateUpdateMessage` above and
never crosses the WebSocket. MD reads it to backdate its extrapolation baseline
-- see `docs/A3-messprotokoll.md`.

## Size limit

`MAX_MESSAGE_BYTES` (`src/limits.ts`, currently 64 KiB) caps a single message.
`parseMessage` rejects anything larger outright; the same constant caps how large
`NdjsonSplitter` (agent) lets a buffered pipe line grow before dropping it, and is
passed as the relay server's WebSocket `maxPayload`. Without this cap a line that
never finds its terminating newline (or an oversized WebSocket frame) would grow a
receive buffer without bound -- enforcing the same limit at all three points closes
that resource-exhaustion gap uniformly across both transports.

## Ship macro whitelist (A2)

`SHIP_MACRO_WHITELIST`/`isKnownShipMacro` (`src/shipMacros.ts`) is a second,
independent check applied to `spawn.shipType` specifically: from A2 on, the
Server -> Agent -> MD direction carries data from another player, which the agent
treats as untrusted input. The agent rejects (logs + drops, does not write to the
pipe) any `spawn` whose `shipType` is not on this whitelist, and the simulator
(`agent/src/simulate.ts`) validates its own `--ship` value against it at startup
with a hard error rather than silently sending a bogus macro name into `create_ship`.

## JSON parsing in MD (known risk, documented fallback not yet implemented)

The Named Pipe stays JSON/NDJSON in both directions, including for `spawn`/
`despawn`/`state_update` going from the agent into the game. MD has no confirmed
native JSON-parsing capability; `mod/md/XMP_Arena.xml`'s `XMP_Arena_ExtractField`
cue is the single, isolated point standing in for whatever mechanism actually works
in-game. **Canonical description of the fallback plan (if it turns out MD cannot
parse JSON like this): `docs/A2-messprotokoll.md` section 1** -- two options (one
field per pipe write, or a `|`-delimited line format), decided only after the first
in-game test of `XMP_Arena_ExtractField`, not implemented yet either way.
