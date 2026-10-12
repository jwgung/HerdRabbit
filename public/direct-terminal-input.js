import { keyboardTerminalKey } from "./key-combinations.js?v=1.2.17";

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const characters = text => segmenter ? [...segmenter.segment(text)].map(part => part.segment) : [...text];

// Reflect IME revisions as terminal edits, without waiting for a word to commit.
// DEL and its replacement travel in one write to preserve ordering and avoid
// a separate network round trip for every revised Hangul syllable.
export function compositionEdit(previous, next) {
  const before = characters(previous);
  const after = characters(next);
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared++;
  return "\x7f".repeat(before.length - shared) + after.slice(shared).join("");
}

// One in-flight write: keys must never overtake text on a slow connection.
// A failed write may have reached the PTY, so discard its tail and never retry.
export function terminalInputQueue({ send, onSent = () => {}, onError = () => {} }) {
  let pending = [];
  let running = null;
  let failed = false;
  async function drain() {
    while (pending.length) {
      const item = pending.shift();
      try {
        await send(item);
        onSent(item);
      } catch (error) {
        pending = [];
        failed = true;
        onError(error);
        break;
      }
    }
  }
  return {
    enqueue(item) {
      if (failed) return false;
      const last = pending.at(-1);
      if (item.text && last?.text && last.paneId === item.paneId &&
          last.text.length + item.text.length <= 8000) last.text += item.text;
      else pending.push({ ...item });
      if (!running) running = Promise.resolve().then(drain).finally(() => { running = null; });
      return true;
    },
    async idle() { await running; },
    resume() { failed = false; },
    stop(error) { pending = []; failed = true; onError(error); },
  };
}

