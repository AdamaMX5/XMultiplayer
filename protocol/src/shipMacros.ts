/**
 * Whitelist of known-good base-game S/M combat ship macros. Used to validate any
 * `shipType` coming from an untrusted source (a remote peer's `spawn` message, or a
 * misconfigured `--ship` CLI flag) before it is ever passed into an X4 MD
 * `create_ship` action -- the Server -> Agent -> MD direction is untrusted input
 * from A2 onward (see docs/A2-messprotokoll.md).
 *
 * Deliberately small, explicit, and base-game only (no DLC dependency, matching
 * PlanMod.md's Arena requirements). PLAUSIBLE, not VERIFIED: macro name spelling
 * follows X4's documented `ship_<race>_<size>_<role>_<variant>_macro` convention,
 * not confirmed against the actual game files. Extend this list as needed; never
 * accept an arbitrary string in its place.
 */
export const SHIP_MACRO_WHITELIST: ReadonlySet<string> = new Set([
  // Argon
  "ship_arg_s_fighter_01_a_macro", // Nodan
  "ship_arg_s_fighter_02_a_macro", // Buzzard
  "ship_arg_s_scout_01_a_macro", // Discoverer
  "ship_arg_m_corvette_01_a_macro", // Moreya
  "ship_arg_m_fighter_01_a_macro", // Cutlass
  // Teladi
  "ship_tel_s_fighter_01_a_macro", // Phoenix
  "ship_tel_s_fighter_02_a_macro", // Kestrel
  "ship_tel_s_scout_01_a_macro", // Falcon
  "ship_tel_m_corvette_01_a_macro", // Osprey
  // Paranid
  "ship_par_s_fighter_01_a_macro", // Vibro Cutlass? (S fighter)
  "ship_par_s_fighter_02_a_macro",
  "ship_par_s_scout_01_a_macro",
  "ship_par_m_corvette_01_a_macro",
  // Split
  "ship_spl_s_fighter_01_a_macro", // Mamba
  "ship_spl_s_fighter_02_a_macro", // Scorpion
  "ship_spl_m_corvette_01_a_macro", // Kestrel-class equivalent
]);

export function isKnownShipMacro(shipType: string): boolean {
  return SHIP_MACRO_WHITELIST.has(shipType);
}
