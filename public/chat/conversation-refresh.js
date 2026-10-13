// What the chat holds of a pane's conversation, and how it is kept current
// from GET /api/panes/:id/conversation (no DOM here):
//
// - the newest page is read again on each change: with no `since` until an
//   older page is shown, then with `since` = where the newest page began when
//   the first older page went above it, so the two always meet;
// - an older page (`before`) goes above everything shown;
// - when the newest page has moved past that start (the conversation grew by
//   more than a page meanwhile), the turns in between are read a page at a
//   time and join the older ones;
// - a 409 (another transcript: a new session, a file rewritten) or a new
//   history id starts over from the newest page.
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- the reading logic of
// src/components/ChatView.tsx and src/lib/conversationRefresh.ts.

// How many pages one gap fill may read before it gives up and starts over.
const MAX_GAP_PAGES = 32;

export function isHistoryChanged(error) {
  return error?.status === 409 || error?.code === "history_changed";
}

export class ConversationHistory {
  constructor() {
    this.revision = 0;
    this.reset();
  }

  reset() {
    this.historyId = null;
    // turns above the newest page, oldest first
    this.older = [];
    // the newest page: everything from `held` (or from its own start) on
    this.tail = [];
    // where the newest page is read from once an older page is shown
    this.held = null;
    // the `before` for the next older page; null at the conversation's
    // beginning, undefined while unknown
    this.olderCursor = undefined;
    this.metadata = null;
    this.loaded = false;
    this.lastAnswer = null;
    this.revision += 1;
  }

  get turns() {
    return this.older.length === 0 ? this.tail : [...this.older, ...this.tail];
  }

  newestQuery() {
    return this.held === null ? {} : { since: this.held };
  }

  // A newest page read with no `since` (or one that starts where `held` does).
  // False when it is the answer already shown (an unchanged read).
  acceptNewest(answer) {
    if (answer === this.lastAnswer) return false;
    if (this.historyId !== null && answer.history_id !== this.historyId) this.reset();
    this.historyId = answer.history_id;
    this.tail = Array.isArray(answer.turns) ? answer.turns : [];
    if (this.held === null) this.olderCursor = typeof answer.cursor === "string" ? answer.cursor : null;
    this.metadata = answer.metadata ?? null;
    this.loaded = true;
    this.lastAnswer = answer;
    this.revision += 1;
    return true;
  }

  // An older page read with `before`. False when it no longer fits: the
  // history changed meanwhile, or another load already put that page above.
  acceptOlder(before, answer) {
    if (answer.history_id !== this.historyId || before !== this.olderCursor) return false;
    if (this.held === null) this.held = before;
    this.older = [...(Array.isArray(answer.turns) ? answer.turns : []), ...this.older];
    this.olderCursor = typeof answer.cursor === "string" ? answer.cursor : null;
    this.revision += 1;
    return true;
  }

  // The turns between `held` and the newest page's new start, read meanwhile.
  acceptGap(turns, answer) {
    this.older = [...this.older, ...turns];
    this.held = answer.cursor;
    this.lastAnswer = null;
    return this.acceptNewest(answer);
  }
}

// One read of the newest page into `history`, with its gap fill and its
// start over. `fetchPage({ before, since })` answers a page (the same object
// again for an unchanged one) or throws an error with `status`.
export async function readNewest(history, fetchPage) {
  const query = history.newestQuery();
  let answer;
  try {
    answer = await fetchPage(query);
  } catch (error) {
    if (!isHistoryChanged(error) || query.since === undefined) throw error;
    history.reset();
    return history.acceptNewest(await fetchPage({}));
  }
  const held = history.held;
  if (held === null || answer.cursor === held || answer.history_id !== history.historyId) {
    if (held !== null && answer.cursor !== held) history.reset();
    return history.acceptNewest(answer);
  }
  // The newest page moved past the held start: read what is in between.
  const between = typeof answer.cursor === "string" ? await turnsBetween(fetchPage, held, answer) : null;
  if (between === null) {
    history.reset();
    return history.acceptNewest(answer);
  }
  return history.acceptGap(between, answer);
}

