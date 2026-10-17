// The selected pane's terminal, as herdr draws it: the server's `herdr terminal
// attach` stream written into xterm.js, with typing and size going back to it.
// Adapted from herdr-web-ui (MIT), src/components/PaneTerminal.tsx.
import { matchHerdrWidths } from "./terminal-widths.js?v=1.2.71";
import { findScreenLinks } from "./terminal-links.js?v=1.2.71";
import { createTouchScroller } from "./touch-scroll.js?v=1.2.71";
import { cellAt, selectionRun } from "./terminal-selection.js?v=1.2.71";
import { findOccurrences } from "./terminal-find.js?v=1.2.71";

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

// A pane that cannot attach is mirrored: the screen the page polls, drawn over
// the whole terminal each time. Clear the scrollback and the screen, home,
// and every line break as CRLF,
// since the polled text has bare LFs and xterm would otherwise step down
// without returning to the first column. One trailing line break is dropped so
// the last line is not scrolled away under a full screen. Lines above the
// screen land in xterm's own scrollback, which a mirror turns on.
export function mirrorFrame(text) {
  const body = String(text ?? "").replace(/\r?\n$/u, "").replace(/\r?\n/gu, "\r\n");
  return `\x1b[0m\x1b[3J\x1b[H\x1b[2J${body}`;
}

// Enough for every line the page polls for a mirror.
const MIRROR_SCROLLBACK = 1000;

