// What every agent's prompt reader shares: the screen's lines as text
// (cleaned of escapes and box edges), numbered menu rows, the card a reader
// builds and what the browser sees of it, and the keys that answer it.
//
// Adapted from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- server/prompt.ts: its screen
// helpers, the card id hash and the answer keys.
import { createHash } from "node:crypto";

export const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
export const SELECTED_RE = /^[❯›>]\s*/;
const DIVIDER_RE = /^[\s╭╮╰╯├┤┬┴┼─━═╌▔]+$/;
export const SOLID_RULE_RE = /^[─━]{8,}$/;
export const NUMBERED_OPTION_RE = /^\s*([›>❯])?\s*(\d+)\.\s+(.+)$/;

export const KEY = Object.freeze({ up: "up", down: "down", left: "left", right: "right", enter: "enter", escape: "esc", tab: "tab", backtab: "shift+tab" });

// The keys that move a menu's cursor back and forth: up and down, unless the
// card names its own (OpenCode's permission buttons sit in a row: left and right).
export const VERTICAL = Object.freeze({ back: KEY.up, forward: KEY.down });
export const HORIZONTAL = Object.freeze({ back: KEY.left, forward: KEY.right });

export function moveKeysOf(parsed) {
  return parsed?.moveKeys ?? VERTICAL;
}

export class InvalidAnswer extends Error {}

export function cleanLine(rawLine) {
  let line = rawLine.replace(ANSI_RE, "").trim();
  if (line.startsWith("│")) line = line.slice(1).trimStart();
  if (line.endsWith("│")) line = line.slice(0, -1).trimEnd();
  return line.trim();
}

export function isDivider(line) {
  const value = cleanLine(line);
  return Boolean(value) && DIVIDER_RE.test(value);
}

export function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

export function findLastIndex(lines, predicate) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index], index)) return index;
  }
  return -1;
}

// A line and the two after it, as one: a narrow pane wraps a hint line.
export function wrapped(lines, index, span = 3) {
  return lines.slice(index, index + span).map(cleanLine).filter((line) => line && !isDivider(line)).join(" ");
}

export function compactLines(lines) {
  return lines.map(cleanLine).filter((line) => !isDivider(line)).join("").replace(/\s+/g, "");
}

export function nearestQuestion(lines, beforeIndex) {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 14); index -= 1) {
    const line = cleanLine(lines[index]);
    if (!line || isDivider(line) || /^Planning:/i.test(line) || /^[←→].*Submit/i.test(line)
      || /^[☐☑✔]\s+\S/.test(line) || /^Question \d+\/\d+/i.test(line)) continue;
    return line.replace(/^\(\d+\s+selected\)\s*/i, "").trim();
  }
  return null;
}

export function parseNumberedRows(lines, start, end) {
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
export function menuRows(lines, start, end) {
  const rows = parseNumberedRows(lines, start, end);
  const column = (row) => lines[row.lineIndex].replace(ANSI_RE, "").search(/\d/);
  const anchor = [...rows].reverse().find((row) => row.selected) ?? rows.at(-1);
  const menu = anchor === undefined ? rows : rows.filter((row) => column(row) === column(anchor));
  return menu.slice(Math.max(0, menu.map((row) => row.number).lastIndexOf(1)));
}

export function sequentialRows(rows) {
  return rows.length > 0 && rows.every((row, index) => row.number === index + 1);
}

export function hashOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

// The card's id hashes everything it shows (and what `hashed` adds), never
// where the cursor is: a moved cursor is the same prompt, a changed command
// or option is another one. Ticks are not shown in the hashed options either.
// The body is capped for display after hashing. `agent` names whose screen
// it is (a fallback card's input names its own).
//
// `promptKey` is what an answer in progress checks between its keys: for a
// multiple choice it leaves out the title as well, since a tick can mark the
// question's tab answered and so retitle the card; otherwise it is the id.
export function finishPrompt(agent, input, internal, hashed = {}) {
  const id = hashOf({ agent, ...input, ...hashed });
  const { title: _title, ...untitled } = input;
  const promptKey = input.multiSelect ? hashOf({ agent, ...untitled, ...hashed }) : id;
  return { id, agent, ...input, body: input.body?.slice(0, 12_000) ?? null, promptKey, ...internal };
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
    // the menu has a "Chat about this" row the card offers as its own button
    ...(Number.isInteger(parsed.chatMenuIndex) ? { chat: true } : {}),
    ...(parsed.fallback ? { fallback: true } : {}),
  };
}

export function navigationKeys(delta, moveKeys = VERTICAL) {
  return Array.from({ length: Math.abs(delta) }, () => delta > 0 ? moveKeys.forward : moveKeys.back);
}

