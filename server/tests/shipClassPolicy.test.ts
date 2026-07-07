import { test } from "node:test";
import assert from "node:assert/strict";
import { isShipClassAllowed, parseShipClassPreset, shipClassOf } from "../src/shipClassPolicy.js";

test("shipClassOf() extracts 's' from an S-class macro name", () => {
  assert.equal(shipClassOf("ship_arg_s_fighter_01_a_macro"), "s");
});

test("shipClassOf() extracts 'm' from an M-class macro name", () => {
  assert.equal(shipClassOf("ship_arg_m_corvette_01_a_macro"), "m");
});

test("shipClassOf() returns undefined for a name with neither class token", () => {
  assert.equal(shipClassOf("totally_made_up_macro"), undefined);
});

test("isShipClassAllowed() with preset 'all' accepts anything, even an undetermined class", () => {
  assert.equal(isShipClassAllowed("ship_arg_s_fighter_01_a_macro", "all"), true);
  assert.equal(isShipClassAllowed("totally_made_up_macro", "all"), true);
});

test("isShipClassAllowed() with preset 's' accepts S-class, rejects M-class", () => {
  assert.equal(isShipClassAllowed("ship_arg_s_fighter_01_a_macro", "s"), true);
  assert.equal(isShipClassAllowed("ship_arg_m_corvette_01_a_macro", "s"), false);
});

test("isShipClassAllowed() with preset 'm' accepts M-class, rejects S-class", () => {
  assert.equal(isShipClassAllowed("ship_arg_m_corvette_01_a_macro", "m"), true);
  assert.equal(isShipClassAllowed("ship_arg_s_fighter_01_a_macro", "m"), false);
});

test("isShipClassAllowed() with preset 'sm' accepts both S and M", () => {
  assert.equal(isShipClassAllowed("ship_arg_s_fighter_01_a_macro", "sm"), true);
  assert.equal(isShipClassAllowed("ship_arg_m_corvette_01_a_macro", "sm"), true);
});

test("isShipClassAllowed() fails CLOSED for an undetermined class under any preset except 'all'", () => {
  assert.equal(isShipClassAllowed("totally_made_up_macro", "s"), false);
  assert.equal(isShipClassAllowed("totally_made_up_macro", "m"), false);
  assert.equal(isShipClassAllowed("totally_made_up_macro", "sm"), false);
});

test("parseShipClassPreset() recognizes all four valid preset values", () => {
  assert.equal(parseShipClassPreset("s"), "s");
  assert.equal(parseShipClassPreset("m"), "m");
  assert.equal(parseShipClassPreset("sm"), "sm");
  assert.equal(parseShipClassPreset("all"), "all");
});

test("parseShipClassPreset() defaults to 'all' for anything unrecognized or absent", () => {
  assert.equal(parseShipClassPreset(undefined), "all");
  assert.equal(parseShipClassPreset(""), "all");
  assert.equal(parseShipClassPreset("xl"), "all");
});
