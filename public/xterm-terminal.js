// The selected pane's terminal, as herdr draws it: the server's `herdr terminal
// attach` stream written into xterm.js, with typing and size going back to it.
// Adapted from herdr-web-ui (MIT), src/components/PaneTerminal.tsx.
import { matchHerdrWidths } from "./terminal-widths.js?v=1.2.12";
import { findTerminalPaths } from "./terminal-links.js?v=1.2.12";

const RESIZE_DEBOUNCE_MS = 80;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 18;

// One terminal row as text, with the cell each character starts in: a wide
// character (Hangul, CJK, emoji) takes two cells but one place in the text.
function rowText(line, cols) {
  let text = "";
  const cells = [];
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let index = 0; index < chars.length; index += 1) cells.push(x);
    text += chars;
  }
  cells.push(cols);
  return { text, cells };
}

// Colors come from the page's own terminal palette, so both views look alike.
function themeFrom(element) {
  const style = getComputedStyle(element);
  const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: color("--terminal-bg", "#111"),
    foreground: color("--terminal-text", "#ddd"),
    cursor: color("--terminal-text", "#ddd"),
  };
}

// `connection` is the page's terminal socket; `onFallback(paneId)` hears that a
// pane cannot attach, so the page shows its screen text instead.
export function createAttachedTerminal({ host, connection, xterm, fontSize, onFallback, onStateChange = () => {},
  onWebLink = (uri) => window.open(uri, "_blank", "noopener,noreferrer"),
  isViewablePath = () => false, onPath = () => {}, onFontSizeChange = () => {} }) {
  const { Terminal, FitAddon, WebLinksAddon, UnicodeGraphemesAddon } = xterm;
  let term = null;
  let fit = null;
  let paneId = null;
  let resizeTimer = null;
  // Panes this page could not attach: they keep the screen-text view.
  const unavailable = new Set();
  let held = false;
  let ready = false;

  function create() {
    term = new Terminal({
      // herdr owns the scrollback: the stream lives in the alternate screen and
      // the wheel goes to herdr as mouse reports.
      scrollback: 0,
      allowProposedApi: true,
      convertEol: false,
      fontSize,
      fontFamily: getComputedStyle(host).getPropertyValue("--mono").trim() || "monospace",
      theme: themeFrom(host),
      macOptionClickForcesSelection: true,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    matchHerdrWidths(term, UnicodeGraphemesAddon);
    term.loadAddon(new WebLinksAddon((event, uri) => { if (/^https?:\/\//iu.test(uri)) onWebLink(uri); }));
    // A file path the page can show opens in its viewer, as in the screen-text view.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) { callback(undefined); return; }
        const { text, cells } = rowText(line, term.cols);
        const links = findTerminalPaths(text, isViewablePath).map(({ start, end, path }) => ({
          range: { start: { x: cells[start] + 1, y }, end: { x: cells[end - 1] + 1, y } },
          text: path,
          // A drag that selects part of a path is not a click on it.
          activate: (event) => { if (event.button === 0 && !term.hasSelection()) onPath(path); },
        }));
        callback(links.length ? links : undefined);
      },
    });
    term.open(host);
    // Ctrl+V pastes through the browser (xterm brackets it); Ctrl+C copies a selection.
    term.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (key === "v") return false;
      if (key === "c" && term.hasSelection()) {
        if (event.type === "keydown") {
          event.preventDefault();
          void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
          term.clearSelection();
        }
        return false;
      }
      return true;
    });
    const type = (data) => { if (paneId && ready && !held) connection.ptyInput(paneId, data); };
    term.onData(type);
    term.onBinary(type);
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      // The size belongs to the pane shown when it changed, never to the next one.
      const resized = paneId;
      resizeTimer = setTimeout(() => { if (resized && resized === paneId) connection.resize(resized, cols, rows); }, RESIZE_DEBOUNCE_MS);
    });
    // A finger drag scrolls herdr's history: it becomes the wheel that herdr reads.
    // Two fingers pinch the font size, kept once they lift.
    let touchY = null;
    let pinch = null;
    const spread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    host.addEventListener("touchstart", (event) => {
      touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
      if (event.touches.length === 2 && spread(event.touches) > 0) {
        pinch = { distance: spread(event.touches), start: term.options.fontSize, size: term.options.fontSize };
      }
    }, { capture: true, passive: true });
    host.addEventListener("touchmove", (event) => {
      if (pinch && event.touches.length === 2) {
        event.preventDefault();
        const size = Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, pinch.start * spread(event.touches) / pinch.distance)));
        if (size !== pinch.size) {
          pinch.size = size;
          term.options.fontSize = size;
          fitNow();
        }
        return;
      }
      if (touchY === null || event.touches.length !== 1) return;
      event.preventDefault();
      const touch = event.touches[0];
      const delta = touchY - touch.clientY;
      touchY = touch.clientY;
      if (delta !== 0) {
        (term.element ?? host).dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaY: delta, clientX: touch.clientX, clientY: touch.clientY,
        }));
      }
    }, { capture: true, passive: false });
    const endTouch = (event) => {
      touchY = null;
      if (pinch && event.touches.length < 2) {
        if (pinch.size !== pinch.start) onFontSizeChange(pinch.size);
        pinch = null;
      }
    };
    host.addEventListener("touchend", endTouch, { capture: true, passive: true });
    host.addEventListener("touchcancel", endTouch, { capture: true, passive: true });
    new ResizeObserver(() => { if (!host.hidden) fitNow(); }).observe(host);
  }

  function fitNow() {
    if (!term || host.hidden || host.clientWidth === 0 || host.clientHeight === 0) return;
    fit.fit();
  }

  function setState(next) {
    onStateChange({ paneId, held, ready, ...next });
  }

  connection.onAttach((message) => {
    if (message.pane_id !== paneId) return;
    switch (message.type) {
      case "pty-data":
        term.write(message.data, () => {
          if (message.flow) connection.acknowledge(message.pane_id, message.flow.stream_id, message.flow.offset);
        });
        break;
      case "input-ready":
        ready = message.ready !== false;
        setState({});
        break;
      case "attach-held":
        held = true;
        setState({});
        break;
      case "attach-resumed":
        held = false;
        setState({});
        break;
      case "pane-geometry":
        if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
        break;
      case "attach-unavailable":
      case "attach-error":
        unavailable.add(paneId);
        stop();
        onFallback(message.pane_id);
        break;
      case "pty-exit":
        ready = false;
        setState({ exited: true });
        break;
      default:
        break;
    }
  });
  // A new socket has none of this page's attachments: ask again with a clean screen.
  connection.onReconnect(() => {
    if (!paneId) return;
    ready = false;
    held = false;
    term?.reset();
    attachCurrent();
  });

  function attachCurrent() {
    fitNow();
    connection.attach(paneId, { cols: term.cols, rows: term.rows });
  }

  function stop() {
    clearTimeout(resizeTimer);
    if (paneId) connection.detach(paneId);
    paneId = null;
    ready = false;
    held = false;
    host.hidden = true;
  }

  return {
    // Shows `nextPaneId` here; false when it keeps the screen-text view.
    show(nextPaneId) {
      if (!nextPaneId || unavailable.has(nextPaneId)) {
        if (paneId) stop();
        return false;
      }
      if (nextPaneId === paneId) return true;
      if (!term) create();
      clearTimeout(resizeTimer);
      if (paneId) connection.detach(paneId);
      paneId = nextPaneId;
      ready = false;
      held = false;
      host.hidden = false;
      term.reset();
      setState({});
      attachCurrent();
      return true;
    },
    takeOver() { if (paneId && held) connection.takeOver(paneId); },
    setFontSize(size) {
      if (!term) return;
      term.options.fontSize = size;
      fitNow();
    },
  };
}
