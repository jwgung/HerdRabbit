// Claude Code's interactive prompts read off its pane's screen: a tool
// approval (Yes / Yes, and don't ask again / No), a plan to approve, an
// AskUserQuestion menu (one choice or several, with a typed answer), the
// review that submits several answers, and Claude's unnumbered menus (the
// folder-trust check). Each becomes a card: what it asks, its options, and
// the keys that answer each option. A pane herdr reports blocked on a screen
// none of these know gets a fallback card with the screen's last lines and
// basic keys (Enter, Esc, a numbered menu's digits).
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- server/prompt.ts, reduced to
// Claude Code's parsers (parseClaudeQuestion, parseClaudeSubmit,
// parseClaudeApproval, parseClaudeConfirm), the fallback card, the card id
// hash and the answer keys. Bun.stringWidth is replaced by ./text-width.mjs.
import { createHash } from "node:crypto";
import { secretPrompt } from "../secret-prompt.mjs";
import { indexAtColumn, stringWidth } from "./text-width.mjs";

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SELECTED_RE = /^[❯›>]\s*/;
const DIVIDER_RE = /^[\s╭╮╰╯├┤┬┴┼─━═╌▔]+$/;
// several questions navigate between tabs: "Tab/Arrow keys to navigate"
const CLAUDE_ASK_HINT_RE = /enter to select.*(?:↑\/↓|tab\/arrow keys) to navigate.*esc to cancel/i;
// question tabs, whole (`←  ☒ Route  ☐ Author  ✔ Submit  →`) or cut off by a narrow pane
const CLAUDE_TABS_RE = /^←\s+[☐☒☑✔]/;
// Claude Code's unnumbered menus (the folder-trust check on a new folder, among others)
const CLAUDE_CONFIRM_HINT_RE = /enter to confirm.*esc to (?:cancel|exit|go back)/i;
// Claude's /model list and /effort slider: their Enter saves a default, so a
// screen showing one gets no fallback card (the terminal answers them).
const guardRe = (parts) => new RegExp(parts
  .map((part) => [...part.replace(/\s+/g, "")].map((char) => char.replace(/[/.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")).join(".*"), "i");
const CLAUDE_EFFORT_GUARD_RE = guardRe(["←/→ to adjust · Enter to confirm", "Esc to cancel"]);
const CLAUDE_MODEL_GUARD_RE = guardRe(["Enter to set as default", "s to use this session only", "Esc to cancel"]);
const SOLID_RULE_RE = /^[─━]{8,}$/;
const NUMBERED_OPTION_RE = /^\s*([›>❯])?\s*(\d+)\.\s+(.+)$/;
const CLAUDE_PREVIEW_HINT_RE = /\bn to add notes\b/i;
const PREVIEW_EDGE = "┌│└├╭╰┐┘╮╯";

export const KEY = Object.freeze({ up: "up", down: "down", enter: "enter", escape: "esc", right: "right", backtab: "shift+tab" });

export class InvalidAnswer extends Error {}

function cleanLine(rawLine) {
  let line = rawLine.replace(ANSI_RE, "").trim();
  if (line.startsWith("│")) line = line.slice(1).trimStart();
  if (line.endsWith("│")) line = line.slice(0, -1).trimEnd();
  return line.trim();
}

function isDivider(line) {
  const value = cleanLine(line);
  return Boolean(value) && DIVIDER_RE.test(value);
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function findLastIndex(lines, predicate) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index], index)) return index;
  }
  return -1;
}

// A line and the two after it, as one: a narrow pane wraps a hint line.
function wrapped(lines, index, span = 3) {
  return lines.slice(index, index + span).map(cleanLine).filter((line) => line && !isDivider(line)).join(" ");
}

function compactLines(lines) {
  return lines.map(cleanLine).filter((line) => !isDivider(line)).join("").replace(/\s+/g, "");
}

function nearestQuestion(lines, beforeIndex) {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 14); index -= 1) {
    const line = cleanLine(lines[index]);
    if (!line || isDivider(line) || /^Planning:/i.test(line) || /^[←→].*Submit/i.test(line)
      || /^[☐☑✔]\s+\S/.test(line) || /^Question \d+\/\d+/i.test(line)) continue;
    return line.replace(/^\(\d+\s+selected\)\s*/i, "").trim();
  }
  return null;
}