// `connection` is the page's terminal socket; `onFallback(paneId, problem)` hears
// that a pane cannot attach, so the page mirrors its polled screen instead.
// `problem` is { code, message, retryAt }: the server's reason ("ended" when
// herdr ended the attach), and when it is tried again (Infinity: never).
export function createAttachedTerminal({ host, connection, xterm, fontSize, onFallback, onStateChange = () => {},
  onWebLink = (uri) => window.open(uri, "_blank", "noopener,noreferrer"),
  isLinkablePath = () => false, onPath = () => {}, onFontSizeChange = () => {}, onRetry = () => {},
  onCopy = () => {}, onViewMoved = () => {} }) {
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
  // Panes this page could not attach, and until when: they are mirrored
  // meanwhile. Only a pane that can never attach here stays mirrored.
  const unavailable = new Map();
  const RETRY_ATTACH_MS = 5_000;
  let held = false;
  let ready = false;
  // Whether this page sets the pane's size. Another page that is in use sets
  // it otherwise, and this one shows that grid as it is.
  let owner = true;
  // The pane drawn from polled text rather than attached, if one is. Nothing
  // typed into the terminal reaches it: `type` below only writes to an
  // attached pane.
  let mirrored = null;
  // The newest frame held back while the reader is scrolled up in a mirror,
  // or while xterm is still drawing the one before: drawn once they are back
  // at the bottom and xterm is done, so frames never pile up in its queue.
  let heldFrame = null;
  // False from a screen clear until the first output of the new stream is drawn.
  let drawn = false;
  let drawingFrame = false;
  // Writes handed to xterm and not drawn yet (pty data and mirror frames).
  let writesInFlight = 0;
  // A phone keyboard is up, and the frame's height when it last fitted.
  let keyboardOpen = false;
  let fullHeight = 0;

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
    term.onScroll(drawHeldFrame);
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
      findMarks = screen.ownerDocument.createElement("div");
      findMarks.className = "terminal-find-marks";
      screen.append(findMarks, marks);
    }
    // The reader moving the view (the wheel, or a finger, which becomes the
    // wheel) leaves a found match's place on screen unknown.
    host.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey && event.deltaY !== 0) onViewMoved();
    }, { capture: true, passive: true });
    term.onRender(scheduleLinks);
    term.onResize(scheduleLinks);
    // Ctrl+V pastes through the browser (xterm brackets it); Ctrl+C copies a selection.
    // Ctrl+Enter is a line feed, Ctrl+J, as a native terminal gives it: a new
    // line in Claude Code and Codex rather than sending. xterm alone would make
    // it a plain Enter.
    term.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      // mid-composition the IME owns the key, as xterm itself leaves it
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        if (event.type === "keydown") {
          event.preventDefault();
          type("\n");
        }
        return false;
      }
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
    } else {
      console.warn("xterm's selection hook is missing: a mouse drag goes to the program, and only Shift+drag selects.");
    }
    // xterm sends a mouse report as typing, and typing clears the selection: under
    // a program that tracks the mouse, as Claude Code does, the first move after
    // a drag dropped what was just selected. Reports still reach the program;
    // only real typing clears the selection. (xterm 5.5 private API, pinned.)
    const mouse = term._core?.coreMouseService;
    const input = term._core?.coreService;
    if (typeof mouse?.triggerMouseEvent === "function" && typeof input?.triggerDataEvent === "function") {
      let reporting = false;
      const report = mouse.triggerMouseEvent.bind(mouse);
      mouse.triggerMouseEvent = (event) => {
        reporting = true;
        try { return report(event); } finally { reporting = false; }
      };
      const send = input.triggerDataEvent.bind(input);
      input.triggerDataEvent = (data, wasUserInput) => send(data, wasUserInput && !reporting);
    } else {
      console.warn("xterm's mouse report hook is missing: moving the mouse over a program that tracks it clears the selection.");
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
      onViewMoved();
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
      emit: (direction) => wheelNotch(direction, touchX),
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
  // What the find bar looks for, marked wherever it shows on screen, and the
  // screen cell of herdr's current match, marked apart.
  let findMarks = null;
  let find = null;
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
    screenLinks = findScreenLinks(rows, { isLinkablePath });
    const screen = marks.parentElement;
    const cellWidth = screen ? screen.offsetWidth / term.cols : 0;
    const cellHeight = screen ? screen.offsetHeight / term.rows : 0;
    findMarks.replaceChildren(...(find ? findOccurrences(rows, find.query, find.current) : []).map((found) => {
      const mark = findMarks.ownerDocument.createElement("span");
      if (found.current) mark.className = "is-current";
      mark.style.left = `${found.start * cellWidth}px`;
      mark.style.top = `${found.row * cellHeight}px`;
      mark.style.width = `${(found.end - found.start) * cellWidth}px`;
      mark.style.height = `${cellHeight}px`;
      return mark;
    }));
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
    // A phone keyboard only covers the screen for a while: the pane keeps its
    // size, so herdr and every other screen on it are not resized each time.
    if (keyboardOpen) return;
    fullHeight = host.clientHeight;
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
        writesInFlight += 1;
        term.write(message.data, () => {
          writesInFlight -= 1;
          if (stream === generation) drawn = true;
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
        fallBack(message.code === "attach_unsupported" ? Infinity : Date.now() + RETRY_ATTACH_MS,
          { code: message.code ?? "attach_failed", message: message.message ?? "" });
        break;
      // Typing that arrived while the attach was not ready never reached the pane.
      case "pty-input-dropped":
        setState({ dropped: true });
        break;
      // herdr ended the attach: the pane is mirrored meanwhile.
      case "pty-exit":
        fallBack(Date.now() + RETRY_ATTACH_MS, { code: "ended", message: "" });
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
    setState({});
  });

  // Each pane shown, and each socket, is a new stream. xterm writes in order,
  // so a full reset (RIS) queued behind writes still in flight clears what
  // they draw too, and the new stream starts on a clean screen.
  let generation = 0;
  function clearScreen() {
    generation += 1;
    drawn = false;
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
  // One wait per pane: Reconnect on one, or another failing, leaves the
  // others' own retries alone.
  const retryTimers = new Map();
  function fallBack(until, problem) {
    const failed = paneId;
    unavailable.set(failed, until);
    stop();
    onFallback(failed, { ...problem, retryAt: until });
    clearTimeout(retryTimers.get(failed));
    retryTimers.delete(failed);
    if (Number.isFinite(until)) {
      retryTimers.set(failed, setTimeout(() => { retryTimers.delete(failed); onRetry(failed); }, Math.max(0, until - Date.now()) + 50));
    }
  }

  function drawFrame(frame) {
    heldFrame = frame;
    drawHeldFrame();
  }

  function drawHeldFrame() {
    if (heldFrame === null || drawingFrame || !atBottom()) return;
    const frame = heldFrame;
    heldFrame = null;
    drawingFrame = true;
    const stream = generation;
    writesInFlight += 1;
    term.write(frame, () => {
      writesInFlight -= 1;
      if (stream === generation) drawn = true;
      drawingFrame = false;
      if (mirrored) drawHeldFrame();
    });
  }

  function atBottom() {
    const buffer = term.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  }

  // One notch of the wheel that herdr reads as a scroll of its history.
  function wheelNotch(direction, clientX = host.getBoundingClientRect().left + 20) {
    (term.element ?? host).dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: direction * 100, clientX, clientY: host.getBoundingClientRect().top + 20,
    }));
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
    // Attaches `nextPaneId` here; false when it cannot now, and the page
    // mirrors it instead.
    show(nextPaneId) {
      if (!nextPaneId || (unavailable.get(nextPaneId) ?? 0) > Date.now()) {
        if (paneId) stop();
        if (!nextPaneId && mirrored) { mirrored = null; host.hidden = true; }
        return false;
      }
      mirrored = null;
      heldFrame = null;
      // Back from the background, the socket was closed: connect it again.
      if (nextPaneId === paneId) { connection.resume(); return true; }
      if (!term) create();
      // herdr owns the scrollback of an attached pane.
      term.options.scrollback = 0;
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
    // Draws `text` as the whole screen of a pane that is not attached.
    // Read-only: keystrokes in the terminal go nowhere, and the page's
    // composer sends text to the pane instead.
    mirror(nextPaneId, text) {
      if (!nextPaneId || nextPaneId === paneId) return false;
      if (paneId) stop();
      if (!term) create();
      if (mirrored !== nextPaneId) {
        mirrored = nextPaneId;
        heldFrame = null;
        clearScreen();
        term.options.scrollback = MIRROR_SCROLLBACK;
      }
      // A mirror has no other page sizing it: it fits its own frame, even when
      // the attach before it was following another page's grid.
      owner = true;
      host.classList.remove("is-adopted");
      host.hidden = false;
      fitNow();
      // A reader scrolled up keeps their place; the newest frame waits.
      drawFrame(mirrorFrame(text));
      return true;
    },
    takeOver() { if (paneId && held) connection.takeOver(paneId); },
    // Reconnect pressed on a pane that failed to attach: its wait is skipped,
    // and the page is asked to show it again now.
    retryNow(failed) {
      if (!failed || !unavailable.has(failed)) return false;
      unavailable.delete(failed);
      clearTimeout(retryTimers.get(failed));
      retryTimers.delete(failed);
      onRetry(failed);
      return true;
    },
    setFontSize(size) {
      if (!term) return;
      term.options.fontSize = size;
      fitNow();
    },
    // The last lines of the screen that hold text, for the page to tell whether
    // a program asks for a password. `paneId` is the pane the screen belongs
    // to, and `fresh` is false whenever the text cannot be trusted to be that
    // pane's current screen: no terminal yet, parked, the first frame of a new
    // stream not drawn, or a frame held back because the reader scrolled up.
    screenText(lines = 8) {
      const shown = paneId ?? mirrored ?? null;
      if (!term) return { paneId: shown, text: "", cols: 0, fresh: false };
      const buffer = term.buffer.active;
      const rows = [];
      for (let y = buffer.baseY; y < buffer.baseY + term.rows; y += 1) rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
      while (rows.length && rows.at(-1).trim() === "") rows.pop();
      // output still being drawn may be the prompt itself: not yet the screen
      const fresh = shown !== null && !host.hidden && drawn && heldFrame === null && !drawingFrame && writesInFlight === 0 && atBottom();
      return { paneId: shown, text: rows.slice(-lines).join("\n"), cols: term.cols, fresh };
    },
    // Fits again once the terminal is shown (the Terminal lens, with the key bar back).
    refit() { fitNow(); },
    // Marks `query` where it shows, and the match at `current` ({ row, col }
    // on screen) apart; null clears the marks.
    setFind(next) {
      find = next && next.query ? { query: next.query, current: next.current ?? null } : null;
      scheduleLinks();
    },
    focus() { term?.focus(); },
    // While a phone keyboard is up the terminal does not fit to the smaller
    // frame; it shows its foot instead, and fits again once the keyboard goes.
    setKeyboardOpen(open) {
      // Never fitted (hidden until now): there is no size to keep yet.
      if (open && fullHeight === 0) open = false;
      if (open === keyboardOpen) return;
      keyboardOpen = open;
      if (open) host.style.setProperty("--terminal-full-height", `${fullHeight}px`);
      else host.style.removeProperty("--terminal-full-height");
      host.classList.toggle("is-keyboard-open", open);
      if (!open) fitNow();
    },
    // Brings the viewport to the newest output: a mirror's own scrollback, and
    // any frame it held back meanwhile. True when a pane is attached (herdr's
    // view of it is the server's to move).
    scrollToBottom() {
      if (!term || host.hidden) return false;
      term.scrollToBottom();
      drawHeldFrame();
      return Boolean(paneId);
    },
    // Scrolls herdr's history of the attached pane by a screen, up for -1.
    // False when no pane is attached: a mirror shows its current screen only.
    scrollPage(direction) {
      if (!term || host.hidden || !paneId) return false;
      const notches = Math.max(1, Math.round((term.rows - 1) / LINES_PER_NOTCH));
      for (let notch = 0; notch < notches; notch += 1) wheelNotch(direction);
      return true;
    },
  };
}
