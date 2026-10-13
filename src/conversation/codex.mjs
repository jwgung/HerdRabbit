// A Codex pane's conversation, read from the rollout Codex writes
// ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl): where the
// file is and how it reads as turns. A rollout holds both what the TUI shows
// (event_msg records) and what the model was given (response_item records);
// only the conversation belongs in the chat, never developer prompts, injected
// context or the encrypted reasoning. Paging, cursors and tool output lookups
// are shared with Claude (pages.mjs).
//
// Ported from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- server/codex.ts (the record
// parser, the rollout checks and the screen match), shared/patch.ts, the Codex
// parts of server/conversation.ts and server/conversation-metadata.ts.
// Rewritten for plain Node ESM: every read goes through a store, so the same
// code reads this machine's rollouts and a Herdr machine's over SSH.
import { TOOL_ID, record, setToolOutput, toolInputFields } from "./pages.mjs";

export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const string = (value) => typeof value === "string" ? value : "";

// ---------------------------------------------------------------------------
// Records.

// Context Codex hands the model as a user message: AGENTS.md, the
// environment, permissions and its own notices. Never the user's words.
function contextOnly(text) {
  const value = text.trim();
  return /^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?$/u.test(value)
    || /^<(environment_context|permissions instructions|turn_aborted|subagent_notification|user_instructions)>[\s\S]*<\/\1>$/u.test(value)
    // a skill the user picked reaches the model as its whole instructions
    || /^<skill>\s*<name>[^<>\r\n]+<\/name>\s*<path>[^<>\r\n]+<\/path>[\s\S]*<\/skill>$/u.test(value);
}

// An answer to Codex's queued questions (request_user_input_async) reaches the
// model as a user message: a JSON list of {answer, question, questionItemId}
// inside `<send_user_message_question_reply>`. The chat shows what was answered.
function questionReply(text) {
  const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/u);
  if (!match) return null;
  try {
    const items = JSON.parse(match[1]);
    if (!Array.isArray(items)) return null;
    const answers = items.map((item) => string(record(item).answer).trim()).filter(Boolean);
    return answers.length > 0 ? answers.join("\n") : null;
  } catch {
    return null;
  }
}

// The questions of a request_user_input(_async) call: `title` (async) or `question` (plan mode).
function questionTitles(args) {
  return Array.isArray(args.questions)
    ? args.questions.map((question) => string(record(question).title) || string(record(question).question)).filter(Boolean)
    : [];
}

function contentText(value, user = false) {
  if (typeof value === "string") return user && contextOnly(value) ? "" : value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((raw) => {
    const part = record(raw);
    return ["input_text", "output_text", "text", "summary_text"].includes(string(part.type))
      && typeof part.text === "string" && !(user && contextOnly(part.text)) ? [part.text] : [];
  }).join("\n");
}