function parseNumberedRows(lines, start, end) {
  const rows = [];
  for (let index = start; index < end; index += 1) {
    const match = lines[index].replace(ANSI_RE, "").trim().match(NUMBERED_OPTION_RE);
    if (!match) continue;
    let label = match[3].trim();
    // Claude Code 2.1.296 ticks a row with ✔, older ones with ✓
    const checked = /^\[[xX✓✔]\]/.test(label);
    label = label.replace(/^\[[ xX✓✔]\]\s*/, "").trim();
    rows.push({ number: Number.parseInt(match[2], 10), label, selected: Boolean(match[1]), checked, lineIndex: index });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const nextLineIndex = rows[index + 1]?.lineIndex ?? end;
    // a description a narrow pane wraps goes on to the next blank line or rule
    const description = [];
    for (let lineIndex = row.lineIndex + 1; lineIndex < nextLineIndex; lineIndex += 1) {
      const line = cleanLine(lines[lineIndex]);
      if (line && !isDivider(line)) description.push(line);
      else if (description.length > 0) break;
    }
    if (description.length > 0) row.description = normalizeText(description.join(" "));
  }
  return rows;
}

// A menu's rows among numbered lines read from well above it: the last run
// that counts up from 1, in the column of the row the cursor is on. A message
// sent before ("❯ 1. …") or a numbered line in a description is not the menu.
function menuRows(lines, start, end) {
  const rows = parseNumberedRows(lines, start, end);
  const column = (row) => lines[row.lineIndex].replace(ANSI_RE, "").search(/\d/);
  const anchor = [...rows].reverse().find((row) => row.selected) ?? rows.at(-1);
  const menu = anchor === undefined ? rows : rows.filter((row) => column(row) === column(anchor));
  return menu.slice(Math.max(0, menu.map((row) => row.number).lastIndexOf(1)));
}

function sequentialRows(rows) {
  return rows.length > 0 && rows.every((row, index) => row.number === index + 1);
}

function hashOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

// The card's id hashes everything it shows (and what `hashed` adds), never
// where the cursor is: a moved cursor is the same prompt, a changed command
// or option is another one. Ticks are not shown in the hashed options either.
// The body is capped for display after hashing.
//
// `promptKey` is what an answer in progress checks between its keys: for a
// multiple choice it leaves out the title as well, since a tick can mark the
// question's tab answered and so retitle the card; otherwise it is the id.
function finishPrompt(input, internal, hashed = {}) {
  const id = hashOf({ agent: "claude", ...input, ...hashed });
  const { title: _title, ...untitled } = input;
  const promptKey = input.multiSelect ? hashOf({ agent: "claude", ...untitled, ...hashed }) : id;
  return { id, agent: "claude", ...input, body: input.body?.slice(0, 12_000) ?? null, promptKey, ...internal };
}

// What the browser gets: the card without the reader's own bookkeeping.
export function publicCard(parsed) {
  if (!parsed) return null;
  return {
    id: parsed.id,
    agent: parsed.agent,
    kind: parsed.kind,
    title: parsed.title,
    question: parsed.question,
    body: parsed.body,
    options: parsed.options.map((option) => ({ label: option.label, description: option.description ?? null })),
    multiSelect: parsed.multiSelect,
    // a multiple choice's options already ticked in the terminal
    checked: [...(parsed.checkedOptionIndices ?? [])],
    customOptionIndex: parsed.customOptionIndex,
    ...(parsed.fallback ? { fallback: true } : {}),
  };
}

