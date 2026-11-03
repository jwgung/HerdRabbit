import test from "node:test";
import assert from "node:assert/strict";
import { markdownText } from "../public/chat/markdown.js";
import { answerCopies } from "../public/chat/copy-menu.js";

test("plain text keeps the words and drops the marks around them", () => {
  assert.equal(markdownText("# Title\n\nSome **bold**, *em*, __strong__, _it_, `code` and ~~gone~~."),
    "Title\n\nSome bold, em, strong, it, code and gone.");
  assert.equal(markdownText("### Deep **heading**"), "Deep heading");
  // a line break inside a paragraph stays one
  assert.equal(markdownText("first line\nsecond line"), "first line\nsecond line");
  assert.equal(markdownText("**nested _emphasis_ here**"), "nested emphasis here");
});

test("a link keeps its address beside its words, unless the words are the address", () => {
  assert.equal(markdownText("See [the docs](https://example.com/a?b=1)."), "See the docs (https://example.com/a?b=1).");
  assert.equal(markdownText("[mail me](mailto:me@example.com)"), "mail me (mailto:me@example.com)");
  assert.equal(markdownText("Open https://example.com/x, then <https://example.org>."), "Open https://example.com/x, then https://example.org.");
  assert.equal(markdownText("Go to www.example.com/docs"), "Go to www.example.com/docs");
  assert.equal(markdownText("[https://example.com](https://example.com)"), "https://example.com");
  assert.equal(markdownText("[**bold** label](https://example.com)"), "bold label (https://example.com)");
  // a file link: the words, and the path when they differ
  assert.equal(markdownText("Edited [the view](src/view.js)."), "Edited the view (src/view.js).");
  assert.equal(markdownText("Edited [src/view.js](src/view.js)."), "Edited src/view.js.");
  // a link to nowhere the chat follows is its words, as the chat shows it
  assert.equal(markdownText("[label](javascript:void)"), "label");
  assert.equal(markdownText("![a diagram](https://example.com/d.png)"), "a diagram");
});

test("a code block is its code, without the fence or the language", () => {
  assert.equal(markdownText("Run:\n\n```sh\nnpm run verify\nnpm test\n```\n\nDone."), "Run:\n\nnpm run verify\nnpm test\n\nDone.");
  // what looks like markdown inside code is code
  assert.equal(markdownText("```md\n# not a heading\n**not bold**\n```"), "# not a heading\n**not bold**");
  assert.equal(markdownText("Use `**x**` here"), "Use **x** here");
});

test("lists read as bullets and numbers, nested ones indented under their item", () => {
  assert.equal(markdownText("- one\n- **two**\n  - two a\n  - two b\n- three"), "• one\n• two\n  • two a\n  • two b\n• three");
  assert.equal(markdownText("1. first\n2. second"), "1. first\n2. second");
  assert.equal(markdownText("3. third\n4. fourth"), "3. third\n4. fourth");
  assert.equal(markdownText("- [x] done\n- [ ] to do"), "☑ done\n☐ to do");
  assert.equal(markdownText("1. step\n   - detail"), "1. step\n   • detail");
});

test("a table reads as rows of cells split by tabs", () => {
  assert.equal(markdownText("| Name | Size |\n| --- | ---: |\n| **a.js** | 12 |\n| [b](https://b.example) | 3 |"),
    "Name\tSize\na.js\t12\nb (https://b.example)\t3");
  assert.equal(markdownText("Before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter"), "Before\n\na\tb\n1\t2\n\nAfter");
});

test("quotes lose their marks, a rule disappears, and math stays as the chat shows it", () => {
  assert.equal(markdownText("> quoted **words**\n> more"), "quoted words\nmore");
  assert.equal(markdownText("above\n\n---\n\nbelow"), "above\n\nbelow");
  assert.equal(markdownText("Area is \\(r^2\\)."), "Area is \\(r^2\\).");
  assert.equal(markdownText("\\[ e = mc^2 \\]"), "\\[e = mc^2\\]");
});

test("plain text of nothing is nothing, and line endings are the reader's", () => {
  assert.equal(markdownText(""), "");
  assert.equal(markdownText("a\r\n\r\nb"), "a\n\nb");
});

test("an answer is copied as its markdown or as plain text, Markdown first", () => {
  const source = "**Done.** See [docs](https://example.com).";
  assert.deepEqual(answerCopies(source), [
    { format: "markdown", label: "Copy as Markdown", text: source },
    { format: "text", label: "Copy as text", text: "Done. See docs (https://example.com)." },
  ]);
});
