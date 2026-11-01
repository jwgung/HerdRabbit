// An OpenCode pane's conversation, read from the SQLite database OpenCode
// keeps ($XDG_DATA_HOME/opencode/opencode.db, else
// ~/.local/share/opencode/opencode.db). Unlike Claude's and Codex's
// transcripts this is no file that grows at its end: a session's messages and
// their parts are rows, so pages are cut by message keys (time, id) rather
// than byte offsets. The page answers keep the shape pages.mjs gives: turns,
// metadata, a `before` cursor, a history id and a version.
//
// The same database holds OpenCode's sign-ins and the secrets of shared
// sessions. Only the fixed statements in
// STATEMENTS ever run here, all of them on session, message, part and
// event_sequence; no statement is built from what a request names, and
// nothing else is read. A test holds this list to that. The reads run in a
// worker thread (opencode-worker.mjs) with this same code and list.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import { toolSummary } from "./claude.mjs";
import { patchFiles, patchText } from "./codex.mjs";
import {
  ConversationUnavailable,
  HistoryChanged,
  MAX_PAGE_PROMPTS,
  READ_BUSY,
  TOOL_ID,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_OUTPUT_PREVIEW_CHARS,
  answerVersion,
  record,
  remember,
  setToolOutput,
  toolInputFields,
  versionMatches,
} from "./pages.mjs";
// What a V2 page reads: the rows that fit, whole. The V1 reader read whole
// rows of at most LARGE_ROW_BYTES and reduced the rest in SQLite (its output
// then fetched capped by id); the V2 table has no per-part rows, so one huge
// message would have to cross into JavaScript whole. A page instead never
// reads a V2 row larger than this; the row's tool calls and words are shown
// with the same cut as V1's large parts (their outputs by the capped fetch,
// their words at LARGE_TEXT_CHARS).
export const V2_LARGE_ROW_BYTES = 32 * 1024;

// OpenCode's session ids: "ses_" and its ascending id.
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/u;
const MESSAGE_ID = /^msg_[A-Za-z0-9]{1,64}$/u;

// The database this server's own OpenCode writes.
export function defaultOpencodeDb(environment = process.env, home = homedir()) {
  const configured = environment.XDG_DATA_HOME;
  const data = configured && isAbsolute(configured) ? configured : join(home, ".local", "share");
  return join(data, "opencode", "opencode.db");
}

// A part (or message) row larger than this is never read whole: SQLite hands
// over a reduced copy instead (see PART_BRIEF), and a page counts it at this size.
export const LARGE_ROW_BYTES = 256 * 1024;
// What a reduced text or reasoning part keeps of its words.
export const LARGE_TEXT_CHARS = 64 * 1024;
// The largest question tool input read for a prompt card.
export const PENDING_QUESTION_BYTES = 64 * 1024;
// How many parts and messages one page reads at most.
const MAX_PAGE_PARTS = 5000;
const MAX_PAGE_MESSAGES = 5000;
// The longest a session's identity is trusted from unchanged file stats alone.
export const IDENTITY_RECHECK_MS = 2_000;

// The messages of one page: a session's message keys from $fromTime/$fromId
// (included) to $toTime/$toId (excluded).
const RANGE = "session_id = $session AND (time_created > $fromTime OR (time_created = $fromTime AND id >= $fromId)) AND (time_created < $toTime OR (time_created = $toTime AND id < $toId))";
// The same range on V2's per-message rows (session_message, ordered by its
// seq) and the V2 session table, where the row's own time and id key it.
const RANGE_V2 = "m.session_id = $session AND (m.time_created > $fromTime OR (m.time_created = $fromTime AND m.id >= $fromId)) AND (m.time_created < $toTime OR (m.time_created = $toTime AND m.id < $toId))";
const SESSION_RANGE_V2 = "(time_created > $fromTime OR (time_created = $fromTime AND id >= $fromId)) AND (time_created < $toTime OR (time_created = $toTime AND id < $toId))";
// What a tool part answered (its output, error or running output), as text, of the row `data`.
const outputOf = (data) => `CASE ${data} ->> '$.state.status' WHEN 'completed' THEN CASE WHEN json_type(${data}, '$.state.output') = 'text' THEN ${data} ->> '$.state.output' END WHEN 'error' THEN CASE WHEN json_type(${data}, '$.state.error') = 'text' THEN ${data} ->> '$.state.error' END WHEN 'running' THEN CASE WHEN json_type(${data}, '$.state.metadata.output') = 'text' THEN ${data} ->> '$.state.metadata.output' END END`;
// A large part as a page reads it: a tool call without its output (and
// without its input, when that alone is too large), text cut at
// $textChars, anything else its type and mime only.
const TOOL_BRIEF = "json_remove(p.data, '$.state.output', '$.state.metadata', '$.state.attachments', '$.state.error', '$.state.raw')";
const PART_BRIEF = `CASE p.data ->> '$.type' WHEN 'tool' THEN CASE WHEN octet_length(${TOOL_BRIEF}) <= $large THEN ${TOOL_BRIEF} ELSE json_remove(${TOOL_BRIEF}, '$.state.input') END WHEN 'text' THEN json_set(json_remove(p.data, '$.metadata'), '$.text', substr(p.data ->> '$.text', 1, $textChars)) WHEN 'reasoning' THEN json_set(json_remove(p.data, '$.metadata'), '$.text', substr(p.data ->> '$.text', 1, $textChars)) ELSE json_object('type', p.data ->> '$.type', 'mime', p.data ->> '$.mime') END`;
// A large message as a page reads it: the fields parseOpencodeTurns and opencodeMetadata read.
const MESSAGE_BRIEF = "json_object('role', data ->> '$.role', 'time', data -> '$.time', 'summary', CASE WHEN json_type(data, '$.summary') = 'true' THEN json('true') END, 'modelID', data ->> '$.modelID', 'variant', data ->> '$.variant', 'tokens', data -> '$.tokens', 'error', data -> '$.error')";

