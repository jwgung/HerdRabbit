// The last resort, for a pane herdr reports blocked on a screen no agent's
// reader knows: the screen's last lines with the keys its hint lines name,
// plus Enter and Esc; a numbered menu that still owns the screen's end is
// answered by its numbers. Never for a password prompt, nor for an agent's
// own lists whose Enter saves a default (Claude's and Codex's /model).
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- server/prompt.ts
// (parseFallbackPrompt and its helpers).
import { createHash } from "node:crypto";
import { secretPrompt } from "../secret-prompt.mjs";
import { claudeListWaits } from "./claude.mjs";
import { codexListWaits } from "./codex.mjs";
import {
  ANSI_RE,
  KEY,
  NUMBERED_OPTION_RE,
  SELECTED_RE,
  cleanLine,
  finishPrompt,
  isDivider,
  keySteps,
  parseNumberedRows,
  sequentialRows,
} from "./screen.mjs";

// Who a card says is waiting, by the agent herdr names.
const ASKERS = { claude: "Claude", codex: "Codex", opencode: "OpenCode", kiro: "Kiro" };

const ASKED_RE = /\?\s*(?:[([][^)\]]*[)\]])?\s*$/;
const YES_NO_RE = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]\s*[:?]?\s*$/i;
const ARROWS_RE = /[↑↓]|\barrow keys\b/i;
const MENU_HINT_RE = /\b(?:select|choose|pick|confirm|navigate|move|esc|cancel)\b|[↑↓↵⏎]|\b(?:enter|type)\s+(?:(?:a|an|the)\s+)?number\b|\b\d\s*[-–]\s*\d\b/i;
const INPUT_FIELD_RE = /:\s*\S{0,3}$/;
const HINT_LINE_RE = /^(?:[↵⏎]|(?:Press|Enter|Select|Choose|Pick|Type|Esc|ESC)\b)/;
const MENU_WRAP_LINES = 2;
const NOT_PROMPT_TEXT_RE = /^(?:[❯›>"'“]|\$ )/;
// Claude Code's working line, whole: its spinner, time and tokens tick while
// it waits, and are left out of a fallback card's id.
const WORKING_LINE_RE = /^[·✢✳✶✻✽*] (\S(?:.*\S)?…) \((?:\d+h )?(?:\d+m )?\d+s · [↑↓] [\d.,]+[kKmM]? tokens( · esc to interrupt)?\)$/u;

function steadyReader(shown) {
  const working = shown.flatMap((line, at) => WORKING_LINE_RE.test(line) ? [at] : []);
  const [at] = working;
  if (working.length !== 1 || at === undefined) return { read: (other) => other, working: null };
  const line = shown[at];
  const steady = line.replace(WORKING_LINE_RE, (_all, doing, hint) => `* ${doing} (<time> · <tokens>${hint ?? ""})`);
  return { read: (other) => other === line ? steady : other, working: at };
}

function steadyFields(question, body, steady) {
  return { ...(question === undefined ? {} : { question: steady(question) }), body: body === null ? null : body.split("\n").map(steady).join("\n") };
}

// A fallback card's id covers the whole visible screen: a changed command,
// footer or label anywhere on it makes an answer to the old card stale.
function screenCard(lines, shown, steady, parsed) {
  const screen = shown.map((index) => steady.read(cleanLine(lines[index]))).join("\n");
  parsed.id = createHash("sha256").update(JSON.stringify({ card: parsed.id, screen, ...(steady.working === null ? {} : { working: steady.working }) })).digest("hex").slice(0, 12);
  parsed.promptKey = parsed.id;
  return parsed;
}

function withoutLine(lines, question) {
  const at = question === undefined ? -1 : lines.lastIndexOf(question);
  return lines.filter((_, index) => index !== at).join("\n") || null;
}

// A numbered menu (2 to 9 rows) that still owns the screen's end: its hint,
// a line that says to choose, is the screen's last line.
function fallbackMenu(lines, shown) {
  const lastRow = [...shown].reverse().find((index) => NUMBERED_OPTION_RE.test(cleanLine(lines[index])));
  const hintIndex = shown.at(-1);
  if (lastRow === undefined || hintIndex === undefined || hintIndex === lastRow) return null;
  const hint = cleanLine(lines[hintIndex]);
  if (!MENU_HINT_RE.test(hint) || SELECTED_RE.test(hint) || NOT_PROMPT_TEXT_RE.test(hint) || INPUT_FIELD_RE.test(hint)) return null;
  let end = lastRow + 1;
  const numberAt = lines[lastRow].search(/\d/);
  while (end < hintIndex && cleanLine(lines[end]) && !isDivider(lines[end]) && lines[end].search(/\S/) > numberAt) end += 1;
  if (shown.some((index) => index >= end && index < hintIndex) || end - lastRow - 1 > MENU_WRAP_LINES) return null;
  let start = lastRow;
  while (start > 0 && cleanLine(lines[start - 1]) && !isDivider(lines[start - 1])) start -= 1;
  while (start < lastRow && !NUMBERED_OPTION_RE.test(cleanLine(lines[start]))) start += 1;
  const rows = parseNumberedRows(lines, start, end);
  if (!sequentialRows(rows) || rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length > 1) return null;
  for (const [at, row] of rows.entries()) {
    const wrappedLines = lines.slice(row.lineIndex + 1, rows[at + 1]?.lineIndex ?? end).map(cleanLine).filter(Boolean);
    if (wrappedLines.some((line) => NOT_PROMPT_TEXT_RE.test(line) || (at === rows.length - 1 && (HINT_LINE_RE.test(line) || /:\s*$/.test(line))))) return null;
    if ([row.label, ...wrappedLines].some((line) => /\(\w\)$/.test(line))) return null;
    row.label = [row.label, ...wrappedLines].join(" ");
  }
  return { start, rows };
}

// The fallback card for `screen`, or null for a password prompt, a blank
// screen or an agent's own lists.
// `agent` names whose screen it is: a fallback card answers any agent.
export function parseFallbackPrompt(screen, { agent = "claude" } = {}) {
  const asker = ASKERS[agent] ?? "The program";
  const text = String(screen ?? "");
  if (secretPrompt(text) !== null) return null;
  const lines = text.replace(ANSI_RE, "").split(/\r?\n/);
  if (claudeListWaits(lines) || codexListWaits(lines)) return null;
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  // a blank screen (one caught mid-redraw) is nothing to answer: Enter or Esc
  // would land on whatever draws next
  if (shown.length === 0) return null;
  const steady = steadyReader(shown.map((index) => cleanLine(lines[index])));
  const menu = fallbackMenu(lines, shown);
  if (menu) {
    const above = shown.filter((index) => index < menu.start).map((index) => cleanLine(lines[index]));
    const question = [...above].reverse().find((line) => ASKED_RE.test(line)) ?? above.at(-1);
    // a row's number is typed alone, as a menu reading keys takes it
    const choices = [
      ...menu.rows.map((row) => ({ label: row.label, steps: [{ text: String(row.number) }] })),
      { label: "Enter", steps: keySteps([KEY.enter]) },
      { label: "Esc", steps: keySteps([KEY.escape]) },
    ];
    const body = withoutLine(above, question);
    return screenCard(lines, shown, steady, finishPrompt(agent, {
      agent, kind: "menu", fallback: true, title: "Waiting for your answer", question: question ?? `${asker} is waiting for your answer.`,
      body,
      options: choices.map(({ label }) => ({ label, description: null })),
      multiSelect: false, customOptionIndex: null,
    }, {
      responder: "fallback-menu", menuLabels: choices.map(({ label }) => label), selectedIndex: 0,
      checkedOptionIndices: [], customMenuIndex: null, optionSteps: choices.map(({ steps }) => steps),
    }, steadyFields(question, body, steady.read)));
  }
  const last = shown.slice(-16).map((index) => cleanLine(lines[index]));
  const hints = NOT_PROMPT_TEXT_RE.test(last.at(-1) ?? "") ? [] : last.slice(-2).filter((line) => !NOT_PROMPT_TEXT_RE.test(line));
  const question = [...last].reverse().find((line) => ASKED_RE.test(line)) ?? last.at(-1);
  const choices = [
    ...(hints.some((line) => YES_NO_RE.test(line)) ? [{ label: "Yes (y)", steps: [{ text: "y" }] }, { label: "No (n)", steps: [{ text: "n" }] }] : []),
    ...(hints.some((line) => ARROWS_RE.test(line)) ? [{ label: "↑", steps: keySteps([KEY.up]) }, { label: "↓", steps: keySteps([KEY.down]) }] : []),
    { label: "Enter", steps: keySteps([KEY.enter]) },
    { label: "Esc", steps: keySteps([KEY.escape]) },
  ];
  const body = withoutLine(last, question);
  return screenCard(lines, shown, steady, finishPrompt(agent, {
    agent, kind: "menu", fallback: true, title: "Waiting for input", question: question ?? `${asker} is waiting for input.`,
    body,
    options: choices.map(({ label }) => ({ label, description: null })),
    multiSelect: false, customOptionIndex: null,
  }, {
    responder: "fallback-keys", menuLabels: choices.map(({ label }) => label), selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, optionSteps: choices.map(({ steps }) => steps),
  }, steadyFields(question, body, steady.read)));
}
