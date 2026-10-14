// The paths an agent names in its text, found the same way wherever the text is
// shown: in the terminal (terminal-links.js) and in the chat (chat/markdown.js).
// Both ask the same question of the same characters, so a path that links in one
// links in the other.
//
// Only paths that name something. Agent output is full of path-shaped words, and
// linking every one of them would underline half the screen: a run is a path
// when its last name is a file name (`api.mjs`) or when it is a folder written
// out in full (`/home/me/proj`, `./build`). The page then says which of those it
// can open (`isLinkable`).

// Whether a path's last segment reads as a file name: `name.ext`, with a name
// before the dot and an extension of 1-10 letters and digits that holds a
// letter. `.env` is a hidden name rather than an extension, and `v1.2` or
// `10.0.0.1` are versions and addresses, so none of them count; neither does
// a folder like `feat/settings-menu` or a fraction like `1/2`.
export function isFileName(name) {
  return /^[^.].*\.(?=[A-Za-z0-9]{1,10}$)[0-9]*[A-Za-z][A-Za-z0-9]*$/u.test(name);
}

// A path without the slashes that close it: they say "folder", not which one.
export function trimTrailingSlashes(path) {
  return path.replace(/\/+$/u, "");
}

// A folder path an agent spells out in full: absolute (`/home/me/proj`) or
// explicitly relative (`./build`, `../shared/`). Such a path says it is a path
// whatever its last name looks like, so it needs no extension. A bare
// `src/foo`, `feat/settings-menu` or `1/2` does not say so and stays plain
// text, as does `//host/share` (half of a URL) and a lone `/word`, which in a
// terminal is nearly always a slash command (`/compact`), not a folder. A
// space inside is allowed -- only a quoted path can hold one -- but not at
// either end.
export function isFolderPath(raw) {
  if (typeof raw !== "string" || raw.startsWith("//") || raw !== raw.trim()) return false;
  const relative = raw.startsWith("./") || raw.startsWith("../");
  if (!relative && !raw.startsWith("/")) return false;
  if (/[\x00-\x1f\x7f]/u.test(raw)) return false;
  const segments = trimTrailingSlashes(raw).split("/").slice(1);
  const last = segments.at(-1);
  if (!last || last === "." || last === "..") return false;
  // `/word` is one segment; `./word` and `../word` are explicit enough alone.
  if (!relative && segments.length < 2) return false;
  return !segments.includes("");
}

// Whether `raw` names a path at all: a file name at its end, or a folder
// written out in full. The default `isLinkable`, for callers that only want
// to know where the paths are.
export function namesPath(raw) {
  return isFileName(trimTrailingSlashes(raw).split("/").pop()) || isFolderPath(raw);
}

