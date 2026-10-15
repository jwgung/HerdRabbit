// Claude Code's interactive prompts read off its pane's screen: a tool
// approval (Yes / Yes, and don't ask again / No), a plan to approve, an
// AskUserQuestion menu (one choice or several, with a typed answer), the
// review that submits several answers, and Claude's unnumbered menus (the
// folder-trust check). Each becomes a card: what it asks, its options, and
// the keys that answer each option (screen.mjs). A screen none of these know
// gets the fallback card (fallback.mjs).
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- server/prompt.ts, reduced to
// Claude Code's parsers (parseClaudeQuestion, parseClaudeSubmit,
// parseClaudeApproval, parseClaudeConfirm). Bun.stringWidth is replaced by
// ./text-width.mjs.
import { secretPrompt } from "../secret-prompt.mjs";
import {
  ANSI_RE,
  KEY,
  NUMBERED_OPTION_RE,
  SELECTED_RE,
  SOLID_RULE_RE,
  cleanLine,
  compactLines,
  findLastIndex,
  finishPrompt,
  hintEnds,
  isDivider,
  keySteps,
  menuRows,
  navigationKeys,
  nearestQuestion,
  normalizeText,
  parseNumberedRows,
  sequentialRows,
  wrapped,
} from "./screen.mjs";
import { indexAtColumn, stringWidth } from "./text-width.mjs";

