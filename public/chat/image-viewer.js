// The chat's pictures over the whole screen (chat-images.js opens it).
//
// The picture is fitted to the screen; the wheel, a pinch, the + and - buttons
// or keys zoom it at the pointer (up to 8x), a drag or the arrow keys pan a
// zoomed one, and a double tap or click toggles fit and 2.5x. At fit, a swipe,
// the side buttons or Left and Right step through the other pictures of the
// chat, wrapping at both ends. Copy puts the picture on the clipboard as PNG;
// Download saves the file through a download ticket, as the Files tab does.
// Esc closes it (the dialog's own cancel).
//
// It is a modal <dialog>, so it sits in the top layer above everything the
// app draws, with no z-index of its own (docs/design.md); its side buttons
// sit on the picture at --layer-raised. Every control is 44px square, for a
// phone.
//
// The step and key arithmetic follows Ovis (MIT, Copyright (c) 2026 devswha),
// src/lib/imageViewer.ts.

import { ticketUrl } from "./chat-images.js?v=1.4.25";

export const FIT = Object.freeze({ scale: 1, x: 0, y: 0 });
const MAX_SCALE = 8;
const TOGGLE_SCALE = 2.5;
const BUTTON_ZOOM = 1.5;
const PAN_STEP = 48;
const SWIPE_PX = 50;
// a press that moved less than this is a tap, and two within DOUBLE_TAP_MS a double tap
const TAP_PX = 8;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 24;
// the wheel's zoom per pixel scrolled, and per line where it scrolls by lines
const WHEEL_PER_PIXEL = 0.0015;
const WHEEL_PER_LINE = 0.05;
// a swipe goes this much more across than down
const SWIPE_SLOPE = 1.5;
// the largest picture Copy draws, along its longer side, and what an SVG with
// no size of its own is drawn at
const MAX_COPY_PX = 4096;
const UNSIZED_COPY_PX = 1024;

// The index `index` steps to among `count` pictures, wrapping at both ends.
export function wrapIndex(index, count) {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

// `view` zoomed by `factor` at `point` (from the stage's centre): the point
// under the pointer stays where it was. Never below fit, never past MAX_SCALE.
export function zoomAt(view, factor, point) {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale * factor));
  if (scale === 1) return { ...FIT };
  const ratio = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

// `view` panned no further than the picture's edges: `fitted` is the picture's
// size at fit, `stage` the room it has. At fit it is centred.
export function clampView(view, fitted, stage) {
  if (view.scale <= 1) return { ...FIT };
  // `+ 0` turns -0 into 0
  const limit = (value, room) => Math.min(room, Math.max(-room, value)) + 0;
  const roomX = Math.max(0, (fitted.width * view.scale - stage.width) / 2);
  const roomY = Math.max(0, (fitted.height * view.scale - stage.height) / 2);
  return { scale: view.scale, x: limit(view.x, roomX), y: limit(view.y, roomY) };
}

// What a one-finger swipe of dx, dy does: 1 the next picture, -1 the previous
// one, 0 nothing. A zoomed picture was being panned.
export function swipeStep(dx, dy, zoomed) {
  if (zoomed || Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_SLOPE) return 0;
  return dx < 0 ? 1 : -1;
}

// What an arrow key does: { pan } a zoomed picture (the view moves the way
// the content would scroll), { step } to another picture at fit, or null.
export function arrowAction(key, zoomed, count) {
  if (zoomed) {
    switch (key) {
      case "ArrowLeft": return { pan: { x: PAN_STEP, y: 0 } };
      case "ArrowRight": return { pan: { x: -PAN_STEP, y: 0 } };
      case "ArrowUp": return { pan: { x: 0, y: PAN_STEP } };
      case "ArrowDown": return { pan: { x: 0, y: -PAN_STEP } };
      default: return null;
    }
  }
  if (count <= 1) return null;
  if (key === "ArrowLeft") return { step: -1 };
  if (key === "ArrowRight") return { step: 1 };
  return null;
}

