import test from "node:test";
import assert from "node:assert/strict";
import { gridCells } from "../public/pane-grid.js";
import {
  MAX_TILES,
  VIEW_SPLIT_STORAGE_KEY,
  addTile,
  layoutRects,
  paneDropKind,
  parseTree,
  prune,
  readViewSplit,
  removeTile,
  renameTiles,
  tiles,
  writeViewSplit,
} from "../public/view-split.js";

test("a drop on the pane alone starts a view split of two tiles on that side", () => {
  assert.deepEqual(addTile(null, "a", "b", "right"), { dir: "right", first: "a", second: "b", ratio: 0.5 });
  assert.deepEqual(addTile(null, "a", "b", "left"), { dir: "right", first: "b", second: "a", ratio: 0.5 });
  assert.deepEqual(addTile(null, "a", "b", "down"), { dir: "down", first: "a", second: "b", ratio: 0.5 });
  assert.deepEqual(addTile(null, "a", "b", "up"), { dir: "down", first: "b", second: "a", ratio: 0.5 });
});

test("a drop on a tile splits that tile only", () => {
  const two = addTile(null, "a", "b", "right");
  const three = addTile(two, "b", "c", "down");
  assert.deepEqual(three, { dir: "right", first: "a", second: { dir: "down", first: "b", second: "c", ratio: 0.5 }, ratio: 0.5 });
  assert.deepEqual(tiles(three), ["a", "b", "c"]);
});

test("a pane already a tile, a missing target, an unknown side or a full split change nothing", () => {
  const two = addTile(null, "a", "b", "right");
  assert.equal(addTile(two, "a", "b", "down"), two);
  assert.equal(addTile(two, "x", "c", "down"), two);
  assert.equal(addTile(two, "a", "c", "middle"), two);
  assert.equal(addTile(null, "a", "a", "left"), null);
  let tree = null;
  const ids = ["p0", "p1", "p2", "p3", "p4", "p5", "p6"];
  for (let index = 1; index < ids.length; index += 1) tree = addTile(tree, ids[index - 1], ids[index], "right");
  assert.equal(tiles(tree).length, MAX_TILES);
  assert.ok(!tiles(tree).includes("p6"), "the seventh is refused");
});

test("removing a tile collapses its node, and one tile left is no view split", () => {
  const three = addTile(addTile(null, "a", "b", "right"), "b", "c", "down");
  assert.deepEqual(removeTile(three, "b"), { dir: "right", first: "a", second: "c", ratio: 0.5 });
  assert.equal(removeTile(removeTile(three, "b"), "a"), null);
  assert.deepEqual(removeTile(three, "zzz"), three);
});

test("prune drops tiles whose panes are gone", () => {
  const three = addTile(addTile(null, "a", "b", "right"), "b", "c", "down");
  assert.deepEqual(prune(three, ["a", "c", "other"]), { dir: "right", first: "a", second: "c", ratio: 0.5 });
  assert.equal(prune(three, ["a"]), null);
  assert.equal(prune(null, ["a"]), null);
});

test("a pane Herdr moved keeps its tile under its new id", () => {
  const two = addTile(null, "a", "b", "right");
  assert.deepEqual(tiles(renameTiles(two, [{ from: "b", to: "b2" }])), ["a", "b2"]);
  assert.equal(renameTiles(two, []), two);
  assert.equal(renameTiles(two, [{ from: "b", to: "a" }]), null, "two tiles of one pane are one");
});

test("the rects cover the area in whole cells and place through the grid's own math", () => {
  const three = addTile(addTile(null, "a", "b", "right"), "b", "c", "down");
  const layout = layoutRects(three);
  assert.deepEqual(layout.area, { x: 0, y: 0, width: 240, height: 80 });
  assert.deepEqual(layout.panes, [
    { pane_id: "a", rect: { x: 0, y: 0, width: 120, height: 80 } },
    { pane_id: "b", rect: { x: 120, y: 0, width: 120, height: 40 } },
    { pane_id: "c", rect: { x: 120, y: 40, width: 120, height: 40 } },
  ]);
  for (const { rect } of layout.panes) for (const value of Object.values(rect)) assert.ok(Number.isInteger(value));
  const { cells } = gridCells(layout, ["a", "b", "c"]);
  assert.deepEqual(cells.map((cell) => [cell.paneId, cell.left, cell.top, cell.width, cell.height]), [
    ["a", 0, 0, 0.5, 1], ["b", 0.5, 0, 0.5, 0.5], ["c", 0.5, 0.5, 0.5, 0.5],
  ]);
  assert.equal(layoutRects(null), null);
  assert.equal(layoutRects("a"), null);
});

test("an odd size still covers the area exactly", () => {
  const layout = layoutRects({ dir: "right", first: "a", second: "b", ratio: 0.5 }, { x: 0, y: 0, width: 7, height: 3 });
  assert.equal(layout.panes[0].rect.width + layout.panes[1].rect.width, 7);
});

