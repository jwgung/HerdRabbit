// What every agent's transcript shares once it is found: the errors the
// routes answer with, the limits a page keeps to, and the paging itself. A
// transcript is a JSONL file that only grows at its end, read through a store
// (stores.mjs). What differs per agent (which line opens a turn, how
// lines read as turns, where a tool's output is) comes in as a format:
//
//   source              "claude-transcript", "codex-transcript", ...
//   turnStarts(bytes)   offsets of the lines that open a turn
//   startContextBytes   how far before a window turnStarts also reads, for a
//                       format whose starts depend on records before them
//                       (absent: the window alone)
//   unbroken(bytes)     optional: [start, end) byte spans a page must not
//                       start inside (a page cut mid-turn moves back to
//                       their start)
//   parse(text)         { turns, cleared }: cleared when the page holds a reset
//   metadata(text)      { model, reasoning_effort, context? }
//   headBytes           how much of the file's start the metadata also reads
//                       when a page starts past it (0: the page alone)
//   toolNeedle(id)      bytes every line answering that tool call holds
//   toolOutputIn(entry, id)  that call's output in one parsed line, or null
//
// Ported from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- the paging parts of
// server/conversation.ts and server/tool-output.ts, rewritten for plain
// Node ESM.
import { createHash, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Errors the routes answer with their own codes.

export class ConversationError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ConversationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// The pane has no transcript to show: not an agent the chat reads, no
// session yet, or the file is gone. `reason` says which, for the page to word it.
export class ConversationUnavailable extends ConversationError {
  constructor(reason) {
    super(404, "conversation_unavailable", "This pane has no conversation to show.", { reason });
    this.name = "ConversationUnavailable";
    this.reason = reason;
  }
}

// A database too busy to answer this time (OpenCode's: a read past its
// timeout, or a reader not yet let go): not a missing conversation. Nothing
// remembers it as missing, nothing reads it as a change, the next read asks again.
export const READ_BUSY = "opencode_busy";

export function isReadBusy(error) {
  return error instanceof ConversationUnavailable && error.reason === READ_BUSY;
}

// A cursor from another transcript (a new session, a file rewritten in place):
// the page reloads from the newest turns.
export class HistoryChanged extends ConversationError {
  constructor() {
    super(409, "history_changed", "The conversation changed. Reload it from its newest turns.");
    this.name = "HistoryChanged";
  }
}

// ---------------------------------------------------------------------------
// Limits and the shapes every parser shares.

// A page never holds more prompts than this (each opens a user + assistant pair).
export const MAX_PAGE_PROMPTS = 50;
// What a page carries of one tool's output; the rest is fetched by id.
export const TOOL_OUTPUT_PREVIEW_CHARS = 2000;
// A tool's input (a whole file written) is cut in the page; it is not fetched again.
export const TOOL_INPUT_CHARS = 4000;
// A whole output fetched by id is still bounded: a page of it, not a log file.
export const TOOL_OUTPUT_MAX_CHARS = 1_000_000;
// One transcript line longer than this is skipped by the tool-output scan.
const MAX_SCANNED_LINE_BYTES = 16 * 1024 * 1024;

export const TOOL_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

// A tool part's output: the preview a page carries, and how long the whole is.
export function setToolOutput(tool, output) {
  tool.output_size = output.length;
  if (output.length <= TOOL_OUTPUT_PREVIEW_CHARS) {
    tool.output = output;
    return;
  }
  tool.output = output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
  tool.output_truncated = true;
}

// A tool's input as a page shows it: cut at TOOL_INPUT_CHARS.
export function toolInputFields(inputText) {
  return inputText.length > TOOL_INPUT_CHARS
    ? { input: inputText.slice(0, TOOL_INPUT_CHARS), input_truncated: true }
    : { input: inputText };
}

// ---------------------------------------------------------------------------
// Pages. A transcript only grows at its end, so a byte offset keeps naming
// the same turn for as long as the file does. A cursor is
// `<file identity>:<offset of the page's first turn>`.

// The turn starts in `scan` that fall at or after `lead` (the context bytes
// read before the window), and the spans a page must not start inside, as
// offsets from `lead`. A format whose starts depend on records before them
// (`startContextBytes`: Kiro's resent steering message) is given that much
// before the window; `unbroken(bytes)` names spans, such as a steering
// message and its resend, that one page has to hold whole.
function scanned(format, scan, lead) {
  const starts = format.turnStarts(scan);
  const unbroken = typeof format.unbroken === "function" ? format.unbroken(scan) : [];
  return {
    starts: lead === 0 ? starts : starts.filter((start) => start >= lead).map((start) => start - lead),
    unbroken: unbroken.map(([start, end]) => [start - lead, end - lead]),
  };
}

// `cut` moved back to the start of every unbroken span it falls inside, but
// never below `lowest`.
function beforeUnbroken(unbroken, cut, lowest) {
  for (let moved = true; moved;) {
    moved = false;
    for (const [start, end] of unbroken) {
      if (start < cut && cut < end && start >= lowest) { cut = start; moved = true; }
    }
  }
  return cut;
}

// The page of turns ending at `to`: at most MAX_PAGE_PROMPTS prompts, starting
// on a line that opens a turn, at `floor`, or at the very beginning. An older
// page (`widen`) reaches further back a window at a time, up to maxPageBytes,
// for a turn longer than a window; the newest page never does and, with no
// turn start in its window, starts mid-turn at a whole line.
async function pageBefore(format, store, path, to, { floor, widen, windowBytes, maxPageBytes }) {
  const contextBytes = format.startContextBytes ?? 0;
  let from = Math.max(floor, to - windowBytes);
  // `scan` holds the window and, before it, `lead` bytes of context
  let lead = Math.min(contextBytes, from);
  let scan = await store.read(path, from - lead, to - from + lead);
  for (;;) {
    const bytes = scan.subarray(lead);
    const { starts, unbroken } = scanned(format, scan, lead);
    const keep = starts.length > MAX_PAGE_PROMPTS ? starts[starts.length - MAX_PAGE_PROMPTS] : from === floor ? 0 : starts[0];
    if (keep !== undefined) return { start: from + keep, bytes: bytes.subarray(keep) };
    if (!widen || to - from >= maxPageBytes || from === floor) {
      // a cut mid-turn starts at a whole line, and not inside a span one
      // page has to hold whole (it may reach into the context for that)
      const firstLine = beforeUnbroken(unbroken, bytes.indexOf(0x0a) + 1, floor - from);
      return { start: from + firstLine, bytes: scan.subarray(lead + firstLine) };
    }
    const next = Math.max(floor, from - windowBytes, to - maxPageBytes);
    const nextLead = Math.min(contextBytes, next);
    const scanFrom = from - lead;
    const nextScanFrom = next - nextLead;
    scan = Buffer.concat([await store.read(path, nextScanFrom, scanFrom - nextScanFrom), scan]);
    from = next;
    lead = nextLead;
  }
}

// In-place rewrites keep the inode: a file that shrank, kept its size but
// changed, or grew with its old tail altered gets a new generation, so cursors
// into its old bytes are refused. Each file's last bytes are remembered as a
// short fingerprint; a file that grew is trusted as an append only while the
// bytes just before its old end still hash the same.
// Revisions and answers are kept per store object: two stores never share
// them, and a store dropped (a machine's client replaced) takes them along.
let states = new WeakMap();
function stateOf(store) {
  let state = states.get(store);
  if (!state) {
    state = { revisions: new Map(), answers: new Map(), reckoning: new Map() };
    states.set(store, state);
  }
  return state;
}
const TAIL_BYTES = 256;
export function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}

