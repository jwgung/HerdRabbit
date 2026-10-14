// Agents name files constantly -- "wrote src/api.mjs", "see ./docs/plan.md" --
// and on a phone the only way to look at one was to go find it in the tree. A
// path that names something this app can show becomes a link to it.
//
// Only such paths. Terminal output is full of path-shaped words, and linking
// every one of them would underline half the screen; requiring a name the
// viewer recognises is what keeps `/usr/bin` and `node_modules/` plain.
// Any run that holds a slash: `/abs/x.log`, `./rel/x.md`, `~/x.md`, and the
// bare `src/api.mjs` an agent writes most often of all.
const PATH_PATTERN = /(?:^|[\s'"`([<])([^\s'"`([<>:,;\x00-\x1f\x7f]*\/[^\s'"`)\]>:,;\x00-\x1f\x7f]+)/g;

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

// Whether a path's last segment reads as a file name: `name.ext`, with a name
// before the dot and an extension of 1-10 letters and digits that holds a
// letter. `.env` is a hidden name rather than an extension, and `v1.2` or
// `10.0.0.1` are versions and addresses, so none of them count; neither does
// a folder like `feat/settings-menu` or a fraction like `1/2`.
export function isFileName(name) {
  return /^[^.].*\.(?=[A-Za-z0-9]{1,10}$)[0-9]*[A-Za-z][A-Za-z0-9]*$/u.test(name);
}

// A folder path an agent spells out in full: absolute (`/home/me/proj`) or
// explicitly relative (`./build`, `../shared/`). Such a path says it is a path
// whatever its last name looks like, so it needs no extension. A bare
// `src/foo`, `feat/settings-menu` or `1/2` does not say so and stays plain
// text, as does `//host/share` (half of a URL) and a lone `/word`, which in a
// terminal is nearly always a slash command (`/compact`), not a folder.
export function isFolderPath(raw) {
  if (typeof raw !== "string" || raw.startsWith("//")) return false;
  const relative = raw.startsWith("./") || raw.startsWith("../");
  if (!relative && !raw.startsWith("/")) return false;
  if (/[\x00-\x1f\x7f\s]/u.test(raw)) return false;
  const segments = raw.replace(/\/+$/u, "").split("/").slice(1);
  const last = segments.at(-1);
  if (!last || last === "." || last === "..") return false;
  // `/word` is one segment; `./word` and `../word` are explicit enough alone.
  if (!relative && segments.length < 2) return false;
  return !segments.includes("");
}

// Linkable paths in terminal text, as [start, end) string offsets.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]/u;
function trimPunctuation(value) {
  let cleaned = value;
  while (cleaned && TRAILING_PUNCTUATION.test(cleaned.at(-1))) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

// The path a run names, with a closing slash kept (it says "folder") when the
// run is linkable that way and otherwise without it, or null.
function linkableLabel(value, isLinkable) {
  const label = trimPunctuation(value);
  if (!label) return null;
  if (isLinkable(label)) return label;
  const bare = label.replace(/\/+$/u, "");
  return bare !== label && bare && isLinkable(bare) ? bare : null;
}

export function findTerminalPaths(text, isLinkable) {
  const links = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1];
    const start = match.index + match[0].length - match[1].length;
    const end = start + raw.length;

    const own = linkableLabel(raw, isLinkable);
    // A path that stopped at the end of a screen row may go on in the next
    // one. Screen rows are padded to the terminal's width, so a newline right
    // after the last character means the row was full. A file name already
    // complete (`a.md`) is not extended; a folder is, when the longer path is
    // one too (`/home/me/doc-` + `viewer`).
    const extendable = own === null || (!isFileName(own.replace(/\/+$/u, "").split("/").pop()));

    let best = own === null ? null : { start, end: start + own.length, path: own };
    if (extendable) {
      let currentEnd = end;
      let accumulated = raw;

      while (currentEnd < text.length) {
        const newlineMatch = text.slice(currentEnd).match(/^(\r?\n)([ \t]*)/);
        if (!newlineMatch) break;
        if (own !== null && newlineMatch[2]) break;

        const nextPos = currentEnd + newlineMatch[0].length;
        const contMatch = text.slice(nextPos).match(/^[^\s'"`)\]>:,;\x00-\x1f\x7f]+/);
        if (!contMatch) break;

        const rawCont = contMatch[0];
        const trimmedCont = trimPunctuation(rawCont);
        const candidate = linkableLabel(accumulated + trimmedCont, isLinkable);
        if (candidate !== null) {
          best = { start, end: nextPos + trimmedCont.length, path: candidate };
          if (own === null) break;
        }

        accumulated += rawCont;
        currentEnd = nextPos + rawCont.length;
        // a continuation that itself ended in punctuation is the end of the path
        if (own !== null && trimmedCont.length !== rawCont.length) break;
      }
    }
    if (best) links.push(best);
  }

  const nonOverlapping = [];
  for (const link of links) {
    if (!nonOverlapping.some((found) => link.start < found.end && found.start < link.end)) {
      nonOverlapping.push(link);
    }
  }
  return nonOverlapping;
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
