// Kiro CLI's menus read off its pane's screen: a tool approval ("… requires
// approval", then Allow once / Deny once / the rule rows) and its other
// arrow-key menus (trusting a workspace). Kiro draws the rows unnumbered, the
// cursor row marked ❯, with a hint under them ("esc to close · ↑↓ to navigate
// · ↵ to select"). Each row is answered as the terminal's user picks it: the
// arrows move the ❯ onto it, then Enter (screen.mjs's answerSteps).
//
// Recorded from Kiro CLI on 2026-10-29 (test/fixtures/kiro-prompt.mjs). The
// shared fallback card read these screens by their hint line only, and offered
// the bare arrow keys instead of the rows.
import { secretPrompt } from "../secret-prompt.mjs";
import { ANSI_RE, cleanLine, finishPrompt, isDivider } from "./screen.mjs";

// The hint under every Kiro menu.
const HINT_RE = /\bto navigate\b.*\bto select\b/u;
// A menu row: the cursor row " ❯ Label", any other "   Label". The lines
// above the rows (" shell → echo probe") sit one column further left.
const ROW_RE = /^ {0,2}(❯) +(\S.*)$|^ {3,6}(\S.*)$/u;
const APPROVAL_RE = /\brequires approval$/u;
// Lines a menu may keep under its hint: the trust menu says where to revoke it.
const AFTER_HINT_RE = /^Revoke later\b/u;
// Read from at most this many lines above the hint.
const MENU_LINES = 48;

// The rows right above `end` (the hint, or the rule before it), oldest first.
function menuRows(lines, end) {
  const rows = [];
  for (let index = end - 1; index >= Math.max(0, end - MENU_LINES); index -= 1) {
    const raw = lines[index].replace(ANSI_RE, "").replace(/\s+$/u, "");
    const match = raw.match(ROW_RE);
    if (!match) break;
    rows.unshift({ label: (match[2] ?? match[3]).trim(), selected: match[1] === "❯", lineIndex: index });
  }
  return rows;
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
  const after = shown.filter((index) => index > hintIndex);
  if (after.length > 1 || after.some((index) => !AFTER_HINT_RE.test(cleanLine(lines[index])))) return null;
  let end = hintIndex;
  while (end > 0 && (isDivider(lines[end - 1]) || !cleanLine(lines[end - 1]))) end -= 1;
  const rows = menuRows(lines, end);
  if (rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const head = heading(lines, rows[0].lineIndex);
  if (!head) return null;
  const approval = APPROVAL_RE.test(head.question);
  return finishPrompt("kiro", {
    kind: approval ? "approval" : "menu",
    title: head.question,
    question: head.question,
    body: head.body,
    options: rows.map((row) => ({ label: row.label, description: null })),
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
