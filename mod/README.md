# XMultiplayer mod (X4: Foundations extension)

Milestone A1: exports the player ship's telemetry (position, rotation, velocity)
over a Windows Named Pipe, at a target rate of 10 Hz, for the external agent/relay
chain described in `docs/PlanMod.md` (`md/XMP_Telemetry.xml`).

Milestone A2: a dedicated Arena galaxy/sector/gamestart (`libraries/clusters.xml`,
`sectors.xml`, `zones.xml`, `galaxy.xml`, `gamestarts.xml`, `t/0001-L044.xml`) with
no factions/jobs/economy, plus proxy spawn/despawn and naive teleport-on-update for
remote players (`md/XMP_Arena.xml`).

Milestone A3: replaces the naive per-update teleport with Dead Reckoning --
`aiscripts/XMP.ProxyPilot.xml` continuously flies each proxy toward an
extrapolated target (last known position + velocity x elapsed time) with the
engine's own flight controller and collision avoidance, only hard-teleporting
("snapping") when the deviation from a fresh update is too large, or stopping
entirely if no update has arrived for too long. Tuning knobs (extrapolation
horizon, snap threshold, update timeout, retarget interval) are centralized in
`XMP_Arena_TuningDefaults` (`md/XMP_Arena.xml`). The agent estimates one-way link
latency per message and folds it into the extrapolation baseline, and now
re-serializes every relay message canonically (only known fields, fixed order)
before it ever reaches the pipe -- see `protocol/protocol.md` and
`docs/A3-messprotokoll.md`.

Milestone A4: combat. Proxies are set locally invulnerable
(`set_object_invulnerable`) and never resolve damage themselves -- a local hit is
only ever *detected* (`event_object_attacked`, assumed) and reported to the server
as `hit_report`; the server is the sole HP authority and broadcasts the resolved
`hp_state` back to everyone, including the attacker (`server/src/hpTracker.ts`).
Clients apply `hp_state` to whichever local representation they have: the real
ship if it's their own (`set_object_hull`/`set_object_shield`), or just a tracked
display value on an invulnerable proxy. `fire_event` drives a purely cosmetic
fake-projectile effect (`fire_weapon_cosmetic`) with no damage component. A hull of
0 triggers a real destruction sequence (`destroy_object ... explosion="true"`) on
both sides, distinct from a silent disconnect despawn. `spawn` also carries optional
`maxHull`/`maxShield` so the server's HP authority can start a ship at the same
values the mod considers "full health" instead of a hardcoded fallback. See
`docs/A4-messprotokoll.md` for the full list of new assumptions and, importantly,
the **known and explicitly accepted weakness**: hit detection is client-side, so a
target can visibly be "hit around a corner" at higher latencies -- there is no
server-side lag compensation.

A4's second review round added several anti-cheat hardening measures on the
Node side (no mod changes): the server now enforces that a client can only
spawn/update/despawn/fire an `objectId` it actually owns, caps each client to one
active spawn at a time, and validates `hit_report`'s `damage` is a positive,
finite number before clamping it; the agent separately rejects a `state_update`
whose position/velocity fall outside plausible Arena bounds, and drops
`state_update`/`hit_report` for any `shipId`/`targetId` it has no known spawn for
(keeping its `LatencyTracker` bounded). None of this needs a mod change since it
all happens server/agent-side against the existing wire format -- see
`protocol/protocol.md`'s "Server-side validation" section for the full list.

