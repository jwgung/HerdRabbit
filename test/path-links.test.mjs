import test from "node:test";
import assert from "node:assert/strict";
import { findPaths, isFolderPath, isQuotablePath, namesPath } from "../public/path-links.js";
import { findScreenLinks } from "../public/terminal-links.js";
import { renderMarkdown } from "../public/chat/markdown.js";

// What the page links (app.js isLinkableTerminalPath, less the viewer's own
// list): a path's shape, and not `~`, whose home is another machine's.
const linkable = (raw) => namesPath(raw) && !raw.startsWith("~");

const rowsOf = (text) => text.split(/\r?\n/u).map((line) => ({ text: line, cells: [...Array(line.length + 1).keys()] }));
const terminalPaths = (text) => findScreenLinks(rowsOf(text), { isLinkablePath: linkable })
  .filter((link) => link.kind === "path").map((link) => link.target);
const unescape = (value) => value.replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
const chatPaths = (text) => [...renderMarkdown(text, { isLinkablePath: linkable }).matchAll(/data-path="([^"]*)"/gu)]
  .map((match) => unescape(match[1]));

// The same line, in the terminal and in the chat, links the same paths.
const SAME = [
  ["열기 /home/me/프로젝트 끝", ["/home/me/프로젝트"]],
  ["보고서 /home/me/문서/보고서.md 완료", ["/home/me/문서/보고서.md"]],
  ["see ./foo#bar and ./docs/a#b.md.", ["./foo#bar", "./docs/a#b.md"]],
  ['cd "/home/me/my folder" && ls', ["/home/me/my folder"]],
  ["built './build output/app.aab' ok", ["./build output/app.aab"]],
  ['path="../shared libs/x y" then', ["../shared libs/x y"]],
  ["src/a.md를 고쳤다", ["src/a.md"]],
  ['"see docs/a.md" he said', ["docs/a.md"]],
  ["on feat/settings-menu with 1/2 done, /compact and src/foo", []],
  ["open https://x.example/home/me/a.md now", []],
  ["wrote src/api.mjs and /tmp/x.aab", ["src/api.mjs", "/tmp/x.aab"]],
  ['"/compact is a command" and "/usr/bin "', ["/usr/bin"]],
  ["it's in '/tmp/a b/c.txt'.", ["/tmp/a b/c.txt"]],
  ['an "unclosed /tmp/a b quote', ["/tmp/a"]],
];

test("the terminal and the chat link the same paths in the same text", () => {
  for (const [text, expected] of SAME) {
    assert.deepEqual(terminalPaths(text), expected, `terminal: ${text}`);
    assert.deepEqual(chatPaths(text), expected, `chat: ${text}`);
  }
});

test("a quoted path is linked inside its quotes only", () => {
  const text = 'cd "/home/me/my folder" now';
  const [link] = findPaths(text, linkable);
  assert.equal(text.slice(link.start, link.end), "/home/me/my folder");
  assert.equal(isQuotablePath("/home/me/my folder"), true);
  for (const value of [" /a b", "/a b ", "see docs/a.md", "//host/a b", "~/a b"]) assert.equal(isQuotablePath(value), false, value);
  // a space is part of a folder only inside it
  assert.equal(isFolderPath("/home/me/my folder"), true);
  assert.equal(isFolderPath("/home/me/ "), false);
});

test("a code span is one path, a bare name or a quoted one; prose needs a path", () => {
  const out = renderMarkdown("see `app.js`, `/home/me/my folder` and `src/foo`, not app.js", { isLinkablePath: linkable });
  assert.deepEqual([...out.matchAll(/data-path="([^"]*)"/gu)].map((match) => match[1]), ["app.js", "/home/me/my folder"]);
});

test("a quoted path cut at the end of a full terminal row joins the next one", () => {
  // the row broke inside the name, and on the space
  for (const [first, second] of [['cd "/home/me/my fo', 'lder" now'], ['cd "/home/me/my ', 'folder" now']]) {
    const links = findScreenLinks(rowsOf(`${first}\n${second}`), { isLinkablePath: linkable });
    assert.deepEqual(links.map((link) => link.target), ["/home/me/my folder"], first);
    assert.equal(links[0].segments.length, 2);
    assert.deepEqual(links[0].segments[0], { row: 0, start: 4, end: first.length });
    assert.deepEqual(links[0].segments[1], { row: 1, start: 0, end: second.indexOf('"') });
  }
  // a row that ended in padding is not a wrap
  assert.deepEqual(terminalPaths(`echo "/home/a${" ".repeat(10)}\nb" x`), ["/home/a"]);
  // nor is an indented next row
  assert.deepEqual(terminalPaths('echo "/home/a b\n  c" x'), ["/home/a"]);
});

test("long and hostile input stays fast", () => {
  const inputs = [
    "a/".repeat(25_000),
    `"/${"a ".repeat(25_000)}`,
    "'".repeat(50_000),
    ` '/x`.repeat(12_000),
    ` "/a b"x`.repeat(7_000),
    `/${"가".repeat(50_000)}.md`,
    `/a/${"b.".repeat(25_000)}md가`,
    `x/${"가".repeat(50_000)}a`,
    `${"/".repeat(50_000)}`,
    `("${"/a b\n".repeat(10_000)}`,
  ];
  for (const text of inputs) {
    const started = Date.now();
    findPaths(text, linkable);
    findScreenLinks(rowsOf(text), { isLinkablePath: linkable });
    renderMarkdown(text, { isLinkablePath: linkable });
    assert.ok(Date.now() - started < 2_000, `${text.slice(0, 20)}… took ${Date.now() - started}ms`);
  }
});
