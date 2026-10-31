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
import { indexAtColumn, stringWidth } from "./text-width.mjs";

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
// The scope menu's line above its rows; only there is one row a menu. The
// chosen scope is in brackets; Kiro's s moves it to the next, round the line.
const SCOPE_RE = /^Scope:\s/u;

// The scope a menu's "Scope:" line has chosen and the one s moves it to, or null.
function scopeCycle(line) {
  if (!SCOPE_RE.test(line ?? "")) return null;
  const scopes = line.replace(SCOPE_RE, "").trim().split(/\s+/u);
  const at = scopes.findIndex((scope) => /^\[\S+\]$/u.test(scope));
  if (at < 0 || scopes.length < 2) return null;
  // a line cut off at the pane's edge ("work…", or a last scope gone) may
  // hide the next scope: only Kiro's three, whole, are cycled
  const name = (scope) => scope.replace(/^\[|\]$/gu, "");
  if (scopes.map(name).join(" ") !== "session workspace user") return null;
  return { current: name(scopes[at]), next: name(scopes[(at + 1) % scopes.length]) };
}
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

// Kiro's menu for its subagents' tool approvals, at the screen's end while it
// orchestrates them: right under a rule, "⚠ 1 tool approval pending", then a
// row per answer, "(a) Approve all pending", the cursor row " ❯ (a) …", any
// other "   (f) …", a row too long for the pane going on in further lines at
// the same indent. No hint line; the arrows move the ❯ and Enter picks. Kiro
// asks about one subagent's tool at a time; the agent list above the rule
// says which ("… general-task-execution WebFetch ⚠ tool approval needed").
const PENDING_RE = /^⚠ (\d+) tool approvals? pending$/u;
const PENDING_ROW_RE = /^ (?:(❯)| ) \(([a-z])\) (\S.*)$/u;
const PENDING_MORE_RE = /^ {3}(?!\([a-z]\) )\S/u;
// A row's further line follows a line the pane had no room left on: its
// first word would not have fitted after it, with this much slack (Kiro
// leaves at most 4 columns at the end of a wrapped row in the screens seen).
const WRAP_SLACK = 5;
const ORCHESTRATING_RE = /^• Orchestrating \(\d+ agents?\)$/u;
// An agent row of the list: "  • <task> <agent type> <status>", its marker a
// spinner while it works (the list's own "  esc to cancel" and "  ctrl+g …"
// lines have no marker and space before their words); its status, cut to a
// narrow column, goes on in lines indented to that column.
const AGENT_ROW_RE = /^ {2}\S (\S.*)$/u;
const AGENT_MORE_RE = /^ {8,}\S/u;

// Whether `line` goes on from `previous`, the pane `width` wide: a word wrap.
function wrapsFrom(previous, line, width) {
  const word = line.trim().split(/\s+/u, 1)[0];
  return width - (stringWidth(previous) + 1 + stringWidth(word)) <= WRAP_SLACK;
}

// The agent rows above the rule that wait on a tool approval, or null: the
// card says which subagent and tool it is about, and another request in its
// place is another card. Each reads "<task> <agent type> <tool> ⚠ tool
// approval needed" whatever the pane's width: a narrow pane cuts the status to
// a column of its own, mid-word or at a word's end alike, so the status is read
// with its spaces taken out, and the tool is what comes before its ⚠. A pane
// too narrow for the status shows none.
function waitingAgents(lines, rule) {
  let start = rule - 1;
  while (start >= 0 && !ORCHESTRATING_RE.test(cleanLine(lines[start]))) start -= 1;
  if (start < 0) return null;
  const rows = [];
  for (let index = start + 1; index < rule; index += 1) {
    const raw = lines[index].replace(ANSI_RE, "").replace(/\s+$/u, "");
    if (AGENT_ROW_RE.test(raw)) {
      rows.push({ first: raw, pieces: [] });
    } else if (rows.length > 0 && AGENT_MORE_RE.test(raw)) {
      rows.at(-1).pieces.push(raw);
    }
  }
  const waiting = [];
  for (const { first, pieces } of rows) {
    let head;
    let status;
    if (pieces.length > 0) {
      // the status column starts where its further lines are indented
      const at = indexAtColumn(first, stringWidth(pieces[0].match(/^ */u)[0]));
      if (at < 0) continue;
      head = first.slice(0, at);
      status = [first.slice(at), ...pieces].join("");
    } else {
      const one = first.match(/^(.*?)\s(\S+\s*⚠\s*tool\s*approval\s*needed)$/u);
      if (!one) continue;
      [, head, status] = one;
    }
    const tool = status.replace(/\s+/gu, "").match(/^(.+?)⚠toolapprovalneeded$/u);
    if (!tool) continue;
    waiting.push(`${head.replace(AGENT_ROW_RE, "$1").replace(/\s+/gu, " ").trim()} ${tool[1]} ⚠ tool approval needed`);
  }
  return waiting.length > 0 ? waiting.join("\n") : null;
}

