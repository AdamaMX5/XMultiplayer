# XMultiplayer protocol v1

Wire format: one JSON object per message, newline-delimited (NDJSON) on the Named Pipe
(game <-> agent) and as individual text frames on the WebSocket (agent <-> relay server).
The relay server forwards most messages verbatim between session members; besides
`type: "session"` (join/leave bookkeeping), it also inspects `type: "spawn"` since A2,
to replay previously spawned proxies to late joiners and to despawn a member's
proxies when they disconnect (see `server/src/sessionManager.ts`). Since A4 it is also
the HP authority (see below): `type: "hit_report"` is the one message type that is
never forwarded raw -- it is consumed entirely server-side and turned into an
`hp_state` broadcast instead (see `server/src/hpTracker.ts`).

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
**Direction:** game -> agent -> server -> other clients in the session. Since A4 the
server only accepts/forwards a `state_update` whose `shipId` the sender actually
owns (rejects both spoofed IDs belonging to someone else and orphaned IDs with no
recorded spawn at all); separately, the AGENT (not the server) also rejects one
whose `position`/`velocity` fall outside plausible bounds before it ever reaches the
pipe (`protocol/src/arenaBounds.ts`, `decideRelay`).
**Purpose:** Periodic export of one ship's kinematic state (A1: the local player's own ship).

