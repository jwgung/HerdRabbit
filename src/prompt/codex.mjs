// Codex's interactive prompts read off its pane's screen: an approval (run a
// command, apply a patch, network access, an MCP tool, trust a folder), a
// question from plan mode, from an MCP server's form or from its queue of
// follow-up questions, its "Press enter to continue" menus (an update offer)
// and the few list popups that ask a decision ("Implement this plan?"). Each
// becomes a card with the keys that answer each option (screen.mjs).
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

// plan mode's questions; the last of several submits them all. A free-form
// question has no "tab to add notes".
const CODEX_ASK_HINT_RE = /enter to submit (?:answer|all).*esc to interrupt/i;
const CODEX_ASK_PROGRESS_RE = /^Question (\d+)\/(\d+)/;
const CODEX_ASK_FREE_RE = /^[›>]?\s*Type your answer\b/;
// a question from Codex's queue (request_user_input_async), open
const CODEX_ASYNC_ASK_HINT_RE = /(?:enter|return).*submit.*(?:ctrl\s*\+\s*\]|⌃\]|skip)/i;
// a form field an MCP server asks (its choice fields: Enter picks the row under the cursor)
const CODEX_ELICIT_HINT_RE = /enter to submit(?: answer| all)?.*esc to cancel/i;
const CODEX_ELICIT_PROGRESS_RE = /^Field (\d+)\/(\d+)/;
const CODEX_CONTINUE_HINT_RE = /press\s+enter\s+to\s+continue|enter continue\s*·\s*esc skip/i;
const CODEX_QUEUE_HEADER_RE = /^(?:•\s*)?Queued follow-up inputs$/;
const CODEX_QUEUE_POSITION_RE = /^(\d+) of (\d+)$/;
// The list popups that ask a decision are named here: Codex's other lists
// (/model, /permissions) save a setting with Enter and stay no card.
const CODEX_APPROVAL_HEADER_RE =
  /(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Trust this folder\?|Enable full access|Implement this plan\?|Hooks need review|Submit with unanswered questions\?|Do you want to approve network access|^\s*(?:•\s*)?[^\n]{1,100} needs your approval\.\s*$)/i;
const CODEX_POPUP_FOOTER_RE = /enter (?:select|confirm)\s*·\s*esc (?:back|skip)/i;
// what ends an approval still open: its hint, or its last row with the cursor moved onto it
const CODEX_APPROVAL_TAIL_RE = new RegExp(
  `press enter to confirm|esc to cancel|enter continue.*esc back|${CODEX_POPUP_FOOTER_RE.source}|^(?:[›>❯]\\s*)?\\d+\\.\\s+(?:No|Reject|Cancel|Deny)\\b`, "i");
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
// column, then "None of the above", whose notes (Tab) take a typed answer. A
// question without that row (a multi-question form's) takes no typed answer;
// a free-form one has only its answer line, typed straight in.
function parseCodexQuestion(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const rows = menuRows(lines, Math.max(0, hintIndex - 48), hintIndex);
  const progressIn = (from, to) => lines.slice(Math.max(0, from), to)
    .map(cleanLine).map((line) => line.match(CODEX_ASK_PROGRESS_RE)).findLast(Boolean) ?? null;
  const titleOf = (progress) => progress && progress[2] !== "1" ? `Question ${progress[1]} of ${progress[2]}` : "Question";
  if (rows.length === 0) {
    // free form: the "Question N/M" line, the question, then the empty answer line
    const answerLine = findLastIndex(lines.slice(0, hintIndex), (line) => CODEX_ASK_FREE_RE.test(cleanLine(line)));
    if (answerLine < 0) return null;
    const progressLine = findLastIndex(lines.slice(Math.max(0, answerLine - 14), answerLine), (line) => CODEX_ASK_PROGRESS_RE.test(cleanLine(line)));
    if (progressLine < 0) return null;
    const from = Math.max(0, answerLine - 14) + progressLine;
    const question = normalizeText(lines.slice(from + 1, answerLine).map(cleanLine).filter((line) => line && !isDivider(line)).join(" "));
    if (!question) return null;
    return finishPrompt("codex", {
      kind: "question", title: titleOf(progressIn(from, from + 1)), question, body: null, options: [],
      multiSelect: false, customOptionIndex: 0,
    }, {
      responder: "codex-question", menuLabels: [], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: 0,
    });
  }
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^None of the above\b/i.test(row.label));
  if (customIndex >= 0 && (customIndex !== rows.length - 1 || customIndex < 1)) return null;
  const progress = progressIn(rows[0].lineIndex - 6, rows[0].lineIndex);
  // without the "None of the above" row the form's own "Question N/M" line is what says this is Codex's
  if (customIndex < 0 && !progress) return null;
  const question = nearestQuestion(lines, rows[0].lineIndex);
  if (!question) return null;
  const optionRows = customIndex < 0 ? rows : rows.slice(0, customIndex);
  const options = optionRows.map((row) => {
    const [label, ...description] = row.label.split(/\s{2,}/);
    return { label, description: description.length ? description.join(" ") : null };
  });
  return finishPrompt("codex", {
    kind: "question", title: titleOf(progress), question, body: null, options,
    multiSelect: false, customOptionIndex: customIndex < 0 ? null : options.length,
  }, {
    responder: "codex-question", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: customIndex < 0 ? null : customIndex,
    // the answer goes into the row's notes, which Tab opens
    typedOpenKeys: [KEY.tab],
  });
}