test("only a well-formed tree is read back", () => {
  const two = { dir: "right", first: "a", second: "b", ratio: 0.5 };
  assert.deepEqual(parseTree(two), two);
  assert.deepEqual(parseTree({ ...two, ratio: 7 }), two, "a silly ratio is evened");
  assert.equal(parseTree("a"), null);
  assert.equal(parseTree({ dir: "sideways", first: "a", second: "b" }), null);
  assert.equal(parseTree({ dir: "right", first: "a", second: "a" }), null);
  assert.equal(parseTree({ dir: "right", first: "a", second: 3 }), null);
  assert.equal(parseTree(null), null);
});

test("the view split is kept per window and survives bad storage", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  const tree = addTile(null, "a", "b", "right");
  writeViewSplit(storage, { tree, shown: true, focus: "b" });
  assert.deepEqual(readViewSplit(storage), { tree, shown: true, focus: "b" });
  writeViewSplit(storage, { tree, shown: false, focus: "gone" });
  assert.deepEqual(readViewSplit(storage), { tree, shown: false, focus: "a" }, "a focus not a tile falls to the first");
  writeViewSplit(storage, { tree: null, shown: false, focus: null });
  assert.equal(store.has(VIEW_SPLIT_STORAGE_KEY), false);
  store.set(VIEW_SPLIT_STORAGE_KEY, "{not json");
  assert.deepEqual(readViewSplit(storage), { tree: null, shown: false, focus: null });
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.deepEqual(readViewSplit(broken), { tree: null, shown: false, focus: null });
  assert.doesNotThrow(() => writeViewSplit(broken, { tree, shown: true }));
  assert.deepEqual(readViewSplit(null), { tree: null, shown: false, focus: null });
});

const local = { server_id: "local", herdr_session_id: "hs_a" };
const laptop = { server_id: "laptop", herdr_session_id: "laptop!hs_a" };
const snapshot = {
  workspaces: [{ workspace_id: "w1", ...local }, { workspace_id: "w2", ...local }, { workspace_id: "laptop!w1", ...laptop }],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", ...local }, { tab_id: "w1:t2", workspace_id: "w1", ...local },
    { tab_id: "w1:t3", workspace_id: "w1", ...local }, { tab_id: "w2:t1", workspace_id: "w2", ...local },
    { tab_id: "laptop!w1:t1", workspace_id: "laptop!w1", ...laptop },
  ],
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", ...local }, { pane_id: "w1:p2", tab_id: "w1:t2", ...local },
    { pane_id: "w1:p3", tab_id: "w1:t3", ...local }, { pane_id: "w1:p4", tab_id: "w1:t3", ...local },
    { pane_id: "w2:p1", tab_id: "w2:t1", ...local }, { pane_id: "laptop!w1:p1", tab_id: "laptop!w1:t1", ...laptop },
  ],
};
const allowed = { paneMoveAllowed: () => true };

test("the same project merges in Herdr; another project is a view split on the pane alone only", () => {
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p1" }, { screen: "solo", ...allowed }), "move");
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p1" }, { screen: "grid", ...allowed }), "move");
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p1" }, { screen: "solo" }), null, "Herdr refuses: no drop");
  assert.equal(paneDropKind(snapshot, { tabId: "w2:t1", targetPaneId: "w1:p1" }, { screen: "solo", ...allowed }), "view");
  assert.equal(paneDropKind(snapshot, { tabId: "w2:t1", targetPaneId: "w1:p1" }, { screen: "grid", ...allowed }), null);
});

test("on a view split anything not a tile yet becomes one, its own project too", () => {
  const tileIds = ["w1:p1", "w2:p1"];
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p1" }, { screen: "tiles", tileIds, ...allowed }), "view");
  assert.equal(paneDropKind(snapshot, { tabId: "w2:t1", targetPaneId: "w1:p1" }, { screen: "tiles", tileIds, ...allowed }), null, "already a tile");
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p3" }, { screen: "tiles", tileIds, ...allowed }), null, "not on a tile");
  const full = ["w1:p1", "a", "b", "c", "d", "e"];
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p1" }, { screen: "tiles", tileIds: full, ...allowed }), null);
});

test("a split session, another machine's or the pane's own is no drop", () => {
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t3", targetPaneId: "w2:p1" }, { screen: "solo", ...allowed }), null);
  assert.equal(paneDropKind(snapshot, { tabId: "laptop!w1:t1", targetPaneId: "w1:p1" }, { screen: "solo", ...allowed }), null);
  assert.equal(paneDropKind(snapshot, { tabId: "w2:t1", targetPaneId: "laptop!w1:p1" }, { screen: "solo", ...allowed }), null);
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t1", targetPaneId: "w1:p1" }, { screen: "solo", ...allowed }), null);
});
