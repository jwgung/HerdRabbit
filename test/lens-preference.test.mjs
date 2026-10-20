import test from "node:test";
import assert from "node:assert/strict";
import {
  LENS_STORAGE_KEY,
  chatMayBecomeAvailable,
  chatReadBusy,
  chatUnavailableText,
  chooseLens,
  defaultLens,
  chatAgent,
  isClaudePane,
  readPaneLens,
  writePaneLens,
} from "../public/lens-preference.js";

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

test("a phone or touch layout opens a pane in Chat, a desktop in Terminal", () => {
  assert.equal(defaultLens({ compact: true, touch: false }), "chat");
  assert.equal(defaultLens({ compact: false, touch: true }), "chat");
  assert.equal(defaultLens({ compact: false, touch: false }), "terminal");
  assert.equal(chooseLens({ compact: true, chatAvailable: true }), "chat");
  assert.equal(chooseLens({ compact: false, chatAvailable: true }), "terminal");
});

test("the lens chosen last is remembered per pane, and wins over the default", () => {
  const storage = memoryStorage();
  assert.equal(readPaneLens(storage, "w1:p1"), null);
  assert.equal(writePaneLens(storage, "w1:p1", "terminal"), true);
  assert.equal(writePaneLens(storage, "w1:p2", "chat"), true);
  assert.equal(readPaneLens(storage, "w1:p1"), "terminal");
  assert.equal(readPaneLens(storage, "w1:p2"), "chat");
  assert.equal(chooseLens({ stored: "terminal", compact: true, chatAvailable: true }), "terminal");
  assert.equal(chooseLens({ stored: "chat", compact: false, chatAvailable: true }), "chat");
  assert.equal(writePaneLens(storage, "w1:p1", "chat"), true);
  assert.equal(readPaneLens(storage, "w1:p1"), "chat");
  assert.deepEqual(JSON.parse(storage.values.get(LENS_STORAGE_KEY)), { "w1:p2": "chat", "w1:p1": "chat" });
});

test("a pane without a chat shows its terminal, whatever was chosen", () => {
  assert.equal(chooseLens({ stored: "chat", chatAvailable: false }), "terminal");
  assert.equal(chooseLens({ compact: true, chatAvailable: false }), "terminal");
});

test("storage that fails or holds nonsense is no choice", () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); } };
  assert.equal(readPaneLens(broken, "w1:p1"), null);
  assert.equal(writePaneLens(broken, "w1:p1", "chat"), false);
  assert.equal(readPaneLens(null, "w1:p1"), null);
  assert.equal(writePaneLens(null, "w1:p1", "chat"), false);
  for (const value of ["not json", "[]", "null", '{"w1:p1":"sideways"}']) {
    assert.equal(readPaneLens(memoryStorage({ [LENS_STORAGE_KEY]: value }), "w1:p1"), null, value);
  }
  const storage = memoryStorage();
  assert.equal(writePaneLens(storage, "w1:p1", "sideways"), false);
  assert.equal(writePaneLens(storage, "", "chat"), false);
  assert.equal(writePaneLens(storage, "x".repeat(513), "chat"), false);
});

test("only so many panes are remembered; the oldest choice goes first", () => {
  const storage = memoryStorage();
  for (let n = 0; n < 205; n += 1) writePaneLens(storage, `p${n}`, "chat");
  assert.equal(readPaneLens(storage, "p0"), null);
  assert.equal(readPaneLens(storage, "p204"), "chat");
  assert.equal(Object.keys(JSON.parse(storage.values.get(LENS_STORAGE_KEY))).length, 200);
});

test("a Claude pane is known from the snapshot, and an unavailable chat says why", () => {
  assert.equal(isClaudePane({ agent: "claude" }), true);
  assert.equal(isClaudePane({ agent_session: { agent: "claude" } }), true);
  assert.equal(isClaudePane({}, { agent: "claude" }), true);
  assert.equal(isClaudePane({ agent: "codex" }, { agent: "codex" }), false);
  assert.equal(isClaudePane(undefined, undefined), false);
  assert.equal(chatUnavailableText("not_claude"), "Chat is only for Claude Code panes.");
  for (const reason of ["pane_not_found", "no_session_id", "server_unavailable", "transcript_missing", "something_new", null]) {
    assert.match(chatUnavailableText(reason), /^Chat /u);
  }
  assert.equal(chatMayBecomeAvailable("no_session_id"), true);
  assert.equal(chatMayBecomeAvailable("not_claude"), false);
  // a connected PC on an older HerdRabbit: update it there, and Chat comes once it is
  assert.match(chatUnavailableText("linked_pc_old"), /update it there/u);
  assert.equal(chatMayBecomeAvailable("linked_pc_old"), true);
  // OpenCode's database busy this time: said in the chat, not read as no conversation
  assert.equal(chatReadBusy("opencode_busy"), true);
  assert.equal(chatReadBusy("transcript_missing"), false);
  assert.match(chatUnavailableText("opencode_busy"), /busy/u);
});

test("a Codex pane has a chat too; other agents do not", () => {
  assert.equal(chatAgent({ agent: "claude" }), "claude");
  assert.equal(chatAgent({ agent: "Codex" }), "codex");
  assert.equal(chatAgent({ agent_session: { agent: "codex" } }), "codex");
  assert.equal(chatAgent({}, { agent: "codex" }), "codex");
  assert.equal(chatAgent({ agent: "gemini" }, { agent: "codex" }), null);
  assert.equal(chatAgent({ agent: "opencode" }), "opencode");
  assert.equal(chatAgent({ agent_session: { agent: "OpenCode" } }), "opencode");
  assert.equal(chatAgent(undefined, undefined), null);
  assert.equal(chatUnavailableText("not_supported_agent"), "Chat is only for Claude Code, Codex and OpenCode panes.");
  assert.match(chatUnavailableText("unsupported_opencode_version"), /OpenCode version/u);
  assert.match(chatUnavailableText("opencode_needs_newer_node"), /Node 22\.5/u);
  assert.equal(chatUnavailableText("no_session_id"), "Chat appears once the agent reports its session.");
  assert.equal(chatMayBecomeAvailable("not_supported_agent"), false);
});
