import test from "node:test";
import assert from "node:assert/strict";
import { answerBody, bannerText, cardVersion, dockMode, initialSelection, optionLabel, shouldWatchPrompt } from "../public/chat/prompt-card.js";
import { comparableText, formatElapsed, pendingMessage, settlePending, showsWorking, workingText } from "../public/chat/chat-activity.js";
import {
  CHAT_FONT_SIZE_STORAGE_KEY, DEFAULT_CHAT_FONT_SIZE, MAX_CHAT_FONT_SIZE, MIN_CHAT_FONT_SIZE,
  adjustedChatFontSize, chatScale, pinchedChatFontSize, readChatFontSize, writeChatFontSize,
} from "../public/chat-font-preference.js";
import { TERMINAL_FONT_SIZE_STORAGE_KEY } from "../public/terminal-preference.js";

const card = { id: "abc123def456", agent: "claude", title: "Bash command", options: [{ label: "Yes" }, { label: "No" }], customOptionIndex: null };

test("a Claude or Codex pane is watched for a card whatever its status; other panes only while blocked", () => {
  for (const agent of ["claude", "codex"]) {
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
  assert.equal(workingText(null, now, "gemini"), "The agent is working");
});

test("a pending message waits until the transcript says it once more, or 30 s", () => {
  const user = (text) => ({ role: "user", parts: [{ kind: "text", text }] });
  const turns = [user("run the tests"), { role: "assistant", parts: [] }];
  const now = 5_000;
  const again = pendingMessage("run the  tests\n", turns, now);
  assert.equal(again.baseline, 1);
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
  assert.match(source, /if \(card && card\.id !== answered\.id\) \{[^}]*view\.pending = false;[^}]*view\.selected = initialSelection\(card\);/su);
  const success = source.slice(source.indexOf("if (card && card.id !== answered.id)"));
  assert.ok(success.indexOf("return;") < success.indexOf("setCard(null);"), "the next prompt is kept, not cleared");
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
