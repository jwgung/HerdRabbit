// Find in the terminal: a bar over the Terminal lens that searches the pane's
// whole history on the server (herdr's copy-mode search, POST
// /api/panes/:id/find), then, if the bar is still on the same pane and words,
// has herdr scroll the pane's view to the match (POST /api/panes/:id/reveal).
// What is on screen is xterm's to draw; this marks the query where it shows.
// Behavior adapted from herdr-web-ui (MIT), src/components/FindBar.tsx.

// Same limit as src/herdr-client.mjs and the input's maxlength in index.html.
export const MAX_FIND_QUERY_LENGTH = 256;
const DEBOUNCE_MS = 250;

// Herdr matches a query without capitals in any case, and one with a capital
// exactly ("smart case"); the marks on screen follow the same rule.
export function findIsCaseSensitive(query) {
  return /\p{Lu}/u.test(query);
}

// Text as a find compares it: as it is when the query has a capital, in lower
// case otherwise. Letter by letter, so one letter whose lower case is longer
// (İ) stays as it is instead of shifting every index after it: an index in the
// folded text is the same index in the text.
export function foldForFind(text, sensitive) {
  if (sensitive) return text;
  let folded = "";
  for (const letter of text) {
    const lower = letter.toLowerCase();
    folded += lower.length === letter.length ? lower : letter;
  }
  return folded;
}

// Where `query` shows in the screen rows (as xterm-terminal.js reads them: the
// text and the cell each character starts in), as { row, start, end, current }
// in cells, end excluded. `current` is the cell herdr's current match starts
// in, { row, col } on screen, if it is on screen; that one is marked apart.
// Text cut at a row's end is not followed onto the next row.
export function findOccurrences(rows, query, current = null) {
  if (typeof query !== "string" || query.length === 0) return [];
  const sensitive = findIsCaseSensitive(query);
  const fold = (text) => foldForFind(text, sensitive);
  const needle = fold(query);
  const found = [];
  rows.forEach((row, index) => {
    const haystack = fold(row.text);
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      const start = row.cells[at];
      const end = row.cells[at + needle.length] ?? row.cells.at(-1);
      found.push({
        row: index, start, end,
        current: current !== null && current.row === index && current.col === start,
      });
      at = haystack.indexOf(needle, at + Math.max(1, needle.length));
    }
  });
  return found;
}

// The screen cell herdr's current match starts in, or null when it is not on
// screen. History rows count from the top; the view's top row is the history
// row `max_offset_from_bottom - offset_from_bottom`.
export function currentMatchCell(result) {
  const match = result?.match;
  const scroll = result?.scroll;
  if (!match || !scroll) return null;
  const top = scroll.max_offset_from_bottom - scroll.offset_from_bottom;
  const row = match.start.row - top;
  if (row < 0 || row >= scroll.viewport_rows) return null;
  return { row, col: match.start.col };
}

// "3/17" for the third of seventeen, counted from the top of the history.
export function findCountText({ busy = false, result = null, error = null } = {}) {
  if (error) return "Search failed";
  if (busy && !result) return "…";
  if (!result) return "";
  if (result.current === null || result.total === 0) return "No matches";
  return `${result.current}/${result.total}`;
}

// The request for a step `direction` from the last answer, when it was for
// this same query; a new query starts afresh from the bottom of the view.
export function findRequestBody(query, result, direction) {
  const previous = result && result.query === query && result.match ? result.match : null;
  return {
    query, direction,
    ...(previous ? { previous, contentRevision: result.content_revision } : {}),
  };
}

