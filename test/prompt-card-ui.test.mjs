import test from "node:test";
import assert from "node:assert/strict";
import { answerBody, bannerText, cardVersion, contextKey, contextVisible, dockMode, initialSelection, optionLabel, shouldWatchPrompt } from "../public/chat/prompt-card.js";
import { comparableText, formatElapsed, pendingMessage, settlePending, showsWorking, workingText } from "../public/chat/chat-activity.js";
import {
  CHAT_FONT_SIZE_STORAGE_KEY, DEFAULT_CHAT_FONT_SIZE, MAX_CHAT_FONT_SIZE, MIN_CHAT_FONT_SIZE,
  adjustedChatFontSize, chatScale, pinchedChatFontSize, readChatFontSize, writeChatFontSize,
} from "../public/chat-font-preference.js";
import { TERMINAL_FONT_SIZE_STORAGE_KEY } from "../public/terminal-preference.js";

const card = { id: "abc123def456", agent: "claude", title: "Bash command", options: [{ label: "Yes" }, { label: "No" }], customOptionIndex: null };

test("a Claude, Codex, OpenCode or Kiro pane is watched for a card whatever its status; other panes only while blocked", () => {
  for (const agent of ["claude", "codex", "opencode", "kiro"]) {
    for (const status of ["blocked", "idle", "working", "done", "unknown", null]) assert.equal(shouldWatchPrompt(status, agent), true);
  }
  for (const agent of [null, "gemini", "unknown"]) {
    assert.equal(shouldWatchPrompt("blocked", agent), true);
    for (const status of ["idle", "working", "done", "unknown", null]) assert.equal(shouldWatchPrompt(status, agent), false);
  }
  assert.equal(shouldWatchPrompt("blocked"), true);
  assert.equal(shouldWatchPrompt("working"), false);
});

test("an answer names the card and exactly one choice", () => {
  assert.deepEqual(answerBody(card, { option: 1 }), { cardId: card.id, option: 1 });
  assert.deepEqual(answerBody(card, { options: [2, 0] }), { cardId: card.id, options: [0, 2] });
  assert.deepEqual(answerBody(card, { text: "  use HOPE " }), { cardId: card.id, text: "use HOPE" });
  assert.deepEqual(answerBody(card, { action: "chat" }), { cardId: card.id, action: "chat" });
});

test("a question's context shows until the chat's last agent turns have its first line of words", () => {
  const context = "┌──────┬──────┐\n│ Store │ Stale │\n└──────┴──────┘\n\nThe **cache** audit is done. Two stores still disagree:\nmore";
  const asked = { ...card, kind: "question", context };
  // the table's borders are no words, and its short header row is passed over (under 12 characters)
  assert.equal(contextKey(context), "The cache audit is done. Two stores still disagree:");
  assert.equal(contextKey("┌──┐\n│ a │\n\n- The cache audit is done. Two stores still disagree"), "The cache audit is done. Two stores still disagree");
  assert.equal(contextKey("ok\n──────"), null);
  assert.equal(contextVisible(asked, ""), true, "nothing loaded: shown");
  assert.equal(contextVisible(asked, "An earlier answer."), true);
  // the transcript caught up: the same words, written in Markdown
  const caught = { ...asked, context: "The cache audit is done. Two stores still disagree:\n\n┌───┐" };
  assert.equal(contextVisible(caught, "Earlier.\n\nThe **cache audit** is done.  Two stores still `disagree`:\n\n| Store | Stale |"), false);
  assert.equal(contextVisible(caught, "The cache audit is done."), true, "a part of the line is not the message");
  // no context, or one too short to tell
  assert.equal(contextVisible(card, ""), false);
  assert.equal(contextVisible({ ...card, context: "  " }, ""), false);
  assert.equal(contextVisible({ ...card, context: "ok" }, "ok"), true);
});

