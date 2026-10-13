// Codex's interactive prompts read off its pane's screen: an approval (run a
// command, apply a patch, trust a folder), a question from plan mode or from
// its queue of follow-up questions, and its "Press enter to continue" menus
// (an update offer). Each becomes a card with the keys that answer each
// option (screen.mjs).
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- server/prompt.ts, its Codex
// parsers (parseCodexContinueMenu, parseCodexQuestion,
// parseCodexAsyncQuestion, parseCodexApproval) and the Codex /model guard.
import { secretPrompt } from "../secret-prompt.mjs";
import {
  ANSI_RE,
  KEY,
  NUMBERED_OPTION_RE,
  cleanLine,
  findLastIndex,
  finishPrompt,
  hintEnds,
  isDivider,
  menuRows,
  nearestQuestion,
  normalizeText,
  parseNumberedRows,
  sequentialRows,
  visibleLines,
  wrapped,
} from "./screen.mjs";

// plan mode's questions; the last of several submits them all
const CODEX_ASK_HINT_RE = /tab to add notes.*enter to submit (?:answer|all).*esc to interrupt/i;
// a question from Codex's queue (request_user_input_async), open
const CODEX_ASYNC_ASK_HINT_RE = /(?:enter|return).*submit.*(?:ctrl\s*\+\s*\]|skip)/i;
const CODEX_CONTINUE_HINT_RE = /press\s+enter\s+to\s+continue/i;
const CODEX_QUEUE_HEADER_RE = /^(?:•\s*)?Queued follow-up inputs$/;
const CODEX_QUEUE_POSITION_RE = /^(\d+) of (\d+)$/;
const CODEX_APPROVAL_HEADER_RE =
  /(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Trust this folder\?|Enable full access)/i;
// what ends an approval still open: its hint, or its last row with the cursor moved onto it
const CODEX_APPROVAL_TAIL_RE = /press enter to confirm|esc to cancel|enter continue.*esc back|^(?:[›>❯]\s*)?\d+\.\s+(?:No|Reject|Cancel|Deny)\b/i;
// Codex's /model lists: a row that opens the next list takes Enter, one that
// picks saves a default with Enter (`s` keeps it to the session)
const CODEX_MODEL_FOOTER_RE = /^enter (?:select|default|apply)\s*·\s*(?:s session\s*·\s*)?esc back$/i;
const CODEX_MODEL_TITLE_RE = /^(?:Select Model(?: and Effort)?|Select Reasoning Level for \S.*|Advanced Reasoning)$/;

// Codex's update offer and its other "Press enter to continue" menus.
function parseCodexContinueMenu(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_CONTINUE_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const rows = menuRows(lines, Math.max(0, hintIndex - 64), hintIndex);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const body = lines.slice(Math.max(0, rows[0].lineIndex - 16), rows[0].lineIndex)
    .map(cleanLine).filter((line) => line && !isDivider(line)).join("\n");
  return finishPrompt("codex", {
    kind: "menu", title: "Codex", question: "Choose how to continue", body: body || null,
    options: rows.map((row) => ({ label: row.label, description: row.description ?? null })),
    multiSelect: false, customOptionIndex: null,
  }, {
    responder: "codex-menu", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
  });
}

// A plan-mode question: numbered options with their descriptions in a second
// column, then "None of the above", whose notes (Tab) take a typed answer.
function parseCodexQuestion(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const rows = menuRows(lines, Math.max(0, hintIndex - 48), hintIndex);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^None of the above\b/i.test(row.label));
  if (customIndex !== rows.length - 1 || customIndex < 1) return null;
  const question = nearestQuestion(lines, rows[0].lineIndex);
  if (!question) return null;
  const options = rows.slice(0, customIndex).map((row) => {
    const [label, ...description] = row.label.split(/\s{2,}/);
    return { label, description: description.length ? description.join(" ") : null };
  });
  const progress = lines.slice(Math.max(0, rows[0].lineIndex - 6), rows[0].lineIndex)
    .map(cleanLine).map((line) => line.match(/^Question (\d+)\/(\d+)/)).find(Boolean);
  const title = progress && progress[2] !== "1" ? `Question ${progress[1]} of ${progress[2]}` : "Question";
  return finishPrompt("codex", {
    kind: "question", title, question, body: null, options,
    multiSelect: false, customOptionIndex: options.length,
  }, {
    responder: "codex-question", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: customIndex,
    // the answer goes into the row's notes, which Tab opens
    typedOpenKeys: [KEY.tab],
  });
}

