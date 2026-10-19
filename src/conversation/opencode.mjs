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
// nothing else is read. A test holds this list to that.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { toolSummary } from "./claude.mjs";
import { patchFiles, patchText } from "./codex.mjs";
import {
  ConversationUnavailable,
  HistoryChanged,
  MAX_PAGE_PROMPTS,
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
// How many parts and messages one page reads at most.
const MAX_PAGE_PARTS = 5000;
const MAX_PAGE_MESSAGES = 5000;

// The messages of one page: a session's message keys from $fromTime/$fromId
// (included) to $toTime/$toId (excluded).
const RANGE = "session_id = $session AND (time_created > $fromTime OR (time_created = $fromTime AND id >= $fromId)) AND (time_created < $toTime OR (time_created = $toTime AND id < $toId))";
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
  // one tool call's output: at most $max characters of it, and its whole length
  toolPart: `SELECT kind, substr(output, 1, $max) AS output, length(output) AS size FROM (SELECT data ->> '$.type' AS kind, ${outputOf("data")} AS output FROM part WHERE id = $id AND session_id = $session)`,
});

// The tables (and columns) the statements read; a database without one of
// them is a version this module does not read.
const TABLES = Object.freeze({
  session: ["id", "parent_id", "directory", "revert", "time_updated"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_updated", "data"],
});
// Read when there: an older database has no event log or archive.
const OPTIONAL = Object.freeze({ event_sequence: ["aggregate_id", "seq"], session: ["time_archived"] });

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

// Where a session's shown history ends: an undo hides the reverted messages
// until OpenCode drops them. { key, part }: the message undone to, and the part in it.
function revertOf(db, row) {
  const revert = parse(string(row.revert));
  const id = string(revert.messageID);
  if (!MESSAGE_ID.test(id)) return null;
  const found = db.statement("message").get(id, row.id);
  return found ? { key: keyOf(found), part: string(revert.partID) } : null;
}

// This machine's OpenCode database, read only. As a store it answers
// stat(session) with an identity that changes whenever the session does, so
// the monitor and a hub's signature poll treat it as they treat a file.
export function localOpencodeStore({ path = defaultOpencodeDb(), statFile = stat, importSqlite = () => import("node:sqlite") } = {}) {
  let sqlite;
  const loadSqlite = () => (sqlite ??= Promise.resolve().then(importSqlite).catch(() => null));
  // dev:ino -> whether that database has the tables and columns read here
  const shapes = new Map();
  // session -> { files, value }: the identity last read, kept while the files did not change
  const identities = new Map();
  const answers = new Map();

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

  // Runs `work(db)` on a short connection. A database that cannot be opened
  // (none yet, or its WAL index missing) answers null; one whose shape is
  // not OpenCode's as known here throws unsupported.
  async function withDb(work) {
    const module = await loadSqlite();
    // this Node has no node:sqlite: not the same as a session that is missing
    if (!module?.DatabaseSync) throw new ConversationUnavailable(NEEDS_NEWER_NODE);
    let info;
    try { info = await statFile(path); } catch { return null; }
    let db;
    try {
      db = new module.DatabaseSync(path, { readOnly: true });
    } catch {
      return null;
    }
    try {
      const prepared = new Map();
      const handle = {
        statement(name) {
          const sql = STATEMENTS[name];
          if (sql === undefined) throw new Error(`unknown statement ${name}`);
          let statement = prepared.get(name);
          if (!statement) {
            statement = db.prepare(sql);
            prepared.set(name, statement);
          }
          return statement;
        },
      };
      // in-place migrations keep the inode: the main file's size and mtime key the check too
      const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      let shape = shapes.get(identity);
      if (shape === undefined) {
        try {
          shape = shapeOf(handle);
        } catch {
          // a database locked mid-migration says nothing about its shape yet
          return null;
        }
        // a database not migrated yet is looked at again next time
        if (shape !== null) remember(shapes, identity, shape, 8);
      }
      if (shape === null) throw unsupported();
      handle.shape = shape;
      return work(handle);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  function shapeOf(handle) {
    const columns = (table) => new Set(handle.statement("columns").all(table).map((row) => row.name));
    for (const [table, wanted] of Object.entries(TABLES)) {
      const have = columns(table);
      if (!wanted.every((column) => have.has(column))) return null;
    }
    const events = columns("event_sequence");
    const sessions = columns("session");
    return {
      events: OPTIONAL.event_sequence.every((column) => events.has(column)),
      archive: OPTIONAL.session.every((column) => sessions.has(column)),
    };
  }

  function identityIn(db, session) {
    const row = db.statement("session").get(session);
    if (!row) return null;
    const seq = db.shape.events ? db.statement("sequence").get(session)?.seq ?? "" : "";
    const parts = db.statement("partsChanged").get(session) ?? {};
    const messages = db.statement("messagesChanged").get(session) ?? {};
    return [seq, row.time_updated, string(row.revert).length, parts.updated ?? "", parts.parts ?? 0,
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
  function readMessages(db, session, from, to) {
    const where = named(session, from, to);
    const messages = db.statement("messages").all({ ...where, large: LARGE_ROW_BYTES, rows: MAX_PAGE_MESSAGES }).reverse().map((row) => ({
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
    return messages;
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
      return withDb((db) => {
        if (typeof session === "string" && OPENCODE_SESSION_ID.test(session)) {
          let row = db.statement("session").get(session);
          if (!row) return { session, found: false };
          for (let depth = 0; row && row.parent_id != null && depth < MAX_SESSION_DEPTH; depth++) {
            const parent = String(row.parent_id);
            row = OPENCODE_SESSION_ID.test(parent) ? db.statement("session").get(parent) : null;
          }
          if (row && row.parent_id == null) return { session: String(row.id), found: true };
          return { session, child: true };
        }
        if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
        const row = db.statement(db.shape.archive ? "newestInDirectory" : "newestInDirectoryAny").get(cwd);
        // another pane already shows the newest one: which pane is it is not known
        if (row && taken.includes(String(row.id))) return null;
        return row && OPENCODE_SESSION_ID.test(String(row.id)) ? { session: String(row.id), found: true } : null;
      });
    },

    // { identity, size, mtimeMs } of the session, or null when it is gone or
    // the database cannot be read. Read again only when the database's files changed.
    async stat(session) {
      if (typeof session !== "string" || !OPENCODE_SESSION_ID.test(session)) return null;
      const seen = await files();
      const known = identities.get(session);
      if (known?.files === seen) return known.value;
      let value = null;
      try {
        const identity = await withDb((db) => identityIn(db, session));
        value = identity === null ? null : { identity, size: 0, mtimeMs: 0 };
      } catch (error) {
        if (error instanceof ConversationUnavailable) throw error;
        value = null;
      }
      remember(identities, session, { files: seen, value }, 64);
      return value;
    },

    // One page of the session, as transcriptPage answers one.
    async page(session, { before: beforeCursor, since, ifNoneMatch } = {}) {
      const answer = await withDb((db) => {
        const row = db.statement("session").get(session);
        if (!row) throw new ConversationUnavailable("transcript_missing");
        const history = historyOf(db, row);
        const key = `${history.id}\0${beforeCursor ?? ""}\0${since ?? ""}`;
        const version = answerVersion(`opencode\0${path}\0${key}`, identityIn(db, session));
        if (versionMatches(ifNoneMatch, version)) return { notModified: true, version };
        const cached = answers.get(key);
        if (cached?.version === version) return cached.answer;
        let start;
        let end = history.end;
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
        const messages = before(start, end) ? readMessages(db, session, start, end) : [];
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
      });
      if (answer === null) throw new ConversationUnavailable("transcript_missing");
      return answer;
    },

    // The whole output of one tool call (a part's id), as { output, size }, or null.
    async toolOutput(session, toolId) {
      if (typeof toolId !== "string" || !TOOL_ID.test(toolId)) return null;
      // SQLite cuts the output: a 50 MB one never crosses into JavaScript whole
      const found = await withDb((db) => {
        const row = db.statement("toolPart").get({ id: toolId, session, max: TOOL_OUTPUT_MAX_CHARS });
        if (!row || row.kind !== "tool") return null;
        return { output: string(row.output), size: Number(row.size ?? 0) };
      });
      return found ?? null;
    },
  };
}

// What the service names OpenCode's conversations by; its pages come from the
// store above, not from pages.mjs's byte paging.
export const OPENCODE_SESSION = Object.freeze({ source: "opencode-session" });