// A form an MCP server asks, one field at a time ("Field 1/2"): its choice
// fields (a boolean, an enum, an allow/cancel) are numbered rows whose Enter
// picks the one under the cursor and goes on to the next field. A text field
// has no rows and is left to the terminal.
function parseCodexElicitation(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CODEX_ELICIT_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const rows = menuRows(lines, Math.max(0, hintIndex - 48), hintIndex);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const from = Math.max(0, rows[0].lineIndex - 24);
  const progressLine = findLastIndex(lines.slice(from, rows[0].lineIndex), (line) => CODEX_ELICIT_PROGRESS_RE.test(cleanLine(line)));
  if (progressLine < 0) return null;
  const progress = cleanLine(lines[from + progressLine]).match(CODEX_ELICIT_PROGRESS_RE);
  const text = lines.slice(from + progressLine + 1, rows[0].lineIndex).map(cleanLine).filter((line) => line && !isDivider(line));
  // the server's name line is context, not the question
  const question = text.find((line) => !/^Server:/i.test(line));
  if (!question) return null;
  const options = rows.map((row) => {
    const [label, ...description] = row.label.split(/\s{2,}/);
    return { label, description: description.length ? description.join(" ") : null };
  });
  return finishPrompt("codex", {
    kind: "question", title: progress[2] !== "1" ? `Field ${progress[1]} of ${progress[2]}` : "Question", question,
    body: text.length > 1 ? text.join("\n") : null, options, multiSelect: false, customOptionIndex: null,
  }, {
    responder: "codex-elicitation", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
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
  const floor = Math.max(0, hintIndex - 48);
  const header = findLastIndex(lines.slice(floor, hintIndex), (line) => CODEX_QUEUE_HEADER_RE.test(cleanLine(line)));
  // Codex 0.171 draws no header: the "1 of 2" line opens the question
  const positionLine = header >= 0 ? -1 : findLastIndex(lines.slice(floor, hintIndex), (line) => CODEX_QUEUE_POSITION_RE.test(cleanLine(line)));
  const top = header >= 0 ? floor + header + 1 : positionLine >= 0 ? floor + positionLine : floor;
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
    if (header < 0 && positionLine < 0) return null;
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
    question = header < 0 && positionLine < 0 ? nearestQuestion(lines, rows[0].lineIndex) : normalizeText(questionLines(rows[0].lineIndex).join(" ")) || null;
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
  // Esc is the row that says "(esc)". Where it is not named, Esc on a popup, or
  // beside a "Cancel" row (an MCP request's, whose "No" continues), is not
  // the refusal the row is: those are moved to and picked.
  const named = rows.findIndex((row) => /\(esc\)\s*$/i.test(row.label));
  const escapes = !visibleLines(screen).slice(-3).some((line) => CODEX_POPUP_FOOTER_RE.test(line))
    && !rows.some((row) => /^Cancel\b/i.test(row.label));
  const reject = named >= 0 ? named : escapes ? rows.findIndex((row) => /^(?:No|Reject|Deny)\b/i.test(row.label)) : -1;
  return finishPrompt("codex", {
    kind: "approval", title: heading, question: heading, body: body || null,
    options: rows.map((row) => {
      // a popup's rows carry their description in a second column
      const [label, ...description] = row.label.split(/\s{2,}/);
      return { label, description: description.length ? description.join(" ") : null };
    }), multiSelect: false, customOptionIndex: null,
  }, {
    responder: "codex-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: reject >= 0 ? reject : null,
  });
}

// Questions Codex folded away when the user went on typing: above the
// composer it leaves "? 2 questions · 15s" and "⇧← to answer" (0.171,
// bottom_pane/questions.rs). The card's one answer is that key, which
// unfolds them; the unfolded question is then a card of its own. The time
// left ticks every second and is left out of the card, so its id holds.
const CODEX_FOLDED_COUNT_RE = /^\?\s+(\d+) questions?(?:\s+·\s+.*)?$/u;
const CODEX_FOLDED_HINT_RE = /^(\S+) to answer$/u;
// The keys its hint can name, as herdr takes them: the defaults of
// edit_queued_message (keymap.rs). Any other binding gets no card.
const CODEX_FOLDED_KEYS = Object.freeze({ "⇧←": "shift+left", "⌥↑": "alt+up" });
// How near the screen's end the summary sits: under it only the composer and
// its footer.
const CODEX_FOLDED_TAIL_LINES = 8;

function foldedQuestionsAt(shown) {
  for (let at = shown.length - 2; at >= Math.max(0, shown.length - CODEX_FOLDED_TAIL_LINES); at -= 1) {
    const count = CODEX_FOLDED_COUNT_RE.exec(shown[at]);
    const hint = count && CODEX_FOLDED_HINT_RE.exec(shown[at + 1] ?? "");
    if (hint) return { at, count: Number(count[1]), binding: hint[1] };
  }
  return null;
}

function parseCodexFoldedQuestions(screen) {
  const folded = foldedQuestionsAt(visibleLines(screen));
  const key = folded && CODEX_FOLDED_KEYS[folded.binding];
  if (!key || folded.count < 1) return null;
  const many = folded.count === 1 ? "1 question" : `${folded.count} questions`;
  const label = `Answer (${folded.binding})`;
  return finishPrompt("codex", {
    kind: "menu", title: `Codex has ${many} waiting`, question: `Codex asked ${many} and folded ${folded.count === 1 ? "it" : "them"} away while you went on.`,
    body: null, options: [{ label, description: null }], multiSelect: false, customOptionIndex: null,
  }, {
    responder: "codex-folded-questions", menuLabels: [label], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null,
    optionSteps: [[{ keys: [key] }]],
  });
}

// Whether the prompt still owns the end of the screen: an answered menu
// above later output is no card.
function promptTailIsActive(prompt, screen) {
  const shown = visibleLines(screen);
  switch (prompt.responder) {
    case "codex-menu": return hintEnds(shown, CODEX_CONTINUE_HINT_RE);
    case "codex-question": return hintEnds(shown, CODEX_ASK_HINT_RE);
    case "codex-elicitation": return hintEnds(shown, CODEX_ELICIT_HINT_RE);
    // the queue keeps a status line or two under its hint
    case "codex-async-question": return shown.slice(-4).some((line) => CODEX_ASYNC_ASK_HINT_RE.test(line)) || hintEnds(shown, CODEX_ASYNC_ASK_HINT_RE);
    case "codex-approval": return hintEnds(shown, CODEX_APPROVAL_TAIL_RE);
    case "codex-folded-questions": return foldedQuestionsAt(shown) !== null;
    default: return false;
  }
}

// The card a Codex screen shows, with the reader's bookkeeping, or null.
export function parseCodexPrompt(screen) {
  const text = String(screen ?? "");
  if (secretPrompt(text) !== null) return null;
  const candidates = [parseCodexContinueMenu(text), parseCodexQuestion(text), parseCodexElicitation(text), parseCodexAsyncQuestion(text), parseCodexApproval(text), parseCodexFoldedQuestions(text)];
  return candidates.find((candidate) => candidate !== null && promptTailIsActive(candidate, text)) ?? null;
}

// Whether the screen ends in one of Codex's /model lists, whose Enter would
// save a default: the fallback card leaves them to the terminal.
export function codexListWaits(lines) {
  const shown = lines.map(cleanLine).filter((line) => line && !isDivider(line)).slice(-30);
  if (!shown.slice(-2).some((line) => CODEX_MODEL_FOOTER_RE.test(line))) return false;
  return shown.some((line) => CODEX_MODEL_TITLE_RE.test(line));
}
