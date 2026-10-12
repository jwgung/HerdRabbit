import test from "node:test";
import assert from "node:assert/strict";
import { cellAt, selectionRun } from "../public/terminal-selection.js";

test("a touch point lands on the cell under it, kept inside the grid", () => {
  const screen = { left: 10, top: 20, width: 800, height: 480 };
  // 80 columns of 10px, 24 rows of 20px.
  assert.deepEqual(cellAt(screen, 80, 24, 10, 20), { col: 0, row: 0 });
  assert.deepEqual(cellAt(screen, 80, 24, 10 + 125, 20 + 45), { col: 12, row: 2 });
  assert.deepEqual(cellAt(screen, 80, 24, 2_000, 2_000), { col: 79, row: 23 }, "past the edge is the last cell");
  assert.deepEqual(cellAt(screen, 80, 24, -5, -5), { col: 0, row: 0 });
});

test("a selection runs from the earlier cell to the later one, row by row", () => {
  assert.deepEqual(selectionRun({ col: 3, row: 1 }, { col: 3, row: 1 }, 80), { col: 3, row: 1, length: 1 });
  assert.deepEqual(selectionRun({ col: 3, row: 1 }, { col: 10, row: 1 }, 80), { col: 3, row: 1, length: 8 });
  assert.deepEqual(selectionRun({ col: 70, row: 1 }, { col: 4, row: 2 }, 80), { col: 70, row: 1, length: 15 }, "over the row's end");
  assert.deepEqual(selectionRun({ col: 4, row: 2 }, { col: 70, row: 1 }, 80), { col: 70, row: 1, length: 15 }, "dragged backwards");
});
