// Quoting terminal text into the composer as a Markdown block.

export const MAX_QUOTED_CHARS = 4000;

// Each line gets "> ", terminal padding is dropped from the line ends, and
// blank lines at the end go; text longer than `cap` is cut with "…". Ends with
// a blank line, so the message goes on below the quote. "" when nothing is left.
export function quoteBlock(text, cap = MAX_QUOTED_CHARS) {
  const lines = String(text).split(/\r\n|\r|\n/u).map((line) => line.trimEnd());
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  let body = lines.join("\n");
  if (!body.trim()) return "";
  if (body.length > cap) body = `${body.slice(0, cap - 1).trimEnd()}…`;
  return `${body.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
}

// The composer's value with the quote put in at the caret (or over the
// selection), set apart from the text before it by a blank line, and the caret
// after it. null when there is nothing to quote or the result would pass `limit`.
export function insertQuote(value, start, end, text, { limit = 8000, cap = MAX_QUOTED_CHARS } = {}) {
  const block = quoteBlock(text, cap);
  if (!block) return null;
  const from = Number.isInteger(start) ? Math.min(Math.max(start, 0), value.length) : value.length;
  const to = Number.isInteger(end) ? Math.min(Math.max(end, from), value.length) : from;
  const before = value.slice(0, from);
  const gap = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const inserted = gap + block;
  const next = before + inserted + value.slice(to);
  if (next.length > limit) return null;
  return { value: next, caret: before.length + inserted.length };
}
