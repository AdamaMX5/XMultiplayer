import { MAX_DAMAGE_PER_HIT, MAX_STARTING_HP, type DamageType } from "@xmultiplayer/protocol";

export interface HpState {
  hull: number;
  shield: number;
}

/**
 * Server-side HP authority (A4, PlanMod.md A4 "Server ist HP-Autorität"). Clients
 * detect hits locally and report them (hit_report); this class is the single place
 * that actually decides what a ship's hull/shield are, keyed per session per
 * objectId. The resulting hp_state is what every client (including the attacker)
 * applies locally -- neither side's own hit detection is trusted to also compute
 * the outcome, only to notice that *something* was hit.
 *
 * A Map, not a plain object, since objectIds come from another player's message.
 */
export class HpTracker {
  private hpBySession = new Map<string, Map<string, HpState>>();

  /** Registers a freshly spawned object's starting HP for a session, overwriting any prior (e.g. respawn) state. */
  register(sessionCode: string, objectId: string, hull: number, shield: number): void {
    const bySession = this.hpBySession.get(sessionCode) ?? new Map<string, HpState>();
    bySession.set(objectId, { hull, shield });
    this.hpBySession.set(sessionCode, bySession);
  }

  /**
   * Applies damage according to damageType (A4 team-lead directive: "Shield vor
   * Hull"), clamped at 0 in each pool. Returns the resulting state, or undefined if
   * objectId isn't tracked in this session (never spawned, already destroyed, or a
   * stale/spoofed reference) -- callers must treat undefined as "ignore this
   * hit_report", not as zero damage applied.
   *
   * Interpretation decision (the instruction was a parenthetical, not a full spec --
   * documented here and in docs/A4-messprotokoll.md rather than left implicit):
   *   - damageType "shield": normal weapon fire. Shield absorbs first; only the
   *     overflow past a fully-depleted shield spills into hull. This is what "Shield
   *     vor Hull" means for the common case.
   *   - damageType "hull": an explicit shield-bypass hit (e.g. a hull-piercing
   *     weapon). Goes straight to hull, shield untouched. Kept as its own case
   *     rather than folding damageType away entirely, since the field already
   *     existed and a bypass mechanic is a natural, useful thing to keep expressible.
   * No regeneration in v1, per the instruction -- shield/hull only ever decrease
   * here, restored only by a fresh register() (respawn).
   */
  applyDamage(sessionCode: string, objectId: string, damage: number, damageType: DamageType): HpState | undefined {
    const state = this.hpBySession.get(sessionCode)?.get(objectId);
    if (!state) return undefined;
    if (damageType === "hull") {
      state.hull = Math.max(0, state.hull - damage);
    } else {
      const shieldAbsorbed = Math.min(state.shield, damage);
      state.shield -= shieldAbsorbed;
      const overflow = damage - shieldAbsorbed;
      state.hull = Math.max(0, state.hull - overflow);
    }
    return { ...state };
  }

  /** Forgets an object's HP (destroyed, or its owner disconnected). */
  remove(sessionCode: string, objectId: string): void {
    this.hpBySession.get(sessionCode)?.delete(objectId);
  }

  /** Current tracked state, if any -- mainly for tests; server.ts drives everything off applyDamage's return value instead. */
  get(sessionCode: string, objectId: string): HpState | undefined {
    const state = this.hpBySession.get(sessionCode)?.get(objectId);
    return state ? { ...state } : undefined;
  }
}

/** A ship with hull at or below 0 is destroyed. Shield reaching 0 only exposes the hull; it does not by itself destroy the ship. */
export function isDestroyed(state: HpState): boolean {
  return state.hull <= 0;
}

/**
 * Clamps a claimed hit_report damage value to MAX_DAMAGE_PER_HIT (protocol/src/combat.ts).
 * Extracted as its own pure function (rather than inlined at the call site in
 * server.ts) specifically so it's directly unit-testable: DEFAULT_HULL (100) is
 * well below MAX_DAMAGE_PER_HIT (1000), so an integration test driving damage
 * through applyDamage can't distinguish "clamped to 1000" from "not clamped at
 * all" -- both floor the same 100-hull ship to 0 either way.
 */
export function clampDamage(damage: number): number {
  return Math.min(damage, MAX_DAMAGE_PER_HIT);
}

/**
 * Range validation for a claimed hit_report damage value (A1 security audit
 * finding, closed in A4 alongside the HP authority itself: "Bereichsvalidierung
 * mit der HP-Autorität"). protocol/src/parse.ts's isNumber already rejects
 * NaN/Infinity (JSON can't even encode those as literals, so this mostly guards
 * against a client that hand-crafts a wire line rather than using the mod), but it
 * does not and should not reject a merely negative finite number -- that's a
 * game-rules concern (regeneration doesn't exist in v1, so negative damage would
 * otherwise silently HEAL the target), not a wire-format concern, so it lives here
 * rather than in the generic parser. clampDamage (above) only handles the upper
 * bound; this handles "not a valid damage claim at all".
 */
export function isValidDamageClaim(damage: number): boolean {
  return Number.isFinite(damage) && damage > 0;
}

/**
 * Range validation for a claimed starting hull/shield value (spawn.maxHull/
 * maxShield, A4 review round 2 finding). Mirrors isValidDamageClaim's "finite and
 * positive" check, plus an upper bound (MAX_DAMAGE_PER_HIT-sized hits must
 * eventually be able to destroy any ship; isValidDamageClaim has no upper bound of
 * its own since MAX_DAMAGE_PER_HIT/clampDamage already cap the other side of that
 * equation). Callers must fall back to DEFAULT_HULL/DEFAULT_SHIELD when this
 * returns false, not merely clamp -- clamping would still let a negative value
 * silently coerce to some small positive number that isn't necessarily the
 * intended default.
 */
export function isValidStartingHp(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_STARTING_HP;
}
