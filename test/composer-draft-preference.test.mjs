import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DRAFT_TTL_MS,
  MAX_DRAFT_LENGTH,
  MAX_DRAFT_PANES,
  createComposerDrafts,
} from "../public/composer-draft-preference.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("each pane keeps its own text, which survives a restart", () => {
  const storage = memoryStorage();
  const drafts = createComposerDrafts(storage);
  drafts.set("a", "hello a");
  drafts.set("b", "hello b");
  assert.equal(drafts.get("a"), "hello a");
  assert.equal(drafts.get("b"), "hello b");
  assert.equal(drafts.get("c"), "");
  const again = createComposerDrafts(storage);
  assert.equal(again.get("a"), "hello a");
  assert.equal(again.get("b"), "hello b");
});

test("clearing (a message was sent or queued) leaves nothing stored", () => {
  const storage = memoryStorage();
  const drafts = createComposerDrafts(storage);
  drafts.set("a", "secret?");
  drafts.clear("a");
  assert.equal(drafts.get("a"), "");
  assert.equal(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY), false);
  drafts.set("a", "x");
  drafts.set("a", "");
  assert.equal(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY), false, "an emptied box is not a draft");
  assert.equal(createComposerDrafts(storage).get("a"), "");
});

test("keeps only the most recent panes", () => {
  const storage = memoryStorage();
  const drafts = createComposerDrafts(storage);
  for (let n = 0; n < MAX_DRAFT_PANES + 5; n += 1) drafts.set(`p${n}`, `t${n}`);
  assert.equal(drafts.panes().length, MAX_DRAFT_PANES);
  assert.equal(drafts.get("p0"), "");
  assert.equal(drafts.get(`p${MAX_DRAFT_PANES + 4}`), `t${MAX_DRAFT_PANES + 4}`);
  assert.equal(Object.keys(JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY))).length, MAX_DRAFT_PANES);
  drafts.set("p10", "again");
  assert.equal(drafts.panes().at(-1), "p10", "writing a draft makes it the newest");
});

test("a text over the limit is kept for the visit but never stored", () => {
  const storage = memoryStorage();
  const drafts = createComposerDrafts(storage);
  drafts.set("a", "short");
  const long = "x".repeat(MAX_DRAFT_LENGTH + 1);
  drafts.set("a", long);
  assert.equal(drafts.get("a"), long);
  assert.equal(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY), false, "the older short copy does not come back");
  assert.equal(createComposerDrafts(storage).get("a"), "");
  drafts.set("b", "x".repeat(MAX_DRAFT_LENGTH));
  assert.equal(createComposerDrafts(storage).get("b").length, MAX_DRAFT_LENGTH);
});

test("old, malformed and oversized records are ignored", () => {
  let now = 1_000_000_000_000;
  const storage = memoryStorage({
    [COMPOSER_DRAFT_STORAGE_KEY]: JSON.stringify({
      fresh: { text: "keep", at: now - 1000 },
      stale: { text: "old", at: now - DRAFT_TTL_MS - 1 },
      noTime: { text: "x" },
      empty: { text: "", at: now },
      numeric: { text: 5, at: now },
      huge: { text: "x".repeat(MAX_DRAFT_LENGTH + 1), at: now },
      [`${"p".repeat(513)}`]: { text: "long id", at: now },
      nested: 7,
    }),
  });
  const drafts = createComposerDrafts(storage, () => now);
  assert.deepEqual(drafts.panes(), ["fresh"]);
  for (const raw of ["{", "[]", "null", "\"x\""]) {
    storage.values.set(COMPOSER_DRAFT_STORAGE_KEY, raw);
    assert.deepEqual(createComposerDrafts(storage).panes(), [], raw);
  }
});

test("works without storage and when storage throws", () => {
  const memory = createComposerDrafts(null);
  assert.equal(memory.set("a", "kept in memory"), false);
  assert.equal(memory.get("a"), "kept in memory");
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("x"); } };
  const drafts = createComposerDrafts(throwing);
  assert.equal(drafts.set("a", "text"), false);
  assert.equal(drafts.get("a"), "text");
  assert.doesNotThrow(() => drafts.clear("a"));
  assert.equal(drafts.get("a"), "");
});

test("rejects unusable pane ids", () => {
  const drafts = createComposerDrafts(memoryStorage());
  assert.equal(drafts.set("", "x"), false);
  assert.equal(drafts.set(null, "x"), false);
  assert.equal(drafts.get(undefined), "");
  assert.deepEqual(drafts.panes(), []);
});

test("a draft is not written while the screen asks for a password, and is again once it does not", async () => {
  const { secretPrompt } = await import("../public/secret-prompt.js");
  const storage = memoryStorage();
  let screen = "$ sudo true\n[sudo] password for me:";
  const drafts = createComposerDrafts(storage, Date.now, () => secretPrompt(screen, 80) !== null);
  drafts.set("a", "hunter2");
  assert.equal(drafts.get("a"), "hunter2", "kept in memory for this visit");
  assert.equal(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY), false, "nothing written");
  assert.equal(createComposerDrafts(storage).get("a"), "");
  // a copy stored before the prompt appeared is removed
  screen = "$ ";
  drafts.set("a", "plain");
  assert.equal(createComposerDrafts(storage).get("a"), "plain");
  screen = "Password:";
  drafts.set("a", "plain+secret");
  assert.equal(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY), false, "the stored copy is gone");
  drafts.set("b", "other");
  screen = "$ ";
  drafts.set("b", "other pane");
  const stored = JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY));
  assert.deepEqual(Object.keys(stored), ["b"], "the secret pane's memory-only draft is still not written");
  drafts.set("a", "typed after");
  assert.equal(createComposerDrafts(storage).get("a"), "typed after");
  const throwing = createComposerDrafts(memoryStorage(), Date.now, () => { throw new Error("no screen"); });
  throwing.set("c", "x");
  assert.deepEqual(throwing.panes(), ["c"]);
});
