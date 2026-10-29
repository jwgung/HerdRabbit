// An Antigravity CLI ("agy") pane's conversation, read from the step ledger
// agy writes to
// `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl`.
// Each line is one step, `{ step_index, type, status, created_at, content?,
// thinking?, tool_calls?, error? }`. Paging, cursors and tool output lookups
// are shared with Claude, Codex and Kiro (pages.mjs); this file is the agy
// format they read with, and the store that finds a pane's session.
//
// Unlike Kiro, agy gives a tool call and its result no shared id: a GENERIC
// result belongs to the tool call written before it, matched by order. The
// authority for which steps are live is the session's SQLite catalog
// (conversations/<uuid>.db); the store filters the ledger by it before it is
// read here (see localAgyStore). This parser trusts the text it is handed.
//
// Ported from ovis (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/ovis -- server/agy.ts (the step parser and the
// user-request unwrap) and server/agy-store.ts (the presence-lock session
// lookup). Rewritten for plain Node ESM; db reads go through node:sqlite.
import { record, setToolOutput, toolInputFields } from "./pages.mjs";
import { open, opendir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

const string = (value) => (typeof value === "string" ? value : "");

// agy wraps a user's prompt in `<USER_REQUEST>…</USER_REQUEST>` followed by
// `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` envelopes. The request is
// the part worth showing; an unknown shape is left whole rather than guessed.
export function agyUserText(text) {
  const value = string(text);
  if (!value.startsWith("<USER_REQUEST>")) return value;
  const close = value.lastIndexOf("</USER_REQUEST>");
  if (close < 0) return value;
  const suffix = value.slice(close + "</USER_REQUEST>".length);
  if (suffix.trim() !== "" && !/^\s*<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/u.test(suffix)) return value;
  return value.slice("<USER_REQUEST>".length, close).replace(/^\n/u, "").replace(/\n$/u, "");
}

// The one-line summary a collapsed tool row shows. agy's tool args are
// PascalCase; the common keys are mapped so the summary and the input read like
// the other agents'.
function mapArgs(args) {
  return { ...args, command: args.CommandLine, file_path: args.AbsolutePath ?? args.TargetFile };
}

function toolSummary(name, mapped) {
  const first = mapped.command ?? mapped.file_path ?? mapped.Query ?? mapped.Pattern ?? mapped.DirectoryPath ?? mapped.SearchDirectory;
  return typeof first === "string" ? first.replace(/\s+/gu, " ").trim().slice(0, 120) : name;
}

// Splits ledger text into turns. A USER_INPUT opens a user turn; a
// PLANNER_RESPONSE opens (or continues) an assistant turn with its thinking,
// text and tool calls; a GENERIC fills the output of the earliest tool call
// still waiting for one. Steps that are not DONE, and every other type, carry
// no turn text.
export function parseAgyTurns(text) {
  const turns = [];
  // tool parts still waiting for a result, oldest first (agy has no call id)
  const pending = [];

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
      continue; // a torn tail line while agy is mid-append, or any malformed line
    }
    if (entry === null || typeof entry !== "object" || entry.status !== "DONE") continue;
    const type = entry.type;
    const ts = typeof entry.created_at === "string" ? entry.created_at : null;

    if (type === "USER_INPUT") {
      const request = agyUserText(entry.content);
      if (request.trim().length === 0) continue;
      turns.push({ role: "user", ts, parts: [{ kind: "text", text: request }] });
      pending.length = 0; // a new prompt: no earlier call still expects a result
      continue;
    }

    if (type === "GENERIC") {
      const content = string(entry.content);
      if (content.length === 0) continue;
      const tool = pending.shift();
      if (tool === undefined) continue; // a result with no open call: nothing to attach it to
      setToolOutput(tool, content);
      continue;
    }

    if (type !== "PLANNER_RESPONSE") continue; // ERROR_MESSAGE, SYSTEM_MESSAGE, CHECKPOINT …

    const turn = assistantTurn(ts);
    if (ts) turn.end_ts = ts;
    const thinking = string(entry.thinking);
    if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
    const content = string(entry.content);
    if (content.length > 0) turn.parts.push({ kind: "text", text: content });
    const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
    for (const raw of calls) {
      const call = record(raw);
      if (typeof call.name !== "string") continue;
      const args = record(call.args);
      const mapped = mapArgs(args);
      const part = {
        kind: "tool",
        id: null,
        name: call.name,
        summary: toolSummary(call.name, mapped),
        ...toolInputFields(JSON.stringify(args, null, 2)),
        output: "",
      };
      turn.parts.push(part);
      pending.push(part);
    }
  }

  return { turns: turns.filter((turn) => turn.parts.length > 0) };
}

export function parseAgyTranscript(text) {
  return parseAgyTurns(text).turns;
}

// ---------------------------------------------------------------------------
// Metadata. agy's ledger names no model per step in a stable field; the chat
// shows none until there is a reliable source.
export function parseAgyMetadata() {
  return { model: null, reasoning_effort: null };
}

// ---------------------------------------------------------------------------
// Where pages start, and where a tool's output is.

const TURN_MARK = Buffer.from('"USER_INPUT"');

