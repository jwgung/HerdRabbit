// Agents name files constantly -- "wrote src/api.mjs", "see ./docs/plan.md" --
// and on a phone the only way to look at one was to go find it in the tree. A
// path that names something this app can show becomes a link to it. Which
// words are paths is path-links.js's to say, the same as in the chat; what is
// the terminal's own is the screen: an address or a path cut at a row's end
// goes on in the next row.
import { MAX_QUOTED, findPaths, isFileName, linkableLabel, trimPunctuation, trimTrailingSlashes } from "./path-links.js?v=1.2.71";

function trimUrlPunctuation(label) {
  let cleaned = label;
  while (cleaned) {
    const last = cleaned.at(-1);
    const open = { ")": "(", "]": "[", "}": "{" }[last];
    if (/[.,;:!]/.test(last) || (open && cleaned.split(last).length > cleaned.split(open).length)) {
      cleaned = cleaned.slice(0, -1);
    } else break;
  }
  return cleaned;
}

function findUrls(text) {
  const links = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\x00-\x1f\x7f]+/gi)) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;

    // A URL that already closed with sentence punctuation at line's end was finished.
    const trimmed = trimUrlPunctuation(raw);
    let label = trimmed;
    let finalEnd = start + trimmed.length;

    if (trimmed.length === raw.length) {
      let currentEnd = end;
      let accumulated = raw;

      while (currentEnd < text.length) {
        const newlineMatch = text.slice(currentEnd).match(/^(\r?\n)([ \t]*)/);
        if (!newlineMatch) break;

        const newlineLen = newlineMatch[1].length;
        const indentLen = newlineMatch[2].length;
        const nextPos = currentEnd + newlineLen + indentLen;

        const contMatch = text.slice(nextPos).match(/^[^\s<>"'`\x00-\x1f\x7f]+/);
        if (!contMatch) break;

        const continuation = contMatch[0];
        const cleanCont = trimUrlPunctuation(continuation);
        if (!cleanCont) break;

        const prevChar = text[currentEnd - 1];

        const hasContinuationChar = /[/?&=%+#:@_-]/u.test(prevChar);
        const continuationHasUrlChar = /[/?&=%+#]/u.test(cleanCont);
        const isUnindented = indentLen === 0;

        let shouldJoin = false;
        if (hasContinuationChar) {
          const isRootDomain = /^https?:\/\/[^/]+\/?$/i.test(accumulated);
          if (!isRootDomain || continuationHasUrlChar) {
            shouldJoin = true;
          }
        } else if (isUnindented && continuationHasUrlChar) {
          shouldJoin = true;
        } else if (isUnindented) {
          const lastSegment = accumulated.split("/").pop();
          if (
            lastSegment &&
            lastSegment.length >= 16 &&
            /^[a-zA-Z0-9_-]+$/.test(lastSegment) &&
            /^[a-zA-Z0-9_-]+$/.test(cleanCont)
          ) {
            shouldJoin = true;
          }
        }

        if (!shouldJoin) break;

        const candidateUrl = accumulated + continuation;
        try {
          const parsed = new URL(trimUrlPunctuation(candidateUrl));
          if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) break;
        } catch {
          break;
        }

        accumulated = accumulated + continuation;
        currentEnd = nextPos + continuation.length;
      }

      label = trimUrlPunctuation(accumulated);
      finalEnd = currentEnd - (accumulated.length - label.length);
    }

    try {
      const url = new URL(label);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) continue;
      links.push({ start, end: finalEnd, href: url.href });
    } catch { /* Leave incomplete URLs as ordinary text. */ }
  }

  const nonOverlapping = [];
  for (const link of links) {
    if (!nonOverlapping.some((found) => link.start < found.end && found.start < link.end)) {
      nonOverlapping.push(link);
    }
  }
  return nonOverlapping;
}

