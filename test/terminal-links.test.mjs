import test from "node:test";
import assert from "node:assert/strict";
import { findScreenLinks } from "../public/terminal-links.js";

// Screen rows as xterm-terminal.js reads them: plain text, one cell per character here.
const rowsOf = (text) => text.split(/\r?\n/u).map((line) => ({
  text: line, cells: [...Array(line.length + 1).keys()],
}));
const targets = (text, kind, options) => findScreenLinks(rowsOf(text), options)
  .filter((link) => link.kind === kind).map((link) => link.target);
const urls = (text) => targets(text, "url");

test("links complete URLs", () => {
  assert.deepEqual(urls("Visit https://example.com/path?q=1&x=2 now"), ["https://example.com/path?q=1&x=2"]);
});

test("excludes surrounding punctuation and retains balanced URL parentheses", () => {
  assert.deepEqual(urls("(https://example.com/wiki/Test_(one)). http://localhost:3000/a, https://[::1]:8080/"), [
    "https://example.com/wiki/Test_(one)", "http://localhost:3000/a", "https://[::1]:8080/",
  ]);
});

test("keeps executable schemes, HTML, and incomplete URLs as text", () => {
  const text = 'javascript:alert(1) data:text/html,test file:///tmp/test https:// <img src=x onerror=alert(1)>';
  assert.deepEqual(findScreenLinks(rowsOf(text)), []);
});

const viewable = (raw) => /\.(?:md|png|log|mjs|js)$/u.test(raw);
const paths = (text) => [...new Set(targets(text, "path", { isViewablePath: viewable }))];

test("links the files an agent names, in the forms it names them", () => {
  // "wrote src/api.mjs" is how this gets written far more often than with a
  // leading ./, so the bare form has to count as a path.
  assert.deepEqual(paths("wrote src/api.mjs and ./docs/plan.md."), ["src/api.mjs", "./docs/plan.md"]);
  assert.deepEqual(paths("see /home/me/shot.png here"), ["/home/me/shot.png"]);
  assert.deepEqual(paths('"public/app.js" 를 고쳤다'), ["public/app.js"]);
  // A file and a line is one reference; the line number is not part of the name.
  assert.deepEqual(paths("test/ui-model.test.mjs:370 에서"), ["test/ui-model.test.mjs"]);
});

test("leaves alone the path-shaped words terminal output is full of", () => {
  // Underlining every one of these would underline half the screen. Needing a
  // name the viewer recognises is what keeps them plain.
  assert.deepEqual(paths("cd /usr/bin && ls node_modules/ build/"), []);
  assert.deepEqual(paths("README.md has no slash"), []);
  assert.deepEqual(paths("a/b/c.zip is not shown here"), []);
});

test("a URL that contains a path is still one address", () => {
  assert.deepEqual(paths("https://x.example/a.md 는 주소"), []);
  assert.deepEqual(urls("https://x.example/a.md 는 주소"), ["https://x.example/a.md"]);
});

test("finds no paths at all unless it is told what can be shown", () => {
  assert.deepEqual(targets("wrote src/api.mjs", "path"), []);
});

test("links URLs that wrap across terminal lines into one complete address", () => {
  assert.deepEqual(urls("Visit https://example.com/a/b/c/\nnextline/file.html now"),
    ["https://example.com/a/b/c/nextline/file.html"]);
  // Real terminal wrapped URL with query parameters and CR+LF
  assert.deepEqual(urls("See https://example.com/commit/12345678901234567890\r\n1234567890abcdef. Done"),
    ["https://example.com/commit/123456789012345678901234567890abcdef"]);
  // Does not merge when the URL already finished before a newline
  assert.deepEqual(urls("Visit https://example.com/\nHello world"), ["https://example.com/"]);
  assert.deepEqual(urls("(https://example.com/wiki/Test_(one)).\nOther line"), ["https://example.com/wiki/Test_(one)"]);
});

test("links file paths that wrap across terminal lines when the joined name is viewable", () => {
  assert.deepEqual(paths("wrote src/components/\nButton.js here"), ["src/components/Button.js"]);
  assert.deepEqual(
    paths("wrote src/components/very/long/path/to/my-comp\nonent.mjs."),
    ["src/components/very/long/path/to/my-component.mjs"],
  );
  // Non-viewable continuations remain plain text
  assert.deepEqual(paths("cd /usr/bin/\nls -la"), []);
});

test("finds the links on a terminal screen, an address wrapped onto the next row included", async () => {
  const { findScreenLinks } = await import("../public/terminal-links.js");
  // A row as rowText gives it: the cell each character starts in, Hangul two cells wide.
  const row = (text) => {
    const cells = [];
    let cell = 0;
    for (const char of text) { cells.push(cell); cell += /[ㄱ-힝]/u.test(char) ? 2 : 1; }
    cells.push(cell);
    return { text, cells };
  };
  const links = findScreenLinks([
    row("열기 https://example.com/a/very/long/"),
    row("path/to/page 그리고 ./docs/plan.md"),
    row("/usr/bin is not linked"),
  ], { isViewablePath: (path) => path.endsWith(".md") });
  assert.deepEqual(links, [
    { kind: "url", target: "https://example.com/a/very/long/path/to/page", segments: [{ row: 0, start: 5, end: 37 }, { row: 1, start: 0, end: 12 }] },
    { kind: "path", target: "./docs/plan.md", segments: [{ row: 1, start: 20, end: 34 }] },
  ]);
});
