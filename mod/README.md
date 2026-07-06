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

**Status: PLAUSIBLE, not VERIFIED.** This extension has not been loaded or run inside
X4 (no game installation available in this development environment). The XML is
checked to be syntactically valid, but the Mission Director/AI-script semantics
(cue timing, the exact SirNukes Named_Pipes API surface, whether MD can parse a
received JSON string at all, and -- new risk in A3 -- the `<aiscript>` root shape,
`move.to.position`, and `object.blackboard` as the MD/AI-script data channel) are
assumptions documented inline in `md/XMP_Telemetry.xml`/`md/XMP_Arena.xml`/
`aiscripts/XMP.ProxyPilot.xml` and in `docs/A1-messprotokoll.md`/
`docs/A2-messprotokoll.md`/`docs/A3-messprotokoll.md`. In-game validation is the
first open task for all three milestones; A2's JSON-parsing assumption must be
validated before A3 can be tested at all (no state_update data reaches the
blackboard otherwise).

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
4. Start a new game via the "XMultiplayer Arena" custom gamestart (added by A2) --
   this drops you directly into the dedicated, empty Arena sector with a starting
   fighter, no factions/jobs/economy running.
5. Start the XMultiplayer agent (`npm start` in `/agent`, see the root README) before
   or after launching X4 -- the agent listens on the pipe continuously and the mod
   retries the connection with backoff if the agent isn't up yet.

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
objectId that already has a proxy. The agent's 5-second stats also report
`remoteForwarded`/`remoteDropped` counts for messages relayed down into the pipe.

`XMP.ProxyPilot.xml` logs under a `[XMultiplayer][ProxyPilot]` prefix: a snap
teleport (with the squared deviation that triggered it) and a "holding position"
line when `$UpdateTimeoutSec` is exceeded. Frequent snaps or holds are a signal
the tuning defaults (`XMP_Arena_TuningDefaults`) need adjusting for the observed
latency/speeds, see `docs/A3-messprotokoll.md` (which also has the in-game
measurement template and A2-vs-A3 comparison table).