export function attachDirectTerminalInput({ output, input, composer, stage, indicator,
  getPaneId, getModifiers, clearModifiers, send, onSent, onError, onFiles = () => false }) {
  // A sentinel lets Android report backspace even with no local draft.
  const sentinel = "\u200b";
  let composing = false;
  let compositionTimer = null;
  let gesture = null;
  let active = false;
  let compositionPaneId = null;
  let compositionPreview = "";
  const selection = () => {
    const selected = window.getSelection();
    return selected && !selected.isCollapsed &&
      (output.contains(selected.anchorNode) || output.contains(selected.focusNode));
  };
  function reset() {
    compositionPreview = "";
    input.value = sentinel;
    input.setSelectionRange(1, 1);
    indicator.textContent = "Direct input";
  }
  function setActive(value) {
    active = value;
    stage.classList.toggle("is-direct-input", value);
    indicator.hidden = !value;
  }
  const queue = terminalInputQueue({ send, onSent, onError(error) {
    setActive(false);
    input.blur();
    onError(error);
  } });
  function enqueue(item) {
    const paneId = getPaneId();
    if (!paneId) return;
    queue.enqueue({ paneId, ...item });
  }
  function sendText(text) {
    // Bound each request to the existing API limit without splitting a surrogate pair.
    let chunk = "";
    for (const char of text) {
      if (chunk.length + char.length > 8000) { enqueue({ text: chunk }); chunk = ""; }
      chunk += char;
    }
    if (chunk) enqueue({ text: chunk });
  }
  function flush() {
    if (composing) return;
    const value = input.value;
    if (compositionPaneId && compositionPaneId !== getPaneId()) { reset(); return; }
    const text = value.startsWith(sentinel) ? value.slice(1) : value;
    const edit = compositionEdit(compositionPreview, text);
    if (edit) sendText(edit);
    reset();
  }
  function focus() {
    if (!getPaneId() || selection()) return;
    queue.resume();
    input.focus({ preventScroll: true });
  }
  reset();
  input.addEventListener("focus", () => { setActive(true); });
  input.addEventListener("blur", () => {
    // Do not commit a partial IME composition when the user changes targets.
    clearTimeout(compositionTimer);
    composing = false;
    compositionPaneId = null;
    reset();
  });
  document.addEventListener("focusin", (event) => {
    if (event.target === input) return;
    if (!event.target.closest(".quick-keys") && event.target !== output) setActive(false);
  });
  composer.addEventListener("focus", () => setActive(false));
  output.addEventListener("pointerdown", (event) => {
    gesture = { x: event.clientX, y: event.clientY, moved: false };
  });
  output.addEventListener("pointermove", (event) => {
    if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) gesture.moved = true;
  });
  output.addEventListener("pointercancel", () => { gesture = null; });
  output.addEventListener("click", (event) => {
    if (event.target.closest("a") || selection() || (event.detail && (!gesture || gesture.moved))) return;
    focus();
  });
  function keydown(event) {
    if (!getPaneId() || event.isComposing || composing || event.keyCode === 229) return;
    // Keep native copy/paste and selection gestures working.
    if ((event.ctrlKey || event.metaKey) && !event.altKey &&
        ((event.key.toLowerCase() === "c" && selection()) || event.key.toLowerCase() === "v")) return;
    if (selection()) return;
    const modifiers = getModifiers();
    const printable = [...event.key].length === 1;
    if (event.target === input && printable && !event.ctrlKey && !event.altKey && !event.metaKey && !modifiers.length) return;
    if (event.getModifierState?.("AltGraph")) return;
    const key = keyboardTerminalKey(event, modifiers);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    setActive(true);
    if (printable && !event.ctrlKey && !event.altKey && !event.metaKey && !modifiers.length) sendText(event.key);
    else enqueue({ keys: [key] });
    clearModifiers();
  }
  for (const element of [output, input]) {
    element.addEventListener("keydown", keydown);
    element.addEventListener("paste", (event) => {
      if (!getPaneId()) return;
      // A pasted image carries no text; sending it as one would type nothing.
      if (onFiles(event.clipboardData?.files)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      sendText(event.clipboardData.getData("text/plain"));
      reset();
    });
  }
  input.addEventListener("compositionstart", () => {
    composing = true;
    compositionPaneId = getPaneId();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    if (document.activeElement !== input) { reset(); return; }
    // Browsers differ on whether the final input event precedes compositionend.
    compositionTimer = setTimeout(() => { flush(); compositionPaneId = null; }, 0);
  });
  input.addEventListener("beforeinput", (event) => {
    if (composing || event.isComposing || !event.cancelable) return;
    const modifiers = getModifiers();
    if (modifiers.length && event.inputType === "insertText" &&
        typeof event.data === "string" && [...event.data].length === 1) {
      const key = keyboardTerminalKey({ key: event.data }, modifiers);
      if (key) {
        event.preventDefault();
        enqueue({ keys: [key] });
        clearModifiers();
        reset();
        return;
      }
    }
    const key = { deleteContentBackward: "backspace", deleteContentForward: "delete",
      insertLineBreak: "enter", insertParagraph: "enter" }[event.inputType];
    if (key) {
      event.preventDefault();
      enqueue({ keys: [key] });
      reset();
    }
  });
  input.addEventListener("input", (event) => {
    if (document.activeElement !== input) { reset(); return; }
    if (composing || event.isComposing) {
      if (compositionPaneId !== getPaneId()) return;
      const text = input.value.startsWith(sentinel) ? input.value.slice(1) : input.value;
      const edit = compositionEdit(compositionPreview, text);
      if (edit) sendText(edit);
      compositionPreview = text;
      indicator.textContent = text || "Direct input";
      return;
    }
    if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      enqueue({ keys: ["enter"] });
      reset();
      return;
    }
    if (event.inputType === "deleteContentBackward" && input.value === "") enqueue({ keys: ["backspace"] });
    flush();
  });
  return {
    isActive: () => active,
    ownsEvent: (event) => event.target === input || event.target === output,
    focus,
    key(key) { enqueue({ keys: [key] }); clearModifiers(); },
    idle: () => queue.idle(),
    stop: error => queue.stop(error),
  };
}