// Every statement this module runs. Nothing else is prepared.
export const STATEMENTS = Object.freeze({
  // the columns of one of the tables below (TABLES), checked once per database file
  columns: "SELECT name FROM pragma_table_info(?)",
  session: "SELECT id, parent_id, directory, revert, time_updated FROM session WHERE id = ?",
  // the OpenCode version that wrote the session: whether a prompt card may read its screen
  sessionVersion: "SELECT version FROM session WHERE id = ?",
  newestInDirectory: "SELECT id FROM session WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC, id DESC LIMIT 1",
  newestInDirectoryAny: "SELECT id FROM session WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC, id DESC LIMIT 1",
  sequence: "SELECT seq FROM event_sequence WHERE aggregate_id = ?",
  partsChanged: "SELECT MAX(time_updated) AS updated, COUNT(*) AS parts FROM part WHERE session_id = ?",
  messagesChanged: "SELECT MAX(time_updated) AS updated, COUNT(*) AS messages FROM message WHERE session_id = ?",
  message: "SELECT id, time_created FROM message WHERE id = ? AND session_id = ?",
  // the prompts before `end`, newest first: the keys a page may start at
  promptsBefore: "SELECT id, time_created FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?)) AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC, id DESC LIMIT ?",
  // what a page's rows cost to read (a large row at $large), and how many parts it has: lengths only, no data
  pageBytes: `SELECT (SELECT COALESCE(SUM(MIN(octet_length(data), $large)), 0) FROM message WHERE ${RANGE}) + (SELECT COALESCE(SUM(MIN(octet_length(data), $large)), 0) FROM part WHERE message_id IN (SELECT id FROM message WHERE ${RANGE})) AS bytes, (SELECT COUNT(*) FROM part WHERE message_id IN (SELECT id FROM message WHERE ${RANGE})) AS parts`,
  // a page's messages, newest first, at most $rows; a large one reduced
  messages: `SELECT id, time_created, CASE WHEN octet_length(data) <= $large THEN data ELSE ${MESSAGE_BRIEF} END AS data FROM message WHERE ${RANGE} ORDER BY time_created DESC, id DESC LIMIT $rows`,
  // all parts of a page's messages in one read, newest first, while their cost stays within $budget and
  // their number within $rows; a large one reduced, with its output's length and first $preview characters
  parts: `SELECT p.id AS id, p.message_id AS message_id, CASE WHEN octet_length(p.data) <= $large THEN p.data ELSE ${PART_BRIEF} END AS data, octet_length(p.data) > $large AS reduced, CASE WHEN octet_length(p.data) > $large THEN length(${outputOf("p.data")}) END AS output_size, CASE WHEN octet_length(p.data) > $large THEN substr(${outputOf("p.data")}, 1, $preview) END AS output_preview FROM (SELECT id, SUM(MIN(octet_length(data), $large)) OVER (ORDER BY message_id DESC, id DESC ROWS UNBOUNDED PRECEDING) AS running FROM part WHERE message_id IN (SELECT id FROM message WHERE ${RANGE})) AS chosen JOIN part AS p ON p.id = chosen.id WHERE chosen.running <= $budget ORDER BY chosen.running LIMIT $rows`,
  // The question the session waits on: the newest question tool call still
  // running (the inner pick: newest by part id, which OpenCode makes
  // ascending) alone decides. Its input when it is at most $large bytes, else
  // NULL: never an older running call's in its place. A completed (answered,
  // dismissed or failed) call waits on nothing.
  pendingQuestion: "SELECT CASE WHEN octet_length(data ->> '$.state.input') <= $large THEN data ->> '$.state.input' END AS input FROM part WHERE session_id = $session AND id = (SELECT id FROM part WHERE session_id = $session AND data ->> '$.type' = 'tool' AND data ->> '$.tool' = 'question' AND data ->> '$.state.status' = 'running' ORDER BY id DESC LIMIT 1)",
  // one tool call's output: at most $max characters of it, and its whole length
  toolPart: `SELECT kind, substr(output, 1, $max) AS output, length(output) AS size FROM (SELECT data ->> '$.type' AS kind, ${outputOf("data")} AS output FROM part WHERE id = $id AND session_id = $session)`,
  // ---------------------------------------------------------------------------
  // The tables OpenCode 2 writes instead (session_v2, session_message; its
  // tool outputs sit in the message's content, not in part rows). They are
  // read only for a session the old tables do not hold.
  sessionV2: "SELECT id, parent_id, fork_session_id, directory, revert, time_updated, version FROM session_v2 WHERE id = ?",
  sessionV2Version: "SELECT version FROM session_v2 WHERE id = ?",
  newestInDirectoryV2: "SELECT id FROM session_v2 WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC, id DESC LIMIT 1",
  newestInDirectoryAnyV2: "SELECT id FROM session_v2 WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC, id DESC LIMIT 1",
  messageV2: "SELECT id, seq FROM session_message WHERE id = ? AND session_id = ?",
  messagesChangedV2: "SELECT MAX(time_updated) AS updated, COUNT(*) AS messages FROM session_message WHERE session_id = ?",
  // V2's pages key on seq, unique per session and always increasing: a
  // message's time_created can repeat (a user prompt and its answer in the
  // same millisecond), so (time, id) is not a safe key there
  promptsBeforeV2: "SELECT id, seq FROM session_message WHERE session_id = $session AND seq < $endSeq AND type = 'user' ORDER BY seq DESC LIMIT $rows",
  pageBytesV2: "SELECT COALESCE(SUM(MIN(octet_length(data), $large)), 0) AS bytes, COUNT(*) AS parts FROM session_message WHERE session_id = $session AND seq >= $fromSeq AND seq < $toSeq",
  // a page's messages, newest first, at most $rows; a large one reduced the
  // way V1's large messages were (its model, tokens and error, not its words)
  messagesV2: "SELECT m.id, m.seq, m.type, m.time_created, m.data FROM session_message m WHERE m.session_id = $session AND m.seq >= $fromSeq AND m.seq < $toSeq ORDER BY m.seq DESC LIMIT $rows",
  // the pending question a page shows: a question call still running, newest
  // first, at most $large bytes of its row (its words cut in JavaScript)
  pendingQuestionV2: `SELECT m.id, m.seq, CASE WHEN octet_length(m.data) <= $large THEN m.data ELSE substr(m.data, 1, $large) END AS data FROM session_message m WHERE m.session_id = $session AND m.type = 'assistant' ORDER BY m.time_created DESC, m.seq DESC, m.id DESC LIMIT $rows`,
  // one tool call's output from a V2 message: $id the message row that holds
  // the call, $tool the call's own id; the call's content as text, at most
  // $max characters, and its whole length
  toolPartV2: `SELECT substr(output, 1, $max) AS output, length(output) AS size FROM (SELECT (SELECT GROUP_CONCAT(json_extract(c.value, '$.text'), CHAR(10)) FROM json_each(m.data, '$.content') AS t, json_each(t.value, '$.state.content') AS c WHERE json_type(t.value) = 'object' AND json_extract(t.value, '$.type') = 'tool' AND json_extract(t.value, '$.id') = $tool AND json_type(c.value) = 'object' AND json_extract(c.value, '$.type') = 'text') AS output FROM session_message m WHERE m.id = $id AND m.session_id = $session)`,
  // is there a message before $seq in the session: the page's cursor is null
  // when the page reaches the first message
  v2FirstBefore: "SELECT 1 AS one FROM session_message WHERE session_id = $session AND seq < $seq LIMIT 1",
});