// The subagent approval card the screen ends with, or null.
function pendingApprovals(lines, shown) {
  const head = shown.findLast((index) => PENDING_RE.test(cleanLine(lines[index])));
  if (head === undefined) return null;
  // right under Kiro's rule, blank lines aside; the rule spans the pane
  let above = head - 1;
  while (above >= 0 && !cleanLine(lines[above])) above -= 1;
  if (above < 0 || !isDivider(lines[above])) return null;
  const width = stringWidth(lines[above].replace(ANSI_RE, "").replace(/\s+$/u, ""));
  // every line under it is a row or a row's further line: an answered menu
  // has output under it, and a card for it would send keys into Kiro's input
  const rows = [];
  let previous = null;
  for (const index of shown.filter((line) => line > head)) {
    const raw = lines[index].replace(ANSI_RE, "").replace(/\s+$/u, "");
    const row = raw.match(PENDING_ROW_RE);
    if (row) {
      rows.push({ key: row[2], label: row[3].trim(), selected: row[1] === "❯" });
    } else if (rows.length > 0 && index === previous + 1 && PENDING_MORE_RE.test(raw) && wrapsFrom(lines[previous].replace(ANSI_RE, "").replace(/\s+$/u, ""), raw, width)) {
      rows.at(-1).label = `${rows.at(-1).label} ${raw.trim()}`;
    } else {
      return null;
    }
    previous = index;
  }
  if (rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  if (new Set(rows.map((row) => row.key)).size !== rows.length) return null;
  const question = cleanLine(lines[head]).replace(/^⚠ /u, "");
  return finishPrompt("kiro", {
    kind: "approval",
    title: question,
    question,
    body: waitingAgents(lines, above),
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

// The card a Kiro screen shows, with the reader's bookkeeping, or null.
export function parseKiroPrompt(screen) {
  const text = String(screen ?? "");
  if (secretPrompt(text) !== null) return null;
  const lines = text.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  const pending = pendingApprovals(lines, shown);
  if (pending) return pending;
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
  const scopeLine = head.body?.split("\n").at(-1) ?? "";
  if (rows.length < 2 && !SCOPE_RE.test(scopeLine)) return null;
  const approval = APPROVAL_RE.test(head.question);
  // The scope menu's s, offered as one more option after the rows.
  const cycle = scopeCycle(scopeLine);
  const options = rows.map((row) => ({ label: row.label, description: row.description }));
  if (cycle) options.push({ label: "Change scope", description: `${cycle.current} → ${cycle.next}` });
  return finishPrompt("kiro", {
    kind: approval ? "approval" : "menu",
    title: head.question,
    question: head.question,
    body: head.body,
    options,
    multiSelect: false,
    customOptionIndex: null,
  }, {
    responder: "kiro-menu",
    menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [],
    customMenuIndex: null,
    ...(cycle ? { ownOptionSteps: { [rows.length]: [{ text: "s" }] } } : {}),
  });
}
