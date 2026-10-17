import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./http-basics.mjs";

// In-app update: whether main on origin has moved past this checkout, and
// running update.sh for it from the page. update.sh stays the one updater;
// this only asks the questions it would ask first, so the page can say why an
// update would stop before anyone presses the button, and starts it outside
// this service so the restart it ends with does not take it down too.

export const MAX_NOTES = 30;
export const MAX_NOTE_LENGTH = 200;
export const MAX_LOG_BYTES = 8 * 1024;
export const LOG_LINES = 40;
// A check this recent is the answer; the Check button may ask again sooner.
export const CHECK_REUSE_MS = 60_000;
export const FRESH_CHECK_REUSE_MS = 10_000;
const GIT_TIMEOUT_MS = 30_000;
const SYSTEMCTL_TIMEOUT_MS = 10_000;
// One start a minute, whoever asks: a run takes longer than that anyway.
export const RUN_INTERVAL_MS = 60_000;
const START_GRACE_MS = 10_000;
// The service units update.sh restarts, in the order it looks for them.
export const SERVICE_UNITS = ["herdrabbit.service", "herdr-web-local.service"];
// The only origins update.sh updates from.
export const OFFICIAL_ORIGINS = new Set([
  "https://github.com/ultivis-iot/HerdRabbit.git",
  "https://github.com/ultivis-iot/HerdRabbit",
  "git@github.com:ultivis-iot/HerdRabbit.git",
]);
export const RUN_STATES = new Set(["idle", "running", "succeeded", "failed"]);

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const SHA = /^[0-9a-f]{4,40}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/u;
const CODE = /^[a-z_]{1,32}$/u;
const UNIT = /^herdrabbit-update-[0-9]{1,20}$/u;

// execFile without a shell, answering { code, stdout } instead of throwing:
// a git command that says "no" (merge-base --is-ancestor) is an answer.
export function execCommand(file, args, { cwd, env, timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : -1) : 0, stdout: String(stdout ?? "") });
    });
  });
}

// What a connected PC (or a log) says, made fit for a line on the page:
// no control characters, bounded length.
function line(text, limit = MAX_NOTE_LENGTH) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, limit);
}

// A log is shown as it is, minus anything that would draw on the screen, and
// minus a user:password an URL might carry.
export function cleanLog(text) {
  const cleaned = String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1***@");
  const tail = cleaned.split("\n").slice(-LOG_LINES).join("\n");
  const bytes = Buffer.from(tail, "utf8");
  if (bytes.length <= MAX_LOG_BYTES) return tail;
  return bytes.subarray(bytes.length - MAX_LOG_BYTES).toString("utf8").replace(/^�+/u, "");
}

function revision(sha, version) {
  return {
    sha: typeof sha === "string" && SHA.test(sha) ? sha : null,
    version: typeof version === "string" && VERSION.test(version) ? version : null,
  };
}

const code = (value) => typeof value === "string" && CODE.test(value) ? value : null;
const time = (value) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;

// A check's answer as this PC passes it on: what a connected PC sent is held
// to exactly this, field by field, before a page sees it.
export function cleanCheck(value) {
  const answer = value && typeof value === "object" ? value : {};
  const latest = answer.latest && typeof answer.latest === "object" ? revision(answer.latest.sha, answer.latest.version) : null;
  return {
    checkedAt: time(answer.checkedAt),
    current: revision(answer.current?.sha, answer.current?.version),
    latest: latest && (latest.sha || latest.version) ? latest : null,
    available: answer.available === true,
    notes: (Array.isArray(answer.notes) ? answer.notes : []).slice(0, MAX_NOTES)
      .filter((note) => typeof note === "string").map((note) => line(note)).filter(Boolean),
    blocked: code(answer.blocked),
    error: code(answer.error),
  };
}

export function cleanRunStatus(value) {
  const status = value && typeof value === "object" ? value : {};
  return {
    state: RUN_STATES.has(status.state) ? status.state : "idle",
    startedAt: time(status.startedAt),
    finishedAt: time(status.finishedAt),
    exitCode: Number.isSafeInteger(status.exitCode) ? status.exitCode : null,
    reason: code(status.reason),
    log: typeof status.log === "string" ? cleanLog(status.log) : "",
    version: typeof status.version === "string" && VERSION.test(status.version) ? status.version : null,
  };
}

function properties(text) {
  const values = {};
  for (const entry of String(text).split("\n")) {
    const at = entry.indexOf("=");
    if (at > 0) values[entry.slice(0, at)] = entry.slice(at + 1).trim();
  }
  return values;
}