// Offsets (into `bytes`) of the lines that open a turn: each USER_INPUT that is
// DONE. agy has no separate turn-start record, so the prompt line is the start.
export function agyTurnStarts(bytes) {
  const starts = [];
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(offset, end);
    if (line.includes(TURN_MARK)) {
      let entry = null;
      try { entry = JSON.parse(line.toString("utf8")); } catch { /* a cut or torn line opens nothing */ }
      if (entry?.type === "USER_INPUT" && entry.status === "DONE") starts.push(offset);
    }
    offset = end + 1;
  }
  return starts;
}

// agy results carry no id, so a tool's whole output cannot be fetched by one.
// The page's inline preview is all there is; the lookup finds nothing.
function agyToolOutputIn() {
  return null;
}

// The agy transcript format pages.mjs reads with.
export const AGY_TRANSCRIPT = Object.freeze({
  source: "agy-transcript",
  turnStarts: agyTurnStarts,
  parse: parseAgyTurns,
  metadata: parseAgyMetadata,
  headBytes: 0,
  toolNeedle: () => null,
  toolOutputIn: agyToolOutputIn,
});

// ---------------------------------------------------------------------------
// Where the transcript is, and how the pane's session is found.
//
// agy opens one presence lock per live session,
// `<root>/presence/<uuid>.lock`, and holds it open for as long as it runs. The
// session a pane shows is the one its agy process holds a lock on; the
// transcript sits beside it under `<root>/brain/<uuid>/`.

const LOCK = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
const MAX_DESCRIPTORS = 512;

// Whether a foreground process is agy, by its program name. herdr reports a
// process with a `name` (and sometimes argv); agy runs as `agy`.
export function isAgyProcess(process) {
  const name = typeof process?.name === "string" ? process.name : "";
  if (name === "agy") return true;
  const argv = Array.isArray(process?.argv) ? process.argv : [];
  const first = typeof argv[0] === "string" ? argv[0] : "";
  return /(?:^|[\\/])agy$/u.test(first);
}

// Where agy keeps its data: `$ANTIGRAVITY_APP_DATA_DIR`, else
// `~/.gemini/antigravity-cli`.
export function defaultAgyDataDir(environment = process.env, home = homedir()) {
  const configured = environment.ANTIGRAVITY_APP_DATA_DIR;
  return configured && isAbsolute(configured) ? configured : join(home, ".gemini", "antigravity-cli");
}

// The transcript a session's ledger is written to.
function agyTranscriptPath(root, session) {
  return join(root, "brain", session, ".system_generated", "logs", "transcript_full.jsonl");
}

// The one session a set of open file paths names, or null: exactly one of them
// must be a presence lock (`<root>/presence/<uuid>.lock`). Other open files the
// process holds are ignored; no lock, or more than one, is not a session.
export function agyStoreFromLocks(paths) {
  const locks = [];
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path)) continue;
    if (basename(dirname(path)) !== "presence") continue;
    const match = LOCK.exec(basename(path));
    if (match) locks.push({ path, session: match[1] });
  }
  if (locks.length !== 1) return null;
  const { path, session } = locks[0];
  const root = dirname(dirname(path));
  return { root, session, path: agyTranscriptPath(root, session) };
}

function absent(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

// This machine's agy sessions, under `dataDir`. The transcript is read as a
// plain growing JSONL file (pages.mjs pages it like the others). agy's ledger
// is a lossy subset of the SQLite catalog — it may omit steps a rewind retired
// but never shows a step that is not live — so reading it directly shows the
// conversation without the catalog; filtering by the catalog is a later
// refinement, not a correctness fix here.
export function localAgyStore(dataDir = defaultAgyDataDir()) {
  // The presence locks a set of pids hold open (Linux /proc), as canonical
  // paths. macOS/Windows have no /proc; there a pane mirrors instead.
  async function heldLocks(pids) {
    const held = new Set();
    if (process.platform !== "linux") return held;
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      let dir;
      try {
        dir = await opendir(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      let count = 0;
      for await (const entry of dir) {
        if (count++ >= MAX_DESCRIPTORS) break;
        try {
          const target = await readlink(`/proc/${pid}/fd/${entry.name}`);
          if (!target.endsWith(".lock")) continue;
          const canonical = await realpath(target);
          if (LOCK.test(basename(canonical)) && basename(dirname(canonical)) === "presence") held.add(canonical);
        } catch { /* a descriptor may close while it is read */ }
      }
    }
    return held;
  }

  return {
    dataDir,
    // { pids }: the pane's foreground agy process ids. Returns { session, path }
    // for the session the one presence lock names, or null when none or many.
    async locate({ pids = [] } = {}) {
      const store = agyStoreFromLocks([...(await heldLocks(pids))]);
      if (!store) return null;
      try {
        const info = await stat(store.path);
        if (!info.isFile()) return null;
      } catch (error) {
        if (absent(error)) return { session: store.session, path: null };
        throw error;
      }
      return { session: store.session, path: store.path };
    },
    async stat(path) {
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        return { identity: `${info.dev.toString(36)}-${info.ino.toString(36)}`, size: info.size, mtimeMs: info.mtimeMs };
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    },
    async read(path, start, length) {
      if (length <= 0) return Buffer.alloc(0);
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buffer.subarray(0, filled);
      } finally {
        await handle.close();
      }
    },
  };
}
