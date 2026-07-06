/**
 * Combat balance defaults for A4 HP authority (server/src/hpTracker.ts). Kept in
 * protocol/ (not server/) since these are shared, documented facts about the game
 * simulation both the server and the mod need to agree on conceptually -- even
 * though the mod can't literally import this TS module, its own defaults
 * (mod/md/XMP_Arena.xml's XMP_Arena_HandleSpawn) must match these values, or a
 * freshly spawned proxy's locally-displayed HP would disagree with what the
 * server considers the ship's starting HP.
 */

/** Starting hull value for a freshly spawned ship, before any hit_report has been processed. */
export const DEFAULT_HULL = 100;

/** Starting shield value for a freshly spawned ship. */
export const DEFAULT_SHIELD = 100;

/**
 * Upper bound on the damage a single hit_report may apply. The server is the HP
 * authority, but a client's hit_report is still untrusted input (from A2's trust
 * boundary rationale, docs/A2-messprotokoll.md) -- without a cap, a single
 * malicious or buggy hit_report claiming e.g. damage: 999999999 would instantly
 * destroy any ship regardless of its actual hull/shield pool. Chosen well above
 * DEFAULT_HULL/DEFAULT_SHIELD so it never clips a plausible single hit under
 * normal (non-malicious) play, only implausible ones.
 */
export const MAX_DAMAGE_PER_HIT = 1000;

/**
 * Upper bound on a client-supplied starting hull/shield (spawn.maxHull/maxShield,
 * A4 review round 2 finding). Same untrusted-input rationale as MAX_DAMAGE_PER_HIT:
 * without a cap, a spawn claiming e.g. maxHull: 1e308 would make that ship
 * practically unkillable (MAX_DAMAGE_PER_HIT-sized hits would never catch up), and
 * a negative/zero value would register an already-dead ship without ever going
 * through the destruction sequence. 50x MAX_DAMAGE_PER_HIT is a deliberately round,
 * generous estimate (50 max-damage hits to kill even the toughest v1 ship) --
 * calibrate after the first live combat test, same as MAX_DAMAGE_PER_HIT itself.
 * The validation function itself (isValidStartingHp) lives in server/src/hpTracker.ts
 * alongside clampDamage/isValidDamageClaim, consistent with this file's existing
 * split: shared constants here, validation logic where it's actually used.
 */
export const MAX_STARTING_HP = 50 * MAX_DAMAGE_PER_HIT;
