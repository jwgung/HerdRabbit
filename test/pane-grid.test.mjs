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