// A path that stopped at the end of a screen row may go on in the next one.
// Screen rows are padded to the terminal's width, so a newline right after the
// last character means the row was full. A file name already complete (`a.md`)
// is not extended; a folder is, when the longer path is one too
// (`/home/me/doc-` + `viewer`).
function extendRun(text, run, own, isLinkable) {
  const { start, end, raw } = run;
  let best = own === null ? null : { start, end: start + own.length, path: own };
  // a complete file name stays as it is
  if (own !== null && isFileName(trimTrailingSlashes(own).split("/").pop())) return best;

  let currentEnd = end;
  let accumulated = raw;
  for (;;) {
    const next = nextRowStart(text, currentEnd, own !== null);
    if (next === null) break;
    const contMatch = text.slice(next).match(/^[^\s'"`)\]>:,;\x00-\x1f\x7f]+/);
    if (!contMatch) break;

    const rawCont = contMatch[0];
    const trimmedCont = trimPunctuation(rawCont);
    const candidate = linkableLabel(accumulated + trimmedCont, isLinkable);
    if (candidate !== null) {
      best = { start, end: next + trimmedCont.length, path: candidate };
      if (own === null) break;
    }

    accumulated += rawCont;
    currentEnd = next + rawCont.length;
    // a continuation that itself ended in punctuation is the end of the path
    if (own !== null && trimmedCont.length !== rawCont.length) break;
  }
  return best;
}

// Where the next screen row's text starts when a newline follows `at`, or null.
// A path that is already linkable only goes on at the row's very edge, not past
// indentation.
function nextRowStart(text, at, alreadyLinkable) {
  const newline = text.slice(at).match(/^(\r?\n)([ \t]*)/);
  if (!newline || (alreadyLinkable && newline[2])) return null;
  return at + newline[0].length;
}

// The most screen rows one quoted path is followed across.
const MAX_QUOTE_ROWS = 4;

// A quoted path may wrap onto the next rows, its closing quote on a later one:
// `cd "/home/me/my` | `folder"`. The rows are read back to back, without the
// newlines between them. A row is only followed when it ends in the path, not
// in the padding after it -- one space may be the one the row broke on, two
// are padding -- and the next row starts at its edge.
function closeQuoteAcrossRows(text, open) {
  const quote = text[open];
  let value = "";
  let from = open + 1;
  for (let rows = 0; rows < MAX_QUOTE_ROWS; rows += 1) {
    const newline = text.indexOf("\n", from);
    const close = text.indexOf(quote, from);
    if (close !== -1 && (newline === -1 || close < newline)) {
      value += text.slice(from, close);
      return value.length > MAX_QUOTED ? null : { end: close, value };
    }
    if (newline === -1) return null;
    const row = text.slice(from, newline).replace(/\r$/u, "");
    if (row.endsWith("  ") || row === "" || /^\s/u.test(text.slice(newline + 1, newline + 2))) return null;
    value += row;
    from = newline + 1;
  }
  return null;
}

// Linkable paths in terminal text, as [start, end) string offsets.
export function findTerminalPaths(text, isLinkable) {
  return findPaths(text, isLinkable, { extendRun, closeQuote: closeQuoteAcrossRows });
}

// The links on a terminal screen, for drawing and tapping them in place.
// `rows` are the visible rows as text, each with the cell every character
// starts in (and one past the end). They are read as one text, a row per
// line, so an address an agent's output wrapped onto the next row is one
// link. Each link comes back as the cells it covers on each row it touches.
export function findScreenLinks(rows, { isLinkablePath = () => false } = {}) {
  const starts = [];
  let text = "";
  for (const row of rows) {
    starts.push(text.length);
    text += `${row.text}\n`;
  }
  const urls = findUrls(text).map((link) => ({ ...link, kind: "url", target: link.href }));
  const paths = findTerminalPaths(text, isLinkablePath)
    .filter((link) => !urls.some((url) => link.start < url.end && url.start < link.end))
    .map((link) => ({ ...link, kind: "path", target: link.path }));
  return [...urls, ...paths].map((link) => {
    const segments = [];
    rows.forEach((row, index) => {
      const from = Math.max(link.start, starts[index]) - starts[index];
      const to = Math.min(link.end, starts[index] + row.text.length) - starts[index];
      if (to <= from) return;
      segments.push({ row: index, start: row.cells[from], end: row.cells[to - 1] + 1 });
    });
    return { kind: link.kind, target: link.target, segments };
  }).filter((link) => link.segments.length > 0);
}
