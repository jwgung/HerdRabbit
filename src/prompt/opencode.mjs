// OpenCode's interactive prompts read off its pane's screen: a permission
// request (Allow once / Allow always / Reject), the "Always allow" check that
// follows Allow always, the message a subagent's rejection asks for, a
// question from its `question` tool (one choice or several, a typed answer)
// and the review that submits several answers. Each becomes a card with the
// keys that answer it (screen.mjs).
//
// What is read follows OpenCode 1.18.34's TUI (github.com/anomalyco/opencode,
// tag v1.18.34): packages/tui/src/routes/session/permission.tsx and
// question.tsx. Both draw a panel with a heavy left bar (┃, SplitBorder) at
// the bottom of the session in place of the input box.
//
// The permission buttons sit in a row, and the one selected is told apart only
// by its colour: its background is the theme's warning colour, the colour the
// panel's "△" is drawn in. So OpenCode's screen is read with its styles
// (ansi) and the selected button found by that colour. Read without styles,
// the card still shows and Reject (Esc) still answers, but nothing that needs
// the cursor moved.
//
// The question rows are told apart by colour too, but each takes its own
// digit (1-9), so they are answered by number and the cursor never matters.
//
// A dialog open over the session (ctrl+p's commands, the session list, the
// model picker, ...) takes every key while the panel only dims under it: no
// card then, nor the fallback (opencodeDialogOpen). Checked on 1.18.34: the
// panel's words and colours stay readable (dimmed) under such a dialog; the
// dialog's title row ends in "esc", its search box ("Search" until something
// is typed there) is two rows under it, and the dialog is a box of its own
// background over the dimmed session.
import { secretPrompt } from "../secret-prompt.mjs";
import {
  ANSI_RE,
  HORIZONTAL,
  InvalidAnswer,
  KEY,
  finishPrompt,
  keySteps,
  menuRows,
  normalizeText,
  sequentialRows,
} from "./screen.mjs";

// the panel's left bar, and a line of it with nothing else
const BAR_RE = /^\s*┃ ?/u;
// Whether a raw line is drawn with such a bar (a panel's, or a message box's).
const inPanel = (rawLine) => BAR_RE.test(String(rawLine ?? "").replace(ANSI_RE, ""));

