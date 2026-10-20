// The version of the OpenCode a pane runs now, told by its running program:
// the session's own record (session.version) is the version that created it
// and stays so when a newer OpenCode carries it on (-c, a session switch).
//
// On Linux a process's program is /proc/<pid>/exe, the file it was started
// from even once an update replaced it on disk; that program is asked
// `--version` (about a second and a half), once per program file (its device,
// inode, size and change time). Where there is no /proc (macOS), or the
// program cannot tell, there is no answer: the caller falls back to the
// session's record.
import { execFile } from "node:child_process";
import { readlink, stat } from "node:fs/promises";

// What `opencode --version` prints: a version, nothing else.
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
// An OpenCode program's file name; a path /proc shows for a program replaced
// on disk ends in " (deleted)".
const OPENCODE_EXE_RE = /(?:^|\/)opencode(?: \(deleted\))?$/u;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_PROGRAMS = 16;

function runVersion(file) {
  return new Promise((resolve) => {
    execFile(file, ["--version"], { timeout: VERSION_TIMEOUT_MS, maxBuffer: 4_096, windowsHide: true }, (error, stdout) => {
      const version = error ? "" : String(stdout).trim();
      resolve(VERSION_RE.test(version) ? version : null);
    });
  });
}

// `pids`: the pane's foreground processes; the first whose program is an
// OpenCode one answers. `fs` and `run` are for tests.
export function opencodeRunningVersion({ fs = { readlink, stat }, run = runVersion } = {}) {
  // program identity -> Promise<version | null>
  const known = new Map();
  return async function runningVersion(pids) {
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const exe = `/proc/${pid}/exe`;
      let target;
      let info;
      try {
        target = await fs.readlink(exe);
        info = await fs.stat(exe);
      } catch {
        continue;
      }
      if (!OPENCODE_EXE_RE.test(target)) continue;
      const key = `${info.dev}\0${info.ino}\0${info.size}\0${info.ctimeMs}`;
      let version = known.get(key);
      if (!version) {
        version = run(exe);
        known.set(key, version);
        // a program that could not tell will not tell next time either
        if (known.size > MAX_PROGRAMS) known.delete(known.keys().next().value);
      }
      return await version;
    }
    return null;
  };
}