// The tables (and columns) the statements read; a database without one of
// them is a version this module does not read.
const TABLES = Object.freeze({
  session: ["id", "parent_id", "directory", "revert", "time_updated"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_updated", "data"],
});
// OpenCode 2's tables, read when they are whole: a V2 session lives there
// alone, beside the old tables' own rows. A database that has the V2 tables
// but not both of session_message's read columns answers V2 sessions by
// their rows; one whose V2 tables are still being migrated reads as before.
const TABLES_V2 = Object.freeze({
  session_v2: ["id", "parent_id", "fork_session_id", "directory", "revert", "time_updated", "version"],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
});
// Read when there: an older database has no event log or archive.
const OPTIONAL = Object.freeze({ event_sequence: ["aggregate_id", "seq"], session: ["time_archived"] });
// Read when there: the version that wrote a session, for the prompt cards.
const SESSION_VERSION = "version";

export const UNSUPPORTED = "unsupported_opencode_version";

// The lowest and highest message keys: the start and the end of a session.
const BEGINNING = Object.freeze({ time: -1, id: "" });
const END = Object.freeze({ time: Number.MAX_SAFE_INTEGER, id: "" });

// How much of a page's parts one read takes at most, before it holds fewer prompts.
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
// How far up a reported subagent's session is followed to its top-level session.
const MAX_SESSION_DEPTH = 8;

export const NEEDS_NEWER_NODE = "opencode_needs_newer_node";

function unsupported() {
  return new ConversationUnavailable(UNSUPPORTED);
}

const string = (value) => typeof value === "string" ? value : "";
const iso = (ms) => Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
const parse = (text) => {
  try { return record(JSON.parse(text)); } catch { return {}; }
};

// ---------------------------------------------------------------------------
// Turns.

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// OpenCode's tools name their file `filePath` and an edit `oldString` /
// `newString`; the chat reads Claude's names for the same fields.
const RENAMED = Object.freeze({ filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" });

function renamed(value, depth = 0) {
  if (Array.isArray(value)) return depth > 2 ? value : value.map((item) => renamed(item, depth + 1));
  if (value === null || typeof value !== "object" || depth > 2) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [RENAMED[key] ?? key, renamed(item, depth + 1)]));
}

function questionTitles(input) {
  return Array.isArray(input.questions)
    ? input.questions.map((question) => string(record(question).question) || string(record(question).header)).filter(Boolean)
    : [];
}

// The one-line summary a collapsed tool row shows: the command, file, pattern
// or question the call is about.
function opencodeToolSummary(name, input, title) {
  const lower = name.toLowerCase();
  let first;
  if (lower === "question") first = questionTitles(input).join(" · ");
  else if (lower === "skill") first = string(input.name);
  else if (lower === "task") first = string(input.description);
  else if (lower === "grep" || lower === "glob") first = string(input.pattern);
  else if (lower === "webfetch") first = string(input.url);
  else if (lower === "todowrite") first = "";
  else {
    const said = toolSummary(name, input);
    first = said === name ? "" : said;
  }
  return (first || title || name).replace(/\s+/gu, " ").trim().slice(0, 120) || name;
}

// `brief`: a part too large to read whole ({ output_size, output_preview }),
// read without its output (or its input) by SQLite.
function toolPart(id, data, brief = null) {
  const name = string(data.tool) || "tool";
  const state = record(data.state);
  const input = record(state.input);
  const patch = typeof input.patchText === "string" ? patchText(input.patchText) : null;
  const normal = renamed(input);
  const files = patch !== null ? patchFiles(patch) : [];
  const part = {
    kind: "tool",
    id: TOOL_ID.test(id) ? id : null,
    name,
    summary: files.length > 0
      ? files.join(", ").slice(0, 120)
      : opencodeToolSummary(name, normal, string(state.title)),
    // a patch reads as the patch itself, as Codex's does
    ...toolInputFields(patch ?? JSON.stringify(normal, null, 2)),
    output: "",
  };
  if (brief) {
    // the output is fetched by id, at most TOOL_OUTPUT_MAX_CHARS of it
    const size = Number(brief.output_size ?? 0);
    part.output = string(brief.output_preview);
    part.output_size = size;
    if (size > part.output.length) part.output_truncated = true;
    part.output_large = true;
    if (!("input" in state)) part.input_truncated = true;
  } else {
    const output = toolOutputOf(state);
    if (output) setToolOutput(part, output);
  }
  if (state.status === "error") part.error = true;
  return part;
}

// What a tool call answered: its output once done, its error once failed, and
// the output so far of a command still running.
function toolOutputOf(state) {
  if (state.status === "completed") return string(state.output);
  if (state.status === "error") return string(state.error);
  if (state.status === "running") return string(record(state.metadata).output);
  return "";
}

function errorText(error) {
  const value = record(error);
  if (value.name === "MessageAbortedError") return "";
  const message = string(record(value.data).message) || string(value.message) || string(value.name);
  return message ? `Error: ${message}` : "";
}

// Words of a part too large to read whole, cut by SQLite at LARGE_TEXT_CHARS.
const cut = (text, brief) => brief && text.length >= LARGE_TEXT_CHARS ? `${text}\n…` : text;

// A session's messages, oldest first ({ id, time, info, parts: [{ id, data, brief? }] }),
// as turns shaped as the Claude parser's: a user turn per prompt; the
// agent's text, reasoning and tool calls, over however many steps, in one
// assistant turn. A compaction marks where the history was folded, with the
// summary OpenCode wrote for it.
export function parseOpencodeTurns(messages) {
  const turns = [];
  let compact = null;
  for (const message of messages) {
    const info = record(message.info);
    const time = record(info.time);
    const ts = iso(time.created) ?? iso(message.time);
    if (info.role === "user") {
      const parts = [];
      const images = [];
      compact = null;
      for (const { data, brief } of message.parts) {
        if (data.type === "text" && !data.synthetic && !data.ignored && string(data.text).trim()) {
          parts.push({ kind: "text", text: cut(data.text, brief), ...(brief ? { text_truncated: true } : {}) });
        } else if (data.type === "file" && IMAGE_TYPES.has(data.mime)) {
          images.push({ kind: "image", media_type: data.mime });
        } else if (data.type === "compaction") {
          compact = { kind: "compact", text: "" };
          parts.push(compact);
        }
      }
      // a pasted image goes before the words, as Claude's do; its bytes stay in the database
      turns.push({ role: "user", ts, parts: [...images, ...parts] });
      continue;
    }
    if (info.role !== "assistant") continue;
    // the summary a compaction asked for belongs to its mark
    if (info.summary === true) {
      if (compact !== null) {
        compact.text = message.parts.filter(({ data }) => data.type === "text").map(({ data }) => string(data.text)).join("\n").trim();
      }
      continue;
    }
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", ts, parts: [] };
      turns.push(turn);
    }
    const end = iso(time.completed);
    if (end) turn.end_ts = end;
    for (const { id, data, brief } of message.parts) {
      if (data.type === "text" && !data.synthetic && !data.ignored && string(data.text).trim()) {
        turn.parts.push({ kind: "text", text: cut(data.text, brief), ...(brief ? { text_truncated: true } : {}) });
      } else if (data.type === "reasoning" && string(data.text).trim()) {
        turn.parts.push({ kind: "thinking", text: cut(data.text, brief), ...(brief ? { text_truncated: true } : {}) });
      } else if (data.type === "tool") {
        turn.parts.push(toolPart(id, data, brief));
      }
      // step marks, snapshots, patches and the rest are OpenCode's bookkeeping
    }
    const failed = errorText(info.error);
    if (failed) turn.parts.push({ kind: "text", text: failed });
  }
  return turns.filter((turn) => turn.parts.length > 0);
}

// V2's rows read as V1's did: one user prompt is a message; each assistant
// message is a step, its content the parts. A message too large to read
// whole is reduced the way V1's large messages were: its words and tool
// calls kept (cut at LARGE_TEXT_CHARS, the tools without their outputs,
// which come by the capped fetch), its model and tokens kept for the page's
// metadata. The reduced row's `data` holds that shape, `content` in place
// of `parts`.
export function shapeV2Row(data, large, rawSize = Buffer.byteLength(String(data), "utf8")) {
  let info;
  try { info = record(JSON.parse(data)); } catch { return null; }
  const time = record(info.time);
  const created = Number(time.created ?? info.created);
  if (!Number.isFinite(created)) return null;
  if (rawSize <= large) return { created, info };
  const content = Array.isArray(info.content) ? info.content : [];
  const kept = [];
  for (const item of content) {
    const part = record(item);
    if (part.type === "text" || part.type === "reasoning") {
      const words = string(part.text);
      if (words.trim()) kept.push({ type: part.type, text: words.slice(0, LARGE_TEXT_CHARS) });
    } else if (part.type === "tool") {
      const state = record(part.state);
      const input = record(state.input);
      kept.push({
        type: "tool",
        id: part.id,
        name: part.name,
        state: { status: state.status, input: Buffer.byteLength(JSON.stringify(input ?? ""), "utf8") > LARGE_TEXT_CHARS ? {} : input },
      });
    }
  }
  const model = record(info.model);
  const cut = { time: { created }, agent: info.agent, modelID: model.id ?? null, variant: model.variant ?? null };
  const tokens = record(info.tokens);
  if (Object.keys(tokens).length > 0) cut.tokens = tokens;
  if (typeof info.cost === "number") cut.cost = info.cost;
  if (info.error !== undefined) cut.error = info.error;
  return { created, info: { ...cut, content: kept, large: true } };
}

// Whether a V2 row was reduced (its words and tool outputs cut): the page
// marks it so the parts know to fetch their whole output by id.
const infoLarge = (row) => record(row.info).large === true;

// V2's message types the chat shows: the conversation's turns. The rest
// (idle, system, compaction's mark) is OpenCode's bookkeeping, shown the way
// V1's compaction part was: the mark at its user message, the summary with
// the message that carries it.
const V2_TURNS = new Set(["user", "assistant", "compaction"]);

// A V2 message's content reads as its parts: a tool call, the tool's
// output or error (or the running output, a V1 running part's).
function v2ToolPart(key, item, info) {
  const state = record(item.state);
  const input = record(state.input);
  const patch = typeof input.patchText === "string" ? patchText(input.patchText) : null;
  const normal = renamed(input);
  const files = patch !== null ? patchFiles(patch) : [];
  const part = {
    kind: "tool",
    // the key (row id, call id) is split by the store for the capped fetch
    id: key,
    name: string(item.name) || "tool",
    summary: files.length > 0
      ? files.join(", ").slice(0, 120)
      : opencodeToolSummary(string(item.name), normal, string(state.title)),
    ...toolInputFields(patch ?? JSON.stringify(normal, null, 2)),
    output: "",
  };
  const large = record(info).large === true;
  const output = v2ToolOutputOf(state);
  if (large) {
    // the reduced row's tool: its output was cut, fetched by id at most
    // TOOL_OUTPUT_MAX_CHARS of it
    part.output_large = true;
    if (output) {
      setToolOutput(part, output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS));
      part.output_size = output.length;
    }
  } else if (output) {
    setToolOutput(part, output);
  }
  if (large) part.input_truncated = Object.keys(record(state.input)).length === 0;
  if (state.status === "error") part.error = true;
  return part;
}