const PERMISSION_HEADER_RE = /^△\s+Permission required$/u;
const ALWAYS_HEADER_RE = /^△\s+Always allow$/u;
const REJECT_HEADER_RE = /^△\s+Reject permission$/u;
const PERMISSION_BUTTONS = Object.freeze(["Allow once", "Allow always", "Reject"]);
const ALWAYS_BUTTONS = Object.freeze(["Confirm", "Cancel"]);
// "ctrl+f fullscreen  ⇆ select  enter confirm": the buttons' hints, on their
// row or (a pane under 80 columns) on a row of their own under it
const BUTTON_HINT_RE = /⇆\s+select\s+enter\s+confirm\b/u;
const REJECT_HINT_RE = /enter\s+confirm\s+esc\s+cancel\s*$/u;
const REJECT_ASK = "Tell OpenCode what to do differently";
// the icon before a permission's title (permission.tsx's info())
const TITLE_ICON_RE = /^[→✱#%◈←⟳⚙]\s+/u;
// An open dialog's title row: its title, then "esc" at its right edge
// ("Commands … esc", "Sessions … esc", "Select model … esc"), and maybe the
// session's scrollbar beside it. Not one of a panel's (┃) rows.
const DIALOG_TITLE_RE = /^\s*\S.*\S\s{2,}esc$/u;
// the dialog's search box before anything is typed in it
const DIALOG_SEARCH = "Search";
const SCROLLBAR_RE = /\s+[█▐▌▕│]$/u;
// text without its spaces, to compare words a narrow pane wrapped
const squash = (value) => String(value ?? "").replace(/\s+/gu, "");

// A question's hints: "⇆ tab" when it has tabs (several questions, or one
// that takes several answers), "↑↓ select", what Enter does, "esc dismiss".
const QUESTION_HINT_RE = /(?:⇆\s+tab\s+)?↑↓\s+select\s+enter\s+(submit|confirm|toggle)\s+esc\s+dismiss\s*$/u;
const REVIEW_HINT_RE = /⇆\s+tab\s+enter\s+submit\s+esc\s+dismiss\s*$/u;
const MULTIPLE_RE = /\s*\(select all that apply\)$/u;
// the row that takes a typed answer (" ✓" once one was typed there)
const CUSTOM_RE = /^Type your own answer(?:\s+✓)?$/u;
// the rows a digit picks: 1 to 9
const MAX_DIGIT_ROWS = 9;

// ---------------------------------------------------------------------------
// The screen, its text and its colours.

const SGR_RE = /^\u001b\[([0-9;:]*)m/u;
const CSI_RE = /^\u001b\[[0-?]*[ -/]*[@-~]/u;

// One raw line's text (escapes gone) with each character's foreground and
// background as written ("" for the default), index for index with the text.
export function styledLine(raw) {
  let fg = "";
  let bg = "";
  let inverse = false;
  let text = "";
  const fgs = [];
  const bgs = [];
  for (let at = 0; at < raw.length;) {
    if (raw[at] === "\u001b") {
      const sgr = SGR_RE.exec(raw.slice(at));
      if (sgr) {
        const params = sgr[1].split(/[;:]/u).map((value) => (value === "" ? 0 : Number(value)));
        for (let index = 0; index < params.length; index += 1) {
          const code = params[index];
          if (code === 0) { fg = ""; bg = ""; inverse = false; }
          else if (code === 7) inverse = true;
          else if (code === 27) inverse = false;
          else if (code === 39) fg = "";
          else if (code === 49) bg = "";
          // the 16 colours as the 256-colour numbers they are: 30-37 → 0-7, bright 90-97 → 8-15
          else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = `c${code >= 90 ? code - 90 + 8 : code - 30}`;
          else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = `c${code >= 100 ? code - 100 + 8 : code - 40}`;
          else if (code === 38 || code === 48) {
            let color = "";
            if (params[index + 1] === 5) { color = `c${params[index + 2]}`; index += 2; }
            else if (params[index + 1] === 2) { color = `#${params.slice(index + 2, index + 5).join(",")}`; index += 4; }
            if (code === 38) fg = color; else bg = color;
          }
        }
        at += sgr[0].length;
        continue;
      }
      const other = CSI_RE.exec(raw.slice(at));
      at += other ? other[0].length : 1;
      continue;
    }
    text += raw[at];
    fgs.push(inverse ? bg : fg);
    bgs.push(inverse ? fg : bg);
    at += 1;
  }
  return { text, fgs, bgs };
}

// The screen's lines, raw and as text without the panel's bar (and their
// right ends trimmed).
function screenLines(screen) {
  const raw = String(screen ?? "").split(/\r?\n/u);
  const lines = raw.map((line) => line.replace(ANSI_RE, "").replace(BAR_RE, "").replace(/\s+$/u, ""));
  return { raw, lines };
}

// Lines with text, and their indices.
function shownIndices(lines) {
  return lines.flatMap((line, index) => (line.trim() ? [index] : []));
}

// Whether `index` is among the screen's last `count` lines with text: the
// panel draws at the bottom, so a prompt above later output is an old one.
function nearEnd(lines, index, count = 3) {
  return shownIndices(lines).slice(-count).includes(index);
}

// Whether a dialog is open over the session: its keys are the dialog's. A
// title row ending in "esc" is not enough (a line of output, a command or a
// diff in a panel can end so too): the dialog's search box is two rows under
// it (a blank row between), at the title's column, or (its text typed over) the title sits on a box of
// its own background that goes on down under it.
function dialogOpen(raw) {
  const plainLine = (index) => String(raw[index] ?? "").replace(ANSI_RE, "").replace(/\s+$/u, "").replace(SCROLLBAR_RE, "");
  for (let index = 0; index < raw.length; index += 1) {
    if (inPanel(raw[index])) continue;
    const title = plainLine(index);
    if (!DIALOG_TITLE_RE.test(title)) continue;
    const column = title.search(/\S/u);
    const searched = !inPanel(raw[index + 2]) && !plainLine(index + 1).trim()
      && plainLine(index + 2).trim() === DIALOG_SEARCH && plainLine(index + 2).search(/\S/u) === column;
    if (searched || onDialogBox(raw, index, column, title.length - 1)) return true;
  }
  return false;
}

// Whether the title row's text, from `column` to its "esc" at `end`, sits on
// one background unlike the row's left edge, and the row under it has that
// background at the title's column: the dialog's box. Read without styles, no.
function onDialogBox(raw, index, column, end) {
  const row = styledLine(raw[index]);
  const box = row.bgs[column];
  if (!box || box === row.bgs[0] || row.bgs[end] !== box) return false;
  const under = typeof raw[index + 1] === "string" ? styledLine(raw[index + 1]) : null;
  return Boolean(under) && under.bgs[column] === box && under.bgs[0] !== box;
}

// Whether `screen` has a dialog open over OpenCode's session: its keys
// (Enter runs the dialog's highlighted entry) are the dialog's, so no card is
// shown for it at all, not even the fallback.
export function opencodeDialogOpen(screen) {
  return dialogOpen(screenLines(String(screen ?? "")).raw);
}

// The button selected in a row of buttons, by colour: the one button whose
// background is the colour of the panel's "△" (the theme's warning colour).
// Null when the colours do not tell: no colour on "△", or not one button on it.
// (On 1.18.34 the two match exactly, dimmed under a dialog too; no guess is
// made from a background merely unlike the others'.)
export function selectedButton(rawRow, labels, rawHeader) {
  const row = styledLine(rawRow);
  const header = typeof rawHeader === "string" ? styledLine(rawHeader) : null;
  const warning = header ? header.fgs[header.text.indexOf("△")] ?? "" : "";
  if (!warning) return null;
  let from = 0;
  const backgrounds = [];
  for (const label of labels) {
    const at = row.text.indexOf(label, from);
    if (at < 0) return null;
    backgrounds.push(row.bgs[at]);
    from = at + label.length;
  }
  const marked = backgrounds.flatMap((bg, index) => (bg === warning ? [index] : []));
  return marked.length === 1 ? marked[0] : null;
}

// ---------------------------------------------------------------------------
// Permissions.

// A row of buttons after `start`: the labels in order, at the row's start.
function buttonRow(lines, start, labels) {
  const re = new RegExp(`^\\s*${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+")}(?:\\s|$)`, "u");
  for (let index = start; index < lines.length; index += 1) {
    if (re.test(lines[index])) return index;
  }
  return -1;
}

// The hints that end the panel: on the button row or on the row after it.
function hintAfter(lines, rowIndex, re) {
  const next = shownIndices(lines).find((index) => index > rowIndex);
  if (re.test(lines[rowIndex])) return rowIndex;
  return next !== undefined && re.test(lines[next]) ? next : -1;
}

// The text between two rows, its blank lines at either end dropped and the
// indent the panel gives it taken off.
function block(lines, from, to) {
  const part = lines.slice(from, to);
  while (part.length && !part[0].trim()) part.shift();
  while (part.length && !part.at(-1).trim()) part.pop();
  const indent = Math.min(...part.filter((line) => line.trim()).map((line) => line.search(/\S/u)));
  return part.map((line) => line.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/u, "")).join("\n").replace(/\n{3,}/gu, "\n\n");
}

function lastHeader(lines, re) {
  return lines.findLastIndex((line) => re.test(line.trim()));
}

// "△ Permission required", what it is for ("# Shell command"), what it would
// do ("$ npm test", a diff, a path or patterns), then Allow once / Allow
// always / Reject. Esc is Reject; Allow always opens the "Always allow" check.
function parsePermission(raw, lines) {
  const header = lastHeader(lines, PERMISSION_HEADER_RE);
  if (header < 0) return null;
  const row = buttonRow(lines, header + 1, PERMISSION_BUTTONS);
  if (row < 0) return null;
  const hint = hintAfter(lines, row, BUTTON_HINT_RE);
  if (hint < 0 || !nearEnd(lines, hint)) return null;
  // the title: the line under the header, and what it wraps onto
  const titleLines = [];
  let at = header + 1;
  for (; at < row && lines[at].trim(); at += 1) titleLines.push(lines[at].trim());
  const question = normalizeText(titleLines.join(" ")).replace(TITLE_ICON_RE, "") || "Permission required";
  const body = block(lines, at, row);
  const selectedIndex = selectedButton(raw[row], PERMISSION_BUTTONS, raw[header]);
  return finishPrompt("opencode", {
    kind: "approval", title: "Permission required", question, body: body || null,
    options: PERMISSION_BUTTONS.map((label) => ({ label, description: null })), multiSelect: false, customOptionIndex: null,
  }, {
    responder: "opencode-permission", menuLabels: [...PERMISSION_BUTTONS], selectedIndex, checkedOptionIndices: [],
    customMenuIndex: null, moveKeys: HORIZONTAL,
    // Esc is the prompt's Reject, wherever the selection is
    rejectWithEscapeIndex: 2,
  });
}

// After Allow always: "△ Always allow", what it allows ("This will allow bash
// until OpenCode is restarted.", or the patterns), Confirm / Cancel. Esc cancels.
function parseAlways(raw, lines) {
  const header = lastHeader(lines, ALWAYS_HEADER_RE);
  if (header < 0) return null;
  const row = buttonRow(lines, header + 1, ALWAYS_BUTTONS);
  if (row < 0) return null;
  const hint = hintAfter(lines, row, BUTTON_HINT_RE);
  if (hint < 0 || !nearEnd(lines, hint)) return null;
  const text = block(lines, header + 1, row);
  const [said, ...rest] = text.split(/\n\s*\n/u);
  const question = normalizeText(said ?? "") || "Always allow";
  return finishPrompt("opencode", {
    kind: "approval", title: "Always allow", question, body: rest.join("\n\n").trim() || null,
    options: ALWAYS_BUTTONS.map((label) => ({ label, description: null })), multiSelect: false, customOptionIndex: null,
  }, {
    responder: "opencode-always", menuLabels: [...ALWAYS_BUTTONS],
    selectedIndex: selectedButton(raw[row], ALWAYS_BUTTONS, raw[header]), checkedOptionIndices: [],
    customMenuIndex: null, moveKeys: HORIZONTAL, rejectWithEscapeIndex: 1,
  });
}

// A subagent's permission rejected: "△ Reject permission", "Tell OpenCode
// what to do differently", a text box, "enter confirm  esc cancel". Enter
// rejects with what the box holds; Esc goes back to the permission. A box
// that already holds words typed in the terminal is left to the terminal.
function rejectBox(lines) {
  const header = lastHeader(lines, REJECT_HEADER_RE);
  if (header < 0) return null;
  const ask = lines.findIndex((line, index) => index > header && line.trim() === REJECT_ASK);
  if (ask < 0) return null;
  const hint = lines.findLastIndex((line) => REJECT_HINT_RE.test(line));
  if (hint <= ask || !nearEnd(lines, hint)) return null;
  // the box: the words before the hints on their row (wide), or the rows between (narrow)
  return [...lines.slice(ask + 1, hint), lines[hint].replace(REJECT_HINT_RE, "")].map((line) => line.trim()).filter(Boolean).join(" ");
}

// Whether `screen` still shows the Reject panel with exactly `text` in its
// box: what a typed message waits on before its Enter goes.
function rejectHolds(screen, text) {
  const { raw, lines } = screenLines(String(screen ?? ""));
  if (dialogOpen(raw)) return false;
  const typed = rejectBox(lines);
  return typeof typed === "string" && typed.length > 0 && squash(typed) === squash(text);
}

function parseReject(_raw, lines) {
  const typed = rejectBox(lines);
  if (typed === null || typed.length > 0) return null;
  return finishPrompt("opencode", {
    kind: "approval", title: "Reject permission", question: REJECT_ASK, body: null,
    options: [
      { label: "Reject without a message", description: null },
      { label: "Back to the permission", description: null },
    ],
    multiSelect: false, customOptionIndex: 2,
  }, {
    responder: "opencode-reject", menuLabels: ["Reject without a message", "Back to the permission"], selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: 2,
    optionSteps: [keySteps([KEY.enter]), keySteps([KEY.escape])],
    // the box has the focus: the message is typed into it and Enter sends it
    customSteps: (text) => [{ text }, ...keySteps([KEY.enter])],
    // each key goes only while this panel is on screen (and the Enter only
    // while its box holds the message): else OpenCode's own input takes them
    checksEachStep: true, holdsText: rejectHolds,
  });
}

// ---------------------------------------------------------------------------
// Questions.

// The digit that picks a row (the row's own number, 1 to 9).
function digitKey(index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_DIGIT_ROWS) {
    throw new InvalidAnswer("Only the first nine options can be answered from here. Answer in the terminal.");
  }
  return String(index + 1);
}

// the questions' tabs: each header, then "Confirm"
const TAB_ROW_RE = /\S\s{2,}Confirm$/u;

// The bar's colours on a raw line ("" for none): a panel's own bar is drawn
// in one colour on one background, a message box's above it in others.
function barStyle(rawLine) {
  const line = styledLine(String(rawLine ?? ""));
  const at = line.text.indexOf("┃");
  return at < 0 ? null : `${line.fgs[at]}/${line.bgs[at]}`;
}

// The question: its paragraphs above the first row, each the lines it wraps
// onto, up to the panel's top (or its row of tabs). Paragraphs are kept apart
// by a blank line; without the panel's bar only the nearest one is taken. A
// line with a bar is the panel's only when its bar is drawn as the first
// row's is and the session's scrollbar is not at its end: a message box in
// the conversation right above the panel has a bar too.
function questionAbove(raw, lines, firstRow) {
  const bar = barStyle(raw[firstRow]);
  const inThis = (index) => index >= 0 && inPanel(raw[index]) && !SCROLLBAR_RE.test(lines[index]) && barStyle(raw[index]) === bar;
  const paragraphs = [];
  let at = firstRow - 1;
  while (at >= 0 && firstRow - at <= 40) {
    // the blank lines between: the panel's own, once a paragraph is in
    for (; at >= 0 && !lines[at].trim(); at -= 1) {
      if (paragraphs.length > 0 && !inThis(at)) return paragraphs.join("\n\n");
    }
    if (at < 0 || TAB_ROW_RE.test(lines[at].trim())) break;
    if (paragraphs.length > 0 && !inThis(at)) break;
    const paragraph = [];
    for (; at >= 0 && lines[at].trim() && (paragraphs.length === 0 || inThis(at)); at -= 1) paragraph.unshift(lines[at].trim());
    paragraphs.unshift(normalizeText(paragraph.join(" ")));
    if (!inThis(at + 1)) break;
  }
  return paragraphs.join("\n\n");
}

// "Which format?" (" (select all that apply)" for several answers), its rows
// "1. ONNX" with their descriptions under them, "N. Type your own answer"
// unless the question forbids one, then the hints. Several questions (or one
// with several answers) have a row of tabs above, the last "Confirm".
function parseQuestion(raw, lines) {
  const hint = lines.findLastIndex((line) => QUESTION_HINT_RE.test(line.trim()));
  if (hint < 0 || !nearEnd(lines, hint)) return null;
  const [, enter] = lines[hint].trim().match(QUESTION_HINT_RE);
  const rows = menuRows(lines, Math.max(0, hint - 64), hint);
  if (!sequentialRows(rows) || rows.length < 1) return null;
  const multiple = enter === "toggle";
  const custom = CUSTOM_RE.test(rows.at(-1).label);
  // A line under "Type your own answer" is its text box open (keys there are
  // typed, not picked) or an answer typed before: left to the terminal.
  if (custom && rows.at(-1).description) return null;
  let question = questionAbove(raw, lines, rows[0].lineIndex);
  if (!question) return null;
  const marked = MULTIPLE_RE.test(question);
  question = question.replace(MULTIPLE_RE, "");
  if (marked !== multiple) return null;
  // Rows a digit cannot reach (a tenth or later) cannot be answered from a
  // card: the terminal (or the fallback card) takes such a question whole
  // rather than a card that offers what it cannot send. A typed answer among
  // several ticks is left to the terminal too; the card offers the ticks.
  if (rows.length > MAX_DIGIT_ROWS) return null;
  const choices = custom ? rows.slice(0, -1) : rows;
  // a question answered before (its tab visited again) marks the pick with " ✓"
  const options = choices.map((row) => ({ label: row.label.replace(/\s+✓$/u, ""), description: row.description ?? null }));
  const typed = custom && !multiple;
  return finishPrompt("opencode", {
    kind: "question", title: "Question", question, body: null, options,
    multiSelect: multiple, customOptionIndex: typed ? options.length : null,
  }, {
    responder: "opencode-question", menuLabels: rows.map((row) => row.label),
    // the rows are picked by number: where the cursor is does not matter
    selectedIndex: null,
    checkedOptionIndices: multiple ? choices.flatMap((row, index) => (row.checked ? [index] : [])) : [],
    customMenuIndex: typed ? rows.length - 1 : null,
    pickKey: digitKey,
    // "Type your own answer" by its digit opens its text box; Enter sends what is typed there
    customSteps: (text) => [...keySteps([digitKey(rows.length - 1)]), { text }, ...keySteps([KEY.enter])],
  });
}

// The questions' last tab: "Review", each question's header and answer, then
// "⇆ tab  enter submit  esc dismiss". Enter submits them all; Esc dismisses.
function parseReview(_raw, lines) {
  const hint = lines.findLastIndex((line) => REVIEW_HINT_RE.test(line.trim()));
  if (hint < 0 || !nearEnd(lines, hint)) return null;
  const review = lines.findLastIndex((line, index) => index < hint && line.trim() === "Review");
  if (review < 0 || hint - review > 40) return null;
  const body = lines.slice(review + 1, hint).map((line) => line.trim()).filter(Boolean).join("\n");
  if (!body) return null;
  return finishPrompt("opencode", {
    kind: "question", title: "Review your answers", question: "Submit these answers?", body,
    options: [{ label: "Submit answers", description: null }, { label: "Dismiss", description: null }],
    multiSelect: false, customOptionIndex: null,
  }, {
    responder: "opencode-review", menuLabels: ["Submit answers", "Dismiss"], selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null,
    optionSteps: [keySteps([KEY.enter]), keySteps([KEY.escape])],
    checksEachStep: true,
  });
}

// The card an OpenCode screen shows, with the reader's bookkeeping, or null.
// `screen` is best read with its styles (ansi): the permission's selected
// button is known only by its colour.
export function parseOpencodePrompt(screen) {
  const text = String(screen ?? "");
  if (secretPrompt(text.replace(ANSI_RE, "")) !== null) return null;
  const { raw, lines } = screenLines(text);
  if (dialogOpen(raw)) return null;
  for (const parse of [parsePermission, parseAlways, parseReject, parseQuestion, parseReview]) {
    const card = parse(raw, lines);
    if (card) return card;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The question's whole words, from OpenCode's database.

const MAX_LINE = 4 * 1024;
const capped = (value, limit) => (value.length > limit ? `${value.slice(0, limit)}…` : value);
// whether the screen's (wrapped, maybe cut) words are the call's: an option's
// label from its start, the question anywhere in it (its paragraphs above may
// be cut off by the panel's top)
const shows = (screenText, full) => {
  const shown = squash(screenText).replace(/…$/u, "");
  return shown.length > 0 && squash(full).startsWith(shown);
};
const showsQuestion = (screenText, full) => {
  const shown = squash(screenText).replace(/…$/u, "");
  return shown.length > 0 && squash(full).includes(shown);
};

// A question card with the words of the `question` tool call that waits (its
// input: { questions: [{ question, header, options: [{ label, description }],
// multiple, custom }] }), when the question on screen is one of them and every
// option on screen is that question's, at its place. Otherwise the card as it is.
export function fillOpencodeCard(card, ask) {
  if (!card || card.agent !== "opencode" || card.kind !== "question" || !ask || ask.name !== "question") return card;
  const questions = Array.isArray(ask.input?.questions) ? ask.input.questions : [];
  const asked = questions.find((item) => item && typeof item.question === "string" && Array.isArray(item.options) && showsQuestion(card.question, item.question));
  if (!asked) return card;
  if (asked.options.length !== card.options.length) return card;
  const options = [];
  for (const [index, option] of card.options.entries()) {
    const full = asked.options[index];
    if (!full || typeof full.label !== "string" || !shows(option.label, full.label)) return card;
    const description = typeof full.description === "string" && full.description ? capped(full.description, MAX_LINE) : option.description;
    options.push({ label: capped(full.label, MAX_LINE), description });
  }
  return { ...card, question: capped(asked.question, MAX_LINE), options };
}
