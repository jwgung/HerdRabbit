// Swiping an in-app alert away. The alert follows the finger; on release it
// either snaps back or leaves in the direction it was thrown.

export const DISMISS_FRACTION = 0.35;
// A flick this fast (pixels per millisecond) dismisses even a short drag.
export const FLICK_SPEED = 0.5;
// A flick must still travel this far, so a twitch does not dismiss.
export const FLICK_MIN_DISTANCE = 24;
// Movement under this is a tap, not a swipe.
export const TAP_SLOP = 8;

// dx, dy: finger travel since touch start; vx, vy: release velocity (px/ms);
// width, height: the alert's size. Down never dismisses: the alert sits at the
// top, so only sideways and up leave.
export function decideSwipe({ dx = 0, dy = 0, vx = 0, vy = 0, width, height, up = true } = {}) {
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  const sideways = Math.abs(dx) >= Math.abs(dy);
  if (sideways || !up) {
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

// Wires touch swipes onto `element`. The element must position itself with
// `translate(calc(-50% + var(--swipe-x, 0px)), var(--swipe-y, 0px))`.
// `onDismiss()` runs once the leave animation ends. Returns { consumedClick() }
// so the click handler can ignore the click that follows a drag.
export function attachSwipeDismiss(element, { onDismiss, reducedMotion = () => false,
  now = () => performance.now() } = {}) {
  let start = null;
  let samples = [];
  let swiped = false;

  function apply(x, y) {
    element.style.setProperty("--swipe-x", `${x}px`);
    element.style.setProperty("--swipe-y", `${y}px`);
  }

  function reset() {
    element.classList.remove("swiping", "leaving");
    element.style.removeProperty("--swipe-x");
    element.style.removeProperty("--swipe-y");
    element.style.removeProperty("opacity");
  }

  function velocity() {
    const t = now();
    const recent = samples.filter((s) => t - s.t <= 100);
    if (recent.length < 2) return { vx: 0, vy: 0 };
    const a = recent[0];
    const b = recent[recent.length - 1];
    const span = Math.max(1, b.t - a.t);
    return { vx: (b.x - a.x) / span, vy: (b.y - a.y) / span };
  }

  element.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
    samples = [{ x: event.clientX, y: event.clientY, t: now() }];
    swiped = false;
  });

  element.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved) {
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      start.moved = true;
      swiped = true;
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
    const dy = event.clientY - start.y;
    const { vx, vy } = velocity();
    start = null;
    if (!moved) return;
    element.classList.remove("swiping");
    const rect = element.getBoundingClientRect();
    const decision = cancelled
      ? { dismiss: false }
      : decideSwipe({ dx, dy: Math.min(0, dy), vx, vy, width: rect.width, height: rect.height });
    if (!decision.dismiss) { reset(); return; }
    const x = decision.direction === "left" ? -window.innerWidth : decision.direction === "right" ? window.innerWidth : dx;
    const y = decision.direction === "up" ? -(rect.bottom + 24) : Math.min(0, dy);
    if (reducedMotion()) { reset(); onDismiss(); return; }
    element.classList.add("leaving");
    apply(x, y);
    element.style.opacity = "0";
    let done = false;
    const complete = () => { if (done) return; done = true; reset(); onDismiss(); };
    element.addEventListener("transitionend", complete, { once: true });
    setTimeout(complete, 400);
  }

  element.addEventListener("pointerup", (event) => finish(event, false));
  element.addEventListener("pointercancel", (event) => finish(event, true));

  return {
    // True once for the click that ends a drag.
    consumedClick() {
      const was = swiped;
      swiped = false;
      return was;
    },
    reset,
  };
}
