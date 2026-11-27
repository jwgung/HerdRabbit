import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SPLITS,
  OPEN_SPLIT_STORAGE_KEY,
  VIEW_SPLITS_STORAGE_KEY,
  VIEW_SPLIT_STORAGE_KEY,
  addPickTile,
  addTile,
  loadViewSplits,
  nextSplitId,
  parseSplits,
  pruneSplits,
  putSplit,
  readViewSplits,
  renameSplits,
  splitHue,
  splitWithPane,
  tiles,
  writeOpenSplit,
  writeViewSplits,
} from "../public/view-split.js";

// Several view splits kept by the browser: the list in local storage (every
// window of this browser, and after it closes), the one each window shows in
// its session storage. A pane is a tile of one split at most.

const memoryStorage = () => {
  const store = new Map();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
};
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
const two = (a, b) => addTile(null, a, b, "right");

test("a split takes the lowest number free, up to MAX_SPLITS", () => {
  assert.equal(MAX_SPLITS, 8);
  assert.equal(nextSplitId([]), 1);
  const list = [{ id: 1, tree: two("a", "b"), focus: "a" }, { id: 3, tree: two("c", "d"), focus: "c" }];
  assert.equal(nextSplitId(list), 2);
  const full = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, tree: two(`a${index}`, `b${index}`), focus: `a${index}` }));
  assert.equal(nextSplitId(full), null);
});

test("each split keeps its own colour: four hues, again from 5", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(splitHue), [0, 1, 2, 3, 0, 1, 2, 3]);
});

test("putting a split adds or replaces it by number, in order, and null takes it out", () => {
  let list = putSplit([], 2, two("c", "d"), "d");
  list = putSplit(list, 1, two("a", "b"), "a");
  assert.deepEqual(list.map((split) => split.id), [1, 2]);
  assert.deepEqual(list[1], { id: 2, tree: two("c", "d"), focus: "d" });
  list = putSplit(list, 2, addTile(two("c", "d"), "d", "e", "down"), "e");
  assert.deepEqual(tiles(list[1].tree), ["c", "d", "e"]);
  assert.deepEqual(putSplit(list, 2, null, null).map((split) => split.id), [1]);
  assert.deepEqual(putSplit(list, 9, two("x", "y"), "x"), list, "no number past MAX_SPLITS");
  assert.deepEqual(putSplit(list, null, two("x", "y"), "x"), list, "no number, nothing kept");
});

test("a pane put in one split leaves any other; a split left with one tile is gone", () => {
  let list = putSplit([], 1, two("a", "b"), "a");
  list = putSplit(list, 2, addTile(two("c", "d"), "d", "e", "down"), "c");
  // "e" goes to split 1: split 2 keeps c and d.
  list = putSplit(list, 1, addTile(two("a", "b"), "b", "e", "right"), "e");
  assert.deepEqual(tiles(splitWithPane(list, "e").tree), ["a", "b", "e"]);
  assert.equal(splitWithPane(list, "e").id, 1);
  assert.deepEqual(tiles(list.find((split) => split.id === 2).tree), ["c", "d"]);
  // "c" goes to split 1 too: split 2 is down to "d" alone, so it is gone.
  list = putSplit(list, 1, addTile(list[0].tree, "e", "c", "down"), "c");
  assert.deepEqual(list.map((split) => split.id), [1]);
  assert.equal(splitWithPane(list, "d"), null);
});

test("a focus that is not a tile falls to the first; a picker is never kept", () => {
  assert.equal(putSplit([], 1, two("a", "b"), "gone")[0].focus, "a");
  const withPick = addPickTile(two("a", "b"), "b", "down");
  assert.deepEqual(tiles(putSplit([], 1, withPick, "b")[0].tree), ["a", "b"]);
  assert.deepEqual(putSplit([], 1, addPickTile(null, "a", "right"), "a"), [], "a picker and one pane is no split yet");
});

test("gone panes leave every split, and renamed panes are followed in every split", () => {
  let list = putSplit([], 1, addTile(two("a", "b"), "b", "c", "down"), "c");
  list = putSplit(list, 2, two("d", "e"), "d");
  const pruned = pruneSplits(list, (paneId) => paneId !== "c" && paneId !== "e");
  assert.deepEqual(pruned.map((split) => [split.id, tiles(split.tree), split.focus]), [[1, ["a", "b"], "a"]]);
  assert.equal(pruneSplits(list, () => true), list, "nothing gone: the same list");
  const renamed = renameSplits(list, [{ from: "a", to: "w2:p9" }, { from: "d", to: "w3:p1" }]);
  assert.deepEqual(renamed.map((split) => tiles(split.tree)), [["w2:p9", "b", "c"], ["w3:p1", "e"]]);
  assert.equal(renameSplits(list, []), list);
  const focusRenamed = renameSplits(putSplit([], 1, two("a", "b"), "b"), [{ from: "b", to: "z" }]);
  assert.equal(focusRenamed[0].focus, "z", "the focus follows its pane");
});

