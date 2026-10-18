// Adapted from herdr-web-ui (MIT), src/lib/draft.ts and composerDraft.ts: each
// pane keeps the message typed but not sent. The drafts live in memory and are
// mirrored to localStorage, a bounded number of panes and a bounded size each.
// Only unsent text goes here: whoever sends a message clears it first.
import { secretPrompt } from "./secret-prompt.js?v=1.2.71";
import { paneRenames } from "./pane-rename.js?v=1.2.71";

export const COMPOSER_DRAFT_STORAGE_KEY = "herdrbridge-composer-drafts";
export const MAX_DRAFT_LENGTH = 8_000;
export const MAX_DRAFT_PANES = 30;
export const MAX_DRAFT_PANE_ID_LENGTH = 512;
// A draft not touched for a week is stale rather than wanted.
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const validPaneId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_DRAFT_PANE_ID_LENGTH;

function loaded(storage, now) {
  const entries = new Map();
  try {
    const value = JSON.parse(storage?.getItem(COMPOSER_DRAFT_STORAGE_KEY) || "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return entries;
    for (const [paneId, record] of Object.entries(value)) {
      if (!validPaneId(paneId) || typeof record !== "object" || record === null) continue;
      const { text, at } = record;
      if (typeof text !== "string" || text === "" || text.length > MAX_DRAFT_LENGTH) continue;
      if (typeof at !== "number" || !Number.isFinite(at) || now - at > DRAFT_TTL_MS) continue;
      entries.set(paneId, { text, at });
    }
  } catch {
    return new Map();
  }
  // Oldest first, so the newest survive the cap.
  const ordered = [...entries].sort((a, b) => a[1].at - b[1].at).slice(-MAX_DRAFT_PANES);
  return new Map(ordered);
}

// isSecret(paneId) tells whether that pane's draft must not be written: its
// screen asks for a password, or cannot be trusted to say it does not. Such a
// draft stays in memory for this visit, is never written, and any copy already
// stored for the pane is removed. A text judged secret stays secret while it is
// unchanged, even if the prompt leaves the screen, and a text judged fine stays
// stored while unchanged; only a changed, cleared or sent text is judged again.
// `isSecret(paneId)`: the draft must not be written (fails closed).
// `showsPrompt(paneId)`: a verified screen shows a password prompt now; it can
// only make a kept text secret, never the other way.
export function createComposerDrafts(storage, now = Date.now, isSecret = () => false, showsPrompt = () => false) {
  const entries = loaded(storage, now());
  const memoryOnly = new Map(); // pane id -> the text judged secret

  // Text longer than a draft may be stays in memory for this visit only: a
  // stale shorter copy in storage must not come back instead of it.
  function persist() {
    try {
      if (!storage) return false;
      const stored = {};
      for (const [paneId, record] of entries) {
        if (record.text.length <= MAX_DRAFT_LENGTH && !memoryOnly.has(paneId)) stored[paneId] = record;
      }
      if (Object.keys(stored).length === 0) {
        if (typeof storage.removeItem === "function") storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
        else storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, "{}");
      } else {
        storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(stored));
      }
      return true;
    } catch {
      return false;
    }
  }

  return {
    get(paneId) {
      return validPaneId(paneId) ? entries.get(paneId)?.text ?? "" : "";
    },
    // `memoryOnly: true` keeps this text out of storage without asking.
    set(paneId, text, { memoryOnly: forced = false } = {}) {
      if (!validPaneId(paneId)) return false;
      if (typeof text !== "string" || text === "") return this.clear(paneId);
      // An unchanged text keeps a secret verdict. A fine one is looked at
      // again only against a verified screen: a password prompt drawn after
      // it was typed makes it secret (it may be the answer, typed ahead), while
      // an unreadable screen (the page unloading) leaves it as it was.
      const unchanged = entries.get(paneId)?.text === text;
      let secret = forced;
      if (!secret && unchanged) {
        secret = memoryOnly.get(paneId) === text;
        if (!secret) {
          try { secret = showsPrompt(paneId) === true; } catch { secret = false; }
        }
      }
      else if (!secret) {
        try { secret = isSecret(paneId) === true; } catch { secret = true; }
      }
      if (secret) memoryOnly.set(paneId, text); else memoryOnly.delete(paneId);
      entries.delete(paneId);
      entries.set(paneId, { text, at: now() });
      while (entries.size > MAX_DRAFT_PANES) entries.delete(entries.keys().next().value);
      return persist();
    },
    clear(paneId) {
      memoryOnly.delete(paneId);
      if (!entries.delete(paneId)) return true;
      return persist();
    },
    // A pane carried to another project has a new id: its draft follows, and
    // keeps its verdict (a secret one stays out of storage).
    rename(moves) {
      const renames = paneRenames(moves);
      const keep = [...renames.entries()].filter(([from, to]) => entries.has(from) && validPaneId(to));
      if (keep.length === 0) return true;
      const taken = keep.map(([from, to]) => [to, entries.get(from), memoryOnly.get(from)]);
      for (const [from] of keep) { entries.delete(from); memoryOnly.delete(from); }
      for (const [to, record, secret] of taken) {
        entries.delete(to);
        memoryOnly.delete(to);
        entries.set(to, record);
        if (secret !== undefined) memoryOnly.set(to, secret);
      }
      return persist();
    },
    // Sign-out: nothing of any pane stays, in memory or in storage.
    clearAll() {
      entries.clear();
      memoryOnly.clear();
      persist();
    },
    panes() {
      return [...entries.keys()];
    },
  };
}

// `screen` is { paneId, text, cols, fresh } from the terminal. True when the
// draft of `paneId` must not be written: it is not the pane on show, the screen
// is another pane's, missing, parked, not yet drawn or held back (not fresh), or
// a password prompt is on it. Anything the page cannot verify fails closed.
// True only when the shown, fresh screen of `paneId` has a password prompt.
export function draftScreenShowsPrompt(paneId, shownPaneId, screen) {
  if (!paneId || paneId !== shownPaneId || !screen || screen.paneId !== paneId || screen.fresh !== true) return false;
  return secretPrompt(String(screen.text ?? ""), screen.cols || Infinity) !== null;
}

export function draftScreenIsSecret(paneId, shownPaneId, screen) {
  if (!paneId || paneId !== shownPaneId) return true;
  if (!screen || screen.paneId !== paneId || screen.fresh !== true) return true;
  return secretPrompt(String(screen.text ?? ""), screen.cols || Infinity) !== null;
}