// An option's preview is boxed to the right of the options; the box stands in
// one terminal column on every line (its top corner names it), so only what
// sits in that column goes.
function withoutPreview(lines, from, to) {
  let column = -1;
  for (let index = from; index <= to && column < 0; index += 1) {
    const line = lines[index] ?? "";
    const corner = /\s{2,}[┌╭]/.exec(line);
    if (corner !== null) column = stringWidth(line.slice(0, corner.index + corner[0].length - 1));
  }
  return lines.map((line) => {
    const at = column >= 2 ? indexAtColumn(line, column) : -1;
    const edge = at >= 0 ? line[at] : undefined;
    const boxed = edge !== undefined && PREVIEW_EDGE.includes(edge) && line.slice(Math.max(0, at - 2), at) === "  ";
    return (boxed ? line.slice(0, at).trimEnd() : line).replace(/^\s*Notes:\s+press n to add notes\b.*$/i, "");
  });
}

function navigationKeys(delta) {
  return Array.from({ length: Math.abs(delta) }, () => delta > 0 ? KEY.down : KEY.up);
}

function keySteps(keys) {
  return keys.map((key) => ({ keys: [key] }));
}

function parseClaudeQuestion(screen) {
  const raw = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(raw, (_, index) => CLAUDE_ASK_HINT_RE.test(wrapped(raw, index)));
  if (hintIndex < 0) return null;
  const preview = CLAUDE_PREVIEW_HINT_RE.test(wrapped(raw, hintIndex));
  const lines = preview ? withoutPreview(raw, Math.max(0, hintIndex - 64), hintIndex) : raw;
  const end = preview ? findLastIndex(lines.slice(0, hintIndex), (line) => isDivider(line)) : hintIndex;
  const rows = menuRows(lines, Math.max(0, hintIndex - 64), end);
  // a multiple choice draws an unnumbered Submit row between the typed answer and "Chat about this"
  const submitLine = rows.length < 2 ? undefined
    : lines.slice(rows.at(-2).lineIndex + 1, rows.at(-1).lineIndex).map(cleanLine).find((line) => /^(?:[›>❯]\s*)?Submit$/.test(line));
  const onSubmit = submitLine !== undefined && SELECTED_RE.test(submitLine);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== (onSubmit ? 0 : 1)) return null;
  const chatIndex = rows.findIndex((row) => row.label === "Chat about this");
  let customIndex = rows.findIndex((row) => /^Type something\.?$/i.test(row.label));
  // typed into, the row shows the draft instead of "Type something."
  const drafted = customIndex < 0 && !preview && chatIndex > 1
    && lines.slice(rows[chatIndex - 1].lineIndex + 1, rows[chatIndex].lineIndex).some((line) => isDivider(line))
    && (claudeTabs(lines, rows[0].lineIndex) !== null || claudeChip(lines, rows[0].lineIndex) !== null);
  if (drafted) customIndex = chatIndex - 1;
  if (preview) {
    if (customIndex >= 0 || chatIndex >= 0) return null;
  } else if (chatIndex !== rows.length - 1 || customIndex !== chatIndex - 1 || customIndex < 1) return null;
  const tabs = claudeTabs(lines, rows[0].lineIndex);
  const question = claudeQuestionText(lines, tabs?.index ?? -1, rows[0].lineIndex) ?? nearestQuestion(lines, rows[0].lineIndex);
  const chip = tabs === null ? claudeChip(lines, rows[0].lineIndex) : null;
  if (!question) return null;
  const optionRows = preview ? rows : rows.slice(0, customIndex);
  const multiSelect = optionRows.some((row) => /^\s*(?:[›>❯]\s*)?\d+\.\s+\[[ xX✓✔]\]/.test(lines[row.lineIndex]));
  if (onSubmit && !multiSelect) return null;
  const submit = multiSelect && submitLine !== undefined;
  const rowAt = rows.findIndex((row) => row.selected);
  // the cursor's place among the rows it moves through, Submit counted before the last one
  const selectedIndex = onSubmit ? rows.length - 1 : submit && rowAt === rows.length - 1 ? rowAt + 1 : rowAt;
  const current = tabs?.tabs.findIndex((tab) => !tab.answered) ?? -1;
  const title = tabs && current >= 0 ? `${tabs.tabs[current].label}${tabs.whole && tabs.tabs.length > 1 ? ` · ${current + 1} of ${tabs.tabs.length}` : ""}`
    : chip ?? (multiSelect ? "Multiple choice" : "Question");
  return finishPrompt({
    kind: "question", title, question, body: null,
    options: optionRows.map((row) => ({ label: row.label, description: row.description ?? null })),
    multiSelect, customOptionIndex: multiSelect || preview ? null : customIndex,
  }, {
    responder: "claude-question",
    menuLabels: submit ? [...rows.slice(0, -1).map((row) => row.label), "Submit", rows.at(-1).label] : rows.map((row) => row.label),
    selectedIndex,
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: preview ? null : customIndex,
    // an answer typed into the draft would join it: the row is emptied first
    ...(drafted ? {
      customSteps: (text) => [
        ...keySteps([...navigationKeys(customIndex - rows.findIndex((row) => row.selected)), "ctrl+k", "ctrl+u"]),
        { text }, ...keySteps([KEY.enter]),
      ],
    } : {}),
  });
}

