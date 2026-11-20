import assert from "node:assert/strict";
import test from "node:test";
import { decidePaneSwipe, paneTabOrder, swipeTarget } from "../public/app/pane-tabs.js";

const panes = (...ids) => ids.map((paneId) => ({ paneId }));
const rect = (x, y, width, height) => ({ x, y, width, height });

test("tabs follow Herdr's layout: the top row left to right, then the row below", () => {
  const layout = {
    area: rect(0, 0, 200, 60),
    panes: [
      { pane_id: "w:p3", rect: rect(100, 30, 100, 30) },
      { pane_id: "w:p1", rect: rect(0, 0, 100, 60) },
      { pane_id: "w:p2", rect: rect(100, 0, 100, 30) },
    ],
  };
  assert.deepEqual(paneTabOrder(layout, panes("w:p3", "w:p2", "w:p1")).map((pane) => pane.paneId), ["w:p1", "w:p2", "w:p3"]);
});

test("a pane the layout does not have yet goes last, and no layout keeps the snapshot's order", () => {
  const layout = { area: rect(0, 0, 100, 10), panes: [{ pane_id: "w:p2", rect: rect(0, 0, 100, 10) }] };
  assert.deepEqual(paneTabOrder(layout, panes("w:p9", "w:p2")).map((pane) => pane.paneId), ["w:p2", "w:p9"]);
  assert.deepEqual(paneTabOrder(undefined, panes("w:p2", "w:p1")).map((pane) => pane.paneId), ["w:p2", "w:p1"]);
});

test("a swipe to the left shows the next pane, to the right the one before, none past the ends", () => {
  const ids = ["a", "b", "c"];
  assert.equal(swipeTarget(ids, "a", "left"), "b");
  assert.equal(swipeTarget(ids, "b", "right"), "a");
  assert.equal(swipeTarget(ids, "c", "left"), null);
  assert.equal(swipeTarget(ids, "a", "right"), null);
  assert.equal(swipeTarget(ids, "z", "left"), null);
});

test("a swipe is a long sideways drag or a quick flick, never a scroll", () => {
  assert.equal(decidePaneSwipe({ dx: -120, dy: 10, vx: -0.1, width: 400 }), "left");
  assert.equal(decidePaneSwipe({ dx: 120, dy: 10, vx: 0.1, width: 400 }), "right");
  // short but quick
  assert.equal(decidePaneSwipe({ dx: -50, dy: 5, vx: -0.8, width: 400 }), "left");
  // short and slow
  assert.equal(decidePaneSwipe({ dx: -50, dy: 5, vx: -0.1, width: 400 }), null);
  // a twitch, however quick
  assert.equal(decidePaneSwipe({ dx: -20, dy: 0, vx: -2, width: 400 }), null);
  // mostly up or down: a scroll
  assert.equal(decidePaneSwipe({ dx: -150, dy: 120, vx: -1, width: 400 }), null);
  // thrown back the other way at the end
  assert.equal(decidePaneSwipe({ dx: -60, dy: 0, vx: 0.9, width: 400 }), null);
});
