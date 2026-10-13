import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_KEY_BAR_ITEMS,
  KEY_BAR_ITEMS_MAX,
  KEY_BAR_STORAGE_KEY,
  addKeyBarItem,
  customKeyBarItem,
  keyBarItemId,
  keyBarItemKey,
  keyBarItemLabel,
  moveKeyBarItem,
  readKeyBarItems,
  removeKeyBarItem,
  resetKeyBarItems,
  sanitizeKeyBarItems,
  writeKeyBarItems,
} from "../public/key-bar-preference.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const labels = (items) => items.map(keyBarItemLabel);

test("the default bar is the one that shipped, in the same order", () => {
  assert.deepEqual(labels(DEFAULT_KEY_BAR_ITEMS), [
    "Esc", "/", "−", "Home", "↑", "End", "PgUp", "Shift", "Tab", "Ctrl", "Alt", "←", "↓", "→", "PgDn", "Enter",
  ]);
  assert.equal(new Set(DEFAULT_KEY_BAR_ITEMS.map(keyBarItemId)).size, 16);
});

test("adds, removes and reorders without touching the original list", () => {
  const items = [...DEFAULT_KEY_BAR_ITEMS];
  const added = addKeyBarItem(items, { type: "key", key: "f5" });
  assert.equal(added.length, 17);
  assert.equal(items.length, 16);
  assert.equal(addKeyBarItem(added, { type: "key", key: "f5" }).length, 17, "a repeat is ignored");
  assert.equal(removeKeyBarItem(items, 6).map(keyBarItemLabel).includes("PgUp"), false);
  const moved = moveKeyBarItem(items, 15, 0);
  assert.equal(keyBarItemLabel(moved[0]), "Enter");
  assert.equal(moved.length, 16);
  assert.deepEqual(moveKeyBarItem(items, 3, 3), items);
  assert.deepEqual(moveKeyBarItem(items, -1, 2), items);
  assert.deepEqual(moveKeyBarItem(items, 2, 99), items);
});

test("the list stops at its maximum", () => {
  let items = [];
  for (let n = 0; n < KEY_BAR_ITEMS_MAX + 5; n += 1) {
    items = addKeyBarItem(items, customKeyBarItem(String.fromCharCode(97 + (n % 26)), n < 26 ? ["ctrl"] : ["alt"]));
  }
  assert.equal(items.length, KEY_BAR_ITEMS_MAX);
});

test("custom combinations are validated and named", () => {
  const ctrlR = customKeyBarItem("R", ["ctrl"]);
  assert.deepEqual(ctrlR, { type: "key", key: "r", modifiers: ["ctrl"] });
  assert.equal(keyBarItemLabel(ctrlR), "Ctrl+R");
  assert.equal(keyBarItemKey(ctrlR, ["alt"]), "ctrl+r", "held modifiers do not change a saved chord");
  const chord = customKeyBarItem("z", ["shift", "ctrl"]);
  assert.equal(keyBarItemKey(chord), "ctrl+shift+z");
  assert.equal(keyBarItemLabel(customKeyBarItem("f5", ["alt"])), "Alt+F5");
  assert.equal(keyBarItemKey({ type: "key", key: "up" }, ["ctrl"]), "ctrl+up", "a plain key takes the held modifiers");
  assert.equal(keyBarItemKey({ type: "modifier", modifier: "ctrl" }), null);
  for (const bad of ["", " ", "a b", "ctrl+r", "--x", "a\n", null, 5]) {
    assert.equal(customKeyBarItem(bad, ["ctrl"]), null, JSON.stringify(bad));
  }
  assert.notEqual(keyBarItemId(customKeyBarItem("r", ["ctrl"])), keyBarItemId(customKeyBarItem("r")));
});

test("saving and reading round-trips, including an emptied bar", () => {
  const storage = memoryStorage();
  const items = moveKeyBarItem(addKeyBarItem(removeKeyBarItem(DEFAULT_KEY_BAR_ITEMS, 6), customKeyBarItem("r", ["ctrl"])), 14, 0);
  assert.equal(writeKeyBarItems(storage, items), true);
  assert.deepEqual(readKeyBarItems(storage), items);
  writeKeyBarItems(storage, []);
  assert.deepEqual(readKeyBarItems(storage), [], "removing every key is respected");
  resetKeyBarItems(storage);
  assert.deepEqual(readKeyBarItems(storage), [...DEFAULT_KEY_BAR_ITEMS]);
});

test("corrupted or hostile storage falls back to the default or drops the bad entries", () => {
  for (const raw of ["{", "null", "[]", "\"x\"", JSON.stringify({ version: 2, items: [] }), JSON.stringify({ version: 1, items: "no" })]) {
    const storage = memoryStorage({ [KEY_BAR_STORAGE_KEY]: raw });
    assert.deepEqual(readKeyBarItems(storage), [...DEFAULT_KEY_BAR_ITEMS], raw);
  }
  const mixed = memoryStorage({ [KEY_BAR_STORAGE_KEY]: JSON.stringify({ version: 1, items: [
    { type: "key", key: "esc" }, { type: "key", key: "esc" }, { type: "key", key: "ctrl+r" },
    { type: "key", key: "x", modifiers: "ctrl" }, { type: "key", key: "x", modifiers: ["super", "ctrl", "ctrl"] },
    { type: "modifier", modifier: "meta" }, { type: "text", text: "rm -rf /" }, 7, null, { type: "key", key: 3 },
  ] }) });
  assert.deepEqual(labels(readKeyBarItems(mixed)), ["Esc", "Ctrl+X"]);
});

test("without usable storage the bar still works", () => {
  assert.deepEqual(readKeyBarItems(null), [...DEFAULT_KEY_BAR_ITEMS]);
  assert.equal(writeKeyBarItems(null, DEFAULT_KEY_BAR_ITEMS), false);
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("x"); } };
  assert.deepEqual(readKeyBarItems(throwing), [...DEFAULT_KEY_BAR_ITEMS]);
  assert.equal(writeKeyBarItems(throwing, DEFAULT_KEY_BAR_ITEMS), false);
  assert.equal(resetKeyBarItems(throwing), false);
  assert.deepEqual(sanitizeKeyBarItems(undefined), [...DEFAULT_KEY_BAR_ITEMS]);
});

test("a stored base key must be one the window can create", () => {
  const stored = (items) => memoryStorage({ [KEY_BAR_STORAGE_KEY]: JSON.stringify({ version: 1, items }) });
  const read = (items) => labels(readKeyBarItems(stored(items)));
  assert.deepEqual(read([
    { type: "key", key: "esc" }, { type: "key", key: "f12" }, { type: "key", key: "r", modifiers: ["ctrl"] },
    { type: "key", key: "é" }, { type: "key", key: "F1" }, { type: "key", key: "xyz" }, { type: "key", key: "unknown" },
    { type: "key", key: "a\u0007" }, { type: "key", key: "\u200b" }, { type: "key", key: "pageup", modifiers: ["alt"] },
  ]), ["Esc", "F12", "Ctrl+R", "é", "Alt+PgUp"]);
  assert.equal(customKeyBarItem("xyz", ["ctrl"]), null);
  assert.equal(customKeyBarItem("f5", ["ctrl"]).key, "f5");
});
