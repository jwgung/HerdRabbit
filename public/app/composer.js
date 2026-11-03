import { writeInputHistories } from "../input-history-preference.js?v=1.4.24";

// The composer's box: its height and its one-row or card layout, each pane's
// unsent draft, and the sent-message history. The draft's pane and save timer,
// and the resize timer, are app.js's own `let`s (the account dialogs, the pane
// rename hooks and the key bar read or assign them too), so this reads and
// assigns them through the getters and setters it is given. The blocked and
// held sets are app.js's too, shared as they are.
export function createComposer({
  state,
  elements,
  panePreferenceStorage,
  composerDrafts,
  composerPopup,
  draftBlocked,
  draftHeld,
  getDraftPaneId,
  setDraftPaneId,
  getDraftSaveTimer,
  setDraftSaveTimer,
  getTerminalInputResizeTimer,
  setTerminalInputResizeTimer,
  COMPOSER_RESIZE_DELAY_MS,
}) {
  function supportsNativeTerminalInputSizing() {
    return typeof CSS !== "undefined" &&
      CSS.supports?.("field-sizing", "content") === true;
  }

  function resizeTerminalInput() {
    const input = elements.terminalInput;
    if (supportsNativeTerminalInputSizing()) {
      input.style.removeProperty("height");
      input.style.removeProperty("overflow-y");
      return;
    }
    input.style.height = "auto";
    const maxHeight = Number.parseFloat(window.getComputedStyle(input).maxHeight);
    const contentHeight = input.scrollHeight;
    const nextHeight = Number.isFinite(maxHeight)
      ? Math.min(contentHeight, maxHeight)
      : contentHeight;
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = contentHeight > nextHeight ? "auto" : "hidden";
  }

  // A long text turns the composer's one row into a card: the text on top across
  // the whole width, the buttons in a row below it (styles.css, .is-expanded).
  // It expands once the text needs a second line at the one-row width, or holds
  // a newline, and folds back only when the box is empty: the change of layout
  // itself changes the box's width, so folding back on a shorter text would
  // flip it to and fro. `fresh` is for a text put in whole (a draft, a recalled
  // message), which is judged from the one-row layout again. `defer` keeps the
  // measuring out of the input event: it runs in the next frame.
  let composerExpandFrame = 0;
  function composerTextNeedsExpanding(input) {
    if (input.value.includes("\n")) return true;
    const style = window.getComputedStyle(input);
    const lineHeight = Number.parseFloat(style.lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return false;
    const oneRow = lineHeight + Number.parseFloat(style.paddingTop || "0") + Number.parseFloat(style.paddingBottom || "0");
    return input.scrollHeight > oneRow + lineHeight / 2;
  }

  function syncComposerExpanded({ fresh = false, defer = false } = {}) {
    const composer = elements.inputComposer;
    const input = elements.terminalInput;
    if (!composer) return;
    window.cancelAnimationFrame(composerExpandFrame);
    composerExpandFrame = 0;
    if (input.value === "") {
      composer.classList.remove("is-expanded");
      return;
    }
    if (fresh) composer.classList.remove("is-expanded");
    if (composer.classList.contains("is-expanded")) return;
    if (input.value.includes("\n")) {
      composer.classList.add("is-expanded");
      return;
    }
    const judge = () => {
      composerExpandFrame = 0;
      if (input.value !== "" && composerTextNeedsExpanding(input)) composer.classList.add("is-expanded");
    };
    if (defer) composerExpandFrame = window.requestAnimationFrame(judge);
    else judge();
  }

  function scheduleTerminalInputResize() {
    if (supportsNativeTerminalInputSizing()) return;
    window.clearTimeout(getTerminalInputResizeTimer());
    setTerminalInputResizeTimer(window.setTimeout(() => {
      setTerminalInputResizeTimer(null);
      resizeTerminalInput();
    }, COMPOSER_RESIZE_DELAY_MS));
  }

  function resetInputHistoryNavigation() {
    state.inputHistoryCursor = null;
    state.inputHistoryDraft = "";
  }

  // While history is browsed the box shows an old message; the draft is the text
  // typed before browsing began.
  function composerDraftText() {
    return state.inputHistoryCursor !== null ? state.inputHistoryDraft : elements.terminalInput.value;
  }

  function saveComposerDraft() {
    window.clearTimeout(getDraftSaveTimer());
    setDraftSaveTimer(null);
    const paneId = getDraftPaneId();
    if (!paneId || draftHeld.has(paneId)) return;
    if (draftBlocked.has(paneId)) {
      composerDrafts.clear(paneId);
      return;
    }
    composerDrafts.set(paneId, composerDraftText());
  }

  function scheduleComposerDraftSave() {
    if (!getDraftPaneId()) return;
    window.clearTimeout(getDraftSaveTimer());
    setDraftSaveTimer(window.setTimeout(saveComposerDraft, 300));
  }

  // Called whenever the selected pane may have changed; does nothing when it has not.
  function syncComposerDraft() {
    const paneId = state.selectedPaneId || null;
    if (paneId === getDraftPaneId()) return;
    saveComposerDraft();
    const leaving = getDraftPaneId();
    draftBlocked.delete(leaving);
    setDraftPaneId(paneId);
    if (paneId) draftBlocked.delete(paneId);
    resetInputHistoryNavigation();
    const text = paneId ? composerDrafts.get(paneId) : "";
    composerPopup.close();
    if (elements.terminalInput.value !== text) {
      elements.terminalInput.value = text;
      syncComposerExpanded({ fresh: true });
      resizeTerminalInput();
    }
  }

  // The message is about to go: nothing of it stays stored, so a closed page
  // mid-send leaves no copy. A failed send puts the draft back.
  function holdComposerDraft(paneId) {
    window.clearTimeout(getDraftSaveTimer());
    setDraftSaveTimer(null);
    draftHeld.add(paneId);
    composerDrafts.clear(paneId);
  }

  function releaseComposerDraft(paneId, { sent, text, secret = false }) {
    // Read once: nothing below assigns it (saveComposerDraft only reads it).
    const draftPaneId = getDraftPaneId();
    draftHeld.delete(paneId);
    if (sent) {
      // A password answer keeps its pane blocked until the composer is cleared or left.
      if (secret && draftPaneId === paneId && elements.terminalInput.value !== "") draftBlocked.add(paneId);
      else draftBlocked.delete(paneId);
      return;
    }
    if (draftPaneId === paneId) saveComposerDraft();
    // The pane was left while the message was on its way and it did not go: its
    // screen is not on show to be checked, so the text stays in memory only.
    else if (!draftBlocked.has(paneId) && !composerDrafts.get(paneId)) composerDrafts.set(paneId, text, { memoryOnly: true });
  }

  window.addEventListener("pagehide", saveComposerDraft);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveComposerDraft();
  });

  function rememberSentInput(paneId, text) {
    const history = state.inputHistoryByPane.get(paneId) || [];
    if (history.at(-1) !== text) history.push(text);
    if (history.length > 100) history.splice(0, history.length - 100);
    state.inputHistoryByPane.delete(paneId);
    state.inputHistoryByPane.set(paneId, history);
    writeInputHistories(panePreferenceStorage, state.inputHistoryByPane);
    resetInputHistoryNavigation();
  }

  return {
    resizeTerminalInput,
    syncComposerExpanded,
    scheduleTerminalInputResize,
    resetInputHistoryNavigation,
    saveComposerDraft,
    scheduleComposerDraftSave,
    syncComposerDraft,
    holdComposerDraft,
    releaseComposerDraft,
    rememberSentInput,
  };
}
