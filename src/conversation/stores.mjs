// Where a transcript's bytes come from: this machine's files, or a Herdr
// machine's over its SSH connection (machine-files.mjs). Both answer the same
// calls, so pages.mjs, claude.mjs and codex.mjs read either the same way:
//   locate(session, projectDirs) -> a Claude transcript's path | null
//   stat(path)                   -> { identity, size, mtimeMs } | null
//   read(path, start, length)    -> Buffer (at most `length` bytes)
//   codex                        -> where Codex rollouts are (codex.mjs's
//                                   locateCodexRollout lists the calls)
// plus the limits a page read keeps to on that store.
import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { SESSION_ID } from "./claude.mjs";
import { THREAD_ID } from "./codex.mjs";

const MiB = 1024 * 1024;
// How many project folders a scan looks into at once.
const SCAN_CONCURRENCY = 8;

// This machine: the newest page reads up to 4 MiB, an older page widens to
// 16 MiB for one long turn, a tool's output is looked for in the last 64 MiB.
export const LOCAL_LIMITS = Object.freeze({ windowBytes: 4 * MiB, maxPageBytes: 16 * MiB, maxToolScanBytes: 64 * MiB });
// Over SSH every read is a round trip and its bytes cross the network.
export const REMOTE_LIMITS = Object.freeze({ windowBytes: 1 * MiB, maxPageBytes: 4 * MiB, maxToolScanBytes: 16 * MiB });

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

// Only an absent path is a miss: an unreadable store is an error to report, not an empty one.
function absent(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function isFile(path, statFile = stat) {
  try { return (await statFile(path)).isFile(); } catch (error) { if (absent(error)) return false; throw error; }
}

// `statFile`: how a candidate file is looked at (a test counts the calls).
export function localTranscriptStore({ configDir = defaultClaudeConfigDir(), codexHome = defaultCodexHome(), limits = LOCAL_LIMITS, statFile = stat } = {}) {
  const projects = join(configDir, "projects");
  // session id -> the file a project scan found it in; checked again on every use
  const found = new Map();
  return {
    key: "local",
    remote: false,
    configDir,
    codexHome,
    codex: localCodexFiles(codexHome),
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

// A Herdr machine's transcripts, through the fixed scripts in
// machine-files.mjs. `files` is that machine's MachineFiles.
export function machineTranscriptStore(serverId, files, { limits = REMOTE_LIMITS } = {}) {
  return {
    key: serverId,
    remote: true,
    ...limits,
    locate: (session, projectDirs) => files.locateClaudeTranscript(session, projectDirs),
    // a Herdr machine's Codex: the rollout herdr names, or the thread's by its
    // file name; its thread index and processes stay on the machine
    codex: {
      rollout: files.codexRollout ? (path) => files.codexRollout(path) : undefined,
      thread: files.locateCodexRollout ? (thread) => files.locateCodexRollout(thread) : undefined,
    },
    stat: (path) => files.transcriptStat(path),
    read: (path, start, length) => files.readTranscriptRange(path, start, length),
  };
}

// ---------------------------------------------------------------------------
// This machine's Codex rollouts, under `home` ($CODEX_HOME).

// Day folders a thread's file is looked for in, newest first, at most.
const MAX_DAY_FOLDERS = 400;
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
    try {
      const db = new module.DatabaseSync(join(home, versions[0].name), { readOnly: true });
      const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('threads')").all().map((row) => row.name));
      if (!columns.has("id") || !columns.has("rollout_path")) { db.close(); return null; }
      return { db, columns };
    } catch {
      return null;
    }
  }

  async function byName(thread) {
    const known = found.get(thread);
    if (known !== undefined && await rollout(known) !== null) return known;
    found.delete(thread);
    const suffix = `-${thread}.jsonl`;
    const days = [];
    for (const year of (await names(sessions)).filter((name) => /^\d{4}$/u.test(name)).sort().reverse()) {
      for (const month of (await names(join(sessions, year))).filter((name) => /^\d{2}$/u.test(name)).sort().reverse()) {
        for (const day of (await names(join(sessions, year, month))).filter((name) => /^\d{2}$/u.test(name)).sort().reverse()) {
          days.push(join(sessions, year, month, day));
          if (days.length >= MAX_DAY_FOLDERS) break;
        }
        if (days.length >= MAX_DAY_FOLDERS) break;
      }
      if (days.length >= MAX_DAY_FOLDERS) break;
    }
    for (const day of days) {
      const name = (await names(day)).filter((entry) => entry.startsWith("rollout-") && entry.endsWith(suffix)).sort().at(-1);
      if (name === undefined) continue;
      const path = await rollout(join(day, name));
      if (path === null) continue;
      found.set(thread, path);
      if (found.size > 256) found.delete(found.keys().next().value);
      return path;
    }
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