function fingerprint(bytes) {
  return createHash("sha256").update(bytes).digest("base64url").slice(0, 22);
}

// One reckoning per file at a time: two requests that overlap would otherwise
// both start from the same remembered revision and each mint a generation,
// refusing the other's cursors although the file did not change again.
export function transcriptId(store, path, stat) {
  const { reckoning } = stateOf(store);
  const run = (reckoning.get(path) ?? Promise.resolve()).catch(() => {}).then(() => reckonTranscriptId(store, path, stat));
  reckoning.set(path, run);
  const settle = () => { if (reckoning.get(path) === run) reckoning.delete(path); };
  run.then(settle, settle);
  return run;
}

async function reckonTranscriptId(store, path, stat) {
  const { revisions } = stateOf(store);
  const key = path;
  const previous = revisions.get(key);
  const sameFile = previous && previous.identity === stat.identity;
  const unchanged = sameFile && stat.size === previous.size && stat.mtimeMs === previous.mtimeMs;
  let rewritten = sameFile && (stat.size < previous.size || (stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs));
  let tail = unchanged ? previous.tail : null;
  if (!unchanged) {
    // one small read: the old end's bytes to verify, and (when close enough) the new end's with them
    const verify = sameFile && !rewritten && previous.tail !== null && previous.size > 0;
    const oldStart = verify ? Math.max(0, previous.size - TAIL_BYTES) : 0;
    const newStart = Math.max(0, stat.size - TAIL_BYTES);
    const from = verify && newStart - oldStart <= 4096 ? oldStart : newStart;
    const bytes = stat.size > from ? await store.read(path, from, stat.size - from) : Buffer.alloc(0);
    if (verify) {
      const old = from === oldStart ? bytes : await store.read(path, oldStart, previous.size - oldStart);
      rewritten = fingerprint(old.subarray(0, previous.size - oldStart)) !== previous.tail;
    }
    tail = fingerprint(bytes.subarray(newStart - from));
  }
  const generation = rewritten ? randomUUID().slice(0, 8) : sameFile ? previous.generation : "";
  remember(revisions, key, { identity: stat.identity, size: stat.size, mtimeMs: stat.mtimeMs, tail, generation }, 128);
  return `${stat.identity}${generation ? `-${generation}` : ""}`;
}