// several questions navigate between tabs: "Tab/Arrow keys to navigate"
const CLAUDE_ASK_HINT_RE = /enter to select.*(?:↑\/↓|tab\/arrow keys) to navigate.*esc to cancel/i;
// question tabs, whole (`←  ☒ Route  ☐ Author  ✔ Submit  →`) or cut off by a narrow pane
const CLAUDE_TABS_RE = /^←\s+[☐☒☑✔]/;
// the review step's last row: "2. Cancel", maybe the selected one
const CLAUDE_SUBMIT_CANCEL_RE = /^(?:[›>❯]\s*)?\d+\.\s+Cancel$/i;
// Claude Code's unnumbered menus (the folder-trust check on a new folder, among others)
const CLAUDE_CONFIRM_HINT_RE = /enter to confirm.*esc to (?:cancel|exit|go back)/i;
// Claude's /model list and /effort slider: their Enter saves a default, so a
// screen showing one gets no fallback card (the terminal answers them).
const guardRe = (parts) => new RegExp(parts
  .map((part) => [...part.replace(/\s+/g, "")].map((char) => char.replace(/[/.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")).join(".*"), "i");
const CLAUDE_EFFORT_GUARD_RE = guardRe(["←/→ to adjust · Enter to confirm", "Esc to cancel"]);
const CLAUDE_MODEL_GUARD_RE = guardRe(["Enter to set as default", "s to use this session only", "Esc to cancel"]);
const CLAUDE_PREVIEW_HINT_RE = /\bn to add notes\b/i;
const PREVIEW_EDGE = "┌│└├╭╰┐┘╮╯";

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
  return finishPrompt("claude", {
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
  return finishPrompt("claude", {
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
    return finishPrompt("claude", {
      kind: "plan", title: "Ready to code?", question: cleanLine(lines[planIndex]),
      body: lines.slice(bodyStart, planIndex).map(cleanLine).filter((line) => !isDivider(line)).join("\n") || null,
      options: rows.map((row) => ({ label: row.label, description: null })), multiSelect: false,
      customOptionIndex: customIndex >= 0 ? customIndex : null,
    }, {
      responder: "claude-plan", menuLabels: rows.map((row) => row.label), selectedIndex: rows.findIndex((row) => row.selected),
      checkedOptionIndices: [], customMenuIndex: customIndex >= 0 ? customIndex : null,
      // the feedback goes with the plan's own key
      typedSubmitKey: KEY.backtab,
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
  return finishPrompt("claude", {
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
  return finishPrompt("claude", {
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
  const ends = (re) => hintEnds(shown, re);
  switch (prompt.responder) {
    case "claude-question": return ends(CLAUDE_ASK_HINT_RE);
    // Its Cancel row last, or under it only Claude's key hint (newer Claude
    // Code adds one: "Enter to select · … · Esc to cancel").
    case "claude-submit": {
      const cancel = shown.findLastIndex((line) => CLAUDE_SUBMIT_CANCEL_RE.test(line));
      if (cancel < 0) return false;
      const after = shown.slice(cancel + 1);
      // Everything under it must be that one hint, from its "Enter to select":
      // another prompt's "Esc to cancel" (a trust check, a later menu) is not the review's.
      return after.length === 0 ||
        (after.length <= 3 && /^enter to select\b/i.test(after[0]) && CLAUDE_ASK_HINT_RE.test(after.join(" ")));
    }
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

// Whether the screen ends in Claude's /model list or /effort slider, whose
// Enter would save a default: the fallback card leaves them to the terminal.
export function claudeListWaits(lines) {
  const tail = compactLines(lines.slice(-16));
  return CLAUDE_MODEL_GUARD_RE.test(tail) || CLAUDE_EFFORT_GUARD_RE.test(tail);
}

// ---------------------------------------------------------------------------
// The card's words from what Claude asked, not from the terminal: there a long
// plan scrolls away and a narrow pane cuts a question or an option short ("…").
// Only words change: the card's id, rows and keys stay the screen's, so an
// answer still goes by what the terminal shows. `ask` is the call Claude waits
// on (conversation/claude.mjs pendingClaudeAsk), or null.

const squash = (text) => String(text ?? "").replace(/\s+/gu, " ").trim();
// What the terminal shows of `full`: all of it, or its start cut with "…".
function shows(shown, full) {
  const seen = squash(shown).replace(/\s*…$/u, "");
  const whole = squash(full);
  return seen.length > 0 && whole.startsWith(seen);
}

// What a card carries of the call's words, at most (characters): a plan to
// read through, a question and its options to pick from.
const MAX_PLAN = 64 * 1024;
const MAX_LINE = 4 * 1024;
const capped = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…` : text;

export function fillClaudeCard(card, ask) {
  if (!card || card.agent !== "claude" || !ask) return card;
  if (card.kind === "plan" && ask.name === "ExitPlanMode") {
    const plan = typeof ask.input.plan === "string" ? ask.input.plan.trim() : "";
    // the plan on screen ends as this one does: not one an earlier session left open
    const last = String(card.body ?? "").split("\n").map(squash).filter(Boolean).at(-1);
    if (!plan || (last && !squash(plan).includes(last.replace(/\s*…$/u, "")))) return card;
    return { ...card, body: capped(plan, MAX_PLAN) };
  }
  if (card.kind !== "question" || ask.name !== "AskUserQuestion" || !Array.isArray(ask.input.questions)) return card;
  const questions = ask.input.questions.filter((item) => item && typeof item.question === "string" && Array.isArray(item.options));
  // the question on screen must be the call's: alike options ("Yes"/"No") say nothing
  const asked = questions.find((item) => shows(card.question, item.question));
  if (!asked) return card;
  // Every option the call has must be the screen's at its place (the screen
  // adds its own after them): one alike label ("Cancel") is not this question.
  const expected = Math.min(card.options.length, asked.options.length);
  let matched = 0;
  const options = card.options.map((option, index) => {
    const full = asked.options[index];
    if (!full || typeof full.label !== "string" || !shows(option.label, full.label)) return option;
    matched += 1;
    const description = typeof full.description === "string" && full.description ? capped(full.description, MAX_LINE) : option.description;
    return { label: capped(full.label, MAX_LINE), description };
  });
  if (expected === 0 || matched < expected) return card;
  return { ...card, question: capped(asked.question, MAX_LINE), options };
}