// What a V2 tool call answered: its content's words once done, its error
// once failed, and the output so far of a command still running.
function v2ToolOutputOf(state) {
  if (state.status === "error") {
    const error = record(state.error);
    return string(error.message) || string(state.error);
  }
  if (!Array.isArray(state.content)) return string(record(state.metadata).output);
  return state.content.filter((item) => record(item).type === "text").map((item) => string(record(item).text)).join("\n");
}

// V2's page, as turns: a user message's words (and images, when the row
// holds them) are a user turn; each assistant message, over however many
// steps, joins one assistant turn. A compaction marks where the history was
// folded, with the summary OpenCode wrote for it.
export function parseV2Turns(rows) {
  const turns = [];
  let compact = null;
  for (const row of rows) {
    const info = v2InfoOf(row);
    const type = string(row.type);
    const ts = iso(record(info.time).created) ?? iso(row.time);
    if (type === "compaction") {
      compact = { kind: "compact", text: string(info.summary).trim() };
      turns.push({ role: "user", ts, parts: [compact] });
      continue;
    }
    if (type === "user") {
      compact = null;
      const parts = [];
      const words = string(info.text);
      if (words.trim()) parts.push({ kind: "text", text: cut(words, infoLarge(row)) });
      const files = Array.isArray(info.files) ? info.files : [];
      for (const file of files) {
        const mime = string(record(file).mime);
        if (IMAGE_TYPES.has(mime)) parts.unshift({ kind: "image", media_type: mime });
      }
      if (parts.length > 0) turns.push({ role: "user", ts, parts });
      continue;
    }
    if (type !== "assistant") continue;
    if (info.summary === true) {
      if (compact !== null) {
        const words = (Array.isArray(info.content) ? info.content : [])
          .filter((item) => record(item).type === "text")
          .map((item) => string(record(item).text)).join("\n").trim();
        if (words) compact.text = words;
      }
      continue;
    }
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", ts, parts: [] };
      turns.push(turn);
    }
    const end = iso(record(info.time).completed ?? record(info.time).streamed);
    if (end) turn.end_ts = end;
    const content = Array.isArray(info.content) ? info.content : [];
    for (const item of content) {
      const part = record(item);
      if (part.type === "text" && !part.synthetic && !part.ignored && string(part.text).trim()) {
        turn.parts.push({ kind: "text", text: cut(string(part.text), infoLarge(row)), ...(infoLarge(row) ? { text_truncated: true } : {}) });
      } else if (part.type === "reasoning" && string(part.text).trim()) {
        turn.parts.push({ kind: "thinking", text: cut(string(part.text), infoLarge(row)), ...(infoLarge(row) ? { text_truncated: true } : {}) });
      } else if (part.type === "tool") {
        // the row's id and the call's own id name it for the capped fetch
        // (a space: a %20 in the URL, never a control character)
        turn.parts.push(v2ToolPart(`${string(row.id)} ${string(part.id)}`, part, info));
      }
    }
    const failed = errorText(info.error);
    if (failed) turn.parts.push({ kind: "text", text: failed });
  }
  return turns.filter((turn) => turn.parts.length > 0);
}

// A V2 row's message as the page reads it: its model, kept as a V1
// message's (modelID and variant), whether the row came whole or reduced.
function v2InfoOf(row) {
  const info = record(row.info);
  if (info.modelID === undefined && info.variant === undefined) {
    const model = record(info.model);
    info.modelID = model.id ?? null;
    info.variant = model.variant ?? null;
  }
  return info;
}

// The model the newest answer on a V2 page ran at, and the context it
// filled. A reduced row's model and tokens are the row's own (its words
// cut, not its identity).
export function v2Metadata(rows) {
  const metadata = { model: null, reasoning_effort: null };
  for (const row of rows) {
    if (string(row.type) !== "assistant") continue;
    const info = v2InfoOf(row);
    if (info.summary === true) continue;
    const model = label(info.modelID);
    if (!model) continue;
    metadata.model = model;
    metadata.reasoning_effort = label(info.variant);
    const tokens = record(info.tokens);
    const cache = record(tokens.cache);
    const used = count(tokens.input) + count(cache.read) + count(cache.write);
    if (used > 0) metadata.context = { used, window: null };
  }
  return metadata;
}

const label = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const count = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

