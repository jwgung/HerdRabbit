// How many terminal columns a string takes, as a terminal lays it out:
// East Asian Wide and Fullwidth characters and emoji take two, combining
// marks and invisible format characters none, everything else one. Read by
// grapheme, so a joined emoji (👩‍💻) is one two-column character.
//
// Stands in for Bun.stringWidth in the prompt readers ported from
// herdr-web-ui; public/terminal-widths.js is xterm's provider and needs xterm.

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}ᅠ-ᇿ​]$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}|️/u;

// East Asian Width W and F ranges (Unicode 15), the ones a pane shows.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function wideCodePoint(code) {
  let low = 0;
  let high = WIDE.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = WIDE[middle];
    if (code < start) high = middle - 1;
    else if (code > end) low = middle + 1;
    else return true;
  }
  return false;
}

export function graphemeWidth(segment) {
  const first = segment.codePointAt(0);
  if (first === undefined) return 0;
  if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0;
  if (ZERO_WIDTH.test(String.fromCodePoint(first)) && [...segment].length === 1) return 0;
  if (wideCodePoint(first)) return 2;
  // a text-presentation symbol made an emoji (❤️), or an emoji the table above has not caught
  if ([...segment].length > 1 && EMOJI_PRESENTATION.test(segment)) return 2;
  return 1;
}

export function stringWidth(text) {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(String(text))) width += graphemeWidth(segment);
  return width;
}

// Where terminal column `column` begins in `line`: an index into the string,
// or -1 when no character starts there (the column is the second half of a
// wide one).
export function indexAtColumn(line, column) {
  let width = 0;
  for (const { segment, index } of GRAPHEMES.segment(line)) {
    if (width === column) return index;
    width += graphemeWidth(segment);
  }
  return width === column ? line.length : -1;
}
