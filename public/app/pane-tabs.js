// The phone's tabs of a split tab: one tab per pane (its agent's mark, its
// name and a dot for a status worth seeing), in the order Herdr lays the
// panes out, read left to right and top to bottom. A tap on a tab, or a
// sideways swipe across the pane's Chat or Terminal, picks a pane.
import { createElement } from "./dom.js?v=1.4.57";
import { createTabStrip } from "./tab-strip.js?v=1.4.57";
import { gridCells } from "../pane-grid.js?v=1.4.57";
import { FLICK_SPEED, VELOCITY_WINDOW_MS } from "../swipe-dismiss.js?v=1.4.57";

// A swipe this share of the stage's width picks the next pane, or a shorter
// flick as fast as one that dismisses an alert (swipe-dismiss.js) that still
// goes FLICK_MIN_DISTANCE: further than an alert's, as text scrolls under it.
export const SWIPE_FRACTION = 0.25;
export const FLICK_MIN_DISTANCE = 40;
// Sideways by at least this much more than up or down: a scroll that drifts is no swipe.
export const SIDEWAYS_RATIO = 1.5;

// A touch that starts this close to the screen's left edge opens the phone
// sidebar (app/sidebar-swipe.js), so a pane swipe leaves it alone.
export const EDGE_SWIPE_ZONE = 24;

// The statuses whose dot a tab shows; an idle or unknown pane shows none.
const DOT_STATUSES = new Set(["blocked", "working", "done"]);

// The panes in the order their tabs stand: where the layout has them (top
// row first, then left to right), then any it does not have yet (one just
// split off) in the snapshot's order.
export function paneTabOrder(layout, panes) {
  const placed = gridCells(layout, panes.map((pane) => pane.paneId)).cells;
  const at = new Map(placed.map((cell) => [cell.paneId, cell]));
  const ordered = panes.filter((pane) => at.has(pane.paneId)).sort((a, b) => {
    const one = at.get(a.paneId);
    const two = at.get(b.paneId);
    return one.top - two.top || one.left - two.left;
  });
  return [...ordered, ...panes.filter((pane) => !at.has(pane.paneId))];
}

// The pane a swipe goes to: a swipe to the left shows the next tab's pane,
// to the right the one before. None past either end.
export function swipeTarget(paneIds, selectedPaneId, direction) {
  const at = paneIds.indexOf(selectedPaneId);
  if (at < 0) return null;
  return paneIds[direction === "left" ? at + 1 : at - 1] ?? null;
}

// Whether a finger's travel (dx, dy) at release speed vx is a swipe across
// a stage `width` wide, and which way: "left", "right" or null.
export function decidePaneSwipe({ dx = 0, dy = 0, vx = 0, width = 0 } = {}) {
  if (Math.abs(dx) < Math.abs(dy) * SIDEWAYS_RATIO) return null;
  const far = width > 0 && Math.abs(dx) >= width * SWIPE_FRACTION;
  const flick = Math.abs(dx) >= FLICK_MIN_DISTANCE && Math.abs(vx) >= FLICK_SPEED && Math.sign(vx) === Math.sign(dx);
  if (!far && !flick) return null;
  return dx < 0 ? "left" : "right";
}

// Draws the tabs into `host`. `panes` are splitTabPanes' records
// ({ paneId, label, kind, status, statusText }); `agentMark(kind)` draws a mark.
export function renderPaneTabs(host, { layout, panes, selectedPaneId, onPick, agentMark }) {
  const ordered = paneTabOrder(layout, panes);
  const strip = createTabStrip({
    label: "Panes of this tab",
    tabs: ordered.map((pane) => ({
      id: pane.paneId,
      label: pane.label,
      icon: agentMark?.(pane.kind),
      ariaLabel: `${pane.label}, ${pane.statusText}`,
      data: { paneId: pane.paneId, status: pane.status },
    })),
    selected: selectedPaneId,
    onSelect: (paneId) => onPick(paneId),
  });
  strip.element.classList.add("pane-tabs");
  for (const pane of ordered) {
    if (!DOT_STATUSES.has(pane.status)) continue;
    const dot = createElement("span", { className: `ui-tab-dot pane-tab-dot state-${pane.status}` });
    dot.title = pane.statusText;
    strip.buttons.get(pane.paneId)?.append(dot);
  }
  host.replaceChildren(strip.element);
  // in the page now: the chosen tab can be scrolled into view
  strip.select(selectedPaneId);
  return ordered.map((pane) => pane.paneId);
}

// Whether `target` sits in something that scrolls sideways and can still go
// the way the finger pushes it (a code block, a wide table): that drag is its
// scroll, not a swipe. Looked for up to `stage`.
export function scrollsSideways(target, stage, dx) {
  for (let node = target; node && node !== stage; node = node.parentElement) {
    if (!(node instanceof Element) || node.scrollWidth <= node.clientWidth + 1) continue;
    const overflow = getComputedStyle(node).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    // a finger moving left scrolls the content on to the right
    if (dx < 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 1) return true;
  }
  return false;
}

// Swipes across `stage` while `paneIds()` answers the tabs' panes in order (null
// while no tabs are shown). `skip(target)` answers the touches left alone
// (the tabs themselves, which scroll, and the prompt card); one that starts in
// the left-edge zone is left alone too. `onSwipe(paneId)`
// picks the pane.
export function attachPaneSwipe(stage, { paneIds, selectedPaneId, skip = () => false, onSwipe }) {
  let touch = null;
  stage.addEventListener("touchstart", (event) => {
    touch = null;
    if (event.touches.length !== 1 || !paneIds() || skip(event.target)) return;
    const { clientX: x, clientY: y } = event.touches[0];
    if (x <= EDGE_SWIPE_ZONE) return;
    touch = { target: event.target, x0: x, y0: y, samples: [{ x, t: event.timeStamp }] };
  }, { passive: true });
  stage.addEventListener("touchmove", (event) => {
    if (!touch) return;
    if (event.touches.length !== 1) { touch = null; return; }
    const { clientX: x } = event.touches[0];
    touch.samples.push({ x, t: event.timeStamp });
    while (touch.samples.length > 2 && event.timeStamp - touch.samples[0].t > VELOCITY_WINDOW_MS) touch.samples.shift();
  }, { passive: true });
  stage.addEventListener("touchcancel", () => { touch = null; }, { passive: true });
  stage.addEventListener("touchend", (event) => {
    const start = touch;
    touch = null;
    const ids = paneIds();
    if (!start || !ids || event.changedTouches.length !== 1) return;
    const { clientX: x, clientY: y } = event.changedTouches[0];
    const dx = x - start.x0;
    const dy = y - start.y0;
    const first = start.samples[0];
    const elapsed = event.timeStamp - first.t;
    const vx = elapsed > 0 ? (x - first.x) / elapsed : 0;
    const direction = decidePaneSwipe({ dx, dy, vx, width: stage.clientWidth });
    if (!direction) return;
    // a drag that selects text, or scrolls something sideways, stays that
    if (String(window.getSelection?.() ?? "").length > 0 || scrollsSideways(start.target, stage, dx)) return;
    const next = swipeTarget(ids, selectedPaneId(), direction);
    if (next) onSwipe(next);
  }, { passive: true });
}