export function keySteps(keys) {
  return keys.map((key) => ({ keys: [key] }));
}

// Whether the prompt's hint still ends the screen. A narrow pane wraps a hint,
// so the last line alone can be its tail: the lines before it count only when
// the match runs into the last one, never for a hint that ended above later
// output (an answered, stale menu).
export function hintEnds(shown, re) {
  const every = new RegExp(re.source, re.flags.replace("g", "") + "g");
  return [1, 2, 3].some((span) => {
    const text = shown.slice(-span).join(" ");
    const before = span === 1 ? 0 : shown.slice(-span, -1).join(" ").length;
    // "Press enter to confirm or esc" / "to cancel": its last match is the one that counts
    const last = [...text.matchAll(every)].at(-1);
    return last !== undefined && last.index + last[0].length > before;
  });
}

// The screen's visible lines, cleaned, without blank lines and rules.
export function visibleLines(screen) {
  return String(screen ?? "").replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter((line) => line && !isDivider(line));
}

// --- answers -----------------------------------------------------------------

// The steps that answer `parsed` with `answer`: exactly one of `option`
// (an index), `options` (indices, for a multiple choice), `text` (a typed
// answer) or `action` ("chat": Claude's "Chat about this" row). A step is
// `{ keys: [...] }` or `{ text }`, either maybe with the `check` the screen
// must pass before it goes (service.mjs).
export function answerSteps(parsed, answer) {
  const supplied = ["option", "options", "text", "action"].filter((name) => answer?.[name] !== undefined);
  if (supplied.length !== 1) throw new InvalidAnswer("Exactly one answer is required.");

  if (answer.action !== undefined) {
    if (answer.action !== "chat" || !Number.isInteger(parsed.chatMenuIndex)) throw new InvalidAnswer("This prompt has no such action.");
    if (!Number.isInteger(parsed.selectedIndex)) throw new InvalidAnswer("The selected option cannot be seen on the screen. Answer in the terminal.");
    // the row as the terminal's user picks it: the cursor onto it, then Enter
    return keySteps([...navigationKeys(parsed.chatMenuIndex - parsed.selectedIndex, moveKeysOf(parsed)), KEY.enter]);
  }

  if (answer.text !== undefined) {
    if (typeof answer.text !== "string") throw new InvalidAnswer("The answer text must be text.");
    const text = answer.text.trim();
    if (!text || text.length > 4_000 || parsed.customMenuIndex === null || parsed.multiSelect) throw new InvalidAnswer("This prompt does not take a typed answer.");
    // a typed answer is one line of text: Esc, Enter or ^C inside it would steer the prompt past this card
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) throw new InvalidAnswer("The answer cannot contain control characters.");
    if (parsed.customSteps) return parsed.customSteps(text);
    // the row that takes the answer, then whatever opens its text line there
    // (Codex's notes: Tab), the text, and the key that sends it
    const navigation = navigationKeys(parsed.customMenuIndex - parsed.selectedIndex, moveKeysOf(parsed));
    return [
      ...keySteps([...navigation, ...(parsed.typedOpenKeys ?? [])]),
      { text },
      ...keySteps([parsed.typedSubmitKey ?? KEY.enter]),
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
      // a menu whose rows take their own keys (OpenCode's digits) ticks each by it
      if (parsed.pickKey) keys.push(parsed.pickKey(optionIndex));
      else keys.push(...navigationKeys(optionIndex - cursor, moveKeysOf(parsed)), KEY.enter);
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
  // an option of the card's own that is no row of the menu (Kiro's "Change
  // scope", its s key): its steps, sent once the menu is seen still on screen
  if (parsed.ownOptionSteps?.[index]) return parsed.ownOptionSteps[index];
  // Codex's "No, and tell Codex what to do differently (esc)" is its Esc
  if (parsed.rejectWithEscapeIndex === index) return keySteps([KEY.escape]);
  if (parsed.pickKey) return keySteps([parsed.pickKey(index)]);
  // a screen that does not show where the cursor is (OpenCode's buttons read
  // without their colours) cannot be moved on blind
  if (!Number.isInteger(parsed.selectedIndex)) throw new InvalidAnswer("The selected option cannot be seen on the screen. Answer in the terminal.");
  return keySteps([...navigationKeys(index - parsed.selectedIndex, moveKeysOf(parsed)), KEY.enter]);
}

// Whether an answer's keys move the cursor and should be checked on screen
// before the key that commits. Menus answered by their own keys (the
// fallback card's Enter, Esc or digits) are sent as they are.
export function verifiesCursor(parsed) {
  return !parsed.optionSteps;
}
