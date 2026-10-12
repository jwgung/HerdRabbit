// The selected pane's terminal, as herdr draws it: the server's `herdr terminal
// attach` stream written into xterm.js, with typing and size going back to it.
// Adapted from herdr-web-ui (MIT), src/components/PaneTerminal.tsx.
import { matchHerdrWidths } from "./terminal-widths.js?v=1.2.12";

const RESIZE_DEBOUNCE_MS = 80;

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
export function createAttachedTerminal({ host, connection, xterm, fontSize, onFallback, onStateChange = () => {}, onWebLink = (uri) => window.open(uri, "_blank", "noopener,noreferrer") }) {
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
    term.onData((data) => { if (paneId && ready && !held) connection.ptyInput(paneId, data); });
    term.onBinary((data) => { if (paneId && ready && !held) connection.ptyInput(paneId, data); });
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (paneId) connection.resize(paneId, cols, rows); }, RESIZE_DEBOUNCE_MS);
    });
    // A finger drag scrolls herdr's history: it becomes the wheel that herdr reads.
    let touchY = null;
    host.addEventListener("touchstart", (event) => {
      touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
    }, { capture: true, passive: true });
    host.addEventListener("touchmove", (event) => {
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
    host.addEventListener("touchend", () => { touchY = null; }, { capture: true, passive: true });
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
    hide() { if (paneId) stop(); },
    takeOver() { if (paneId && held) connection.takeOver(paneId); },
    focus() { term?.focus(); },
    setFontSize(size) {
      if (!term) return;
      term.options.fontSize = size;
      fitNow();
    },
    get paneId() { return paneId; },
  };
}
