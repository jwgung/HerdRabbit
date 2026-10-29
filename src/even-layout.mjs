// Evening out a split tab: the planning half, free of Herdr. A tab's panes
// tile its area as nested splits; read from their rects, each split is a run
// of side-by-side (or stacked) parts, and evening out gives every part of a
// run the same share of it. Herdr resizes by moving one pane's border, and a
// moved border carries the panes inside the parts it bounds along in
// proportion, so the plan is one move at a time, outermost runs first, read
// again after each (see HerdrClient.evenLayout).

const AXES = {
  x: { pos: "x", size: "width", grow: "right", shrink: "left" },
  y: { pos: "y", size: "height", grow: "down", shrink: "up" },
};
// A border within a cell of where it should be is where it should be: a run
// of n parts rarely divides into whole cells.
const TOLERANCE = 1;

const end = (rect, axis) => rect[AXES[axis].pos] + rect[AXES[axis].size];

function boundsOf(panes) {
  const x = Math.min(...panes.map((pane) => pane.rect.x));
  const y = Math.min(...panes.map((pane) => pane.rect.y));
  return { x, y, width: Math.max(...panes.map((pane) => end(pane.rect, "x"))) - x,
    height: Math.max(...panes.map((pane) => end(pane.rect, "y"))) - y };
}

// The parts of `panes` along `axis`: split wherever a line crosses no pane.
// A gap between two parts is no split Herdr draws: null.
function partsAlong(panes, axis) {
  const { pos } = AXES[axis];
  const sorted = [...panes].sort((a, b) => a.rect[pos] - b.rect[pos]);
  const parts = [];
  let reach = -Infinity;
  for (const pane of sorted) {
    if (parts.length > 0 && pane.rect[pos] > reach) return null;
    if (pane.rect[pos] === reach) parts.push([]);
    if (parts.length === 0) parts.push([]);
    parts.at(-1).push(pane);
    reach = Math.max(reach, end(pane.rect, axis));
  }
  return parts;
}

const sameBox = (a, b) => a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const SPLIT_AXES = { right: "x", down: "y" };

// The tab as nested runs: { axis, box, parts: [{ box, panes, node }] } down to
// single panes ({ pane }). Herdr's own splits (`layout.splits`: a rect, a
// direction and a ratio each) say where a run divides, so panes that merely
// line up across two splits are not read as one run; a split inside a part
// of its own direction joins that run (A | (B | C) is three columns). Without
// them, every line no pane crosses divides, columns before rows. Null when
// the panes do not tile as splits.
function splitTree(panes, splits) {
  if (panes.length === 1) return { pane: panes[0] };
  const box = boundsOf(panes);
  const split = splits.find((item) => sameBox(item?.rect, box) && SPLIT_AXES[item.direction]);
  if (split) {
    const axis = SPLIT_AXES[split.direction];
    const { pos, size } = AXES[axis];
    const parts = partsAlong(panes, axis);
    if (parts === null || parts.length < 2) return null;
    // The divide nearest the split's ratio is the split's.
    const at = box[pos] + (Number.isFinite(split.ratio) ? split.ratio : 0.5) * box[size];
    const cut = parts.slice(1).reduce((best, part, index) =>
      Math.abs(part[0].rect[pos] - at) < Math.abs(parts[best + 1][0].rect[pos] - at) ? index : best, 0) + 1;
    const children = [parts.slice(0, cut).flat(), parts.slice(cut).flat()].flatMap((part) => {
      const node = splitTree(part, splits);
      if (node?.axis === axis) return node.parts;
      return [{ box: boundsOf(part), panes: part, node }];
    });
    if (children.some((child) => child.node === null)) return null;
    return { axis, box, parts: children };
  }
  for (const axis of ["x", "y"]) {
    const parts = partsAlong(panes, axis);
    if (parts === null) return null;
    if (parts.length < 2) continue;
    const children = parts.map((part) => ({ box: boundsOf(part), panes: part, node: splitTree(part, splits) }));
    if (children.some((child) => child.node === null)) return null;
    return { axis, box, parts: children };
  }
  return null;
}

const treeOf = (layout) => splitTree(validPanes(layout), Array.isArray(layout?.splits) ? layout.splits : []);