// A single question's header chip (`☐ Dataset`), its short name.
function claudeChip(lines, firstRow) {
  for (let index = firstRow - 1; index >= Math.max(0, firstRow - 40); index -= 1) {
    const line = cleanLine(lines[index]);
    if (isDivider(line) || CLAUDE_TABS_RE.test(line)) return null;
    const chip = /^[☐☒☑✔]\s+(\S.*)$/.exec(line);
    if (chip !== null) return chip[1].trim();
  }
  return null;
}

// Claude's question tabs above several questions. ☐ is unanswered, ☒
// answered, ✔ the Submit step; a narrow pane can cut the bar off.
function claudeTabs(lines, beforeIndex) {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 60); index -= 1) {
    const line = cleanLine(lines[index]);
    if (SOLID_RULE_RE.test(line)) return null;
    if (!CLAUDE_TABS_RE.test(line)) continue;
    const tabs = [...line.replace(/^←/, "").replace(/→$/, "").matchAll(/([☐☒☑✔])\s+(.+?)(?=\s{2,}|\s*$)/g)]
      .filter((match) => match[1] !== "✔")
      .map((match) => ({ label: match[2].trim(), answered: match[1] !== "☐" }));
    return { index, whole: /→$/.test(line), tabs };
  }
  return null;
}

// The question over Claude's options, joined back when a narrow pane wraps it.
function claudeQuestionText(lines, tabsIndex, firstRow) {
  const text = [];
  for (let index = firstRow - 1; index > Math.max(tabsIndex, firstRow - 30); index -= 1) {
    const line = cleanLine(lines[index]);
    if (!line) { if (text.length > 0) break; continue; }
    if (/^[☐☒☑✔]\s+\S/.test(line) || isDivider(line) || CLAUDE_TABS_RE.test(line)) break;
    text.unshift(line);
  }
  return text.length > 0 ? normalizeText(text.join(" ")) : null;
}