// Cmd+F on a Mac, Ctrl+F elsewhere; on a Mac Ctrl+F stays the terminal's.
export function isFindShortcut(event, mac) {
  if (event.isComposing || event.altKey || event.shiftKey || String(event.key).toLowerCase() !== "f") return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

// The bar's behavior. `search(paneId, body)` asks the server, `reveal(paneId,
// { match, contentRevision })` has it scroll the view to the match found (and
// answers { scroll }); `onHighlight`
// hears what to mark on screen ({ query, current } or null); `onClose` hears
// the bar close (to give the terminal its focus back), `onError` a failed find.
export function createTerminalFind({
  form, input, count, olderButton, newerButton, closeButton,
  search, reveal = null, coverRows = () => undefined,
  onHighlight = () => {}, onClose = () => {}, onOpen = () => {}, onError = () => {},
  debounceMs = DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let paneId = null;
  let open = false;
  let result = null;
  let busy = false;
  let error = null;
  let queued = null;
  let timer = null;
  // Each opening of the bar is its own: an answer to a find from before a close
  // is not taken for one asked after it, even for the same words.
  let opening = 0;

  function render() {
    form.hidden = !open;
    count.textContent = findCountText({ busy, result, error });
    count.title = error ?? "";
    count.dataset.error = error ? "true" : "false";
    const empty = input.value.length === 0;
    olderButton.disabled = empty;
    newerButton.disabled = empty;
  }

  function highlight() {
    if (!open || !result || result.query !== input.value || !result.match) {
      onHighlight(open && input.value ? { query: input.value, current: null } : null);
      return;
    }
    onHighlight({ query: result.query, current: currentMatchCell(result) });
  }

  async function run(direction, { fresh = false } = {}) {
    clearTimer(timer);
    timer = null;
    const query = input.value;
    if (!open || !paneId || !query) return;
    if (busy) {
      queued = { direction, fresh: fresh || queued?.fresh === true };
      return;
    }
    busy = true;
    error = null;
    render();
    const forPane = paneId;
    const forOpening = opening;
    const body = findRequestBody(query, fresh ? null : result, direction);
    try {
      // The reader may have changed the words, left the pane or closed the bar
      // while the server worked: then nothing is shown, and, above all, the
      // shared view is not scrolled for a search nobody wants any more.
      const current = () => forPane === paneId && open && forOpening === opening && input.value === query;
      // Scrolls the shared view to the match. Once the request is out the
      // server moves it whatever the reader does next; that window is the
      // round trip only, and the answer is dropped if things changed.
      const revealed = async (answer) => {
        if (!reveal || !answer.match) return answer;
        const cover = coverRows();
        const moved = await reveal(forPane, {
          match: answer.match, contentRevision: answer.content_revision,
          ...(Number.isSafeInteger(cover) ? { coverRows: cover } : {}),
        });
        return moved?.scroll === undefined ? answer : { ...answer, scroll: moved.scroll };
      };
      let answer;
      try {
        answer = await search(forPane, body);
        if (!current()) return;
        answer = await revealed(answer);
      } catch (cause) {
        // Output moved the history since the last match (or since the find, for
        // the reveal): find again from where the view is now, the same way.
        if (cause?.code !== "stale_content" || (!body.previous && !answer)) throw cause;
        // A search the reader has since changed or left is not retried: it
        // would scroll the shared view for words nobody is looking for now.
        if (!current()) return;
        answer = await search(forPane, findRequestBody(query, null, direction));
        if (!current()) return;
        answer = await revealed(answer);
      }
      if (current()) result = { ...answer, query };
    } catch (cause) {
      // A failure belongs to its own search: one the reader has left says nothing.
      if (forPane === paneId && open && forOpening === opening && input.value === query) {
        result = null;
        error = cause?.message || "Search failed";
        onError(error);
      }
    } finally {
      busy = false;
      render();
      highlight();
      const next = queued;
      queued = null;
      if (next && open) void run(next.direction, { fresh: next.fresh });
    }
  }

  function close() {
    if (!open) return;
    open = false;
    opening += 1;
    clearTimer(timer);
    timer = null;
    queued = null;
    result = null;
    error = null;
    render();
    onHighlight(null);
    onClose();
  }

  input.addEventListener("input", () => {
    if (input.value.length > MAX_FIND_QUERY_LENGTH) input.value = input.value.slice(0, MAX_FIND_QUERY_LENGTH);
    result = null;
    error = null;
    render();
    highlight();
    clearTimer(timer);
    timer = input.value ? setTimer(() => void run("backward", { fresh: true }), debounceMs) : null;
  });
  input.addEventListener("keydown", (event) => {
    // mid-composition the IME owns Enter and Escape
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      // A query still waiting on its pause is searched now, from the bottom.
      const fresh = timer !== null || !result;
      void run(event.shiftKey ? "forward" : "backward", { fresh });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.target === input) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  form.addEventListener("submit", (event) => event.preventDefault());
  olderButton.addEventListener("click", () => void run("backward"));
  newerButton.addEventListener("click", () => void run("forward"));
  closeButton.addEventListener("click", () => close());

  render();
  return {
    get open() { return open; },
    // Opens the bar on `forPane`, its text selected to type over.
    show(forPane) {
      if (paneId !== forPane) {
        result = null;
        error = null;
      }
      paneId = forPane;
      const wasOpen = open;
      if (!wasOpen) opening += 1;
      open = true;
      render();
      input.focus();
      input.select?.();
      if (!wasOpen) {
        highlight();
        onOpen();
        if (input.value && !result) void run("backward", { fresh: true });
      }
    },
    close,
    // The pane on screen changed (or went): a find belongs to one pane.
    setPane(nextPaneId) {
      if (nextPaneId === paneId) return;
      close();
      paneId = nextPaneId;
      result = null;
    },
    // The view moved under the reader (wheel, finger, typing): the current
    // match's place on screen is no longer known; the marks stay.
    forgetPlace() {
      if (result?.match) {
        result = { ...result, scroll: null };
        highlight();
      }
    },
  };
}