test("a multiple choice starts from the ticks the terminal shows, and other ticks are another card", () => {
  const choice = { id: "c1", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }], checked: [0, 2], customOptionIndex: null };
  assert.deepEqual([...initialSelection(choice)], [0, 2]);
  // untouched, the answer keeps the ticks as they are
  assert.deepEqual(answerBody(choice, { options: [...initialSelection(choice)] }), { cardId: "c1", options: [0, 2] });
  assert.deepEqual([...initialSelection({ ...choice, checked: [5, -1, "x", 1] })], [1]);
  assert.deepEqual([...initialSelection({ ...choice, checked: undefined })], []);
  assert.deepEqual([...initialSelection({ ...card, checked: [0] })], []);
  assert.deepEqual([...initialSelection(null)], []);
  assert.notEqual(cardVersion(choice), cardVersion({ ...choice, checked: [0] }));
  assert.equal(cardVersion(choice), cardVersion({ ...choice }));
  assert.equal(cardVersion(null), null);
});

test("Claude's (Recommended) suffix becomes a tag", () => {
  assert.deepEqual(optionLabel("Redis (Recommended)"), { text: "Redis", recommended: true });
  assert.deepEqual(optionLabel("Yes"), { text: "Yes", recommended: false });
});

test("the dock shows the card in the Chat lens, a banner over the terminal, the card again when opened there", () => {
  assert.equal(dockMode({ card: null, lens: "chat" }), "hidden");
  assert.equal(dockMode({ card, lens: "chat" }), "card");
  assert.equal(dockMode({ card, lens: "chat", dismissed: true }), "card");
  assert.equal(dockMode({ card, lens: "terminal" }), "banner");
  assert.equal(dockMode({ card, lens: "terminal", dismissed: true }), "hidden");
  assert.equal(dockMode({ card, lens: "terminal", expanded: true }), "overlay");
  assert.equal(bannerText(card), "Claude is asking: Bash command");
  assert.equal(bannerText({ ...card, agent: "codex", title: "Would you like to run the following command?" }), "Codex is asking: Would you like to run the following command?");
  assert.equal(bannerText({ ...card, agent: "kiro", title: "Run this command?" }), "Kiro is asking: Run this command?");
  assert.equal(bannerText({ ...card, fallback: true }), "This pane is waiting for input");
});

test("the working row shows while the agent works, or briefly after a send, never over a card", () => {
  const now = 1_000_000;
  assert.equal(showsWorking({ status: "working", now }), true);
  assert.equal(showsWorking({ status: "idle", now }), false);
  assert.equal(showsWorking({ status: "idle", optimisticUntil: now + 1, now }), true);
  assert.equal(showsWorking({ status: "done", optimisticUntil: now - 1, now }), false);
  assert.equal(showsWorking({ status: "blocked", optimisticUntil: now + 1, now }), false);
  assert.equal(formatElapsed(12_400), "12s");
  assert.equal(formatElapsed(72_000), "1m 12s");
  assert.equal(formatElapsed(3_780_000), "1h 3m");
  assert.equal(workingText(now - 72_000, now), "Claude is working · 1m 12s");
  assert.equal(workingText(null, now), "Claude is working");
  assert.equal(workingText(now - 5_000, now, "codex"), "Codex is working · 5s");
  assert.equal(workingText(now - 5_000, now, "opencode"), "OpenCode is working · 5s");
  assert.equal(workingText(now - 5_000, now, "kiro"), "Kiro is working · 5s");
  assert.equal(workingText(null, now, "gemini"), "The agent is working");
});

test("a pending message waits until the transcript says it once more, or 30 s", () => {
  const user = (text) => ({ role: "user", parts: [{ kind: "text", text }] });
  const turns = [user("run the tests"), { role: "assistant", parts: [] }];
  const now = 5_000;
  const again = pendingMessage("run the  tests\n", turns, now);
  assert.equal(again.baseline, 1);
  assert.equal(again.ahead, 0);
  assert.equal(comparableText(" a\n b "), "a b");
  assert.deepEqual(settlePending([again], turns, now + 10), [again]);
  assert.deepEqual(settlePending([again], [...turns, user("run the tests")], now + 10), []);
  assert.deepEqual(settlePending([again], turns, now + 30_001), []);
});

