import { combinedTerminalKey, keyboardTerminalKey } from "../key-combinations.js?v=1.4.43";
import { inputKeyAction, insertNewlineAtSelection, nextInputHistory, paneKeepsInputHistory, shouldBrowseInputHistory } from "../ui-model.js?v=1.4.43";
import { chatAgent } from "../lens-preference.js?v=1.4.43";
import { composerEscapeStops, sendButtonMode as sendButtonModeFor, showsStop, stopFollowUp, stopPresses } from "../chat/chat-activity.js?v=1.4.43";
import { keyBarItemKey, keyBarItemLabel } from "../key-bar-preference.js?v=1.4.43";
import { numberedChoice } from "../chat/prompt-card.js?v=1.4.43";

// The composer's sending side and the key bar: the form's submit, the
// composer's keys (history, Enter, Esc to stop), Send doubling as Stop, the key
// bar's buttons and latched modifiers, and a modifier taking a typed letter.
// The key bar's layout, the Enter mode, the draft's pane, the Stop target, the
// modifiers' pane and the phone keyboard's state are app.js's own `let`s
// (other parts of the page assign them), so this reads and assigns them
// through the getters and setters it is given.
export function createKeyBar({
  state,
  elements,
  composerPopup,
  chatLens,
  attachedTerminal,
  draftBlocked,
  getDraftPaneId,
  getTerminalInputResizeTimer,
  setTerminalInputResizeTimer,
  getChatFind,
  getPromptDock,
  getEnterKeyMode,
  getPhysicalKeyboardSeen,
  getKeyBarItems,
  setModifierPaneId,
  getStopTarget,
  getComposerKeyboardDismissed,
  setComposerKeyboardDismissed,
  getPhoneKeyboardOpen,
  syncComposerExpanded,
  resizeTerminalInput,
  scheduleTerminalInputResize,
  resetInputHistoryNavigation,
  scheduleComposerDraftSave,
  holdComposerDraft,
  releaseComposerDraft,
  rememberSentInput,
  speechStop,
  setFeedback,
  sendText,
  sendKeys,
  snapshotRecords,
  selectedRecords,
  agentForPane,
  refreshAfterSubmission,
  refreshTerminal,
  focusComposer,
  usesTouchInputEnvironment,
  hintIfStillWorking,
}) {
  const selectedKeyModifiers = new Set();
  let keySendBusy = false;

  function clearComposer() {
    const draftPaneId = getDraftPaneId();
    if (draftPaneId) draftBlocked.delete(draftPaneId);
    composerPopup.close();
    elements.terminalInput.value = "";
    getPromptDock?.()?.preview(null);
    window.clearTimeout(getTerminalInputResizeTimer());
    setTerminalInputResizeTimer(null);
    syncComposerExpanded();
    resizeTerminalInput();
    speechStop();
  }

  // A number alone in the composer answers the shown card: the option it
  // names is marked on the card as it is typed, and Enter or Send answers
  // the card with it rather than sending it as a message.
  function composerChoice(text = elements.terminalInput.value) {
    const dock = getPromptDock?.();
    // only the card of the pane the composer sends to
    if (!dock || dock.mode === "hidden" || !state.selectedPaneId || dock.paneId !== state.selectedPaneId) return null;
    return numberedChoice(dock.card, text);
  }

  function syncComposerChoice() {
    getPromptDock?.()?.preview(composerChoice());
  }

  elements.terminalInput.addEventListener("input", syncComposerChoice);
  elements.terminalInput.addEventListener("promptcardchange", syncComposerChoice);

  elements.inputForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = elements.terminalInput.value;
    const paneId = state.selectedPaneId;
    const choice = composerChoice(text);
    if (choice !== null) {
      // the number answers the card; while an answer is still on its way it
      // stays in the box rather than going to the pane as a message
      if (getPromptDock?.()?.choose(choice)) {
        clearComposer();
        setFeedback("");
      }
      return;
    }
    composerSending = true;
    syncSendButton();
    setFeedback("Sending…");
    // The Chat lens shows the message on its way and goes to the end at once.
    // The text itself shows only once the server says it was no password answer.
    let delivered = false;
    let secret = false;
    if (paneId) holdComposerDraft(paneId);
    chatLens.sent(paneId, null);
    let pending = null;
    try {
      if (text) {
        const sent = await sendText(text, paneId);
        secret = sent?.secret === true;
        // An answer to a password prompt is never kept, nor left on show in the chat.
        if (!sent?.secret) pending = chatLens.pend(paneId, text);
        if (!sent?.secret && paneKeepsInputHistory(paneId, snapshotRecords())) rememberSentInput(paneId, text);
      } else {
        await sendKeys(["enter"], paneId);
      }
      delivered = true;
      // Only the pane's own box: the message may have been sent from another pane's draft.
      if (getDraftPaneId() === paneId || !paneId) clearComposer();
      setFeedback("");
      refreshAfterSubmission();
    } catch (error) {
      chatLens.unsent(paneId, pending);
      setFeedback(error.message, true);
    } finally {
      if (paneId) releaseComposerDraft(paneId, { sent: delivered, text, secret });
      composerSending = false;
      // On a desktop the composer gets focus back after a click on Send, so
      // the button stays Send and a second click cannot stop what was just
      // sent. A touch screen keeps its keyboard down (focusComposer no-ops).
      focusComposer();
      syncSendButton();
    }
  });

  elements.terminalInput.addEventListener("keydown", (event) => {
    if (composerPopup.handleKeydown(event)) return;
    // Esc in the composer stops the agent, as it does in the terminal, unless
    // the @ list (answered above), the find bar or a dialog has Esc first.
    if (composerEscapeStops({
      key: event.key, isComposing: event.isComposing, keyCode: event.keyCode,
      ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
      stopShown: stopReady(),
      ownedElsewhere: composerPopup.isOpen || Boolean(getChatFind()?.open) || Boolean(document.querySelector("dialog[open]")),
    })) {
      event.preventDefault();
      event.stopPropagation();
      void stopAgent();
      return;
    }
    if (
      !event.isComposing &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      selectedKeyModifiers.size === 0 &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      if (!shouldBrowseInputHistory({
        key: event.key, value: elements.terminalInput.value,
        selectionStart: elements.terminalInput.selectionStart,
        selectionEnd: elements.terminalInput.selectionEnd,
      })) return;
      const next = nextInputHistory({
        history: state.inputHistoryByPane.get(state.selectedPaneId) || [],
        cursor: state.inputHistoryCursor,
        draft: state.inputHistoryDraft,
        currentValue: elements.terminalInput.value,
        direction: event.key === "ArrowUp" ? "previous" : "next",
      });
      if (next.handled) {
        event.preventDefault();
        state.inputHistoryCursor = next.cursor;
        state.inputHistoryDraft = next.draft;
        elements.terminalInput.value = next.value;
        elements.terminalInput.setSelectionRange(next.value.length, next.value.length);
        syncComposerExpanded({ fresh: true });
        resizeTerminalInput();
      }
      return;
    }

    const action = inputKeyAction({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.isComposing,
      keyCode: event.keyCode,
      usesTouchInput: usesTouchInputEnvironment(),
      enterMode: getEnterKeyMode(),
      physicalKeyboard: getPhysicalKeyboardSeen(),
    });
    if (action === "submit") {
      event.preventDefault();
      if (!composerSending) elements.inputForm.requestSubmit();
    } else if (action === "newline") {
      event.preventDefault();
      const next = insertNewlineAtSelection(
        elements.terminalInput.value,
        elements.terminalInput.selectionStart,
        elements.terminalInput.selectionEnd,
      );
      elements.terminalInput.value = next.value;
      elements.terminalInput.setSelectionRange(next.caret, next.caret);
      elements.terminalInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  elements.terminalInput.addEventListener("input", () => {
    syncComposerExpanded({ defer: true });
    if (usesTouchInputEnvironment()) {
      resizeTerminalInput();
    } else {
      scheduleTerminalInputResize();
    }
    if (state.inputHistoryCursor !== null) resetInputHistoryNavigation();
    scheduleComposerDraftSave();
  });

  elements.terminalInput.addEventListener("blur", () => {
    void refreshTerminal();
  });

  window.addEventListener("resize", () => {
    syncComposerExpanded({ defer: true });
    resizeTerminalInput();
  });

  const PAGE_KEY_DIRECTION = Object.freeze({ pageup: -1, pagedown: 1 });

  function renderKeyBar() {
    const keyBarItems = getKeyBarItems();
    const buttons = keyBarItems.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = keyBarItemLabel(item);
      if (item.type === "modifier") {
        button.dataset.modifier = item.modifier;
        button.setAttribute("aria-pressed", "false");
        button.title = "Combine with the next button or keyboard key";
      } else {
        button.dataset.key = item.key;
        // A saved combination sends exactly its own chord, whatever is held.
        if (item.modifiers) button.dataset.chord = item.modifiers.join("+");
        if (item.modifiers) button.title = keyBarItemKey(item) || "";
      }
      return button;
    });
    elements.quickKeys.replaceChildren(...buttons);
    // A latched modifier whose button was removed would stay on unseen.
    for (const name of [...selectedKeyModifiers]) {
      if (!keyBarItems.some((item) => item.type === "modifier" && item.modifier === name)) {
        selectedKeyModifiers.delete(name);
      }
    }
    renderKeyModifiers();
  }

  function renderKeyModifiers() {
    for (const button of elements.quickKeys.querySelectorAll("[data-modifier]")) {
      button.setAttribute("aria-pressed", String(selectedKeyModifiers.has(button.dataset.modifier)));
    }
  }

  function clearKeyModifiers() {
    selectedKeyModifiers.clear();
    setModifierPaneId(null);
    renderKeyModifiers();
  }

  async function sendCommandKey(key) {
    if (!key || keySendBusy || !state.authenticated || !state.selectedPaneId) return;
    keySendBusy = true;
    const paneId = state.selectedPaneId;
    clearKeyModifiers();
    setFeedback(`Sending ${key}…`);
    try {
      await sendKeys([key], paneId);
      refreshAfterSubmission();
      setFeedback("");
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      keySendBusy = false;
    }
  }

  // Send doubles as Stop: the key bar's Esc for the Chat lens, which has no key
  // bar. While the selected Claude or Codex pane works and the composer is not
  // focused, the button shows Stop; typing in the composer makes it Send again,
  // so a draft can still go out (the agent queues it). Esc interrupts without
  // losing the conversation: no confirmation.
  const STOP_BUSY_MS = 1_000;
  // Panes whose Stop is still sending: busy is per pane, so a slow Esc to one
  // does not hold another pane's Stop, and never holds Send.
  const stoppingPanes = new Set();
  // A message on its way: Send waits for it.
  let composerSending = false;
  // The mode a press started in, kept until its click: pressing the button moves
  // focus out of the composer, which must not turn a press on Send into Stop.
  let pressedSendMode = null;
  let pressedSendModeTimer = null;

  // The selected pane is a working agent in the Chat lens.
  function stopReady() {
    const stopTarget = getStopTarget();
    return Boolean(stopTarget.paneId) && stopTarget.paneId === state.selectedPaneId &&
      showsStop({ lens: chatLens.lens, agent: stopTarget.agent, status: stopTarget.status });
  }

  // Whether the composer is where the person is: in it, or on Send having
  // tabbed there from it (a keyboard press on Send means sending the draft).
  // Send focused by a pointer press is not: that press chose its mode already.
  let sendFocusedByPointer = false;
  function composerFocused() {
    const active = document.activeElement;
    if (active === elements.sendButton) return !sendFocusedByPointer;
    return active === elements.terminalInput && !getComposerKeyboardDismissed();
  }

  function sendButtonMode() {
    const stopTarget = getStopTarget();
    // A message on its way keeps the button Send (and busy): a second press
    // then can never stop the work it is starting.
    if (composerSending || stopTarget.paneId !== state.selectedPaneId) return "send";
    return sendButtonModeFor({ lens: chatLens.lens, agent: stopTarget.agent, status: stopTarget.status,
      composerFocused: composerFocused() });
  }

  function syncSendButton() {
    const button = elements.sendButton;
    const mode = pressedSendMode ?? sendButtonMode();
    const stop = mode === "stop";
    const busy = stop && stoppingPanes.has(state.selectedPaneId);
    button.dataset.mode = mode;
    button.setAttribute("aria-label", stop ? "Stop" : "Send");
    button.title = stop ? "Stop (Esc)" : "Send";
    button.disabled = stop ? busy : composerSending;
    if (busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }

  function releasePressedSendMode() {
    window.clearTimeout(pressedSendModeTimer);
    pressedSendModeTimer = null;
    if (pressedSendMode === null) return;
    pressedSendMode = null;
    syncSendButton();
  }

  async function stopAgent() {
    const paneId = state.selectedPaneId;
    if (!stopReady() || !state.authenticated || !paneId || stoppingPanes.has(paneId)) return;
    // Busy until the Esc has gone, and for a moment at least; then ready again,
    // as Claude may need a second Esc. Stop does not queue behind another key
    // on its way (a slow link, a stuck request): the Esc goes at once, to the
    // pane it was pressed for, and is never dropped for waiting.
    stoppingPanes.add(paneId);
    syncSendButton();
    const shortest = new Promise((resolve) => window.setTimeout(resolve, STOP_BUSY_MS));
    clearKeyModifiers();
    try {
      // Only Claude Code puts a stopped message back in its box; the server
      // looks for it before the next send only after a Stop marked as Claude's.
      const agent = chatAgent(selectedRecords().pane, agentForPane(paneId));
      const claude = agent === "claude";
      await sendKeys(["esc"], paneId, { stop: claude });
      // OpenCode stops on a second Esc (within 5 seconds), sent apart from the first
      const { presses, gapMs } = stopPresses(agent);
      for (let press = 1; press < presses; press += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, gapMs));
        await sendKeys(["esc"], paneId);
      }
      refreshAfterSubmission();
      const followUp = stopFollowUp(agent);
      if (followUp) void hintIfStillWorking(paneId, followUp);
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      await shortest;
      stoppingPanes.delete(paneId);
      syncSendButton();
    }
  }

  // The press decides: at pointerdown, before focus leaves the composer, a press
  // is Send if the composer is focused and Stop if not (while the agent works).
  elements.sendButton.addEventListener("pointerdown", () => {
    // The mode is what the button shows as it is pressed (Send when tabbed to
    // from the composer); the pointer's own focus counts only after.
    const mode = sendButtonMode();
    sendFocusedByPointer = true;
    if (elements.sendButton.disabled) return;
    window.clearTimeout(pressedSendModeTimer);
    pressedSendMode = mode;
    syncSendButton();
  });
  elements.sendButton.addEventListener("pointercancel", releasePressedSendMode);
  elements.sendButton.addEventListener("focus", () => syncSendButton());
  elements.sendButton.addEventListener("blur", () => { sendFocusedByPointer = false; syncSendButton(); });
  // A press let go off the button has no click: its mode goes a moment later.
  window.addEventListener("pointerup", () => {
    if (pressedSendMode === null) return;
    window.clearTimeout(pressedSendModeTimer);
    pressedSendModeTimer = window.setTimeout(releasePressedSendMode, 1_000);
  });
  elements.sendButton.addEventListener("click", (event) => {
    const mode = pressedSendMode ?? sendButtonMode();
    releasePressedSendMode();
    if (mode !== "stop") return; // the form sends the draft
    event.preventDefault();
    void stopAgent();
  });
  // A press never moves focus into the composer: focus there ends any press.
  elements.terminalInput.addEventListener("focus", () => {
    setComposerKeyboardDismissed(false);
    window.clearTimeout(pressedSendModeTimer);
    pressedSendMode = null;
    syncSendButton();
  });
  elements.terminalInput.addEventListener("blur", () => syncSendButton());
  // A tap on a still-focused composer brings the phone keyboard back.
  elements.terminalInput.addEventListener("pointerdown", () => {
    if (!getComposerKeyboardDismissed()) return;
    setComposerKeyboardDismissed(false);
    syncSendButton();
  });

  // Keep the composer focused when using the screen keyboard with a mouse.
  elements.quickKeys.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });

  // A phone keyboard put away leaves its input focused, and Android brings the
  // keyboard back as soon as the terminal answers a key. With the keyboard away,
  // a tap on the bar lets go of the input; with it up, typing carries on.
  elements.quickKeys.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("button") || !usesTouchInputEnvironment() || getPhoneKeyboardOpen()) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches("input, textarea")) focused.blur();
  });

  elements.quickKeys.addEventListener("click", (event) => {
    if (!state.authenticated || !state.selectedPaneId || keySendBusy) return;
    const modifier = event.target.closest("button[data-modifier]");
    if (modifier) {
      const key = modifier.dataset.modifier;
      if (selectedKeyModifiers.has(key)) selectedKeyModifiers.delete(key);
      else selectedKeyModifiers.add(key);
      setModifierPaneId(state.selectedPaneId);
      renderKeyModifiers();
      focusComposer();
      return;
    }
    const button = event.target.closest("button[data-key]");
    if (!button) return;
    const modifiers = button.dataset.chord !== undefined ? button.dataset.chord.split("+") : [...selectedKeyModifiers];
    if (button.dataset.chord === undefined) {
      if (event.ctrlKey) modifiers.push("ctrl");
      if (event.altKey) modifiers.push("alt");
      if (event.shiftKey) modifiers.push("shift");
    }
    // PgUp and PgDn page through the history, as a finger or the wheel does: a
    // shell or Claude Code does nothing with the keys. Held Shift sends the plain
    // key instead (not Shift+PgUp, which less and vim do not read as paging).
    // In the chat lens there is no terminal to page, and the key goes as before.
    const page = button.dataset.chord === undefined && Object.hasOwn(PAGE_KEY_DIRECTION, button.dataset.key)
      ? PAGE_KEY_DIRECTION[button.dataset.key] : undefined;
    if (page && modifiers.length === 0 && attachedTerminal.scrollPage(page)) return;
    if (page && modifiers.length > 0 && modifiers.every((part) => part === "shift")) {
      void sendCommandKey(button.dataset.key);
      return;
    }
    void sendCommandKey(combinedTerminalKey(button.dataset.key, modifiers));
  });

  // Only intercept the terminal area: login fields and other dialogs retain
  // their normal shortcuts. Without a selected modifier, the composer does too.
  elements.terminalPanel.addEventListener("keydown", (event) => {
    if (!state.authenticated || !state.selectedPaneId) return;
    // A physical copy shortcut belongs to the browser while text is selected.
    if ((event.ctrlKey || event.metaKey) && !event.altKey &&
        event.key.toLowerCase() === "c" && window.getSelection()?.toString()) return;
    if (selectedKeyModifiers.size === 0) return;
    const key = keyboardTerminalKey(event, [...selectedKeyModifiers]);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void sendCommandKey(key);
  }, { capture: true });

  // Mobile keyboards may emit beforeinput without a usable keydown event. Most
  // also compose even a single letter, which cannot be cancelled: then the held
  // modifier takes the one character the composer gained, and it is taken out.
  let modifierInputBefore = null;
  // The keyboard may still commit the letter it was composing once the
  // modifier has gone; that copy is taken out too.
  let modifierComposition = null;
  elements.terminalInput.addEventListener("beforeinput", (event) => {
    if (!selectedKeyModifiers.size) return;
    if (!event.isComposing && event.inputType === "insertText" && event.cancelable &&
        typeof event.data === "string" && event.data.length === 1) {
      const key = keyboardTerminalKey({ key: event.data }, [...selectedKeyModifiers]);
      if (key) {
        event.preventDefault();
        void sendCommandKey(key);
        return;
      }
    }
    // Only typing takes the modifier: a pasted letter stays text.
    if (event.inputType !== "insertText" && event.inputType !== "insertCompositionText") return;
    const input = elements.terminalInput;
    modifierInputBefore ??= { value: input.value, start: input.selectionStart, end: input.selectionEnd };
  });

  function restoreComposer(before) {
    elements.terminalInput.value = before.value;
    elements.terminalInput.setSelectionRange(before.start, before.end);
  }

  elements.terminalInput.addEventListener("input", (event) => {
    const input = elements.terminalInput;
    const before = modifierInputBefore;
    modifierInputBefore = null;
    // The composition that gave the key may still change or commit until it
    // ends: whatever it writes is taken out again.
    if (modifierComposition) {
      restoreComposer(modifierComposition);
      return;
    }
    if (!before || !selectedKeyModifiers.size) return;
    const head = before.value.slice(0, before.start);
    const tail = before.value.slice(before.end);
    const { value } = input;
    // Head and tail can overlap when the text was cut short, so check the length too.
    if (value.length < head.length + tail.length || !value.startsWith(head) || !value.endsWith(tail)) return;
    const added = value.slice(head.length, value.length - tail.length);
    // Only a letter, digit or sign: a Korean or Japanese keyboard composes a
    // syllable through partial ones, and Ctrl with those means nothing here.
    const key = /^[\x21-\x7e]$/u.test(added) ? keyboardTerminalKey({ key: added }, [...selectedKeyModifiers]) : null;
    if (!key) return;
    restoreComposer(before);
    if (event.isComposing) modifierComposition = before;
    void sendCommandKey(key);
  });

  // A composition the key was taken from may end without a compositionend once
  // the composer was set back; the next one starts afresh.
  elements.terminalInput.addEventListener("compositionstart", () => {
    modifierComposition = null;
  });

  elements.terminalInput.addEventListener("compositionend", () => {
    // Some browsers commit after compositionend; let that input arrive first.
    window.setTimeout(() => {
      modifierComposition = null;
      modifierInputBefore = null;
    }, 0);
  });

  // A composition cut short by leaving the composer leaves nothing to take out.
  elements.terminalInput.addEventListener("blur", () => {
    modifierComposition = null;
    modifierInputBefore = null;
  });

  return { clearComposer, syncSendButton, clearKeyModifiers, renderKeyBar };
}
