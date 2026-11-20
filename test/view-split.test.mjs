import test from "node:test";
import assert from "node:assert/strict";
import { gridCells } from "../public/pane-grid.js";
import {
  MAX_TILES,
  PICK_TILE,
  VIEW_SPLIT_STORAGE_KEY,
  addPickTile,
  addTile,
  applyToHerdrPlan,
  evenTree,
  evensHerdrTabAfter,
  fillPick,
  layoutRects,
  moveTile,
  paneDropKind,
  parseTree,
  pickChoices,
  prune,
  readViewSplit,
  removeTile,
  renameTiles,
  swapTiles,
  tiles,
  writeViewSplit,
} from "../public/view-split.js";

// The widths (or heights) of the tiles in VIEW_AREA, left to right and top to bottom.
const sizes = (tree, key = "width") => layoutRects(tree).panes.map(({ rect }) => rect[key]);

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

test("any tab dropped on another pane is a tile of this window's split view, never a Herdr move", () => {
  // The same workspace, another workspace, another machine: all a view tile, on any screen.
  for (const screen of ["solo", "grid"]) {
    assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p1" }, { screen }), "view", `${screen}: same workspace`);
    assert.equal(paneDropKind(snapshot, { tabId: "w2:t1", targetPaneId: "w1:p1" }, { screen }), "view", `${screen}: another workspace`);
    assert.equal(paneDropKind(snapshot, { tabId: "laptop!w1:t1", targetPaneId: "w1:p1" }, { screen }), "view", `${screen}: another machine`);
  }
  const older = { ...snapshot, servers: [{ id: "laptop", pane_layout: false }] };
  assert.equal(paneDropKind(older, { tabId: "w1:t2", targetPaneId: "laptop!w1:p1" }, { screen: "solo" }), "view",
    "a PC that cannot lay out its panes still gives a tile");
});

test("on a view split anything not a tile yet becomes one beside a tile", () => {
  const tileIds = ["w1:p1", "w2:p1"];
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p1" }, { screen: "tiles", tileIds }), "view");
  assert.equal(paneDropKind(snapshot, { tabId: "laptop!w1:t1", targetPaneId: "w2:p1" }, { screen: "tiles", tileIds }), "view");
  assert.equal(paneDropKind(snapshot, { tabId: "w2:t1", targetPaneId: "w1:p1" }, { screen: "tiles", tileIds }), null, "already a tile");
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p3" }, { screen: "tiles", tileIds }), null, "not on a tile");
  const full = ["w1:p1", "a", "b", "c", "d", "e"];
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t2", targetPaneId: "w1:p1" }, { screen: "tiles", tileIds: full }), null, "full");
});

test("a tab dropped on its own pane splits it, alone or as a tile; a split tab is no drop", () => {
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t1", targetPaneId: "w1:p1" }, { screen: "solo" }), "self");
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t1", targetPaneId: "w1:p1" }, { screen: "tiles", tileIds: ["w1:p1", "w2:p1"] }), "self");
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t1", targetPaneId: "w1:p1" }, { screen: "tiles", tileIds: ["w1:p1", "a", "b", "c", "d", "e"] }), null, "full");
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t3", targetPaneId: "w2:p1" }, { screen: "solo" }), null, "a split tab");
  assert.equal(paneDropKind(snapshot, { tabId: "w1:t3", targetPaneId: "w1:p3" }, { screen: "solo" }), null, "its own pane, of a split tab");
});