function parseCursor(id, size, cursor) {
  if (typeof cursor !== "string" || cursor.length > 200) throw new HistoryChanged();
  const separator = cursor.lastIndexOf(":");
  const offset = Number(cursor.slice(separator + 1));
  if (separator <= 0 || cursor.slice(0, separator) !== id || !/^\d+$/u.test(cursor.slice(separator + 1)) ||
      !Number.isSafeInteger(offset) || offset > size) {
    throw new HistoryChanged();
  }
  return offset;
}

// A restart may parse the same file differently: its answers never match an earlier ETag.
const PROCESS_VERSION = randomUUID();
export function answerVersion(key, signature) {
  return createHash("sha256").update(`${PROCESS_VERSION}\0${key}\0${signature}`).digest("base64url").slice(0, 22);
}

// `ifNoneMatch`: one version, or the list an If-None-Match header named.
export function versionMatches(ifNoneMatch, version) {
  if (ifNoneMatch === "*") return true;
  return Array.isArray(ifNoneMatch) ? ifNoneMatch.includes("*") || ifNoneMatch.includes(version) : ifNoneMatch === version;
}

// One page of a transcript read as `format`.
// - no cursor: the newest page;
// - `since` alone: every turn from that cursor while it is still inside the
//   newest page (an open chat polling its newest turns), else the newest page;
// - `before`: the page ending at that cursor, never reaching back past `since`.
// A cursor from another file, or past the end, throws HistoryChanged.
// `ifNoneMatch` answers { notModified: true } when nothing it shows changed.
export async function transcriptPage(format, store, path, { before, since, ifNoneMatch } = {}) {
  const stat = await store.stat(path);
  if (!stat) throw new ConversationUnavailable("transcript_missing");
  const id = await transcriptId(store, path, stat);
  const { answers } = stateOf(store);
  const key = `${format.source}\0${store.key}\0${path}\0${before ?? ""}\0${since ?? ""}`;
  // an older page never changes while its file stays the same; the newest changes with every append
  const signature = before !== undefined ? id : `${id}:${stat.size}:${stat.mtimeMs}`;
  const version = answerVersion(key, signature);
  if (versionMatches(ifNoneMatch, version)) return { notModified: true, version };
  const cached = answers.get(key);
  if (cached?.version === version) return cached.answer;

  const limits = { windowBytes: store.windowBytes, maxPageBytes: store.maxPageBytes };
  let start;
  let bytes;
  if (before !== undefined) {
    const end = parseCursor(id, stat.size, before);
    const floor = since === undefined ? 0 : parseCursor(id, stat.size, since);
    if (floor > end) throw new HistoryChanged();
    const older = end === floor ? { start: floor, bytes: Buffer.alloc(0) } : await pageBefore(format, store, path, end, { floor, widen: true, ...limits });
    ({ start, bytes } = older);
  } else {
    const held = since === undefined ? null : parseCursor(id, stat.size, since);
    const newest = await pageBefore(format, store, path, stat.size, { floor: 0, widen: false, ...limits });
    start = held !== null && held >= newest.start ? held : newest.start;
    bytes = newest.bytes.subarray(start - newest.start);
  }
  const text = bytes.toString("utf8");
  const { turns, cleared } = format.parse(text);
  // the settings a session states once, at its start, still hold on a later page
  const head = format.headBytes > 0 && start > 0
    ? (await store.read(path, 0, Math.min(start, format.headBytes))).toString("utf8")
    : "";
  // a reset on the page is where the conversation begins: nothing before it is offered
  const cursor = cleared || start === 0 ? null : `${id}:${start}`;
  const answer = {
    source: format.source,
    turns,
    metadata: format.metadata(head ? `${head}\n${text}` : text),
    cursor,
    history_id: id,
    version,
  };
  remember(answers, key, { version, answer }, 32);
  return answer;
}

