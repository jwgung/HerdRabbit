// Where a transcript's bytes come from: this machine's files, or a Herdr
// machine's over its SSH connection (machine-files.mjs). Both answer the same
// four calls, so claude.mjs reads either the same way:
//   locate(session, projectDirs) -> path | null
//   stat(path)                   -> { identity, size, mtimeMs } | null
//   read(path, start, length)    -> Buffer (at most `length` bytes)
// plus the limits a page read keeps to on that store.
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SESSION_ID } from "./claude.mjs";

const MiB = 1024 * 1024;

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

// Only an absent path is a miss: an unreadable store is an error to report, not an empty one.
function absent(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch (error) { if (absent(error)) return false; throw error; }
}

export function localTranscriptStore({ configDir = defaultClaudeConfigDir(), limits = LOCAL_LIMITS } = {}) {
  const projects = join(configDir, "projects");
  // session id -> the file a project scan found it in; checked again on every use
  const found = new Map();
  return {
    key: "local",
    remote: false,
    configDir,
    ...limits,
    async locate(session, projectDirs) {
      if (!SESSION_ID.test(session)) return null;
      const file = `${session}.jsonl`;
      for (const dir of projectDirs) {
        const path = join(projects, dir, file);
        if (await isFile(path)) return path;
      }
      const known = found.get(session);
      if (known !== undefined && await isFile(known)) return known;
      found.delete(session);
      // the pane's cwd need not be the one Claude started in: any project may hold the id
      let entries;
      try { entries = await readdir(projects); } catch (error) { if (absent(error)) return null; throw error; }
      const checks = await Promise.allSettled(entries.map(async (entry) => {
        const path = join(projects, entry, file);
        return await isFile(path) ? path : null;
      }));
      for (const check of checks) {
        if (check.status === "fulfilled" && check.value !== null) {
          found.set(session, check.value);
          if (found.size > 256) found.delete(found.keys().next().value);
          return check.value;
        }
      }
      const failed = checks.find((check) => check.status === "rejected");
      if (failed) throw failed.reason;
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
    stat: (path) => files.transcriptStat(path),
    read: (path, start, length) => files.readTranscriptRange(path, start, length),
  };
}