test("a drop on its own pane opens a picker tile on that edge, which a pane fills or Cancel takes out", () => {
  assert.deepEqual(addPickTile(null, "a", "left"), { dir: "right", first: PICK_TILE, second: "a", ratio: 0.5 });
  assert.deepEqual(addPickTile(null, "a", "down"), { dir: "down", first: "a", second: PICK_TILE, ratio: 0.5 });
  // On a tile of three in a row: the picker is a fourth, and the row is evened.
  const row = evenTree(addTile(addTile(null, "a", "b", "right"), "b", "c", "right"));
  const picking = addPickTile(row, "c", "right");
  assert.deepEqual(tiles(picking), ["a", "b", "c", PICK_TILE]);
  assert.deepEqual(sizes(picking), [60, 60, 60, 60]);
  // A second picker replaces the first.
  assert.deepEqual(tiles(addPickTile(picking, "a", "up")), [PICK_TILE, "a", "b", "c"]);
  // Filled: the pane takes the picker's place.
  assert.deepEqual(tiles(fillPick(picking, "d")), ["a", "b", "c", "d"]);
  assert.equal(fillPick(picking, "a"), picking, "a tile already");
  assert.equal(fillPick(row, "d"), row, "no picker");
  // Cancel split: the picker goes, the rest evens.
  assert.deepEqual(sizes(evenTree(removeTile(picking, PICK_TILE))), [80, 80, 80]);
  assert.equal(removeTile(addPickTile(null, "a", "left"), PICK_TILE), null, "the pane alone again");
  // Full: no room for a picker.
  const six = ["c", "d", "e", "f"].reduce((tree, id, index) => addTile(tree, ["b", "c", "d", "e"][index], id, "right"), addTile(null, "a", "b", "right"));
  assert.equal(addPickTile(six, "a", "left"), six);
});

test("adding or removing a tile evens the split view (evenTree after each change)", () => {
  const added = evenTree(addTile(evenTree(addTile(null, "a", "b", "right")), "b", "c", "right"));
  assert.deepEqual(sizes(added), [80, 80, 80]);
  assert.deepEqual(sizes(evenTree(removeTile(added, "a"))), [120, 120]);
  const column = evenTree(addTile(added, "c", "d", "down"));
  assert.deepEqual(sizes(column), [80, 80, 80, 80]);
  assert.deepEqual(sizes(column, "height"), [80, 80, 40, 40]);
});

// A workspace of four single-pane tabs, one split tab, and another workspace.
const herdrSnapshot = {
  workspaces: [{ workspace_id: "w1", ...local }, { workspace_id: "w2", ...local }, { workspace_id: "laptop!w1", ...laptop }],
  tabs: ["t1", "t2", "t3", "t4", "t5"].map((id) => ({ tab_id: `w1:${id}`, workspace_id: "w1", ...local }))
    .concat([{ tab_id: "w2:t1", workspace_id: "w2", ...local }, { tab_id: "laptop!w1:t1", workspace_id: "laptop!w1", ...laptop },
      { tab_id: "w1:t9", workspace_id: "w1", ...local, herdr_session_id: "hs_other" }]),
  panes: ["1", "2", "3", "4"].map((n) => ({ pane_id: `w1:p${n}`, tab_id: `w1:t${n}`, ...local }))
    .concat([{ pane_id: "w1:p5", tab_id: "w1:t5", ...local }, { pane_id: "w1:p6", tab_id: "w1:t5", ...local },
      { pane_id: "w2:p1", tab_id: "w2:t1", ...local }, { pane_id: "laptop!w1:p1", tab_id: "laptop!w1:t1", ...laptop },
      { pane_id: "w1:p9", tab_id: "w1:t9", ...local, herdr_session_id: "hs_other" }]),
};