// The whole output of one tool call, as { output, size } (output cut at
// TOOL_OUTPUT_MAX_CHARS, size its whole length), read from the file's end
// backwards a window at a time (the call is most likely recent), up to the
// store's scan limit. Null when nothing answers that id.
export async function transcriptToolOutput(format, store, path, toolId) {
  if (typeof toolId !== "string" || !TOOL_ID.test(toolId)) return null;
  const stat = await store.stat(path);
  if (!stat) throw new ConversationUnavailable("transcript_missing");
  const needle = format.toolNeedle(toolId);
  const lowest = Math.max(0, stat.size - store.maxToolScanBytes);
  let end = stat.size;
  // `carry`: the parts (in file order) from `end` on of the line that starts
  // before `end`; `skipping`: that line grew too long to keep, so it is passed over
  let carry = [];
  let carried = 0;
  let skipping = false;
  while (end > lowest) {
    const start = Math.max(lowest, end - store.windowBytes);
    const chunk = await store.read(path, start, end - start);
    let body;
    if (skipping) {
      const newline = chunk.lastIndexOf(0x0a);
      if (newline === -1) { end = start; continue; }
      body = chunk.subarray(0, newline);
      skipping = false;
    } else if (start > 0 && chunk.indexOf(0x0a) === -1) {
      // all of this chunk is inside one line: kept until the line's start is read
      carry.unshift(chunk);
      carried += chunk.length;
      if (carried > MAX_SCANNED_LINE_BYTES) { carry = []; carried = 0; skipping = true; }
      end = start;
      continue;
    } else {
      body = carry.length > 0 ? Buffer.concat([chunk, ...carry]) : chunk;
    }
    // below the file's start the first line is cut: it is finished by the next chunk
    const first = start === 0 ? -1 : body.indexOf(0x0a);
    const lines = splitLines(body.subarray(first + 1));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const output = outputInLine(format, lines[index], needle, toolId);
      if (output !== null) return { output: output.slice(0, TOOL_OUTPUT_MAX_CHARS), size: output.length };
    }
    carry = start === 0 || first === -1 ? [] : [body.subarray(0, first)];
    carried = carry[0]?.length ?? 0;
    if (carried > MAX_SCANNED_LINE_BYTES) { carry = []; carried = 0; skipping = true; }
    end = start;
  }
  return null;
}

function splitLines(buffer) {
  const lines = [];
  let offset = 0;
  while (offset <= buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    const stop = newline === -1 ? buffer.length : newline;
    if (stop > offset) lines.push(buffer.subarray(offset, stop));
    if (newline === -1) break;
    offset = newline + 1;
  }
  return lines;
}

function outputInLine(format, line, needle, toolId) {
  if (line.length === 0 || !line.includes(needle)) return null;
  let entry;
  try { entry = JSON.parse(line.toString("utf8")); } catch { return null; }
  return format.toolOutputIn(record(entry), toolId);
}

// Tests compare cold reads.
export function forgetConversationState() {
  states = new WeakMap();
}