// After several questions Claude shows the answers and asks before sending them.
function parseClaudeSubmit(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const questionIndex = findLastIndex(lines, (line) => /^Ready to submit your answers\?$/i.test(cleanLine(line)));
  if (questionIndex < 0) return null;
  const tabsIndex = findLastIndex(lines.slice(0, questionIndex), (line) => CLAUDE_TABS_RE.test(cleanLine(line)));
  if (tabsIndex < 0 || questionIndex - tabsIndex > 40) return null;
  const rows = parseNumberedRows(lines, questionIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const body = lines.slice(tabsIndex + 1, questionIndex).map(cleanLine)
    .filter((line) => line && !isDivider(line) && !/^Review your answers$/i.test(line)).join("\n");
  return finishPrompt({
    kind: "menu", title: "Review your answers", question: cleanLine(lines[questionIndex]), body: body || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multiSelect: false, customOptionIndex: null,
  }, {
    responder: "claude-submit", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null,
  });
}

function parseClaudeApproval(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const planIndex = findLastIndex(lines, (_, index) => /Claude has written up a plan and is ready to execute\. Would you like to proceed\?/i.test(wrapped(lines, index)));
  if (planIndex >= 0) {
    const rows = parseNumberedRows(lines, planIndex + 1, lines.length);
    if (!sequentialRows(rows) || rows.length < 3 || rows.filter((row) => row.selected).length !== 1) return null;
    const customIndex = rows.findIndex((row) => /^Tell Claude what to change$/i.test(row.label));
    const bodyStart = Math.max(0, findLastIndex(lines.slice(0, planIndex), (line) => /Ready to code\?/i.test(cleanLine(line))));
    return finishPrompt({
      kind: "plan", title: "Ready to code?", question: cleanLine(lines[planIndex]),
      body: lines.slice(bodyStart, planIndex).map(cleanLine).filter((line) => !isDivider(line)).join("\n") || null,
      options: rows.map((row) => ({ label: row.label, description: null })), multiSelect: false,
      customOptionIndex: customIndex >= 0 ? customIndex : null,
    }, {
      responder: "claude-plan", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
      checkedOptionIndices: [], customMenuIndex: customIndex >= 0 ? customIndex : null,
    });
  }

  const requiredIndex = findLastIndex(lines, (line) => /This command requires approval/i.test(cleanLine(line)));
  const dangerousRmIndex = findLastIndex(lines, (line) => /^Dangerous rm operation\b/i.test(cleanLine(line)));
  const approvalIndex = Math.max(requiredIndex, dangerousRmIndex);
  // "Do you want to proceed?", "Do you want to create hello.txt?", "Do you want to make this edit to a.ts?"
  const questionIndex = findLastIndex(lines, (line) => /^Do you want to .+\?$/i.test(cleanLine(line)));
  if (questionIndex < 0) return null;
  // options end at the key hint: a line under the last one is then only its wrapped label
  const hintIndex = findLastIndex(lines, (_, index) => /esc to cancel/i.test(wrapped(lines, index)));
  const rows = parseNumberedRows(lines, questionIndex + 1, hintIndex > questionIndex ? hintIndex : lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  // a hint of its own under the last row and over the last hint: the panel
  // was answered, and what ends the screen now is another prompt
  if (/esc to\s+cancel/i.test(lines.slice(rows.at(-1).lineIndex + 1, hintIndex).map(cleanLine).join(" "))) return null;
  let title;
  let body;
  if (approvalIndex >= 0 && approvalIndex < questionIndex) {
    title = nearestQuestion(lines, approvalIndex) ?? "Command approval";
    const bodyEnd = dangerousRmIndex > requiredIndex ? questionIndex : approvalIndex;
    body = lines.slice(Math.max(0, approvalIndex - 8), bodyEnd).map(cleanLine).filter((line) => line && !isDivider(line)).join("\n");
  } else {
    // Claude Code 2.1: the panel under a solid rule opens with the tool
    // ("Bash command", "Create file"), then the command or file. The panel's
    // rule is the first one under the tool call (`● Write(a.ts)`); rules
    // further down belong to a file preview.
    const callIndex = findLastIndex(lines.slice(0, questionIndex), (line) => /^●\s+[\w.:-]+(?:\s[\w.:-]+)*(?:\s\(MCP\))?\(/.test(cleanLine(line)));
    const rules = lines.slice(0, questionIndex).flatMap((line, index) => index > callIndex && SOLID_RULE_RE.test(cleanLine(line)) ? [index] : []);
    const ruleIndex = callIndex >= 0 ? rules[0] ?? -1 : rules.at(-1) ?? -1;
    // a long command pushes the panel's rule and tool name off the screen:
    // its `│` command block and the dashed rule under it still say it is one
    const above = lines.slice(0, questionIndex).map((line) => line.replace(ANSI_RE, "").trim());
    const dashIndex = findLastIndex(above, (line) => isDivider(line));
    const scrolled = ruleIndex < 0 && callIndex < 0 && hintIndex > questionIndex && /^esc to cancel\b/i.test(cleanLine(lines[hintIndex]))
      && dashIndex >= 1 && questionIndex - dashIndex <= 8 && /^╌{8,}$/.test(above[dashIndex]) && /^│\s/.test(above[dashIndex - 1])
      && above.slice(dashIndex + 1).every((line) => !/^[●⏺❯>›]/.test(line));
    if (!scrolled && (ruleIndex < 0 || questionIndex - ruleIndex > 60)) return null;
    const panel = lines.slice(scrolled ? 0 : ruleIndex + 1, questionIndex)
      .filter((line) => !/^Tip:/i.test(line.replace(ANSI_RE, "").trim())).map(cleanLine)
      .filter((line) => line && !isDivider(line));
    if (panel.length === 0) return null;
    title = scrolled ? "Command approval" : panel[0];
    body = (scrolled ? panel : panel.slice(1)).join("\n");
  }
  return finishPrompt({
    kind: "approval", title, question: cleanLine(lines[questionIndex]),
    body: body || null,
    // an approval's options have no descriptions: lines under one are its label wrapped by a narrow pane
    options: rows.map((row, index) => ({ label: normalizeText([row.label, ...lines.slice(row.lineIndex + 1, rows[index + 1]?.lineIndex ?? (hintIndex > questionIndex ? hintIndex : lines.length))
      .map(cleanLine).filter((line) => line && !isDivider(line))].join(" ")), description: null })),
    multiSelect: false, customOptionIndex: null,
  }, {
    responder: "claude-approval", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null,
  });
}

// Claude Code's unnumbered menus, such as the folder-trust check:
//
//   Accessing workspace:
//   …
//   ❯ No, exit
//     Yes, I trust this folder
//   Enter to confirm · Esc to cancel
//
// The rows are the lines right above the hint, up to a blank line or a rule,
// exactly one of them `❯`.
function parseClaudeConfirm(screen) {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_CONFIRM_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  let end = hintIndex - 1;
  while (end >= 0 && !cleanLine(lines[end])) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]) && !isDivider(lines[start - 1])) start -= 1;
  if (end < 0 || start < 0) return null;
  // A narrow pane wraps a long label onto the next line at the label's own
  // indent. A line under a row (without its own ❯) continues that row when
  // its first word would not have fitted after it; the widest line off the
  // rows stands for the pane's width. A row wider than all of them says
  // nothing of it, so such a screen gets no card rather than a wrong one.
  const width = Math.max(0, ...lines.filter((_, index) => index < start || index > end).map((line) => stringWidth(line.trimEnd())));
  let unsure = false;
  const wrappedFrom = (above, line) => {
    if (stringWidth(above.trimEnd()) + 1 + stringWidth(line.split(/\s+/)[0] ?? "") <= width) return false;
    if (stringWidth(above.trimEnd()) > width) unsure = true;
    return true;
  };
  const rows = [];
  for (let index = start; index <= end; index += 1) {
    const line = cleanLine(lines[index]);
    const selected = SELECTED_RE.test(line);
    const previous = rows.at(-1);
    if (previous && !selected && wrappedFrom(lines[index - 1], line)) {
      previous.label = normalizeText(`${previous.label} ${line}`);
      continue;
    }
    rows.push({ label: line.replace(SELECTED_RE, "").trim(), selected, lineIndex: index });
  }
  if (unsure) return null;
  if (rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length !== 1) return null;
  if (rows.some((row) => !row.label || NUMBERED_OPTION_RE.test(row.label))) return null;
  // the panel above the rows: its first line names it, a sentence ending in "?" asks
  let top = start - 1;
  while (top >= 0 && !isDivider(lines[top]) && start - top <= 30) top -= 1;
  const panel = lines.slice(top + 1, start).map(cleanLine).filter(Boolean);
  const title = (panel[0] ?? "Choose an option").replace(/:$/, "");
  const prose = normalizeText(panel.slice(1).join(" "));
  const asked = /(?:^|[.:!]\s+)([^.:!?]*\?)/.exec(prose)?.[1]?.trim();
  return finishPrompt({
    kind: "menu", title, question: asked ?? title,
    body: panel.slice(1).join("\n") || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multiSelect: false, customOptionIndex: null,
  }, {
    responder: "claude-confirm", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null,
  });
}

