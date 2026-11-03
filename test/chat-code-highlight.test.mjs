import test from "node:test";
import assert from "node:assert/strict";
import { codeLanguage, codeTokens, highlightCode, highlightCodeBlocks, MAX_HIGHLIGHT_CHARS } from "../public/chat/code-highlight.js";
import { renderMarkdown } from "../public/chat/markdown.js";

// [kind, text] for the marked tokens only: what a reader sees coloured.
const marked = (code, language) => codeTokens(code, language).filter((token) => token.kind !== null).map((token) => [token.kind, token.text]);
const joined = (tokens) => tokens.map((token) => token.text).join("");

test("a fence's language names one of the few the chat colours, by its usual names", () => {
  for (const name of ["js", "JavaScript", "jsx", "mjs", "cjs", "ts", "tsx", "typescript"]) assert.equal(codeLanguage(name), "javascript", name);
  for (const name of ["py", "python"]) assert.equal(codeLanguage(name), "python");
  for (const name of ["sh", "bash", "zsh", "shell"]) assert.equal(codeLanguage(name), "shell");
  for (const name of ["json", "jsonc"]) assert.equal(codeLanguage(name), "json");
  assert.equal(codeLanguage("css"), "css");
  for (const name of ["diff", "patch"]) assert.equal(codeLanguage(name), "diff");
  for (const name of ["", "text", "html", "rust", "constructor", "__proto__", undefined]) assert.equal(codeLanguage(name), null, String(name));
});

test("the tokens are the code itself, cut up: nothing added, dropped or moved", () => {
  const samples = {
    js: "const a = `x\n${b}` + 'c\\'d' // note\n/* block\n */ if (a) return 0x1F;\n",
    py: "def f(x):\n    \"\"\"doc\n    more\"\"\"\n    return f'{x}' # c\n",
    sh: "for f in *.txt; do echo \"$f\" # loop\ndone\nurl=a#b\n",
    json: '{"a": [1, -2.5e3, true, null], "b": "\\"q\\""}',
    css: "@media (max-width: 760px) { .a::before { content: \"/*\"; margin: -4px; color: #fff; } } /* end",
    diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n",
  };
  for (const [language, code] of Object.entries(samples)) assert.equal(joined(codeTokens(code, language)), code, language);
  // any text at all, in every language: unclosed strings and comments included
  const alphabet = ["a", "if", " ", "\n", "\"", "'", "`", "\\", "/", "*", "#", "-", "+", "@", "1", ".", "$", "{", "}", "<script>", "é", "😀"];
  let seed = 7;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  for (let round = 0; round < 300; round += 1) {
    const code = Array.from({ length: next() % 40 }, () => alphabet[next() % alphabet.length]).join("");
    for (const language of ["js", "py", "sh", "json", "css", "diff"]) assert.equal(joined(codeTokens(code, language)), code, `${language}: ${JSON.stringify(code)}`);
  }
});

test("JavaScript and TypeScript: keywords, strings, comments and numbers", () => {
  assert.deepEqual(marked("const x = 'a'; // hi", "js"), [["keyword", "const"], ["string", "'a'"], ["comment", "// hi"]]);
  assert.deepEqual(marked("return `one\ntwo` /* c\nd */ 42", "ts"), [["keyword", "return"], ["string", "`one\ntwo`"], ["comment", "/* c\nd */"], ["number", "42"]]);
  assert.deepEqual(marked("interface A { b: number }", "ts"), [["keyword", "interface"]]);
  // a word that holds a keyword, or a number inside a name, is plain
  assert.deepEqual(marked("constant iffy x1 $if", "js"), []);
  // digits run into a name are no number
  assert.deepEqual(marked("1a 0x1Fz 2n 3", "js"), [["number", "2n"], ["number", "3"]]);
  assert.deepEqual(marked('"open', "js"), [["string", '"open']], "an unclosed string runs to the line's end");
  assert.deepEqual(marked('"a\nb"', "js"), [["string", '"a'], ["string", '"']], "a quoted string stops at its line's end");
});

test("Python: its comments, triple-quoted and prefixed strings, and keywords", () => {
  assert.deepEqual(marked("def f(): # c", "py"), [["keyword", "def"], ["comment", "# c"]]);
  assert.deepEqual(marked('x = """a\nb""" + rb\'c\' + f"{y}"', "py"), [["string", '"""a\nb"""'], ["string", "rb'c'"], ["string", 'f"{y}"']]);
  assert.deepEqual(marked("if x is None: pass", "py"), [["keyword", "if"], ["keyword", "is"], ["keyword", "None"], ["keyword", "pass"]]);
  assert.deepEqual(marked("bar'x'", "py"), [["string", "'x'"]], "a name before a quote is no prefix");
});

test("shell: a comment starts a word, quotes and keywords", () => {
  assert.deepEqual(marked("if [ -f a ]; then echo 'x' # y\nfi", "sh"), [["keyword", "if"], ["keyword", "then"], ["string", "'x'"], ["comment", "# y"], ["keyword", "fi"]]);
  assert.deepEqual(marked("curl a#b ${#arr}", "sh"), [], "a # inside a word is no comment");
  assert.deepEqual(marked("npm --if-present --in x", "sh"), [], "a flag holding a keyword is plain");
  assert.deepEqual(marked('echo "a \\" b"', "sh"), [["string", '"a \\" b"']]);
});

