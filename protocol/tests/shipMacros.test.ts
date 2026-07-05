import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownShipMacro, SHIP_MACRO_WHITELIST } from "../src/shipMacros.js";

test("accepts a whitelisted macro", () => {
  assert.equal(isKnownShipMacro("ship_arg_s_fighter_01_a_macro"), true);
});

test("rejects an unknown macro", () => {
  assert.equal(isKnownShipMacro("ship_totally_made_up_macro"), false);
});

test("rejects an empty string", () => {
  assert.equal(isKnownShipMacro(""), false);
});

test("is case-sensitive (X4 macro names are lowercase by convention)", () => {
  assert.equal(isKnownShipMacro("SHIP_ARG_S_FIGHTER_01_A_MACRO"), false);
});

test("the whitelist is non-empty and contains only unique entries", () => {
  assert.ok(SHIP_MACRO_WHITELIST.size > 0);
  assert.equal(SHIP_MACRO_WHITELIST.size, new Set(SHIP_MACRO_WHITELIST).size);
});
