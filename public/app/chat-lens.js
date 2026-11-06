import { createTerminalFind, isFindShortcut } from "../terminal-find.js?v=1.4.44";
import { createChatLens } from "../chat/chat-view.js?v=1.4.44";
import { createChatImages } from "../chat/chat-images.js?v=1.4.44";
import { createImageViewer } from "../chat/image-viewer.js?v=1.4.44";
import { createChatFind } from "../chat/chat-find.js?v=1.4.44";
import { composerPlaceholder, createPromptDock, sharedPromptWatch } from "../chat/prompt-card.js?v=1.4.44";
import { paneServerId } from "../ui-model.js?v=1.4.44";
import {
  chatScale,
  pinchedChatFontSize,
  readChatFontSize,
  writeChatFontSize,
} from "../chat-font-preference.js?v=1.4.44";

// The Chat lens, the prompt dock, find in the terminal and in the conversation,
// and the chat's text size. `deps` hands in what lives in app.js; its functions
// are called through, so they may be defined further down app.js than this is
// called. app.js keeps its own `promptDock`, `terminalFind` and `chatFind` and
// sets them from what this returns; `chatFontSize` is read through a getter.
// Whether the keyboard is in a terminal: the single pane's, or a grid cell's.
export function inTerminal(node, singleTerminal) {
  return Boolean(node) && (singleTerminal.contains(node) || Boolean(node.closest?.(".pane-grid-terminal")));
}