// Any run that holds a slash: `/abs/x.log`, `./rel/x.md`, `~/x.md`, the bare
// `src/api.mjs` an agent writes most often of all, and names in any script
// (`/home/me/프로젝트`). A run starts after a space, a quote or an opening
// bracket and stops at a space, a quote, a closing bracket or `:,;` -- so
// `test/a.mjs:370` is the file without its line, and `https://x` is no run.
const PATH_PATTERN = /(?:^|[\s'"`([<])([^\s'"`([<>:,;\x00-\x1f\x7f]*\/[^\s'"`)\]>:,;\x00-\x1f\x7f]+)/gu;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}]/u;
export function trimPunctuation(value) {
  let cleaned = value;
  while (cleaned && TRAILING_PUNCTUATION.test(cleaned.at(-1))) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

// `src/a.md를`: a Korean particle written straight after a file name is not
// part of it. Only after a file name's extension -- a folder name may be
// written in any script, and `/home/me/프로젝트` is a folder.
function withoutParticle(label) {
  let end = label.length;
  while (end > 0 && label.charCodeAt(end - 1) > 0x7f && /\p{L}/u.test(label[end - 1])) end -= 1;
  if (end === label.length || end === 0) return null;
  const head = label.slice(0, end);
  return isFileName(head.split("/").pop()) ? head : null;
}

// The path a run names, with a closing slash kept (it says "folder") when the
// run is linkable that way and otherwise without it, or null. Always a prefix
// of `value`, so the link ends where the path does.
export function linkableLabel(value, isLinkable) {
  const label = trimPunctuation(value);
  if (!label) return null;
  const head = withoutParticle(label);
  if (head !== null && isLinkable(head)) return head;
  if (isLinkable(label)) return label;
  const bare = trimTrailingSlashes(label);
  return bare !== label && bare && isLinkable(bare) ? bare : null;
}

// A path in quotes may hold spaces: `"/home/me/my folder"`,
// `'./build output/app.aab'`. Such a quote counts when it holds a path written
// out in full -- absolute, `./` or `../` -- with no space at either end;
// `"see docs/a.md"` is a sentence that holds a path, not a path.
export function isQuotablePath(value) {
  return value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value) && !value.startsWith("//") &&
    /^(?:\/|\.{1,2}\/)/u.test(value);
}

const QUOTES = "\"'`";
// The longest quoted path looked for; longer quotes are left to the runs inside.
export const MAX_QUOTED = 1024;
// A quote opens after a space, an opening bracket, `=` or `:`, or at the start,
// and closes before a space, closing punctuation or the end -- so the apostrophe
// in "it's" opens nothing.
const OPENS_AFTER = /[\s([{<=:,]/u;
const CLOSES_BEFORE = /[\s.,;:!?)\]}>]/u;

// The quote that closes one opened at `open`, on the same line: { end, value }
// (`end` the closing quote's offset), or null.
function sameLineQuote(text, open) {
  const quote = text[open];
  const end = text.indexOf(quote, open + 1);
  if (end === -1 || end - open - 1 > MAX_QUOTED) return null;
  const value = text.slice(open + 1, end);
  return value.includes("\n") ? null : { end, value };
}

// The offset of the first quote at or after `from` that opens one, or -1.
function findOpenQuote(text, from) {
  for (let index = from; index < text.length; index += 1) {
    if (QUOTES.includes(text[index]) && (index === 0 || OPENS_AFTER.test(text[index - 1]))) return index;
  }
  return -1;
}

// The link a quote opened at `open` makes, or null when it holds no spaced,
// linkable path or is not closed where a quote closes.
function quotedLink(text, open, isLinkable, closeQuote) {
  const quoted = closeQuote(text, open);
  if (quoted === null || !/\s/u.test(quoted.value)) return null;
  const after = text[quoted.end + 1];
  if (after !== undefined && !CLOSES_BEFORE.test(after)) return null;
  if (!isQuotablePath(quoted.value) || !isLinkable(quoted.value)) return null;
  return { start: open + 1, end: quoted.end, path: quoted.value };
}

function quotedPaths(text, isLinkable, closeQuote) {
  const links = [];
  let from = 0;
  for (let open = findOpenQuote(text, from); open !== -1; open = findOpenQuote(text, from)) {
    from = open + 1;
    const link = quotedLink(text, open, isLinkable, closeQuote);
    if (link === null) continue;
    links.push(link);
    from = link.end + 1;
  }
  return links;
}

const overlaps = (link, links) => links.some((found) => link.start < found.end && found.start < link.end);

// The linkable paths in `text`, as { start, end, path } with [start, end)
// string offsets, in order. A quoted path with spaces is one link, the quotes
// left out; elsewhere a path ends at the first space.
//
// The terminal reads several screen rows as one text and passes two hooks for
// what a wrapped row means there: `extendRun(text, run, own, isLinkable)` may carry a run
// onto the next row (and returns the link, or null), and `closeQuote(text,
// open)` may find a quote's closer on a later row.
export function findPaths(text, isLinkable = namesPath, { extendRun = null, closeQuote = sameLineQuote } = {}) {
  const links = quotedPaths(text, isLinkable, closeQuote);
  const quoted = links.length;
  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1];
    const start = match.index + match[0].length - raw.length;
    const run = { start, end: start + raw.length, raw };
    if (quoted > 0 && overlaps(run, links.slice(0, quoted))) continue;
    const own = linkableLabel(raw, isLinkable);
    const link = extendRun ? extendRun(text, run, own, isLinkable)
      : own === null ? null : { start, end: start + own.length, path: own };
    if (link && !overlaps(link, links)) links.push(link);
  }
  return links.sort((a, b) => a.start - b.start);
}
