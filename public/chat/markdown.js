// The markdown an agent writes, as safe HTML for the chat: every character of
// the source is escaped, links keep only http(s) and mailto addresses, and the
// only markup is the fixed set of tags written below. No raw HTML from the
// source ever reaches the page, and nothing is highlighted, typeset or drawn.
//
// Ported from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- src/lib/markdown.ts (the parser,
// nearly as is), src/lib/filePaths.ts and src/lib/terminalFileLinks.ts
// (fileUriPath), and the rendering of src/components/Markdown.tsx, rewritten
// as an HTML string builder. HTML blocks (markdownHtml.ts) are left out: an
// agent's text keeps them as text.

import { findPaths, isFileName, isQuotablePath, namesPath } from "../path-links.js?v=1.2.71";

// ---------------------------------------------------------------------------
// Escaping and addresses.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ESCAPES[char]);
}

export function safeMarkdownHref(href) {
  const value = href.trim();
  // a control character or a space has no place in an address a link follows
  if (/[\u0000- \u007f]/u.test(value)) return null;
  return /^(?:https?:\/\/|mailto:)/iu.test(value) ? value : null;
}

// An address written without its scheme: `www.example.com/x`, `localhost:7317/`.
export function webLikeHref(target) {
  const value = target.trim();
  if (/^(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}:\d+|\d{1,3}(?:\.\d{1,3}){3}(?=\/))(?:\/\S*)?$/iu.test(value)) return `http://${value}`;
  const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(\/\S*)?$/iu.exec(value);
  if (match === null) return null;
  const [, host, path] = match;
  return /^www\./iu.test(host) || path !== undefined ? `https://${value}` : null;
}

