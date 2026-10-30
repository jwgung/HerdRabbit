// Where a transcript's bytes come from: this machine's files. A store answers
// these calls, so pages.mjs, claude.mjs and codex.mjs read through it:
//   locate(session, projectDirs) -> a Claude transcript's path | null
//   backgroundJobSession(short)  -> the session of Claude's background job
//                                   with that short id | null (optional)
//   stat(path)                   -> { identity, size, mtimeMs } | null
//   read(path, start, length)    -> Buffer (at most `length` bytes)
//   codex                        -> where Codex rollouts are (codex.mjs's
//                                   locateCodexRollout lists the calls)
//   opencode                     -> OpenCode's database (opencode.mjs's
//                                   localOpencodeStore), a store of its own
// plus the limits a page read keeps to on that store.
import { open, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { JOB_SHORT_ID, SESSION_ID } from "./claude.mjs";
import { THREAD_ID } from "./codex.mjs";
import { SESSION_ID as KIRO_SESSION_ID } from "./kiro.mjs";
import { defaultAgyDataDir, localAgyStore } from "./agy.mjs";
import { defaultOpencodeDb, localOpencodeStore } from "./opencode.mjs";

const MiB = 1024 * 1024;
// How many project folders a scan looks into at once.
const SCAN_CONCURRENCY = 8;
// A background job's state file is a few kilobytes; a larger one is not read.
const MAX_JOB_STATE_BYTES = 256 * 1024;

// This machine: the newest page reads up to 4 MiB, an older page widens to
// 16 MiB for one long turn, a tool's output is looked for in the last 64 MiB.
export const LOCAL_LIMITS = Object.freeze({ windowBytes: 4 * MiB, maxPageBytes: 16 * MiB, maxToolScanBytes: 64 * MiB });

// The store this server's own Claude writes: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
export function defaultClaudeConfigDir(environment = process.env, home = homedir()) {
  const configured = environment.CLAUDE_CONFIG_DIR;
  return configured && isAbsolute(configured) ? configured : join(home, ".claude");
}

// The store this server's own Codex writes: `$CODEX_HOME`, else `~/.codex`.
export function defaultCodexHome(environment = process.env, home = homedir()) {
  const configured = environment.CODEX_HOME;
  return configured && isAbsolute(configured) ? configured : join(home, ".codex");
}

// Where this server's own Kiro writes its sessions: `$KIRO_CONFIG_DIR`, else
// `~/.kiro`. Transcripts sit under `<dir>/sessions/<workspace hash>/sess_<uuid>/`.
export function defaultKiroConfigDir(environment = process.env, home = homedir()) {
  const configured = environment.KIRO_CONFIG_DIR;
  return configured && isAbsolute(configured) ? configured : join(home, ".kiro");
}

// Only an absent path is a miss: an unreadable store is an error to report, not an empty one.
function absent(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function isFile(path, statFile = stat) {
  try { return (await statFile(path)).isFile(); } catch (error) { if (absent(error)) return false; throw error; }
}

// `statFile`: how a candidate file is looked at (a test counts the calls).
export function localTranscriptStore({ configDir = defaultClaudeConfigDir(), codexHome = defaultCodexHome(), opencodeDb = defaultOpencodeDb(), kiroConfigDir = defaultKiroConfigDir(), agyDataDir = defaultAgyDataDir(), procRoot = "/proc", limits = LOCAL_LIMITS, statFile = stat } = {}) {
  const projects = join(configDir, "projects");
  // session id -> the file a project scan found it in; checked again on every use
  const found = new Map();
  return {
    key: "local",
    remote: false,
    configDir,
    codexHome,
    codex: localCodexFiles(codexHome),
    opencode: localOpencodeStore({ path: opencodeDb }),
    kiro: localKiroStore(kiroConfigDir, { procRoot }),
    agy: localAgyStore(agyDataDir),
    ...limits,
    async locate(session, projectDirs) {
      if (!SESSION_ID.test(session)) return null;
      const file = `${session}.jsonl`;
      for (const dir of projectDirs) {
        const path = join(projects, dir, file);
        if (await isFile(path, statFile)) return path;
      }
      const known = found.get(session);
      if (known !== undefined && await isFile(known, statFile)) return known;
      found.delete(session);
      // the pane's cwd need not be the one Claude started in: any project may hold the id
      let entries;
      try { entries = await readdir(projects); } catch (error) { if (absent(error)) return null; throw error; }
      // a few projects at a time, and no more once one holds it
      let next = 0;
      let hit = null;
      let failure = null;
      const worker = async () => {
        while (hit === null && next < entries.length) {
          const path = join(projects, entries[next++], file);
          try {
            if (await isFile(path, statFile) && hit === null) hit = path;
          } catch (error) {
            failure ??= error;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, entries.length) }, worker));
      if (hit !== null) {
        found.set(session, hit);
        if (found.size > 256) found.delete(found.keys().next().value);
        return hit;
      }
      if (failure) throw failure;
      return null;
    },
    // Claude keeps each background job's state in jobs/<short id>/state.json,
    // the job's whole session id among it.
    // The session each of these pids' Claude is on, by the registry Claude keeps
    // per process (<config>/sessions/<pid>.json): it follows /branch and /resume,
    // which herdr's hook report may not. Distinct ids; none for a pid without one.
    async sessionsOfPids(pids) {
      const ids = new Set();
      for (const pid of pids) {
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        try {
          const record = JSON.parse(await readFile(join(configDir, "sessions", `${pid}.json`), "utf8"));
          if (record?.pid === pid && typeof record.sessionId === "string" && SESSION_ID.test(record.sessionId)) ids.add(record.sessionId);
        } catch { /* a pid that is no Claude, or a file torn mid-write, names no session */ }
      }
      return [...ids];
    },
    async backgroundJobSession(short) {
      if (typeof short !== "string" || !JOB_SHORT_ID.test(short)) return null;
      const path = join(configDir, "jobs", short, "state.json");
      let text;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_JOB_STATE_BYTES) return null;
        text = await readFile(path, "utf8");
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
      let session;
      try { session = JSON.parse(text)?.sessionId; } catch { return null; }
      return typeof session === "string" && SESSION_ID.test(session) && session.startsWith(short) ? session : null;
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

// ---------------------------------------------------------------------------
// This machine's Codex rollouts, under `home` ($CODEX_HOME).

// Day folders a thread's file is looked for in, newest first, at most.
const MAX_DAY_FOLDERS = 400;
// How long a thread found in no day folder is not scanned for again.
const MISSED_SCAN_MS = 15_000;
// Threads of one directory a screen match compares, at most.
const MAX_CWD_THREADS = 8;
// Open files of one process looked at, at most.
const MAX_DESCRIPTORS = 512;

let sqlite;
// node:sqlite (Node 22.13+): without it the thread index is skipped.
function loadSqlite() {
  sqlite ??= import("node:sqlite").catch(() => null);
  return sqlite;
}

async function names(path) {
  try { return await readdir(path); } catch (error) { if (absent(error) || error?.code === "EACCES") return []; throw error; }
}

export function localCodexFiles(home) {
  const sessions = join(home, "sessions");
  // thread id -> the file a folder scan found it in; checked again on every use
  const found = new Map();
  // thread id -> until when only the newest day folders are looked in
  const missed = new Map();

  // The canonical path of a rollout inside sessions/, or null: a link out of
  // the store, another kind of file, or one that is gone.
  async function rollout(path) {
    if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl") || path.length > 4096) return null;
    try {
      const [root, file] = await Promise.all([realpath(sessions), realpath(path)]);
      if (!file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) || !file.endsWith(".jsonl")) return null;
      return (await stat(file)).isFile() ? file : null;
    } catch {
      return null;
    }
  }

  // Codex's thread index, read only: the newest state_<n>.sqlite. Null
  // without one, or without node:sqlite.
  async function threadIndex() {
    const versions = (await names(home)).flatMap((name) => {
      const match = /^state_(\d+)\.sqlite$/u.exec(name);
      return match ? [{ name, version: Number(match[1]) }] : [];
    }).sort((a, b) => b.version - a.version);
    if (versions.length === 0) return null;
    const module = await loadSqlite();
    if (!module?.DatabaseSync) return null;
    let db = null;
    try {
      db = new module.DatabaseSync(join(home, versions[0].name), { readOnly: true });
      const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('threads')").all().map((row) => row.name));
      if (!columns.has("id") || !columns.has("rollout_path")) { db.close(); return null; }
      return { db, columns };
    } catch {
      try { db?.close(); } catch { /* already unusable */ }
      return null;
    }
  }

  async function byName(thread) {
    const known = found.get(thread);
    if (known !== undefined && await rollout(known) !== null) return known;
    found.delete(thread);
    // a thread whose rollout is not written yet is looked for only in the
    // newest day folders for a while, where a new rollout appears, not in
    // every day folder again on each locate
    const recentOnly = (missed.get(thread) ?? 0) > Date.now();
    const dayLimit = recentOnly ? 2 : MAX_DAY_FOLDERS;
    const suffix = `-${thread}.jsonl`;
    const days = [];
    for (const year of (await names(sessions)).filter((name) => /^\d{4}$/u.test(name)).sort().reverse()) {
      for (const month of (await names(join(sessions, year))).filter((name) => /^\d{2}$/u.test(name)).sort().reverse()) {
        for (const day of (await names(join(sessions, year, month))).filter((name) => /^\d{2}$/u.test(name)).sort().reverse()) {
          days.push(join(sessions, year, month, day));
          if (days.length >= dayLimit) break;
        }
        if (days.length >= dayLimit) break;
      }
      if (days.length >= dayLimit) break;
    }
    for (const day of days) {
      const name = (await names(day)).filter((entry) => entry.startsWith("rollout-") && entry.endsWith(suffix)).sort().at(-1);
      if (name === undefined) continue;
      const path = await rollout(join(day, name));
      if (path === null) continue;
      found.set(thread, path);
      if (found.size > 256) found.delete(found.keys().next().value);
      missed.delete(thread);
      return path;
    }
    if (!recentOnly) missed.set(thread, Date.now() + MISSED_SCAN_MS);
    if (missed.size > 256) missed.delete(missed.keys().next().value);
    return null;
  }

  return {
    home,
    rollout,
    // The rollout of a thread: by Codex's index, else by its file name.
    async thread(thread) {
      if (typeof thread !== "string" || !THREAD_ID.test(thread)) return null;
      const index = await threadIndex();
      if (index !== null) {
        try {
          const row = index.db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(thread);
          const path = typeof row?.rollout_path === "string" ? await rollout(row.rollout_path) : null;
          if (path !== null) return path;
        } catch { /* an index of another shape: the file name still tells */ }
        finally { index.db.close(); }
      }
      return byName(thread);
    },
    // The newest interactive threads begun in `cwd`, by Codex's index.
    async threadsIn(cwd) {
      if (typeof cwd !== "string" || !isAbsolute(cwd)) return [];
      const index = await threadIndex();
      if (index === null) return [];
      try {
        const { db, columns } = index;
        if (!columns.has("cwd")) return [];
        const where = ["cwd = ?"];
        if (columns.has("archived")) where.push("archived = 0");
        // subagents and `codex exec` runs share the directory but are never the TUI's conversation
        if (columns.has("agent_role")) where.push("agent_role IS NULL");
        if (columns.has("source")) where.push("source IN ('cli', 'vscode')");
        const order = columns.has("updated_at") ? " ORDER BY updated_at DESC" : "";
        const rows = db.prepare(`SELECT rollout_path FROM threads WHERE ${where.join(" AND ")}${order} LIMIT ${MAX_CWD_THREADS}`).all(cwd);
        const paths = [];
        for (const row of rows) {
          const path = typeof row.rollout_path === "string" ? await rollout(row.rollout_path) : null;
          if (path !== null) paths.push(path);
        }
        return paths;
      } catch {
        return [];
      } finally {
        index.db.close();
      }
    },
    // The rollouts the pane's own Codex processes hold open (Linux /proc).
    async openBy(pids) {
      const open = new Set();
      if (process.platform !== "linux") return open;
      for (const pid of pids) {
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        for (const descriptor of (await names(`/proc/${pid}/fd`)).slice(0, MAX_DESCRIPTORS)) {
          try {
            const target = await readlink(`/proc/${pid}/fd/${descriptor}`);
            if (!target.endsWith(".jsonl")) continue;
            const path = await rollout(target);
            if (path !== null) open.add(path);
          } catch { /* a descriptor may close while it is read */ }
        }
      }
      return open;
    },
  };
}

// ---------------------------------------------------------------------------
// This machine's Kiro sessions, under `<config>/sessions`.
//
// Kiro names a session's directory after the workspace it ran in:
// `sessions/<sha256(cwd) first 16 hex>/sess_<uuid>/messages.jsonl`. Herdr
// reports no Kiro session id. The pane's own Kiro process says which session it
// runs: one of its processes holds its log (`<config>/logs/<started>/kiro.log`)
// open, and the log names the session it loads. Without that (no /proc, or a
// process that has not logged yet), the newest `sess_` under the cwd's hash is
// the pane's, but only while no other Kiro pane works in the same folder.

const SESS_DIR = /^sess_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// The session a Kiro log line is about: the one a session/new or load names,
// or the conversation a later line belongs to.
const LOG_SESSION_RE = /(?:sessionId=|\\?"(?:sessionId|conversationId)\\?":\\?")sess_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/giu;
// How much of a log's end is read for the session it is on now.
const LOG_TAIL_BYTES = 256 * 1024;
// A process tree walked for its open log, at most.
const MAX_TREE = 64;
const MAX_KIRO_DESCRIPTORS = 512;

export function localKiroStore(configDir, { procRoot = "/proc" } = {}) {
  const sessions = join(configDir, "sessions");
  const logs = join(configDir, "logs");
  // The transcript of one session directory, or null when it has no messages file.
  async function transcriptOf(hash, sessionDir) {
    const path = join(sessions, hash, sessionDir, "messages.jsonl");
    try {
      const info = await stat(path);
      return info.isFile() ? { path, mtimeMs: info.mtimeMs } : null;
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  }
  // `pids` and the processes under them, breadth first: Kiro's log is held by
  // a worker a few levels below the kiro-cli herdr names.
  async function tree(pids) {
    const seen = new Set();
    const queue = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1);
    while (queue.length > 0 && seen.size < MAX_TREE) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const task of await names(join(procRoot, String(pid), "task"))) {
        let children = "";
        try { children = await readFile(join(procRoot, String(pid), "task", task, "children"), "utf8"); } catch { continue; }
        for (const child of children.split(/\s+/u)) {
          const value = Number(child);
          if (Number.isSafeInteger(value) && value > 1 && !seen.has(value)) queue.push(value);
        }
      }
    }
    return [...seen];
  }
  // The Kiro logs a process holds open, as paths under <config>/logs.
  async function heldLogs(pid) {
    const held = new Set();
    for (const descriptor of (await names(join(procRoot, String(pid), "fd"))).slice(0, MAX_KIRO_DESCRIPTORS)) {
      try {
        const target = await readlink(join(procRoot, String(pid), "fd", descriptor));
        if (target.startsWith(`${logs}${sep}`) && target.endsWith(`${sep}kiro.log`)) held.add(target);
      } catch { /* a descriptor may close while it is read */ }
    }
    return held;
  }
  // The session a log names last: the one its process is on now.
  async function lastSessionIn(path) {
    let handle;
    try {
      handle = await open(path, "r");
      const { size } = await handle.stat();
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return [...buffer.toString("utf8").matchAll(LOG_SESSION_RE)].at(-1)?.[1]?.toLowerCase() ?? null;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
  return {
    configDir,
    // The sessions these pids' Kiro runs, by the log one of their processes
    // holds open. Distinct ids; none without /proc or before Kiro has logged.
    async sessionsOfPids(pids) {
      const found = new Set();
      for (const pid of await tree(pids)) {
        for (const log of await heldLogs(pid)) {
          const session = await lastSessionIn(log);
          if (session !== null) found.add(session);
        }
      }
      return [...found];
    },
    // { session, hashes }: a reported session uuid (or null), and the workspace
    // hashes to look under, most specific first. Returns { session, path } for
    // the newest session with a transcript, or null when none is written yet.
    async locate({ session = null, hashes = [] } = {}) {
      for (const hash of hashes) {
        if (typeof hash !== "string" || !/^[0-9a-f]{16}$/u.test(hash)) continue;
        let entries;
        try {
          entries = await readdir(join(sessions, hash));
        } catch (error) {
          if (absent(error) || error?.code === "EACCES") continue;
          throw error;
        }
        const dirs = entries.filter((name) => SESS_DIR.test(name));
        // Herdr reported a session: only that one in this workspace is the pane's.
        if (session !== null && KIRO_SESSION_ID.test(session)) {
          const named = `sess_${session}`;
          if (!dirs.includes(named)) continue;
          const found = await transcriptOf(hash, named);
          if (found) return { session, path: found.path };
          continue;
        }
        // No reported session: the newest sess_ with a transcript is the pane's.
        let best = null;
        for (const dir of dirs) {
          const found = await transcriptOf(hash, dir);
          if (found && (best === null || found.mtimeMs > best.mtimeMs)) {
            best = { session: SESS_DIR.exec(dir)[1], path: found.path, mtimeMs: found.mtimeMs };
          }
        }
        if (best) return { session: best.session, path: best.path };
      }
      return null;
    },
  };
}
