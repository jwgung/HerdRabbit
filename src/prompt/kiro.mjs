// Kiro CLI's menus read off its pane's screen: a tool approval ("… requires
// approval", then Allow once / Deny once / the rule rows) and its other
// arrow-key menus (trusting a workspace). Kiro draws the rows unnumbered, the
// cursor row marked ❯, with a hint under them ("esc to close · ↑↓ to navigate
// · ↵ to select"). Each row is answered as the terminal's user picks it: the
// arrows move the ❯ onto it, then Enter (screen.mjs's answerSteps).
//
// Recorded from Kiro CLI on 2026-10-29 and 2026-10-30 (test/fixtures/kiro-prompt.mjs).
// The shared fallback card read these screens by their hint line only, and
// offered the bare arrow keys instead of the rows. On a phone-width pane Kiro
// breaks a long row, its hint and the note under it on to further lines, and
// on a rule row its hint is "esc to close · Enter to see more options".
// Enter on a rule row opens the rule's scope menu ("Create allow rule: …",
// "Scope: [session] workspace user"): its rows have a second column (what the
// rule matches, its scope), a tool with one rule has one row, and its hint
// keeps "esc to go back" in a column of its own.
import { secretPrompt } from "../secret-prompt.mjs";
import { ANSI_RE, cleanLine, finishPrompt, isDivider } from "./screen.mjs";

// The hint under every Kiro menu, or the first line of it on a narrow pane.
const HINT_RE = /^esc to \S+.*\b(?:to navigate|to select|to see more options)\b/u;
// The hint's further lines on a narrow pane: right under it, indented, made
// of the hint's own words, at most two of them, and only while the hint has
// not ended.
const HINT_MORE_RE = /^ +(?:(?:[↑↓↵·]+|Tab|Enter|to|edit|select|navigate|see|more|options|go|back|s|cycle|scope)(?: +|$))+$/u;
const HINT_MORE_LINES = 2;
// A hint's last words: one that ends so has no further lines. The scope menu's
// hint ("esc to go back …") goes on past "to select" ("· s to cycle scope · Tab
// to edit"); every other hint has ended there.
const HINT_END_RE = /\b(?:select|edit|options)$/u;
const SCOPE_HINT_END_RE = /\b(?:edit|options)$/u;
const SCOPE_HINT_RE = /^esc to go\b/u;
// A row's second column, after a wide gap: what a rule matches, its scope.
const COLUMN_GAP_RE = / {3,}/u;
// The scope menu's line above its rows; only there is one row a menu.
const SCOPE_RE = /^Scope:\s/u;
// A row's further lines on a narrow pane are indented as rows are, and go on
// mid-sentence; a row of its own starts with a capital ("Allow once").
const ROW_MORE_RE = /^\p{Ll}/u;
// A menu row: the cursor row " ❯ Label", any other "   Label". The lines
// above the rows (" shell → echo probe") sit one column further left.
const ROW_RE = /^ {0,2}(❯) +(\S.*)$|^ {3,6}(\S.*)$/u;
const APPROVAL_RE = /\brequires approval$/u;
// Lines a menu may keep under its hint: the trust menu says where to revoke it,
// in a note that ends with a file's path, and on a narrow pane that path goes
// on in pieces (no spaces) right under it, a few at most, until it ends.
const AFTER_HINT_RE = /^Revoke later\b/u;
const NOTE_MORE_RE = /^\S+$/u;
const NOTE_MORE_LINES = 3;
const NOTE_END_RE = /\/\S*\.yaml$/u;
// Read from at most this many lines above the hint.
const MENU_LINES = 48;

// The rows right above `end` (the hint, or the rule before it), oldest first.
function menuRows(lines, end) {
  const rows = [];
  for (let index = end - 1; index >= Math.max(0, end - MENU_LINES); index -= 1) {
    const raw = lines[index].replace(ANSI_RE, "").replace(/\s+$/u, "");
    const match = raw.match(ROW_RE);
    if (!match) break;
    const [label, ...columns] = (match[2] ?? match[3]).trim().split(COLUMN_GAP_RE);
    rows.unshift({ label, description: columns.length ? columns.join(" · ") : null, selected: match[1] === "❯", lineIndex: index });
  }
  // A row broken over two lines is one row: its second line goes on in lower
  // case, or, where rows have a second column, comes without one.
  // A line that starts as the menu's rows do ("Trust …", "Deny …") is a row.
  const rowWord = (label) => label.split(" ", 1)[0];
  const firstWord = rows.length ? rowWord(rows[0].label) : null;
  const joined = [];
  for (const row of rows) {
    const previous = joined.at(-1);
    const columnless = previous?.description !== null && row.description === null && rowWord(row.label) !== firstWord;
    const more = previous && !row.selected && (ROW_MORE_RE.test(row.label) || columnless);
    if (more) previous.label = `${previous.label} ${row.label}`;
    else joined.push(row);
  }
  return joined;
}

