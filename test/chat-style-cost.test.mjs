import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// A :has() looking at the descendants of an element that holds the chat is
// checked again over that whole subtree each time a turn is added, so an
// answer arriving cost more the longer the conversation (most on a phone).
// Over the chat's ancestors only a child :has(> ...) is allowed; anything
// further down is said with a class or attribute instead.
const CHAT_ANCESTORS = /(?:^|[\s,>+~(])(?:html|body|:root|\.terminal-panel|\.terminal-stage|\.chat-host|\.chat-scroll|\.chat-turns)(?:[.#[:][^\s,{]*)?:has\(\s*(?!>)/gmu;

function descendantHasOverChat(css) {
  const found = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const match of text.matchAll(CHAT_ANCESTORS)) {
    found.push(text.slice(match.index, text.indexOf("{", match.index)).trim());
  }
  return found;
}

test("no stylesheet has a descendant :has() over the chat's ancestors", async () => {
  for (const file of ["public/styles.css", "public/chat/chat-view.css", "public/chat/prompt-card.css", "public/chat/chat-images.css"]) {
    const css = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.deepEqual(descendantHasOverChat(css), [], `${file} restyles the page on every chat turn`);
  }
});

test("the check catches the rules that made a long chat slow, and lets child :has() through", () => {
  assert.equal(descendantHasOverChat('body:has(.terminal-panel[data-lens="chat"]) { --x: 1; }').length, 1);
  assert.equal(descendantHasOverChat(".terminal-stage:has(.terminal-find:not([hidden])) .terminal-copy-bar { top: 0; }").length, 1);
  assert.equal(descendantHasOverChat(".terminal-stage:has(> .terminal-find:not([hidden])) .terminal-copy-bar { top: 0; }").length, 0);
  assert.equal(descendantHasOverChat(".plugin-row:has(.plugin-update) { gap: 0; }").length, 0);
});

test("turns off screen are skipped until they scroll near", async () => {
  const css = await readFile(new URL("../public/chat/chat-view.css", import.meta.url), "utf8");
  const rule = /\.chat-turn\s*\{([^}]*)\}/u.exec(css.replace(/\/\*[\s\S]*?\*\//gu, ""))?.[1] ?? "";
  assert.match(rule, /content-visibility:\s*auto/u);
  assert.match(rule, /contain-intrinsic-size:\s*auto\s/u);
});