export function zoomPercent(view) {
  return Math.round(view.scale * 100);
}

// The size Copy draws a picture of `natural` size at (0 for an SVG with none),
// shown at `shown`: its own pixels, at most MAX_COPY_PX along the longer side.
export function copySize(natural, shown) {
  let { width, height } = natural;
  if (!(width > 0 && height > 0)) {
    const ratio = shown.width > 0 && shown.height > 0 ? shown.height / shown.width : 1;
    width = UNSIZED_COPY_PX;
    height = Math.round(UNSIZED_COPY_PX * ratio);
  }
  const shrink = Math.min(1, MAX_COPY_PX / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * shrink)), height: Math.max(1, Math.round(height * shrink)) };
}

// ---------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";
// Stroked on 20 units, like the chat's copy icon.
const ICONS = {
  zoomOut: [["circle", { cx: 9, cy: 9, r: 5.5 }], ["path", { d: "M6.5 9h5M13 13l4 4" }]],
  zoomIn: [["circle", { cx: 9, cy: 9, r: 5.5 }], ["path", { d: "M6.5 9h5M9 6.5v5M13 13l4 4" }]],
  copy: [["rect", { x: 7, y: 7, width: 10, height: 10, rx: 2 }], ["path", { d: "M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" }]],
  download: [["path", { d: "M10 3v10M6 9l4 4 4-4M4 16.5h12" }]],
  close: [["path", { d: "M5 5l10 10M15 5L5 15" }]],
  previous: [["path", { d: "M12.5 4l-6 6 6 6" }]],
  next: [["path", { d: "M7.5 4l6 6-6 6" }]],
};

function icon(document, shapes) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, String(value));
    svg.append(shape);
  }
  return svg;
}

function button(document, { label, shapes, className = "", action }) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `image-viewer-button${className ? ` ${className}` : ""}`;
  node.setAttribute("aria-label", label);
  node.title = label;
  node.dataset.action = action;
  if (shapes) node.append(icon(document, shapes));
  return node;
}

