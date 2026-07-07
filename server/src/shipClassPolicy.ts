/**
 * Server-side ship-class rule preset (A5 "Regel-Presets als Server-Config").
 * `protocol/src/shipMacros.ts`'s SHIP_MACRO_WHITELIST already answers "is this a
 * real, known ship macro at all"; this is a SEPARATE, narrower, operator-chosen
 * restriction on top of that ("which classes are allowed in THIS session's
 * ruleset", e.g. an S-only arena for a more even 1v1). Kept in server/ (not
 * protocol/) since it's server operating policy, not a wire-format fact both
 * sides need to agree on.
 *
 * Ship class is derived from the macro name's own naming convention
 * (`ship_<race>_<size>_<role>_<variant>_macro`) rather than a second parallel
 * table to keep in sync with the whitelist -- PLAUSIBLE, not VERIFIED, same
 * caveat as the whitelist itself (see shipMacros.ts).
 */
export type ShipClass = "s" | "m";
export type ShipClassPreset = "s" | "m" | "sm" | "all";

const CLASS_TOKEN: Record<ShipClass, string> = { s: "_s_", m: "_m_" };

/** Extracts the ship class from a macro name, or undefined if neither known class token appears. */
export function shipClassOf(shipType: string): ShipClass | undefined {
  if (shipType.includes(CLASS_TOKEN.s)) return "s";
  if (shipType.includes(CLASS_TOKEN.m)) return "m";
  return undefined;
}

/**
 * True if shipType's class is permitted under preset. "all" permits everything
 * (including a shipType whose class couldn't be determined -- that's the
 * whitelist's job to reject, not this policy's). Every other preset fails
 * CLOSED on an undetermined class: if we can't tell what class it is, it isn't
 * on the allowed list, so it's rejected rather than let through by default.
 */
export function isShipClassAllowed(shipType: string, preset: ShipClassPreset): boolean {
  if (preset === "all") return true;
  const cls = shipClassOf(shipType);
  if (!cls) return false;
  return preset.includes(cls);
}

/** Parses a --ships CLI/env value into a ShipClassPreset, defaulting to "all" (no additional restriction beyond the macro whitelist) for anything unrecognized or absent. */
export function parseShipClassPreset(value: string | undefined): ShipClassPreset {
  if (value === "s" || value === "m" || value === "sm" || value === "all") return value;
  return "all";
}
