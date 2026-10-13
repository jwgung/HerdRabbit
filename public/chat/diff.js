// A line diff between an edit's old and new text, as a reader wants it on a
// narrow screen: unchanged lines once, removed and added lines in place.
//
// Ported from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- src/lib/diff.ts.

// Past this many line pairs the table costs more than it shows: removed, then added.
const MAX_CELLS = 250_000;

// [{ kind: "same" | "del" | "add", text }]
export function lineDiff(before, after) {
  const a = before === "" ? [] : String(before).split("\n");
  const b = after === "" ? [] : String(after).split("\n");
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ kind: "del", text })), ...b.map((text) => ({ kind: "add", text }))];
  }
  // longest common subsequence, from the end, so the walk below goes forward
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) lines.push({ kind: "del", text: a[i++] });
    else lines.push({ kind: "add", text: b[j++] });
  }
  while (i < a.length) lines.push({ kind: "del", text: a[i++] });
  while (j < b.length) lines.push({ kind: "add", text: b[j++] });
  return lines;
}
