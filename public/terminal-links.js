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

// Viewable paths in terminal text, as [start, end) string offsets.
export function findTerminalPaths(text, isViewable) {
  const links = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1];
    const start = match.index + match[0].length - match[1].length;
    const end = start + raw.length;

    let label = raw;
    while (label && /[.,;:!?)\]}/]/u.test(label.at(-1))) label = label.slice(0, -1);
    if (label && isViewable(label)) {
      links.push({ start, end: start + label.length, path: label });
      continue;
    }

    // Terminal width wrapping can split a long path across line breaks.
    let currentEnd = end;
    let accumulated = raw;

    while (currentEnd < text.length) {
      const newlineMatch = text.slice(currentEnd).match(/^(\r?\n)([ \t]*)/);
      if (!newlineMatch) break;

      const nextPos = currentEnd + newlineMatch[0].length;
      const contMatch = text.slice(nextPos).match(/^[^\s'"`)\]>:,;\x00-\x1f\x7f]+/);
      if (!contMatch) break;

      const rawCont = contMatch[0];
      let trimmedCont = rawCont;
      while (trimmedCont && /[.,;:!?)\]}/]/u.test(trimmedCont.at(-1))) trimmedCont = trimmedCont.slice(0, -1);

      const candidate = accumulated + trimmedCont;
      let candidateLabel = candidate;
      while (candidateLabel && /[.,;:!?)\]}/]/u.test(candidateLabel.at(-1))) candidateLabel = candidateLabel.slice(0, -1);

      if (candidateLabel && isViewable(candidateLabel)) {
        const finalEnd = nextPos + trimmedCont.length;
        links.push({ start, end: finalEnd, path: candidateLabel });
        break;
      }

      accumulated = accumulated + rawCont;
      currentEnd = nextPos + rawCont.length;
    }
  }

  const nonOverlapping = [];
  for (const link of links) {
    if (!nonOverlapping.some((found) => link.start < found.end && found.start < link.end)) {
      nonOverlapping.push(link);
    }
  }
  return nonOverlapping;
}

// Detect URLs across ANSI style boundaries without interpreting terminal text as HTML.
export function linkTerminalSegments(segments, { isViewablePath = () => false } = {}) {
  const text = segments.map((segment) => segment.text).join("");
  const links = findUrls(text);

  // A URL wins where the two overlap: "https://x/a.md" is one address, not an
  // address next to a file.
  for (const link of findTerminalPaths(text, isViewablePath)) {
    if (!links.some((found) => link.start < found.end && found.start < link.end)) links.push(link);
  }
  links.sort((first, second) => first.start - second.start);

  const result = [];
  let offset = 0;
  let linkIndex = 0;
  for (const segment of segments) {
    const end = offset + segment.text.length;
    let position = offset;
    while (position < end) {
      while (links[linkIndex]?.end <= position) linkIndex += 1;
      const link = links[linkIndex];
      const linked = link && position >= link.start;
      const boundary = Math.min(end, link ? linked ? link.end : link.start : end);
      const part = { ...segment, text: segment.text.slice(position - offset, boundary - offset) };
      if (linked) {
        if (link.href) part.href = link.href;
        else part.path = link.path;
        part.linkStart = link.start;
      }
      result.push(part);
      position = boundary;
    }
    offset = end;
  }
  return result;
}

// The links on a terminal screen, for drawing and tapping them in place.
// `rows` are the visible rows as text, each with the cell every character
// starts in (and one past the end). They are read as one text, a row per
// line, so an address an agent's output wrapped onto the next row is one
// link. Each link comes back as the cells it covers on each row it touches.
export function findScreenLinks(rows, { isViewablePath = () => false } = {}) {
  const starts = [];
  let text = "";
  for (const row of rows) {
    starts.push(text.length);
    text += `${row.text}\n`;
  }
  const urls = findUrls(text).map((link) => ({ ...link, kind: "url", target: link.href }));
  const paths = findTerminalPaths(text, isViewablePath)
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
