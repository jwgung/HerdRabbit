import { createAttachTracker, terminalStatus, terminalStatusParts } from "../terminal-status.js?v=1.4.30";
import { array } from "./dom.js?v=1.4.30";

// The terminal status strip and its Reconnect button, the phone keyboard, and
// letting the terminal go after a while in the Chat lens. Nothing here runs
// until createTerminalStatus is called; app.js calls it where this code used
// to sit, so its listeners are added in the same order as before.
// `phoneKeyboardOpen` and `composerKeyboardDismissed` stay in app.js, which the
// composer and key bar also read and set; they are read and set here through
// accessors on `deps`. `chatLens` is made after this and is read through a getter.
export function createTerminalStatus(deps) {
  const {
    state, elements, terminalStream, attachedTerminal, paneCalls,
    paneServerId, shownGrid, refreshTerminal, usesTouchInputEnvironment, syncSendButton,
  } = deps;

  // The strip over the Terminal lens that says why the terminal is not live:
  // the socket is down, or the pane on screen could not attach. Quiet during a
  // normal connect, gone as soon as the terminal is live again. A held pane has
  // its own strip (#terminal-held), and the Chat lens shows neither.
  // Where the pane on screen is in attaching, and why each pane last failed to.
  const attachTracker = createAttachTracker();
  let terminalConnectionState = terminalStream.connectionState;
  let terminalStatusTimer = null;
  let terminalStatusShown = null;

  function noteTerminalAttach(paneId, next) {
    attachTracker.note(paneId, next);
    renderTerminalStatus();
  }

  function terminalMachine(paneId) {
    const serverId = paneServerId(paneId);
    if (!serverId || serverId === "local") return null;
    return array(state.snapshot?.servers).find((item) => item.id === serverId)?.name || null;
  }

  function renderTerminalStatus() {
    window.clearTimeout(terminalStatusTimer);
    terminalStatusTimer = null;
    const paneId = state.selectedPaneId;
    const attach = attachTracker.of(paneId);
    const signedOut = terminalConnectionState.state === "signed-out";
    const { status, recheckAt } = ((state.authenticated && !document.hidden) || signedOut) && !shownGrid()
      ? terminalStatus({
        connection: terminalConnectionState,
        attach: attach && { ...attach, machine: terminalMachine(paneId) },
        offline: navigator.onLine === false,
      })
      : { status: null, recheckAt: null };
    terminalStatusShown = status;
    elements.terminalStatus.hidden = !status;
    if (status) {
      // Only a changed reason is announced; the countdown ticks silently.
      const { reason, countdown } = terminalStatusParts(status);
      if (elements.terminalStatusText.textContent !== reason) elements.terminalStatusText.textContent = reason;
      elements.terminalStatusCountdown.textContent = countdown;
      elements.terminalStatus.dataset.target = status.target;
      elements.terminalStatus.classList.toggle("is-quiet", Boolean(status.quiet));
      elements.terminalReconnect.hidden = !status.reconnect;
    }
    if (recheckAt !== null) {
      terminalStatusTimer = window.setTimeout(renderTerminalStatus, Math.max(50, Math.min(1000, recheckAt - Date.now())));
    }
  }

  terminalStream.onConnectionState((next) => {
    terminalConnectionState = next;
    renderTerminalStatus();
  });

  elements.terminalReconnect.addEventListener("click", () => {
    const status = terminalStatusShown;
    if (!status?.reconnect) return;
    if (status.target === "connection") {
      terminalStream.reconnectNow();
      return;
    }
    const paneId = state.selectedPaneId;
    if (!paneId) return;
    state.terminalParked = null;
    // A pane waiting out its retry is tried now; one still attaching is asked again.
    if (!attachedTerminal.retryNow(paneId)) void refreshTerminal();
    renderTerminalStatus();
  });

  // The network coming back is worth trying at once, not at the end of the wait.
  window.addEventListener("online", () => {
    if (state.authenticated && !document.hidden) terminalStream.reconnectNow();
    renderTerminalStatus();
  });
  window.addEventListener("offline", () => renderTerminalStatus());

  // A phone keyboard takes the bottom of the screen. The page shrinks to what is
  // still visible, so the composer and key bar sit just above the keyboard
  // instead of under it, and the terminal keeps its size and shows its foot.
  // The tallest height seen at a width is the screen without a keyboard; each
  // width (a phone held upright or turned) keeps its own.
  // A keyboard takes far more than this; a browser's address bar folding away
  // takes less.
  const KEYBOARD_MIN_HEIGHT_PX = 120;
  if (window.visualViewport) {
    const viewport = window.visualViewport;
    const unobstructedHeights = new Map();
    const followKeyboard = () => {
      const width = Math.round(viewport.width);
      const unobstructed = Math.max(unobstructedHeights.get(width) ?? 0, viewport.height);
      unobstructedHeights.set(width, unobstructed);
      // Only typing brings a keyboard: a split screen or a resized window with
      // nothing focused is a smaller screen, which the terminal fits.
      const typing = document.activeElement instanceof HTMLElement && document.activeElement.matches("input, textarea");
      const open = usesTouchInputEnvironment() && typing && viewport.height < unobstructed - KEYBOARD_MIN_HEIGHT_PX;
      if (open) document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
      else document.documentElement.style.removeProperty("--app-height");
      const dismissed = deps.phoneKeyboardOpen && !open && document.activeElement === elements.terminalInput;
      deps.phoneKeyboardOpen = open;
      if (open) deps.composerKeyboardDismissed = false;
      if (dismissed) {
        deps.composerKeyboardDismissed = true;
        syncSendButton();
      }
      attachedTerminal.setKeyboardOpen(open);
      // The browser may have scrolled the page to show the composer; the page
      // now fits, so it goes back to the top.
      if (open && window.scrollY) window.scrollTo(0, 0);
    };
    viewport.addEventListener("resize", followKeyboard);
    followKeyboard();
  }

  // A conversation page or tool output for the Chat lens. The answer's ETag
  // comes back as If-None-Match, so an unchanged page costs no body (a 304).
  // After this long in the Chat lens without the terminal, the terminal is let
  // go (detached); switching back attaches it again and herdr redraws it.
  const TERMINAL_PARK_MS = 5 * 60_000;
  const SCROLL_BOTTOM_RETRY_MS = 1_000;
  let terminalParkTimer = null;

  // Back from the Chat lens, the terminal shows the newest output: herdr's
  // shared view of the pane goes to the bottom (asked of the server), and so
  // does xterm's own viewport. A terminal let go while parked attaches again
  // right after, so it counts too; a mirror has no herdr view to move.
  // A request that fails is tried once more a moment later, while the pane is
  // still the one in view in the terminal.
  function showNewestTerminalOutput(paneId, { retry = true } = {}) {
    const attached = attachedTerminal.scrollToBottom();
    if (!attached && state.terminalParked !== paneId) return;
    paneCalls.scrollToBottom(paneId).catch(() => {
      if (!retry) return;
      window.setTimeout(() => {
        if (deps.chatLens.lens === "terminal" && state.selectedPaneId === paneId) showNewestTerminalOutput(paneId, { retry: false });
      }, SCROLL_BOTTOM_RETRY_MS);
    });
  }

  function scheduleTerminalPark(lens, paneId) {
    window.clearTimeout(terminalParkTimer);
    terminalParkTimer = null;
    if (lens !== "chat" || !paneId) return;
    terminalParkTimer = window.setTimeout(() => {
      terminalParkTimer = null;
      if (deps.chatLens.lens !== "chat" || state.selectedPaneId !== paneId) return;
      state.terminalParked = paneId;
      attachedTerminal.show(null);
      terminalStream.unwatch();
    }, TERMINAL_PARK_MS);
  }

  return { attachTracker, noteTerminalAttach, renderTerminalStatus, showNewestTerminalOutput, scheduleTerminalPark };
}