// The path a `file:///` URI names, or null.
export function fileUriPath(uri) {
  if (!/^file:\/\/\//iu.test(uri) || /[\u0000-\u001f\u007f]/u.test(uri)) return null;
  try {
    const url = new URL(uri);
    if (url.host || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname);
    if (/[\u0000-\u001f\u007f]/u.test(path) || /^[\\/]{2}/u.test(path)) return null;
    return /^\/[A-Za-z]:[\\/]/u.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

// The file a link names when its target is a path rather than an address.
export function markdownFileTarget(href) {
  const value = href.trim();
  if (/^file:\/\/\//iu.test(value)) return fileUriPath(value);
  if (value === "" || value.startsWith("#")) return null;
  const withoutAnchor = value.replace(/#.*$/u, "");
  const path = withoutAnchor.replace(/(?::\d+){1,2}$/u, "");
  if (path === "" || /^[a-z][a-z0-9+.-]*:/iu.test(path) || (path !== withoutAnchor && !/[./]/u.test(path))) return null;
  return path;
}

// A bare URL without the punctuation that closes the sentence around it.
export function trimUrl(url) {
  let end = url.length;
  let opened = 0;
  let closed = 0;
  for (let index = 0; index < end; index += 1) {
    if (url[index] === "(") opened += 1;
    else if (url[index] === ")") closed += 1;
  }
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && ".,:;!?'\"*_~".includes(last)) { end -= 1; continue; }
    if (last === ")" && closed > opened) { end -= 1; closed -= 1; continue; }
    break;
  }
  return url.slice(0, end);
}

// ---------------------------------------------------------------------------
// File paths in prose ("saved to docs/demo.mp4") are found by path-links.js,
// the same finder the terminal uses, so the chat and the terminal link the same
// words. A code span is one thing: the whole span is a path or it is not, and
// there a bare file name is enough (`app.js`), as is a path with spaces
// (`/home/me/my folder`) -- the backticks quote it.

const CODE_NAME = /^(?:process\.(?:env|argv|cwd|exit|platform|stdout|stderr|stdin)(?:\.\w+)?|Math\.(?:random|floor|ceil|round|max|min|abs|pow|sqrt|trunc|sign)|JSON\.(?:parse|stringify)|console\.(?:log|error|warn|info|debug)|Object\.(?:keys|values|entries|assign|freeze)|Array\.(?:from|isArray)|Promise\.(?:all|race|any|allSettled|resolve|reject)|Number\.(?:isFinite|isInteger|parseInt|parseFloat)|os\.(?:path|environ|getcwd|getenv)|sys\.(?:argv|path|exit|stdout|stderr)|window\.(?:location|history|open)|document\.(?:body|title|cookie))$/u;

// Text and the paths in it, in order: strings and { path } parts.
export function splitFilePaths(text, isLinkable = namesPath) {
  const parts = [];
  let offset = 0;
  for (const link of findPaths(text, isLinkable)) {
    if (link.start > offset) parts.push(text.slice(offset, link.start));
    parts.push({ path: link.path });
    offset = link.end;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

export function codeIsFilePath(code) {
  if (/\s/u.test(code)) return isQuotablePath(code) && namesPath(code);
  if (code.includes("/")) return namesPath(code);
  // a name alone: a file name, but not `process.env` or a version
  return isFileName(code) && !CODE_NAME.test(code) && /[A-Za-z]/u.test(code.replace(/\.[A-Za-z0-9]{1,10}$/u, ""));
}

// ---------------------------------------------------------------------------
// Inline marks.

const MAX_INLINE_DEPTH = 16;

// The marks in a line, left to right. The pattern is only tried where a mark
// can start, and where its closer may be far away, only if one is there.
export function* inlineMarks(source) {
  const marker = /(`[^`\n]+`|\\\(.+?\\\)|\[[^\]\n]+\]\([^\s)]+\)|<https?:\/\/[^\s<>]+>|file:\/\/\/[!#-;=?-_a-~]+|https?:\/\/[!-;=?-~]+|(?<![\w.@/-])www\.[!-;=?-~]+|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}\p{M}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}\p{M}_])|~~[^~\n]+~~|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_]))/yu;
  const emphasis = /(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_])/yu;
  const opener = /[`[<*_~]|\\\(|file:\/\/\/|https?:\/\/|www\./gu;
  const next = (pattern) => {
    let found = -1;
    return (from) => {
      if (found < from) {
        pattern.lastIndex = from;
        found = pattern.exec(source)?.index ?? Infinity;
      }
      return found;
    };
  };
  const lineEnd = next(/\n/gu);
  const mathBreak = next(/[\n\r\u2028\u2029]/gu);
  const mathClose = next(/\\\)/gu);
  const labelEnd = next(/[\]\n]/gu);
  const targetEnd = next(/[\s)]/gu);
  const emphasisClose = next(/(?<=\S)_(?![\p{L}\p{N}\p{M}_])/gu);
  const strongClose = next(/(?<=\S)__(?![\p{L}\p{N}\p{M}_])/gu);
  let from = 0;
  for (;;) {
    opener.lastIndex = from;
    const start = opener.exec(source)?.index;
    if (start === undefined) return;
    from = start + 1;
    let pattern = marker;
    const char = source[start];
    if (char === "\\") {
      if (!(mathClose(start + 3) < mathBreak(start + 2))) pattern = null;
    } else if (char === "[") {
      const label = labelEnd(start + 1);
      const target = label + 2;
      if (!(label > start + 1 && source[label] === "]" && source[label + 1] === "(")) pattern = null;
      else {
        const end = targetEnd(target);
        if (!(end > target && source[end] === ")")) pattern = null;
      }
    } else if (char === "_") {
      const end = lineEnd(start + 1);
      if (!(source[start + 1] === "_" && strongClose(start + 3) < end)) pattern = emphasisClose(start + 2) < end ? emphasis : null;
    }
    if (pattern === null) continue;
    pattern.lastIndex = start;
    const match = pattern.exec(source);
    if (match === null) continue;
    from = start + match[0].length;
    yield match;
  }
}

// Inline nodes: text, code, math, strong/em/del, link, image, file.
// Unknown or malformed markup stays text.
export function parseInline(source, links = true, depth = 0) {
  if (depth > MAX_INLINE_DEPTH) return source === "" ? [] : [{ type: "text", value: source }];
  const nodes = [];
  let offset = 0;
  for (const match of inlineMarks(source)) {
    const index = match.index ?? 0;
    let token = match[0];
    const image = token.startsWith("[") && index > offset && source[index - 1] === "!";
    const textEnd = image ? index - 1 : index;
    if (textEnd > offset) nodes.push({ type: "text", value: source.slice(offset, textEnd) });
    if (token.startsWith("file:///")) {
      token = trimUrl(token);
      const path = fileUriPath(token);
      nodes.push(links && path !== null ? { type: "file", path, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("<")) {
      const url = token.slice(1, -1);
      nodes.push(links ? { type: "link", href: url, children: [{ type: "text", value: url }] } : { type: "text", value: token });
    } else if (/^(?:https?:|www\.)/iu.test(token)) {
      token = trimUrl(token);
      const href = /^www\./iu.test(token) ? `https://${token}` : token;
      nodes.push(links ? { type: "link", href, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("`")) {
      nodes.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("\\(")) {
      nodes.push({ type: "math", value: token.slice(2, -2) });
    } else if (token.startsWith("[")) {
      const split = token.lastIndexOf("](");
      const label = token.slice(1, split);
      const target = token.slice(split + 2, -1);
      const href = safeMarkdownHref(target) ?? webLikeHref(target);
      const file = href === null ? markdownFileTarget(target) : null;
      const shown = href !== null ? { type: "link", href, children: parseInline(label, false, depth) }
        : file !== null ? { type: "file", path: file, children: parseInline(label, false, depth) }
          : { type: "text", value: label };
      if (image) nodes.push({ type: "image", alt: label, src: target, fallback: [{ type: "text", value: "!" }, shown] });
      else nodes.push(shown);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push({ type: "strong", children: parseInline(token.slice(2, -2), links, depth + 1) });
    } else if (token.startsWith("~~")) {
      nodes.push({ type: "del", children: parseInline(token.slice(2, -2), links, depth + 1) });
    } else {
      nodes.push({ type: "em", children: parseInline(token.slice(1, -1), links, depth + 1) });
    }
    offset = index + token.length;
  }
  if (offset < source.length) nodes.push({ type: "text", value: source.slice(offset) });
  return nodes;
}

// ---------------------------------------------------------------------------
// Blocks.

const listLine = /^(\s*)([-*]|\d+\.)\s+(.+)$/su;

export function isTableSeparator(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  const columns = row.split("|");
  return columns.length >= 2 && columns.every((column) => /^:?-{3,}:?$/u.test(column.trim()));
}

function cells(line) {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}
const lineAt = (lines, index) => lines[index] ?? "";
const startsTable = (lines, index) => lineAt(lines, index).includes("|") && isTableSeparator(lineAt(lines, index + 1));

function parseTable(lines, start, within = 0) {
  const header = cells(lineAt(lines, start)).map((cell) => parseInline(cell));
  let index = start + 2;
  const rows = [];
  const inItem = (line) => within === 0 || ((/^\s*/u.exec(line)?.[0].length ?? 0) >= within && !listLine.test(line));
  while (index < lines.length && lineAt(lines, index).includes("|") && lineAt(lines, index).trim() !== "" && inItem(lineAt(lines, index))) {
    rows.push(cells(lineAt(lines, index)).map((cell) => parseInline(cell)));
    index += 1;
  }
  return { block: { type: "table", header, rows }, next: index };
}

function startsBlock(lines, index) {
  const line = lines[index] ?? "";
  return /^\s*\\\[/u.test(line) || /^\s{0,3}```/u.test(line) || /^#{1,6}\s+/u.test(line) || /^\s*>/u.test(line) ||
    /^(?:\s*[-*_]){3,}\s*$/u.test(line) || listLine.test(line) || startsTable(lines, index);
}

function listItem(text) {
  const task = /^\[([ xX])\](?:\s+(.*))?$/u.exec(text);
  if (task === null) return { content: parseInline(text) };
  return { content: parseInline(task[2] ?? ""), checked: task[1] !== " " };
}

function parseList(lines, start) {
  const first = listLine.exec(lineAt(lines, start));
  if (first === null) return { block: { type: "list", ordered: false, items: [] }, next: start + 1 };
  const baseIndent = (first[1] ?? "").length;
  const ordered = /\d/u.test(first[2] ?? "");
  const number = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1;
  const block = { type: "list", ordered, ...(ordered && number !== 1 ? { start: number } : {}), items: [] };
  let index = start;
  while (index < lines.length) {
    if (block.items.length > 0 && !listLine.test(lineAt(lines, index))) {
      let ahead = index;
      while (ahead < lines.length && lineAt(lines, ahead).trim() === "") ahead += 1;
      const line = lineAt(lines, ahead);
      const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
      const sibling = listLine.exec(line);
      if (sibling !== null && (sibling[1] ?? "").length === baseIndent && /\d/u.test(sibling[2] ?? "") === ordered) { index = ahead; continue; }
      if (sibling !== null && (sibling[1] ?? "").length >= baseIndent + 2) { index = ahead; continue; }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && startsTable(lines, ahead)) {
        const item = block.items.at(-1);
        const table = parseTable(lines, ahead, baseIndent + 2);
        (item.blocks ??= []).push(table.block);
        index = table.next;
        continue;
      }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && !/^\s*```/u.test(line)) {
        const item = block.items.at(-1);
        const last = item.blocks?.at(-1);
        if (last === undefined) {
          item.content.push({ type: "text", value: " " });
          for (const node of parseInline(line.trim())) item.content.push(node);
        } else {
          if (startsBlock(lines, ahead)) break;
          if (last.type === "paragraph" && ahead === index) last.lines.push(parseInline(line.trim()));
          else item.blocks.push({ type: "paragraph", lines: [parseInline(line.trim())] });
        }
        index = ahead + 1;
        continue;
      }
      break;
    }
    const match = listLine.exec(lineAt(lines, index));
    if (match === null || (match[1] ?? "").length < baseIndent) break;
    if ((match[1] ?? "").length >= baseIndent + 2) {
      const parent = block.items.at(-1);
      if (parent === undefined) break;
      const nested = parseList(lines, index);
      (parent.blocks ??= []).push(nested.block);
      index = nested.next;
      continue;
    }
    if ((match[1] ?? "").length !== baseIndent || /\d/u.test(match[2] ?? "") !== ordered) break;
    block.items.push(listItem(match[3] ?? ""));
    index += 1;
  }
  return { block, next: index };
}

// Code blocks longer than this open folded to their first FOLDED_CODE_LINES lines.
export const FOLD_CODE_AFTER_LINES = 30;
export const FOLDED_CODE_LINES = 20;
const MAX_QUOTE_DEPTH = 32;

export function parseMarkdown(source, depth = 0) {
  const lines = String(source).replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let index = 0;
  let unclosedMath = 0;
  while (index < lines.length) {
    const line = lineAt(lines, index);
    if (line.trim() === "") { index += 1; continue; }

    const fence = /^( {0,3})```\s*([^\s`]*)/u.exec(line);
    if (fence !== null) {
      const indent = fence[1] ?? "";
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}```\s*$/u.test(lineAt(lines, index))) {
        const bodyLine = lineAt(lines, index++);
        body.push(bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine.trimStart());
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[2] ?? "", value: body.join("\n") });
      continue;
    }

    const display = index < unclosedMath ? null : /^\s*\\\[(.*)$/u.exec(line);
    if (display !== null) {
      const body = [];
      let next = index;
      let part = display[1] ?? "";
      let complete = false;
      for (;;) {
        const close = part.indexOf("\\]");
        if (close !== -1 && part.slice(close + 2).trim() === "") {
          body.push(part.slice(0, close));
          blocks.push({ type: "math", value: body.join("\n").trim() });
          index = next + 1;
          complete = true;
          break;
        }
        body.push(part);
        next += 1;
        if (next >= lines.length || /^\s{0,3}```/u.test(lineAt(lines, next))) break;
        part = lineAt(lines, next);
      }
      if (complete) continue;
      unclosedMath = next;
    }

    const heading = /^(#{1,6})\s+(.+)$/su.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: heading[1].length, content: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    if (/^(?:\s*[-*_]){3,}\s*$/u.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (/^\s*>/u.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>/u.test(lineAt(lines, index))) quoted.push(lineAt(lines, index++).replace(/^\s*>\s?/u, ""));
      blocks.push({ type: "blockquote", blocks: depth < MAX_QUOTE_DEPTH ? parseMarkdown(quoted.join("\n"), depth + 1)
        : [{ type: "paragraph", lines: quoted.map((quotedLine) => parseInline(quotedLine)) }] });
      continue;
    }

    if (listLine.test(line)) {
      const parsed = parseList(lines, index);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    if (startsTable(lines, index)) {
      const table = parseTable(lines, index);
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lineAt(lines, index).trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, index))) {
      paragraph.push(parseInline(lineAt(lines, index)));
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// HTML. `isLinkablePath(path)` says which file paths the page can open or show: they
// become buttons carrying the path in `data-path`, for the chat to open.

function fileButton(path, label, code) {
  return `<button type="button" class="md-file${code ? " is-code" : ""}" data-path="${escapeHtml(path)}" title="${escapeHtml(`Open ${path}`)}">${label}</button>`;
}

function inlineHtml(nodes, options, interactive = true) {
  const linkable = interactive ? options.isLinkablePath : () => false;
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return splitFilePaths(node.value, linkable).map((part) => (typeof part === "string"
          ? escapeHtml(part)
          : fileButton(part.path, escapeHtml(part.path), false))).join("");
      case "code": {
        const file = fileUriPath(node.value);
        if (file !== null && linkable(file)) return fileButton(file, `<code>${escapeHtml(node.value)}</code>`, true);
        if (interactive && /^https?:\/\/\S+$/iu.test(node.value) && safeMarkdownHref(node.value) !== null) {
          return `<a class="md-code-link" href="${escapeHtml(node.value)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(node.value)}</code></a>`;
        }
        if (codeIsFilePath(node.value) && linkable(node.value)) return fileButton(node.value, `<code>${escapeHtml(node.value)}</code>`, true);
        return `<code>${escapeHtml(node.value)}</code>`;
      }
      case "math": return `<code class="md-math">${escapeHtml(`\\(${node.value}\\)`)}</code>`;
      case "image": return inlineHtml(node.fallback, options, interactive);
      case "strong": return `<strong>${inlineHtml(node.children, options, interactive)}</strong>`;
      case "em": return `<em>${inlineHtml(node.children, options, interactive)}</em>`;
      case "del": return `<del>${inlineHtml(node.children, options, interactive)}</del>`;
      case "link": {
        const href = safeMarkdownHref(node.href);
        const label = inlineHtml(node.children, options, false);
        return href === null ? label : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      case "file": {
        const label = inlineHtml(node.children, options, false);
        return linkable(node.path) ? fileButton(node.path, label, false) : `${label} (<code>${escapeHtml(node.path)}</code>)`;
      }
      default: return "";
    }
  }).join("");
}