test("only well-formed splits are read back: numbers 1 to 8, once each, a pane in one split", () => {
  const good = { id: 1, tree: two("a", "b"), focus: "b" };
  assert.deepEqual(parseSplits({ splits: [good] }), [good]);
  assert.deepEqual(parseSplits({ splits: [{ ...good, id: 0 }, { ...good, id: 9 }, { ...good, id: "1" }] }), []);
  assert.deepEqual(parseSplits({ splits: [good, { id: 1, tree: two("c", "d"), focus: "c" }] }), [good], "a number twice: the first");
  assert.deepEqual(parseSplits({ splits: [good, { id: 2, tree: two("b", "c"), focus: "c" }] }), [good], "a pane twice: the first");
  assert.deepEqual(parseSplits({ splits: [{ id: 2, tree: { dir: "sideways", first: "a", second: "b" } }] }), []);
  assert.deepEqual(parseSplits({ splits: [{ id: 2, tree: two("c", "d"), focus: "nope" }] })[0].focus, "c");
  assert.deepEqual(parseSplits(null), []);
  assert.deepEqual(parseSplits({ splits: "x" }), []);
});

test("the list survives in local storage, and bad or blocked storage reads as none", () => {
  const local = memoryStorage();
  const list = putSplit(putSplit([], 1, two("a", "b"), "a"), 2, two("c", "d"), "d");
  writeViewSplits(local, list);
  assert.deepEqual(readViewSplits(local), list);
  writeViewSplits(local, []);
  assert.equal(local.store.has(VIEW_SPLITS_STORAGE_KEY), false, "no splits, no key");
  local.store.set(VIEW_SPLITS_STORAGE_KEY, "{not json");
  assert.deepEqual(readViewSplits(local), []);
  assert.deepEqual(readViewSplits(broken), []);
  assert.deepEqual(readViewSplits(null), []);
  assert.doesNotThrow(() => writeViewSplits(broken, list));
});

test("each window opens its own split again on reload, or none", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  writeViewSplits(local, putSplit(putSplit([], 1, two("a", "b"), "a"), 2, two("c", "d"), "d"));
  writeOpenSplit(session, { id: 2, tree: two("c", "d"), shown: true });
  const loaded = loadViewSplits(local, session);
  assert.deepEqual(loaded.splits.map((split) => split.id), [1, 2]);
  assert.deepEqual(loaded.open, { id: 2, tree: two("c", "d"), shown: true, focus: "d" });
  writeOpenSplit(session, { id: 2, tree: two("c", "d"), shown: false });
  assert.equal(loadViewSplits(local, session).open.shown, false, "left for a pane alone: Back to split view");
  writeOpenSplit(session, { id: 5, tree: two("x", "y"), shown: true });
  assert.deepEqual(loadViewSplits(local, session).open, { id: null, tree: null, shown: false, focus: null }, "a split gone meanwhile");
  writeOpenSplit(session, { id: null, tree: null, shown: false });
  assert.equal(session.store.has(OPEN_SPLIT_STORAGE_KEY), false);
  assert.deepEqual(loadViewSplits(broken, broken), { splits: [], open: { id: null, tree: null, shown: false, focus: null } });
  assert.deepEqual(loadViewSplits(null, null).splits, []);
});

test("the one view split an earlier version kept for the window joins the list", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  writeViewSplits(local, putSplit([], 1, two("a", "b"), "a"));
  session.store.set(VIEW_SPLIT_STORAGE_KEY, JSON.stringify({ tree: two("c", "d"), shown: true, focus: "d" }));
  const loaded = loadViewSplits(local, session);
  assert.deepEqual(loaded.splits.map((split) => [split.id, tiles(split.tree)]), [[1, ["a", "b"]], [2, ["c", "d"]]]);
  assert.deepEqual(loaded.open, { id: 2, tree: two("c", "d"), shown: true, focus: "d" });
  assert.equal(session.store.has(VIEW_SPLIT_STORAGE_KEY), false, "read once");
  assert.deepEqual(readViewSplits(local), loaded.splits, "and kept in the list");
  assert.deepEqual(JSON.parse(session.store.get(OPEN_SPLIT_STORAGE_KEY)), { id: 2, shown: true });
  // Left for a pane alone, it comes back that way.
  const later = memoryStorage();
  later.store.set(VIEW_SPLIT_STORAGE_KEY, JSON.stringify({ tree: two("e", "f"), shown: false, focus: "e" }));
  assert.equal(loadViewSplits(memoryStorage(), later).open.shown, false);
  // With all eight numbers taken it waits, kept, for one to close.
  const full = memoryStorage();
  writeViewSplits(full, Array.from({ length: 8 }, (_, index) => ({ id: index + 1, tree: two(`a${index}`, `b${index}`), focus: `a${index}` })));
  const waiting = memoryStorage();
  waiting.store.set(VIEW_SPLIT_STORAGE_KEY, JSON.stringify({ tree: two("g", "h"), shown: true, focus: "g" }));
  assert.equal(loadViewSplits(full, waiting).open.id, null);
  assert.equal(waiting.store.has(VIEW_SPLIT_STORAGE_KEY), true, "not dropped");
  writeViewSplits(full, readViewSplits(full).slice(1));
  assert.deepEqual(tiles(loadViewSplits(full, waiting).open.tree), ["g", "h"], "joins once a number is free");
  assert.equal(waiting.store.has(VIEW_SPLIT_STORAGE_KEY), false);
  // A legacy value that is no split is cleared.
  const bad = memoryStorage();
  bad.store.set(VIEW_SPLIT_STORAGE_KEY, JSON.stringify({ tree: "a" }));
  loadViewSplits(memoryStorage(), bad);
  assert.equal(bad.store.has(VIEW_SPLIT_STORAGE_KEY), false);
});
