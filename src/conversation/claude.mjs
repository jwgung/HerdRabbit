// A Claude Code pane's conversation, read from the transcript Claude writes:
// where the file is and how it reads as turns. Paging, cursors and tool
// output lookups are the same for every agent (pages.mjs); this file is the
// Claude format they read with.
//
// Ported from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- server/claude-store.ts,
// server/conversation.ts (the Claude parts), server/transcript-records.ts,
// server/conversation-metadata.ts and server/tool-output.ts. Rewritten for
// plain Node ESM; every read goes through a store (stores.mjs) so the same
// code reads this machine's files and a Herdr machine's over SSH.
import { TOOL_ID, record, setToolOutput, toolInputFields } from "./pages.mjs";

// How much of a transcript's end is read for a `continued-in` record: only metadata follows one.
const CONTINUED_TAIL_BYTES = 64 * 1024;

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// ---------------------------------------------------------------------------
// Where the transcript is.

const MAX_PROJECT_NAME = 200;

// Java's String.hashCode, which Claude Code uses for the suffix of a long name.
function stringHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

// Claude's own name for the directory it started in (read from Claude Code
// 2.1.284): every character that is not an ASCII letter or digit becomes `-`,
// and a name past 200 characters keeps its first 200 plus `-` and a base-36
// hash of the whole path. The result only ever holds [A-Za-z0-9-].
export function claudeProjectDir(cwd) {
  const name = String(cwd).replace(/[^a-zA-Z0-9]/gu, "-");
  if (name.length <= MAX_PROJECT_NAME) return name;
  return `${name.slice(0, MAX_PROJECT_NAME)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

// A background job Claude opened in this session, by the job's short id in
// parentheses in a local command's notice ("Opening …, running in the
// background (d62fa238)"). Only a job the store knows counts, so other short
// ids in parentheses (a commit's) name nothing.
export const JOB_SHORT_ID = /^[0-9a-f]{8}$/u;
const JOB_NOTICE = /\(([0-9a-f]{8})\)/gu;

// Where this session went on, when it has no user or assistant turn after:
// the session of a `continued-in` record, or a background job a local command
// opened (the pane now shows that job). Oldest first; only the file's tail is
// read. A file that cannot be read names nothing (an empty list).
async function continuations(store, path) {
  let text;
  try {
    const stat = await store.stat(path);
    if (!stat) return [];
    const start = Math.max(0, stat.size - CONTINUED_TAIL_BYTES);
    text = (await store.read(path, start, stat.size - start)).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return [];
  }
  let found = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"type"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "user" || entry?.type === "assistant") found = [];
      else if (entry?.type === "continued-in" && typeof entry.continuedInSessionId === "string" && SESSION_ID.test(entry.continuedInSessionId)) {
        found.push({ session: entry.continuedInSessionId });
      } else if (entry?.type === "system" && entry.subtype === "local_command" && typeof entry.content === "string") {
        for (const match of entry.content.matchAll(JOB_NOTICE)) found.push({ job: match[1] });
      }
    } catch { /* a torn tail line cannot name the active session */ }
  }
  return found;
}

// The transcript of `session` (a UUID): under the project of each cwd in
// turn, else in whichever project holds it (store.locate does both), then
// along where it went on (continued-in, an opened background job) to the file
// written now: the latest of those that has a file. Null when no project holds
// it yet (a session that has not written its first message).
export async function locateClaudeTranscript(store, session, cwds = []) {
  if (typeof session !== "string" || !SESSION_ID.test(session)) return null;
  const dirs = [...new Set(cwds.filter((cwd) => typeof cwd === "string" && cwd.length > 0).map(claudeProjectDir))];
  const seen = new Set([session]);
  let path = await store.locate(session, dirs);
  while (path !== null) {
    let nextPath = null;
    const tried = new Set();
    for (const next of (await continuations(store, path)).reverse()) {
      const key = next.session ?? next.job;
      if (tried.has(key)) continue;
      tried.add(key);
      const id = next.session ?? await store.backgroundJobSession?.(next.job) ?? null;
      if (id === null || seen.has(id)) continue;
      // one whose file is not there (yet) gives way to the one before it
      nextPath = await store.locate(id, dirs);
      if (nextPath !== null) {
        seen.add(id);
        break;
      }
    }
    if (nextPath === null) return path;
    path = nextPath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turns.

// Slash-command and bookkeeping entries Claude logs as user turns, not conversation.
function isCommandEntry(text) {
  return text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("<task-");
}

// A /clear in the user's seat: the conversation starts again after it.
// A whole local-command envelope is required; quoting /clear in prose is not a reset.
export function isContextClear(value) {
  const entry = record(value);
  const message = record(entry.message);
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || message.role !== "user" || typeof message.content !== "string") return false;
  return /^\s*<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/u.test(message.content);
}

// A command's answer is a notice, not a log: the rest of a long one stays in the terminal.
const LOCAL_COMMAND_MAX_CHARS = 4000;
// Lines of one notice Claude Code writes as separate entries, a moment apart.
const NOTICE_JOIN_MS = 1000;

function capNotice(text) {
  return text.length > LOCAL_COMMAND_MAX_CHARS ? `${text.slice(0, LOCAL_COMMAND_MAX_CHARS)}…` : text;
}

// Terminal output without its escape codes and other controls, in one pass.
export function stripTerminalControls(input) {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code !== 0x1b) {
      if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) out += input[i];
      i++;
      continue;
    }
    const kind = input[i + 1];
    if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      i += 2;
      while (i < input.length && input.charCodeAt(i) !== 0x07 && input.charCodeAt(i) !== 0x1b) i++;
      if (input.charCodeAt(i) === 0x07) i++;
      else if (input[i + 1] === "\\") i += 2;
    } else if (kind === "[") {
      i += 2;
      while (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x3f) i++;
      while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
      if (i < input.length && input.charCodeAt(i) >= 0x40 && input.charCodeAt(i) <= 0x7e) i++;
    } else {
      i++;
      while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
      if (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x7e) i++;
    }
  }
  return out;
}

// What a slash command printed, from the `local_command` entry Claude Code
// records it in; the command's echo has no output tag and reads as nothing.
function localCommandOutput(content) {
  if (typeof content !== "string") return "";
  const streams = [];
  let at = 0;
  for (;;) {
    while (at < content.length && /\s/u.test(content[at])) at++;
    if (at === content.length) break;
    const stream = content.startsWith("<local-command-stdout>", at) ? "stdout" : content.startsWith("<local-command-stderr>", at) ? "stderr" : null;
    if (stream === null) return "";
    const start = at + `<local-command-${stream}>`.length;
    const close = `</local-command-${stream}>`;
    let end = content.indexOf(close, start);
    let next = 0;
    while (end !== -1) {
      next = end + close.length;
      while (next < content.length && /\s/u.test(content[next])) next++;
      if (next === content.length || content.startsWith("<local-command-stdout>", next) || content.startsWith("<local-command-stderr>", next)) break;
      end = content.indexOf(close, end + close.length);
    }
    if (end === -1) return "";
    const text = stripTerminalControls(content.slice(start, end)).trim();
    if (text.length > 0) streams.push(text);
    at = next;
  }
  return capNotice(streams.join("\n"));
}

function loneNotice(turn) {
  const part = turn?.parts.length === 1 ? turn.parts[0] : undefined;
  return part?.kind === "notice" ? part : null;
}

function writtenTogether(a, b) {
  return a != null && b != null && Math.abs(Date.parse(a) - Date.parse(b)) <= NOTICE_JOIN_MS;
}

// The same refusal recorded both as a command's answer and as a notice is one answer.
function saidByOtherKind(turn, text, ts, kind) {
  const said = loneNotice(turn);
  if (said === null || said.source === kind || (said.source !== "local-command" && said.source !== "informational")) return false;
  return writtenTogether(turn?.ts, ts) && (said.text === text || said.text.split("\n").includes(text));
}

// Claude Code wraps a long paste in `<pasted_content id="…">` tags; its own
// TUI shows only the text, and so does the chat.
export function unwrapPastes(text) {
  let changed = false;
  const visible = text.replace(/<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="([^"\r\n]+)">/gu,
    (whole, opening, body, closing) => {
      if (opening !== closing || opening.length > 64 || !/^[\w-]+$/u.test(opening)) return whole;
      changed = true;
      return body;
    });
  return changed ? visible.replace(/^\n+|\n+$/gu, "") : text;
}

export function claudeResultText(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.map((part) => (part !== null && typeof part === "object" && typeof part.text === "string" ? part.text : "")).join("");
}

// The one-line summary a collapsed tool row shows.
export function toolSummary(name, input) {
  const first = input.command ?? input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? input.description ?? input.url ?? input.query;
  return typeof first === "string" ? first.replace(/\s+/gu, " ").trim().slice(0, 120) : name;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Splits transcript text into turns. Adjacent assistant entries merge into
// one turn (text, thinking and tool parts in order); each tool_result is
// folded into the tool part it answers. `cleared` says a /clear was read:
// nothing before it belongs to the conversation any more.
export function parseClaudeTurns(text) {
  const turns = [];
  // tool parts still waiting for their result, by tool_use id
  const pending = new Map();
  // the agent's last entry called a tool: its turn is not over, whatever is written meanwhile
  let atWork = false;
  let cleared = false;
  const noticeAt = () => (atWork && turns.at(-1)?.role === "assistant" ? turns.length - 1 : turns.length);

  const assistantTurn = (ts) => {
    const last = turns.at(-1);
    if (last !== undefined && last.role === "assistant") return last;
    const turn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  // A send Claude Code cancelled before any reply is re-sent as a sibling of
  // it (same parentUuid); its own screen shows only the re-send.
  let lastPrompt = null;
  const pushPrompt = (turn, entry) => {
    if (lastPrompt !== null && !lastPrompt.answered && typeof entry.parentUuid === "string" && entry.parentUuid === lastPrompt.parent) {
      const index = turns.indexOf(lastPrompt.turn);
      if (index !== -1) turns.splice(index, 1);
    }
    turns.push(turn);
    lastPrompt = { turn, parent: entry.parentUuid, answered: false };
  };

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn tail line while Claude is mid-append, or any malformed line
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.isMeta) continue;
    // a subagent's own records are not this conversation's turns, its /clear included
    if (entry.isSidechain === true) continue;
    if (isContextClear(entry)) {
      turns.length = 0;
      pending.clear();
      lastPrompt = null;
      atWork = false;
      cleared = true;
      continue;
    }
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : null;
    const content = record(entry.message).content;

    // a compaction's summary marks where the conversation was folded
    if (entry.isCompactSummary) {
      const summary = typeof content === "string" ? content
        : Array.isArray(content) ? content.map((block) => (record(block).type === "text" ? String(record(block).text ?? "") : "")).join("\n") : "";
      turns.push({ role: "user", ts, parts: [{ kind: "compact", text: summary }] });
      continue;
    }

    // A message sent while Claude works is queued, then recorded as this
    // attachment when the turn takes it in. Only a person's prompt counts.
    const queued = entry.type === "attachment" ? record(entry.attachment) : null;
    if (queued?.type === "queued_command" && queued.commandMode === "prompt" && record(queued.origin).kind === "human") {
      if (typeof queued.prompt === "string" && queued.prompt.trim() && !isCommandEntry(queued.prompt.trim())) {
        turns.push({ role: "user", ts, parts: [{ kind: "text", text: unwrapPastes(queued.prompt) }] });
      }
      continue;
    }

    // A slash command answers in the terminal, not through the model.
    if (entry.type === "system" && entry.subtype === "local_command") {
      const output = localCommandOutput(entry.content);
      const at = noticeAt();
      if (output.length > 0 && !saidByOtherKind(turns[at - 1], output, ts, "local-command")) {
        turns.splice(at, 0, { role: "user", ts, parts: [{ kind: "notice", text: output, source: "local-command" }] });
      }
      continue;
    }

    // Claude Code's own notices (an unknown command, a usage limit). Lines
    // written together read as one; one written while the agent works goes
    // before the turn at work, so that turn stays whole and last.
    if (entry.type === "system" && entry.subtype === "informational") {
      const noticeText = typeof entry.content === "string" ? capNotice(stripTerminalControls(entry.content).trim()) : "";
      if (noticeText.length === 0) continue;
      const at = noticeAt();
      const before = turns[at - 1];
      if (saidByOtherKind(before, noticeText, ts, "informational")) continue;
      const said = loneNotice(before);
      if (before && said?.source === "informational" && writtenTogether(before.ts, ts)) {
        turns[at - 1] = { ...before, parts: [{ ...said, text: capNotice(`${said.text}\n${noticeText}`) }] };
      } else {
        turns.splice(at, 0, { role: "user", ts, parts: [{ kind: "notice", text: noticeText, source: "informational" }] });
      }
      continue;
    }

    if (entry.type === "user" && typeof content === "string") {
      if (isCommandEntry(content)) continue;
      pushPrompt({ role: "user", ts, parts: [{ kind: "text", text: unwrapPastes(content) }] }, entry);
      continue;
    }

    if (entry.type === "user" && Array.isArray(content)) {
      const prompt = content.flatMap((block) => {
        const part = record(block);
        return part.type === "text" && typeof part.text === "string" && !isCommandEntry(part.text.trim()) ? [part.text] : [];
      }).join("\n");
      for (const block of content) {
        const result = record(block);
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
        const tool = pending.get(result.tool_use_id);
        if (tool === undefined) continue;
        pending.delete(result.tool_use_id);
        setToolOutput(tool, claudeResultText(result.content));
        if (result.is_error === true) tool.error = true;
      }
      // a pasted image is named, not carried: its bytes stay in the file
      const images = content.flatMap((block) => {
        const image = record(block);
        const source = record(image.source);
        if (image.type !== "image" || typeof source.media_type !== "string" || !IMAGE_TYPES.has(source.media_type)) return [];
        return [{ kind: "image", media_type: source.media_type }];
      });
      if (prompt.trim() || images.length > 0) {
        pushPrompt({ role: "user", ts, parts: [...images, ...(prompt.trim() ? [{ kind: "text", text: unwrapPastes(prompt) }] : [])] }, entry);
      }
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      if (lastPrompt !== null) lastPrompt.answered = true;
      const turn = assistantTurn(ts);
      // an entry that names no stop reason is still at work when it calls a tool
      const stop = record(entry.message).stop_reason;
      atWork = stop === "tool_use" || (stop == null && content.some((block) => record(block).type === "tool_use"));
      if (ts) turn.end_ts = ts;
      for (const block of content) {
        const b = record(block);
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const input = record(b.input);
          const inputText = JSON.stringify(input, null, 2);
          const id = typeof b.id === "string" && TOOL_ID.test(b.id) ? b.id : null;
          const part = {
            kind: "tool",
            id,
            name: b.name,
            summary: toolSummary(b.name, input),
            ...toolInputFields(inputText),
            output: "",
          };
          turn.parts.push(part);
          if (id !== null) pending.set(id, part);
        }
        // other blocks (redacted thinking, server tools) are left out
      }
    }
  }

  return { turns: turns.filter((turn) => turn.parts.length > 0), cleared };
}

export function parseClaudeTranscript(text) {
  return parseClaudeTurns(text).turns;
}

// ---------------------------------------------------------------------------
// Metadata: the model the turns ran at and the context the last one filled.

const CLAUDE_STANDARD_WINDOW = 200_000;
const CLAUDE_LONG_WINDOW = 1_000_000;
const count = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const label = (value) => typeof value === "string" && value.trim() && !value.startsWith("<") ? value.trim() : null;

export function parseClaudeMetadata(text) {
  const metadata = { model: null, reasoning_effort: null };
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"') && !line.includes("/clear")) continue;
    let entry;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    // a subagent's model, effort, context and /clear are its own
    if (entry.isSidechain === true) continue;
    if (isContextClear(entry)) {
      metadata.model = null;
      metadata.reasoning_effort = null;
      delete metadata.context;
      continue;
    }
    if (entry.type !== "assistant") continue;
    const message = record(entry.message);
    const model = label(message.model);
    if (model) metadata.model = model;
    if (model) {
      const usage = record(message.usage);
      const used = count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens);
      if (used > 0) {
        const long = model.startsWith("claude") && (used > CLAUDE_STANDARD_WINDOW || metadata.context?.window === CLAUDE_LONG_WINDOW);
        metadata.context = { used, window: long ? CLAUDE_LONG_WINDOW : null };
      }
    }
    if ("effort" in entry) metadata.reasoning_effort = label(entry.effort);
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Where pages start, and where a tool's output is.

const TURN_MARK = Buffer.from('"user"');

function opensTurn(entry) {
  if (entry === null || typeof entry !== "object" || entry.type !== "user" || entry.isMeta || entry.isCompactSummary || entry.isSidechain === true) return false;
  const content = record(entry.message).content;
  if (typeof content === "string") return !isCommandEntry(content) && !isContextClear(entry);
  return Array.isArray(content) && content.some((block) =>
    record(block).type === "text" && typeof record(block).text === "string" && !isCommandEntry(record(block).text.trim()));
}

// Offsets (into `bytes`) of the lines that open a turn. A prompt Claude Code
// cancelled before any reply and re-sent from the same parent continues the
// cancelled prompt's turn rather than opening one, as parseClaudeTurns reads it.
export function turnStarts(bytes) {
  const starts = [];
  const chain = { parent: null, answered: true };
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes('"type":"assistant"')) chain.answered = true;
    if (line.includes(TURN_MARK)) {
      let entry = null;
      try { entry = JSON.parse(line.toString("utf8")); } catch { /* a cut or torn line opens nothing */ }
      if (opensTurn(entry)) {
        const parent = typeof entry.parentUuid === "string" ? entry.parentUuid : null;
        if (chain.answered || parent === null || parent !== chain.parent) starts.push(offset);
        chain.parent = parent;
        chain.answered = false;
      }
    }
    offset = end + 1;
  }
  return starts;
}

// A tool's output: the user entry whose tool_result answers its tool_use id.
function claudeToolOutputIn(entry, toolId) {
  const content = record(entry.message).content;
  if (!Array.isArray(content)) return null;
  const result = content.find((block) => record(block).type === "tool_result" && record(block).tool_use_id === toolId);
  if (result === undefined) return null;
  return claudeResultText(record(result).content);
}

// The Claude transcript format pages.mjs reads with.
export const CLAUDE_TRANSCRIPT = Object.freeze({
  source: "claude-transcript",
  turnStarts,
  parse: parseClaudeTurns,
  metadata: parseClaudeMetadata,
  headBytes: 0,
  toolNeedle: (toolId) => Buffer.from(`"tool_use_id":${JSON.stringify(toolId)}`),
  toolOutputIn: claudeToolOutputIn,
});

// ---------------------------------------------------------------------------
// What Claude waits on.

// The tools whose question a prompt card shows from the terminal, where a long
// plan scrolls away and a narrow pane cuts an option short.
const ASKING_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

// The last asking tool call in `text` (a transcript's tail) that has no result
// yet: { name, input }, or null.
export function pendingClaudeAsk(text) {
  const open = new Map();
  for (const line of String(text).split("\n")) {
    if (!line.includes('"tool_')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type === "tool_use" && ASKING_TOOLS.has(item.name) && typeof item.id === "string" && item.input && typeof item.input === "object") {
        open.delete(item.id);
        open.set(item.id, { name: item.name, input: item.input });
      } else if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
        open.delete(item.tool_use_id);
      }
    }
  }
  return [...open.values()].at(-1) ?? null;
}

