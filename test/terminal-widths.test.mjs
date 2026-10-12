import test from "node:test";
import assert from "node:assert/strict";
import { herdrWidthProvider } from "../public/terminal-widths.js";

// The bundle reads `self` as it loads; the width tables need nothing else of a browser.
globalThis.self ??= globalThis;
const { UnicodeGraphemesAddon } = await import("../public/vendor/xterm.mjs");

// How many cells herdr 0.9 gives each text (the cursor read back after printing it in a pane).
const HERDR_COLUMNS = [
  ["Unicode 9 emoji", "🤖", 2],
  ["ZWJ family", "👨‍👩‍👧", 2],
  ["Unicode 14 emoji", "🫡", 2],
  ["Unicode 15 emoji", "🫨", 2],
  ["Thai SARA AM after a tone mark", "น้ำ", 2],
  ["Devanagari vowel sign", "का", 2],
  ["zero-width space", "a​b", 2],
  ["decomposed Hangul", "한", 2],
  ["Hangul and Han", "한漢", 4],
  ["ambiguous-width circle", "●", 1],
];

// Cells as xterm lays them out: a character either joins the cell before it or starts its own.
function columns(provider, text) {
  let total = 0;
  let properties = 0;
  for (const char of text) {
    const next = provider.charProperties(char.codePointAt(0), properties);
    const width = (next >> 1) & 3;
    const joins = (next & 1) !== 0;
    total += joins ? Math.max(0, width - ((properties >> 1) & 3)) : width;
    properties = next;
  }
  return total;
}

test("xterm counts cells as herdr does", () => {
  const provider = herdrWidthProvider(UnicodeGraphemesAddon);
  for (const [name, text, expected] of HERDR_COLUMNS) assert.equal(columns(provider, text), expected, name);
});
