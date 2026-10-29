import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STORAGE_KEY,
  adjustedTerminalFontSize,
  readTerminalFontSize,
  writeTerminalFontSize,
} from "../public/terminal-preference.js";

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("stores and restores the terminal font size", () => {
  const storage = memoryStorage();
  assert.equal(readTerminalFontSize(storage), DEFAULT_TERMINAL_FONT_SIZE);
  assert.equal(writeTerminalFontSize(storage, 15), true);
  assert.equal(readTerminalFontSize(storage), 15);
});

test("bounds terminal font size adjustments", () => {
  assert.equal(adjustedTerminalFontSize(12, "smaller"), 11);
  assert.equal(adjustedTerminalFontSize(12, "larger"), 13);
  assert.equal(
    adjustedTerminalFontSize(MIN_TERMINAL_FONT_SIZE, "smaller"),
    MIN_TERMINAL_FONT_SIZE,
  );
  assert.equal(
    adjustedTerminalFontSize(MAX_TERMINAL_FONT_SIZE, "larger"),
    MAX_TERMINAL_FONT_SIZE,
  );
});

test("falls back safely for malformed or unavailable preferences", () => {
  assert.equal(
    readTerminalFontSize(memoryStorage({
      [TERMINAL_FONT_SIZE_STORAGE_KEY]: "not-a-size",
    })),
    DEFAULT_TERMINAL_FONT_SIZE,
  );
  assert.equal(readTerminalFontSize({ getItem() { throw new Error("blocked"); } }), 12);
  assert.equal(writeTerminalFontSize(null, 14), false);
});

test("a grid's own text size is kept apart, in half steps from 4 to 32", async () => {
  const { GRID_FONT_STORAGE_KEY, adjustedGridFont, normalizedGridFont, readGridFont, writeGridFont } =
    await import("../public/terminal-preference.js");
  assert.equal(GRID_FONT_STORAGE_KEY, "herdrbridge-grid-font");
  assert.equal(normalizedGridFont(null), null);
  assert.equal(normalizedGridFont("nope"), null);
  assert.equal(normalizedGridFont(9.7), 9.5);
  assert.equal(normalizedGridFont(1), 4);
  assert.equal(normalizedGridFont(99), 32);
  // One step like a single pane's, from the font the grid has now.
  assert.equal(adjustedGridFont(13.5, "smaller"), 12.5);
  assert.equal(adjustedGridFont(13.5, "larger"), 14.5);
  assert.equal(adjustedGridFont(4.5, "smaller"), 4);
  assert.equal(adjustedGridFont(32, "larger"), 32);
  assert.equal(adjustedGridFont(null, "larger"), null);
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) };
  assert.equal(readGridFont(storage), null);
  assert.equal(writeGridFont(storage, 11.5), true);
  assert.equal(readGridFont(storage), 11.5);
  assert.equal(stored.has(TERMINAL_FONT_SIZE_STORAGE_KEY), false);
  writeGridFont(storage, null);
  assert.equal(readGridFont(storage), null);
  // Storage that throws or is missing is tolerated.
  const broken = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); }, removeItem() { throw new Error("no"); } };
  assert.equal(readGridFont(broken), null);
  assert.equal(writeGridFont(broken, 12), false);
  assert.equal(writeGridFont(null, 12), false);
});

test("a grid fits its panes to the window unless the user turned that off", async () => {
  const { GRID_FIT_STORAGE_KEY, readGridFit, writeGridFit } = await import("../public/terminal-preference.js");
  assert.equal(GRID_FIT_STORAGE_KEY, "herdrbridge-grid-fit");
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  assert.equal(readGridFit(storage), true, "on by default");
  assert.equal(writeGridFit(storage, false), true);
  assert.equal(readGridFit(storage), false);
  assert.equal(writeGridFit(storage, true), true);
  assert.equal(readGridFit(storage), true);
  stored.set(GRID_FIT_STORAGE_KEY, "garbage");
  assert.equal(readGridFit(storage), true);
  // Storage that throws or is missing is tolerated, and the grid fits.
  const broken = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } };
  assert.equal(readGridFit(broken), true);
  assert.equal(readGridFit(null), true);
  assert.equal(writeGridFit(broken, false), false);
  assert.equal(writeGridFit(null, false), false);
});
