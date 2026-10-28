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
