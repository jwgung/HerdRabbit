import test from "node:test";
import assert from "node:assert/strict";
import {
  codeIsFilePath,
  escapeHtml,
  parseInline,
  parseMarkdown,
  renderMarkdown,
  safeMarkdownHref,
  splitFilePaths,
  webLikeHref,
} from "../public/chat/markdown.js";
import { namesPath } from "../public/path-links.js";

const html = (source, options) => renderMarkdown(source, options);

test("escapes everything the agent wrote: no tag or attribute of its own reaches the page", () => {
  const out = html('<script>alert(1)</script> <img src=x onerror="alert(2)"> & "quotes" \'single\'');
  assert.doesNotMatch(out, /<script|<img/u);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(out, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt; &amp; &quot;quotes&quot; &#39;single&#39;/u);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  // inside code, a table cell and a link label alike
  assert.doesNotMatch(html("`<b>x</b>`\n\n| <i>a</i> | b |\n| --- | --- |\n| <u>c</u> | d |\n\n[<em>x</em>](https://example.com)"), /<(?:b|i|u|em)>/u);
});

test("links keep only http(s) and mailto addresses, opened apart from the app", () => {
  assert.match(html("[docs](https://example.com/a?b=1&c=2)"),
    /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/u);
  assert.match(html("[mail](mailto:me@example.com)"), /href="mailto:me@example\.com"/u);
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "java\tscript:alert(1)"]) {
    const out = html(`[click](${bad})`);
    assert.doesNotMatch(out, /<a /u, bad);
    assert.doesNotMatch(out, /href=/u, bad);
  }
  assert.equal(safeMarkdownHref("javascript:alert(1)"), null);
  assert.equal(safeMarkdownHref("https://x.dev"), "https://x.dev");
  assert.equal(safeMarkdownHref("https://x.dev/\u0000"), null);
  // a bare address links, without the punctuation that ends the sentence
  assert.match(html("see https://x.dev/a)."), /<a href="https:\/\/x\.dev\/a"[^>]*>https:\/\/x\.dev\/a<\/a>\)\./u);
  assert.match(html("at www.example.com/x"), /href="https:\/\/www\.example\.com\/x"/u);
  assert.equal(webLikeHref("README.md:3"), null);
  assert.equal(webLikeHref("localhost:7317/"), "http://localhost:7317/");
  // an address with a quote in it cannot break out of its attribute
  assert.doesNotMatch(html('https://x.dev/"onmouseover="alert(1)'), /href="[^"]*"onmouseover/u);
});

test("code blocks are escaped, labelled, copyable, and a long one opens folded", () => {
  const out = html("```html\n<div class=\"x\">&amp;</div>\n```");
  assert.match(out, /<span>html<\/span>/u);
  assert.match(out, /data-action="copy-code"/u);
  assert.match(out, /<pre><code>&lt;div class=&quot;x&quot;&gt;&amp;amp;&lt;\/div&gt;<\/code><\/pre>/u);
  assert.doesNotMatch(out, /is-folded/u);
  const long = html(`\`\`\`\n${Array.from({ length: 31 }, (_, n) => `line ${n}`).join("\n")}\n\`\`\``);
  assert.match(long, /class="md-code is-folded"/u);
  assert.match(long, /Show all 31 lines/u);
  // an unclosed fence runs to the end, and an indented one loses its indent
  assert.equal(parseMarkdown("```\nopen")[0].value, "open");
  assert.equal(parseMarkdown("1. step\n   ```sh\n   npm test\n   ```")[1].value, "npm test");
});

test("lists: bullets, numbers from where they start, nesting and task boxes", () => {
  const out = html("- one\n- two\n  - nested\n\n3. three\n4. four\n\n- [x] done\n- [ ] open");
  assert.match(out, /<ul class="md-list"><li>one<\/li><li>two<ul class="md-list"><li>nested<\/li><\/ul><\/li><\/ul>/u);
  assert.match(out, /<ol class="md-list" start="3"><li>three<\/li><li>four<\/li><\/ol>/u);
  assert.match(out, /<li class="md-task"><span class="md-task-box is-checked" role="img" aria-label="Done"><\/span>done<\/li>/u);
  assert.match(out, /aria-label="Not done"><\/span>open/u);
});

