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

// A font whose W is half as wide as the font size and whose ascent and
// descent are the font size.
const metrics = (font) => ({ charWidth: font / 2, charHeight: font });
// Two cells side by side, each 60 columns by 40 rows, with 10 px beside the
// screen across and 33 down.
const halves = [
  { width: 0.5, height: 1, cols: 60, rows: 40, extraX: 10, extraY: 33 },
  { width: 0.5, height: 1, cols: 60, rows: 40, extraX: 10, extraY: 33 },
];

test("a screen is drawn at whole device pixels: lines round up, the whole to CSS pixels", async () => {
  const { screenSize } = await import("../public/pane-grid.js");
  assert.deepEqual(screenSize({ charWidth: 6.3, charHeight: 12.2, cols: 10, rows: 10 }), { width: 63, height: 130 });
  assert.deepEqual(screenSize({ charWidth: 6.3, charHeight: 12.2, cols: 10, rows: 10, dpr: 2 }), { width: 63, height: 125 });
  // 13.5px and 14px lines are both 14px tall.
  assert.equal(screenSize({ ...metrics(13.5), cols: 60, rows: 40 }).height, screenSize({ ...metrics(14), cols: 60, rows: 40 }).height);
});

test("the board is the tab's shape in the cells' font, the largest that fits the room", async () => {
  const { GRID_MAX_FONT, letterbox } = await import("../public/pane-grid.js");
  assert.equal(GRID_MAX_FONT, 32);
  const fit = (room) => letterbox({ room, cells: halves, metrics, maxFont: GRID_MAX_FONT });
  // A wide room: the height binds (14px lines: 560 + 33), the board is narrower than the room.
  assert.deepEqual(fit({ width: 1200, height: 600 }), { font: 14, width: 861, height: 594 });
  // A narrow one: the width binds (9.5px: 285 + 10 per half).
  assert.deepEqual(fit({ width: 600, height: 600 }), { font: 9.5, width: 591, height: 434 });
  // A large room grows the font to the grid's cap, whatever font one pane is read at.
  assert.equal(fit({ width: 9000, height: 9000 }).font, 32);
  // Too small for the least font: the board is cut to the room.
  assert.deepEqual(fit({ width: 40, height: 40 }), { font: 4, width: 40, height: 40 });
  // No cell with a terminal yet: nothing to fit to.
  assert.equal(letterbox({ room: { width: 600, height: 600 }, cells: [{ width: 1, height: 1, cols: 0, rows: 0, extraX: 0, extraY: 0 }], metrics, maxFont: 32 }), null);
});

test("a stacked layout makes the board as tall as its tallest column needs", async () => {
  const { letterbox } = await import("../public/pane-grid.js");
  const cells = [
    { width: 0.5, height: 1, cols: 58, rows: 38, extraX: 10, extraY: 33 },
    { width: 0.5, height: 0.5, cols: 58, rows: 18, extraX: 10, extraY: 33 },
    { width: 0.5, height: 0.5, cols: 58, rows: 18, extraX: 10, extraY: 33 },
  ];
  // At 10px the stack needs (180 + 33) * 2 = 426 px, more than the tall cell's 380 + 33.
  assert.deepEqual(letterbox({ room: { width: 601, height: 427 }, cells, metrics, maxFont: 32 }), { font: 10, width: 601, height: 427 });
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


test("a font chosen for the grid shrinks the board; a larger one stays at the fit", async () => {
  const { GRID_MAX_FONT, letterbox } = await import("../public/pane-grid.js");
  const room = { width: 1200, height: 600 };
  const fit = (maxFont) => letterbox({ room, cells: halves, metrics, maxFont });
  assert.equal(fit(GRID_MAX_FONT).font, 14);
  const smaller = fit(10);
  assert.equal(smaller.font, 10);
  assert.ok(smaller.width < fit(GRID_MAX_FONT).width && smaller.height < fit(GRID_MAX_FONT).height);
  assert.deepEqual(fit(20), fit(GRID_MAX_FONT));
  assert.equal(fit(10.5).font, 10.5);
});