function validPanes(layout) {
  const panes = Array.isArray(layout?.panes) ? layout.panes : [];
  return panes.filter((pane) => typeof pane?.pane_id === "string" && pane.rect
    && ["x", "y", "width", "height"].every((key) => Number.isInteger(pane.rect[key])) && pane.rect.width > 0 && pane.rect.height > 0);
}

// Every border of every run, outermost first: where it is, where it should
// be (`target(run, index)`, or null to leave it), and the panes on each side.
function borders(tree, target) {
  const found = [];
  const queue = tree ? [tree] : [];
  while (queue.length > 0) {
    const run = queue.shift();
    if (!run.parts) continue;
    const { pos } = AXES[run.axis];
    run.parts.forEach((part, index) => {
      queue.push(part.node);
      if (index === 0) return;
      const at = part.box[pos];
      const want = target(run, index);
      if (want === null || want === undefined) return;
      found.push({ axis: run.axis, at, want,
        before: run.parts[index - 1].panes.filter((pane) => end(pane.rect, run.axis) === at),
        after: part.panes.filter((pane) => pane.rect[pos] === at) });
    });
  }
  return found;
}

// Where border `index` of a run sits when its parts share it evenly.
function evenTarget(run, index) {
  const { pos, size } = AXES[run.axis];
  return run.box[pos] + Math.round((run.box[size] * index) / run.parts.length);
}

// Where border `index` of a run sat in `goal` (pane id -> rect), read from a
// pane that starts that part; null when no such pane is in `goal`.
function goalTarget(goal) {
  return (run, index) => {
    const { pos } = AXES[run.axis];
    const part = run.parts[index];
    const lead = part.panes.find((pane) => pane.rect[pos] === part.box[pos] && goal.has(pane.pane_id));
    return lead ? goal.get(lead.pane_id)[pos] : null;
  };
}

// Whether a tab's layout is one evenLayoutStep can work on: two panes or more
// that tile the area as splits.
export function canEvenLayout(layout) {
  const panes = validPanes(layout);
  return panes.length >= 2 && treeOf(layout) !== null;
}

// How far from even a layout is: the cells its borders are off by, beyond a
// cell each. 0 is even; Infinity is a layout that does not tile as splits.
export function layoutUnevenness(layout) {
  const tree = treeOf(layout);
  if (!tree) return Infinity;
  return borders(tree, evenTarget).reduce((sum, border) => sum + Math.max(0, Math.abs(border.want - border.at) - TOLERANCE), 0);
}

// The next resize that brings `layout` ({ area, panes: [{ pane_id, rect }] })
// closer to even, or, given `goal` (pane id -> rect), back toward it: one
// border, the outermost one off by more than a cell. { paneId, direction,
// amount } for `herdr pane resize`, amount a fraction of the area; null when
// nothing is left to move (or the layout does not tile as splits).
export function evenLayoutStep(layout, goal = null) {
  const area = layout?.area;
  const tree = treeOf(layout);
  if (!tree) return null;
  for (const border of borders(tree, goal ? goalTarget(goal) : evenTarget)) {
    const off = border.want - border.at;
    if (Math.abs(off) <= TOLERANCE) continue;
    // Growing the part before the border moves it on; shrinking the part
    // after it moves it back. Either pane's border on that side is the one.
    const pane = off > 0 ? border.before[0] : border.after[0];
    if (!pane) continue;
    const { size, grow, shrink } = AXES[border.axis];
    const whole = Number.isInteger(area?.[size]) && area[size] > 0 ? area[size] : tree.box[size];
    return { paneId: pane.pane_id, direction: off > 0 ? grow : shrink, amount: Math.abs(off) / whole };
  }
  return null;
}

// The rect each pane has, keyed by id: a layout to come back to.
export function layoutRects(layout) {
  return new Map(validPanes(layout).map((pane) => [pane.pane_id, { ...pane.rect }]));
}

// The layout's rects as one string: the same text means nothing moved.
export function layoutSignature(layout) {
  return validPanes(layout).map((pane) => `${pane.pane_id}:${pane.rect.x},${pane.rect.y},${pane.rect.width},${pane.rect.height}`).sort().join(" ");
}