test("tables, headings, quotes, rules and emphasis", () => {
  const out = html("# Title\n\n| a | b |\n|---|:---:|\n| **1** | 2 |\n\n> quoted\n\n---\n\n*em* and ~~gone~~ and snake_case_name");
  assert.match(out, /<h4 class="md-h1">Title<\/h4>/u);
  assert.match(out, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td><strong>1<\/strong><\/td><td>2<\/td><\/tr><\/tbody><\/table>/u);
  assert.match(out, /<blockquote><p>quoted<\/p><\/blockquote>/u);
  assert.match(out, /<hr>/u);
  assert.match(out, /<em>em<\/em> and <del>gone<\/del> and snake_case_name/u);
  // lines of one paragraph keep their breaks
  assert.match(html("first\nsecond"), /<p>first<br>second<\/p>/u);
});

test("file paths the viewer can show become buttons; others stay text", () => {
  const isLinkablePath = (path) => /\.(?:md|png)$/u.test(path);
  const out = html("Wrote docs/plan.md and src/app.mjs, see `notes/a.png` and [the report](/out/REPORT.md#L3).", { isLinkablePath });
  assert.match(out, /<button type="button" class="md-file" data-path="docs\/plan\.md" title="Open docs\/plan\.md">docs\/plan\.md<\/button>/u);
  assert.doesNotMatch(out, /data-path="src\/app\.mjs"/u);
  assert.match(out, /class="md-file is-code" data-path="notes\/a\.png"[^>]*><code>notes\/a\.png<\/code><\/button>/u);
  assert.match(out, /data-path="\/out\/REPORT\.md"[^>]*>the report<\/button>/u);
  // with nothing to open them, a file link shows its path after the label
  assert.match(html("[report](/out/REPORT.md)"), /report \(<code>\/out\/REPORT\.md<\/code>\)/u);
  // a path cannot break out of its attribute
  assert.doesNotMatch(html('`a"b/c.md`', { isLinkablePath: () => true }), /data-path="a"b/u);
  assert.deepEqual(splitFilePaths("v1.2.3 and and/or and src/x.ts"), ["v1.2.3 and and/or and ", { path: "src/x.ts" }]);
  assert.equal(codeIsFilePath("README.md"), true);
  assert.equal(codeIsFilePath("process.env"), false);
  assert.equal(codeIsFilePath("1.2.3"), false);
});

test("pathological input stays fast and bounded", () => {
  const started = Date.now();
  parseInline(`${"[".repeat(20_000)}${"_".repeat(20_000)}${"\\(".repeat(5_000)}`);
  html(">".repeat(5_000));
  html("*".repeat(20_000));
  assert.ok(Date.now() - started < 2_000);
});

test("a folder written out in full becomes a button in prose and in code", () => {
  // the page's own judge (app.js isLinkableTerminalPath) asks the same of a path's shape
  const isLinkablePath = namesPath;
  const out = html("Cloned to /home/capalace/Git/doc-viewer. Build in `./build` and `../shared/`, not `/compact` or and/or src/foo.", { isLinkablePath });
  assert.match(out, /data-path="\/home\/capalace\/Git\/doc-viewer" title="Open [^"]*">\/home\/capalace\/Git\/doc-viewer<\/button>\./u);
  assert.match(out, /class="md-file is-code" data-path="\.\/build"/u);
  assert.match(out, /class="md-file is-code" data-path="\.\.\/shared\/"/u);
  assert.doesNotMatch(out, /data-path="\/compact"/u);
  assert.doesNotMatch(out, /data-path="src\/foo"/u);
  assert.deepEqual(splitFilePaths("in ./build, /usr/bin/ and https://x.example/a/b and 12/05/2024"), ["in ", { path: "./build" }, ", ", { path: "/usr/bin/" }, " and https://x.example/a/b and 12/05/2024"]);
  assert.equal(codeIsFilePath("/home/me/proj"), true);
  assert.equal(codeIsFilePath("/compact"), false);
  assert.equal(codeIsFilePath("src/foo"), false);
});
