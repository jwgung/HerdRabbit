import test from "node:test";
import assert from "node:assert/strict";
import { canEvenLayout, evenLayoutStep, layoutRects, layoutUnevenness } from "../src/even-layout.mjs";

// A small Herdr: a tree of splits, each a direction and a ratio, laid out in
// whole cells, and `pane resize` moving the nearest split on that side of the
// pane by a fraction of the area (and with it the panes inside, in proportion).
const leaf = (id) => ({ id });
const right = (ratio, a, b) => ({ dir: "right", ratio, a, b });
const down = (ratio, a, b) => ({ dir: "down", ratio, a, b });
const AREA = { x: 0, y: 0, width: 120, height: 40 };

function layoutOf(tree, { splits = true } = {}) {
  const panes = [];
  const found = [];
  const walk = (node, rect) => {
    if (node.id) { panes.push({ pane_id: node.id, rect }); return; }
    found.push({ direction: node.dir, ratio: node.ratio, rect });
    const across = node.dir === "right";
    const whole = across ? rect.width : rect.height;
    const first = Math.round(whole * node.ratio);
    walk(node.a, across ? { ...rect, width: first } : { ...rect, height: first });
    walk(node.b, across ? { ...rect, x: rect.x + first, width: whole - first } : { ...rect, y: rect.y + first, height: whole - first });
  };
  walk(tree, AREA);
  return { area: AREA, zoomed: false, panes, ...(splits ? { splits: found } : {}) };
}

function resize(tree, step) {
  const across = step.direction === "left" || step.direction === "right";
  const forward = step.direction === "right" || step.direction === "down";
  const path = [];
  const find = (node, rect) => {
    if (node.id) return node.id === step.paneId;
    const horizontal = node.dir === "right";
    const whole = horizontal ? rect.width : rect.height;
    const first = Math.round(whole * node.ratio);
    const rects = horizontal
      ? [{ ...rect, width: first }, { ...rect, x: rect.x + first, width: whole - first }]
      : [{ ...rect, height: first }, { ...rect, y: rect.y + first, height: whole - first }];
    for (const [side, child] of [["a", node.a], ["b", node.b]]) {
      path.push({ node, side, whole });
      if (find(child, side === "a" ? rects[0] : rects[1])) return true;
      path.pop();
    }
    return false;
  };
  find(tree, AREA);
  const hit = path.reverse().find(({ node, side }) => (node.dir === "right") === across && side === (forward ? "a" : "b"));
  if (!hit) return;
  const cells = step.amount * (across ? AREA.width : AREA.height) * (forward ? 1 : -1);
  hit.node.ratio = Math.min(0.95, Math.max(0.05, hit.node.ratio + cells / hit.whole));
}

// Runs the plan to its end, as HerdrClient.evenLayout does: the steps taken.
function evenOut(tree, { goal = null, splits = true, cap = 60 } = {}) {
  let steps = 0;
  for (let step = evenLayoutStep(layoutOf(tree, { splits }), goal); step && steps < cap; step = evenLayoutStep(layoutOf(tree, { splits }), goal)) {
    resize(tree, step);
    steps += 1;
  }
  return steps;
}
const sizes = (tree, key) => layoutOf(tree).panes.map((pane) => pane.rect[key]);
const within = (values, wanted) => values.forEach((value, index) => assert.ok(Math.abs(value - wanted[index]) <= 1, `${values} ≈ ${wanted}`));

test("four uneven columns made by splitting right again and again become four equal ones", () => {
  // 24 | 48 | 24 | 24
  const tree = right(0.2, leaf("w1:p1"), right(0.5, leaf("w1:p2"), right(0.5, leaf("w1:p3"), leaf("w1:p4"))));
  assert.ok(layoutUnevenness(layoutOf(tree)) > 0);
  const first = evenLayoutStep(layoutOf(tree));
  assert.deepEqual(first, { paneId: "w1:p1", direction: "right", amount: 6 / 120 }, "the outermost border first");
  const steps = evenOut(tree);
  assert.ok(steps > 0 && steps <= 6, `${steps} steps`);
  within(sizes(tree, "width"), [30, 30, 30, 30]);
  assert.equal(layoutUnevenness(layoutOf(tree)), 0);
  assert.equal(evenLayoutStep(layoutOf(tree)), null, "nothing left to move");
});

