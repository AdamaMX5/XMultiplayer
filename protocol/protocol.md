# XMultiplayer protocol v1

Wire format: one JSON object per message, newline-delimited (NDJSON) on the Named Pipe
(game <-> agent) and as individual text frames on the WebSocket (agent <-> relay server).
The relay server forwards messages verbatim between session members; it does not
transform payloads in A1 (it only inspects `type: "session"` messages for join/leave
bookkeeping).

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

## Size limit

`MAX_MESSAGE_BYTES` (`src/limits.ts`, currently 64 KiB) caps a single message.
`parseMessage` rejects anything larger outright; the same constant caps how large
`NdjsonSplitter` (agent) lets a buffered pipe line grow before dropping it, and is
passed as the relay server's WebSocket `maxPayload`. Without this cap a line that
never finds its terminating newline (or an oversized WebSocket frame) would grow a
receive buffer without bound -- enforcing the same limit at all three points closes
that resource-exhaustion gap uniformly across both transports.