test("JSON, CSS and diff", () => {
  assert.deepEqual(marked('{"a": -1.5, "b": [true, null]}', "json"), [["string", '"a"'], ["number", "-1.5"], ["string", '"b"'], ["keyword", "true"], ["keyword", "null"]]);
  assert.deepEqual(marked("@media x { a { margin: 4px; color: #fff; } } /* c */", "css"),
    [["keyword", "@media"], ["number", "4px"], ["number", "#fff"], ["comment", "/* c */"]]);
  assert.deepEqual(marked("h1 { content: 'x' }", "css"), [["string", "'x'"]]);
  assert.deepEqual(marked("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same", "diff"),
    [["meta", "--- a/x"], ["meta", "+++ b/x"], ["meta", "@@ -1 +1 @@"], ["del", "-old"], ["add", "+new"]]);
});

test("a language the chat does not colour, or code too long to colour cheaply, has no tokens", () => {
  assert.equal(codeTokens("x", "rust"), null);
  assert.equal(codeTokens("x", ""), null);
  assert.equal(codeTokens("a".repeat(MAX_HIGHLIGHT_CHARS + 1), "js"), null);
  assert.notEqual(codeTokens("a".repeat(MAX_HIGHLIGHT_CHARS), "js"), null);
  // a long unclosed comment or string, or a digit run, is read once, not once per character
  const started = Date.now();
  codeTokens(`/*${"a".repeat(MAX_HIGHLIGHT_CHARS - 2)}`, "js");
  codeTokens(`"""${"a\n".repeat((MAX_HIGHLIGHT_CHARS - 3) / 2)}`, "py");
  codeTokens(`"${"\\".repeat(MAX_HIGHLIGHT_CHARS - 1)}`, "sh");
  for (const language of ["js", "py", "json", "css"]) codeTokens(`${"1".repeat(MAX_HIGHLIGHT_CHARS - 1)}a`, language);
  assert.deepEqual(marked(`${"1".repeat(50)}a`, "py"), []);
  assert.ok(Date.now() - started < 1000, "tokenizing stays linear");
});

// Just enough of a DOM to see what the highlighter builds: nodes made by
// createElement and createTextNode, and no innerHTML anywhere.
function fakeDocument() {
  const node = (props) => ({
    ...props,
    children: [],
    replaceChildren(...nodes) { this.text = undefined; this.children = nodes; },
    get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(""); },
    set textContent(value) { this.text = String(value); this.children = []; },
    set innerHTML(_value) { throw new Error("innerHTML is never set"); },
  });
  return {
    createElement: (tag) => node({ tag }),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  };
}

test("a code element is rebuilt as text and spans, its text unchanged and never parsed as markup", () => {
  const document = fakeDocument();
  const code = document.createElement("code");
  code.textContent = 'const a = "<img src=x onerror=alert(1)>"; // <b>';
  assert.equal(highlightCode(code, "js", document), true);
  assert.equal(code.textContent, 'const a = "<img src=x onerror=alert(1)>"; // <b>');
  const spans = code.children.filter((child) => child.tag === "span");
  assert.deepEqual(spans.map((span) => [span.className, span.textContent]),
    [["md-tok is-keyword", "const"], ["md-tok is-string", '"<img src=x onerror=alert(1)>"'], ["md-tok is-comment", "// <b>"]]);
  // plain text between tokens is one text node each
  assert.ok(code.children.every((child) => child.tag === "span" || child.nodeType === 3));
  const plain = document.createElement("code");
  plain.textContent = "fn main() {}";
  assert.equal(highlightCode(plain, "rust", document), false, "an unknown language is left as it is");
  assert.equal(plain.text, "fn main() {}");
});

test("highlightCodeBlocks colours each drawn block by the language its fence named", () => {
  const document = fakeDocument();
  const codes = [document.createElement("code"), document.createElement("code")];
  codes[0].textContent = "let x";
  codes[1].textContent = "let x";
  const blocks = [
    { dataset: { language: "js" }, querySelector: () => codes[0] },
    { dataset: { language: "text" }, querySelector: () => codes[1] },
  ];
  const root = { ownerDocument: document, querySelectorAll: (selector) => (selector === ".md-code[data-language]" ? blocks : []) };
  highlightCodeBlocks(root);
  assert.equal(codes[0].children[0].className, "md-tok is-keyword");
  assert.equal(codes[1].text, "let x");
});

test("the markdown names a code block's language for the highlighter, escaped", () => {
  assert.match(renderMarkdown("```js\nx\n```"), /<div class="md-code" data-language="js">/u);
  assert.match(renderMarkdown('```j"s<x\nx\n```'), /data-language="j&quot;s&lt;x"/u);
  assert.match(renderMarkdown("```\nx\n```"), /<div class="md-code">/u, "no language, no attribute");
});
