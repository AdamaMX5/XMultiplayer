/**
 * Node-side mirror of mod/md/XMP_Arena.xml's XMP_Arena_ExtractField cue -- the MD
 * field reader that does not parse JSON, but does a naive linear string search for
 * the first `"<key>":` it can find, then reads until whatever ends the value.
 *
 * Extracted into its own file (A4 review requirement) so it stops being buried
 * inside canonical.test.ts: every future test file that needs to simulate the MD
 * extractor (e.g. hit_report/hp_state extraction tests) imports this instead of
 * redefining it. If XMP_Arena_ExtractField's XML logic ever changes, this is the
 * one place to update to match -- see the back-reference comment on that cue
 * itself in mod/md/XMP_Arena.xml.
 *
 * Reproduces the CURRENT (post-A3-review, round 2) algorithm faithfully, including
 * all three fixes documented on the cue itself:
 *   (1) fall back to the brace position when no comma follows (last-field-in-object),
 *   (2) detect an object-valued field (its first character is '{') and search only
 *       for the matching '}', never a comma (nested position/rotation/velocity), and
 *   (3) only quote-strip the scalar branch's result -- the object branch's span is
 *       returned exactly as captured, so its own nested "key": quotes survive for
 *       the sub-extraction that reads x/y/z etc. back out of it.
 */
export interface ExtractFieldResult {
  found: boolean;
  value: string | null;
  endIndex: number;
}

export function simulateMdExtractField(rxLine: string, key: string): ExtractFieldResult {
  const needle = `"${key}":`;
  const keyPos = rxLine.indexOf(needle);
  if (keyPos === -1) return { found: false, value: null, endIndex: NaN };
  const valueStart = keyPos + needle.length;
  const isObjectValue = rxLine.slice(valueStart, valueStart + 1) === "{";
  let end: number;
  if (isObjectValue) {
    const bracePos = rxLine.indexOf("}", valueStart);
    end = bracePos + 1; // include the closing brace, mirroring the cue's own comment
  } else {
    const commaPos = rxLine.indexOf(",", valueStart);
    const bracePos = rxLine.indexOf("}", valueStart);
    end = commaPos === -1 ? bracePos : Math.min(commaPos, bracePos);
  }
  if (end < 0) return { found: true, value: null, endIndex: end };
  const raw = rxLine.slice(valueStart, end);
  // Fix 3: the quote-strip only applies to the scalar branch now. The object
  // branch's span keeps its nested keys' quotes intact.
  const value = isObjectValue ? raw : raw.replace(/"/g, "");
  return { found: true, value, endIndex: end };
}
