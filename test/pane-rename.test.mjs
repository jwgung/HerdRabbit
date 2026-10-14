import test from "node:test";
import assert from "node:assert/strict";
import { paneRenames, renamePaneKeys } from "../public/pane-rename.js";
import { COMPOSER_DRAFT_STORAGE_KEY, createComposerDrafts } from "../public/composer-draft-preference.js";
import { LENS_STORAGE_KEY, readPaneLens, renamePaneLenses, writePaneLens } from "../public/lens-preference.js";
import { INPUT_HISTORY_STORAGE_KEY, readInputHistories, writeInputHistories } from "../public/input-history-preference.js";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const moves = [{ from: "w1:p1", to: "w2:p3" }];

test("only real, well-formed id changes count as renames", () => {
  assert.deepEqual([...paneRenames([{ from: "a", to: "b" }, { from: "c", to: "c" }, { from: "", to: "d" }, null, { from: "e" }])], [["a", "b"]]);
  assert.equal(paneRenames(undefined).size, 0);
});

test("a keyed map follows its moved panes, swaps included", () => {
  const map = new Map([["a", 1], ["b", 2], ["c", 3]]);
  assert.deepEqual([...renamePaneKeys(map, [{ from: "a", to: "z" }])], [["b", 2], ["c", 3], ["z", 1]]);
  assert.deepEqual([...renamePaneKeys(map, [{ from: "a", to: "b" }, { from: "b", to: "a" }])], [["c", 3], ["b", 1], ["a", 2]]);
  assert.equal(renamePaneKeys(map, []), map, "nothing moved, nothing copied");
});

test("an unsent draft moves with its pane, in memory and in storage", () => {
  const storage = memoryStorage();
  const drafts = createComposerDrafts(storage);
  drafts.set("w1:p1", "half a message");
  drafts.set("w1:p2", "other");
  drafts.rename(moves);
  assert.equal(drafts.get("w1:p1"), "");
  assert.equal(drafts.get("w2:p3"), "half a message");
  assert.equal(drafts.get("w1:p2"), "other");
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY))).sort(), ["w1:p2", "w2:p3"]);
  assert.equal(createComposerDrafts(storage).get("w2:p3"), "half a message");
});

test("a draft judged secret stays out of storage under its new id", () => {
  const storage = memoryStorage();
  const drafts = createComposerDrafts(storage, Date.now, () => true);
  drafts.set("w1:p1", "hunter2");
  assert.equal(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY), null);
  drafts.rename(moves);
  assert.equal(drafts.get("w2:p3"), "hunter2", "still in memory");
  assert.equal(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY), null, "never written");
  drafts.set("w2:p3", "hunter2", {});
  assert.equal(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY), null, "unchanged text keeps the verdict");
});

test("renaming a pane with no draft leaves the drafts alone", () => {
  const storage = memoryStorage();
  const drafts = createComposerDrafts(storage);
  drafts.set("w1:p2", "other");
  assert.equal(drafts.rename(moves), true);
  assert.deepEqual(drafts.panes(), ["w1:p2"]);
});

test("the message history follows the pane through storage", () => {
  const storage = memoryStorage();
  const histories = new Map([["w1:p1", ["ls", "pwd"]], ["w1:p2", ["top"]]]);
  writeInputHistories(storage, renamePaneKeys(histories, moves));
  assert.deepEqual(JSON.parse(storage.getItem(INPUT_HISTORY_STORAGE_KEY)), { "w1:p2": ["top"], "w2:p3": ["ls", "pwd"] });
  assert.deepEqual(readInputHistories(storage).get("w2:p3"), ["ls", "pwd"]);
});

test("the chosen lens follows the pane", () => {
  const storage = memoryStorage();
  writePaneLens(storage, "w1:p1", "chat");
  writePaneLens(storage, "w1:p2", "terminal");
  assert.equal(renamePaneLenses(storage, moves), true);
  assert.equal(readPaneLens(storage, "w2:p3"), "chat");
  assert.equal(readPaneLens(storage, "w1:p1"), null);
  assert.equal(readPaneLens(storage, "w1:p2"), "terminal");
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(LENS_STORAGE_KEY))).sort(), ["w1:p2", "w2:p3"]);
  assert.equal(renamePaneLenses(null, moves), false);
});