// The model the newest answer on the page ran at, and the context it filled.
export function opencodeMetadata(messages) {
  const metadata = { model: null, reasoning_effort: null };
  for (const message of messages) {
    const info = record(message.info);
    if (info.role !== "assistant" || info.summary === true) continue;
    const model = label(info.modelID);
    if (!model) continue;
    metadata.model = model;
    metadata.reasoning_effort = label(info.variant);
    const tokens = record(info.tokens);
    const cache = record(tokens.cache);
    const used = count(tokens.input) + count(cache.read) + count(cache.write);
    if (used > 0) metadata.context = { used, window: null };
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// The database.

const keyOf = (row) => ({ time: Number(row.time_created), id: String(row.id) });
const before = (a, b) => a.time < b.time || (a.time === b.time && a.id < b.id);
// the same range as RANGE's named parameters
const named = (session, from, to) => ({ session, fromTime: from.time, fromId: from.id, toTime: to.time, toId: to.id });
// V2's keys: the message's seq, unique per session and always increasing
const V2_BEGINNING = -1;
const V2_END = Number.MAX_SAFE_INTEGER;
const keyOfV2 = (row) => Number(row.seq);
const beforeV2 = (a, b) => a < b;

// Where a session's shown history ends: an undo hides the reverted messages
// until OpenCode drops them. { key, part }: the message undone to, and the part in it.
function revertOf(db, row) {
  const revert = parse(string(row.revert));
  const id = string(revert.messageID);
  if (!MESSAGE_ID.test(id)) return null;
  const found = db.statement("message").get(id, row.id);
  return found ? { key: keyOf(found), part: string(revert.partID) } : null;
}

// ---------------------------------------------------------------------------
// The reads. What touches the database runs in a reader: in a worker thread
// (opencode-worker.mjs), so a page of thousands of rows and megabytes never
// holds the server's event loop (HTTP, WebSocket, terminals), else, when no
// worker can start, here in this thread. Both run the same code below.

// The only way a statement is prepared, in the worker and here alike: by its
// name in STATEMENTS, never from SQL a request carries. `onPrepare(sql)` sees each one.
export function statementsOf(db, onPrepare = null) {
  const prepared = new Map();
  return {
    statement(name) {
      if (typeof name !== "string" || !Object.hasOwn(STATEMENTS, name)) throw new Error(`unknown statement ${String(name)}`);
      let statement = prepared.get(name);
      if (!statement) {
        const sql = STATEMENTS[name];
        onPrepare?.(sql);
        statement = db.prepare(sql);
        prepared.set(name, statement);
      }
      return statement;
    },
  };
}

// What a store asks its reader, by name; nothing else is answered.
export const OPERATIONS = Object.freeze(["locate", "identity", "page", "toolOutput", "pendingQuestion", "sessionVersion"]);

// The reads of one database: read(op, args, file) runs one of OPERATIONS on
// a short connection, `file` the database file's dev:ino:size:mtime as the
// store saw it. A database that cannot be opened (none yet, or its WAL index
// missing) answers null; one whose shape is not OpenCode's as known here
// throws unsupported. The connection is closed after each read: a database
// replaced or deleted is never held open, and what cannot be opened reads as
// it always did.
export function opencodeReader({ DatabaseSync, path, maxMessages = MAX_PAGE_MESSAGES, onPrepare = null }) {
  // dev:ino:size:mtime -> whether that database has the tables and columns read here
  const shapes = new Map();
  const answers = new Map();

  function shapeOf(handle) {
    const columns = (table) => new Set(handle.statement("columns").all(table).map((row) => row.name));
    // A database is readable when it holds the V1 tables whole or the V2 tables
    // whole: OpenCode 2 carries a V1 session into session_v2 and a new V2
    // session only there, and a database migrated past V1 holds V2 alone.
    const v1 = wholeTables(handle, TABLES, columns);
    const v2 = wholeTables(handle, TABLES_V2, columns);
    if (!v1 && !v2) return null;
    const events = columns("event_sequence");
    const sessions = v1 ? columns("session") : new Set();
    const sessionsV2 = v2 ? columns("session_v2") : new Set();
    return {
      v1,
      v2,
      events: v1 && OPTIONAL.event_sequence.every((column) => events.has(column)),
      archive: (v1 && OPTIONAL.session.every((column) => sessions.has(column))) || (v2 && sessionsV2.has("time_archived")),
      version: (v1 && sessions.has(SESSION_VERSION)) || (v2 && sessionsV2.has(SESSION_VERSION)),
      v2Archive: v2 && sessionsV2.has("time_archived"),
    };
  }

  // Whether a set of tables is whole (every table, every wanted column).
  function wholeTables(handle, tables, columns) {
    for (const [table, wanted] of Object.entries(tables)) {
      const have = columns(table);
      if (!have.size || !wanted.every((column) => have.has(column))) return false;
    }
    return true;
  }

  function identityIn(db, session) {
    if (!db.shape.v1) return null;
    const row = db.statement("session").get(session);
    if (!row) return null;
    const seq = db.shape.events ? db.statement("sequence").get(session)?.seq ?? "" : "";
    const parts = db.statement("partsChanged").get(session) ?? {};
    const messages = db.statement("messagesChanged").get(session) ?? {};
    // the undo target itself, not its length: another message of the same length is another history
    const revert = createHash("sha256").update(string(row.revert)).digest("base64url").slice(0, 12);
    return [seq, row.time_updated, revert, parts.updated ?? "", parts.parts ?? 0,
      messages.updated ?? "", messages.messages ?? 0].join(":");
  }

  // The session's history: its id, and a mark of its undo, so a page read
  // across an undo starts over.
  function historyOf(db, row) {
    const revert = revertOf(db, row);
    if (!revert) return { id: String(row.id), end: END };
    // the message (and part) undone to name it: two messages of one millisecond are two histories
    const mark = createHash("sha256").update(`${revert.key.id}\0${revert.part}`).digest("base64url").slice(0, 12);
    return { id: `${row.id}-r${revert.key.time.toString(36)}-${mark}`, end: revert.key };
  }

  function parseCursor(db, history, session, cursor) {
    if (typeof cursor !== "string" || cursor.length > 200) throw new HistoryChanged();
    const parts = cursor.split(":");
    if (parts.length !== 3 || parts[0] !== history.id || !/^\d+$/u.test(parts[1]) || !MESSAGE_ID.test(parts[2])) throw new HistoryChanged();
    const found = db.statement("message").get(parts[2], session);
    if (!found || Number(found.time_created) !== Number(parts[1])) throw new HistoryChanged();
    const key = keyOf(found);
    if (!before(key, history.end)) throw new HistoryChanged();
    return key;
  }

  const cursorOf = (history, key) => `${history.id}:${key.time}:${key.id}`;

  // Where a page ending at `end` starts: at most MAX_PAGE_PROMPTS prompts back,
  // fewer when their parts are too large to read at once, else `floor`.
  function pageStart(db, session, end, floor) {
    const prompts = db.statement("promptsBefore").all(session, end.time, end.time, end.id, MAX_PAGE_PROMPTS + 1)
      .map(keyOf).filter((key) => !before(key, floor));
    let take = Math.min(prompts.length, MAX_PAGE_PROMPTS);
    let start = prompts.length > MAX_PAGE_PROMPTS ? prompts[MAX_PAGE_PROMPTS - 1] : floor;
    const tooLarge = (from) => {
      const cost = db.statement("pageBytes").get({ ...named(session, from, end), large: LARGE_ROW_BYTES }) ?? {};
      return Number(cost.bytes ?? 0) > MAX_PAGE_BYTES || Number(cost.parts ?? 0) > MAX_PAGE_PARTS;
    };
    while (take > 1 && tooLarge(start)) {
      take = Math.floor(take / 2);
      start = prompts[take - 1];
    }
    return start;
  }

  // The page's messages and their parts, in two reads. However large a part
  // is, what crosses into JavaScript is bounded: a large row comes reduced, the
  // parts stop at MAX_PAGE_BYTES (counted as pageBytes counts them) and
  // MAX_PAGE_PARTS, the newest kept.
  // When the range holds more than maxMessages, the newest maxMessages come and
  // `start` is the oldest of them, so the next page continues right before it.
  function readMessages(db, session, from, to) {
    const rows = db.statement("messages").all({ ...named(session, from, to), large: LARGE_ROW_BYTES, rows: maxMessages + 1 });
    const cut = rows.length > maxMessages;
    if (cut) rows.pop();
    const start = cut ? keyOf(rows.at(-1)) : from;
    const where = named(session, start, to);
    const messages = rows.reverse().map((row) => ({
      id: String(row.id),
      time: Number(row.time_created),
      info: parse(string(row.data)),
      parts: [],
    }));
    const byId = new Map(messages.map((message) => [message.id, message]));
    const parts = db.statement("parts").all({
      ...where, large: LARGE_ROW_BYTES, textChars: LARGE_TEXT_CHARS, preview: TOOL_OUTPUT_PREVIEW_CHARS,
      budget: MAX_PAGE_BYTES, rows: MAX_PAGE_PARTS,
    });
    for (const part of parts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const message = byId.get(String(part.message_id));
      if (!message) continue;
      const brief = part.reduced ? { output_size: part.output_size, output_preview: part.output_preview } : null;
      message.parts.push({ id: String(part.id), data: parse(string(part.data)), ...(brief ? { brief } : {}) });
    }
    return { messages, start };
  }

  // ---------------------------------------------------------------------------
  // V2. OpenCode 2 writes a session to session_v2 and its messages to
  // session_message, with each tool call's output in the message's content
  // (no part rows). A session the old tables do not hold is read from there,
  // the same way: a page of its newest messages, its undo, its question.
  // Its keys are the messages' seq, unique per session and always increasing.

  function identityInV2(db, session) {
    const row = db.statement("sessionV2").get(session);
    if (!row) return null;
    const changed = db.statement("messagesChangedV2").get(session) ?? {};
    const revert = createHash("sha256").update(string(row.revert)).digest("base64url").slice(0, 12);
    return [row.time_updated, revert, changed.updated ?? "", changed.messages ?? 0].join(":");
  }

  function revertOfV2(db, row) {
    const revert = parse(string(row.revert));
    const id = string(revert.messageID);
    if (!MESSAGE_ID.test(id)) return null;
    const found = db.statement("messageV2").get(id, row.id);
    return found ? { key: keyOfV2(found), part: string(revert.partID) } : null;
  }

  function historyOfV2(db, row) {
    const revert = revertOfV2(db, row);
    if (!revert) return { id: String(row.id), end: V2_END };
    const mark = createHash("sha256").update(`${revert.key}\0${revert.part}`).digest("base64url").slice(0, 12);
    return { id: `${row.id}-r${revert.key.toString(36)}-${mark}`, end: revert.key };
  }

  function parseCursorV2(db, history, session, cursor) {
    if (typeof cursor !== "string" || cursor.length > 200) throw new HistoryChanged();
    const parts = cursor.split(":");
    if (parts.length !== 2 || parts[0] !== history.id || !/^\d+$/u.test(parts[1])) throw new HistoryChanged();
    const key = Number(parts[1]);
    if (!beforeV2(key, history.end)) throw new HistoryChanged();
    return key;
  }

  const cursorOfV2 = (history, key) => `${history.id}:${key}`;

  // A V2 session's pending question: its newest assistant rows, looking for
  // a question call still running.
  function pendingQuestionV2(db, session) {
    const rows = db.statement("pendingQuestionV2").all({ session, large: PENDING_QUESTION_BYTES, rows: 32 });
    for (const v2row of rows) {
      let info;
      try { info = record(JSON.parse(v2row.data)); } catch { continue; }
      const content = Array.isArray(info.content) ? info.content : [];
      for (let i = content.length - 1; i >= 0; i -= 1) {
        const item = record(content[i]);
        if (item.type !== "tool" || item.name !== "question") continue;
        const state = record(item.state);
        if (state.status !== "running") continue;
        const input = record(state.input);
        if (Array.isArray(input.questions)) return { name: "question", input: { questions: input.questions } };
        return null;
      }
    }
    return null;
  }

  // Where a page ending at `end` starts: at most MAX_PAGE_PROMPTS prompts back,
  // fewer when their rows are too large to read at once, else `floor`.
  function pageStartV2(db, session, end, floor) {
    const prompts = db.statement("promptsBeforeV2").all({ session, endSeq: end, rows: MAX_PAGE_PROMPTS + 1 })
      .map(keyOfV2).filter((key) => !beforeV2(key, floor));
    let take = Math.min(prompts.length, MAX_PAGE_PROMPTS);
    let start = prompts.length > MAX_PAGE_PROMPTS ? prompts[MAX_PAGE_PROMPTS - 1] : floor;
    const tooLarge = (from) => {
      const cost = db.statement("pageBytesV2").get({ session, fromSeq: from, toSeq: end, large: V2_LARGE_ROW_BYTES }) ?? {};
      return Number(cost.bytes ?? 0) > MAX_PAGE_BYTES || Number(cost.parts ?? 0) > MAX_PAGE_PARTS;
    };
    while (take > 1 && tooLarge(start)) {
      take = Math.floor(take / 2);
      start = prompts[take - 1];
    }
    return start;
  }

  // The page's messages, newest first, at most $rows; a large one reduced in
  // JavaScript (shapeV2Row), its words and tool outputs cut. A message the
  // page cannot read is skipped for this read; the page's cursor stays at
  // the oldest message read, so the next page goes after it and the message
  // is read again from its own start.
  function readMessagesV2(db, session, from, to) {
    const rows = db.statement("messagesV2").all({ session, fromSeq: from, toSeq: to, rows: maxMessages + 1 });
    const cut = rows.length > maxMessages;
    if (cut) rows.pop();
    const messages = rows.reverse().map((row) => {
      const shaped = shapeV2Row(string(row.data), V2_LARGE_ROW_BYTES);
      return shaped ? { id: String(row.id), time: Number(row.time_created), seq: Number(row.seq), type: String(row.type), info: shaped.info } : null;
    }).filter((row) => row !== null);
    if (messages.length === 0) return { messages, start: from };
    // the cursor is null when the page reaches the session's first message
    const first = messages[0];
    const hasEarlier = db.statement("v2FirstBefore").get({ session, seq: first.seq });
    const start = hasEarlier ? first.seq : V2_BEGINNING;
    return { messages, start };
  }

  const operations = {
    // see the store's locate
    locate(db, { session = null, cwd = null, taken = [] } = {}) {
      if (typeof session === "string" && OPENCODE_SESSION_ID.test(session)) {
        let row = db.shape.v1 ? db.statement("session").get(session) : undefined;
        if (!row && db.shape.v2) row = db.statement("sessionV2").get(session);
        if (!row) return { session, found: false };
        // A V2 fork (fork_session_id set) is an independent conversation, not a
        // subagent: its parent_id names the session it was forked from, but the
        // fork's own messages are its own and it is shown on its own.
        if (db.shape.v2 && row.fork_session_id != null) return { session: String(row.id), found: true };
        for (let depth = 0; row && row.parent_id != null && depth < MAX_SESSION_DEPTH; depth++) {
          const parent = String(row.parent_id);
          if (!OPENCODE_SESSION_ID.test(parent)) { row = null; break; }
          row = (db.shape.v1 ? db.statement("session").get(parent) : undefined) ?? (db.shape.v2 ? db.statement("sessionV2").get(parent) : null);
        }
        if (row && row.parent_id == null) return { session: String(row.id), found: true };
        return { session, child: true };
      }
      if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
      // the newest top-level session of the folder: OpenCode 2 carries a V1
      // session into session_v2 but a new V2 session only there, so the pane's
      // session is the newest across both tables. A V2 session that the old
      // table does not hold is OpenCode 2's own, and is preferred over a V1
      // session the old table holds more recently (the old table's
      // time_updated can lag when OpenCode 2 carries a V1 session on).
      const name = db.shape.archive ? "newestInDirectory" : "newestInDirectoryAny";
      let row = db.shape.v1 ? db.statement(name).get(cwd) : undefined;
      if (db.shape.v2) {
        const v2name = db.shape.v2Archive ? "newestInDirectoryV2" : "newestInDirectoryAnyV2";
        const v2row = db.statement(v2name).get(cwd);
        if (v2row) {
          if (!row) row = v2row;
          else {
            // a V2 session the old table does not hold is OpenCode 2's own:
            // prefer it over a V1 session the old table holds more recently
            const inOld = db.shape.v1 ? db.statement("session").get(String(v2row.id)) : undefined;
            if (!inOld) row = v2row;
            else {
              // both tables hold it: pick the one OpenCode touched more recently
              const t1 = Number((db.shape.v1 ? db.statement("session").get(String(row.id)) : undefined)?.time_updated ?? 0);
              const t2 = Number(db.statement("sessionV2").get(String(v2row.id))?.time_updated ?? 0);
              if (t2 > t1) row = v2row;
            }
          }
        }
      }
      // another pane already shows the newest one: which pane is it is not known
      if (row && Array.isArray(taken) && taken.includes(String(row.id))) return null;
      return row && OPENCODE_SESSION_ID.test(String(row.id)) ? { session: String(row.id), found: true } : null;
    },

    identity(db, session) {
      if (db.shape.v1 && db.statement("session").get(session)) return identityIn(db, session);
      if (db.shape.v2 && db.statement("sessionV2").get(session)) return identityInV2(db, session);
      return null;
    },

    page(db, session, { before: beforeCursor, since, ifNoneMatch } = {}) {
      // a session the old tables hold reads from them: OpenCode 2 carries a
      // V1 session on by writing its new messages to the V2 tables alone, and
      // the old tables keep every message the V1 reader read
      const row = db.shape.v1 ? db.statement("session").get(session) : undefined;
      const v2 = row === undefined && db.shape.v2 && db.statement("sessionV2").get(session) !== undefined;
      const sessionRow = v2 ? db.statement("sessionV2").get(session) : row;
      if (!sessionRow) throw new ConversationUnavailable("transcript_missing");
      const history = v2 ? historyOfV2(db, sessionRow) : historyOf(db, sessionRow);
      const identity = v2 ? identityInV2(db, session) : identityIn(db, session);
      const key = `${history.id}\0${beforeCursor ?? ""}\0${since ?? ""}`;
      const version = answerVersion(`opencode\0${path}\0${key}`, identity);
      if (versionMatches(ifNoneMatch, version)) return { notModified: true, version };
      const cached = answers.get(key);
      if (cached?.version === version) return cached.answer;
      let start;
      let end = history.end;
      if (v2) {
        // V2's keys are seqs: numbers, not { time, id }
        if (beforeCursor !== undefined) {
          end = parseCursorV2(db, history, session, beforeCursor);
          const floor = since === undefined ? V2_BEGINNING : parseCursorV2(db, history, session, since);
          if (beforeV2(end, floor)) throw new HistoryChanged();
          start = end === floor ? floor : pageStartV2(db, session, end, floor);
        } else {
          const held = since === undefined ? null : parseCursorV2(db, history, session, since);
          const newest = pageStartV2(db, session, end, V2_BEGINNING);
          start = held !== null && !beforeV2(held, newest) ? held : newest;
        }
        let messages = [];
        if (beforeV2(start, end)) ({ messages, start } = readMessagesV2(db, session, start, end));
        const page = {
          source: OPENCODE_SESSION.source,
          turns: parseV2Turns(messages),
          metadata: v2Metadata(messages),
          cursor: start === V2_BEGINNING ? null : cursorOfV2(history, start),
          history_id: history.id,
          version,
        };
        remember(answers, key, { version, answer: page }, 32);
        return page;
      }
      if (beforeCursor !== undefined) {
        end = parseCursor(db, history, session, beforeCursor);
        const floor = since === undefined ? BEGINNING : parseCursor(db, history, session, since);
        if (before(end, floor)) throw new HistoryChanged();
        start = end.time === floor.time && end.id === floor.id ? floor : pageStart(db, session, end, floor);
      } else {
        const held = since === undefined ? null : parseCursor(db, history, session, since);
        const newest = pageStart(db, session, end, BEGINNING);
        start = held !== null && !before(held, newest) ? held : newest;
      }
      let messages = [];
      if (before(start, end)) ({ messages, start } = readMessages(db, session, start, end));
      const page = {
        source: OPENCODE_SESSION.source,
        turns: parseOpencodeTurns(messages),
        metadata: opencodeMetadata(messages),
        cursor: start === BEGINNING ? null : cursorOf(history, start),
        history_id: history.id,
        version,
      };
      remember(answers, key, { version, answer: page }, 32);
      return page;
    },

    toolOutput(db, session, toolId) {
      // SQLite cuts the output: a 50 MB one never crosses into JavaScript whole
      const words = String(toolId);
      const at = words.indexOf(" ");
      if (at > 0 && db.shape.v2) {
        // a V2 key: the message row that holds the call, and the call's own id
        const rowId = words.slice(0, at);
        const callId = words.slice(at + 1);
        if (MESSAGE_ID.test(rowId) && TOOL_ID.test(callId)) {
          const v2row = db.statement("toolPartV2").get({ id: rowId, session, tool: callId, max: TOOL_OUTPUT_MAX_CHARS });
          if (v2row) {
            const output = string(v2row.output);
            const size = Number(v2row.size ?? 0);
            return { output: size > output.length ? output.slice(0, TOOL_OUTPUT_MAX_CHARS) : output, size };
          }
          return null;
        }
      }
      if (!db.shape.v1) return null;
      const row = db.statement("toolPart").get({ id: words, session, max: TOOL_OUTPUT_MAX_CHARS });
      if (row && row.kind === "tool") return { output: string(row.output), size: Number(row.size ?? 0) };
      return null;
    },

    pendingQuestion(db, session) {
      const inV1 = db.shape.v1 && db.statement("session").get(session) !== undefined;
      if (!inV1 && db.shape.v2) {
        // a V2 session's question: its newest assistant rows
        return pendingQuestionV2(db, session);
      }
      const row = db.statement("pendingQuestion").get({ session, large: PENDING_QUESTION_BYTES });
      if (row) {
        const input = parse(string(row.input));
        if (Array.isArray(input.questions)) return { name: "question", input: { questions: input.questions } };
      }
      if (!db.shape.v2) return null;
      const rows = db.statement("pendingQuestionV2").all({ session, large: PENDING_QUESTION_BYTES, rows: 32 });
      for (const v2row of rows) {
        let info;
        try { info = record(JSON.parse(v2row.data)); } catch { continue; }
        const content = Array.isArray(info.content) ? info.content : [];
        for (let i = content.length - 1; i >= 0; i -= 1) {
          const item = record(content[i]);
          if (item.type !== "tool" || item.name !== "question") continue;
          const state = record(item.state);
          if (state.status !== "running") continue;
          const input = record(state.input);
          if (Array.isArray(input.questions)) return { name: "question", input: { questions: input.questions } };
          return null;
        }
      }
      return null;
    },

    sessionVersion(db, session) {
      if (db.shape.v1) {
        const row = db.statement("session").get(session);
        if (row) {
          if (!db.shape.version) return null;
          const value = db.statement("sessionVersion").get(session)?.version;
          return typeof value === "string" && value.length <= 64 ? value : null;
        }
      }
      if (db.shape.v2 && db.statement("sessionV2").get(session)) {
        const value = db.statement("sessionV2Version").get(session)?.version;
        return typeof value === "string" && value.length <= 64 ? value : null;
      }
      return null;
    },
  };

  return function read(op, args, file) {
    if (!OPERATIONS.includes(op) || !Array.isArray(args)) throw new Error(`unknown operation ${String(op)}`);
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
    } catch {
      return null;
    }
    try {
      const handle = statementsOf(db, onPrepare);
      // in-place migrations keep the inode: the main file's size and mtime key the check too
      let shape = shapes.get(file);
      if (shape === undefined) {
        try {
          shape = shapeOf(handle);
        } catch {
          // a database locked mid-migration says nothing about its shape yet
          return null;
        }
        // a database not migrated yet is looked at again next time
        if (shape !== null) remember(shapes, file, shape, 8);
      }
      if (shape === null) throw unsupported();
      handle.shape = shape;
      return operations[op](handle, ...args);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  };
}

// How an error crosses from the worker: the two the service answers by kind, the rest as their words.
function errorOf(error) {
  if (error instanceof ConversationUnavailable) return { type: "unavailable", reason: error.reason };
  if (error instanceof HistoryChanged) return { type: "history" };
  return { type: "error", message: String(error?.message ?? error) };
}

function revive(error) {
  if (error?.type === "unavailable") return new ConversationUnavailable(error.reason);
  if (error?.type === "history") return new HistoryChanged();
  return new Error(string(error?.message) || "OpenCode read failed");
}

// What the worker answers one request with: { id, op, args, file, delayMs } ->
// { id, ok: true, value } or { id, ok: false, error }. `read` is null when the
// worker has no node:sqlite. `delayMs` holds the worker that long first (a
// test's slow read).
export function answerRequest(read, request) {
  const { id, op, args, file, delayMs } = record(request);
  try {
    if (!OPERATIONS.includes(op) || !Array.isArray(args)) throw new Error(`unknown operation ${String(op)}`);
    if (Number.isFinite(delayMs) && delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    if (read === null) throw new ConversationUnavailable(NEEDS_NEWER_NODE);
    return { id, ok: true, value: read(op, args, String(file)) };
  } catch (error) {
    return { id, ok: false, error: errorOf(error) };
  }
}

const WORKER_URL = new URL("./opencode-worker.mjs", import.meta.url);
// How long one read may take, from when the worker begins it, before the
// database counts as too busy to answer this time.
export const WORKER_TIMEOUT_MS = 10_000;
// Most requests the client keeps waiting for the worker; more answer BUSY at once.
export const WORKER_QUEUE_MAX = 32;
// The client's answer that says: read in this thread (no worker could start).
const HERE = Symbol("read here");
// A read that timed out, or that a worker not yet gone keeps from starting:
// busy this time, not a missing session (pages.mjs READ_BUSY).
const BUSY = Object.freeze({ ok: false, error: Object.freeze({ type: "unavailable", reason: READ_BUSY }) });

// One long-lived worker, started at the first read and again after it is let
// go, reads one request at a time: the client keeps the rest in its own queue
// and sends the next when the last is answered, so a read's `timeoutMs` counts
// from when the worker is given it, never the time it waited behind others,
// and nothing waits in a worker's port when that worker is let go. (The cost:
// one message's round trip between reads.) It never holds the process open
// while idle; a read waiting on it does.
//
// A request also answers BUSY once it has waited `timeoutMs` in the queue.
// A read past `timeoutMs` lets the worker go and answers BUSY, as does every
// read queued behind it. A synchronous SQLite read cannot be interrupted, so
// a worker let go may run on for a while: until it has exited no new worker
// starts and every read answers BUSY at once, so slow reads never pile up
// threads. A worker that dies by itself answers its read BUSY and the reads
// queued behind it go to the next worker. One that cannot be created, or dies
// before its module loaded, means reading here from then on.
function workerClient({ createWorker, workerData, timeoutMs }) {
  // { worker, ready, exited, dropped }
  let current = null;
  let here = false;
  let nextId = 1;
  // workers let go that have not exited yet
  let lingering = 0;
  // { message, resolve, reject }, not yet sent
  const queue = [];
  // { id, job, timer }: the request the current worker reads
  let running = null;

  // Takes the first queued request off the queue and stops its waiting timer.
  function takeQueued() {
    const job = queue.shift();
    clearTimeout(job.waitTimer);
    return job;
  }

  function pump() {
    while (running === null && queue.length > 0) {
      if (here) {
        takeQueued().resolve(HERE);
        continue;
      }
      if (current === null) {
        // the reads queued behind a worker that died go to the next once it is gone
        if (lingering > 0) return;
        current = start();
        if (current === null) continue;
      }
      const job = takeQueued();
      const id = nextId++;
      const reader = current;
      try {
        reader.worker.postMessage({ ...job.message, id });
      } catch (error) {
        // a request that cannot be sent (cannot be cloned) is its own failure
        job.reject(error);
        continue;
      }
      running = { id, job, timer: setTimeout(() => drop(reader, BUSY, { queued: BUSY }), timeoutMs) };
      reader.worker.ref();
    }
    if (running === null) current?.worker.unref();
  }

  // Lets `reader` go, if it is still the current worker: its read answers
  // `answer`, the reads queued behind it `queued` (null: they wait for the next worker).
  function drop(reader, answer, { queued = null } = {}) {
    if (reader === null || reader !== current) return;
    current = null;
    reader.dropped = true;
    if (!reader.exited) lingering += 1;
    if (running !== null) {
      clearTimeout(running.timer);
      running.job.resolve(answer);
      running = null;
    }
    if (queued !== null) while (queue.length > 0) takeQueued().resolve(queued);
    reader.worker.unref();
    try {
      Promise.resolve(reader.worker.terminate()).catch(() => {});
    } catch { /* it ends by itself */ }
    pump();
  }

  function start() {
    let worker;
    try {
      worker = createWorker(WORKER_URL, { workerData });
    } catch {
      here = true;
      return null;
    }
    const reader = { worker, ready: false, exited: false, dropped: false };
    worker.unref();
    worker.on("message", (message) => {
      if (message?.ready === true) {
        reader.ready = true;
        return;
      }
      if (reader !== current || running === null || message?.id !== running.id) return;
      const { job, timer } = running;
      running = null;
      clearTimeout(timer);
      job.resolve(message);
      pump();
    });
    // Died by itself. Before its module loaded: read here from then on.
    const lost = () => {
      if (reader !== current) return;
      if (!reader.ready) here = true;
      drop(reader, reader.ready ? BUSY : HERE);
    };
    worker.on("error", lost);
    worker.on("exit", () => {
      if (reader.exited) return;
      reader.exited = true;
      if (reader.dropped) lingering -= 1;
      else lost();
      pump();
    });
    return reader;
  }

  return {
    request(message) {
      if (here) return Promise.resolve(HERE);
      // a worker let go still reads: no second one beside it
      if (current === null && lingering > 0) return Promise.resolve(BUSY);
      // a queue this long means the worker cannot keep up: busy at once
      if (queue.length >= WORKER_QUEUE_MAX) return Promise.resolve(BUSY);
      return new Promise((resolve, reject) => {
        const job = { message, resolve, reject, waitTimer: null };
        // waiting in the queue is bounded by `timeoutMs` too (the dispatch timeout is separate)
        job.waitTimer = setTimeout(() => {
          const at = queue.indexOf(job);
          if (at >= 0) queue.splice(at, 1);
          resolve(BUSY);
        }, timeoutMs);
        job.waitTimer.unref();
        queue.push(job);
        pump();
      });
    },
    close() {
      drop(current, BUSY, { queued: BUSY });
      while (queue.length > 0) takeQueued().resolve(BUSY);
    },
  };
}

// This machine's OpenCode database, read only. As a store it answers
// stat(session) with an identity that changes whenever the session does, so
// the monitor and a hub's signature poll treat it as they treat a file.
// `createWorker(url, options)`: how its reading worker starts (null: read in
// this thread); `onPrepare(sql)`: sees each statement prepared, here or in the
// worker; `requestDelayMs()`: how long the worker waits before each read (tests).
export function localOpencodeStore({
  path = defaultOpencodeDb(), statFile = stat, importSqlite = () => import("node:sqlite"), maxMessages = MAX_PAGE_MESSAGES, now = () => Date.now(),
  createWorker = (url, options) => new Worker(url, options), timeoutMs = WORKER_TIMEOUT_MS, onPrepare = null, requestDelayMs = () => 0,
} = {}) {
  let sqlite;
  const loadSqlite = () => (sqlite ??= Promise.resolve().then(importSqlite).catch(() => null));
  // session -> { files, value }: the identity last read, kept while the files did not change
  const identities = new Map();
  const client = typeof createWorker === "function"
    ? workerClient({ createWorker, timeoutMs, workerData: { path, maxMessages, trace: typeof onPrepare === "function" } })
    : null;
  let local = null;

  async function files() {
    const one = async (file) => {
      try {
        const info = await statFile(file);
        return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      } catch {
        return "-";
      }
    };
    return `${await one(path)}|${await one(`${path}-wal`)}`;
  }

  // Runs one of OPERATIONS in the worker (else here); null when the database
  // is not there. A worker too busy to answer throws ConversationUnavailable
  // (READ_BUSY), which no caller remembers as a missing session.
  async function read(op, ...args) {
    const module = await loadSqlite();
    // this Node has no node:sqlite: not the same as a session that is missing
    if (!module?.DatabaseSync) throw new ConversationUnavailable(NEEDS_NEWER_NODE);
    let info;
    try { info = await statFile(path); } catch { return null; }
    const file = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    const answer = client === null ? HERE : await client.request({ op, args, file, delayMs: requestDelayMs() });
    if (answer === HERE) {
      local ??= opencodeReader({ DatabaseSync: module.DatabaseSync, path, maxMessages, onPrepare });
      return local(op, args, file);
    }
    if (typeof onPrepare === "function") for (const sql of answer.prepared ?? []) onPrepare(sql);
    if (answer.ok) return answer.value;
    throw revive(answer.error);
  }

  return {
    key: `opencode:${path}`,
    remote: false,
    path,

    // The session a pane shows: the one herdr reports, when it is a top-level
    // session of this database; a subagent's session reported reads as the
    // top-level session it belongs to. Else, with none reported, the newest
    // top-level session started in the pane's folder. { session, found }:
    // found false for a reported session not written yet; { child } for a
    // reported subagent's session whose top-level session is not there. Null
    // when nothing tells.
    async locate({ session = null, cwd = null, taken = [] } = {}) {
      return read("locate", { session, cwd, taken: Array.isArray(taken) ? [...taken] : [] });
    },

    // { identity, size, mtimeMs } of the session, or null when it is gone or
    // the database cannot be read; a database too busy to answer (READ_BUSY)
    // throws and is not remembered. Read again when the database's files
    // changed, and at least every IDENTITY_RECHECK_MS: a write the files'
    // size and time do not show (same size, same millisecond) is seen soon.
    async stat(session) {
      if (typeof session !== "string" || !OPENCODE_SESSION_ID.test(session)) return null;
      const seen = await files();
      const known = identities.get(session);
      if (known?.files === seen && now() - known.at < IDENTITY_RECHECK_MS) return known.value;
      let value = null;
      try {
        const identity = await read("identity", session);
        value = identity === null ? null : { identity, size: 0, mtimeMs: 0 };
      } catch (error) {
        if (error instanceof ConversationUnavailable) throw error;
        value = null;
      }
      remember(identities, session, { files: seen, value, at: now() }, 64);
      return value;
    },

    // One page of the session, as transcriptPage answers one.
    async page(session, { before: beforeCursor, since, ifNoneMatch } = {}) {
      const answer = await read("page", session, { before: beforeCursor, since, ifNoneMatch });
      if (answer === null) throw new ConversationUnavailable("transcript_missing");
      return answer;
    },

    // The question the session waits on: its newest `question` tool call still
    // running, as { name: "question", input }, or null (none running, or the
    // newest one's input over PENDING_QUESTION_BYTES or without questions; an
    // older running call never stands in). A prompt card takes its words.
    async pendingQuestion(session) {
      if (typeof session !== "string" || !OPENCODE_SESSION_ID.test(session)) return null;
      return (await read("pendingQuestion", session)) ?? null;
    },

    // The OpenCode version that wrote the session (its `version` column), or
    // null: no such session, no such column, or not a short version string.
    async sessionVersion(session) {
      if (typeof session !== "string" || !OPENCODE_SESSION_ID.test(session)) return null;
      return (await read("sessionVersion", session)) ?? null;
    },

    // The whole output of one tool call (a part's id, or a V2 key of its
    // message row and call), as { output, size }, or null.
    async toolOutput(session, toolId) {
      if (typeof toolId !== "string" || toolId.length === 0 || toolId.length > 200) return null;
      const at = toolId.indexOf(" ");
      if (at > 0) {
        if (!TOOL_ID.test(toolId.slice(0, at)) || !TOOL_ID.test(toolId.slice(at + 1))) return null;
      } else if (!TOOL_ID.test(toolId)) return null;
      return (await read("toolOutput", session, toolId)) ?? null;
    },

    // Lets the reading worker go (a later read starts it again).
    close() {
      client?.close();
    },
  };
}

// What the service names OpenCode's conversations by; its pages come from the
// store above, not from pages.mjs's byte paging.
export const OPENCODE_SESSION = Object.freeze({ source: "opencode-session" });
