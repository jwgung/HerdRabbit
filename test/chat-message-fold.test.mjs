import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { USER_FOLD_CHARS, USER_FOLD_LINES, foldsUserMessage } from "../public/chat/chat-activity.js";

const lines = (count, text = "line") => Array.from({ length: count }, (_, n) => `${text} ${n + 1}`).join("\n");

test("a user message folds past 12 lines", () => {
  assert.equal(USER_FOLD_LINES, 12);
  assert.equal(foldsUserMessage(lines(12)), false, "12 lines show whole");
  assert.equal(foldsUserMessage(lines(13)), true, "13 lines fold");
  assert.equal(foldsUserMessage(lines(13).replace(/\n/gu, "\r\n")), true, "CRLF counts the same");
  assert.equal(foldsUserMessage(`\n\n${lines(12)}\n\n\n`), false, "blank lines at the ends do not count");
});

test("a long paste with few line breaks folds too, empty text never", () => {
  assert.equal(foldsUserMessage("x".repeat(USER_FOLD_CHARS)), false);
  assert.equal(foldsUserMessage("x".repeat(USER_FOLD_CHARS + 1)), true);
  // a link counts as its words, not its address
  assert.equal(foldsUserMessage(`[the report](https://example.com/${"a".repeat(USER_FOLD_CHARS)})`), false);
  assert.equal(foldsUserMessage(""), false);
  assert.equal(foldsUserMessage("   \n  "), false);
  assert.equal(foldsUserMessage(null), false);
});

test("the chat folds a long user turn behind Show all, drawn as text and kept open across redraws", async () => {
  const view = await readFile(new URL("../public/chat/chat-view.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/chat/chat-view.css", import.meta.url), "utf8");
  assert.match(view, /foldsUserMessage\(text\)/u);
  assert.match(view, /case "unfold-message":/u);
  assert.match(view, /"Show all"/u);
  assert.match(view, /"Show less"/u);
  assert.match(view, /openMessages/u, "an opened message stays open when its turn is drawn again");
  // the fold caps the bubble at the lines it shows, in the chat's own text size
  assert.match(styles, /\.chat-bubble\.is-capped:not\(\.is-expanded\) \.markdown \{[^}]*max-height: calc\(12 \* 1\.55em\)/u);
  assert.match(styles, /\.chat-bubble-more \{[^}]*min-height: 44px/u, "a 44px touch target");
  assert.match(styles, /\.chat-bubble-more \{[^}]*font-size: calc\(var\(--font-sm\) \* var\(--chat-scale, 1\)\)/u);
});

test("the pending bubble's clock is drawn from a fixed icon, and its words stay text", async () => {
  const view = await readFile(new URL("../public/chat/chat-view.js", import.meta.url), "utf8");
  assert.match(view, /pendingShowsClock\(item, now\)/u);
  assert.match(view, /PENDING_CLOCK_ICON/u);
  assert.match(view, /className: "chat-pending-text", text: item\.text/u, "the sent words as textContent");
});

test("find in the chat opens a folded user message to show a match", async () => {
  const find = await readFile(new URL("../public/chat/chat-find.js", import.meta.url), "utf8");
  assert.match(find, /data-action"\) === "unfold-message"/u);
});
