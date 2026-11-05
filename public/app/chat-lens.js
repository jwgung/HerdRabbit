import { createTerminalFind, isFindShortcut } from "../terminal-find.js?v=1.4.39";
import { createChatLens } from "../chat/chat-view.js?v=1.4.39";
import { createChatImages } from "../chat/chat-images.js?v=1.4.39";
import { createImageViewer } from "../chat/image-viewer.js?v=1.4.39";
import { createChatFind } from "../chat/chat-find.js?v=1.4.39";
import { composerPlaceholder, createPromptDock } from "../chat/prompt-card.js?v=1.4.39";
import { paneServerId } from "../ui-model.js?v=1.4.39";
import {
  chatScale,
  pinchedChatFontSize,
  readChatFontSize,
  writeChatFontSize,
} from "../chat-font-preference.js?v=1.4.39";

// The Chat lens, the prompt dock, find in the terminal and in the conversation,
// and the chat's text size. `deps` hands in what lives in app.js; its functions
// are called through, so they may be defined further down app.js than this is
// called. app.js keeps its own `promptDock`, `terminalFind` and `chatFind` and
// sets them from what this returns; `chatFontSize` is read through a getter.
export function createChatPanel(deps) {
  const {
    state, elements, panePreferenceStorage, desktopMedia, terminalStream, attachedTerminal, paneCalls,
    conversationRequest, api, usesTouchInputEnvironment, isLinkableTerminalPath, openTerminalPath, setFeedback,
    showNewestTerminalOutput, scheduleTerminalPark, syncComposerExpanded, resizeTerminalInput, syncSendButton,
    refreshTerminal, refreshAfterSubmission, selectedRecordsFor, viewTicket,
  } = deps;
  let promptDock = null;
  let terminalFind = null;
  let chatFind = null;

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
    },
    onLensChange: (lens, paneId, previous) => {
      // `previous` follows a pane renamed under it (a move to another workspace)
      if (lens === "terminal" && previous?.lens === "chat" && previous.paneId === paneId) showNewestTerminalOutput(paneId);
      scheduleTerminalPark(lens, paneId);
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
      // Typing must not go on into a terminal that is no longer on screen.
      if (lens === "chat" && elements.terminalXterm.contains(document.activeElement)) {
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
  promptDock = createPromptDock({
    dock: elements.promptDock,
    connection: terminalStream,
    getJson: (path) => api(path),
    postJson: (path, body) => api(path, { method: "POST", body }),
    showChat: () => chatLens.showChat(),
    onAnswered: (paneId, summary) => {
      chatLens.answered(paneId, summary);
      refreshAfterSubmission();
    },
    // the composer says which numbers answer the card
    onCardChange: (card) => {
      elements.terminalInput.placeholder = composerPlaceholder(card);
      // the key bar's composer side looks again at a number already typed
      elements.terminalInput.dispatchEvent(new Event("promptcardchange"));
    },
    conversation: (paneId) => chatLens.chatFor(paneId)?.agentText ?? "",
  });
  promptDock.setLens(chatLens.lens);
  elements.terminalPanel.dataset.lens = chatLens.lens;

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
      const row = document.querySelector("#terminal-xterm .xterm-rows > div")?.getBoundingClientRect();
      const screen = document.querySelector("#terminal-xterm .xterm-screen")?.getBoundingClientRect();
      const bar = terminalFindForm.getBoundingClientRect();
      if (!row || !screen || row.height <= 0 || terminalFindForm.hidden) return undefined;
      return Math.max(0, Math.min(20, Math.ceil((bar.bottom - screen.top) / row.height)));
    },
    onHighlight: (marks) => attachedTerminal.setFind(marks),
    onOpen: () => syncTerminalFind(),
    onClose: () => {
      syncTerminalFind();
      if (!usesTouchInputEnvironment() && chatLens.lens === "terminal" && !state.renderedGrid) attachedTerminal.focus();
    },
    onError: (message) => setFeedback(message, true),
  });

  // The pane find can work on now, or why not.
  // None over a grid: its cells have no find, and the single terminal is not on screen.
  function terminalFindTarget() {
    const paneId = !state.renderedGrid && state.selectedPaneId && state.renderedPaneId === state.selectedPaneId
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
    const inTerminal = elements.terminalXterm.contains(active);
    const inFind = terminalFindForm.contains(active) || chatFindForm.contains(active);
    if (!inTerminal && !inFind && active instanceof HTMLElement &&
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
      (elements.chatHost.contains(target) || elements.promptDock.contains(target));
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