test("Apply to Herdr is offered only for tiles of one workspace, session and machine, each alone in its tab", () => {
  const two = addTile(null, "w1:p1", "w1:p2", "right");
  assert.deepEqual(applyToHerdrPlan(herdrSnapshot, two), { anchor: "w1:p1", moves: [{ paneId: "w1:p2", targetPaneId: "w1:p1", side: "right" }] });
  assert.equal(applyToHerdrPlan(herdrSnapshot, addTile(null, "w1:p1", "w2:p1", "right")), null, "another workspace");
  assert.equal(applyToHerdrPlan(herdrSnapshot, addTile(null, "w1:p1", "laptop!w1:p1", "right")), null, "another machine");
  assert.equal(applyToHerdrPlan(herdrSnapshot, addTile(null, "w1:p1", "w1:p9", "right")), null, "another Herdr session");
  assert.equal(applyToHerdrPlan(herdrSnapshot, addTile(null, "w1:p1", "w1:p5", "right")), null, "a pane of a split tab");
  assert.equal(applyToHerdrPlan(herdrSnapshot, addPickTile(null, "w1:p1", "right")), null, "a picker waiting");
  assert.equal(applyToHerdrPlan(herdrSnapshot, addTile(null, "w1:p1", "w1:gone", "right")), null, "a pane not listed (machine away)");
  assert.equal(applyToHerdrPlan(herdrSnapshot, null), null);
  // A connected PC applies only when it lays out its panes from here.
  const laptopTwo = {
    ...herdrSnapshot, servers: [{ id: "laptop", pane_layout: true }],
    tabs: [...herdrSnapshot.tabs, { tab_id: "laptop!w1:t2", workspace_id: "laptop!w1", ...laptop }],
    panes: [...herdrSnapshot.panes, { pane_id: "laptop!w1:p2", tab_id: "laptop!w1:t2", ...laptop }],
  };
  const remote = addTile(null, "laptop!w1:p1", "laptop!w1:p2", "down");
  assert.ok(applyToHerdrPlan(laptopTwo, remote));
  assert.equal(applyToHerdrPlan({ ...laptopTwo, servers: [] }, remote), null);
});

// Replays a plan the way Herdr splits a pane: the target's leaf becomes a
// node of the target and the moved pane, right of or under it.
function herdrReplay(plan) {
  let tree = plan.anchor;
  for (const { paneId, targetPaneId, side } of plan.moves) {
    const split = (node) => (typeof node === "string"
      ? (node === targetPaneId ? { dir: side, first: node, second: paneId } : node)
      : { ...node, first: split(node.first), second: split(node.second) });
    tree = split(tree);
  }
  const shape = (node) => (typeof node === "string" ? node : { dir: node.dir, first: shape(node.first), second: shape(node.second) });
  return shape(tree);
}
const shapeOf = (node) => (typeof node === "string" ? node : { dir: node.dir, first: shapeOf(node.first), second: shapeOf(node.second) });

test("the apply plan rebuilds the view split's arrangement with Herdr's right and down splits", () => {
  const trees = [
    // a | (b over c)
    addTile(addTile(null, "w1:p1", "w1:p2", "right"), "w1:p2", "w1:p3", "down"),
    // (a | b) over c, built from a drop on the left and on top
    addTile(addTile(null, "w1:p2", "w1:p1", "left"), "w1:p2", "w1:p3", "down"),
    // ((a | b) over (c | d))
    { dir: "down", ratio: 0.5,
      first: { dir: "right", first: "w1:p1", second: "w1:p2", ratio: 0.5 },
      second: { dir: "right", first: "w1:p3", second: "w1:p4", ratio: 0.5 } },
    // (a | b) | c, nested to the left
    { dir: "right", ratio: 0.5, first: { dir: "right", first: "w1:p3", second: "w1:p1", ratio: 0.5 }, second: "w1:p2" },
  ];
  for (const tree of trees) {
    const plan = applyToHerdrPlan(herdrSnapshot, tree);
    assert.equal(plan.anchor, tiles(tree)[0]);
    assert.equal(plan.moves.length, tiles(tree).length - 1);
    for (const move of plan.moves) assert.ok(move.side === "right" || move.side === "down");
    assert.deepEqual(herdrReplay(plan), shapeOf(tree));
  }
});