// Memory citations are metadata unless the answer quotes them in Markdown code.
export function withoutMemoryCitations(text) {
  const opening = "<oai-mem-citation>";
  const closing = "</oai-mem-citation>";
  if (!text.includes(opening)) return text.trimEnd();

  const tokens = [];
  const quote = /[ \t]*>[ \t]?/y;
  for (const match of text.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/gu)) {
    const source = match[1];
    let offset = 0;
    let quoteDepth = 0;
    quote.lastIndex = 0;
    while (quote.exec(source)) { offset = quote.lastIndex; quoteDepth++; }
    const indent = /^[ \t]*/u.exec(source.slice(offset))[0].length;
    const content = source.slice(offset + indent);
    const list = /^(?:[-+*]|\d+[.)])[ \t]+/u.exec(content);
    const line = { kind: "line", index: match.index, quoteDepth, indent,
      ...(list ? { listIndent: indent + list[0].length } : {}), blank: content.trim() === "" };
    tokens.push(line);
    const body = content.slice(list?.[0].length ?? 0);
    const marker = /^(`{3,}|~{3,})/u.exec(body)?.[0];
    const info = marker ? body.slice(marker.length) : "";
    // a backtick fence's info string cannot contain backticks
    if (marker && (marker[0] !== "`" || !info.includes("`"))) {
      tokens.push({ kind: "fence", index: match.index + offset + indent + (list?.[0].length ?? 0), marker, info, line });
    }
    for (const token of source.matchAll(/`+|<oai-mem-citation>/gu)) {
      tokens.push(token[0] === opening ? { kind: "citation", index: match.index + token.index }
        : { kind: "ticks", index: match.index + token.index, size: token[0].length });
    }
  }
  const closes = new Map();
  const pairs = [];
  // index matching runs once: unmatched delimiters must not repeatedly scan the tail
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token.kind !== "ticks") {
      if (token.kind === "line") closes.clear();
      continue;
    }
    let backslashes = 0;
    for (let at = token.index - 1; at >= 0 && text[at] === "\\"; at--) backslashes++;
    const length = token.size - (backslashes % 2);
    pairs[i] = length > 0 ? closes.get(length) ?? -1 : -1;
    // inside a code span a backslash does not escape its closing backticks
    closes.set(token.size, i);
  }
  const parts = [];
  const listIndents = [];
  let quoteDepth = 0;
  let kept = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "line") {
      if (token.quoteDepth !== quoteDepth) { listIndents.length = 0; quoteDepth = token.quoteDepth; }
      if (token.blank) continue;
      while (listIndents.length > 0 && listIndents.at(-1) > token.indent) listIndents.pop();
      if (token.listIndent !== undefined) listIndents.push(token.listIndent);
      continue;
    }
    if (token.kind === "fence") {
      const within = token.line.listIndent ?? listIndents.at(-1) ?? 0;
      const indent = token.line.listIndent === undefined ? token.line.indent - within : 0;
      if (indent < 0 || indent > 3) continue;
      // an unfinished fence remains code until its quote/list container ends
      for (i++; i < tokens.length; i++) {
        const end = tokens[i];
        if (end.kind === "line" && (end.quoteDepth < token.line.quoteDepth
          || (within > 0 && end.quoteDepth === token.line.quoteDepth && !end.blank && end.indent < within))) { i--; break; }
        if (end.kind === "fence" && end.line.quoteDepth === token.line.quoteDepth && end.marker[0] === token.marker[0]
          && end.marker.length >= token.marker.length && /^[ \t]*$/u.test(end.info)) {
          // the closing line's raw backtick/citation tokens are skipped too
          while (i + 1 < tokens.length && tokens[i + 1].kind !== "line") i++;
          break;
        }
      }
      continue;
    }
    const pair = pairs[i];
    if (pair !== undefined && pair >= 0) { i = pair; continue; }
    if (token.kind !== "citation") continue;
    parts.push(text.slice(kept, token.index));
    const close = text.indexOf(closing, token.index + opening.length);
    kept = close === -1 ? text.length : close + closing.length;
    // metadata contents cannot open code spans or fences in the surrounding answer
    while (i + 1 < tokens.length && tokens[i + 1].index < kept) i++;
  }
  parts.push(text.slice(kept));
  return parts.join("").trimEnd();
}

// Whether a Codex tool output says the call failed. Codex records no flag: its
// command runner writes the exit code into the output, and a script or patch
// its own verdict. A script that completed is judged as a whole.
export function codexCallFailed(output) {
  const head = output.slice(0, 2000);
  if (/^Script completed\b/mu.test(head)) return false;
  if (/^Script failed\b/mu.test(head) || /apply_patch verification failed/u.test(head)) return true;
  const code = /^(?:Process exited with code|Exit code:) (\d+)$/mu.exec(head) ?? /"exit_code":\s*(\d+)/u.exec(head);
  return code !== null && code[1] !== "0";
}

const PATCH_BEGIN = "*** Begin Patch";

