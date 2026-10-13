import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DRAFT_TTL_MS,
  MAX_DRAFT_LENGTH,
  MAX_DRAFT_PANES,
  createComposerDrafts,
  draftScreenIsSecret,
  draftScreenShowsPrompt,
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

test("clearing (a message was sent) leaves nothing stored", () => {
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

test("a text judged secret stays out of storage while it is unchanged, whatever the screen shows later", () => {
  const storage = memoryStorage();
  let secret = true;
  const drafts = createComposerDrafts(storage, Date.now, () => secret);
  drafts.set("a", "hunter2");
  secret = false; // the prompt left the screen
  drafts.set("a", "hunter2");
  drafts.set("a", "hunter2");
  assert.equal(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY), false, "still not written");
  assert.equal(drafts.get("a"), "hunter2");
  drafts.set("a", "hunter2!");
  assert.equal(createComposerDrafts(storage).get("a"), "hunter2!", "a changed text is judged again");
  secret = true;
  drafts.set("a", "again");
  secret = false;
  drafts.clear("a");
  drafts.set("a", "again");
  assert.equal(createComposerDrafts(storage).get("a"), "again", "cleared, then typed anew, is judged anew");
  assert.equal(drafts.set("b", "forced", { memoryOnly: true }), true);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY))), ["a"], "a forced memory-only draft is not written");
  assert.equal(drafts.get("b"), "forced");
});

test("sign-out removes every draft from memory and storage", () => {
  const storage = memoryStorage();
  const drafts = createComposerDrafts(storage);
  drafts.set("a", "one");
  drafts.set("b", "two", { memoryOnly: true });
  drafts.clearAll();
  assert.deepEqual(drafts.panes(), []);
  assert.equal(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY), false);
  assert.equal(createComposerDrafts(storage).get("a"), "");
});

test("the screen check fails closed unless it is the pane's own, drawn, current screen without a prompt", () => {
  const ok = { paneId: "a", text: "$ ", cols: 80, fresh: true };
  assert.equal(draftScreenIsSecret("a", "a", ok), false);
  assert.equal(draftScreenIsSecret("a", "a", { ...ok, text: "[sudo] password for me:" }), true, "a prompt");
  assert.equal(draftScreenIsSecret("a", "a", { ...ok, paneId: "b" }), true, "another pane's screen");
  assert.equal(draftScreenIsSecret("a", "a", { ...ok, paneId: null }), true, "no pane shown");
  assert.equal(draftScreenIsSecret("a", "a", { ...ok, fresh: false }), true, "no term, parked, first frame not drawn or a held frame");
  assert.equal(draftScreenIsSecret("a", "b", ok), true, "the draft is not the pane on show");
  assert.equal(draftScreenIsSecret("a", "a", null), true);
  assert.equal(draftScreenIsSecret(null, null, ok), true);
});

test("a text stored as fine is not pulled out by a later unreadable or prompting screen while unchanged", () => {
  const storage = memoryStorage();
  let secret = false;
  const drafts = createComposerDrafts(storage, Date.now, () => secret);
  drafts.set("a", "fine text");
  secret = true; // the page is unloading, or a prompt appeared
  drafts.set("a", "fine text");
  assert.equal(createComposerDrafts(storage).get("a"), "fine text");
  drafts.set("a", "fine text and a password");
  assert.equal(createComposerDrafts(storage).get("a"), "", "changed under a prompt: not written, old copy gone");
});

test("a text typed ahead of a password prompt is taken out of storage once a verified screen shows the prompt", () => {
  const storage = memoryStorage();
  let prompt = false;
  let verified = true;
  const drafts = createComposerDrafts(storage, () => 1_000, () => false, () => verified && prompt);
  drafts.set("w1:p1", "hunter2");
  assert.match(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "", /hunter2/u, "no prompt yet: a fine draft is kept");
  // the screen cannot be read (the page unloading): the fine verdict stands
  verified = false;
  prompt = true;
  drafts.set("w1:p1", "hunter2");
  assert.match(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "", /hunter2/u);
  // a verified screen shows the prompt now: the unchanged text becomes secret
  verified = true;
  drafts.set("w1:p1", "hunter2");
  assert.doesNotMatch(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "", /hunter2/u);
  assert.equal(drafts.get("w1:p1"), "hunter2", "kept in memory");
  // and stays secret once the prompt is gone, while unchanged
  prompt = false;
  drafts.set("w1:p1", "hunter2");
  assert.doesNotMatch(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "", /hunter2/u);
});

test("only a shown, fresh screen with a password prompt counts as showing one", () => {
  const screen = (extra = {}) => ({ paneId: "w1:p1", text: "[sudo] password for me:", cols: 80, fresh: true, ...extra });
  assert.equal(draftScreenShowsPrompt("w1:p1", "w1:p1", screen()), true);
  assert.equal(draftScreenShowsPrompt("w1:p1", "w1:p1", screen({ fresh: false })), false);
  assert.equal(draftScreenShowsPrompt("w1:p1", "w1:p2", screen()), false);
  assert.equal(draftScreenShowsPrompt("w1:p1", "w1:p1", screen({ text: "$ ls" })), false);
});