// Whether the shown lines under the hint (`after`, line indices) are only the
// menu's own: the hint's further lines, then the trust menu's note and its
// further lines.
function menuOwnsEnd(lines, hintIndex, after) {
  let index = 0;
  let hint = cleanLine(lines[hintIndex]);
  const ends = SCOPE_HINT_RE.test(hint) ? SCOPE_HINT_END_RE : HINT_END_RE;
  let last = hintIndex;
  while (index < after.length && index < HINT_MORE_LINES && after[index] === last + 1 && !ends.test(hint)) {
    const raw = lines[after[index]].replace(ANSI_RE, "").replace(/\s+$/u, "");
    if (!HINT_MORE_RE.test(raw)) break;
    hint = cleanLine(raw);
    last = after[index];
    index += 1;
  }
  if (index === after.length) return true;
  let note = cleanLine(lines[after[index]]);
  if (!AFTER_HINT_RE.test(note)) return false;
  last = after[index];
  let pieces = 0;
  for (const line of after.slice(index + 1)) {
    const piece = cleanLine(lines[line]);
    if (NOTE_END_RE.test(note) || pieces === NOTE_MORE_LINES || line !== last + 1 || !NOTE_MORE_RE.test(piece)) return false;
    note += piece;
    last = line;
    pieces += 1;
  }
  return NOTE_END_RE.test(note);
}

// The lines above the rows up to a rule: the question and what it is about.
// A one-line section between the two rules above heads the menu (the trust
// menu's "Trust this workspace?"); else the section's first line does.
function heading(lines, rowsStart) {
  const block = [];
  let index = rowsStart - 1;
  for (; index >= Math.max(0, rowsStart - MENU_LINES); index -= 1) {
    if (isDivider(lines[index])) break;
    const line = cleanLine(lines[index]);
    if (line) block.unshift(line);
  }
  const titled = [];
  if (index >= 0 && isDivider(lines[index])) {
    for (let above = index - 1; above >= Math.max(0, index - 4); above -= 1) {
      if (isDivider(lines[above])) break;
      const line = cleanLine(lines[above]);
      if (line) titled.unshift(line);
    }
  }
  if (titled.length === 1 && /\?$/u.test(titled[0]) && !APPROVAL_RE.test(block[0] ?? "")) {
    return { question: titled[0], body: block.join("\n") || null };
  }
  if (block.length === 0) return null;
  return { question: block[0], body: block.slice(1).join("\n") || null };
}

// The card a Kiro screen shows, with the reader's bookkeeping, or null.
export function parseKiroPrompt(screen) {
  const text = String(screen ?? "");
  if (secretPrompt(text) !== null) return null;
  const lines = text.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  const hintIndex = shown.findLast((index) => HINT_RE.test(cleanLine(lines[index])));
  if (hintIndex === undefined) return null;
  // the menu must still own the screen's end: an answered one sits above later output
  if (!menuOwnsEnd(lines, hintIndex, shown.filter((index) => index > hintIndex))) return null;
  let end = hintIndex;
  while (end > 0 && (isDivider(lines[end - 1]) || !cleanLine(lines[end - 1]))) end -= 1;
  const rows = menuRows(lines, end);
  if (rows.length === 0 || rows.filter((row) => row.selected).length !== 1) return null;
  const head = heading(lines, rows[0].lineIndex);
  if (!head) return null;
  if (rows.length < 2 && !SCOPE_RE.test(head.body?.split("\n").at(-1) ?? "")) return null;
  const approval = APPROVAL_RE.test(head.question);
  return finishPrompt("kiro", {
    kind: approval ? "approval" : "menu",
    title: head.question,
    question: head.question,
    body: head.body,
    options: rows.map((row) => ({ label: row.label, description: row.description })),
    multiSelect: false,
    customOptionIndex: null,
  }, {
    responder: "kiro-menu",
    menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [],
    customMenuIndex: null,
  });
}