test("the chat's text size is its own, remembered and bounded", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readChatFontSize(storage), DEFAULT_CHAT_FONT_SIZE);
  assert.equal(writeChatFontSize(storage, 17), true);
  assert.equal(values.get(CHAT_FONT_SIZE_STORAGE_KEY), "17");
  assert.notEqual(CHAT_FONT_SIZE_STORAGE_KEY, TERMINAL_FONT_SIZE_STORAGE_KEY);
  assert.equal(readChatFontSize(storage), 17);
  values.set(CHAT_FONT_SIZE_STORAGE_KEY, "99");
  assert.equal(readChatFontSize(storage), MAX_CHAT_FONT_SIZE);
  values.set(CHAT_FONT_SIZE_STORAGE_KEY, "abc");
  assert.equal(readChatFontSize(storage), DEFAULT_CHAT_FONT_SIZE);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readChatFontSize(broken), DEFAULT_CHAT_FONT_SIZE);
  assert.equal(writeChatFontSize(broken, 16), false);
  assert.equal(adjustedChatFontSize(MAX_CHAT_FONT_SIZE, "larger"), MAX_CHAT_FONT_SIZE);
  assert.equal(adjustedChatFontSize(MIN_CHAT_FONT_SIZE, "smaller"), MIN_CHAT_FONT_SIZE);
  assert.equal(adjustedChatFontSize(14, "larger"), 15);
  assert.equal(pinchedChatFontSize(14, 100, 150), 21);
  assert.equal(pinchedChatFontSize(14, 100, 10), MIN_CHAT_FONT_SIZE);
  assert.equal(pinchedChatFontSize(14, 0, 10), 14);
  assert.equal(chatScale(21), 1.5);
});

test("an answer that lands after the next prompt arrived keeps that prompt on show", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../public/chat/prompt-card.js", import.meta.url), "utf8");
  const kept = "if (result?.stays || (card && card.id !== answered.id)) {";
  assert.ok(source.includes(kept));
  const success = source.slice(source.indexOf(kept));
  assert.match(success, /^[^}]*view\.pending = false;[^}]*view\.selected = initialSelection\(card\);/su);
  assert.ok(success.indexOf("return;") < success.indexOf("setCard(null);"), "the next prompt is kept, not cleared");
});

// Review of #109: Kiro's Change scope leaves the menu up; the card is not
// cleared, and a look brings the changed one.
test("an answer the server says leaves the menu up keeps the card and looks again", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../public/chat/prompt-card.js", import.meta.url), "utf8");
  assert.match(source, /const result = await postJson\(/u);
  assert.match(source, /if \(result\?\.stays && card\?\.id === answered\.id\) \{\s*keepOpen = true;\s*void refresh\(\);\s*\}\s*return;/u);
  // the changed card that comes stays open as the answered one was
  assert.match(source, /if \(moved && !\(keepOpen && card\)\) expanded = false;\s*\}\s*if \(moved\) keepOpen = false;/u);
});

test("a dismissed banner comes back when the same prompt is asked again, and a refused watch is asked for again", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../public/chat/prompt-card.js", import.meta.url), "utf8");
  assert.match(source, /if \(moved && card\) dismissed\.delete\(card\.id\);/u);
  assert.match(source, /watch\(null\);\s*clearTimeout\(rewatchTimer\);\s*rewatchTimer = setTimeout\(/u);
  assert.match(source, /if \(id === paneId && watched === null && shouldWatchPrompt\(status, agentName\)\) watch\(id\);/u);
});