// The patch an edit call carries (an apply_patch input, or the string an exec
// script hands tools.apply_patch), or null when the input is not one.
export function patchText(input) {
  const trimmed = input.trimStart();
  if (trimmed.startsWith(PATCH_BEGIN)) return trimmed;
  const call = /tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/su.exec(input);
  if (call === null) return null;
  const literal = call[1];
  let text;
  if (literal.startsWith("`")) text = literal.slice(1, -1).replace(/\\`/gu, "`");
  else {
    try { text = JSON.parse(literal); } catch { return null; }
  }
  return typeof text === "string" && text.trimStart().startsWith(PATCH_BEGIN) ? text.trimStart() : null;
}

// The files a patch adds, updates or deletes, in the order it names them.
export function patchFiles(patch) {
  const files = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu)) {
    const file = match[1].trim();
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,/u;

// The images a user record attached, named but not carried: their bytes stay
// where Codex keeps them.
function imageParts(entry) {
  const payload = record(entry.payload);
  let values = [];
  if (entry.type === "event_msg" && payload.type === "user_message") {
    values = [payload.local_images, payload.images].flatMap((value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } else if (entry.type === "response_item" && payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
    values = payload.content.flatMap((value) => {
      const part = record(value);
      const path = part.type === "input_image" ? part.image_url : part.type === "local_image" ? part.path : null;
      return typeof path === "string" ? [path] : [];
    });
  }
  return [...new Set(values)].flatMap((value) => {
    const inline = DATA_IMAGE.exec(value);
    if (!inline && /^[a-z][a-z\d+.-]*:/iu.test(value)) return [];
    const extension = /\.[A-Za-z0-9]+$/u.exec(value)?.[0]?.toLowerCase();
    const mediaType = inline?.[1] ?? IMAGE_TYPES[extension];
    return mediaType ? [{ kind: "image", media_type: mediaType }] : [];
  });
}

// The one-line summary a collapsed tool row shows.
function codexToolSummary(name, raw, args) {
  const patch = typeof raw === "string" ? patchText(raw) : null;
  if (patch !== null && patchFiles(patch).length > 0) return patchFiles(patch).join(", ");
  if (/^request_user_input/u.test(name) && questionTitles(args).length > 0) return questionTitles(args).join(" · ");
  // the shell tool's command is an argv: `bash -lc "<script>"` reads as its script
  if (Array.isArray(args.command) && args.command.every((part) => typeof part === "string") && args.command.length > 0) {
    const argv = args.command;
    return argv.length >= 3 && /^-\w*c$/u.test(argv.at(-2)) ? argv.at(-1) : argv.join(" ");
  }
  return [args.cmd, args.command, args.file_path, args.path, args.pattern, args.description, args.url, args.query].find((value) => typeof value === "string");
}

const PHASES = new Set(["commentary", "final_answer"]);

// Splits rollout text into turns, shaped as the Claude parser's: a user turn
// per prompt; the agent's messages, reasoning summaries and tool calls in one
// assistant turn; each output folded into the call it answers. The TUI's
// event and the model's copy of the same message are read once.
export function parseCodexTurns(text) {
  const turns = [];
  // tool parts still waiting for their output, by call id
  const tools = new Map();
  // the last few messages, for the copy of each that the other record kind writes
  const messages = [];
  let startedAt = null;

  const assistant = (ts) => {
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", ts: startedAt || ts || null, parts: [] };
      turns.push(turn);
    }
    if (ts) turn.end_ts = ts;
    return turn;
  };

  const message = (role, raw, source, ts, phase, images = []) => {
    const body = role === "user" ? questionReply(raw) ?? raw : withoutMemoryCitations(raw);
    if (!body.trim() && images.length === 0) return;
    const duplicate = messages.slice(-8).reverse().find((other) => !other.paired && other.role === role && other.text === body
      && other.source !== source && (other.ts === ts || Math.abs(Date.parse(other.ts) - Date.parse(ts)) <= 1000));
    if (duplicate) {
      duplicate.paired = true;
      if (phase) duplicate.part.phase = phase;
      // the event's images are the ones the user attached; a response's are its copies of them
      if (images.length > 0 && (source === "event" || !duplicate.turn.parts.some((part) => part.kind === "image"))) {
        duplicate.turn.parts = [...images, ...duplicate.turn.parts.filter((part) => part.kind !== "image")];
      }
      return;
    }
    const part = { kind: "text", text: body, ...(phase ? { phase } : {}) };
    let turn;
    if (role === "user") {
      turn = { role, ts: ts || null, parts: [...images, ...(body.trim() ? [part] : [])] };
      turns.push(turn);
    } else {
      turn = assistant(ts);
      turn.parts.push(part);
    }
    messages.push({ role, text: body, source, ts, paired: false, part, turn });
    if (messages.length > 8) messages.shift();
  };

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // a torn tail line, or any malformed one
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const payload = record(entry.payload);
    const ts = string(entry.timestamp);

    // a compaction folds the history into a summary: the chat marks where
    if (entry.type === "compacted") {
      turns.push({ role: "user", ts: ts || null, parts: [{ kind: "compact", text: string(payload.message) }] });
      tools.clear();
      continue;
    }

    if (entry.type === "event_msg") {
      if (payload.type === "task_started") startedAt = string(payload.started_at) || ts || null;
      if (payload.type === "task_complete" || payload.type === "turn_aborted") {
        const turn = turns.at(-1);
        if (turn?.role === "assistant" && ts) turn.end_ts = ts;
        startedAt = null;
      }
      if (payload.type === "user_message" && (!payload.kind || payload.kind === "plain")) {
        message("user", contentText(payload.message, true), "event", ts, undefined, imageParts(entry));
      }
      if (payload.type === "agent_message") {
        message("assistant", contentText(payload.message), "event", ts, PHASES.has(payload.phase) ? payload.phase : undefined);
      }
      continue;
    }
    if (entry.type !== "response_item") continue;

    if (payload.type === "message") {
      if (payload.role === "user") {
        const content = Array.isArray(payload.content) ? payload.content : [{ type: "input_text", text: payload.content }];
        message("user", contentText(content, true), "response", ts, undefined, imageParts(entry));
      } else if (payload.role === "assistant") {
        const body = contentText(payload.content);
        if (payload.channel === "analysis") {
          if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
        } else if (!payload.recipient || payload.recipient === "all") {
          message("assistant", body, "response", ts, PHASES.has(payload.phase) ? payload.phase : undefined);
        }
      }
      // developer and system messages are Codex's own instructions
    } else if (payload.type === "reasoning") {
      // the summary Codex shows; encrypted_content is the model's and stays out
      const body = contentText(payload.summary);
      if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") {
      const name = string(payload.name) || (payload.type === "local_shell_call" ? "shell" : "tool");
      const raw = payload.type === "function_call" ? payload.arguments : payload.type === "custom_tool_call" ? payload.input : record(payload.action);
      let args = record(raw);
      if (typeof raw === "string") { try { args = record(JSON.parse(raw)); } catch { /* freeform input */ } }
      const inputText = Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : string(raw);
      const callId = string(payload.call_id) || string(payload.id);
      const part = {
        kind: "tool",
        id: TOOL_ID.test(callId) ? callId : null,
        name,
        summary: (string(codexToolSummary(name, raw, args)).replace(/\s+/gu, " ").trim() || name).slice(0, 120),
        ...toolInputFields(inputText),
        output: "",
      };
      assistant(ts).parts.push(part);
      if (callId) tools.set(callId, part);
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const callId = string(payload.call_id);
      const tool = tools.get(callId);
      if (!tool) continue;
      tools.delete(callId);
      const output = outputOf(payload);
      setToolOutput(tool, output);
      if (codexCallFailed(output)) tool.error = true;
      const turn = turns.at(-1);
      if (turn?.role === "assistant" && ts) turn.end_ts = ts;
    }
  }
  return { turns: turns.filter((turn) => turn.parts.length > 0), cleared: false };
}

// A function call's output: text, a list of content items, or (older Codex)
// `{ content, success }` serialized or not.
function outputOf(payload) {
  const output = payload.output;
  if (output !== null && typeof output === "object" && !Array.isArray(output)) return contentText(output.content);
  return contentText(output);
}

export function parseCodexTranscript(text) {
  return parseCodexTurns(text).turns;
}

// ---------------------------------------------------------------------------
// Metadata: the model and effort of the newest turn context, and the context
// the last request filled against the window Codex states.

const count = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const label = (value) => typeof value === "string" && value.trim() && !value.startsWith("<") ? value.trim() : null;

export function parseCodexMetadata(text) {
  const metadata = { model: null, reasoning_effort: null };
  for (const line of text.split("\n")) {
    if (!line.includes('"turn_context"') && !line.includes('"session_meta"') && !line.includes('"token_count"')) continue;
    let entry;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    const payload = record(entry.payload);
    if (entry.type === "event_msg" && payload.type === "token_count") {
      const info = record(payload.info);
      const used = count(record(info.last_token_usage).total_tokens);
      if (used > 0) metadata.context = { used, window: count(info.model_context_window) || null };
      continue;
    }
    if (entry.type !== "turn_context" && entry.type !== "session_meta") continue;
    const settings = record(record(payload.collaboration_mode).settings);
    const model = label(payload.model) ?? label(settings.model);
    const effort = "effort" in payload ? payload.effort
      : "reasoning_effort" in payload ? payload.reasoning_effort : settings.reasoning_effort;
    if (model) metadata.model = model;
    // a new complete context without effort must not keep an older one
    if (model || effort !== undefined) metadata.reasoning_effort = label(effort);
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Where pages start, and where a tool's output is.

const TURN_MARK = Buffer.from('"task_started"');

// Offsets (into `bytes`) of the lines that open a turn: a Codex task starts
// with task_started, and its prompt, the copies of it and its tool calls
// all follow.
export function codexTurnStarts(bytes) {
  const starts = [];
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes(TURN_MARK)) {
      let entry = null;
      try { entry = JSON.parse(line.toString("utf8")); } catch { /* a cut or torn line opens nothing */ }
      if (entry?.type === "event_msg" && entry.payload?.type === "task_started") starts.push(offset);
    }
    offset = end + 1;
  }
  return starts;
}

function codexToolOutputIn(entry, toolId) {
  const payload = record(entry.payload);
  if (entry.type !== "response_item" || (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output")) return null;
  return payload.call_id === toolId ? outputOf(payload) : null;
}

// The Codex rollout format pages.mjs reads with.
export const CODEX_TRANSCRIPT = Object.freeze({
  source: "codex-transcript",
  turnStarts: codexTurnStarts,
  parse: parseCodexTurns,
  metadata: parseCodexMetadata,
  // the session's first turn context sits near the file's start
  headBytes: 64 * 1024,
  toolNeedle: (toolId) => Buffer.from(`"call_id":${JSON.stringify(toolId)}`),
  toolOutputIn: codexToolOutputIn,
});

// ---------------------------------------------------------------------------
// Where the rollout is.

// The session_meta a rollout opens with, as read from its first line: a
// rollout of Codex's own subagents or of a `codex exec` child is not the
// pane's conversation.
export function interactiveRolloutHeader(firstLine) {
  let header;
  try { header = record(JSON.parse(firstLine)); } catch { return false; }
  if (header.type !== "session_meta") return false;
  const meta = record(header.payload);
  if (meta.source !== undefined && typeof meta.source !== "string") return false;
  if (meta.source === "subagent" || (meta.thread_source && meta.thread_source !== "user") || meta.agent_role) return false;
  return true;
}

// How much of a rollout's start its header may take (base instructions are long).
const HEADER_BYTES = 1024 * 1024;
let checkedHeaders = new WeakMap();

// Whether the rollout at `path` opens as an interactive session. Read once per
// file identity and store: a header never changes.
export async function rolloutIsInteractive(store, path) {
  const stat = await store.stat(path);
  if (!stat) return false;
  let known = checkedHeaders.get(store);
  if (!known) { known = new Map(); checkedHeaders.set(store, known); }
  const key = `${path}\0${stat.identity}`;
  if (known.has(key)) return known.get(key);
  const bytes = await store.read(path, 0, Math.min(stat.size, HEADER_BYTES));
  const newline = bytes.indexOf(0x0a);
  // a header not written whole yet says nothing either way: asked again next time
  if (newline === -1) return false;
  const verdict = interactiveRolloutHeader(bytes.subarray(0, newline).toString("utf8"));
  known.set(key, verdict);
  if (known.size > 256) known.delete(known.keys().next().value);
  return verdict;
}

const normalizeDisplay = (text) => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");

// What of an answer to look for on screen: its last 160 letters and digits.
// Codex shows a markdown link as its label and target, so the text is cut at
// link targets and the anchor is the end of the last piece long enough.
function answerAnchor(text) {
  const pieces = text.split(/\]\([^)\s]*\)/u);
  for (let index = pieces.length - 1; index >= 0; index--) {
    const anchor = normalizeDisplay(pieces[index]).slice(-160);
    if (anchor.length >= 64 && new Set(anchor).size >= 12) return anchor;
  }
  return null;
}

// The last resort: the rollout one of whose recent, substantial answers the
// pane's screen shows, when exactly one does. Recency of a file alone is never
// evidence: several panes can share a directory.
export function matchCodexTranscript(screen, candidates) {
  const lastHeader = screen.lastIndexOf("OpenAI Codex (v");
  const display = normalizeDisplay(lastHeader >= 0 ? screen.slice(lastHeader) : screen);
  const matching = new Set();
  for (const candidate of candidates) {
    const prose = parseCodexTranscript(candidate.text).filter((turn) => turn.role === "assistant")
      .flatMap((turn) => turn.parts).filter((part) => part.kind === "text").slice(-8);
    if (prose.some((part) => {
      const anchor = answerAnchor(part.text);
      return anchor !== null && display.includes(anchor);
    })) matching.add(candidate.path);
  }
  return matching.size === 1 ? [...matching][0] : null;
}

// What a screen match reads of each candidate: its newest answers are here.
const MATCH_TAIL_BYTES = 1024 * 1024;

// The rollout a pane's Codex writes, or null when nothing tells. In order:
//  1. the rollout herdr reports for the pane (agent_session kind "path"),
//     kept only when it lies in the store's sessions and opens as an
//     interactive session;
//  2. the one rollout the pane's own Codex processes hold open (`pids`);
//  3. the thread herdr reports (agent_session kind "id"), found through
//     Codex's thread index (state_*.sqlite) or by its file name;
//  4. the screen: one recent rollout of the pane's directory whose answer the
//     pane shows (`readScreen`), and only one.
// `store.codex` answers rollout(path), thread(id), openBy(pids) and
// threadsIn(cwd); a store without one of them skips that step.
export async function locateCodexRollout(store, { session = null, cwd = null, pids = [], readScreen = null } = {}) {
  const codex = store.codex ?? {};
  const kept = async (path) => (path !== null && await rolloutIsInteractive(store, path) ? path : null);
  if (session?.kind === "path" && typeof session.value === "string") {
    return codex.rollout ? kept(await codex.rollout(session.value)) : null;
  }
  const open = new Set();
  if (pids.length > 0 && codex.openBy) {
    for (const path of await codex.openBy(pids)) if (await kept(path) !== null) open.add(path);
    if (open.size === 1) return [...open][0];
  }
  const thread = (session?.kind === undefined || session?.kind === "id") && typeof session?.value === "string" && THREAD_ID.test(session.value)
    ? session.value : null;
  if (thread !== null && codex.thread) {
    const path = await kept(await codex.thread(thread));
    if (path !== null) return path;
  }
  if (!readScreen || typeof cwd !== "string" || !cwd) return null;
  const paths = [...new Set([...open, ...(codex.threadsIn ? await codex.threadsIn(cwd) : [])])];
  if (paths.length === 0) return null;
  const candidates = [];
  for (const path of paths) {
    try {
      if (await kept(path) === null) continue;
      const stat = await store.stat(path);
      const start = Math.max(0, stat.size - MATCH_TAIL_BYTES);
      let text = (await store.read(path, start, stat.size - start)).toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      candidates.push({ path, text });
    } catch { /* a rollout gone meanwhile is no candidate */ }
  }
  if (candidates.length === 0) return null;
  let screen;
  try { screen = await readScreen(); } catch { return null; }
  return typeof screen === "string" ? matchCodexTranscript(screen, candidates) : null;
}

// A pane's Codex processes, from herdr's process info: the executable, or a
// script an interpreter runs (`node …/codex.js`). An option that runs code or
// takes the next argument ends the search: what follows is not the script.
const CODE_OPTIONS = new Set(["eval", "print", "require", "import", "loader", "experimental-loader", "input-type"]);
const VALUELESS_OPTIONS = new Set([
  "", "no-warnings", "no-deprecation", "trace-warnings", "trace-deprecation", "pending-deprecation", "throw-deprecation",
  "enable-source-maps", "preserve-symlinks", "preserve-symlinks-main", "expose-gc", "abort-on-uncaught-exception",
  "experimental-strip-types", "experimental-transform-types", "experimental-vm-modules", "experimental-require-module",
  "no-experimental-fetch", "harmony", "bun", "smol", "hot", "watch", "noprofile", "norc", "posix", "login",
]);
const CODEX_EXECUTABLE = /(?:^|[\\/])codex(?:\.js|\.exe)?$/u;

export function isCodexProcess(argv) {
  if (!Array.isArray(argv)) return false;
  const executable = argv[0] ?? "";
  if (CODEX_EXECUTABLE.test(executable)) return true;
  if (!/(?:^|[\\/])(?:node|bun|sh|bash|dash|zsh)(?:\.exe)?$/u.test(executable)) return false;
  let script = 1;
  for (; typeof argv[script] === "string" && argv[script].startsWith("--"); script++) {
    const option = argv[script];
    const name = option.slice(2, option.includes("=") ? option.indexOf("=") : undefined);
    if (CODE_OPTIONS.has(name)) return false;
    if (!option.includes("=") && !VALUELESS_OPTIONS.has(name)) return false;
  }
  return CODEX_EXECUTABLE.test(argv[script] ?? "");
}

// Tests compare cold reads.
export function forgetCodexState() {
  checkedHeaders = new WeakMap();
}
