// The list above the composer that completes what is being typed: `@` file
// references (composer-at-files.js) and `/` commands (composer-slash.js).
// One list for both, since only one of them can be typed at the caret at a
// time. Each kind is a source:
//
//   label                      the list's accessible name ("Files", "Commands")
//   parse(value, start, end)   the token the caret is in, with its `start`, or null
//   debounceMs                 how long typing settles before asking
//   lookUp(token)              -> { matches, where } or null (no list)
//   stillCurrent(where)        whether what was looked up still holds (the pane
//                              has not moved on), checked before a pick goes in
//   sameToken(a, b)            whether two parses are the same token
//   apply(value, token, match) -> { value, caret, open }: the composer after the pick
//   renderItem(li, match, doc) fills a row
//
// Nothing here ever reports an error: a lookup that fails is no list.

export function createComposerPopup({ input, listElement, sources, document: doc = globalThis.document }) {
  const state = {
    source: null, token: null, where: null, matches: [], active: 0, open: false,
    timer: null, generation: 0, dismissed: null, composing: false,
  };

  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listElement.id);
  input.setAttribute("aria-expanded", "false");

  function close() {
    window.clearTimeout(state.timer);
    state.timer = null;
    state.generation += 1;
    state.open = false;
    state.matches = [];
    state.token = null;
    state.source = null;
    listElement.hidden = true;
    listElement.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function markActive() {
    [...listElement.children].forEach((item, index) => {
      const active = index === state.active;
      item.setAttribute("aria-selected", String(active));
      if (active) {
        input.setAttribute("aria-activedescendant", item.id);
        item.scrollIntoView?.({ block: "nearest" });
      }
    });
  }

  function render() {
    listElement.replaceChildren();
    if (state.matches.length === 0) {
      close();
      return;
    }
    listElement.setAttribute("aria-label", state.source.label);
    state.matches.forEach((match, index) => {
      const item = doc.createElement("li");
      item.id = `${listElement.id}-${index}`;
      item.setAttribute("role", "option");
      state.source.renderItem(item, match, doc);
      // mousedown keeps the composer focused (and a phone's keyboard up);
      // the click that follows picks the row.
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", (event) => {
        event.preventDefault();
        accept(index);
      });
      listElement.append(item);
    });
    state.open = true;
    listElement.hidden = false;
    input.setAttribute("aria-expanded", "true");
    markActive();
  }

  async function lookUp(source, token, generation) {
    let found = null;
    try {
      found = await source.lookUp(token);
    } catch {
      found = null;
    }
    // The caret moved on, or the list was closed, while this was asked.
    if (generation !== state.generation) return;
    if (!found) {
      close();
      return;
    }
    state.source = source;
    state.token = token;
    state.where = found.where ?? null;
    state.matches = Array.isArray(found.matches) ? found.matches : [];
    state.active = 0;
    render();
  }

  function parsed() {
    for (const source of sources) {
      const token = source.parse(input.value, input.selectionStart, input.selectionEnd);
      if (token) return { source, token };
    }
    return null;
  }

  function update({ now = false } = {}) {
    window.clearTimeout(state.timer);
    state.timer = null;
    if (state.composing) return;
    const found = parsed();
    if (!found) {
      state.dismissed = null;
      close();
      return;
    }
    const { source, token } = found;
    if (state.dismissed?.source === source && state.dismissed.start === token.start) {
      close();
      return;
    }
    state.dismissed = null;
    const generation = ++state.generation;
    const run = () => void lookUp(source, token, generation);
    if (now) run();
    else state.timer = window.setTimeout(run, source.debounceMs ?? 0);
  }

  function accept(index = state.active) {
    const match = state.matches[index];
    const { token, source } = state;
    if (!match || !token || !source) return;
    // Typed on, or moved, since this list was drawn: it belongs to another
    // token. Nothing is put in; the list catches up instead. The same when
    // what it was looked up for has changed (the pane moved on).
    const current = source.parse(input.value, input.selectionStart, input.selectionEnd);
    if (!source.stillCurrent(state.where) || !current || !source.sameToken(current, token)) {
      update({ now: true });
      return;
    }
    const next = source.apply(input.value, token, match);
    // Set by script, the value would pass the composer's maxlength; a pick
    // that does not fit is not put in.
    if (input.maxLength > 0 && next.value.length > input.maxLength) {
      close();
      return;
    }
    close();
    input.value = next.value;
    input.setSelectionRange(next.caret, next.caret);
    // The composer's own listeners (draft, size, history) see it as typing;
    // that also brings up what follows a pick that keeps the list open.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
  }

  // Whether the key was the list's. Called first by the composer's own
  // keydown, so a handled key never reaches send, newline or history.
  function handleKeydown(event) {
    if (!state.open || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return false;
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
    if (!plain) return false;
    const count = state.matches.length;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.shiftKey) {
      state.active = (state.active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      markActive();
    } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      accept();
    } else if (event.key === "Escape") {
      state.dismissed = state.token ? { source: state.source, start: state.token.start } : null;
      close();
    } else {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  input.addEventListener("input", (event) => {
    if (event.isComposing) return;
    update();
  });
  input.addEventListener("compositionstart", () => {
    state.composing = true;
  });
  input.addEventListener("compositionend", () => {
    state.composing = false;
    update();
  });
  // The caret moved without typing: a click, or the arrows along the line.
  input.addEventListener("click", () => update({ now: true }));
  input.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) update({ now: true });
  });
  input.addEventListener("blur", () => {
    state.composing = false;
    close();
  });

  return {
    handleKeydown,
    // From outside (another pane's draft, a sent message), an Escape on the
    // text that was there no longer holds.
    close() {
      state.dismissed = null;
      close();
    },
    get isOpen() {
      return state.open;
    },
  };
}
