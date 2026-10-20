// How one agent turn reads in the chat: everything the agent did on the way
// (tool calls, thinking, the narration between them) folded under one
// "Worked for 7s · 1 edit" header, and what it said after its last action
// left in the open as the answer. Also the words a tool row uses ("Ran",
// "Edited"), a TodoWrite call's list, and the files a SendUserFile call
// handed over, which read as a card beside the answer.
//
// Ported from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- src/lib/workBlocks.ts,
// src/lib/toolVerbs.ts and src/lib/todos.ts, reduced to Claude Code's,
// Codex's and OpenCode's tools (the server gives OpenCode's inputs Claude's
// field names).

// { work: parts, answer: text parts and delivered files }. Files handed to
// the user are what the turn made, not how: they stay out of the folded work
// wherever they were sent, and are no action the answer has to come after.
export function splitTurn(parts) {
  const delivered = parts.map((part) => deliveredFiles(part) !== null);
  let lastAction = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.kind !== "text" && !delivered[index]) lastAction = index;
  }
  const isProse = (part) => part.kind === "text" && typeof part.text === "string" && part.text.trim().length > 0;
  return {
    work: parts.filter((part, index) => !delivered[index] && (part.kind !== "text" || (isProse(part) && index <= lastAction))),
    answer: parts.filter((part, index) => delivered[index] || (isProse(part) && index > lastAction)),
  };
}

// A work block is open while its turn runs, and folded once it settles --
// unless the work holds the last words the agent said (no answer after them).
export function workStartsOpen(live, parts) {
  if (live) return true;
  const lastAnswer = splitTurn(parts).answer.filter((part) => part.kind === "text").at(-1);
  const after = lastAnswer === undefined ? 0 : parts.lastIndexOf(lastAnswer) + 1;
  return parts.slice(after).some((part) => part.kind === "text" && part.text.trim().length > 0);
}

const CATEGORY_LABEL = {
  edit: ["edit", "edits"],
  read: ["file read", "file reads"],
  command: ["command", "commands"],
  other: ["other tool", "other tools"],
};

function categorize(name) {
  const lower = String(name).toLowerCase();
  if (/edit|write|patch|create_file|multiedit/u.test(lower)) return "edit";
  if (/^(read|glob|grep|ls|list|search|find|cat)/u.test(lower)) return "read";
  if (/bash|command|shell|exec|eval|run/u.test(lower)) return "command";
  return "other";
}

// "1 edit · 2 file reads · 1 command"; failures are counted apart (workFailed).
export function workSummary(parts) {
  const counts = { edit: 0, read: 0, command: 0, other: 0 };
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    // a todo update is the plan, not an edit: TodoWrite would match /write/
    if (!isTodoTool(part.name)) counts[categorize(part.name)] += 1;
  }
  return Object.keys(counts)
    .filter((category) => counts[category] > 0)
    .map((category) => `${counts[category]} ${CATEGORY_LABEL[category][counts[category] === 1 ? 0 : 1]}`)
    .join(" · ");
}

export function workFailed(parts) {
  return parts.filter((part) => part.kind === "tool" && part.error === true).length;
}

// "7s" / "1m 12s" / "2h 5m"; null when the span is unknown or nonsense.
export function formatWorkDuration(startTs, endTs) {
  if (startTs == null || endTs == null) return null;
  const ms = Date.parse(endTs) - Date.parse(startTs);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// The last turn, while the agent works or waits on the user, is the one running.
export function isLiveWorkTurn(turn, last, status) {
  return last && turn?.role === "assistant" && (status === "working" || status === "blocked");
}

// The open block's header: "Needs you", "Working…" or "Worked for 7s".
export function workTitle({ live, status, duration }) {
  if (live && status === "blocked") return "Needs you";
  if (live) return "Working…";
  return duration === null ? "Worked" : `Worked for ${duration}`;
}

// ---------------------------------------------------------------------------
// Tool verbs: "Read src/a.ts", "Ran npm test". Only Claude Code's and
// Codex's own tools, by exact name; anything else (Grep, a web or MCP tool)
// keeps its name.

const VERB_OF = {
  read: "Read",
  edit: "Edited", multiedit: "Edited", notebookedit: "Edited",
  write: "Wrote",
  bash: "Ran",
  // Codex
  exec_command: "Ran", shell: "Ran", local_shell: "Ran",
};

const OBJECT_KEYS = {
  Read: ["file_path", "path"],
  Edited: ["file_path", "notebook_path", "path"],
  Wrote: ["file_path", "path"],
  Ran: ["command", "cmd"],
};

// A command as a row names it: Codex's shell tool takes an argv, and
// `bash -lc "<script>"` reads as its script.
export function commandText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string")) return undefined;
  return value.length >= 3 && /^-\w*c$/u.test(value.at(-2)) ? value.at(-1) : value.join(" ");
}

// The server cuts a row's summary to this many characters.
const SUMMARY_LENGTH = 120;

