// Files on a Herdr SSH machine, which has no HerdRabbit of its own. Each call
// runs one small fixed shell script over the machine's existing SSH master
// connection and answers in the same shapes, with the same errors, as this
// machine's own browser (file-browser.mjs) and uploads folder (file-store.mjs).
//
// What the request chooses (paths, names) never becomes part of a script: the
// script text is constant and every value travels as its own positional
// argument, quoted once for the remote shell that ssh hands the command to.
// Output comes back NUL-separated, so a name may hold any byte but NUL.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { InputValidationError } from "./herdr-client.mjs";
import { FileAccessError, MAX_LISTED_ENTRIES, UNKNOWN_SIZE_STREAM_BYTES, fileAccessError, protectedPathError, validateBrowsePath } from "./file-browser.mjs";
import { credentialRules, protectedPaths } from "./protected-paths.mjs";
import { TEMPORARY_PREFIX, safeTransferName, splitExtension, validateTransferName } from "./file-store.mjs";
import { parseByteRange } from "../public/file-preview.js";

// The uploads folder sits where this machine keeps its own, under the remote $HOME.
// How long a file read may send nothing before it is given up.
const READ_IDLE_MS = 30_000;
// How long a download may sit with the browser not taking any bytes before it is ended.
const STALLED_CLIENT_MS = 10 * 60_000;
const UPLOADS_UNDER_HOME = ".local/share/herdrabbit/files";
const MAX_LISTING_OUTPUT = 16 * 1024 * 1024;
const MAX_SMALL_OUTPUT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 20_000;
// After the last byte of an upload went out, what is left is a rename.
const UPLOAD_FINISH_MS = 60_000;
// How long a call waits for one of the machine's slots before giving up.
const SLOT_WAIT_MS = 15_000;
// The machine's sshd caps sessions per connection (MaxSessions, 10 by
// default), and the master already carries Herdr's own. Short commands and
// streams get separate budgets so a few long downloads never block a listing.
const MAX_COMMANDS = 3;
const MAX_STREAMS = 5;
// Without a master the client would open a login of its own; this proxy
// command makes that fallback fail at once instead. A multiplexed session
// never runs it.
const SSH_OPTIONS = ["-T", "-o", "ControlMaster=no", "-o", "ProxyCommand=false"];

// Exit codes the scripts below use for what local file calls report as errno.
const EXIT_ERRNO = new Map([[64, "ENOENT"], [65, "ENOTDIR"], [66, "EACCES"], [67, "ENXIO"]]);
const EXIT_TOOLS = 68;
const EXIT_INCOMPLETE = 69;
const EXIT_WRITE = 70;
const EXIT_NAMES = 71;

// GNU find's -printf is what every listing stands on; BusyBox and BSD find lack it.
const PRELUDE = `LC_ALL=C; export LC_ALL
command -v find >/dev/null 2>&1 && find / -maxdepth 0 -printf "" >/dev/null 2>&1 || exit ${EXIT_TOOLS}
`;

// $1: an absolute folder. The physical path, the folder's own time, then each
// entry as lstat sees it and, for links, what they point at.
const LIST_SCRIPT = `${PRELUDE}[ -e "$1" ] || exit 64
[ -d "$1" ] || exit 65
cd -P -- "$1" 2>/dev/null && [ -r . ] || exit 66
printf "D\\0%s\\0" "$PWD"
find . -maxdepth 0 -printf "M\\0%T@\\0"
find . -mindepth 1 -maxdepth 1 -printf "E\\0%P\\0%y\\0%s\\0%T@\\0" 2>/dev/null
find -L . -mindepth 1 -maxdepth 1 -xtype l -printf "L\\0%P\\0%y\\0%s\\0%T@\\0" 2>/dev/null
exit 0
`;

// Each argument a folder; for each, its time and entry count, or X.
const FINGERPRINT_SCRIPT = `${PRELUDE}for d in "$@"; do
  if cd -P -- "$d" 2>/dev/null && [ -r . ]; then
    m=$(find . -maxdepth 0 -printf "%T@")
    n=$(find . -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d " ")
    r=$(pwd -P; echo x); r=\${r%??}
    printf "F\\0%s\\0%s\\0%s\\0" "$m" "$n" "$r"
  else
    printf "X\\0\\0\\0\\0"
  fi
done
`;

const HOME_SCRIPT = `printf "%s" "$HOME"
`;

// $1: a path; $2: "follow" or "nofollow" (an upload is never a link). Its
// size, then its real path, which is what is checked against the protected ones.
const STAT_SCRIPT = `${PRELUDE}if [ "$2" = nofollow ] && [ -L "$1" ]; then exit 64; fi
[ -e "$1" ] || exit 64
[ -f "$1" ] || exit 67
[ -r "$1" ] || exit 66
find -L "$1" -maxdepth 0 -printf "%s\\0"
readlink -zf -- "$1" || exit 68
`;

