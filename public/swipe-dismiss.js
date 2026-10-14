// Swiping an in-app alert away. The alert follows the finger; on release it
// either snaps back or leaves in the direction it was thrown.

export const DISMISS_FRACTION = 0.35;
// A flick this fast (pixels per millisecond) dismisses even a short drag.
export const FLICK_SPEED = 0.5;
// A flick must still travel this far, so a twitch does not dismiss.
export const FLICK_MIN_DISTANCE = 24;
// Movement under this is a tap, not a swipe.
export const TAP_SLOP = 8;
// The click a drag ends with arrives within this many milliseconds; a later
// click is a fresh tap.
export const DRAG_CLICK_WINDOW = 400;
// The leave transition lasts 0.22s; this backstop finishes it if
// `transitionend` never comes.
const LEAVE_BACKSTOP = 400;
// Release speed is measured over the last stretch of the drag only, so a
// pause before letting go reads as slow.
const VELOCITY_WINDOW_MS = 100;
// How far past the screen's top edge an upward-thrown alert travels, so its
// shadow is gone too.
const OFFSCREEN_MARGIN = 24;

// dx, dy: finger travel since touch start; vx, vy: release velocity (px/ms);
// width, height: the alert's size. Down never dismisses: the alert sits at the
// top, so only sideways and up leave.
export function decideSwipe({ dx = 0, dy = 0, vx = 0, vy = 0, width, height } = {}) {
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  const sideways = Math.abs(dx) >= Math.abs(dy);
  if (sideways) {
    const far = Math.abs(dx) >= w * DISMISS_FRACTION;
    const flick = Math.abs(vx) >= FLICK_SPEED && Math.abs(dx) >= FLICK_MIN_DISTANCE && Math.sign(vx) === Math.sign(dx);
    if (far || flick) return { dismiss: true, direction: dx < 0 ? "left" : "right" };
    return { dismiss: false, direction: null };
  }
  const far = -dy >= h * DISMISS_FRACTION;
  const flick = vy <= -FLICK_SPEED && -dy >= FLICK_MIN_DISTANCE;
  if (far || flick) return { dismiss: true, direction: "up" };
  return { dismiss: false, direction: null };
}

// Where a dismissed alert ends up: off the side it was thrown toward, or off
// the top. `dy` is already clamped to upward travel.
function leaveTarget(direction, rect, dx, dy) {
  if (direction === "left") return { x: -window.innerWidth, y: dy };
  if (direction === "right") return { x: window.innerWidth, y: dy };
  return { x: dx, y: -(rect.bottom + OFFSCREEN_MARGIN) };
}

// Wires touch swipes onto `element`. The element must position itself with
// `translate(calc(-50% + var(--swipe-x, 0px)), var(--swipe-y, 0px))`.
// `onDismiss()` runs once the leave animation ends. Returns { consumedClick() }
// so the click handler can ignore the click that follows a drag.
export function attachSwipeDismiss(element, { onDismiss, reducedMotion = () => false,
  now = () => performance.now() } = {}) {
  let start = null;
  let samples = [];
  // When the last drag ended, so its trailing click can be told apart.
  let draggedAt = null;
  // The leave animation under way, so a new alert can call it off.
  let leaving = null;

  function apply(x, y) {
    element.style.setProperty("--swipe-x", `${x}px`);
    element.style.setProperty("--swipe-y", `${y}px`);
  }

  // Puts the alert back where it sits, calling off any leave under way. The
  // drag's trailing click is still remembered.
  function settle() {
    if (leaving) {
      clearTimeout(leaving.timer);
      element.removeEventListener("transitionend", leaving.complete);
      leaving = null;
    }
    element.classList.remove("swiping", "leaving");
    element.style.removeProperty("--swipe-x");
    element.style.removeProperty("--swipe-y");
    element.style.removeProperty("opacity");
  }

  // For a new alert: forgets every gesture made on the old one too.
  function reset() {
    settle();
    start = null;
    samples = [];
    draggedAt = null;
  }

  function velocity() {
    const t = now();
    const recent = samples.filter((s) => t - s.t <= VELOCITY_WINDOW_MS);
    if (recent.length < 2) return { vx: 0, vy: 0 };
    const a = recent[0];
    const b = recent[recent.length - 1];
    const span = Math.max(1, b.t - a.t);
    return { vx: (b.x - a.x) / span, vy: (b.y - a.y) / span };
  }

  element.addEventListener("pointerdown", (event) => {
    // Any new press is a fresh tap, whatever the last drag left behind.
    draggedAt = null;
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
    samples = [{ x: event.clientX, y: event.clientY, t: now() }];
  });

  element.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved) {
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      start.moved = true;
      element.classList.add("swiping");
      try { element.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    }
    samples.push({ x: event.clientX, y: event.clientY, t: now() });
    // Down is resisted: the alert may follow sideways and up, not drift down.
    apply(dx, Math.min(0, dy));
  });

  function finish(event, cancelled) {
    if (!start || event.pointerId !== start.id) return;
    const { moved } = start;
    const dx = event.clientX - start.x;
    // Down is resisted, so only upward travel counts.
    const dy = Math.min(0, event.clientY - start.y);
    const { vx, vy } = velocity();
    start = null;
    if (!moved) return;
    draggedAt = now();
    element.classList.remove("swiping");
    const rect = element.getBoundingClientRect();
    const decision = cancelled
      ? { dismiss: false }
      : decideSwipe({ dx, dy, vx, vy, width: rect.width, height: rect.height });
    if (!decision.dismiss) { settle(); return; }
    const { x, y } = leaveTarget(decision.direction, rect, dx, dy);
    if (reducedMotion()) { settle(); onDismiss(); return; }
    element.classList.add("leaving");
    apply(x, y);
    element.style.opacity = "0";
    const ending = { complete: null, timer: null };
    ending.complete = () => {
      if (leaving !== ending) return;
      settle();
      onDismiss();
    };
    ending.timer = setTimeout(ending.complete, LEAVE_BACKSTOP);
    element.addEventListener("transitionend", ending.complete);
    leaving = ending;
  }

  element.addEventListener("pointerup", (event) => finish(event, false));
  element.addEventListener("pointercancel", (event) => finish(event, true));

  return {
    // True once for the click that ends a drag.
    consumedClick() {
      const was = draggedAt !== null && now() - draggedAt <= DRAG_CLICK_WINDOW;
      draggedAt = null;
      return was;
    },
    reset,
  };
}
