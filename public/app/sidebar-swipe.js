// Swiping the phone sidebar open and shut: a drag that starts at the screen's
// left edge and goes right opens it, a drag to the left on the open sidebar
// closes it. Decided on release, as the pane swipe is (app/pane-tabs.js).
import { FLICK_SPEED, VELOCITY_WINDOW_MS } from "../swipe-dismiss.js?v=1.4.62";
import { EDGE_SWIPE_ZONE, SIDEWAYS_RATIO, scrollsSideways } from "./pane-tabs.js?v=1.4.62";

// The sidebar covers the screen, so a swipe that clearly means it is short.
export const SIDEBAR_SWIPE_DISTANCE = 48;
// A quick flick may be shorter, but not a twitch.
export const SIDEBAR_FLICK_DISTANCE = 24;

// What a finger's travel (dx, dy) from `startX` at release speed vx does to
// the sidebar: "open", "close" or null. A closed sidebar opens only from the
// edge zone, going right; an open one closes going left, from anywhere on it.
export function decideSidebarSwipe({ open = false, startX = 0, dx = 0, dy = 0, vx = 0 } = {}) {
  if (Math.abs(dx) < Math.abs(dy) * SIDEWAYS_RATIO) return null;
  const goes = open ? -dx : dx;
  const flick = goes >= SIDEBAR_FLICK_DISTANCE && Math.abs(vx) >= FLICK_SPEED && Math.sign(vx) === Math.sign(dx);
  if (goes < SIDEBAR_SWIPE_DISTANCE && !flick) return null;
  if (open) return "close";
  return startX <= EDGE_SWIPE_ZONE ? "open" : null;
}

// Wires the swipes on `document`. `isPhone()` says whether the sidebar is a
// drawer, `isOpen()` whether it is showing, `drawer` is the sidebar element.
// A dialog on screen keeps its own touches, and a drag that scrolls
// something sideways inside the sidebar stays that scroll.
export function attachSidebarSwipe({ drawer, isPhone, isOpen, onOpen, onClose }) {
  let touch = null;
  document.addEventListener("touchstart", (event) => {
    touch = null;
    if (event.touches.length !== 1 || !isPhone() || document.querySelector("dialog[open]")) return;
    const { clientX: x, clientY: y } = event.touches[0];
    const open = isOpen();
    if (open ? !drawer.contains(event.target) : x > EDGE_SWIPE_ZONE) return;
    touch = { open, target: event.target, x0: x, y0: y, samples: [{ x, t: event.timeStamp }] };
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (!touch) return;
    if (event.touches.length !== 1) { touch = null; return; }
    touch.samples.push({ x: event.touches[0].clientX, t: event.timeStamp });
    while (touch.samples.length > 2 && event.timeStamp - touch.samples[0].t > VELOCITY_WINDOW_MS) touch.samples.shift();
  }, { passive: true });
  document.addEventListener("touchcancel", () => { touch = null; }, { passive: true });
  document.addEventListener("touchend", (event) => {
    const start = touch;
    touch = null;
    if (!start || event.changedTouches.length !== 1) return;
    const { clientX: x, clientY: y } = event.changedTouches[0];
    const dx = x - start.x0;
    const first = start.samples[0];
    const elapsed = event.timeStamp - first.t;
    const vx = elapsed > 0 ? (x - first.x) / elapsed : 0;
    const decision = decideSidebarSwipe({ open: start.open, startX: start.x0, dx, dy: y - start.y0, vx });
    if (!decision) return;
    if (decision === "close" && scrollsSideways(start.target, drawer, dx)) return;
    if (decision === "open") onOpen();
    else onClose();
  }, { passive: true });
}