// Each argument's real path, as far as it exists: where the machine's keys
// and settings really are.
const RESOLVE_SCRIPT = `LC_ALL=C; export LC_ALL
readlink -zm -- "$@" || exit 68
`;

// $1: a path; $2: "+<first byte, from 1>"; $3: how many bytes; $4 as above.
// The regular-file test is repeated: the file may have changed since it was sized.
const READ_SCRIPT = `LC_ALL=C; export LC_ALL
if [ "$4" = nofollow ] && [ -L "$1" ]; then exit 64; fi
[ -f "$1" ] || exit 67
tail -c "$2" -- "$1" | head -c "$3"
`;

// $1: the uploads folder. Its regular files, as lstat sees them.
const UPLOADS_SCRIPT = `${PRELUDE}[ -d "$1" ] || exit 0
find "$1/" -mindepth 1 -maxdepth 1 -type f -printf "E\\0%f\\0%s\\0%T@\\0" 2>/dev/null
exit 0
`;

// $1: the uploads folder; $2: a temporary name; $3/$4: the name's stem and
// extension; $5: the declared size. The body arrives on stdin into the
// temporary file, which only becomes a stored file when every declared byte
// came: a connection cut short ends stdin early, and the partial file goes.
// A hard link claims the name without replacing a file already there.
// Temporary files a dropped connection stranded are cleared after a day.
const SAVE_SCRIPT = `LC_ALL=C; export LC_ALL
umask 077
mkdir -p -- "$1" 2>/dev/null && [ -d "$1" ] || exit ${EXIT_WRITE}
find "$1/" -mindepth 1 -maxdepth 1 -name "${TEMPORARY_PREFIX}*" -type f -mmin +1440 -exec rm -f -- {} + 2>/dev/null
t="$1/$2"
set -C
if ! cat > "$t"; then rm -f -- "$t"; exit ${EXIT_WRITE}; fi
s=$(wc -c < "$t" | tr -d " ")
if [ "$s" != "$5" ]; then rm -f -- "$t"; exit ${EXIT_INCOMPLETE}; fi
i=1
while [ "$i" -le 100 ]; do
  if [ "$i" -eq 1 ]; then n="$3$4"; else n="$3-$i$4"; fi
  if [ ! -e "$1/$n" ] && [ ! -L "$1/$n" ]; then
    if ln -T -- "$t" "$1/$n" 2>/dev/null; then
      rm -f -- "$t"
      printf "%s\\0%s\\0" "$n" "$s"
      exit 0
    fi
    if [ ! -e "$1/$n" ] && [ ! -L "$1/$n" ]; then rm -f -- "$t"; exit ${EXIT_WRITE}; fi
  fi
  i=$((i + 1))
done
rm -f -- "$t"
exit ${EXIT_NAMES}
`;

// $1: a stored file in the uploads folder.
const REMOVE_SCRIPT = `LC_ALL=C; export LC_ALL
if [ -L "$1" ] || [ ! -f "$1" ]; then exit 64; fi
rm -f -- "$1" 2>/dev/null || exit 66
`;

// Claude Code transcripts (conversation/stores.mjs). $1: a session id (a
// UUID); the rest: project folder names ([A-Za-z0-9-] only). The first
// `<session>.jsonl` under one of those projects, else under any project,
// in the store an SSH command's Claude would use.
const LOCATE_TRANSCRIPT_SCRIPT = `LC_ALL=C; export LC_ALL
case "$CLAUDE_CONFIG_DIR" in /*) c=$CLAUDE_CONFIG_DIR ;; *) c=$HOME/.claude ;; esac
p=$c/projects
s=$1; shift
for d in "$@"; do
  if [ -f "$p/$d/$s.jsonl" ]; then printf "%s\\0" "$p/$d/$s.jsonl"; exit 0; fi
done
[ -d "$p" ] || exit 0
for f in "$p"/*/"$s.jsonl"; do
  if [ -f "$f" ]; then printf "%s\\0" "$f"; exit 0; fi
done
exit 0
`;

// Codex rollouts (conversation/codex.mjs), in the store an SSH command's
// Codex would use. $1: a thread id (a UUID). The newest
// sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl, links left out.
const LOCATE_CODEX_SCRIPT = `LC_ALL=C; export LC_ALL
case "$CODEX_HOME" in /*) h=$CODEX_HOME ;; *) h=$HOME/.codex ;; esac
[ -d "$h/sessions" ] || exit 0
f=$(find "$h/sessions" -mindepth 4 -maxdepth 4 -type f -name "rollout-*-$1.jsonl" 2>/dev/null | sort | tail -n 1)
[ -n "$f" ] && printf "%s\\0" "$f"
exit 0
`;