export function parseToolInput(input) {
  try {
    const value = JSON.parse(input);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The verb a row shows in place of the tool's name, or null: an unknown tool,
// or a summary that is not the call's own command or path.
export function toolVerb(part) {
  const summary = String(part.summary ?? "");
  if (summary.trim().length === 0 || summary === part.name) return null;
  // Codex's patch is its input whole; the server sums it up by the files it touches
  if (String(part.name).toLowerCase() === "apply_patch") return String(part.input ?? "").trimStart().startsWith("*** Begin Patch") ? "Edited" : null;
  const verb = VERB_OF[String(part.name).toLowerCase()];
  if (verb === undefined) return null;
  const input = parseToolInput(part.input ?? "");
  if (input === null) return null;
  const said = (key) => (verb === "Ran" ? commandText(input[key]) : typeof input[key] === "string" ? input[key] : undefined);
  const matches = OBJECT_KEYS[verb].some((key) => said(key) !== undefined &&
    said(key).replace(/\s+/gu, " ").trim().slice(0, SUMMARY_LENGTH) === summary);
  return matches ? verb : null;
}

// Whether a row is a shell command, whose output also scrolled by in the terminal.
export function isCommandTool(name) {
  return categorize(name) === "command";
}

// ---------------------------------------------------------------------------
// Todos: Claude Code's TodoWrite and OpenCode's todowrite send the whole list
// every time.

export function isTodoTool(name) {
  return name === "TodoWrite" || name === "todowrite";
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

// [{ label, status }] from a TodoWrite call's input, or null.
export function todoItems(input) {
  const parsed = parseToolInput(input ?? "");
  if (parsed === null || !Array.isArray(parsed.todos)) return null;
  return parsed.todos.flatMap((todo) => {
    if (todo === null || typeof todo !== "object") return [];
    const label = typeof todo.content === "string" ? todo.content.trim() : "";
    if (!label) return [];
    return [{ label, status: TODO_STATUSES.has(todo.status) ? todo.status : "pending" }];
  });
}

// "3/5 done" for a todo list row; null for any other tool.
export function todoCallSummary(part) {
  if (!isTodoTool(part.name)) return null;
  const items = todoItems(part.input);
  if (items === null) return null;
  return `${items.filter((item) => item.status === "completed").length}/${items.length} done`;
}

// ---------------------------------------------------------------------------
// Files handed over: Claude Code's SendUserFile gives the user files by path,
// with a caption. The terminal shows each as one line; the chat as a card.

// More files than this in one call read as the plain tool row.
export const MAX_DELIVERED_FILES = 20;
// A path longer than this is no path the card shows.
const MAX_DELIVERED_PATH = 4096;

// Claude Code marks no error when a file did not reach every viewer: its
// result's words say so. So a card is drawn only for a result that says the
// files went ("1 file delivered to user.", "2 files delivered to the user.")
// and nowhere that one did not, or reached only some viewers; any other
// wording keeps the tool row.
const DELIVERED_RE = /^\d+ files? delivered to (?:the )?user\.?$/iu;
const NOT_DELIVERED_RE = /\bnot\b[^\n]*\bdeliver|\bno files?\b|only one of its viewers|\bfailed\b|\berror\b/iu;
// a line naming a file that went, whose path may hold any word
const DELIVERED_LINE_RE = /^\s+.+ → file_uuid: [\w-]+$/u;
function deliveredResult(output) {
  if (typeof output !== "string") return false;
  const [first, ...rest] = output.split("\n");
  return DELIVERED_RE.test(first.trim()) && !rest.some((line) => !DELIVERED_LINE_RE.test(line) && NOT_DELIVERED_RE.test(line));
}

// { files: [path], caption } for a SendUserFile call that finished and handed
// its files over, or null: one still running, failed, cut short, with an
// input the card cannot read, or whose result does not say its files were
// delivered (or is too long to tell) keeps the tool row's own look.
export function deliveredFiles(part) {
  if (part?.kind !== "tool" || part.name !== "SendUserFile") return null;
  if (part.error === true || part.input_truncated === true || typeof part.output_size !== "number") return null;
  if (part.output_truncated === true || !deliveredResult(part.output)) return null;
  const input = parseToolInput(part.input ?? "");
  const files = input?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_DELIVERED_FILES) return null;
  const readable = (path) => typeof path === "string" && path.trim().length > 0 && path.length <= MAX_DELIVERED_PATH &&
    !/[\x00-\x1f\x7f]/u.test(path);
  if (!files.every(readable)) return null;
  const caption = typeof input.caption === "string" && input.caption.trim() ? input.caption : null;
  return { files: [...files], caption };
}

// A delivered path as a card line shows it: the file's name, and the folder
// it sits in ("" for a bare name).
export function splitDeliveredPath(path) {
  const trimmed = path.replace(/\/+$/u, "") || path;
  const cut = trimmed.lastIndexOf("/");
  if (cut === -1) return { name: trimmed, folder: "" };
  return { name: trimmed.slice(cut + 1) || trimmed, folder: trimmed.slice(0, cut + 1) };
}
