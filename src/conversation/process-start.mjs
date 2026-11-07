// When a pane's agent process started, from Linux's /proc: a session found
// only by a guess (the folder's newest) that was last written before the
// agent started belongs to an earlier run, not to the conversation it shows.
//
// /proc/<pid>/stat's 22nd field is the start in clock ticks after boot, and
// /proc/stat's btime the boot in seconds since the epoch. Linux reports both
// with USER_HZ ticks, 100 a second on every architecture it supports.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const USER_HZ = 100;
// fields after the process name's closing parenthesis start at field 3
const STARTTIME_AFTER_NAME = 22 - 3;

// `startedAt(pids)`: the earliest start, in ms since the epoch, of the pids
// that can be read; null when none can (no /proc, gone, not numbers).
export function processStartedAt({ procRoot = "/proc", ticksPerSecond = USER_HZ } = {}) {
  async function bootMs() {
    try {
      const match = /^btime (\d+)$/mu.exec(await readFile(join(procRoot, "stat"), "utf8"));
      return match ? Number(match[1]) * 1000 : null;
    } catch {
      return null;
    }
  }
  async function ticksOf(pid) {
    try {
      const text = await readFile(join(procRoot, String(pid), "stat"), "utf8");
      // the name may hold spaces and parentheses: the fields follow its last ")"
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[STARTTIME_AFTER_NAME]);
      return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
    } catch {
      return null;
    }
  }
  return async (pids) => {
    const valid = (Array.isArray(pids) ? pids : []).filter((pid) => Number.isSafeInteger(pid) && pid > 1);
    if (valid.length === 0) return null;
    const ticks = (await Promise.all(valid.map(ticksOf))).filter((value) => value !== null);
    if (ticks.length === 0) return null;
    const boot = await bootMs();
    return boot === null ? null : boot + Math.round((Math.min(...ticks) * 1000) / ticksPerSecond);
  };
}