Milestone A5: "Drop-in-Arena" instead of a lobby -- explicit developer decision,
no ready-check/countdown/session-code dialog at all. `XMP_Arena_PresenceLoop`
polls `player.sector` once a second; entering the Arena sector sends a real
`session` join plus a `spawn` built from the player's ACTUAL ship
(`player.entity.macro.name`, `hullmax`/`shieldmax`), replacing A1-A4's
unconditional-at-connect-time `XMP_Arena_AnnounceSpawn`; leaving it despawns and
leaves the session. The agent mirrors this: it only still auto-joins at connect
time when given an explicit `--session`/`XMP_SESSION` override (simulator/e2e/
manual use); otherwise it waits for the mod's own join, and restores session
membership (plus its own spawn) automatically after a relay reconnect
(`agent/src/sessionState.ts`). The server now also builds a kill-feed `chat`
message on every combat destruction, enforces a configurable ship-class rule
preset (`--ships s|m|sm|all`) on top of the existing macro whitelist -- which it
now also checks itself, closing a gap where only the agent ever did -- and
detects the local player's own SETA (time acceleration) to tell the other side
to freeze that player's proxy (`XMP.ProxyPilot.xml`'s `$XMP_Frozen`) rather than
extrapolate through a broken time-scale assumption. Three additional map variants
(asteroid field, debris field, nebula) ship as their own gamestarts. See
`docs/A5-messprotokoll.md` for the full assumption list, including two
explicitly **deferred, not-yet-attempted** items: real weapon-loadout
enumeration and true pause detection (reasoned to likely be infeasible via MD
polling at all, see that doc's section 8).

Milestone C1 (PlanMod.md Phase 2, "Statischer Sektor-Mirror" -- the first
milestone of the Coop-in-the-host's-universe track, `docs/C1-messprotokoll.md`):
a new `md/XMP_Coop.xml`, plugged into `XMP_Arena.xml`'s existing dispatch via
three new branches. Whenever ANY session member's `session` `join` is received,
every OTHER member walks its OWN current `player.sector` (stations, gates,
asteroid fields, regions) and exports it once as a burst of `sector_object`
messages bracketed by `sector_mirror` begin/end; the receiving side spawns each
as a static, non-piloted placeholder. Deliberately symmetric, not host/guest --
this protocol and server have no such distinction anywhere, so a member with
nothing of interest in its own sector (the Arena, or an empty sector) simply
exports zero objects. The new message types (`protocol/src/messages.ts`) have
no per-object ownership model server-side (static scenery has no "owner" the
way a player's ship does), so `server/src/server.ts` needed no new branch, only
a comment documenting that the existing generic broadcast fallthrough is
deliberate. See `docs/C1-messprotokoll.md` for the full, and for this milestone
unusually large, list of open assumptions -- most notably that this is the
first milestone needing to enumerate a COLLECTION of sector objects (rather
than read the player's own ship or a single scalar), for which no prior
pattern existed anywhere in this codebase.

Milestone C2 (PlanMod.md Phase 2, "Host-Schiff als dynamisches Objekt =
Arena-Code wiederverwendet", `docs/C2-messprotokoll.md`): mirrors each session
member's own real ship to the others, reusing `XMP_Arena_HandleSpawn`/
`HandleDespawn`/`HandleStateUpdate`/`aiscripts/XMP.ProxyPilot.xml` completely
unchanged -- they already handle any `spawn`/`despawn`/`state_update`
generically regardless of what triggered it, and `XMP_Telemetry_Tick` already
streams unconditionally. The one genuinely new piece: Coop sessions are joined
via the agent's explicit `session` CLI flag/`XMP_SESSION` override (A5), a
join that goes straight to the relay server over WebSocket and never
otherwise reaches MD -- so `agent/src/index.ts` now loops that join back into
the local pipe too (covering both connection orderings, game-before-agent and
agent-before-game, exactly once per WebSocket connection), and
`XMP_Coop_HandleSessionJoin` (`md/XMP_Coop.xml`) now tells its own looped-back
join apart from a real remote one (`playerName == player.name`) to announce
its own ship exactly once. This loopback is the one part of C2 that IS
end-to-end VERIFIED, not just PLAUSIBLE (`agent/tests/relayToPipe.e2e.test.ts`
spawns the real agent process and observes it over a real pipe/WebSocket).

**Status: PLAUSIBLE, not VERIFIED (mod side); the server/agent-side logic IS
VERIFIED** (real `node:test` tests throughout `server/tests/` and
`agent/tests/`, including a real spawned-process end-to-end test for the C2
join loopback). This extension has not been loaded or run inside X4 (no game
installation available in this development environment). The XML is checked to
be syntactically valid, but the Mission Director/AI-script semantics (cue
timing, the exact SirNukes Named_Pipes API surface, whether MD can parse a
received JSON string at all, the `<aiscript>` root shape, `move.to.position`, and
`object.blackboard` as the MD/AI-script data channel from A3, whether
`event_object_attacked`/`event_object_fired` exist as assumed (A4), whether
`player.sector`/`player.entity.hullmax`/`player.timewarp` exist as assumed
(A5), whether a `find_object`-style sector enumeration and `create_station`-style
placeholder placement exist as assumed (C1), and now -- C2 -- whether
`XMP_Coop_HandleSessionJoin`'s `playerName == player.name` self-detection
actually distinguishes a looped-back own join from a real remote one the way
assumed) are assumptions documented inline in `md/XMP_Telemetry.xml`/`md/XMP_Arena.xml`/
`md/XMP_Coop.xml`/`aiscripts/XMP.ProxyPilot.xml` and in
`docs/A1-messprotokoll.md` through `docs/C2-messprotokoll.md`. In-game
validation is the first open task for all seven milestones; A2's JSON-parsing
assumption must be validated before A3-C2 can be tested at all (no
state_update/hit_report/hp_state/session/sector_object data reaches the
blackboard or the player's own ship otherwise).

## Dependencies

- **SirNukes Mod Support APIs** (Steam Workshop). Provides the `md.Named_Pipes`
  component this extension uses to open a Named Pipe from Mission Director code.
  Install it from the Steam Workshop and make sure it loads before this extension
  (the game's extension manager handles load order via the `dependency` declared
  in `content.xml`).

## Installation

1. Subscribe to / install "SirNukes Mod Support APIs" via the Steam Workshop.
2. Copy the `mod/` folder into your X4 extensions directory, renamed to
   `xmultiplayer` (or any name; the folder name does not need to match the
   `content.xml` id), typically:
   - `<X4 install>/extensions/xmultiplayer/` or
   - `%APPDATA%/Roaming/EgoSoft/X4/<user id>/extensions/xmultiplayer/`
3. Enable both extensions in the in-game extension manager and restart X4.
4. Start a new game via one of the four "XMultiplayer Arena" custom gamestarts
   (base/asteroid field/debris field/nebula, A2 + A5) -- each drops you directly
   into its own dedicated Arena sector with a starting fighter, no factions/jobs/
   economy running.
5. Start the XMultiplayer agent (`npm start` in `/agent`, see the root README)
   before or after launching X4 -- the agent listens on the pipe continuously and
   the mod retries the connection with backoff if the agent isn't up yet. Since
   A5, simply being in the Arena sector is what joins the session (no extra step):
   the agent auto-joins at connect time ONLY if given an explicit `--session`/
   `XMP_SESSION` (leave it unset for normal drop-in play).

## Expected pipe name

The extension writes to a logical pipe named `xmultiplayer`. Per the SirNukes API
(assumption, see `docs/A1-messprotokoll.md`), this maps to the Windows Named Pipe
path `\\.\pipe\x4_xmultiplayer`, which is exactly what the agent listens on by
default (`agent/src/config.ts`).

## Debugging in-game

Enable MD debug logging (`General` filter) to see `[XMultiplayer]` log lines from
`XMP_Telemetry.xml`: API-ready notification, per-tick skip warnings (no player ship),
and pipe write failures with backoff. Cross-reference with the agent's own 5-second
console stats (received messages, measured Hz, sequence gaps) to validate the
achievable MD update rate -- the critical number for all of Phase 1 (PlanMod.md 4.1).

`XMP_Arena.xml` logs under the same filter with a `[XMultiplayer][Arena]` prefix:
proxy spawned/despawned per objectId, and a warning if a spawn arrives for an
objectId that already has a proxy. Since A4, also logs a destruction (own ship or
proxy) as "destroyed (server-confirmed)", distinguishing it from a regular despawn.
Since A5, also logs entering/leaving the Arena sector and a SETA status change for
another session member ("activated SETA (proxy frozen)"/"left SETA (proxy
resumed)"). The agent's 5-second stats also report `remoteForwarded`/
`remoteDropped` counts for messages relayed down into the pipe.

`XMP.ProxyPilot.xml` logs under a `[XMultiplayer][ProxyPilot]` prefix: a snap
teleport (with the squared deviation that triggered it), a "holding position"
line when `$UpdateTimeoutSec` is exceeded, and, since A5, "frozen (owner in
SETA), holding position" when the proxy's owner is in SETA. Frequent snaps or
holds are a signal the tuning defaults (`XMP_Arena_TuningDefaults`) need
adjusting for the observed latency/speeds, see `docs/A3-messprotokoll.md` (which
also has the in-game measurement template and A2-vs-A3 comparison table).