// Claude's task list and the session's titled rule stay under an open panel;
// they are not output after it.
const CLAUDE_TASKS_HEAD_RE = /^(\d+) tasks \(\d+ done, (?:\d+ in progress, )?\d+ open\)$/;
const CLAUDE_TASK_ROW_RE = /^[◻◼✔]\s/;
const CLAUDE_TASKS_MORE_RE = /^…\s\+\d+ pending$/;
const LABELED_RULE_RE = /^─{3,}\s.*─$/;
const CLAUDE_HINT_TAIL_RE = /\besc to (?:cancel|exit|go back)\b/i;
function withoutClaudeTasks(shown) {
  let end = shown.length;
  const head = findLastIndex(shown, (line) => CLAUDE_TASKS_HEAD_RE.test(line));
  if (head >= 0) {
    const total = Number(CLAUDE_TASKS_HEAD_RE.exec(shown[head])[1]);
    let rows = 0;
    let inProgress = false;
    let list = true;
    for (let index = head + 1; index < shown.length && list; index += 1) {
      const line = shown[index];
      if (CLAUDE_TASK_ROW_RE.test(line)) { rows += 1; inProgress = line.startsWith("◼"); }
      else if (CLAUDE_TASKS_MORE_RE.test(line)) list = index === shown.length - 1;
      else if (inProgress && line.endsWith("…") && !/^[❯>›●⏺]/.test(line)) inProgress = false;
      else list = false;
    }
    if (list && rows > 0 && rows <= total) end = head;
  }
  if (LABELED_RULE_RE.test(shown[end - 1] ?? "")) end -= 1;
  return end < shown.length && CLAUDE_HINT_TAIL_RE.test(shown[end - 1] ?? "") ? shown.slice(0, end) : shown;
}