// $1: a rollout path herdr reported. Its physical path when it is a file
// (not a link) inside that store's sessions, else nothing.
const CODEX_ROLLOUT_SCRIPT = `LC_ALL=C; export LC_ALL
case "$CODEX_HOME" in /*) h=$CODEX_HOME ;; *) h=$HOME/.codex ;; esac
r=$(cd -P -- "$h/sessions" 2>/dev/null && pwd -P) || exit 0
d=$(cd -P -- "$(dirname -- "$1")" 2>/dev/null && pwd -P) || exit 0
p=$d/$(basename -- "$1")
if [ -L "$p" ] || [ ! -f "$p" ]; then exit 0; fi
case "$p" in "$r"/*) printf "%s\\0" "$p" ;; esac
exit 0
`;

// $1: a transcript. Its device, inode, size and time, or 64 when it is gone.
const TRANSCRIPT_STAT_SCRIPT = `${PRELUDE}[ -e "$1" ] || exit 64
[ -f "$1" ] || exit 67
find -L "$1" -maxdepth 0 -printf "%D\\0%i\\0%s\\0%T@\\0"
`;

// One read of a transcript is at most this much.
const MAX_TRANSCRIPT_READ = 4 * 1024 * 1024;
const TRANSCRIPT_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TRANSCRIPT_PROJECT = /^[A-Za-z0-9-]{1,255}$/u;

function transcriptPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || !path.endsWith(".jsonl") || path.length > 4096 ||
      /[\u0000-\u001f\u007f\\]/u.test(path)) {
    throw new FileAccessError(400, "invalid_path", "That transcript cannot be read on an SSH machine.");
  }
  return path;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// ssh joins everything after the destination into one line for the remote
// shell, so the script and each argument are quoted once, separately.
// A backslash is refused too: a login shell that is not sh-like (fish) reads
// it as an escape even inside single quotes, and one at the end of an argument
// would let the next argument out of its quotes.
export function remoteCommand(script, args = []) {
  for (const arg of args) {
    if (typeof arg !== "string" || /[\u0000\n\r]/u.test(arg)) {
      throw new FileAccessError(400, "invalid_path", "Enter an absolute path.");
    }
    if (arg.includes("\\")) {
      throw new FileAccessError(400, "invalid_path", "Paths with a backslash cannot be opened on an SSH machine.");
    }
  }
  return ["sh", "-c", shellQuote(script), "herdrabbit", ...args.map(shellQuote)].join(" ");
}

function fields(buffer) {
  const parts = [];
  for (let start = 0, end; (end = buffer.indexOf(0, start)) !== -1; start = end + 1) parts.push(buffer.subarray(start, end));
  return parts;
}

// The same test file-browser.mjs makes: a name that does not survive the trip
// through UTF-8 cannot be used to reach the file again.
function decodeName(raw) {
  const name = raw.toString("utf8");
  return { name, readable: !name.includes("�") && Buffer.from(name, "utf8").equals(raw) };
}

// find's %T@ is seconds with a nanosecond fraction; Node's mtime is built from
// whole seconds and nanoseconds, rounded to the millisecond, and so is this.
function timeMs(seconds) {
  const match = /^(\d+)(?:\.(\d{1,9})\d*)?$/u.exec(String(seconds));
  if (!match) return null;
  return Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(9, "0")) / 1e6;
}

function isoTime(seconds) {
  const ms = timeMs(seconds);
  return ms === null ? null : new Date(Math.round(ms)).toISOString();
}

// Built the way file-browser.mjs builds its tag, from the folder's time and entry count.
function fingerprintOf(seconds, count) {
  return `${(timeMs(seconds) ?? 0).toString(36)}:${Number(count).toString(36)}`;
}

function kindOf(type) {
  if (type === "d") return "directory";
  if (type === "f") return "file";
  return "other";
}

const failed = () => new FileAccessError(502, "machine_files_failed", "That machine could not do this. Try again.");

// A slot budget that waits in line rather than refuse at once: a folder tree
// asks for several listings together, and losing one would fold it away.
function slots(max, busy) {
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      active -= 1;
    }
  };
  return async function acquire() {
    if (active < max) active += 1;
    else {
      await new Promise((resolve, reject) => {
        const entry = { resolve };
        entry.timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(busy());
        }, SLOT_WAIT_MS);
        entry.timer.unref?.();
        waiting.push(entry);
      });
    }
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  };
}

