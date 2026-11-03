import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../public/chat/markdown.js";
import { foldsUserMessage, USER_FOLD_CHARS, USER_FOLD_LINES } from "../public/chat/chat-activity.js";

// The fold numbers the README states.
test("a user message folds past 12 lines or 900 characters", () => {
  assert.equal(USER_FOLD_LINES, 12);
  assert.equal(USER_FOLD_CHARS, 900);
  assert.equal(foldsUserMessage("x".repeat(900)), false);
  assert.equal(foldsUserMessage("x".repeat(901)), true);
});

// A code block folds only past 30 lines, and then shows 20.
test("a code block of 30 lines stays open and one of 31 folds", () => {
  const block = (lines) => "```js\n" + Array.from({ length: lines }, (_, n) => `line${n}`).join("\n") + "\n```";
  assert.doesNotMatch(renderMarkdown(block(30)), /is-folded/u);
  assert.match(renderMarkdown(block(31)), /is-folded/u);
  assert.match(renderMarkdown(block(31)), /Show all 31 lines/u);
});

// The inline markers' lazy patterns stay linear on what an agent might write.
test("long runs of inline markers render quickly", () => {
  for (const unit of ["_a", "__a", "*a ", "\\(", "[a](", "`a", "~~a"]) {
    const text = unit.repeat(Math.ceil(40_000 / unit.length));
    const started = performance.now();
    renderMarkdown(text);
    const took = performance.now() - started;
    assert.ok(took < 1_000, `${JSON.stringify(unit)} took ${Math.round(took)} ms`);
  }
});