// Whether the prompt still owns the end of the screen: an answered menu
// above later output is no card.
function promptTailIsActive(prompt, screen) {
  const visible = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter((line) => line && !isDivider(line));
  const shown = withoutClaudeTasks(visible);
  const last = shown.at(-1) ?? "";
  const ends = (re) => [1, 2, 3].some((span) =>
    re.test(shown.slice(-span).join(" ")) && (span === 1 || !re.test(shown.slice(-span, -1).join(" "))));
  switch (prompt.responder) {
    case "claude-question": return ends(CLAUDE_ASK_HINT_RE);
    case "claude-submit": return /^(?:[›>❯]\s*)?\d+\.\s+Cancel$/i.test(last);
    // "Esc to cancel", maybe with Claude's own suffixes; anything else after it is not the approval's
    case "claude-approval": return ends(/esc to cancel.*(?:tab|ctrl\+e)|ctrl\+e to explain|^esc to cancel(?:\s*·\s*ctrl\+x ctrl\+k twice to stop background agents)?$/i);
    case "claude-confirm": return ends(CLAUDE_CONFIRM_HINT_RE);
    default: return ends(/ctrl\+g to edit|shift\+tab to approve with this feedback/i);
  }
}

// The card a Claude screen shows, with the reader's bookkeeping, or null.
export function parseClaudePrompt(screen) {
  const text = String(screen ?? "");
  if (secretPrompt(text) !== null) return null;
  const candidates = [parseClaudeQuestion(text), parseClaudeSubmit(text), parseClaudeApproval(text), parseClaudeConfirm(text)];
  return candidates.find((candidate) => candidate !== null && promptTailIsActive(candidate, text)) ?? null;
}

// --- the fallback card -------------------------------------------------------

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

// Whether the screen ends in Claude's /model list or /effort slider, whose
// Enter would save a default: no fallback card for them.
function claudeListWaits(lines) {
  const tail = compactLines(lines.slice(-16));
  return CLAUDE_MODEL_GUARD_RE.test(tail) || CLAUDE_EFFORT_GUARD_RE.test(tail);
}

