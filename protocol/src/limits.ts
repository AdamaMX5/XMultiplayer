/**
 * Shared size cap for a single wire message (one NDJSON line on the pipe, one
 * WebSocket text frame). Without a cap, a line that never finds its terminating
 * newline (or an oversized WebSocket frame) grows a receive buffer without bound --
 * a resource-exhaustion vector. Enforced in three places using this same constant:
 *   - parseMessage() in parse.ts (rejects an oversized payload outright)
 *   - NdjsonSplitter in agent/src/ndjson.ts (drops an oversized buffered line/chunk)
 *   - the relay server's WebSocketServer `maxPayload` option (server/src/server.ts)
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * C1 "Statischer Sektor-Mirror": sanity cap on `sector_mirror`'s `objectCount`
 * (begin) and, separately, a length cap on `sector_object.macroName`. Unlike
 * `spawn.shipType`, there is no whitelist a station/gate/asteroid-field/region
 * macro name can be checked against yet (SHIP_MACRO_WHITELIST is ship-specific,
 * and no equivalent exists for sector scenery, see shipMacros.ts) -- these two
 * cheap, whitelist-free bounds are what stands in for one until a real macro
 * list is confirmed against the game's own library files.
 */
export const MAX_SECTOR_OBJECTS_PER_MIRROR = 2000;
export const MAX_MACRO_NAME_LENGTH = 64;

/**
 * C3 "NPC-Bubble mit Interest Management": max simultaneous "npc"-category
 * spawns (SpawnMessage.category) a single client may own, enforced server-side
 * (server/src/server.ts, server/src/sessionManager.ts) independently of A4's
 * original one-"player"-spawn cap. Matches PlanMod.md's own number ("volle
 * Update-Rate nur für die ~10 nächsten/relevantesten Objekte") -- doubles as
 * this milestone's answer to "Budget definieren: max. Proxy-Anzahl beim Gast".
 */
export const MAX_NPC_SPAWNS_PER_CLIENT = 10;