test("the page tells the prompt dock which agent the pane runs, so Claude and Codex panes are watched at any status", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /promptDock\?\.select\(paneId, \{ agent: chatAgent\(pane, agent\), status: agentStatus\(agent, pane\) \}\);/u);
  assert.match(app, /import \{ chatAgent \} from "\.\/lens-preference\.js/u);
});

// The working row counts from when the agent's turn began, as the agent's own
// screen does (Kiro's "Kiro is working · 16m 9s"), not from when this page
// first saw it working: a page opened mid-turn, or a status that flickered,
// showed a few seconds where the terminal showed minutes (2026-11-01).
import { workingSince } from "../public/chat/chat-activity.js";

test("the working row counts from the prompt that began the turn, not a message sent while it worked", () => {
  const now = Date.parse("2026-11-01T01:51:00.000Z");
  const turns = [
    { role: "user", ts: "2026-11-01T01:30:00.000Z", parts: [{ kind: "text", text: "earlier" }] },
    { role: "assistant", ts: "2026-11-01T01:30:02.000Z", parts: [{ kind: "text", text: "done" }] },
    { role: "user", ts: "2026-11-01T01:34:51.000Z", parts: [{ kind: "text", text: "fix it" }] },
    { role: "assistant", ts: "2026-11-01T01:34:55.000Z", parts: [{ kind: "text", text: "on it" }] },
    { role: "user", ts: "2026-11-01T01:45:00.000Z", queued: true, parts: [{ kind: "text", text: "also this" }] },
    { role: "assistant", ts: "2026-11-01T01:45:03.000Z", parts: [{ kind: "text", text: "noted" }] },
  ];
  assert.equal(workingSince({ turns, seen: now - 26_000, now }), Date.parse("2026-11-01T01:34:51.000Z"));
});

test("the working row keeps what the page saw when the transcript cannot say", () => {
  const now = Date.parse("2026-11-01T01:51:00.000Z");
  const seen = now - 5_000;
  const prompt = (ts) => [{ role: "user", ts, parts: [{ kind: "text", text: "go" }] }];
  // no turns, a prompt without a time, or with a time not read
  assert.equal(workingSince({ turns: [], seen, now }), seen);
  assert.equal(workingSince({ turns: prompt(null), seen, now }), seen);
  assert.equal(workingSince({ turns: prompt("yesterday"), seen, now }), seen);
  // a prompt the page saw the agent go idle after belongs to a turn that ended
  assert.equal(workingSince({ turns: prompt("2026-11-01T01:40:00.000Z"), seen, now, idleAt: now - 60_000 }), seen);
  // a message just sent from here, not yet in the transcript: its own send time
  assert.equal(workingSince({ turns: prompt("2026-11-01T01:40:00.000Z"), seen, now, sending: true }), seen);
  // a prompt timed ahead of this device's clock counts from now, never ahead
  assert.equal(workingSince({ turns: prompt("2026-11-01T01:51:03.000Z"), seen, now }), now);
  // a notice or a compaction is no prompt
  const notice = [{ role: "user", ts: "2026-11-01T01:20:00.000Z", parts: [{ kind: "text", text: "go" }] },
    { role: "user", ts: "2026-11-01T01:50:00.000Z", parts: [{ kind: "notice", text: "ran /status" }] }];
  assert.equal(workingSince({ turns: notice, seen, now }), Date.parse("2026-11-01T01:20:00.000Z"));
  assert.equal(workingSince({ turns: prompt("2026-11-01T01:40:00.000Z"), seen: null, now }), Date.parse("2026-11-01T01:40:00.000Z"));
});

test("the working row leaves out the time the turn waited on the agent's question", () => {
  const now = Date.parse("2026-11-01T02:00:00.000Z");
  const turns = [{ role: "user", ts: "2026-11-01T00:00:00.000Z", pausedMs: 90 * 60_000, parts: [{ kind: "text", text: "go" }] }];
  assert.equal(formatElapsed(now - workingSince({ turns, seen: null, now })), "30m 0s");
});