export function createChatPanel(deps) {
  const {
    state, elements, panePreferenceStorage, desktopMedia, terminalStream, attachedTerminal, paneCalls,
    conversationRequest, api, usesTouchInputEnvironment, isLinkableTerminalPath, openTerminalPath, setFeedback,
    showNewestTerminalOutput, scheduleTerminalPark, syncComposerExpanded, resizeTerminalInput, syncSendButton,
    refreshTerminal, refreshAfterSubmission, selectedRecordsFor, viewTicket, renderPaneViews, shownGrid,
  } = deps;
  let promptDock = null;
  let terminalFind = null;
  let chatFind = null;
  // Whether a grid (a Herdr tab's or this window's view split) is on screen:
  // its focused cell is the selected pane, in that cell's lens.
  const gridShown = () => elements.terminalPanel.classList.contains("is-grid");
  // The prompt cards' watches: the selected pane's dock and each Chat cell's
  // may watch the same pane while the focus moves between them.
  const prompts = sharedPromptWatch(terminalStream);
  // The terminal whose find marks show now (see findTerminal).
  let marked = null;

  const chatLens = createChatLens({
    stage: elements.terminalStage,
    host: elements.chatHost,
    group: elements.lensSwitch,
    chatButton: elements.lensChat,
    terminalButton: elements.lensTerminal,
    storage: panePreferenceStorage,
    layout: () => ({ compact: !desktopMedia.matches, touch: usesTouchInputEnvironment() }),
    connection: terminalStream,
    fetchJson: conversationRequest,
    isLinkablePath: isLinkableTerminalPath,
    onOpenPath: openTerminalPath,
    // An agent's `![](path)` images, from the Files tab's file route, resolved
    // against the pane's folder as its path links are.
    images: createChatImages({
      context: (paneId) => {
        const pane = selectedRecordsFor(paneId).pane;
        const cwd = pane?.foreground_cwd || pane?.cwd;
        return pane ? { server: paneServerId(paneId) || "local", cwd: typeof cwd === "string" ? cwd : null } : null;
      },
      viewTicket,
      viewer: createImageViewer({ viewTicket }),
    }),
    onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
    onChatDrawn: (chat, drawn) => {
      chatFind?.redrawn(chat, drawn);
      // a question card's context goes once the chat shows that message
      promptDock?.conversationChanged();
      cellCards.get(chat.paneId)?.dock.conversationChanged();
    },
    // A split's cells: a pane's chat became available or not, or a lens was
    // chosen in one. They are drawn again, which hands them back here.
    onCellsChange: () => renderPaneViews(),
    onCells: (cells, paneId) => placePromptCards(cells, paneId),
    onLensChange: (lens, paneId, previous) => {
      const grid = gridShown();
      // `previous` follows a pane renamed under it (a move to another workspace).
      // A grid cell's terminal is its own, not the single one, and Herdr's view
      // of the pane is left as it is.
      if (!grid && lens === "terminal" && previous?.lens === "chat" && previous.paneId === paneId) showNewestTerminalOutput(paneId);
      // The single terminal is not on screen under a grid: nothing to park.
      scheduleTerminalPark(grid ? "terminal" : lens, paneId);
      // The key bar drives the terminal: the Chat lens hides it, and the
      // terminal fits again once it is back.
      elements.terminalPanel.dataset.lens = lens;
      // the composer's text size goes with the lens
      syncComposerExpanded({ defer: true });
      resizeTerminalInput();
      promptDock?.setLens(lens);
      syncSendButton();
      // Each lens has its own find bar, and each bar its own pane: a switch
      // closes the other lens's, and a pane switch the chat's.
      if (lens === "chat") terminalFind?.close();
      if (lens !== "chat" || chatFind?.paneId !== paneId) chatFind?.close();
      if (terminalFind) syncTerminalFind();
      if (lens === "terminal") window.requestAnimationFrame(() => attachedTerminal.refit());
      // Typing must not go on into a terminal that is no longer on screen
      // (the single one, or a cell's under its chat).
      if (lens === "chat" && inTerminal(document.activeElement, elements.terminalXterm)) {
        if (usesTouchInputEnvironment()) document.activeElement.blur();
        else elements.terminalInput.focus({ preventScroll: true });
      }
      if (lens === "terminal" && state.terminalParked) {
        state.terminalParked = null;
        void refreshTerminal();
      }
    },
  });

  // A blocked pane's prompt card: at the bottom of the Chat lens, and as a
  // banner over the Terminal lens (src/prompt/, public/chat/prompt-card.js).
  // What every prompt card shares: the requests, what an answer refreshes,
  // and the conversation a card reads its words from.
  const makeDock = (dock, extra) => createPromptDock({
    dock,
    connection: prompts,
    getJson: (path) => api(path),
    postJson: (path, body) => api(path, { method: "POST", body }),
    onAnswered: (paneId, summary) => {
      chatLens.answered(paneId, summary);
      refreshAfterSubmission();
    },
    conversation: (paneId) => chatLens.chatFor(paneId)?.agentText ?? "",
    ...extra,
  });
  promptDock = makeDock(elements.promptDock, {
    showChat: () => chatLens.showChat(),
    // the composer says which numbers answer the card
    onCardChange: (card) => {
      elements.terminalInput.placeholder = composerPlaceholder(card);
      // the key bar's composer side looks again at a number already typed
      elements.terminalInput.dispatchEvent(new Event("promptcardchange"));
    },
  });
  promptDock.setLens(chatLens.lens);
  elements.terminalPanel.dataset.lens = chatLens.lens;

  // In a split, each Chat cell shows its own pane's prompt card under its
  // chat. The focused cell's is the selected pane's dock itself, moved into
  // the cell, so the composer answers the card it shows (numbers, preview);
  // every other Chat cell has a card of its own, made while it shows its
  // chat. A Terminal cell's pane says it waits in the cell's header status.
  const cellCards = new Map();
  function placePromptCards(cells, paneId) {
    const focused = cells?.find((cell) => cell.paneId === paneId && cell.lens === "chat") ?? null;
    const home = focused ? focused.dockSlot : elements.terminalStage;
    if (elements.promptDock.parentElement !== home) home.append(elements.promptDock);
    const wanted = new Map((cells ?? []).filter((cell) => cell.lens === "chat" && cell.paneId !== paneId).map((cell) => [cell.paneId, cell]));
    for (const [id, card] of cellCards) {
      if (wanted.get(id)?.dockSlot === card.slot) continue;
      card.dock.dispose();
      card.element.remove();
      cellCards.delete(id);
    }
    for (const [id, cell] of wanted) {
      let card = cellCards.get(id);
      if (!card) {
        const element = document.createElement("div");
        element.className = "prompt-dock";
        element.dataset.mode = "hidden";
        element.hidden = true;
        cell.dockSlot.append(element);
        const dock = makeDock(element, { showChat: () => true });
        dock.setLens("chat");
        card = { dock, element, slot: cell.dockSlot };
        cellCards.set(id, card);
      }
      card.dock.select(id, { agent: cell.agent, status: cell.status });
    }
  }

  // Find in the terminal: searches the pane's whole history on the server and
  // herdr scrolls the pane's view to each match. Ctrl+F (Cmd+F on a Mac) opens
  // it over the Terminal lens; the button in the header does on a phone too.
  // A mirrored pane (no attach) shows a copy of its screen that herdr's scroll
  // does not move, so it has no find.
  const FIND_SHORTCUT_MAC = /Mac|iPhone|iPad/u.test(navigator.platform);
  const MIRRORED_FIND_REASON = "Find needs the live terminal. This pane is shown as a copy of its screen, which a search cannot scroll.";
  const terminalFindButton = document.querySelector("#terminal-find-open");
  const terminalFindForm = document.querySelector("#terminal-find");
  terminalFind = createTerminalFind({
    form: terminalFindForm,
    input: document.querySelector("#terminal-find-input"),
    count: document.querySelector("#terminal-find-count"),
    olderButton: document.querySelector("#terminal-find-older"),
    newerButton: document.querySelector("#terminal-find-newer"),
    closeButton: document.querySelector("#terminal-find-close"),
    search: (paneId, body) => paneCalls.find(paneId, body),
    reveal: (paneId, body) => paneCalls.reveal(paneId, body),
    // How many terminal rows the bar lies over, measured, so a match is
    // scrolled clear of it whatever the bar's size.
    coverRows: () => {
      const xterm = state.renderedGrid ? ".pane-grid-cell.is-focused .pane-grid-terminal" : "#terminal-xterm";
      const row = document.querySelector(`${xterm} .xterm-rows > div`)?.getBoundingClientRect();
      const screen = document.querySelector(`${xterm} .xterm-screen`)?.getBoundingClientRect();
      const bar = terminalFindForm.getBoundingClientRect();
      if (!row || !screen || row.height <= 0 || terminalFindForm.hidden) return undefined;
      return Math.max(0, Math.min(20, Math.ceil((bar.bottom - screen.top) / row.height)));
    },
    onHighlight: (marks) => {
      // in a grid, the focused cell's own terminal; the one marked before lets its marks go
      const target = findTerminal();
      if (marked && marked !== target) marked.setFind(null);
      marked = marks ? target : null;
      target?.setFind(marks);
    },
    onOpen: () => syncTerminalFind(),
    onClose: () => {
      syncTerminalFind();
      if (!usesTouchInputEnvironment() && chatLens.lens === "terminal") findTerminal()?.focus();
    },
    onError: (message) => setFeedback(message, true),
  });

  // The terminal find marks: the single terminal, or over a grid the focused
  // cell's own (`marked` is the one that has marks now).
  function findTerminal() {
    if (!state.renderedGrid) return attachedTerminal;
    return state.selectedPaneId ? shownGrid()?.terminalOf(state.selectedPaneId) ?? null : null;
  }

  // The pane find can work on now, or why not. Over a grid, the focused cell
  // while it shows its live terminal (a cell's terminal is never a mirror).
  function terminalFindTarget() {
    if (state.renderedGrid) {
      const grid = shownGrid();
      const paneId = state.selectedPaneId && grid?.lensOf(state.selectedPaneId) === "terminal" && grid.terminalOf(state.selectedPaneId)
        ? state.selectedPaneId : null;
      return { paneId, mirrored: false };
    }
    const paneId = state.selectedPaneId && state.renderedPaneId === state.selectedPaneId
      ? state.selectedPaneId : null;
    return { paneId, mirrored: Boolean(paneId && state.mirrored?.paneId === paneId) };
  }

  function syncTerminalFind() {
    const { paneId, mirrored } = terminalFindTarget();
    terminalFind.setPane(mirrored ? null : paneId);
    terminalFindButton.hidden = !paneId;
    const shortcut = FIND_SHORTCUT_MAC ? "Cmd+F" : "Ctrl+F";
    // Over the Chat lens the same button finds in the conversation.
    if (chatLens.lens === "chat") {
      terminalFindButton.setAttribute("aria-controls", "chat-find");
      terminalFindButton.setAttribute("aria-disabled", "false");
      terminalFindButton.setAttribute("aria-expanded", String(Boolean(chatFind?.open)));
      terminalFindButton.setAttribute("aria-label", "Find in conversation");
      terminalFindButton.title = `Find in conversation (${shortcut})`;
      return;
    }
    terminalFindButton.setAttribute("aria-controls", "terminal-find");
    terminalFindButton.setAttribute("aria-disabled", String(mirrored));
    terminalFindButton.setAttribute("aria-expanded", String(terminalFind.open));
    terminalFindButton.setAttribute("aria-label", "Find in terminal");
    terminalFindButton.title = mirrored ? MIRRORED_FIND_REASON : `Find in terminal (${shortcut})`;
  }

  function openTerminalFind() {
    const { paneId, mirrored } = terminalFindTarget();
    if (!paneId || mirrored) return false;
    if (chatLens.lens !== "terminal") chatLens.showTerminal();
    terminalFind.show(paneId);
    syncTerminalFind();
    return true;
  }

  // Find in the conversation: marks the turns the Chat lens has drawn, and
  // offers to load the earlier ones it has not (chat-find.js).
  const chatFindForm = document.querySelector("#chat-find");
  chatFind = createChatFind({
    form: chatFindForm,
    input: document.querySelector("#chat-find-input"),
    count: document.querySelector("#chat-find-count"),
    olderButton: document.querySelector("#chat-find-older"),
    newerButton: document.querySelector("#chat-find-newer"),
    closeButton: document.querySelector("#chat-find-close"),
    more: document.querySelector("#chat-find-more"),
    moreButton: document.querySelector("#chat-find-load"),
    onOpen: () => syncTerminalFind(),
    onClose: () => syncTerminalFind(),
  });

  function openChatFind() {
    const chat = chatLens.lens === "chat" ? chatLens.chatFor(chatLens.paneId) : null;
    if (!chat) return false;
    chatFind.show(chat);
    syncTerminalFind();
    return true;
  }

  terminalFindButton.addEventListener("click", () => {
    if (chatLens.lens === "chat") {
      if (chatFind.open) chatFind.close();
      else openChatFind();
      return;
    }
    if (terminalFindButton.getAttribute("aria-disabled") === "true") {
      setFeedback(MIRRORED_FIND_REASON, true);
      return;
    }
    if (terminalFind.open) terminalFind.close();
    else openTerminalFind();
  });

  // Taken before xterm sees it (it would send ^F to the program), and over the
  // Chat lens for the conversation's own find, but never from a text field: the
  // composer, a dialog or the sidebar's fields keep the browser's own find.
  window.addEventListener("keydown", (event) => {
    if (!isFindShortcut(event, FIND_SHORTCUT_MAC) || !state.authenticated) return;
    if (document.querySelector("dialog[open]")) return;
    const active = document.activeElement;
    const typing = inTerminal(active, elements.terminalXterm);
    const inFind = terminalFindForm.contains(active) || chatFindForm.contains(active);
    if (!typing && !inFind && active instanceof HTMLElement &&
        (active.isContentEditable || active.matches("input, textarea, select"))) return;
    if (chatLens.lens === "chat") {
      if (!chatLens.chatFor(chatLens.paneId)) return;
      event.preventDefault();
      event.stopPropagation();
      openChatFind();
      return;
    }
    if (chatLens.lens !== "terminal") return;
    const { paneId, mirrored } = terminalFindTarget();
    if (!paneId || mirrored) return;
    event.preventDefault();
    event.stopPropagation();
    openTerminalFind();
  }, { capture: true });

  // The Chat lens's text size, apart from the terminal's (chat-font-preference.js).
  let chatFontSize = readChatFontSize(panePreferenceStorage);
  function applyChatFontSize(size, { save = true } = {}) {
    const scroller = chatLens.chatFor(chatLens.paneId)?.root.querySelector(".chat-scroll");
    // the reader keeps their place: at the end stays at the end, elsewhere the same share of the way down
    const atEnd = scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48 : false;
    const share = scroller && scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    chatFontSize = size;
    elements.terminalStage.style.setProperty("--chat-scale", String(chatScale(size)));
    elements.terminalStage.dataset.chatFontSize = String(size);
    // the composer takes the chat's size in the Chat lens
    document.documentElement.style.setProperty("--chat-font-size", `${size}px`);
    syncComposerExpanded({ defer: true });
    resizeTerminalInput();
    if (save) writeChatFontSize(panePreferenceStorage, size);
    if (scroller) scroller.scrollTop = atEnd ? scroller.scrollHeight : share * scroller.scrollHeight;
  }
  applyChatFontSize(chatFontSize, { save: false });

  function overChat(target) {
    return chatLens.lens === "chat" && target instanceof Node &&
      (elements.chatHost.contains(target) || elements.promptDock.contains(target) ||
        Boolean(target instanceof Element && target.closest(".pane-grid-chat")));
  }

  // Two fingers on the chat pinch its text size; one finger still scrolls it.
  let chatPinch = null;
  const touchSpread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  elements.terminalStage.addEventListener("touchstart", (event) => {
    if (event.touches.length === 2 && overChat(event.target)) {
      chatPinch = { distance: touchSpread(event.touches), start: chatFontSize };
    }
  }, { passive: true });
  elements.terminalStage.addEventListener("touchmove", (event) => {
    if (!chatPinch || event.touches.length !== 2) return;
    event.preventDefault();
    const size = pinchedChatFontSize(chatPinch.start, chatPinch.distance, touchSpread(event.touches));
    if (size !== chatFontSize) applyChatFontSize(size, { save: false });
  }, { passive: false });
  const endChatPinch = (event) => {
    if (!chatPinch || event.touches.length >= 2) return;
    if (chatFontSize !== chatPinch.start) writeChatFontSize(panePreferenceStorage, chatFontSize);
    chatPinch = null;
  };
  elements.terminalStage.addEventListener("touchend", endChatPinch, { passive: true });
  elements.terminalStage.addEventListener("touchcancel", endChatPinch, { passive: true });

  // The message (loading, errors) stands in for the terminal until a pane is drawn.
  function showTerminalView(shown) {
    elements.terminalMessage.hidden = shown;
    elements.terminalXterm.hidden = !shown;
    if (!shown) elements.terminalHeld.hidden = true;
  }

  document.querySelector("#terminal-take-over").addEventListener("click", () => attachedTerminal.takeOver());

  return {
    chatLens, promptDock, terminalFind, chatFind, syncTerminalFind, applyChatFontSize, overChat, showTerminalView,
    get chatFontSize() { return chatFontSize; },
  };
}
