// Find in the conversation: a bar over the Chat lens that searches the turns
// this page has already drawn (not the pages before them, which the bar offers
// to load), marks every match in the page text with <mark>, and steps through
// them, the current one marked apart and scrolled to the middle of the view.
// Work blocks and tool rows that are folded shut are not drawn, so not searched.
//
// The bar's behavior follows herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- src/components/ChatFind.tsx and
// src/lib/chatSearch.ts, rewritten to mark the drawn page text in place.
import { MAX_FIND_QUERY_LENGTH, findIsCaseSensitive, foldForFind } from "../terminal-find.js?v=1.2.71";

const DEBOUNCE_MS = 150;
// A reader this close to the bottom of the chat is "at the bottom": a new find
// starts from the last match.
const AT_BOTTOM_PX = 48;
// Past this many matches the rest are neither marked nor counted ("1000+").
export const MAX_CHAT_MATCHES = 1000;

// Elements whose text ends where they end: a match does not run across them.
const BLOCK_TAGS = new Set([
  "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "BUTTON", "DD", "DETAILS", "DIV", "DL", "DT", "FIGURE",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "OL", "P", "PRE", "SECTION", "SUMMARY",
  "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
// The page's own furniture, not the conversation: copy and fold buttons, a
// code block's language, words only a screen reader hears.
const SKIPPED_CLASSES = ["chat-copy", "md-code-copy", "md-code-more", "md-code-head", "chat-tool-more",
  "chat-link-button", "sr-only", "work-caret"];

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function skipped(element) {
  const tag = String(element.tagName).toUpperCase();
  if (tag === "SVG" || tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return true;
  if (element.getAttribute?.("aria-hidden") === "true") return true;
  return SKIPPED_CLASSES.some((name) => element.classList?.contains(name));
}

// The text under `root` in runs read as one (the text nodes of one block, in
// page order), leaving out the page's furniture.
export function textRuns(root) {
  const runs = [];
  let run = [];
  const flush = () => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        if (child.data) run.push(child);
      } else if (child.nodeType === ELEMENT_NODE && !skipped(child)) {
        const block = BLOCK_TAGS.has(String(child.tagName).toUpperCase());
        if (block) flush();
        walk(child);
        if (block) flush();
      }
    }
  };
  walk(root);
  flush();
  return runs;
}

// Where `query` shows in `text`, as [start, end) pairs that do not overlap.
// Smart case, as in the terminal's find: a query with a capital matches
// exactly, one without in any case.
export function findInText(text, query) {
  if (typeof query !== "string" || query.length === 0) return [];
  const sensitive = findIsCaseSensitive(query);
  const haystack = foldForFind(text, sensitive);
  const needle = foldForFind(query, sensitive);
  const found = [];
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    found.push([at, at + needle.length]);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return found;
}

// Wraps every match of `query` under `root` in <mark class="chat-find-mark">,
// splitting text nodes where a match starts or ends; nothing else changes.
// Answers { matches, capped }: each match is its marks in page order (a match
// across bold or code text has one per piece).
export function markMatches(root, query, { document = globalThis.document, limit = MAX_CHAT_MATCHES } = {}) {
  const matches = [];
  let capped = false;
  for (const run of textRuns(root)) {
    if (matches.length >= limit) {
      // Full: all that is left to learn is whether any match was left out.
      if (findInText(run.map((node) => node.data).join(""), query).length > 0) {
        capped = true;
        break;
      }
      continue;
    }
    const text = run.map((node) => node.data).join("");
    let spans = findInText(text, query);
    if (spans.length === 0) continue;
    if (matches.length + spans.length > limit) {
      spans = spans.slice(0, limit - matches.length);
      capped = true;
    }
    // Each match's pieces, by the text node each lies in.
    const pieces = new Map();
    const firstMatch = matches.length;
    spans.forEach(([start, end], index) => {
      const own = [];
      let offset = 0;
      for (const node of run) {
        const from = Math.max(start, offset);
        const to = Math.min(end, offset + node.data.length);
        if (from < to) {
          const piece = { start: from - offset, end: to - offset, mark: null };
          own.push(piece);
          if (!pieces.has(node)) pieces.set(node, []);
          pieces.get(node).push(piece);
        }
        offset += node.data.length;
      }
      matches[firstMatch + index] = own;
    });
    for (const [node, inNode] of pieces) {
      // From the last piece back, so `node` keeps the text before each one.
      for (const piece of [...inNode].reverse()) {
        if (piece.end < node.data.length) node.splitText(piece.end);
        const middle = piece.start > 0 ? node.splitText(piece.start) : node;
        const mark = document.createElement("mark");
        mark.className = "chat-find-mark";
        middle.parentNode.replaceChild(mark, middle);
        mark.appendChild(middle);
        piece.mark = mark;
      }
    }
    for (let index = firstMatch; index < matches.length; index += 1) matches[index] = matches[index].map((piece) => piece.mark);
    if (capped) break;
  }
  return { matches, capped };
}