function listHtml(block, options) {
  const tag = block.ordered ? "ol" : "ul";
  const start = block.ordered && Number.isInteger(block.start) ? ` start="${block.start}"` : "";
  const items = block.items.map((item) => {
    const box = item.checked === undefined ? ""
      : `<span class="md-task-box${item.checked ? " is-checked" : ""}" role="img" aria-label="${item.checked ? "Done" : "Not done"}"></span>`;
    const nested = item.blocks ? blocksHtml(item.blocks, options) : "";
    return `<li${item.checked === undefined ? "" : ' class="md-task"'}>${box}${inlineHtml(item.content, options)}${nested}</li>`;
  }).join("");
  return `<${tag} class="md-list"${start}>${items}</${tag}>`;
}

// The copy buttons' icons, stroked on 20 units like the composer's, and the
// check a button shows for a moment once a copy worked (chat-view.js).
export const COPY_ICONS = '<svg class="copy-icon" aria-hidden="true" viewBox="0 0 20 20" focusable="false">' +
  '<rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></svg>' +
  '<svg class="copied-icon" aria-hidden="true" viewBox="0 0 20 20" focusable="false"><path d="m4.5 10.5 3.5 3.5 7.5-8" /></svg>';

function codeHtml(block) {
  const lines = block.value.split("\n").length;
  const folded = lines > FOLD_CODE_AFTER_LINES;
  return `<div class="md-code${folded ? " is-folded" : ""}">` +
    `<div class="md-code-head"><span>${escapeHtml(block.language || "text")}</span>` +
    `<button type="button" class="md-code-copy" data-action="copy-code" aria-label="Copy code" title="Copy code">${COPY_ICONS}</button></div>` +
    `<pre><code>${escapeHtml(block.value)}</code></pre>` +
    (folded ? `<button type="button" class="md-code-more" data-action="unfold-code" aria-expanded="false" data-lines="${lines}">Show all ${lines} lines</button>` : "") +
    "</div>";
}

function blocksHtml(blocks, options) {
  return blocks.map((block) => {
    switch (block.type) {
      // an agent's headings stay under the app's own: all are h4, the level a class
      case "heading": return `<h4 class="md-h${block.level}">${inlineHtml(block.content, options)}</h4>`;
      case "paragraph": return `<p>${block.lines.map((line) => inlineHtml(line, options)).join("<br>")}</p>`;
      case "list": return listHtml(block, options);
      case "blockquote": return `<blockquote>${blocksHtml(block.blocks, options)}</blockquote>`;
      case "code": return codeHtml(block);
      case "math": return `<pre class="md-math">${escapeHtml(`\\[${block.value}\\]`)}</pre>`;
      case "hr": return "<hr>";
      case "table": return `<div class="md-table-wrap"><table><thead><tr>${block.header.map((cell) => `<th>${inlineHtml(cell, options)}</th>`).join("")}</tr></thead>` +
        `<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell, options)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      default: return "";
    }
  }).join("");
}

export function renderMarkdown(source, { isLinkablePath = () => false } = {}) {
  return blocksHtml(parseMarkdown(source), { isLinkablePath });
}
