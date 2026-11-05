// Zoom inside the file viewer, and only there. The page itself never zooms: a
// phone's pinch on the page leaves the zoom behind when the dialog closes (see
// files.js), so the viewer's boxes refuse the browser's own pinch
// (touch-action) and do the zooming themselves.
//
//   - A picture scales about the fingers or the cursor: pinch, double-tap or
//     double-click, Ctrl+wheel (a trackpad pinch arrives as one). Zoomed in, a
//     drag moves it, and it cannot be dragged out of its box.
//   - Text grows its letters instead, so it still wraps and scrolls as text:
//     pinch or Ctrl+wheel.

// A picture here is an SVG, which stays in the viewer dialog for its Source
// button; every other picture opens in the chat's picture viewer
// (chat/image-viewer.js). This zoom is that one's in miniature, with its limits.
import { MAX_SCALE, TOGGLE_SCALE as DOUBLE_TAP_SCALE } from "../chat/image-viewer.js?v=1.4.42";

export { MAX_SCALE, DOUBLE_TAP_SCALE };
export const MIN_SCALE = 1;
export const MIN_TEXT_SCALE = 0.6;
export const MAX_TEXT_SCALE = 4;
// a press that moved more than this is a drag, not a tap
const TAP_PX = 6;
// two taps this close in time and place are a double tap
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 30;
// Ctrl+wheel (or a trackpad pinch) zoom per pixel scrolled
const WHEEL_ZOOM_PER_PIXEL = 0.004;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// How far a picture drawn `scale` times its size in a box of `size` may move
// from the middle before an edge comes away from the box's edge.
export function clampPan(view, size) {
  const maxX = (size.width * (view.scale - 1)) / 2;
  const maxY = (size.height * (view.scale - 1)) / 2;
  // `|| 0` turns a -0 (from the middle at 1x) into the plain 0 it means.
  return { scale: view.scale, x: clamp(view.x, -maxX, maxX) || 0, y: clamp(view.y, -maxY, maxY) || 0 };
}

// The view after scaling to `scale` about `point`, which is measured from the
// picture's middle as laid out (unzoomed): the spot under the point stays put.
export function zoomAt(view, scale, point, size) {
  const next = clamp(scale, MIN_SCALE, MAX_SCALE);
  const ratio = next / view.scale;
  return clampPan({
    scale: next,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  }, size);
}

const distance = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

// Wraps a picture in a box that zooms it. Returns the box, to go where the
// picture would have gone.
export function zoomablePicture(picture) {
  const box = document.createElement("div");
  box.className = "viewer-zoom";
  box.append(picture);
  let view = { scale: 1, x: 0, y: 0 };
  const pointers = new Map();
  let pinch = null;
  let drag = null;
  let lastTap = null;

  const size = () => ({ width: picture.offsetWidth, height: picture.offsetHeight });
  // A point on screen, measured from the picture's laid-out middle.
  const fromMiddle = (clientX, clientY) => {
    const rect = box.getBoundingClientRect();
    const left = picture.offsetLeft + picture.offsetWidth / 2;
    const top = picture.offsetTop + picture.offsetHeight / 2;
    return { x: clientX - rect.left - left, y: clientY - rect.top - top };
  };
  const draw = () => {
    picture.style.transform = view.scale === 1 ? "" : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    box.dataset.zoomed = String(view.scale > 1);
  };
  const zoomTo = (scale, clientX, clientY) => {
    view = zoomAt(view, scale, fromMiddle(clientX, clientY), size());
    draw();
  };
  const toggleAt = (clientX, clientY) => zoomTo(view.scale > 1 ? 1 : DOUBLE_TAP_SCALE, clientX, clientY);

  box.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, event);
    box.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: distance(a, b) || 1, scale: view.scale };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { x: event.clientX, y: event.clientY, view, moved: false };
    }
  });
  box.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      zoomTo(pinch.scale * (distance(a, b) / pinch.distance), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    } else if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > TAP_PX) drag.moved = true;
      if (view.scale > 1) {
        view = clampPan({ scale: view.scale, x: drag.view.x + dx, y: drag.view.y + dy }, size());
        draw();
      }
    }
  });
  const release = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (event.type !== "pointerup" || pointers.size > 0) {
      drag = null;
      return;
    }
    // Two quick taps in one place: in to 2.5x there, or back out.
    const tap = drag && !drag.moved && event.pointerType !== "mouse";
    drag = null;
    if (!tap) return;
    const now = performance.now();
    if (lastTap && now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < DOUBLE_TAP_PX) {
      lastTap = null;
      toggleAt(event.clientX, event.clientY);
    } else {
      lastTap = { at: now, x: event.clientX, y: event.clientY };
    }
  };
  box.addEventListener("pointerup", release);
  box.addEventListener("pointercancel", release);
  box.addEventListener("dblclick", (event) => toggleAt(event.clientX, event.clientY));
  box.addEventListener("wheel", (event) => {
    // A plain wheel is left alone unless the picture is zoomed, so the dialog
    // does not swallow a scroll meant for it.
    if (!event.ctrlKey && view.scale === 1) return;
    event.preventDefault();
    if (event.ctrlKey) zoomTo(view.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_PER_PIXEL), event.clientX, event.clientY);
    else {
      view = clampPan({ scale: view.scale, x: view.x - event.deltaX, y: view.y - event.deltaY }, size());
      draw();
    }
  }, { passive: false });
  return box;
}

// Lets a text box's letters be pinched larger or smaller, from 0.6x to 4x.
export function zoomableText(text) {
  let scale = 1;
  let pinch = null;
  const setScale = (next) => {
    scale = clamp(next, MIN_TEXT_SCALE, MAX_TEXT_SCALE);
    text.style.fontSize = scale === 1 ? "" : `calc(var(--font-sm) * ${scale})`;
  };
  const spread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  text.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    pinch = { distance: spread(event.touches) || 1, scale };
  }, { passive: false });
  text.addEventListener("touchmove", (event) => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    setScale(pinch.scale * (spread(event.touches) / pinch.distance));
  }, { passive: false });
  text.addEventListener("touchend", (event) => {
    if (event.touches.length < 2) pinch = null;
  });
  text.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setScale(scale * Math.exp(-event.deltaY * WHEEL_ZOOM_PER_PIXEL));
  }, { passive: false });
  return text;
}