export class MachineFiles {
  // `link` returns the machine's connection once it is up, and throws the
  // machine's own "offline" error until then.
  constructor({ link, spawnProcess = spawn, maxBytes = Infinity, timeoutMs = COMMAND_TIMEOUT_MS, readIdleMs = READ_IDLE_MS, stalledClientMs = STALLED_CLIENT_MS }) {
    this.readIdleMs = readIdleMs;
    this.stalledClientMs = stalledClientMs;
    this.link = link;
    this.spawnProcess = spawnProcess;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.homes = new WeakMap();
    this.matchers = new WeakMap();
    this.commands = slots(MAX_COMMANDS, () => new FileAccessError(429, "browse_busy", "Too many folders are being read on that machine. Try again."));
    this.streams = slots(MAX_STREAMS, () => new FileAccessError(429, "too_many_downloads", "Too many files are moving to or from that machine. Try again."));
  }

  #ready() {
    try {
      return this.link();
    } catch (error) {
      if (error?.code !== "machine_offline") throw error;
      // Same words the sidebar shows, as a file error the routes already answer.
      throw Object.assign(new FileAccessError(503, "machine_offline", error.message), { connecting: error.connecting === true });
    }
  }

  #spawn(link, script, args, { input = false } = {}) {
    return this.spawnProcess(link.ssh, link.sshArgs(SSH_OPTIONS, remoteCommand(script, args)), {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
  }

  // Waits for a child to end, keeping at most `maxBytes` of its output; one
  // that says more, or takes longer, is ended and refused.
  #collect(child, { maxBytes = MAX_SMALL_OUTPUT, timeoutMs = this.timeoutMs, tooLarge = failed } = {}) {
    const control = {};
    const done = new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let stderr = "";
      let problem = null;
      const stop = (error) => {
        if (problem) return;
        problem = error;
        try { child.kill("SIGKILL"); } catch {}
      };
      control.arm = (ms) => {
        clearTimeout(control.timer);
        if (ms === null) return;
        control.timer = setTimeout(() => stop(new FileAccessError(504, "machine_timeout", "That machine did not answer in time.")), ms);
        control.timer.unref?.();
      };
      control.arm(timeoutMs);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) stop(tooLarge());
        else chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
      let settled = false;
      const settle = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(control.timer);
        if (problem || code === undefined) reject(problem ?? failed());
        else resolve({ code, stdout: Buffer.concat(chunks), stderr });
      };
      // ssh missing or not startable: there may be no "close" after this.
      child.once("error", () => settle(undefined));
      child.once("close", (code) => settle(code));
    });
    return Object.assign(done, control);
  }

  async #command(link, script, args, options = {}) {
    const release = await this.commands();
    try {
      const result = await this.#collect(this.#spawn(link, script, args), options);
      if (result.code !== 0) throw this.#exitError(result);
      return result.stdout;
    } finally {
      release();
    }
  }

  #exitError({ code, stderr = "" }) {
    const errno = EXIT_ERRNO.get(code);
    if (errno) return fileAccessError({ code: errno });
    if (code === EXIT_TOOLS || code === 127) {
      return new FileAccessError(501, "machine_tools_missing",
        "Files on this machine need a Linux shell with GNU find and coreutils there.");
    }
    if (code === EXIT_INCOMPLETE) return new InputValidationError("The upload did not arrive whole. Try again.");
    if (code === EXIT_NAMES) return new InputValidationError("Too many files share this name. Rename the file and try again.");
    if (code === EXIT_WRITE && /No space left/iu.test(stderr)) {
      return new InputValidationError("The disk is full. Delete some files and try again.");
    }
    if (code === EXIT_WRITE) return new FileAccessError(502, "write_failed", "The file could not be saved on that machine.");
    // ssh itself: the master went away under this call.
    if (code === 255) return new FileAccessError(503, "machine_offline", "The SSH connection to this machine stopped.");
    return failed();
  }

  async #home(link) {
    if (this.homes.has(link)) return this.homes.get(link);
    const home = (await this.#command(link, HOME_SCRIPT, [])).toString("utf8");
    if (!home.startsWith("/") || home.length > 4096 || /[\u0000-\u001f\u007f�]/u.test(home)) {
      throw new FileAccessError(502, "machine_files_failed", "That machine did not say where its home folder is.");
    }
    const resolved = posix.resolve(home);
    this.homes.set(link, resolved);
    return resolved;
  }

  // What the file browser never opens on that machine: its SSH and GPG keys,
  // its AI CLIs' sign-ins and any HerdRabbit settings under its home -- the
  // same list as here, at the default places (src/protected-paths.mjs). The
  // rules' real paths are asked for once per connection, so a key folder made
  // or linked on the machine after that is seen on the next connection.
  async #protected(link) {
    if (this.matchers.has(link)) return this.matchers.get(link);
    const home = await this.#home(link);
    const guard = protectedPaths(credentialRules({ home }), async (paths) => {
      const real = await this.#realPaths(link, paths);
      return new Map(paths.map((path, index) => [path, real[index]]));
    });
    const matcher = await guard.matcher();
    this.matchers.set(link, matcher);
    return matcher;
  }

  // Where each path really is on the machine (`readlink -m`), as written when
  // it cannot say.
  async #realPaths(link, paths) {
    const real = fields(await this.#command(link, RESOLVE_SCRIPT, paths)).map((part) => part.toString("utf8"));
    return paths.map((path, index) => (real[index]?.startsWith("/") ? real[index] : path));
  }

  async listDirectory(rawPath, { limit = MAX_LISTED_ENTRIES, prefix = "" } = {}) {
    const link = this.#ready();
    // No path is the machine's home.
    const requested = rawPath ? validateBrowsePath(rawPath) : await this.#home(link);
    const output = await this.#command(link, LIST_SCRIPT, [requested], {
      maxBytes: MAX_LISTING_OUTPUT,
      tooLarge: () => new FileAccessError(413, "folder_too_large", "That folder has too many entries to list here."),
    });
    const parts = fields(output);
    let directory = null;
    let folderTime = null;
    const lstats = [];
    const targets = new Map();
    for (let index = 0; index < parts.length;) {
      const tag = parts[index].toString("latin1");
      if (tag === "D" && index + 1 < parts.length) {
        directory = parts[index + 1].toString("utf8");
        index += 2;
      } else if (tag === "M" && index + 1 < parts.length) {
        folderTime = parts[index + 1].toString("latin1");
        index += 2;
      } else if ((tag === "E" || tag === "L") && index + 4 < parts.length) {
        const [raw, type, size, time] = parts.slice(index + 1, index + 5);
        const record = { raw, type: type.toString("latin1"), size: Number(size.toString("latin1")), time: time.toString("latin1") };
        if (tag === "E") lstats.push(record);
        else targets.set(raw.toString("latin1"), record);
        index += 5;
      } else {
        throw failed();
      }
    }
    if (!directory?.startsWith("/")) throw failed();
    const isProtected = await this.#protected(link);
    if (isProtected(directory)) throw protectedPathError();

    const all = lstats.map((record) => ({ ...decodeName(record.raw), record }));
    const wanted = prefix === ""
      ? all
      : all.filter(({ name }) => name.toLowerCase().startsWith(prefix.toLowerCase()));
    // Sorted before the cut, as file-browser.mjs does, so a clipped listing is
    // the first N by name.
    const names = wanted.sort((first, second) => (first.name < second.name ? -1 : 1));
    const visible = names.slice(0, limit);
    const entries = visible.map(({ name, readable, record }) => {
      const entry = { name, path: posix.resolve(directory, name), hidden: name.startsWith("."), readable };
      if (record.type !== "l") {
        const kind = kindOf(record.type);
        // As file-browser.mjs: named, and nothing more. A link's target is
        // not known here; opening it is refused by its real path instead.
        if (isProtected(entry.path)) return { ...entry, kind, readable: false, locked: true };
        return { ...entry, kind, size: kind === "file" ? record.size : null, modifiedAt: isoTime(record.time) };
      }
      const target = targets.get(record.raw.toString("latin1"));
      // A link the second pass could not follow is broken or loops.
      if (!target || target.type === "l" || target.type === "N") {
        return { ...entry, kind: "other", symlink: true, broken: true };
      }
      const kind = kindOf(target.type);
      return { ...entry, kind, size: kind === "file" ? target.size : null, modifiedAt: isoTime(target.time), symlink: true };
    });
    entries.sort((first, second) => {
      if (first.kind !== second.kind) return first.kind === "directory" ? -1 : 1;
      return first.name < second.name ? -1 : 1;
    });
    const parent = posix.dirname(directory);
    return {
      path: directory,
      parent: parent === directory ? null : parent,
      entries,
      truncated: names.length > visible.length,
      total: names.length,
      etag: folderTime === null ? undefined : fingerprintOf(folderTime, all.length),
    };
  }

  // Many folders in one round trip: the Files tab checks every open folder
  // every couple of seconds. A folder that cannot be read maps to null.
  async directoryFingerprints(rawPaths) {
    const link = this.#ready();
    const result = new Map();
    const checked = rawPaths.map((raw) => {
      try {
        return { raw, path: validateBrowsePath(raw) };
      } catch {
        return { raw, path: null };
      }
    });
    for (const { raw, path } of checked) if (path === null) result.set(raw, null);
    const candidates = checked.filter(({ path }) => path !== null);
    if (candidates.length === 0) return result;
    // Protected as written, or where it really leads (the script says where,
    // like listDirectory's real path), so a link to a key folder is no way in.
    const isProtected = await this.#protected(link);
    const valid = candidates.filter(({ raw, path }) => {
      if (!isProtected(path)) return true;
      result.set(raw, null);
      return false;
    });
    if (valid.length === 0) return result;
    const parts = fields(await this.#command(link, FINGERPRINT_SCRIPT, valid.map(({ path }) => path)));
    valid.forEach(({ raw }, index) => {
      const [tag, time, count] = parts.slice(index * 4, index * 4 + 4).map((part) => part?.toString("latin1"));
      const reads = tag === "F" && time && /^\d+$/u.test(count ?? "");
      result.set(raw, reads && !isProtected(parts[index * 4 + 3].toString("utf8")) ? fingerprintOf(time, Number(count)) : null);
    });
    return result;
  }

  async directoryFingerprint(rawPath) {
    const fingerprint = (await this.directoryFingerprints([rawPath])).get(rawPath);
    if (fingerprint === null || fingerprint === undefined) throw fileAccessError({ code: "ENOENT" });
    return fingerprint;
  }

  async #size(link, path, follow) {
    return (await this.#stat(link, path, follow)).size;
  }

  async #stat(link, path, follow) {
    const output = fields(await this.#command(link, STAT_SCRIPT, [path, follow ? "follow" : "nofollow"]));
    const size = Number(output[0]?.toString("latin1"));
    const real = output[1]?.toString("utf8");
    if (!Number.isSafeInteger(size) || size < 0 || !real?.startsWith("/")) throw failed();
    return { size, real };
  }

  // The bytes of one file, read as they are sent. The stream ends cleanly only
  // when the read on the machine did; destroying it ends the read there.
  // `exact`: the length is the size the caller announced. The shell only
  // reports how head ended, not tail, so a read that failed there (the file
  // changed, an I/O error) shows up as missing bytes and is an error, never a
  // short download sent as complete.
  async #read(link, path, start, length, follow, exact = false) {
    const release = await this.streams();
    let child;
    try {
      child = this.#spawn(link, READ_SCRIPT, [path, `+${start + 1}`, String(length), follow ? "follow" : "nofollow"]);
    } catch (error) {
      release();
      throw error;
    }
    const stream = new PassThrough();
    let ended = false;
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.stdout.pipe(stream, { end: false });
    // A read that stops sending (a hung network filesystem there) gives its
    // slot back instead of holding it until the browser gives up.
    let idle = null;
    let stalledSince = null;
    // The browser taking bytes lets the buffer drain, which is progress.
    stream.on("drain", () => { stalledSince = null; });
    const watch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        // Nothing arrives while the browser is the slow side (the buffer is
        // full and ssh's output is paused); that is a moving transfer, not a
        // hung read -- unless the browser has taken nothing for a long while.
        if (!ended && stream.writableNeedDrain) {
          const now = Date.now();
          if (stalledSince === null) stalledSince = now;
          if (now - stalledSince < this.stalledClientMs) { watch(); return; }
          stream.destroy(failed());
          return;
        }
        try { child.kill("SIGKILL"); } catch {}
      }, this.readIdleMs);
      idle.unref?.();
    };
    watch();
    let received = 0;
    child.stdout.on("data", (chunk) => { received += chunk.length; stalledSince = null; watch(); });
    const finish = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
      release();
      if (stream.destroyed) return;
      if (code === 0 && exact && received !== length) stream.destroy(failed());
      else if (code === 0) stream.end();
      else stream.destroy(code === null ? failed() : this.#exitError({ code, stderr }));
    };
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    stream.once("close", () => {
      if (!ended) {
        try { child.kill("SIGKILL"); } catch {}
      }
    });
    return stream;
  }

  async openFile(rawPath, { maxBytes = Infinity, rangeHeader = null } = {}) {
    const path = validateBrowsePath(rawPath);
    const link = this.#ready();
    const { size: stats, real } = await this.#stat(link, path, true);
    if ((await this.#protected(link))(real)) throw protectedPathError();
    if (stats > maxBytes) throw new FileAccessError(413, "file_too_large", "That file is too large to download here.");
    // As file-browser.mjs: a size of 0 may be a file that does not know its
    // own length, so it streams without one, capped.
    const size = stats > 0 ? stats : null;
    const range = size === null ? null : parseByteRange(rangeHeader, size);
    if (range?.unsatisfiable) {
      const error = new FileAccessError(416, "range_not_satisfiable", "That part of the file does not exist.");
      error.size = size;
      throw error;
    }
    const slice = range
      ? { start: range.start, end: range.end }
      : size === null ? { start: 0, end: Math.min(maxBytes, UNKNOWN_SIZE_STREAM_BYTES) - 1 } : { start: 0, end: size - 1 };
    // A file of unknown size (0) may end before the cap; any other read must
    // bring every byte it promised.
    const stream = await this.#read(link, path, slice.start, slice.end - slice.start + 1, true, size !== null);
    return {
      name: posix.basename(path),
      path,
      size,
      range,
      length: size === null ? null : slice.end - slice.start + 1,
      stream,
    };
  }

  async #uploadsDirectory(link) {
    return posix.join(await this.#home(link), UPLOADS_UNDER_HOME);
  }

  async uploadsDirectory() {
    return this.#uploadsDirectory(this.#ready());
  }

  // The rules FileStore lists by: names a person could not have meant, and
  // temporary ones, stay out.
  async listUploads() {
    const link = this.#ready();
    const directory = await this.#uploadsDirectory(link);
    const parts = fields(await this.#command(link, UPLOADS_SCRIPT, [directory], { maxBytes: MAX_LISTING_OUTPUT }));
    const files = [];
    for (let index = 0; index + 3 < parts.length; index += 4) {
      if (parts[index].toString("latin1") !== "E") throw failed();
      const { name, readable } = decodeName(parts[index + 1]);
      if (!readable || parts[index + 1].length > 255 || name.startsWith(TEMPORARY_PREFIX)) continue;
      if (/[\u0000-\u001f\u007f]/u.test(name)) continue;
      files.push({
        name,
        size: Number(parts[index + 2].toString("latin1")),
        modifiedAt: isoTime(parts[index + 3].toString("latin1")),
        path: posix.join(directory, name),
      });
    }
    return files.sort((first, second) => (first.name < second.name ? -1 : 1));
  }

  // Names reach here already decoded by the route; encoding again lets the
  // same check run without decoding a second time.
  #storedPath(directory, name) {
    let checked;
    try {
      checked = validateTransferName(encodeURIComponent(String(name)));
    } catch {
      throw new InputValidationError("Invalid file name");
    }
    return posix.join(directory, checked);
  }

  async openUpload(name) {
    const link = this.#ready();
    const path = this.#storedPath(await this.#uploadsDirectory(link), name);
    let size;
    try {
      size = await this.#size(link, path, false);
    } catch (error) {
      // As FileStore: anything that is not a stored file is not found.
      if (error instanceof FileAccessError && (error.code === "not_found" || error.code === "not_a_file")) {
        throw new InputValidationError("File not found");
      }
      throw error;
    }
    const stream = await this.#read(link, path, 0, size, false, true);
    return { name: posix.basename(path), path, size, range: null, length: size, stream };
  }

  async saveUpload(requestedName, source, { bytes } = {}) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new InputValidationError("Send the file size with the upload.");
    if (bytes > this.maxBytes) throw new InputValidationError("The file is larger than the upload limit.");
    const { stem, extension } = splitExtension(safeTransferName(requestedName));
    const link = this.#ready();
    const directory = await this.#uploadsDirectory(link);
    const release = await this.streams();
    try {
      const child = this.#spawn(link, SAVE_SCRIPT,
        [directory, `${TEMPORARY_PREFIX}${randomUUID()}`, stem, extension, String(bytes)], { input: true });
      // The body has no deadline of its own (the request has one); the rename after it does.
      const result = this.#collect(child, { timeoutMs: null });
      result.catch(() => {});
      let written = 0;
      const tooLarge = new InputValidationError("The file is larger than the upload limit.");
      const counter = new Transform({
        transform: (chunk, _encoding, callback) => {
          written += chunk.length;
          callback(written > this.maxBytes || written > bytes ? tooLarge : null, chunk);
        },
      });
      try {
        await pipeline(source, counter, child.stdin);
      } catch (error) {
        // A script that stopped first (say, on a full disk) closed its end and
        // says why itself. Otherwise the body broke off here: ending ssh ends
        // stdin there short, and the script drops the partial file.
        const scriptStopped = child.exitCode !== null || error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
        try { child.kill("SIGKILL"); } catch {}
        const outcome = await result.then((value) => value, () => null);
        if (scriptStopped && error !== tooLarge && outcome && outcome.code !== null && outcome.code !== 0) throw this.#exitError(outcome);
        throw error;
      }
      result.arm(UPLOAD_FINISH_MS);
      const outcome = await result;
      if (outcome.code !== 0) throw this.#exitError(outcome);
      const [rawName, rawSize] = fields(outcome.stdout);
      const { name, readable } = rawName ? decodeName(rawName) : { readable: false };
      if (!readable) throw failed();
      return {
        name,
        size: Number(rawSize?.toString("latin1") ?? written),
        modifiedAt: new Date().toISOString(),
        path: posix.join(directory, name),
      };
    } finally {
      release();
    }
  }

  async removeUpload(name) {
    const link = this.#ready();
    const path = this.#storedPath(await this.#uploadsDirectory(link), name);
    try {
      await this.#command(link, REMOVE_SCRIPT, [path]);
    } catch (error) {
      if (error instanceof FileAccessError && error.code === "not_found") throw new InputValidationError("File not found");
      throw error;
    }
  }

  // Where a Claude session's transcript is on the machine, or null.
  async locateClaudeTranscript(session, projectDirs = []) {
    if (typeof session !== "string" || !TRANSCRIPT_SESSION.test(session) ||
        !Array.isArray(projectDirs) || projectDirs.length > 8 || projectDirs.some((dir) => typeof dir !== "string" || !TRANSCRIPT_PROJECT.test(dir))) {
      throw new FileAccessError(400, "invalid_path", "That transcript cannot be looked up on an SSH machine.");
    }
    const link = this.#ready();
    const [raw] = fields(await this.#command(link, LOCATE_TRANSCRIPT_SCRIPT, [session, ...projectDirs]));
    if (!raw) return null;
    const path = raw.toString("utf8");
    // What comes back is used as an argument again: it must be the file asked for.
    try {
      transcriptPath(path);
    } catch {
      throw failed();
    }
    if (!path.endsWith(`/${session}.jsonl`) || !Buffer.from(path, "utf8").equals(raw)) throw failed();
    return path;
  }

  // Where a Codex thread's rollout is on the machine, or null.
  async locateCodexRollout(thread) {
    if (typeof thread !== "string" || !TRANSCRIPT_SESSION.test(thread)) {
      throw new FileAccessError(400, "invalid_path", "That rollout cannot be looked up on an SSH machine.");
    }
    const link = this.#ready();
    const [raw] = fields(await this.#command(link, LOCATE_CODEX_SCRIPT, [thread]));
    if (!raw) return null;
    const path = raw.toString("utf8");
    // what comes back is used as an argument again: it must be the file asked for
    try {
      transcriptPath(path);
    } catch {
      throw failed();
    }
    if (!path.endsWith(`-${thread}.jsonl`) || !Buffer.from(path, "utf8").equals(raw)) throw failed();
    return path;
  }

  // The rollout herdr reported for a Codex pane, as its physical path when it
  // lies in the machine's Codex sessions; null otherwise.
  async codexRollout(path) {
    let checked;
    try {
      checked = transcriptPath(path);
    } catch {
      return null;
    }
    const link = this.#ready();
    const [raw] = fields(await this.#command(link, CODEX_ROLLOUT_SCRIPT, [checked]));
    if (!raw) return null;
    const physical = raw.toString("utf8");
    try {
      transcriptPath(physical);
    } catch {
      throw failed();
    }
    if (!Buffer.from(physical, "utf8").equals(raw)) throw failed();
    return physical;
  }

  // A transcript's identity, size and time, or null when it is gone.
  async transcriptStat(path) {
    const checked = transcriptPath(path);
    const link = this.#ready();
    let output;
    try {
      output = fields(await this.#command(link, TRANSCRIPT_STAT_SCRIPT, [checked]));
    } catch (error) {
      if (error instanceof FileAccessError && error.code === "not_found") return null;
      throw error;
    }
    const [device, inode, size, time] = output.map((part) => part.toString("latin1"));
    const mtimeMs = timeMs(time);
    if (!/^\d+$/u.test(device ?? "") || !/^\d+$/u.test(inode ?? "") || !/^\d+$/u.test(size ?? "") || mtimeMs === null) throw failed();
    return {
      identity: `${BigInt(device).toString(36)}-${BigInt(inode).toString(36)}`,
      size: Number(size),
      mtimeMs,
    };
  }

  // Up to `length` bytes of a transcript from `start`, at most MAX_TRANSCRIPT_READ.
  async readTranscriptRange(path, start, length) {
    const checked = transcriptPath(path);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new FileAccessError(400, "invalid_range", "That part of the transcript cannot be read.");
    }
    const wanted = Math.min(length, MAX_TRANSCRIPT_READ);
    if (wanted === 0) return Buffer.alloc(0);
    const link = this.#ready();
    return this.#command(link, READ_SCRIPT, [checked, `+${start + 1}`, String(wanted), "follow"], { maxBytes: wanted });
  }

  // Kept so callers can treat every file client alike.
  hold() {}
  release() {}
}
