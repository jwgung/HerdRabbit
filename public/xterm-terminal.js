// The selected pane's terminal, as herdr draws it: the server's `herdr terminal
// attach` stream written into xterm.js, with typing and size going back to it.
// Adapted from herdr-web-ui (MIT), src/components/PaneTerminal.tsx.
import { matchHerdrWidths } from "./terminal-widths.js?v=1.2.16";
import { findScreenLinks } from "./terminal-links.js?v=1.2.16";
import { createTouchScroller } from "./touch-scroll.js?v=1.2.16";
import { cellAt, selectionRun } from "./terminal-selection.js?v=1.2.16";

const RESIZE_DEBOUNCE_MS = 80;
// herdr scrolls this many lines per wheel notch (measured on herdr 0.9.3).
const LINES_PER_NOTCH = 3;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 18;
// A finger held this long without moving starts selecting text.
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;

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
  isViewablePath = () => false, onPath = () => {}, onFontSizeChange = () => {}, onRetry = () => {},
  onCopy = () => {} }) {
  const { Terminal, FitAddon, UnicodeGraphemesAddon } = xterm;
  let term = null;
  // The finger scroll; a glide stops when the pane changes or goes away.
  let scroller = null;
  // The Copy bar over a selection, and the finger selecting, if one is.
  let copyBar = null;
  let selecting = null;
  // A finger held still, before it starts selecting.
  let pressTimer = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  let fit = null;
  let paneId = null;
  let resizeTimer = null;
  // Panes this page could not attach, and until when: they keep the
  // screen-text view. Only a pane that can never attach here stays there.
  const unavailable = new Map();
  const RETRY_ATTACH_MS = 5_000;
  let held = false;
  let ready = false;
  // Whether this page sets the pane's size. Another page that is in use sets
  // it otherwise, and this one shows that grid as it is.
  let owner = true;

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
    // Web addresses and file paths the page can show are found on the whole
    // screen, so one an agent's output wrapped onto the next row is still one
    // link. They are underlined all the time, not only under a mouse: on a
    // phone nothing hovers, and a link has to be seen to be tapped.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const row = y - 1 - term.buffer.active.viewportY;
        const links = screenLinks.filter((link) => link.segments.some((segment) => segment.row === row)).map((link) => {
          const first = link.segments[0];
          const last = link.segments.at(-1);
          const top = term.buffer.active.viewportY + 1;
          return {
            range: { start: { x: first.start + 1, y: top + first.row }, end: { x: last.end, y: top + last.row } },
            text: link.target,
            // A drag that selects part of a link is not a click on it.
            activate: (event) => {
              if (event.button !== 0 || term.hasSelection()) return;
              if (link.kind === "url") onWebLink(link.target);
              else onPath(link.target);
            },
          };
        });
        callback(links.length ? links : undefined);
      },
    });
    term.open(host);
    const screen = term.element?.querySelector(".xterm-screen");
    if (screen) {
      marks = screen.ownerDocument.createElement("div");
      marks.className = "terminal-link-marks";
      screen.append(marks);
    }
    term.onRender(scheduleLinks);
    term.onResize(scheduleLinks);
    // Ctrl+V pastes through the browser (xterm brackets it); Ctrl+C copies a selection.
    term.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (key === "v") return false;
      if (key === "c" && term.hasSelection()) {
        if (event.type === "keydown") {
          event.preventDefault();
          void copySelection();
        }
        return false;
      }
      return true;
    });
    // Ctrl+wheel, and a trackpad pinch, size the font on the page; xterm would
    // pass them on to herdr as a scroll.
    term.attachCustomWheelEventHandler((event) => !(event.ctrlKey || event.metaKey));
    // herdr's attach selects nothing itself, so a plain left drag selects text
    // here, as on any page, instead of going to the program as mouse reports.
    // The wheel still scrolls herdr. (xterm 5.5 private API; the bundle is pinned.)
    const selectionService = term._core?._selectionService;
    if (typeof selectionService?.shouldForceSelection === "function") {
      const forced = selectionService.shouldForceSelection.bind(selectionService);
      selectionService.shouldForceSelection = (event) => event.button === 0 || forced(event);
    }
    copyBar = host.ownerDocument.createElement("div");
    copyBar.className = "terminal-copy-bar";
    copyBar.hidden = true;
    const copyButton = host.ownerDocument.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", () => void copySelection());
    const dismissButton = host.ownerDocument.createElement("button");
    dismissButton.type = "button";
    dismissButton.textContent = "Cancel";
    dismissButton.addEventListener("click", () => term.clearSelection());
    copyBar.append(copyButton, dismissButton);
    host.append(copyBar);
    // The bar offers to copy whatever is selected, by mouse or by finger.
    term.onSelectionChange(() => { copyBar.hidden = !term.hasSelection() || Boolean(selecting); });
    host.addEventListener("contextmenu", (event) => { if (selecting || term.hasSelection()) event.preventDefault(); });
    const type = (data) => {
      if (!paneId || !ready || held) return;
      // A socket that dropped has not told this pane yet: say the typing was lost.
      if (!connection.ptyInput(paneId, data)) {
        ready = false;
        setState({ dropped: true });
      }
    };
    term.onData(type);
    term.onBinary(type);
    term.onResize(({ cols, rows }) => {
      // A grid taken from the page that sets the size is not this page's wish.
      if (!owner) return;
      clearTimeout(resizeTimer);
      // The size belongs to the pane shown when it changed, never to the next one.
      const resized = paneId;
      resizeTimer = setTimeout(() => { if (resized && resized === paneId) connection.resize(resized, cols, rows); }, RESIZE_DEBOUNCE_MS);
    });
    // A finger drag scrolls herdr's history: it becomes the wheel that herdr
    // reads, one notch per three lines the finger travels, gliding on after a
    // flick. Two fingers pinch the font size, kept once they lift.
    let touchX = 0;
    scroller = createTouchScroller({
      step: () => {
        const screen = term.element?.querySelector(".xterm-screen");
        const lineHeight = screen && term.rows ? screen.offsetHeight / term.rows : 16;
        return lineHeight * LINES_PER_NOTCH;
      },
      emit: (direction) => {
        (term.element ?? host).dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaY: direction * 100, clientX: touchX, clientY: host.getBoundingClientRect().top + 20,
        }));
      },
    });
    let pinch = null;
    // A held finger selects: from the cell it was held on to the one under it.
    let pressAt = null;
    const cellUnder = (x, y) => {
      const screen = term.element?.querySelector(".xterm-screen");
      if (!screen) return { col: 0, row: term.buffer.active.viewportY };
      const cell = cellAt(screen.getBoundingClientRect(), term.cols, term.rows, x, y);
      return { col: cell.col, row: cell.row + term.buffer.active.viewportY };
    };
    const selectTo = (point) => {
      const run = selectionRun(selecting.anchor, point, term.cols);
      term.select(run.col, run.row, run.length);
    };
    const spread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    // A touch's later events go to the element it began on. Scrolling redraws
    // the rows, so that row leaves the page; events aimed at it then reach
    // nothing above it, not even the window. They are followed on it instead.
    const followed = new WeakSet();
    const follow = (target) => {
      if (!target || followed.has(target)) return;
      followed.add(target);
      target.addEventListener("touchmove", onMove, { passive: false });
      target.addEventListener("touchend", endTouch, { passive: true });
      target.addEventListener("touchcancel", endTouch, { passive: true });
    };
    host.addEventListener("touchstart", (event) => {
      // The copy bar's buttons take their own taps.
      if (copyBar.contains(event.target)) return;
      follow(event.target);
      cancelPress();
      if (event.touches.length === 1) {
        // A tap elsewhere lets go of what was selected.
        if (term.hasSelection()) term.clearSelection();
        touchX = event.touches[0].clientX;
        scroller.start(event.touches[0].clientY);
        pressAt = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        pressTimer = setTimeout(() => {
          pressTimer = null;
          scroller.cancel();
          selecting = { anchor: cellUnder(pressAt.x, pressAt.y) };
          selectTo(selecting.anchor);
          navigator.vibrate?.(10);
        }, LONG_PRESS_MS);
      } else {
        scroller.cancel();
        selecting = null;
      }
      if (event.touches.length === 2 && spread(event.touches) > 0) {
        pinch = { distance: spread(event.touches), start: term.options.fontSize, size: term.options.fontSize };
      }
    }, { capture: true, passive: true });
    function onMove(event) {
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
      if (event.touches.length !== 1) return;
      event.preventDefault();
      const touch = event.touches[0];
      if (selecting) {
        selectTo(cellUnder(touch.clientX, touch.clientY));
        return;
      }
      if (pressTimer && Math.hypot(touch.clientX - pressAt.x, touch.clientY - pressAt.y) > LONG_PRESS_SLOP_PX) cancelPress();
      touchX = touch.clientX;
      scroller.move(touch.clientY);
    }
    function endTouch(event) {
      cancelPress();
      if (selecting && event.touches.length === 0) {
        selecting = null;
        copyBar.hidden = !term.hasSelection();
        return;
      }
      if (event.type === "touchcancel") scroller.cancel();
      else if (event.touches.length === 0) scroller.end();
      if (pinch && event.touches.length < 2) {
        if (pinch.size !== pinch.start) onFontSizeChange(pinch.size);
        pinch = null;
      }
    }
    new ResizeObserver(() => { if (!host.hidden) fitNow(); }).observe(host);
  }

  // The links on screen now, and their underlines, redrawn once per frame at most.
  let screenLinks = [];
  let marks = null;
  let linksFrame = null;
  function scheduleLinks() {
    if (!marks || linksFrame !== null) return;
    linksFrame = requestAnimationFrame(() => {
      linksFrame = null;
      refreshLinks();
    });
  }

  function refreshLinks() {
    if (!term || !marks) return;
    const buffer = term.buffer.active;
    const rows = [];
    for (let y = 0; y < term.rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      rows.push(line ? rowText(line, term.cols) : { text: "", cells: [term.cols] });
    }
    screenLinks = findScreenLinks(rows, { isViewablePath });
    const screen = marks.parentElement;
    const cellWidth = screen ? screen.offsetWidth / term.cols : 0;
    const cellHeight = screen ? screen.offsetHeight / term.rows : 0;
    marks.replaceChildren(...screenLinks.flatMap((link) => link.segments.map((segment) => {
      const mark = marks.ownerDocument.createElement("span");
      mark.style.left = `${segment.start * cellWidth}px`;
      mark.style.top = `${(segment.row + 1) * cellHeight - 2}px`;
      mark.style.width = `${(segment.end - segment.start) * cellWidth}px`;
      return mark;
    })));
  }

  // The size this page's frame would hold.
  function wantedSize() {
    const proposed = fit.proposeDimensions();
    return proposed && proposed.cols > 0 && proposed.rows > 0
      ? { cols: proposed.cols, rows: proposed.rows }
      : { cols: term.cols, rows: term.rows };
  }

  function fitNow() {
    if (!term || host.hidden || host.clientWidth === 0 || host.clientHeight === 0) return;
    if (owner) { fit.fit(); return; }
    // Not this page's grid to change: it only says what it would want, for
    // when it takes the size over by typing.
    const { cols, rows } = wantedSize();
    clearTimeout(resizeTimer);
    const resized = paneId;
    resizeTimer = setTimeout(() => { if (resized && resized === paneId) connection.resize(resized, cols, rows); }, RESIZE_DEBOUNCE_MS);
  }

  function setState(next) {
    onStateChange({ paneId, held, ready, ...next });
  }

  connection.onAttach((message) => {
    if (message.pane_id !== paneId) return;
    switch (message.type) {
      case "pty-data": {
        const stream = generation;
        term.write(message.data, () => {
          // Drawn after the page moved on to another pane or socket: that credit is not owed.
          if (message.flow && stream === generation) connection.acknowledge(message.pane_id, message.flow.stream_id, message.flow.offset);
        });
        break;
      }
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
        owner = message.owner !== false;
        host.classList.toggle("is-adopted", !owner);
        if (owner) fitNow();
        else if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
        break;
      case "attach-unavailable":
      case "attach-error":
        fallBack(message.code === "attach_unsupported" ? Infinity : Date.now() + RETRY_ATTACH_MS);
        break;
      // Typing that arrived while the attach was not ready never reached the pane.
      case "pty-input-dropped":
        setState({ dropped: true });
        break;
      // herdr ended the attach: the screen text shows the pane meanwhile.
      case "pty-exit":
        fallBack(Date.now() + RETRY_ATTACH_MS);
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
    clearScreen();
    attachCurrent();
  });

  // Each pane shown, and each socket, is a new stream. xterm writes in order,
  // so a full reset (RIS) queued behind writes still in flight clears what
  // they draw too, and the new stream starts on a clean screen.
  let generation = 0;
  function clearScreen() {
    generation += 1;
    cancelPress();
    selecting = null;
    term?.clearSelection();
    term?.write("\x1bc");
  }

  // The clipboard API needs a secure page; over plain HTTP the older copy
  // command still works from a tap. `onCopy(ok)` hears how it went.
  async function copySelection() {
    const text = term.getSelection();
    term.clearSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onCopy(true);
      return;
    } catch {}
    const scratch = host.ownerDocument.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    host.ownerDocument.body.append(scratch);
    scratch.select();
    let ok = false;
    try { ok = host.ownerDocument.execCommand("copy"); } catch {}
    scratch.remove();
    onCopy(ok);
  }

  function attachCurrent() {
    const size = wantedSize();
    if (owner) fit.fit();
    connection.attach(paneId, size);
  }

  // A pane that failed for now is tried again once its wait is over, even if
  // nothing else on the page asks for it.
  let retryTimer = null;
  function fallBack(until) {
    const failed = paneId;
    unavailable.set(failed, until);
    stop();
    onFallback(failed);
    clearTimeout(retryTimer);
    if (Number.isFinite(until)) retryTimer = setTimeout(() => onRetry(failed), Math.max(0, until - Date.now()) + 50);
  }

  function stop() {
    clearTimeout(resizeTimer);
    cancelPress();
    scroller?.cancel();
    if (paneId) connection.detach(paneId);
    paneId = null;
    ready = false;
    held = false;
    host.hidden = true;
  }

  return {
    // Shows `nextPaneId` here; false when it keeps the screen-text view.
    show(nextPaneId) {
      if (!nextPaneId || (unavailable.get(nextPaneId) ?? 0) > Date.now()) {
        if (paneId) stop();
        return false;
      }
      // Back from the background, the socket was closed: connect it again.
      if (nextPaneId === paneId) { connection.resume(); return true; }
      if (!term) create();
      clearTimeout(resizeTimer);
      scroller?.cancel();
      if (paneId) connection.detach(paneId);
      paneId = nextPaneId;
      ready = false;
      held = false;
      owner = true;
      host.classList.remove("is-adopted");
      host.hidden = false;
      clearScreen();
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