// `viewTicket(path, server, view)` is the Files tab's ticket request
// (app/files.js), used here for downloads.
export function createImageViewer({ document = globalThis.document, viewTicket, clipboard = globalThis.navigator?.clipboard }) {
  let parts = null;
  let entries = [];
  let index = 0;
  let view = { ...FIT };
  const pointers = new Map();
  let gesture = null;
  let lastTap = null;

  function build() {
    const dialog = document.createElement("dialog");
    dialog.className = "image-viewer";
    dialog.setAttribute("aria-label", "Image viewer");
    const bar = Object.assign(document.createElement("div"), { className: "image-viewer-bar" });
    const heading = Object.assign(document.createElement("div"), { className: "image-viewer-heading" });
    const name = Object.assign(document.createElement("p"), { className: "image-viewer-name" });
    const count = Object.assign(document.createElement("p"), { className: "image-viewer-count" });
    heading.append(name, count);
    const tools = Object.assign(document.createElement("div"), { className: "image-viewer-tools" });
    const zoom = button(document, { label: "Fit to screen", className: "image-viewer-zoom", action: "fit" });
    tools.append(
      button(document, { label: "Zoom out", shapes: ICONS.zoomOut, action: "zoom-out" }),
      zoom,
      button(document, { label: "Zoom in", shapes: ICONS.zoomIn, action: "zoom-in" }),
      button(document, { label: "Copy image", shapes: ICONS.copy, action: "copy" }),
      button(document, { label: "Download image", shapes: ICONS.download, action: "download" }),
      button(document, { label: "Close", shapes: ICONS.close, action: "close" }),
    );
    bar.append(heading, tools);
    const main = Object.assign(document.createElement("div"), { className: "image-viewer-main" });
    const stage = Object.assign(document.createElement("div"), { className: "image-viewer-stage" });
    const picture = Object.assign(document.createElement("img"), { className: "image-viewer-picture", draggable: false });
    stage.append(picture);
    const previous = button(document, { label: "Previous image", shapes: ICONS.previous, className: "image-viewer-step is-previous", action: "previous" });
    const next = button(document, { label: "Next image", shapes: ICONS.next, className: "image-viewer-step is-next", action: "next" });
    main.append(stage, previous, next);
    const status = Object.assign(document.createElement("p"), { className: "image-viewer-status" });
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    dialog.append(bar, main, status);
    document.body.append(dialog);

    dialog.addEventListener("click", (event) => {
      const action = event.target instanceof Element ? event.target.closest("[data-action]") : null;
      if (!action || !dialog.contains(action)) return;
      switch (action.dataset.action) {
        case "zoom-out": zoomBy(1 / BUTTON_ZOOM); break;
        case "zoom-in": zoomBy(BUTTON_ZOOM); break;
        case "fit": setView(FIT); break;
        case "copy": void copy(); break;
        case "download": void download(action); break;
        case "close": dialog.close(); break;
        case "previous": step(-1); break;
        case "next": step(1); break;
        default: break;
      }
    });
    dialog.addEventListener("keydown", onKey);
    dialog.addEventListener("close", () => {
      pointers.clear();
      gesture = null;
      picture.removeAttribute("src");
      entries = [];
    });
    picture.addEventListener("error", () => { if (picture.getAttribute("src")) say("This image could not be shown here."); });
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerUp);
    return { dialog, name, count, zoom, stage, picture, previous, next, status };
  }

  function say(message) {
    parts.status.textContent = message;
  }

  // A point of the page as seen from the stage's centre.
  function fromCentre(clientX, clientY) {
    const box = parts.stage.getBoundingClientRect();
    return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) };
  }

  function setView(next) {
    const { picture, stage } = parts;
    view = clampView(next, { width: picture.clientWidth, height: picture.clientHeight },
      { width: stage.clientWidth, height: stage.clientHeight });
    picture.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    parts.zoom.textContent = `${zoomPercent(view)}%`;
    stage.classList.toggle("is-zoomed", view.scale > 1);
  }

  function zoomBy(factor, point = { x: 0, y: 0 }) {
    setView(zoomAt(view, factor, point));
  }

  function show() {
    const entry = entries[index];
    parts.name.textContent = entry.alt || entry.name;
    parts.name.title = entry.path;
    parts.count.textContent = entries.length > 1 ? `${index + 1} of ${entries.length}` : "";
    parts.previous.hidden = entries.length < 2;
    parts.next.hidden = entries.length < 2;
    parts.picture.alt = entry.alt || entry.name;
    parts.picture.src = entry.url;
    say("");
    setView(FIT);
  }

  function step(by) {
    if (entries.length < 2) return;
    index = wrapIndex(index + by, entries.length);
    show();
  }

  function onKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "+" || event.key === "=") zoomBy(BUTTON_ZOOM);
    else if (event.key === "-") zoomBy(1 / BUTTON_ZOOM);
    else if (event.key === "0") setView(FIT);
    else {
      // an arrow on a focused button is still the picture's
      const action = arrowAction(event.key, view.scale > 1, entries.length);
      if (action === null) return;
      if (action.step) step(action.step);
      else setView({ ...view, x: view.x + action.pan.x, y: view.y + action.pan.y });
    }
    event.preventDefault();
  }

  function onWheel(event) {
    event.preventDefault();
    const point = fromCentre(event.clientX, event.clientY);
    zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? WHEEL_PER_LINE : WHEEL_PER_PIXEL)), point);
  }

  function pinchOf() {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, middle: fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2) };
  }

  function startDrag(point, afterPinch = false) {
    gesture = { kind: "drag", start: point, view: { ...view }, moved: afterPinch, afterPinch };
  }

  function onPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    parts.stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) startDrag({ x: event.clientX, y: event.clientY });
    else if (pointers.size === 2) gesture = { kind: "pinch", ...pinchOf(), view: { ...view } };
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture?.kind === "pinch" && pointers.size >= 2) {
      const now = pinchOf();
      const zoomed = zoomAt(gesture.view, now.distance / gesture.distance, gesture.middle);
      setView({ ...zoomed, x: zoomed.x + now.middle.x - gesture.middle.x, y: zoomed.y + now.middle.y - gesture.middle.y });
    } else if (gesture?.kind === "drag") {
      const dx = event.clientX - gesture.start.x;
      const dy = event.clientY - gesture.start.y;
      if (Math.hypot(dx, dy) > TAP_PX) gesture.moved = true;
      if (view.scale > 1) setView({ ...view, x: gesture.view.x + dx, y: gesture.view.y + dy });
    }
  }

  function onPointerUp(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (gesture?.kind === "pinch") {
      // the finger left on the glass pans on from here; its lift is no tap
      const [rest] = [...pointers.values()];
      if (rest) startDrag(rest, true);
      else gesture = null;
      return;
    }
    if (gesture?.kind !== "drag" || pointers.size > 0) return;
    const drag = gesture;
    gesture = null;
    if (drag.afterPinch) return;
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (drag.moved) {
      const by = swipeStep(dx, dy, drag.view.scale > 1);
      if (by !== 0) step(by);
      lastTap = null;
      return;
    }
    const at = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    const double = lastTap && at.time - lastTap.time < DOUBLE_TAP_MS && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < DOUBLE_TAP_PX;
    lastTap = double ? null : at;
    if (!double) return;
    if (view.scale > 1) setView(FIT);
    else zoomBy(TOGGLE_SCALE, fromCentre(at.x, at.y));
  }

  // The picture as PNG, drawn from what the viewer shows: the clipboard takes
  // PNG everywhere, and a same-origin picture does not taint the canvas.
  function pictureAsPng() {
    const { picture } = parts;
    const canvas = document.createElement("canvas");
    const size = copySize({ width: picture.naturalWidth, height: picture.naturalHeight },
      { width: picture.clientWidth, height: picture.clientHeight });
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext("2d").drawImage(picture, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));
  }

  async function copy() {
    try {
      if (!clipboard?.write || typeof globalThis.ClipboardItem !== "function" || !parts.picture.complete) {
        throw new Error("no clipboard");
      }
      // the promise goes in as it is, so Safari keeps the press as the reason
      await clipboard.write([new globalThis.ClipboardItem({ "image/png": pictureAsPng() })]);
      say("Copied.");
    } catch {
      say("Could not copy. Copying needs a secure connection (HTTPS).");
    }
  }

  // Mirrors the Files tab's downloadPath (app/files.js), for the viewer's own
  // status line. One at a time: each holds one of the server's few tickets.
  async function download(control) {
    const entry = entries[index];
    if (!entry || control.disabled) return;
    control.disabled = true;
    try {
      // a download ticket: the file arrives as an attachment, as from the Files tab
      const url = ticketUrl(await viewTicket(entry.path, entry.server, false));
      if (url === null) throw new Error("no ticket");
      const link = document.createElement("a");
      link.href = url;
      link.download = entry.name;
      document.body.append(link);
      link.click();
      link.remove();
      say("");
    } catch {
      say("Could not download the image. Try again.");
    } finally {
      control.disabled = false;
    }
  }

  return {
    // `list` is [{ url, path, server, name, alt }], `start` the one to show.
    open(list, start = 0) {
      if (!Array.isArray(list) || list.length === 0) return;
      parts ??= build();
      entries = list;
      index = wrapIndex(start, list.length);
      if (!parts.dialog.open) parts.dialog.showModal();
      show();
    },
  };
}
