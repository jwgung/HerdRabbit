// Adapted from herdr-web-ui (MIT), src/lib/draft.ts and composerDraft.ts: each
// pane keeps the message typed but not sent. The drafts live in memory and are
// mirrored to localStorage, a bounded number of panes and a bounded size each.
// Only unsent text goes here: whoever sends or queues a message clears it first.
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

// isSecret(paneId) tells whether that pane's screen asks for a password right
// now. Such a draft stays in memory for this visit, is never written, and any
// copy already stored for the pane is removed.
export function createComposerDrafts(storage, now = Date.now, isSecret = () => false) {
  const entries = loaded(storage, now());
  const memoryOnly = new Set();

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
    set(paneId, text) {
      if (!validPaneId(paneId)) return false;
      if (typeof text !== "string" || text === "") return this.clear(paneId);
      let secret = false;
      try { secret = isSecret(paneId) === true; } catch { secret = true; }
      if (secret) memoryOnly.add(paneId); else memoryOnly.delete(paneId);
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
    panes() {
      return [...entries.keys()];
    },
  };
}