// A question from Codex's queue, open: under the queue header, an optional
// "1 of 2", the question (wrapped over as many lines as the pane needs), then
// its options and a last row that takes a typed answer ("Other", or what was
// typed there). A free-form question has only that answer line.
function parseCodexAsyncQuestion(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_ASYNC_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const header = findLastIndex(lines.slice(Math.max(0, hintIndex - 48), hintIndex), (line) => CODEX_QUEUE_HEADER_RE.test(cleanLine(line)));
  const top = header < 0 ? Math.max(0, hintIndex - 48) : Math.max(0, hintIndex - 48) + header + 1;
  // without the header the rows are read from well above: a message sent before can be there too
  const rows = menuRows(lines, top, hintIndex);
  const text = (from, to) => lines.slice(from, to).map(cleanLine).filter((line) => line && !isDivider(line));
  let position = null;
  const questionLines = (to) => {
    const found = text(top, to);
    position = found[0]?.match(CODEX_QUEUE_POSITION_RE) ?? null;
    return position ? found.slice(1) : found;
  };
  let question;
  let options;
  let menuLabels;
  let selectedIndex;
  if (rows.length === 0) {
    // free form: the answer line sits right above the hint
    if (header < 0) return null;
    const answerLine = findLastIndex(lines.slice(0, hintIndex), (line) => Boolean(cleanLine(line)) && !isDivider(line));
    if (answerLine < top) return null;
    question = normalizeText(questionLines(answerLine).join(" ")) || null;
    options = [];
    menuLabels = [];
    selectedIndex = 0;
  } else {
    if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
    // an old layout without the header must still end in its "Other" row
    if (header < 0 && !/^Other\b/i.test(rows.at(-1).label)) return null;
    // a wrapped option continues on the lines under it: these rows carry no descriptions
    const labels = rows.map((row, index) => normalizeText([row.label, ...text(row.lineIndex + 1, rows[index + 1]?.lineIndex ?? hintIndex)].join(" ")));
    question = header < 0 ? nearestQuestion(lines, rows[0].lineIndex) : normalizeText(questionLines(rows[0].lineIndex).join(" ")) || null;
    options = labels.slice(0, -1).map((label) => ({ label, description: null }));
    menuLabels = labels;
    selectedIndex = rows.findIndex((row) => row.selected);
  }
  if (!question) return null;
  return finishPrompt("codex", {
    kind: "question", title: position ? `Question ${position[1]} of ${position[2]}` : "Question", question, body: null,
    options, multiSelect: false, customOptionIndex: options.length,
  }, {
    // the last row takes the answer once it is selected: typed straight in
    responder: "codex-async-question", menuLabels, selectedIndex, checkedOptionIndices: [],
    customMenuIndex: menuLabels.length === 0 ? 0 : menuLabels.length - 1,
  });
}

// An approval: "Would you like to run the following command?", "… make the
// following edits?", a folder to trust. Its "No, and tell Codex what to do
// differently (esc)" row, and any other row that refuses, is answered with Esc.
function parseCodexApproval(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) => CODEX_APPROVAL_HEADER_RE.test(line) && !NUMBERED_OPTION_RE.test(line));
  if (headerIndex < 0) return null;
  const rows = parseNumberedRows(lines, headerIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  // "Trust this folder? Codex can read, …": the question heads the card, its explanation joins the body
  const header = cleanLine(lines[headerIndex]);
  const split = header.match(/^(.*?\?)\s+(.+)$/);
  const heading = split ? split[1] : header;
  const body = [split?.[2] ?? "", ...lines.slice(headerIndex + 1, rows[0].lineIndex).map(cleanLine)].filter(Boolean).join("\n");
  const reject = rows.findIndex((row) => /^(?:No|Reject|Cancel|Deny)\b/i.test(row.label));
  return finishPrompt("codex", {
    kind: "approval", title: heading, question: heading, body: body || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multiSelect: false, customOptionIndex: null,
  }, {
    responder: "codex-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: reject >= 0 ? reject : null,
  });
}

// Whether the prompt still owns the end of the screen: an answered menu
// above later output is no card.
function promptTailIsActive(prompt, screen) {
  const shown = visibleLines(screen);
  switch (prompt.responder) {
    case "codex-menu": return hintEnds(shown, CODEX_CONTINUE_HINT_RE);
    case "codex-question": return hintEnds(shown, CODEX_ASK_HINT_RE);
    // the queue keeps a status line or two under its hint
    case "codex-async-question": return shown.slice(-4).some((line) => CODEX_ASYNC_ASK_HINT_RE.test(line)) || hintEnds(shown, CODEX_ASYNC_ASK_HINT_RE);
    case "codex-approval": return hintEnds(shown, CODEX_APPROVAL_TAIL_RE);
    default: return false;
  }
}

// The card a Codex screen shows, with the reader's bookkeeping, or null.
export function parseCodexPrompt(screen) {
  const text = String(screen ?? "");
  if (secretPrompt(text) !== null) return null;
  const candidates = [parseCodexContinueMenu(text), parseCodexQuestion(text), parseCodexAsyncQuestion(text), parseCodexApproval(text)];
  return candidates.find((candidate) => candidate !== null && promptTailIsActive(candidate, text)) ?? null;
}

// Whether the screen ends in one of Codex's /model lists, whose Enter would
// save a default: the fallback card leaves them to the terminal.
export function codexListWaits(lines) {
  const shown = lines.map(cleanLine).filter((line) => line && !isDivider(line)).slice(-30);
  if (!shown.slice(-2).some((line) => CODEX_MODEL_FOOTER_RE.test(line))) return false;
  return shown.some((line) => CODEX_MODEL_TITLE_RE.test(line));
}