// The run's record, kept beside its log: written as "running" here before
// the run starts, and as its end by the run itself (runUpdateScript), which
// outlives this process.
// Files in the state folder are created by this process and never followed
// through a link someone else left there.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

async function writeFileSafely(path, content, flags) {
  const handle = await open(path, flags | fsConstants.O_WRONLY | fsConstants.O_CREAT | NOFOLLOW, 0o600);
  try {
    if (content) await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

// The state folder must be a real directory of this user, not a link.
async function checkStateDir(stateDir, { create = false } = {}) {
  const unsafe = () => new HttpError(500, "update_state_unsafe", "The update state folder is not safe to use.");
  if (create) await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let info;
  try {
    info = await lstat(stateDir);
  } catch {
    throw unsafe();
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe();
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw unsafe();
  if (create) await chmod(stateDir, 0o700);
}

async function writeRecord(stateDir, record) {
  const path = join(stateDir, "update-state.json");
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFileSafely(temporary, `${JSON.stringify(record)}\n`, fsConstants.O_EXCL);
  await rename(temporary, path);
}

async function readRecord(stateDir) {
  try {
    const record = JSON.parse(await readFile(join(stateDir, "update-state.json"), "utf8"));
    return record && typeof record === "object" && RUN_STATES.has(record.state) ? record : null;
  } catch {
    return null;
  }
}

async function readLogTail(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return cleanLog(buffer.toString("utf8"));
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

export class AppUpdater {
  #last = null;
  #checking = null;
  #starting = false;
  #lastStart = -Infinity;

  // `exec(file, args, options)` answers { code, stdout } (execCommand): git,
  // systemctl and systemd-run all go through it, so a test can stand in for
  // the service manager while git runs for real against a scratch repository.
  constructor({
    version, repository = REPOSITORY, stateDir, exec = execCommand, now = () => Date.now(),
    pid = process.pid, platform = process.platform, environment = process.env, nodeBin = process.execPath,
    originAllowed = (url) => OFFICIAL_ORIGINS.has(url),
  }) {
    if (!stateDir) throw new TypeError("stateDir is required");
    this.version = version;
    this.repository = repository;
    this.stateDir = stateDir;
    this.exec = exec;
    this.now = now;
    this.pid = pid;
    this.platform = platform;
    this.environment = environment;
    this.nodeBin = nodeBin;
    this.originAllowed = originAllowed;
    this.logFile = join(stateDir, "update.log");
  }

  #git(...args) {
    return this.exec("git", args, {
      cwd: this.repository,
      timeout: GIT_TIMEOUT_MS,
      env: { ...this.environment, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C" },
    });
  }

  #systemctl(...args) {
    return this.exec("systemctl", ["--user", ...args], { timeout: SYSTEMCTL_TIMEOUT_MS });
  }

  // update.sh restarts the first of SERVICE_UNITS that is loaded, and only
  // when it runs from the directory this is. This process has to be that
  // unit's main process too: a copy started by hand from the same checkout
  // would otherwise start an update that restarts someone else.
  async #isService() {
    if (this.platform !== "linux") return false;
    for (const unit of SERVICE_UNITS) {
      const { code: exit, stdout } = await this.#systemctl(
        "show", unit, "--property=LoadState", "--property=WorkingDirectory", "--property=MainPID",
      );
      // a unit systemctl cannot tell about is not this one; the next may be
      if (exit !== 0) continue;
      const values = properties(stdout);
      if (values.LoadState !== "loaded") continue;
      if (!values.WorkingDirectory) return false;
      const [directory, repository] = await Promise.all([
        realpath(values.WorkingDirectory).catch(() => null),
        realpath(this.repository).catch(() => null),
      ]);
      return directory !== null && directory === repository && Number(values.MainPID) === this.pid;
    }
    return false;
  }

  async #inspect() {
    const current = { sha: null, version: this.version ?? null };
    const answer = (fields) => ({
      checkedAt: new Date(this.now()).toISOString(), current, latest: null, available: false, notes: [],
      blocked: null, error: null, ...fields,
    });
    const head = await this.#git("rev-parse", "--short", "HEAD");
    if (head.code !== 0) return answer({ error: "not_git" });
    current.sha = head.stdout.trim();
    const [branch, status, origin, service] = await Promise.all([
      this.#git("branch", "--show-current"),
      this.#git("status", "--porcelain"),
      this.#git("remote", "get-url", "origin"),
      this.#isService(),
    ]);
    // The remote's address is compared and never repeated: it may carry a token.
    const officialOrigin = origin.code === 0 && this.originAllowed(origin.stdout.trim());
    // An address that is not the official one is never even reached: no
    // connection, no credential helper, nothing fetched from it.
    if (!officialOrigin) return answer({ blocked: "wrong_origin" });
    const fetched = await this.#git("fetch", "--quiet", "--no-tags", "origin", "main");
    const precondition = !service ? "not_service"
      : branch.stdout.trim() !== "main" ? "not_main"
        : status.code !== 0 || status.stdout.trim() !== "" ? "local_changes" : null;
    if (fetched.code !== 0) return answer({ blocked: precondition, error: "fetch_failed" });
    const latestSha = (await this.#git("rev-parse", "--short", "FETCH_HEAD")).stdout.trim();
    // Something on origin this checkout does not have.
    const available = (await this.#git("merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD")).code !== 0;
    const diverged = available && (await this.#git("merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD")).code !== 0;
    const notes = available
      ? (await this.#git("log", "--no-merges", "--format=%s", `--max-count=${MAX_NOTES}`, "HEAD..FETCH_HEAD")).stdout
        .split("\n").map((note) => line(note)).filter(Boolean)
      : [];
    let latestVersion = null;
    try {
      latestVersion = JSON.parse((await this.#git("show", "FETCH_HEAD:package.json")).stdout).version;
    } catch { /* shown without a version */ }
    return answer({
      latest: revision(latestSha, latestVersion),
      available,
      notes,
      blocked: precondition ?? (diverged ? "diverged" : null),
    });
  }

  // Coalesced: one look at origin at a time, and a recent one is the answer.
  // While an update runs nothing is fetched: update.sh owns FETCH_HEAD then.
  async check({ fresh = false } = {}) {
    const running = (await this.runStatus()).state === "running";
    const reuse = fresh ? FRESH_CHECK_REUSE_MS : CHECK_REUSE_MS;
    let result = this.#last?.result;
    if (!running && (!this.#last || this.now() - this.#last.at >= reuse)) {
      this.#checking ??= this.#inspect().then((value) => {
        this.#last = { at: this.now(), result: value };
        return value;
      }).finally(() => { this.#checking = null; });
      result = await this.#checking;
    }
    result ??= {
      checkedAt: null, current: { sha: null, version: this.version ?? null }, latest: null, available: false, notes: [],
      blocked: null, error: null,
    };
    return running ? { ...result, blocked: "running" } : result;
  }

  // The run as this PC's page and a hub see it: state, the end of its log,
  // and the version this process runs, which changes once the restart is done.
  runStatus() {
    return this.#status(false);
  }

  // `starting` is start() asking about an earlier run; otherwise a run being
  // started right now (its unit not yet created) is not an interrupted one.
  async #status(starting) {
    let record = await readRecord(this.stateDir);
    const settling = !starting && (this.#starting
      || this.now() - Date.parse(record?.startedAt ?? "") < START_GRACE_MS);
    if (record?.state === "running" && !settling) {
      const named = typeof record.unit === "string" && UNIT.test(record.unit);
      if (!named) {
        record = { ...record, state: "failed", reason: "interrupted", finishedAt: new Date(this.now()).toISOString() };
        await writeRecord(this.stateDir, record).catch(() => {});
      }
    }
    if (record?.state === "running" && !settling && typeof record.unit === "string" && UNIT.test(record.unit)) {
      // A run whose unit is gone without saying how it ended was cut short
      // (a reboot, a kill); it is not left "running" for ever.
      const { code: exit, stdout } = await this.#systemctl("is-active", record.unit);
      const state = stdout.trim();
      if (exit !== 0 && state !== "" && state !== "active" && state !== "activating" && state !== "deactivating") {
        const again = await readRecord(this.stateDir);
        if (again?.state === "running") {
          record = { ...again, state: "failed", reason: "interrupted", finishedAt: new Date(this.now()).toISOString() };
          await writeRecord(this.stateDir, record).catch(() => {});
        } else {
          record = again;
        }
      }
    }
    return {
      state: record?.state ?? "idle",
      startedAt: record?.startedAt ?? null,
      finishedAt: record?.finishedAt ?? null,
      exitCode: Number.isSafeInteger(record?.exitCode) ? record.exitCode : null,
      reason: code(record?.reason),
      log: record ? await readLogTail(this.logFile) : "",
      version: this.version ?? null,
    };
  }

  // Starts update.sh in a transient user unit of its own, so the service
  // restart it ends with does not stop it. Everything it is given is fixed
  // here: this checkout, this state folder, this Node.
  async start() {
    if (this.#starting) throw new HttpError(409, "update_running", "An update is already starting.");
    this.#starting = true;
    try {
      if ((await this.#status(true)).state === "running") {
        throw new HttpError(409, "update_running", "An update is already running.");
      }
      if (this.now() - this.#lastStart < RUN_INTERVAL_MS) {
        throw new HttpError(429, "too_many_requests", "An update was started a moment ago. Try again in a minute.");
      }
      // Asked again right before starting: what was true when the page loaded may not be now.
      this.#last = null;
      const check = await this.check();
      if (check.error) throw new HttpError(409, "update_check_failed", "Could not check origin for a new version.");
      if (!check.available) throw new HttpError(409, "up_to_date", "Already up to date.");
      if (check.blocked) throw new HttpError(409, "update_blocked", `This update cannot run here (${check.blocked}).`);
      const startedAt = new Date(this.now()).toISOString();
      const unit = `herdrabbit-update-${this.now()}`;
      await checkStateDir(this.stateDir, { create: true });
      try {
        await writeFileSafely(this.logFile, "", fsConstants.O_TRUNC);
      } catch {
        throw new HttpError(500, "update_state_unsafe", "The update log cannot be written safely.");
      }
      // The unit is named in the record only once systemd-run has made it.
      const record = { state: "running", unit: null, startedAt, finishedAt: null, exitCode: null, reason: null };
      await writeRecord(this.stateDir, record);
      // npm and node next to the Node this runs on, wherever the user's
      // manager would otherwise look for them.
      const path = [dirname(this.nodeBin), this.environment.PATH].filter(Boolean).join(":");
      const started = await this.exec("systemd-run", [
        "--user", `--unit=${unit}`, "--collect", "--quiet",
        `--property=WorkingDirectory=${this.repository}`,
        `--setenv=PATH=${path}`,
        this.nodeBin, join(this.repository, "scripts", "run-update.mjs"), this.stateDir,
      ], { timeout: SYSTEMCTL_TIMEOUT_MS });
      if (started.code !== 0) {
        await writeRecord(this.stateDir, {
          ...record, state: "failed", reason: "start_failed", finishedAt: new Date(this.now()).toISOString(),
        });
        throw new HttpError(502, "update_start_failed", "Could not start the update.");
      }
      // Only a run that started counts against the minute.
      this.#lastStart = this.now();
      // The run may already have ended; its outcome is not overwritten.
      const current = await readRecord(this.stateDir);
      if (current?.state === "running") await writeRecord(this.stateDir, { ...current, unit });
      return this.#status(false);
    } finally {
      this.#starting = false;
    }
  }
}

// The run itself (scripts/run-update.mjs, inside the transient unit): update.sh
// with its output in the log, and how it ended in the record.
export async function runUpdateScript({
  repository = REPOSITORY, stateDir, script = join(repository, "update.sh"), spawnImpl = spawn, now = () => Date.now(),
}) {
  const logFile = join(stateDir, "update.log");
  await checkStateDir(stateDir);
  const log = await open(logFile, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW, 0o600);
  // A start that throws at once (no shell, no file) is a failed run all the
  // same: the log is closed and the outcome written either way.
  const exitCode = await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl("sh", [script], { cwd: repository, stdio: ["ignore", log.fd, log.fd] });
    } catch {
      resolve(-1);
      return;
    }
    child.once("error", () => resolve(-1));
    child.once("close", (exit) => resolve(Number.isInteger(exit) ? exit : -1));
  }).finally(() => log.close().catch(() => {}));
  const record = await readRecord(stateDir) ?? {};
  await writeRecord(stateDir, {
    ...record,
    state: exitCode === 0 ? "succeeded" : "failed",
    finishedAt: new Date(now()).toISOString(),
    exitCode,
    reason: exitCode === 0 ? null : "script_failed",
  });
  return exitCode;
}

// One run start per PC per window, as this hub forwards them. `limit(key)`
// takes the slot; `limit.release(key)` gives it back when nothing started.
export function runLimiter(windowMs = RUN_INTERVAL_MS, now = () => Date.now()) {
  const last = new Map();
  const limit = (key) => {
    const at = last.get(key);
    if (at !== undefined && now() - at < windowMs) {
      throw new HttpError(429, "too_many_requests", "An update was started a moment ago. Try again in a minute.");
    }
    if (last.size > 256) last.clear();
    last.set(key, now());
  };
  limit.release = (key) => { last.delete(key); };
  return limit;
}