| Field | Type | Notes |
|---|---|---|
| `shipId` | string | Stable identifier for the ship (A1: the sending player's ship). |
| `position` | `{x,y,z}` | World-space position. Agent-side sanity bound: `ARENA_BOUNDS_METERS` (`protocol/src/arenaBounds.ts`). |
| `rotation` | `{qx,qy,qz,qw}` | Orientation quaternion. |
| `velocity` | `{x,y,z}` | Velocity vector, world-space. Agent-side sanity bound: `MAX_VELOCITY_MPS`. |
| `mdRate` | number (optional) | MD's own measured tick rate in Hz for this cue, so receivers can distinguish network jitter from a slow MD tick (PlanMod.md 0.3). |

### `spawn`
**Direction:** client -> server -> other clients (A2+; type exists from A1 for forward
compatibility). Since A4, the server also enforces ownership here: a client may only
spawn an `objectId` nobody else already owns (re-spawning your OWN previous
`objectId` is fine and replaces it, see `despawn`/session lifecycle), and only one
active spawn per client at a time (a second, *different* `objectId` is rejected --
respawn by re-sending the SAME `objectId` instead).
**Purpose:** Announce a new remote object (typically a proxy ship for another player).

| Field | Type | Notes |
|---|---|---|
| `objectId` | string | Identifier for the new object. |
| `shipType` | string | Ship macro/type name. |
| `loadout` | string[] (optional) | Short-form loadout (weapon/equipment macro names). |
| `owner` | string | Owning player's identifier/name. |
| `maxHull` | number (optional, A4) | Starting hull for the server's HP authority (`server/src/hpTracker.ts`). Falls back to `DEFAULT_HULL` (`src/combat.ts`) if absent. |
| `maxShield` | number (optional, A4) | Starting shield, same fallback pattern (`DEFAULT_SHIELD`). |

**maxHull/maxShield, from A5 on:** `mod/md/XMP_Arena.xml`'s `XMP_Arena_OnEnterSector`
(fired when the player enters the Arena sector, replacing A1-A4's
`XMP_Arena_AnnounceSpawn`, which spawned unconditionally at connect time
regardless of location) sends the ship's actual `player.entity.hullmax`/
`shieldmax` rather than a fixed constant -- so different ship types genuinely do
start combat with different HP now, at least in principle. This is still one of
the least-confirmed assumptions in the whole mod (see
`docs/A5-messprotokoll.md`): X4 may expose hull/shield as a 0..1 fraction rather
than absolute points in other contexts, which this cue does not convert. Loadout
(`spawn.loadout`) is NOT populated yet -- enumerating equipped weapons needs an
assumed collection-iteration API with no existing pattern elsewhere in this
codebase to anchor a guess on, so it's deferred rather than risk breaking the
whole spawn sequence on a wrong guess (see `docs/A5-messprotokoll.md` for what to
try once the real weapon-enumeration API is confirmed in-game). `DEFAULT_HULL`/
`DEFAULT_SHIELD` remain the server-side fallback if `maxHull`/`maxShield` are
ever absent (e.g. an older sender, or these fields turning out to need to be
omitted after all).

### `despawn`
**Direction:** server -> clients (disconnect, or a server-triggered destruction,
see `hp_state` below) OR, since A5, client -> server -> other clients (the mod
sends one itself when the player leaves the Arena sector,
`XMP_Arena_OnExitSector`, `reason: "left_sector"`). Either way the server only
accepts and forwards a client-sent one if the sender actually owns that
`objectId` (A4 ownership authority, same check as `state_update`/`fire_event`
below).
**Purpose:** Announce removal of a previously spawned object.

| Field | Type | Notes |
|---|---|---|
| `objectId` | string | Identifier of the object to remove. |
| `reason` | string (optional) | Free-form reason (`"session_end"`, `"destroyed"`, `"disconnect"`, `"left_sector"` (A5), ...). |

### `hit_report`
**Direction:** client -> server only (A4). Never forwarded to other clients raw --
see `hp_state` below for what they receive instead.
**Purpose:** Client-detected report of a hit registered locally against a proxy. This
is the client-side hit *detection* PlanMod.md A4 calls out as a known, accepted
weakness: at latencies above ~100ms a target can visibly be "hit around a corner"
that no longer matches its position in the reporting client's own game.

| Field | Type | Notes |
|---|---|---|
| `targetId` | string | Object that was hit. Naturally NOT owned by the sender (you report hits on someone else's ship) -- the one field in this message the ownership check does not apply to. |
| `sourceId` | string | Object/weapon that caused the hit. Must be owned by the sender; a `hit_report` claiming a `sourceId` you don't own is rejected server-side (A4 ownership authority). |
| `damage` | number | Raw, untrusted damage value, pre-mitigation. Must be a finite, strictly positive number (`isValidDamageClaim`, `src/hpTracker.ts`) -- zero, negative (which would otherwise silently *heal* the target, since regeneration does not exist in v1), or non-finite values are rejected outright, before the value is even clamped. Passing that check, it is further clamped to `MAX_DAMAGE_PER_HIT` (`src/combat.ts`, currently 1000) so a single hit_report can never claim to instantly destroy an arbitrarily healthy ship. |
| `damageType` | `"hull"` \| `"shield"` | Resolution rule (A4): `"shield"` damage is absorbed by the shield pool first, with any leftover ("overflow") spilling into hull once the shield is fully depleted -- the normal case for most weapon fire. `"hull"` damage bypasses the shield pool entirely and always applies straight to hull, representing a hull-piercing/shield-ignoring hit. See `docs/A4-messprotokoll.md` section 1 for the reasoning behind this split. |

### `hp_state`
**Direction:** server -> clients (A4).
**Purpose:** Authoritative HP state after the server resolves a `hit_report`. Sent to
every session member, including whoever sent the `hit_report` (the attacker needs the
confirmed outcome too, not just the victim). A freshly spawned object starts at
`DEFAULT_HULL`/`DEFAULT_SHIELD` (`src/combat.ts`, currently 100/100 for every ship
type -- a deliberate V1 simplification, see `docs/A4-messprotokoll.md` section 1).
`hull` reaching 0 additionally triggers a `despawn` (`reason: "destroyed"`) for the
same `objectId`, since a destroyed ship is also no longer a valid spawn to replay to
late joiners.

| Field | Type | Notes |
|---|---|---|
| `objectId` | string | Object the state applies to. |
| `hull` | number | Current hull value, never negative (clamped at 0 server-side). |
| `shield` | number | Current shield value, never negative (clamped at 0 server-side). |

### `fire_event`
**Direction:** client -> server -> other clients (A4). `sourceId` must be owned by
the sender (A4 ownership authority), same rule as `state_update`/`despawn`.
**Purpose:** Cosmetic-only weapon fire notification, to drive fake projectiles on proxies.
Actual damage is never derived from this message -- only from `hit_report`/`hp_state`.

| Field | Type | Notes |
|---|---|---|
| `sourceId` | string | Firing object. |
| `weapon` | string | Weapon macro name. |
| `origin` | `{x,y,z}` | Muzzle/origin position at fire time. |
| `direction` | `{x,y,z}` | Fire direction vector. |

## Server-side validation (trust boundary), summary

Every field above documents its own specific check; this is just the index. Since
A2, the server treats every client-supplied message as untrusted input, not merely
data to relay; A4 substantially expands that:

| Check | Where | Rejects |
|---|---|---|
| Ship macro whitelist | `agent/src/relayFilter.ts` (`decideRelay`) AND `server/src/server.ts` (A5: closes a gap where only the agent checked this) | `spawn` with a `shipType` outside `SHIP_MACRO_WHITELIST`. |
| Ship class rule preset (A5) | `server/src/shipClassPolicy.ts` (`isShipClassAllowed`), `--ships`/`XMP_SHIPS` | `spawn` with a `shipType` whose class isn't in the configured preset (`s`\|`m`\|`sm`\|`all`). |
| Arena position/velocity bounds | `agent/src/relayFilter.ts` (`decideRelay`) AND `server/src/server.ts` (A5: same gap-closing rationale as the whitelist above), `protocol/src/arenaBounds.ts` | `state_update` with an implausible position or velocity. |
| Orphan filter | `agent/src/relayFilter.ts` (`decideRelay`) | `state_update`/`hit_report` for a `shipId`/`targetId` with no known spawn -- also what keeps the agent's `LatencyTracker` map bounded. |
| Ownership authority | `server/src/server.ts` (`requireOwnership`), `server/src/sessionManager.ts` (`ownerOf`) | `spawn`/`state_update`/`despawn`/`fire_event` referencing an `objectId` the sender does not own. |
| Spawn cap | `server/src/sessionManager.ts` (`hasOtherActiveSpawn`) | A second, different `objectId` spawned by a client that already has one active. |
| Respawn gate (A5) | `server/src/server.ts` | A `spawn` for an `objectId` the sender STILL actively owns (not yet destroyed/despawned) -- closes a free, unlimited self-heal (`hp.register()` resets HP unconditionally). |
| Damage validation | `server/src/hpTracker.ts` (`isValidDamageClaim`, `clampDamage`) | Non-finite, zero, or negative `damage`; clamps anything above `MAX_DAMAGE_PER_HIT`. |
| Message size | `protocol/src/parse.ts`, `agent/src/ndjson.ts`, the relay's `maxPayload` | Any message over `MAX_MESSAGE_BYTES`. |
| Per-client rate limit (A5) | `server/src/rateLimiter.ts` (`TokenBucket`) | Any message beyond the general per-client rate; `hit_report` additionally has its own, tighter limit on top. |
| Connection/session limits (A5) | `server/src/server.ts` | A new WebSocket connection beyond `maxConnections`/`maxConnectionsPerIp`; a `session` `join` that would create a new session beyond `maxSessions` (joining an EXISTING session is never affected). |
| Session-code entropy (A5, `--public`/`XMP_PUBLIC`) | `server/src/server.ts` (`isSessionCodeAllowedInPublicMode`) | In public mode only: the LAN default `"arena"`, or any `sessionCode` shorter than `MIN_PUBLIC_SESSION_CODE_LENGTH` (12). |
| String sanitizing (A5) | `protocol/src/sanitize.ts`, `server/src/server.ts` (logging + broadcast), `agent/src/pipeSanitize.ts` (pipe-bound, additionally strips `{`/`}`/`,` to protect MD's field extractor) | Control characters and excess length in `playerName`/`chat.from`/`chat.text` -- sanitized, not rejected outright. |

See `docs/A4-messprotokoll.md`/`docs/A5-messprotokoll.md` for the reasoning behind each addition.

### `session`
**Direction:** client <-> server.
**Purpose:** Join/leave lifecycle for a session. Since A5 ("Drop-in-Arena statt
Lobby", explicit developer decision) there is no lobby, ready-check, or
countdown UI: `join`/`leave` are sent automatically by the mod when it detects
the player entering/leaving the Arena sector (`XMP_Arena_OnEnterSector`/
`XMP_Arena_OnExitSector`), never from a player-facing dialog. `"ready"`/
`"countdown"` remain in the type for now but are unused/vestigial -- nothing
sends or handles them -- rather than a breaking removal of a wire type that
cost nothing to leave in place. A client-sent `leave` is fully processed
server-side (not just rebroadcast): it removes session membership and despawns/
forgets HP for whatever that client had spawned, exactly like a disconnect does
(A5 review fix, `server/src/server.ts`'s `leaveSession`).

| Field | Type | Notes |
|---|---|---|
| `action` | `"join"` \| `"leave"` \| `"ready"` \| `"countdown"` \| `"seta_on"` \| `"seta_off"` \| `"sector_change"` | `"seta_on"`/`"seta_off"` (A5): broadcast when the local player's SETA/time-acceleration state changes, so others freeze/thaw that player's proxy (`mod/md/XMP_Arena.xml`'s `XMP_Arena_HandleSetaStatus`). `"sector_change"` (C5): broadcast when the local player's own sector changes (e.g. a gate transit) during an active Coop session -- other members re-export their own current sector to the mover (same reaction as a fresh `join`, `mod/md/XMP_Coop.xml`'s `XMP_Coop_HandleSessionJoin`), while the mover tears down its own stale sector mirror and NPC bubble locally (`XMP_Coop_SectorChangeCheck`). See `docs/A5-messprotokoll.md`/`docs/C5-messprotokoll.md`. |
| `sessionCode` | string | Session identifier both sides agree on; `"arena"` is the LAN default both the agent (`agent/src/config.ts`) and the mod (`XMP_Arena_OnEnterSector`) fall back to when nothing else overrides it. |
| `playerName` | string (optional) | Display name, expected on `join`. |
| `countdownSeconds` | number (optional) | Unused/vestigial, see above. |

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
