// A Kiro CLI pane's conversation, read from the transcript Kiro writes:
// `~/.kiro/sessions/<workspace hash>/sess_<uuid>/messages.jsonl`. The workspace
// hash is the first 16 hex of sha256(cwd). Each line is one event,
// `{ id, timestamp, payload }`, and `payload.type` says what it is. Paging,
// cursors and tool output lookups are shared with Claude and Codex (pages.mjs);
// this file is the Kiro format they read with.
//
// Unlike Claude's transcript, Kiro writes every record whole (no parentUuid
// chain, no in-place rewrites to follow) and links a tool call to its result
// by `toolCallId`, so the parser stays close to the records themselves.
import { TOOL_ID, record, setToolOutput, toolInputFields } from "./pages.mjs";

// The uuid that names a session directory, after the `sess_` prefix.
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const string = (value) => (typeof value === "string" ? value : "");

// Kiro's own name for a session's workspace directory: the first 16 hex
// characters (8 bytes) of sha256(cwd). Recorded on Kiro CLI, confirmed against
// a live session directory.
import { createHash } from "node:crypto";
export function kiroWorkspaceHash(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

// The one-line summary a collapsed tool row shows, from the call's own fields.
function toolSummary(name, args) {
  const first = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url ?? args.description;
  return typeof first === "string" ? first.replace(/\s+/gu, " ").trim().slice(0, 120) : name;
}

// Splits transcript text into turns. A `turn_start` opens an assistant turn;
// the user prompt written just before it is that turn's prompt. Adjacent
// assistant records (Say text and Reasoning) merge into the open turn, and each
// tool_result is folded into the tool part its toolCallId names.
export function parseKiroTurns(text) {
  const turns = [];
  // tool parts still waiting for their result, by toolCallId
  const pending = new Map();

  const assistantTurn = (ts) => {
    const last = turns.at(-1);
    if (last !== undefined && last.role === "assistant") return last;
    const turn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn tail line while Kiro is mid-append, or any malformed line
    }
    const payload = record(entry?.payload);
    const type = payload.type;
    const ts = typeof entry?.timestamp === "string" ? entry.timestamp : null;

    if (type === "user") {
      const content = string(payload.content);
      if (content.trim().length === 0) continue;
      turns.push({ role: "user", ts, parts: [{ kind: "text", text: content }] });
      continue;
    }

    if (type === "assistant") {
      const content = string(payload.content);
      if (content.length === 0) continue;
      // Kiro records thinking as an assistant record of operationType "Reasoning".
      const kind = payload.operationType === "Reasoning" ? "thinking" : "text";
      // A Reasoning of only "..." stands for thinking Kiro keeps encrypted
      // (reasoningSignature), most often written right after the answer: no
      // words to show, and after the answer it would read as work still going.
      if (kind === "thinking" && /^[\s.…]*$/u.test(content)) continue;
      const turn = assistantTurn(ts);
      if (ts) turn.end_ts = ts;
      turn.parts.push({ kind, text: content });
      continue;
    }

    if (type === "tool_call") {
      const name = string(payload.toolName);
      const id = typeof payload.toolCallId === "string" && TOOL_ID.test(payload.toolCallId) ? payload.toolCallId : null;
      const args = record(payload.args);
      const turn = assistantTurn(ts);
      if (ts) turn.end_ts = ts;
      const part = {
        kind: "tool",
        id,
        name,
        summary: toolSummary(name, args),
        ...toolInputFields(JSON.stringify(args, null, 2)),
        output: "",
      };
      turn.parts.push(part);
      if (id !== null) pending.set(id, part);
      continue;
    }

    if (type === "tool_result") {
      const id = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      if (id === null) continue;
      const tool = pending.get(id);
      if (tool === undefined) continue;
      pending.delete(id);
      setToolOutput(tool, string(payload.content));
      if (payload.success === false) tool.error = true;
      continue;
    }

    // turn_start/turn_end, session_metadata, pending_interaction,
    // interaction_resolved, sub_agent_*, usage_summary and the rest carry no
    // turn text of their own.
  }

  return { turns: turns.filter((turn) => turn.parts.length > 0) };
}

export function parseKiroTranscript(text) {
  return parseKiroTurns(text).turns;
}

// ---------------------------------------------------------------------------
// Metadata: the model the turns ran at and the context the last one filled.

const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export function parseKiroMetadata(text) {
  const metadata = { model: null, reasoning_effort: null };
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let payload;
    try { payload = record(JSON.parse(line)?.payload); } catch { continue; }
    if (payload.type === "assistant") {
      const model = string(payload.reasoningModelId).trim();
      if (model) metadata.model = model;
    } else if (payload.type === "session_metadata" && payload.key === "contextUsage") {
      const percentage = num(record(payload.value).usagePercentage);
      if (percentage !== null) metadata.context = { usedPercent: percentage };
    }
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Where pages start, and where a tool's output is.

const TURN_MARK = Buffer.from('"turn_start"');

// Offsets (into `bytes`) of the lines that open a turn: each `turn_start`. The
// user prompt sits on the line just before it, so a page that begins on a
// turn_start keeps the prompt with its answer.
export function kiroTurnStarts(bytes) {
  const starts = [];
  let userOffset = -1;
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes(Buffer.from('"user"'))) {
      try {
        if (record(JSON.parse(line.toString("utf8"))?.payload).type === "user") userOffset = offset;
      } catch { /* a torn line opens nothing */ }
    } else if (line.includes(TURN_MARK)) {
      let entry = null;
      try { entry = JSON.parse(line.toString("utf8")); } catch { /* a cut or torn line opens nothing */ }
      if (record(entry?.payload).type === "turn_start") {
        starts.push(userOffset >= 0 ? userOffset : offset);
        userOffset = -1;
      }
    }
    offset = end + 1;
  }
  return starts;
}

function kiroToolOutputIn(entry, toolId) {
  const payload = record(entry.payload);
  if (payload.type !== "tool_result" || payload.toolCallId !== toolId) return null;
  return string(payload.content);
}

// The Kiro transcript format pages.mjs reads with.
export const KIRO_TRANSCRIPT = Object.freeze({
  source: "kiro-transcript",
  turnStarts: kiroTurnStarts,
  parse: parseKiroTurns,
  metadata: parseKiroMetadata,
  headBytes: 0,
  toolNeedle: (toolId) => Buffer.from(`"toolCallId":${JSON.stringify(toolId)}`),
  toolOutputIn: kiroToolOutputIn,
});
