# XMultiplayer mod (X4: Foundations extension)

Milestone A1 skeleton: exports the player ship's telemetry (position, rotation,
velocity) over a Windows Named Pipe, at a target rate of 10 Hz, for the external
agent/relay chain described in `docs/PlanMod.md`.

**Status: PLAUSIBLE, not VERIFIED.** This extension has not been loaded or run inside
X4 (no game installation available in this development environment). The XML is
checked to be syntactically valid, but the Mission Director semantics (cue timing,
the exact SirNukes Named_Pipes API surface) are assumptions documented inline in
`md/XMP_Telemetry.xml` and in `docs/A1-messprotokoll.md`. In-game validation is the
first open task for milestone A1.

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
4. Start the XMultiplayer agent (`npm start` in `/agent`, see the root README) before
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