test("the picker groups the tabs by this workspace, other workspaces and other machines", () => {
  const groups = pickChoices(herdrSnapshot, { anchorPaneId: "w1:p1", tileIds: ["w1:p1", PICK_TILE, "w1:p2"] });
  assert.deepEqual(groups.here.map((choice) => choice.paneId), ["w1:p3", "w1:p4", "w1:p5"], "tiles left out");
  assert.deepEqual(groups.here.find((choice) => choice.tabId === "w1:t5"), { tabId: "w1:t5", paneId: "w1:p5", paneCount: 2 });
  assert.deepEqual(groups.workspaces.map((choice) => choice.paneId), ["w2:p1", "w1:p9"], "another workspace or Herdr session");
  assert.deepEqual(groups.machines.map((choice) => choice.paneId), ["laptop!w1:p1"]);
  // A split tab offers the pane asked for, else the first that is no tile.
  const preferred = pickChoices(herdrSnapshot, { anchorPaneId: "w1:p1", preferredPane: (tabId) => (tabId === "w1:t5" ? "w1:p6" : null) });
  assert.equal(preferred.here.find((choice) => choice.tabId === "w1:t5").paneId, "w1:p6");
  const partly = pickChoices(herdrSnapshot, { anchorPaneId: "w1:p1", tileIds: ["w1:p5"] });
  assert.equal(partly.here.find((choice) => choice.tabId === "w1:t5").paneId, "w1:p6");
});

test("HerdRabbit evens a Herdr split tab only after changing it itself", () => {
  for (const action of ["split", "close", "move-out", "apply"]) assert.equal(evensHerdrTabAfter(action, 3), true, action);
  assert.equal(evensHerdrTabAfter("close", 1), false, "one pane left is no split");
  for (const action of ["swap", "relocate", "zoom", "resize", "snapshot"]) assert.equal(evensHerdrTabAfter(action, 3), false, action);
});

test("two tiles trade places and nothing else moves", () => {
  const three = addTile(addTile(null, "a", "b", "right"), "b", "c", "down");
  assert.deepEqual(swapTiles(three, "a", "c"), { dir: "right", first: "c", second: { dir: "down", first: "b", second: "a", ratio: 0.5 }, ratio: 0.5 });
  assert.deepEqual(swapTiles(swapTiles(three, "a", "c"), "c", "a"), three);
  // Not a tile, or the same tile: unchanged.
  assert.equal(swapTiles(three, "a", "z"), three);
  assert.equal(swapTiles(three, "a", "a"), three);
  assert.equal(swapTiles(null, "a", "b"), null);
});

test("a tile moves next to another on any side, taking half of it", () => {
  // a | (b over c): a goes under c.
  const three = addTile(addTile(null, "a", "b", "right"), "b", "c", "down");
  const moved = moveTile(three, "a", "c", "down");
  assert.deepEqual(moved, { dir: "down", first: "b", second: { dir: "down", first: "c", second: "a", ratio: 0.5 }, ratio: 0.5 });
  assert.deepEqual(tiles(moved), ["b", "c", "a"]);
  assert.deepEqual(moveTile(three, "c", "a", "left"),
    { dir: "right", first: { dir: "right", first: "c", second: "a", ratio: 0.5 }, second: "b", ratio: 0.5 });
  assert.deepEqual(moveTile(three, "c", "b", "up"),
    { dir: "right", first: "a", second: { dir: "down", first: "c", second: "b", ratio: 0.5 }, ratio: 0.5 });
  // Of two tiles, one goes on any side of the other.
  const two = addTile(null, "a", "b", "right");
  assert.deepEqual(moveTile(two, "a", "b", "right"), { dir: "right", first: "b", second: "a", ratio: 0.5 });
  assert.deepEqual(moveTile(two, "a", "b", "down"), { dir: "down", first: "b", second: "a", ratio: 0.5 });
  assert.deepEqual(moveTile(two, "b", "a", "up"), { dir: "down", first: "b", second: "a", ratio: 0.5 });
  // Unchanged: onto itself, a pane that is no tile, a side that is none.
  assert.equal(moveTile(three, "a", "a", "left"), three);
  assert.equal(moveTile(three, "z", "a", "left"), three);
  assert.equal(moveTile(three, "a", "z", "left"), three);
  assert.equal(moveTile(three, "a", "b", "middle"), three);
  // Every rearranged tree is still one a reload reads back.
  const full = ["c", "d", "e", "f"].reduce((tree, id, index) => addTile(tree, ["a", "b", "c", "d"][index], id, "right"), two);
  assert.equal(tiles(full).length, MAX_TILES);
  for (const tree of [moveTile(full, "a", "f", "down"), swapTiles(full, "a", "f"), moved]) {
    assert.deepEqual(parseTree(JSON.parse(JSON.stringify(tree))), tree);
  }
});


