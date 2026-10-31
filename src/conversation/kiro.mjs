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

// Kiro's steering: a message sent while Kiro works is the user's own record
// (`{ id: "steer-…", source: "steer" }`), and is given to the model again
// inside instructions written as one more user record, marked
// `_meta.kiro.syntheticUserMessageReason: "steering-injection"`. Each message
// in those sits in `<user_message id="steer-…">…</user_message>`.
const STEERING_MESSAGE_RE = /<user_message id="([^"]{1,128})">\n?([\s\S]*?)\n?<\/user_message>/gu;
function steeringInjection(payload) {
  return record(record(payload._meta).kiro).syntheticUserMessageReason === "steering-injection";
}
function steeringMessages(content) {
  return [...content.matchAll(STEERING_MESSAGE_RE)]
    .map(([, id, text]) => ({ id, text: text.trim() }))
    .filter((message) => message.text.length > 0);
}

// Splits transcript text into turns. A `turn_start` opens an assistant turn;
// the user prompt written just before it is that turn's prompt. Adjacent
// assistant records (Say text and Reasoning) merge into the open turn, and each
// tool_result is folded into the tool part its toolCallId names.
export function parseKiroTurns(text) {
  const turns = [];
  // tool parts still waiting for their result, by toolCallId
  const pending = new Map();
  // steering messages already shown from their own record, by id
  const shownSteers = new Set();
  // steering messages given to the model (in Kiro's instructions), by id
  const consumedSteers = new Set();
  // the turn each steering message shows as, until a boundary clears it
  const steerTurns = new Map();
  // steering messages cleared before the model had them, by id: Kiro sends
  // their words again as the next prompt
  const undelivered = new Map();
  // Takes a turn out, joining the assistant work on its two sides.
  const removeTurn = (turn) => {
    const at = turns.indexOf(turn);
    if (at < 0) return;
    turns.splice(at, 1);
    const before = turns[at - 1];
    const after = turns[at];
    if (before?.role === "assistant" && after?.role === "assistant") {
      before.parts.push(...after.parts);
      if (after.end_ts) before.end_ts = after.end_ts;
      turns.splice(at, 1);
    }
  };

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
      const kiro = record(record(payload._meta).kiro);
      // a boundary clearing steering messages: one never given to the model
      // is sent again as the next prompt, which shows in its place
      for (const id of Array.isArray(kiro.steeringClearedIds) ? kiro.steeringClearedIds : []) {
        const shown = steerTurns.get(id);
        if (shown && !consumedSteers.has(id)) undelivered.set(id, shown);
        steerTurns.delete(id);
      }
      if (content.trim().length === 0) continue;
      if (steeringInjection(payload)) {
        // Kiro's instructions to itself around a message sent while it
        // worked: the message shows, once, as the user's words. Instructions
        // whose messages cannot be read show as they are rather than not at all.
        const messages = steeringMessages(content);
        for (const id of Array.isArray(kiro.steeringConsumedIds) ? kiro.steeringConsumedIds : []) consumedSteers.add(id);
        for (const message of messages) consumedSteers.add(message.id);
        if (messages.length === 0) {
          turns.push({ role: "user", ts, parts: [{ kind: "text", text: content }] });
          continue;
        }
        for (const message of messages) {
          if (shownSteers.has(message.id)) continue;
          shownSteers.add(message.id);
          turns.push({ role: "user", ts, parts: [{ kind: "text", text: message.text }] });
        }
        continue;
      }
      if (payload.source === "steer" && typeof entry?.id === "string") {
        shownSteers.add(entry.id);
        const turn = { role: "user", ts, parts: [{ kind: "text", text: content }] };
        turns.push(turn);
        steerTurns.set(entry.id, turn);
        continue;
      }
      // the prompt that sends an undelivered steering message again: the
      // message shows here alone, and the work it split is one block again
      for (const [id, shown] of undelivered) {
        if (shown.parts[0].text === content) removeTurn(shown);
        undelivered.delete(id);
      }
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
// turn_start keeps the prompt with its answer. A prompt that sends again a
// steering message Kiro cleared before the model had it opens no page: the
// page that holds the message holds its resend too, which shows in its place.
export function kiroTurnStarts(bytes) {
  const starts = [];
  let userOffset = -1;
  let resend = false;
  // steering words by id, those given to the model, and those cleared before
  const steers = new Map();
  const consumed = new Set();
  const undelivered = new Set();
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes(Buffer.from('"user"'))) {
      try {
        const entry = JSON.parse(line.toString("utf8"));
        const payload = record(entry?.payload);
        if (payload.type === "user") {
          const content = string(payload.content);
          const kiro = record(record(payload._meta).kiro);
          for (const id of Array.isArray(kiro.steeringConsumedIds) ? kiro.steeringConsumedIds : []) consumed.add(id);
          for (const id of Array.isArray(kiro.steeringClearedIds) ? kiro.steeringClearedIds : []) {
            if (steers.has(id) && !consumed.has(id)) undelivered.add(steers.get(id));
            steers.delete(id);
          }
          if (payload.source === "steer") {
            if (content.trim() && typeof entry?.id === "string") steers.set(entry.id, content);
          } else if (kiro.syntheticUserMessageReason === undefined && content.trim()) {
            userOffset = offset;
            resend = undelivered.has(content);
            undelivered.clear();
          }
        }
      } catch { /* a torn line opens nothing */ }
    } else if (line.includes(TURN_MARK)) {
      let entry = null;
      try { entry = JSON.parse(line.toString("utf8")); } catch { /* a cut or torn line opens nothing */ }
      if (record(entry?.payload).type === "turn_start") {
        if (!resend) starts.push(userOffset >= 0 ? userOffset : offset);
        userOffset = -1;
        resend = false;
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