// Takes the marks out again, joining the text they split: the page is as it was.
export function clearMarks(matches) {
  const parents = new Set();
  for (const marks of matches) {
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parents.add(parent);
    }
  }
  for (const parent of parents) parent.normalize();
}

// "3/17": the third of seventeen, counted from the top of the conversation.
export function chatFindCountText({ query = "", total = 0, index = -1, capped = false } = {}) {
  if (!query) return "";
  if (total === 0) return "No matches";
  return `${index + 1}/${total}${capped ? "+" : ""}`;
}

// The match a step `direction` lands on: "older" is up, "newer" down, and the
// ends wrap round.
export function stepMatch(index, total, direction) {
  if (total <= 0) return -1;
  if (index < 0) return direction === "older" ? total - 1 : 0;
  return (index + (direction === "older" ? -1 : 1) + total) % total;
}

// The bar's behavior. A chat (chat-view.js) gives it `findRoot` (the drawn
// turns), `scroller`, `older()` ({ more, state } of the pages before) and
// `loadOlder()`; `redrawn(chat, { turns })` tells it the chat drew again.
export function createChatFind({
  document = globalThis.document, form, input, count, olderButton, newerButton, closeButton,
  more, moreButton, onOpen = () => {}, onClose = () => {},
  debounceMs = DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout, limit = MAX_CHAT_MATCHES,
}) {
  let chat = null;
  let open = false;
  let query = "";
  let matches = [];
  let capped = false;
  let index = -1;
  let timer = null;

  function render() {
    form.hidden = !open;
    count.textContent = chatFindCountText({ query, total: matches.length, index, capped });
    const none = matches.length === 0;
    // Stepping needs words to step through.
    const stuck = none && !input.value;
    olderButton.disabled = stuck;
    newerButton.disabled = stuck;
    const older = open && chat ? chat.older() : { more: false, state: "idle" };
    more.hidden = !older.more;
    moreButton.disabled = older.state === "loading";
    moreButton.textContent = older.state === "loading" ? "Loading…" : older.state === "failed" ? "Try again" : "Load earlier";
  }

  // Where the current match is, taken when it becomes current (a redraw may
  // have replaced its turn by the time it is needed): its turn, that turn's
  // place counted from the end, and how many of the turn's matches come first.
  let place = null;

  function markCurrent(next) {
    for (const mark of matches[index] ?? []) mark.classList.remove("is-current");
    index = next;
    for (const mark of matches[index] ?? []) mark.classList.add("is-current");
    place = null;
    const turn = index >= 0 ? turnOf(matches[index][0]) : null;
    if (turn) {
      const turns = Array.from(chat.findRoot.childNodes);
      const before = matches.slice(0, index).filter((marks) => turnOf(marks[0]) === turn).length;
      place = { turn, fromEnd: turns.length - turns.indexOf(turn), before };
    }
  }

  // The turn (the root's child) a mark is in.
  function turnOf(node) {
    const root = chat?.findRoot;
    while (node && node.parentNode !== root) node = node.parentNode;
    return node ?? null;
  }

  // Unfolds what hides the current match (a folded code block, a shut
  // notice), then scrolls it to the middle of the view.
  function reveal() {
    const first = matches[index]?.[0];
    if (!first) return;
    for (let node = first.parentNode; node && node !== chat.findRoot; node = node.parentNode) {
      if (String(node.tagName).toUpperCase() === "DETAILS" && !node.open) node.open = true;
      if (node.classList?.contains("md-code") && node.classList.contains("is-folded") && !node.classList.contains("is-expanded")) {
        Array.from(node.childNodes).find((child) => child.getAttribute?.("data-action") === "unfold-code")?.click?.();
      }
    }
    first.scrollIntoView?.({ block: "center", inline: "nearest" });
  }

  // Where a new search starts: the last match above the bottom of the view,
  // as the terminal's find starts from the bottom of its view going up; the
  // last of all when the reader is at the end (one folded out of sight too).
  function startIndex() {
    const scroller = chat?.scroller;
    const view = scroller?.getBoundingClientRect?.();
    if (!view || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - AT_BOTTOM_PX) return matches.length - 1;
    for (let at = matches.length - 1; at >= 0; at -= 1) {
      const box = matches[at][0].getBoundingClientRect?.();
      if (!box || box.top <= view.bottom) return at;
    }
    return 0;
  }

  // Marks `query` afresh. `keep` holds on to the current match through a
  // redraw (by its turn and its place among that turn's matches) and does not
  // scroll; otherwise the search starts over from the view and scrolls there.
  function apply({ keep = false } = {}) {
    const kept = keep ? place : null;
    clearMarks(matches);
    matches = [];
    capped = false;
    index = -1;
    place = null;
    if (open && chat && query) {
      ({ matches, capped } = markMatches(chat.findRoot, query, { document, limit }));
      let next = -1;
      if (kept) {
        const turns = Array.from(chat.findRoot.childNodes);
        const turn = kept.turn.parentNode === chat.findRoot ? kept.turn : turns[turns.length - kept.fromEnd] ?? null;
        const inTurn = [];
        matches.forEach((marks, at) => { if (turn && turnOf(marks[0]) === turn) inTurn.push(at); });
        if (inTurn.length > 0) next = inTurn[Math.min(kept.before, inTurn.length - 1)];
      }
      if (next < 0 && matches.length > 0) next = keep ? matches.length - 1 : startIndex();
      markCurrent(next);
      if (!keep) reveal();
    }
    render();
  }

  function flush() {
    if (timer === null) return false;
    clearTimer(timer);
    timer = null;
    query = input.value;
    apply();
    return true;
  }

  function step(direction) {
    if (flush()) return;
    if (matches.length === 0) return;
    markCurrent(stepMatch(index, matches.length, direction));
    reveal();
    render();
  }

  function close() {
    if (!open) return;
    open = false;
    clearTimer(timer);
    timer = null;
    clearMarks(matches);
    matches = [];
    capped = false;
    index = -1;
    query = "";
    render();
    onClose();
  }

  input.addEventListener("input", () => {
    if (input.value.length > MAX_FIND_QUERY_LENGTH) input.value = input.value.slice(0, MAX_FIND_QUERY_LENGTH);
    clearTimer(timer);
    timer = null;
    if (!input.value) {
      query = "";
      apply();
      return;
    }
    timer = setTimer(() => {
      timer = null;
      query = input.value;
      apply();
    }, debounceMs);
    render();
  });
  input.addEventListener("keydown", (event) => {
    // mid-composition the IME owns Enter and Escape
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? "newer" : "older");
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
  olderButton.addEventListener("click", () => step("older"));
  newerButton.addEventListener("click", () => step("newer"));
  closeButton.addEventListener("click", () => close());
  moreButton.addEventListener("click", () => { void chat?.loadOlder(); });

  render();
  return {
    get open() { return open; },
    get paneId() { return open ? chat?.paneId ?? null : null; },
    // Opens the bar on `forChat`, its text selected to type over.
    show(forChat) {
      if (chat !== forChat) {
        clearMarks(matches);
        matches = [];
        index = -1;
      }
      chat = forChat;
      const wasOpen = open;
      open = true;
      // shown before it takes the focus: a hidden field cannot have it
      render();
      input.focus();
      input.select?.();
      if (!wasOpen) {
        query = input.value;
        apply();
        onOpen();
      }
    },
    close,
    // The chat drew again: new turns, an earlier page, a block opened or
    // shut; or only its state (an earlier page loading) when `turns` is false.
    redrawn(forChat, { turns = true } = {}) {
      if (!open || forChat !== chat) return;
      if (turns) apply({ keep: true });
      else render();
    },
  };
}