test("an uneven grid of four columns of three becomes a regular grid", () => {
  const column = (n, ratios) => down(ratios[0], leaf(`w1:p${n}a`), down(ratios[1], leaf(`w1:p${n}b`), leaf(`w1:p${n}c`)));
  const tree = right(0.6, column(1, [0.7, 0.5]),
    right(0.4, column(2, [0.5, 0.5]), right(0.5, column(3, [0.2, 0.8]), column(4, [0.4, 0.5]))));
  const steps = evenOut(tree);
  assert.ok(steps <= 20, `${steps} steps`);
  within(sizes(tree, "width"), Array(12).fill(30));
  within(sizes(tree, "height"), Array(4).fill([13, 14, 13]).flat());
});

test("panes that only line up across two splits are evened by Herdr's splits, not by their lining up", () => {
  // Rows: (p1 | p2) over ((p3 over (p4 | p5)) | p6); p1 and p3's column and
  // p2 and p6 happen to meet at the same column.
  const tree = down(0.8, right(0.5, leaf("w1:p1"), leaf("w1:p2")),
    right(0.5, down(0.5, leaf("w1:p3"), right(0.5, leaf("w1:p4"), leaf("w1:p5"))), leaf("w1:p6")));
  evenOut(tree);
  assert.deepEqual(Object.fromEntries(layoutOf(tree).panes.map((pane) => [pane.pane_id, pane.rect.height])),
    { "w1:p1": 20, "w1:p2": 20, "w1:p3": 10, "w1:p4": 10, "w1:p5": 10, "w1:p6": 20 });
  // Without Herdr's splits every line no pane crosses divides: columns first.
  const bare = down(0.8, right(0.5, leaf("w1:p1"), leaf("w1:p2")), right(0.5, leaf("w1:p3"), leaf("w1:p4")));
  evenOut(bare, { splits: false });
  within(sizes(bare, "height"), [20, 20, 20, 20]);
});

test("a layout already even, a single pane or panes that do not tile are left alone", () => {
  const even = right(0.5, leaf("w1:p1"), down(0.5, leaf("w1:p2"), leaf("w1:p3")));
  assert.equal(evenLayoutStep(layoutOf(even)), null);
  assert.equal(layoutUnevenness(layoutOf(even)), 0);
  assert.equal(canEvenLayout(layoutOf(leaf("w1:p1"))), false);
  const gap = { area: AREA, panes: [
    { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 50, height: 40 } },
    { pane_id: "w1:p2", rect: { x: 60, y: 0, width: 60, height: 40 } },
  ] };
  assert.equal(canEvenLayout(gap), false);
  assert.equal(evenLayoutStep(gap), null);
  assert.equal(layoutUnevenness(gap), Infinity);
  // A pinwheel: no line crosses no pane, so it is no layout of splits.
  const pinwheel = { area: { x: 0, y: 0, width: 3, height: 3 }, panes: [
    { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 2, height: 1 } }, { pane_id: "w1:p2", rect: { x: 2, y: 0, width: 1, height: 2 } },
    { pane_id: "w1:p3", rect: { x: 1, y: 2, width: 2, height: 1 } }, { pane_id: "w1:p4", rect: { x: 0, y: 1, width: 1, height: 2 } },
    { pane_id: "w1:p5", rect: { x: 1, y: 1, width: 1, height: 1 } },
  ] };
  assert.equal(canEvenLayout(pinwheel), false);
});

test("a border within a cell of even is even: a run of three in 40 rows is 13, 14, 13", () => {
  const tree = down(0.33, leaf("w1:p1"), down(0.5, leaf("w1:p2"), leaf("w1:p3")));
  assert.equal(evenLayoutStep(layoutOf(tree)), null);
});

test("given the rects it had, a layout is moved back toward them", () => {
  const tree = right(0.25, leaf("w1:p1"), down(0.8, leaf("w1:p2"), leaf("w1:p3")));
  const goal = layoutRects(layoutOf(tree));
  evenOut(tree);
  within(sizes(tree, "width"), [60, 60, 60]);
  const back = evenOut(tree, { goal });
  assert.ok(back > 0);
  for (const pane of layoutOf(tree).panes) {
    const was = goal.get(pane.pane_id);
    for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(pane.rect[key] - was[key]) <= 1, `${pane.pane_id} ${key}`);
  }
});
