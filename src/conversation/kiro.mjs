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

// What a user record is to steering, the one reading both the parser and the
// page starts use: "steer" (a message sent while Kiro worked, its own
// record), "injection" (Kiro's instructions around such messages), or
// "prompt" (any other user record with words); with the steering ids it
// marks consumed (given to the model) or cleared (taken off the queue).
function userRecordOf(entry, payload) {
  const kiro = record(record(payload._meta).kiro);
  const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  const content = string(payload.content);
  const kind = payload.source === "steer" ? "steer" : steeringInjection(payload) ? "injection" : "prompt";
  const consumed = ids(kiro.steeringConsumedIds);
  if (kind === "injection") consumed.push(...steeringMessages(content).map((message) => message.id));
  return {
    kind,
    id: typeof entry?.id === "string" ? entry.id : null,
    content,
    words: content.trim().length > 0,
    consumed: [...new Set(consumed)],
    cleared: ids(kiro.steeringClearedIds),
  };
}

// Steering messages Kiro took off its queue before the model had them: their
// words come again as the next prompt, which shows in their place. Fed each
// user record in order; `resends(prompt)` tells whether a prompt is one.
function steeringQueue() {
  const waiting = new Map();
  const consumed = new Set();
  let cleared = new Map();
  return {
    note(user) {
      for (const id of user.consumed) consumed.add(id);
      for (const id of user.cleared) {
        if (waiting.has(id) && !consumed.has(id)) cleared.set(id, waiting.get(id));
        waiting.delete(id);
      }
      if (user.kind === "steer" && user.words && user.id !== null) waiting.set(user.id, user.content);
    },
    // The ids of cleared messages this prompt sends again; after a prompt,
    // the cleared ones it does not send are left as they were shown.
    resends(prompt) {
      const ids = [...cleared].filter(([, words]) => words === prompt.content).map(([id]) => id);
      cleared = new Map();
      return ids;
    },
  };
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
  // the turn each steering message shows as, by id
  const steerTurns = new Map();
  // which cleared steering messages a prompt sends again
  const queue = steeringQueue();
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
      const user = userRecordOf(entry, payload);
      queue.note(user);
      if (!user.words) continue;
      const { content } = user;
      if (user.kind === "injection") {
        // Kiro's instructions to itself around a message sent while it
        // worked: the message shows, once, as the user's words. Instructions
        // whose messages cannot be read show as they are rather than not at all.
        const messages = steeringMessages(content);
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
      const turn = { role: "user", ts, parts: [{ kind: "text", text: content }] };
      if (user.kind === "steer") {
        if (user.id !== null) {
          shownSteers.add(user.id);
          steerTurns.set(user.id, turn);
        }
        turns.push(turn);
        continue;
      }
      // the prompt that sends a steering message again, one Kiro cleared
      // before the model had it: the message shows here alone, and the work
      // it split is one block again
      for (const id of queue.resends(user)) {
        const shown = steerTurns.get(id);
        if (shown) removeTurn(shown);
      }
      turns.push(turn);
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
// steering message Kiro cleared before the model had it opens no page, so the
// message and its resend fall in one page, which shows the message once. Kiro
// clears such a message as its turn ends, a few records before the resend (at
// most 3.5 KiB apart in the transcripts seen). A page's window is scanned with
// STEERING_CONTEXT_BYTES before it, so its edge falling between them does not
// make the resend a start, and a page cut mid-turn moves back past the spans
// kiroUnbroken names. A cut more than STEERING_CONTEXT_BYTES after the
// steering message (Kiro's instructions can come a megabyte later) cannot see
// it and may still show it twice; a cut mid-turn only happens in a turn longer
// than a page's window (4 MiB), and the longest seen is 1.24 MB.
const STEERING_CONTEXT_BYTES = 64 * 1024;

// The spans a page must not start inside (offsets into `bytes`): from a
// steering message to the line that shows it in its place, its resend or
// Kiro's instructions that give it to the model. A page cut between them
// would show the message on both sides.
export function kiroUnbroken(bytes) {
  const spans = [];
  const queue = steeringQueue();
  const steerAt = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes(Buffer.from('"user"'))) {
      let entry = null;
      try { entry = JSON.parse(line.toString("utf8")); } catch { /* a torn line holds nothing */ }
      const payload = record(entry?.payload);
      if (payload.type === "user") {
        const user = userRecordOf(entry, payload);
        queue.note(user);
        if (user.kind === "steer" && user.words && user.id !== null) steerAt.set(user.id, offset);
        const shows = user.kind === "injection" ? user.consumed : user.kind === "prompt" && user.words ? queue.resends(user) : [];
        for (const id of shows) {
          if (steerAt.has(id)) spans.push([steerAt.get(id), end + 1]);
        }
      }
    }
    offset = end + 1;
  }
  return spans;
}
export function kiroTurnStarts(bytes) {
  const starts = [];
  let userOffset = -1;
  let resend = false;
  const queue = steeringQueue();
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes(Buffer.from('"user"'))) {
      try {
        const entry = JSON.parse(line.toString("utf8"));
        const payload = record(entry?.payload);
        if (payload.type === "user") {
          const user = userRecordOf(entry, payload);
          queue.note(user);
          if (user.kind === "prompt" && user.words) {
            userOffset = offset;
            resend = queue.resends(user).length > 0;
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
  startContextBytes: STEERING_CONTEXT_BYTES,
  unbroken: kiroUnbroken,
  parse: parseKiroTurns,
  metadata: parseKiroMetadata,
  headBytes: 0,
  toolNeedle: (toolId) => Buffer.from(`"toolCallId":${JSON.stringify(toolId)}`),
  toolOutputIn: kiroToolOutputIn,
});
