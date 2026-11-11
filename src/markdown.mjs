// Markdown is what the agents on the other end of this app write: plans,
// reports, READMEs, notes. Reading one as its own source on a phone means
// counting hashes and pipes to work out where a table starts, so it is drawn.
//
// The parsing is marked's. A hand-rolled line reader got the common shapes
// right and the ordinary ones wrong -- a nested list flattened, a paragraph
// wrapped over two lines became two paragraphs -- and those are what a real
// document is full of. It costs one dependency and nothing in the browser,
// because the rendering happens here and only the result is sent.
//
// What is not marked's is what a document is allowed to point at or contain.
// It emits `javascript:` hrefs and raw HTML untouched by design, leaving that
// to the caller, so the caller does it: links are http(s) or they are text,
// and embedded markup is shown as the characters it is made of.
//
// The frame this lands in is the other half. Its response policy ends in
// `sandbox` -- an opaque origin with no script -- so nothing here is the only
// thing standing between a document and this app's session.

import { Marked } from "marked";

const ESCAPES = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ESCAPES.get(character));
}

// Only the two schemes a document should be able to point at. Everything else
// -- javascript:, data:, a bare path that would resolve against our own origin
// -- keeps its text and loses its link.
function safeUrl(raw) {
  const value = String(raw ?? "").trim();
  return /^https?:\/\/[^\s<>"]+$/iu.test(value) ? value : null;
}

// A document opened with its folder (src/site-preview.mjs) may also point at
// a file beside it: a relative path, with no scheme, no leading slash and no
// `//`, resolves under the folder's own URL and nowhere else.
function relativeUrl(raw) {
  const value = String(raw ?? "").trim();
  return value && !/^[a-z][a-z0-9+.-]*:|^[/\\]|[\s<>"]/iu.test(value) ? value : null;
}

// Set while one document renders: whether relative paths are allowed in it.
let relative = false;

const renderer = {
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const near = relative ? relativeUrl(href) : null;
    if (near) return `<a href="${escapeHtml(near)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`;
    const url = safeUrl(href);
    if (!url) return label;
    const named = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(url)}"${named} target="_blank" rel="noopener noreferrer">${label}</a>`;
  },
  image({ href, text, title }) {
    const url = safeUrl(href) ?? (relative ? relativeUrl(href) : null);
    // A relative path would resolve against this app and be refused by the
    // frame's policy, which shows as a broken icon and no explanation. The
    // text that named it is more use than that.
    if (!url) return escapeHtml(text || String(href ?? ""));
    const named = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text ?? "")}"${named} />`;
  },
  html({ text }) {
    return escapeHtml(text);
  },
};

const markdown = new Marked({ gfm: true, breaks: false, async: false });
markdown.use({ renderer });

export function renderInline(source) {
  return markdown.parseInline(String(source));
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 18px 20px 40px; font: 15px/1.65 system-ui, sans-serif;
  color: #1c2320; background: #ffffff; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { margin: 1.6em 0 0.6em; line-height: 1.3; }
h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.15em; }
h1, h2 { padding-bottom: 0.25em; border-bottom: 1px solid #dfe6e2; }
p, ul, ol, blockquote, pre, table { margin: 0.8em 0; }
ul, ol { padding-left: 1.5em; }
li { margin: 0.25em 0; }
li > p { margin: 0.2em 0; }
li input[type="checkbox"] { margin-right: 0.4em; }
a { color: #167454; }
code { padding: 0.15em 0.35em; border-radius: 4px; background: #eef3f0;
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 0.9em; }
pre { padding: 12px 14px; border-radius: 8px; background: #f3f7f5; overflow-x: auto; }
pre code { padding: 0; background: none; font-size: 0.88em; }
blockquote { padding-left: 14px; border-left: 3px solid #c9d8d2; color: #4d5d56; }
hr { height: 1px; margin: 1.6em 0; border: 0; background: #dfe6e2; }
img { max-width: 100%; }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; }
th, td { padding: 6px 12px; border: 1px solid #dfe6e2; text-align: left; }
th { background: #f3f7f5; }
@media (prefers-color-scheme: dark) {
  body { color: #e2e9e5; background: #10161a; }
  h1, h2 { border-bottom-color: #2a343a; }
  a { color: #7fe0bd; }
  code { background: #1c252b; }
  pre { background: #161e24; }
  blockquote { border-left-color: #35434b; color: #a6b3ac; }
  hr { background: #2a343a; }
  th, td { border-color: #2a343a; }
  th { background: #161e24; }
}`;

// `site`: the document is shown with its folder, so a relative picture or
// link points at a file beside it rather than at this app.
export function renderMarkdown(source, title = "", { site = false } = {}) {
  relative = site;
  try {
    return renderDocument(source, title);
  } finally {
    relative = false;
  }
}

function renderDocument(source, title) {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    markdown.parse(String(source)),
    "</body></html>",
  ].join("\n");
}