// For a pane herdr reports blocked on a screen no reader knows: the screen's
// last lines with the keys its hint lines name, plus Enter and Esc; a
// numbered menu that owns the screen's end is answered by its numbers.
// Null for a password prompt or Claude's own lists.
// `agent` names whose screen it is: a fallback card answers any agent.
export function parseFallbackPrompt(screen, { agent = "claude" } = {}) {
  const asker = agent === "claude" ? "Claude" : "The program";
  const text = String(screen ?? "");
  if (secretPrompt(text) !== null) return null;
  const lines = text.replace(ANSI_RE, "").split(/\r?\n/);
  if (claudeListWaits(lines)) return null;
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
    return screenCard(lines, shown, steady, finishPrompt({
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
  return screenCard(lines, shown, steady, finishPrompt({
    agent, kind: "menu", fallback: true, title: "Waiting for input", question: question ?? `${asker} is waiting for input.`,
    body,
    options: choices.map(({ label }) => ({ label, description: null })),
    multiSelect: false, customOptionIndex: null,
  }, {
    responder: "fallback-keys", menuLabels: choices.map(({ label }) => label), selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, optionSteps: choices.map(({ steps }) => steps),
  }, steadyFields(question, body, steady.read)));
}

// --- answers -----------------------------------------------------------------

// The steps that answer `parsed` with `answer`: exactly one of `option`
// (an index), `options` (indices, for a multiple choice) or `text` (a typed
// answer). A step is `{ keys: [...] }` or `{ text }`.
export function answerSteps(parsed, answer) {
  const supplied = ["option", "options", "text"].filter((name) => answer?.[name] !== undefined);
  if (supplied.length !== 1) throw new InvalidAnswer("Exactly one answer is required.");

  if (answer.text !== undefined) {
    if (typeof answer.text !== "string") throw new InvalidAnswer("The answer text must be text.");
    const text = answer.text.trim();
    if (!text || text.length > 4_000 || parsed.customMenuIndex === null || parsed.multiSelect) throw new InvalidAnswer("This prompt does not take a typed answer.");
    // a typed answer is one line of text: Esc, Enter or ^C inside it would steer the prompt past this card
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) throw new InvalidAnswer("The answer cannot contain control characters.");
    if (parsed.customSteps) return parsed.customSteps(text);
    const navigation = navigationKeys(parsed.customMenuIndex - parsed.selectedIndex);
    return [
      ...keySteps(navigation),
      { text },
      ...(parsed.responder === "claude-plan" ? keySteps([KEY.backtab]) : keySteps([KEY.enter])),
    ];
  }

  if (answer.options !== undefined) {
    if (!Array.isArray(answer.options)) throw new InvalidAnswer("The options must be a list.");
    if (!parsed.multiSelect || answer.options.length === 0) throw new InvalidAnswer("This prompt takes one or more options.");
    const choices = [...new Set(answer.options)];
    if (choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= parsed.options.length)) {
      throw new InvalidAnswer("An option is outside the card.");
    }
    const desired = new Set(choices);
    const checked = new Set(parsed.checkedOptionIndices);
    const toggles = parsed.options.flatMap((_, index) => desired.has(index) !== checked.has(index) ? [index] : []);
    let cursor = parsed.selectedIndex;
    const keys = [];
    for (const optionIndex of toggles) {
      keys.push(...navigationKeys(optionIndex - cursor), KEY.enter);
      cursor = optionIndex;
    }
    // → leaves the choice for the next question or the review of the answers:
    // an Enter there would pick that question's first option
    keys.push(KEY.right);
    return keySteps(keys);
  }

  const index = answer.option;
  if (!Number.isInteger(index) || index < 0 || index >= parsed.options.length || index === parsed.customOptionIndex || parsed.multiSelect) {
    throw new InvalidAnswer("A valid option is required.");
  }
  if (parsed.optionSteps) return parsed.optionSteps[index];
  return keySteps([...navigationKeys(index - parsed.selectedIndex), KEY.enter]);
}

// Whether an answer's keys move the cursor and should be checked on screen
// before the key that commits. Menus answered by their own keys (the
// fallback card's Enter, Esc or digits) are sent as they are.
export function verifiesCursor(parsed) {
  return !parsed.optionSteps;
}
