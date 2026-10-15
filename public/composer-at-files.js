// `@` file references in the composer. Claude Code and Codex both take
// `@path` to mean "this file"; typing one here offers the names in the pane's
// own folder, the way their own prompts do.
//
// The parts that decide what is typed, where it is looked up and what goes in
// are plain functions; createAtFilesPopup wires them to the textarea and the
// list above it.

export const MAX_AT_MATCHES = 50;
export const AT_DEBOUNCE_MS = 120;
export const AT_CACHE_MS = 5_000;

// The `@` reference the caret is in, or null. It starts at the beginning of
// the text or after whitespace. Unquoted it runs to the caret with no
// whitespace; `@"…` runs to the caret with no closing quote, so a name with a
// space can be typed and completed. `end` also takes in what belongs to the
// reference past the caret: the rest of the word, or the rest of a quoted
// name up to and with its closing quote.
export function parseAtQuery(value, selectionStart, selectionEnd = selectionStart) {
  if (typeof value !== "string" || !Number.isInteger(selectionStart) || selectionStart !== selectionEnd) return null;
  const before = value.slice(0, selectionStart);
  const quoted = /(^|\s)@"([^"\n]*)$/u.exec(before);
  if (quoted) {
    const start = quoted.index + quoted[1].length;
    const closing = /^[^"\n]*"/u.exec(value.slice(selectionStart));
    const end = closing ? selectionStart + closing[0].length : selectionStart;
    return withParts({ start, end, query: quoted[2], quoted: true });
  }
  const plain = /(^|\s)@([^\s"]*)$/u.exec(before);
  if (!plain) return null;
  const start = plain.index + plain[1].length;
  const rest = /^[^\s]*/u.exec(value.slice(selectionStart))[0];
  return withParts({ start, end: selectionStart + rest.length, query: plain[2], quoted: false });
}

function withParts(token) {
  const cut = token.query.lastIndexOf("/");
  return { ...token, dir: token.query.slice(0, cut + 1), prefix: token.query.slice(cut + 1) };
}

// The absolute folder a reference's folder part names, or null when it cannot
// be known: `~` (the home belongs to the pane's machine, and a listing of this
// machine cannot say where it is), or a relative one with no working folder.
export function resolveAtDirectory(base, dir) {
  if (typeof dir !== "string") return null;
  if (dir.startsWith("~")) return null;
  let joined;
  if (dir.startsWith("/")) joined = dir;
  else if (typeof base === "string" && base.startsWith("/")) joined = `${base}/${dir}`;
  else return null;
  const parts = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

// What is offered from a listing: folders first, then files, by name. A
// locked entry, or a name with a quote or line break that no reference could
// carry, is left out; a hidden one only when the name typed starts with ".".
export function matchingEntries(entries, prefix = "", limit = MAX_AT_MATCHES) {
  const wanted = prefix.toLowerCase();
  const showHidden = prefix.startsWith(".");
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => typeof entry?.name === "string" && entry.name !== ""
      && (entry.kind === "directory" || entry.kind === "file")
      && !entry.locked
      && !/["\n\r]/u.test(entry.name)
      && (showHidden || !(entry.hidden || entry.name.startsWith(".")))
      && entry.name.toLowerCase().startsWith(wanted))
    .sort((first, second) => {
      if (first.kind !== second.kind) return first.kind === "directory" ? -1 : 1;
      return first.name < second.name ? -1 : first.name > second.name ? 1 : 0;
    })
    .slice(0, limit);
}

// The reference that goes in. A path with whitespace -- or one already typed
// in quotes -- is quoted whole: `@"my folder/notes.md"`, the form Claude Code
// takes for a name with a space.
export function atReferenceText(path, quoted = false) {
  return quoted || /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

// The composer once `entry` is picked for `token`. A folder goes in with its
// closing slash and the caret inside the reference, so the next names are
// offered at once; a file goes in with a space after it, and the reference is
// done.
export function applyAtCompletion(value, token, entry) {
  const directory = entry.kind === "directory";
  const path = `${token.dir}${entry.name}${directory ? "/" : ""}`;
  const quoted = token.quoted || /\s/u.test(path);
  const text = atReferenceText(path, quoted);
  const head = value.slice(0, token.start);
  let tail = value.slice(token.end);
  if (directory) {
    const caret = head.length + text.length - (quoted ? 1 : 0);
    return { value: `${head}${text}${tail}`, caret, open: true };
  }
  if (!/^\s/u.test(tail)) tail = ` ${tail}`;
  const caret = head.length + text.length + 1;
  return { value: `${head}${text}${tail}`, caret, open: false };
}

// Listings kept for a short while, so typing back and forth does not ask
// again. One asked with a shorter name, and not cut short, also answers a
// longer one: `ap` is inside what `a` brought back.
export function createListingCache({ ttlMs = AT_CACHE_MS, now = () => Date.now() } = {}) {
  const entries = new Map();
  const key = (server, dir, prefix) => JSON.stringify([server, dir, prefix]);
  return {
    get(server, dir, prefix) {
      const at = now();
      for (let length = prefix.length; length >= 0; length -= 1) {
        const shorter = prefix.slice(0, length);
        const found = entries.get(key(server, dir, shorter));
        if (!found) continue;
        if (at - found.at > ttlMs) {
          entries.delete(key(server, dir, shorter));
          continue;
        }
        if (length === prefix.length || !found.truncated) return found.entries;
      }
      return null;
    },
    set(server, dir, prefix, listing) {
      if (entries.size > 64) entries.clear();
      entries.set(key(server, dir, prefix), {
        at: now(), entries: Array.isArray(listing?.entries) ? listing.entries : [], truncated: listing?.truncated === true,
      });
    },
  };
}

// The popup itself. `context()` says where the selected pane is
// ({ server, cwd }) or null; `fetchListing(server, dir, prefix)` brings a listing back
// or throws. Nothing here ever reports an error: no pane, no folder or a
// listing that fails just means no list.
export function createAtFilesPopup({ input, listElement, context, fetchListing, document: doc = globalThis.document }) {
  const cache = createListingCache();
  const state = { token: null, matches: [], active: 0, open: false, timer: null, generation: 0, dismissed: null, composing: false };

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
    state.matches.forEach((entry, index) => {
      const item = doc.createElement("li");
      item.id = `${listElement.id}-${index}`;
      item.className = "file-suggestion composer-file";
      item.dataset.kind = entry.kind;
      item.setAttribute("role", "option");
      const name = doc.createElement("span");
      name.textContent = entry.kind === "directory" ? `${entry.name}/` : entry.name;
      item.append(name);
      // mousedown keeps the composer focused (and a phone's keyboard up);
      // the click that follows picks the name.
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

  async function lookUp(token, generation) {
    const where = context();
    const dir = where ? resolveAtDirectory(where.cwd, token.dir) : null;
    if (!dir) {
      close();
      return;
    }
    let entries = cache.get(where.server, dir, token.prefix);
    if (!entries) {
      try {
        const listing = await fetchListing(where.server, dir, token.prefix);
        cache.set(where.server, dir, token.prefix, listing);
        entries = listing?.entries || [];
      } catch {
        entries = [];
      }
    }
    // The caret moved on, or the list was closed, while this was asked.
    if (generation !== state.generation) return;
    state.token = token;
    state.matches = matchingEntries(entries, token.prefix);
    state.active = 0;
    render();
  }

  function update({ now = false } = {}) {
    window.clearTimeout(state.timer);
    state.timer = null;
    if (state.composing) return;
    const token = parseAtQuery(input.value, input.selectionStart, input.selectionEnd);
    if (!token) {
      state.dismissed = null;
      close();
      return;
    }
    if (state.dismissed === token.start) {
      close();
      return;
    }
    state.dismissed = null;
    const generation = ++state.generation;
    const run = () => void lookUp(token, generation);
    if (now) run();
    else state.timer = window.setTimeout(run, AT_DEBOUNCE_MS);
  }

  function accept(index = state.active) {
    const entry = state.matches[index];
    const token = state.token;
    if (!entry || !token) return;
    // Typed on, or moved, since this list was drawn: it belongs to another
    // reference. Nothing is put in; the list catches up instead.
    const now = parseAtQuery(input.value, input.selectionStart, input.selectionEnd);
    if (!now || now.start !== token.start || now.end !== token.end || now.query !== token.query || now.quoted !== token.quoted) {
      update({ now: true });
      return;
    }
    const next = applyAtCompletion(input.value, token, entry);
    close();
    input.value = next.value;
    input.setSelectionRange(next.caret, next.caret);
    // The composer's own listeners (draft, size, history) see it as typing;
    // that also brings up a folder's contents.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
  }

  // Whether the key was the popup's. Called first by the composer's own
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
      state.dismissed = state.token?.start ?? null;
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
    close,
    get isOpen() {
      return state.open;
    },
  };
}
