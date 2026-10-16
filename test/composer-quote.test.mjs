import assert from "node:assert/strict";
import test from "node:test";
import { MAX_QUOTED_CHARS, insertQuote, quoteBlock } from "../public/composer-quote.js";

test("prefixes every line and ends with a blank line", () => {
  assert.equal(quoteBlock("Error: boom\n  at x (a.js:1)"), "> Error: boom\n>   at x (a.js:1)\n\n");
  assert.equal(quoteBlock("one line"), "> one line\n\n");
});

test("drops terminal padding, keeps inner blank lines, trims trailing blank lines", () => {
  assert.equal(quoteBlock("a   \n\nb\t  \n   \n\n"), "> a\n>\n> b\n\n");
  assert.equal(quoteBlock("a\r\nb\r\n"), "> a\n> b\n\n");
  assert.equal(quoteBlock("  \n \n"), "");
  assert.equal(quoteBlock(""), "");
});

test("cuts long text with an ellipsis", () => {
  // the cap counts the quote as it goes in, "> " included
  const block = quoteBlock("x".repeat(50), 10);
  assert.equal(block, `> ${"x".repeat(7)}…\n\n`);
});

test("inserts into an empty composer", () => {
  assert.deepEqual(insertQuote("", 0, 0, "oops"), { value: "> oops\n\n", caret: 8 });
});

test("appends after existing text with a blank line between", () => {
  assert.deepEqual(insertQuote("why?", 4, 4, "oops"), { value: "why?\n\n> oops\n\n", caret: 14 });
  assert.equal(insertQuote("why?\n", 5, 5, "oops").value, "why?\n\n> oops\n\n");
  assert.equal(insertQuote("why?\n\n", 6, 6, "oops").value, "why?\n\n> oops\n\n");
});

test("inserts at a caret in the middle and puts the caret after the quote", () => {
  const result = insertQuote("before\nafter", 7, 7, "q");
  assert.equal(result.value, "before\n\n> q\n\nafter");
  assert.equal(result.caret, "before\n\n> q\n\n".length);
  assert.equal(insertQuote("ab", 1, 2, "q").value, "a\n\n> q\n\n");
  assert.equal(insertQuote("hi", undefined, undefined, "q").value, "hi\n\n> q\n\n");
});

test("refuses what would pass the limit, and empty text", () => {
  assert.equal(insertQuote("x".repeat(7995), 7995, 7995, "quote", { limit: 8000 }), null);
  assert.ok(insertQuote("x".repeat(100), 100, 100, "quote", { limit: 8000 }));
  assert.equal(insertQuote("hi", 2, 2, "  \n"), null);
  const big = insertQuote("", 0, 0, "y".repeat(9000));
  assert.ok(big.value.length <= 8000);
  assert.ok(big.value.includes("…"));
});

test("many short lines are capped as they go in, marks and all", () => {
  const text = Array.from({ length: 2000 }, () => "x").join("\n");
  const block = quoteBlock(text);
  assert.ok(block.length <= MAX_QUOTED_CHARS + 2, `quote is ${block.length} characters`);
  assert.ok(block.endsWith("…\n\n"));
  assert.ok(block.startsWith("> x\n> x"));
  assert.notEqual(insertQuote("", 0, 0, text, { limit: 8000 }), null, "it fits an empty message");
});
