import test from "node:test";
import assert from "node:assert/strict";
import { gridCells } from "../public/pane-grid.js";

test("panes sit at Herdr's rects as shares of the tab, matched by the id after the scope", () => {
  const layout = {
    area: { x: 0, y: 0, width: 100, height: 40 },
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 50, height: 40 } },
      { pane_id: "w1:p2", rect: { x: 50, y: 0, width: 50, height: 20 } },
      { pane_id: "w1:p3", rect: { x: 50, y: 20, width: 50, height: 20 } },
    ],
  };
  const { cells } = gridCells(layout, ["hs_x~w1:p1", "hs_x~w1:p2", "hs_x~w1:p3"]);
  assert.equal(cells.length, 3);
  const second = cells.find((cell) => cell.paneId === "hs_x~w1:p2");
  assert.deepEqual([second.left, second.top, second.width, second.height], [0.5, 0, 0.5, 0.5]);
  assert.deepEqual([second.cols, second.rows], [50, 20]);
});

test("without a layout the panes share an even grid", () => {
  const { cells } = gridCells(null, ["a", "b", "c", "d"]);
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map((cell) => [cell.left, cell.top]), [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]]);
});

test("a pane the layout does not list yet is left out", () => {
  const layout = { area: { x: 0, y: 0, width: 10, height: 10 }, panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 10, height: 10 } }] };
  assert.deepEqual(gridCells(layout, ["w1:p1", "w1:p2"]).cells.map((cell) => cell.paneId), ["w1:p1"]);
});

test("a cell dropped in another's middle swaps; near an edge it goes on that side", async () => {
  const { REARRANGE_EDGE_BAND, rearrangeDrop } = await import("../public/pane-grid.js");
  const box = { left: 100, top: 50, width: 200, height: 100 };
  assert.equal(REARRANGE_EDGE_BAND, 0.3);
  assert.deepEqual(rearrangeDrop(box, 200, 100), { kind: "swap", preview: { left: 100, top: 50, width: 200, height: 100 } });
  // The middle 40% each way swaps.
  assert.equal(rearrangeDrop(box, 100 + 200 * 0.31, 100).kind, "swap");
  assert.equal(rearrangeDrop(box, 200, 50 + 100 * 0.69).kind, "swap");
  assert.deepEqual(rearrangeDrop(box, 110, 100), { kind: "side", side: "left", preview: { left: 100, top: 50, width: 100, height: 100 } });
  assert.deepEqual(rearrangeDrop(box, 290, 100), { kind: "side", side: "right", preview: { left: 200, top: 50, width: 100, height: 100 } });
  assert.deepEqual(rearrangeDrop(box, 200, 55), { kind: "side", side: "up", preview: { left: 100, top: 50, width: 200, height: 50 } });
  assert.deepEqual(rearrangeDrop(box, 200, 145), { kind: "side", side: "down", preview: { left: 100, top: 100, width: 200, height: 50 } });
  // Outside, or a box of no size, is no drop.
  assert.equal(rearrangeDrop(box, 99, 100), null);
  assert.equal(rearrangeDrop(box, 200, 151), null);
  assert.equal(rearrangeDrop({ left: 0, top: 0, width: 0, height: 10 }, 0, 5), null);
});

// Two cells side by side, each 60 columns by 40 rows of a 6 x 12 px font at
// 12px (360 x 480), with 10 px beside the screen across and 33 down.
const halves = (screens) => [
  { width: 0.5, height: 1, extraX: 10, extraY: 33, screens },
  { width: 0.5, height: 1, extraX: 10, extraY: 33, screens },
];

test("the board is the tab's shape in the cells' font, the largest that fits the room", async () => {
  const { letterbox } = await import("../public/pane-grid.js");
  const screens = new Map([[12, { width: 360, height: 480 }]]);
  // A wide room: the height binds, and the board is narrower than the room.
  assert.deepEqual(letterbox({ room: { width: 1200, height: 600 }, cells: halves(screens), maxFont: 12 }),
    { font: 12, width: 741, height: 514, exact: true });
  // A narrow one: a smaller font, its size guessed until the cells are drawn at it.
  const narrow = letterbox({ room: { width: 600, height: 600 }, cells: halves(screens), maxFont: 12 });
  assert.equal(narrow.font, 9.5);
  assert.equal(narrow.exact, false);
  assert.ok(narrow.width <= 600 && narrow.height <= 600);
  // Drawn at 9.5 a little larger than guessed, it no longer fits: one step
  // down, guessed from what 9.5 drew.
  screens.set(9.5, { width: 290, height: 390 });
  assert.deepEqual(letterbox({ room: { width: 600, height: 600 }, cells: halves(screens), maxFont: 12 }),
    { font: 9, width: 571, height: 404, exact: false });
  // Never past the font the user chose, nor below the least.
  assert.equal(letterbox({ room: { width: 5000, height: 5000 }, cells: halves(screens), maxFont: 12 }).font, 12);
  const tiny = letterbox({ room: { width: 40, height: 40 }, cells: halves(screens), maxFont: 12 });
  assert.deepEqual([tiny.font, tiny.width, tiny.height], [4, 40, 40]);
  // No cell drawn yet: nothing to fit to.
  assert.equal(letterbox({ room: { width: 600, height: 600 }, cells: halves(new Map()), maxFont: 12 }), null);
});

test("a stacked layout makes the board as tall as its tallest column needs", async () => {
  const { letterbox } = await import("../public/pane-grid.js");
  const at = (width, height) => new Map([[10, { width, height }]]);
  const cells = [
    { width: 0.5, height: 1, extraX: 10, extraY: 33, screens: at(300, 400) },
    { width: 0.5, height: 0.5, extraX: 10, extraY: 33, screens: at(300, 190) },
    { width: 0.5, height: 0.5, extraX: 10, extraY: 33, screens: at(300, 190) },
  ];
  // The stack needs (190 + 33) * 2 = 446 px, more than the tall cell's 433.
  assert.deepEqual(letterbox({ room: { width: 1000, height: 1000 }, cells, maxFont: 10 }), { font: 10, width: 621, height: 447, exact: true });
});

test("a moved cell is put back where it was by a translate and a scale", async () => {
  const { flipDelta } = await import("../public/pane-grid.js");
  assert.deepEqual(flipDelta({ left: 0, top: 0, width: 200, height: 100 }, { left: 200, top: 100, width: 100, height: 100 }),
    { x: -200, y: -100, scaleX: 2, scaleY: 1 });
  // Where it was (to half a pixel), or no box to slide to: nothing to do.
  assert.equal(flipDelta({ left: 10, top: 10, width: 100, height: 50 }, { left: 10.3, top: 10, width: 100.2, height: 50 }), null);
  assert.equal(flipDelta(null, { left: 0, top: 0, width: 10, height: 10 }), null);
  assert.equal(flipDelta({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 0 }), null);
});