test("evening out gives every tile of a row the same width, however it was nested", () => {
  // a | b, then b split again: a half and two quarters until evened out.
  const three = addTile(addTile(null, "a", "b", "right"), "b", "c", "right");
  assert.deepEqual(sizes(three), [120, 60, 60]);
  assert.deepEqual(sizes(evenTree(three)), [80, 80, 80]);
  // Nested the other way, (a | b) | c, the row is the same three.
  const leftNested = addTile(addTile(null, "a", "b", "right"), "a", "c", "left");
  assert.deepEqual(sizes(evenTree(leftNested)), [80, 80, 80]);
  // Four and six in a row.
  const four = ["c", "d"].reduce((tree, id, index) => addTile(tree, ["b", "c"][index], id, "right"), addTile(null, "a", "b", "right"));
  assert.deepEqual(sizes(evenTree(four)), [60, 60, 60, 60]);
  const six = ["c", "d", "e", "f"].reduce((tree, id, index) => addTile(tree, ["b", "c", "d", "e"][index], id, "right"), addTile(null, "a", "b", "right"));
  assert.deepEqual(sizes(evenTree(six)), [40, 40, 40, 40, 40, 40]);
  // A column the same way, by height.
  const column = addTile(addTile(null, "a", "b", "down"), "b", "c", "down");
  assert.deepEqual(sizes(evenTree(column), "height").map(Math.round), [27, 27, 26]);
});

test("a split the other way inside a row counts as one tile of that row", () => {
  // a | (b over c): two columns, halves; the column's two tiles share it evenly.
  const tree = { dir: "right", first: "a", second: { dir: "down", first: "b", second: "c", ratio: 0.7 }, ratio: 0.25 };
  const evened = layoutRects(evenTree(tree)).panes;
  assert.deepEqual(evened.map(({ rect }) => rect.width), [120, 120, 120]);
  assert.deepEqual(evened.slice(1).map(({ rect }) => rect.height), [40, 40]);
  // a | (b over (c | d)): the inner row of two is evened inside its own box.
  const deep = { dir: "right", first: "a",
    second: { dir: "down", first: "b", second: { dir: "right", first: "c", second: "d", ratio: 0.8 }, ratio: 0.5 }, ratio: 0.5 };
  const cells = layoutRects(evenTree(deep)).panes;
  assert.deepEqual(cells.slice(2).map(({ rect }) => rect.width), [60, 60]);
});

test("evening out keeps the tiles where they are and an even tree as it is", () => {
  const three = addTile(addTile(null, "a", "b", "right"), "b", "c", "right");
  const evened = evenTree(three);
  assert.deepEqual(tiles(evened), tiles(three));
  assert.equal(evenTree(evened), evened, "already even: the same tree");
  const two = addTile(null, "a", "b", "right");
  assert.equal(evenTree(two), two);
  assert.equal(evenTree(null), null);
  // A reload reads an evened tree back as it was.
  assert.deepEqual(parseTree(JSON.parse(JSON.stringify(evened))), evened);
});

test("a picker waiting in a tile is not kept for a reload", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  writeViewSplit(storage, { tree: addPickTile(addTile(null, "a", "b", "right"), "b", "down"), shown: true, focus: "b" });
  assert.deepEqual(tiles(readViewSplit(storage).tree), ["a", "b"]);
  writeViewSplit(storage, { tree: addPickTile(null, "a", "right"), shown: true, focus: "a" });
  assert.equal(store.has(VIEW_SPLIT_STORAGE_KEY), false);
});