async function turnsBetween(fetchPage, held, answer) {
  const pages = [];
  let before = answer.cursor;
  try {
    for (let step = 0; step < MAX_GAP_PAGES && before !== held; step += 1) {
      const page = await fetchPage({ before, since: held });
      if (page.history_id !== answer.history_id || typeof page.cursor !== "string" || page.cursor === before) return null;
      pages.unshift(Array.isArray(page.turns) ? page.turns : []);
      before = page.cursor;
    }
  } catch {
    return null;
  }
  return before === held ? pages.flat() : null;
}

// The page above everything shown. False when there is none to read, or it
// no longer fits; a 409 starts the history over (the caller reads the newest).
export async function readOlder(history, fetchPage) {
  const before = history.olderCursor;
  if (typeof before !== "string") return false;
  let page;
  try {
    page = await fetchPage({ before });
  } catch (error) {
    if (isHistoryChanged(error)) {
      history.reset();
      return false;
    }
    throw error;
  }
  if (page.history_id !== history.historyId) {
    history.reset();
    return false;
  }
  return history.acceptOlder(before, page);
}

// Keeps one pane's history current: one read at a time, a burst of changes
// read once, and no newest read sooner than `minIntervalMs` after the last.
export class ConversationLoader {
  constructor({ fetchPage, onChange = () => {}, onError = () => {}, onRead = () => {}, minIntervalMs = 300,
    now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) }) {
    this.history = new ConversationHistory();
    this.fetchPage = fetchPage;
    this.onChange = onChange;
    this.onError = onError;
    this.onRead = onRead;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.running = false;
    this.wanted = false;
    this.olderWanted = null;
    this.timer = null;
    this.lastReadAt = -Infinity;
    this.stopped = false;
    this.error = null;
  }

  // Read the newest page soon (a change was announced, the chat was shown).
  refresh({ now = false } = {}) {
    if (this.stopped) return;
    this.wanted = true;
    if (now) this.lastReadAt = -Infinity;
    void this.#drain();
  }

  // Read the page above what is shown. Resolves once it is in (or not).
  loadOlder() {
    if (this.stopped) return Promise.resolve(false);
    if (!this.olderWanted) {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      this.olderWanted = { promise, resolve };
    }
    const { promise } = this.olderWanted;
    void this.#drain();
    return promise;
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.timer);
    this.timer = null;
    this.olderWanted?.resolve(false);
    this.olderWanted = null;
  }

  async #drain() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        if (this.olderWanted) {
          const { resolve } = this.olderWanted;
          this.olderWanted = null;
          const revision = this.history.revision;
          let added = false;
          try {
            added = await readOlder(this.history, this.fetchPage);
            this.error = null;
          } catch (error) {
            this.error = error;
            this.onError(error, { older: true });
          }
          if (this.history.revision !== revision) {
            // a 409 emptied the history: read it again from the newest page
            if (!this.history.loaded) { this.wanted = true; this.lastReadAt = -Infinity; }
            this.onChange(this.history, { older: added });
          }
          resolve(added);
          continue;
        }
        if (!this.wanted) break;
        const wait = this.lastReadAt + this.minIntervalMs - this.now();
        if (wait > 0) {
          this.clearTimer(this.timer);
          this.timer = this.setTimer(() => { this.timer = null; void this.#drain(); }, wait);
          break;
        }
        this.wanted = false;
        this.lastReadAt = this.now();
        const revision = this.history.revision;
        try {
          await readNewest(this.history, this.fetchPage);
          this.error = null;
          this.onRead(this.history);
        } catch (error) {
          this.error = error;
          this.onError(error, { older: false });
          continue;
        }
        if (this.history.revision !== revision) this.onChange(this.history, { older: false });
      }
    } finally {
      this.running = false;
    }
  }
}
