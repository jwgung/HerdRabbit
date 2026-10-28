import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ID, absoluteFolder } from "./config.mjs";
import { HttpError } from "./http-basics.mjs";

// In-app update: whether main on origin has moved past this checkout, and
// running update.sh for it from the page. update.sh stays the one updater;
// this only asks the questions it would ask first, so the page can say why an
// update would stop before anyone presses the button, and starts it outside
// this service so the restart it ends with does not take it down too.
//
// Started by Herdr as a plugin, Herdr is the updater instead: `herdr plugin
// update` fetches main into a new checkout and the plugin's restart action
// moves this server onto it. The checkout Herdr made is detached from any
// branch, so only its origin is asked about.

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
// No update takes this long: a run systemctl cannot tell about (no answer at
// all) and still "running" after it is taken for one that ended unseen. A
// unit systemctl says is active is never taken for ended, however long.
export const MAX_RUN_MS = 60 * 60_000;
// How long a plugin run's queued restart may take to replace this server
// before the run is taken for one whose restart never came.
export const RESTART_WAIT_MS = 2 * 60_000;
// The service units update.sh restarts, in the order it looks for them.
export const SERVICE_UNITS = ["herdrabbit.service", "herdr-web-local.service"];
// The only origins update.sh updates from.
export const OFFICIAL_ORIGINS = new Set([
  "https://github.com/ultivis-iot/HerdRabbit.git",
  "https://github.com/ultivis-iot/HerdRabbit",
  "git@github.com:ultivis-iot/HerdRabbit.git",
]);
export const RUN_STATES = new Set(["idle", "running", "succeeded", "failed"]);
// What a run's failure may say beyond its reason (Herdr's own error text for
// a restart that did not happen), bounded like Herdr's update detail.
export const MAX_DETAIL = 300;
// The shapes a status may have: how many steps, how long a step's label.
const MAX_STEPS = 8;
const MAX_STEP_LABEL = 80;
// How much of the log file is read back for the page.
const LOG_TAIL_BYTES = 64 * 1024;
// A command that answers within this, in at most this many bytes, is read.
const CAPTURE_TIMEOUT_MS = 10_000;
const MAX_CAPTURED_BYTES = 1024 * 1024;
// A command that ignores SIGTERM when its timeout fires is killed after this.
export const KILL_GRACE_MS = 3_000;
// After `herdr plugin action invoke <id>.restart` answers, how long the run
// watches Herdr's log of that action for its outcome: a restart stops the old
// server (up to 5s) and waits for the new one (up to 15s).
export const ACTION_WAIT_MS = 30_000;
const ACTION_POLL_MS = 1_000;
// The run's own restart, when Herdr's action could not run, gets as long.
const DIRECT_RESTART_TIMEOUT_MS = 60_000;

// The steps the page shows for a run, in order. A plugin run is Herdr's
// update and the restart; update.sh's steps are the lines it logs (below).
// "reload" is the page's own: it is current once the server has done its part.
export const RUN_STEPS = Object.freeze({
  plugin: Object.freeze([
    { id: "fetch", label: "Download and build the new version" },
    { id: "restart", label: "Restart HerdRabbit" },
    { id: "reload", label: "Reload this page" },
  ]),
  script: Object.freeze([
    { id: "fetch", label: "Fetch main" },
    { id: "herdr", label: "Update Herdr" },
    { id: "install", label: "Install dependencies" },
    { id: "verify", label: "Verify the updated code" },
    { id: "restart", label: "Restart HerdRabbit" },
    { id: "reload", label: "Reload this page" },
  ]),
});
const STEP_IDS = new Set(Object.values(RUN_STEPS).flat().map((step) => step.id));

// update.sh's log lines (`log "..."`, printed as "  > ...") that begin a
// step. update.sh names these next to the lines; test/app-update.test.mjs
// fails when one of them is no longer printed there.
export const SCRIPT_MARKERS = Object.freeze([
  ["Fetching main", "fetch"],
  ["Updating Herdr", "herdr"],
  ["Installing runtime dependencies", "install"],
  ["Verifying the updated code", "verify"],
  ["Restarting ", "restart"],
  ["Updated to ", "done"],
]);

// The step update.sh is at, from its log: the last marker line in it. A log
// with none of them (or only other output) leaves `previous` as it was.
export function scriptPhase(text, previous = null) {
  let phase = previous;
  for (const entry of String(text ?? "").split(/\r?\n/u)) {
    const match = /^ {2}> (.*)$/u.exec(entry);
    if (!match) continue;
    for (const [marker, id] of SCRIPT_MARKERS) {
      if (match[1].startsWith(marker)) phase = id;
    }
  }
  return phase;
}

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const SHA = /^[0-9a-f]{4,40}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/u;
const CODE = /^[a-z_]{1,32}$/u;
const UNIT = /^herdrabbit-update-[0-9]{1,20}$/u;

// Whether a run started outside systemd still goes: a pid this account can
// signal. One that has ended, or belongs to someone else (a recycled pid), does not.
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
export function line(text, limit = MAX_NOTE_LENGTH) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, limit);
}

// A user:password an URL might carry.
const maskCredentials = (text) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1***@");

// What Herdr (or a connected PC) says about a failure, as one line: masked
// like the log, since it is a line of that output, then bounded.
export function cleanDetail(text, limit = MAX_DETAIL) {
  return line(maskCredentials(String(text ?? "")), limit);
}

// A log is shown as it is, minus anything that would draw on the screen, and
// minus a user:password an URL might carry.
export function cleanLog(text) {
  const cleaned = maskCredentials(String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ""));
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

const cleanMode = (value) => value === "plugin" || value === "script" ? value : null;
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
    mode: cleanMode(answer.mode),
  };
}

export function cleanRunStatus(value) {
  const status = value && typeof value === "object" ? value : {};
  const steps = (Array.isArray(status.steps) ? status.steps : []).slice(0, MAX_STEPS)
    .filter((step) => typeof step?.id === "string" && STEP_IDS.has(step.id) && typeof step.label === "string")
    .map((step) => ({ id: step.id, label: line(step.label, MAX_STEP_LABEL) }))
    .filter((step) => step.label);
  return {
    state: RUN_STATES.has(status.state) ? status.state : "idle",
    startedAt: time(status.startedAt),
    finishedAt: time(status.finishedAt),
    exitCode: Number.isSafeInteger(status.exitCode) ? status.exitCode : null,
    reason: code(status.reason),
    detail: typeof status.detail === "string" ? cleanDetail(status.detail) || null : null,
    log: typeof status.log === "string" ? cleanLog(status.log) : "",
    version: typeof status.version === "string" && VERSION.test(status.version) ? status.version : null,
    mode: cleanMode(status.mode),
    steps,
    phase: steps.some((step) => step.id === status.phase) ? status.phase : null,
  };
}

export function properties(text) {
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
export const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export async function writeFileSafely(path, content, flags) {
  const handle = await open(path, flags | fsConstants.O_WRONLY | fsConstants.O_CREAT | NOFOLLOW, 0o600);
  try {
    if (content) await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

// The state folder must be a real directory of this user, not a link.
export async function checkStateDir(stateDir, { create = false } = {}) {
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

// Herdr's own update (src/herdr-update.mjs) keeps its record and log beside
// these, under names of its own, with the same care.
export async function writeRecord(stateDir, record, name = "update-state.json") {
  const path = join(stateDir, name);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFileSafely(temporary, `${JSON.stringify(record)}\n`, fsConstants.O_EXCL);
  await rename(temporary, path);
}

export async function readRecord(stateDir, name = "update-state.json") {
  try {
    const record = JSON.parse(await readFile(join(stateDir, name), "utf8"));
    return record && typeof record === "object" && RUN_STATES.has(record.state) ? record : null;
  } catch {
    return null;
  }
}

// The last `limit` bytes of a log, as written.
async function readLogText(path, limit) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW);
    const { size } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

export async function readLogTail(path) {
  return cleanLog(await readLogText(path, LOG_TAIL_BYTES));
}

// Enough of update.sh's log to find the step it is at: npm's and the checks'
// output can run long between two of its lines.
const PHASE_LOG_BYTES = 1024 * 1024;

export class AppUpdater {
  #last = null;
  #checking = null;
  #starting = false;
  #lastStart = -Infinity;
  // The step update.sh was last seen at, for a log whose window no longer
  // holds the line that began it.
  #lastPhase = null;

  // `exec(file, args, options)` answers { code, stdout } (execCommand): git,
  // systemctl and systemd-run all go through it, so a test can stand in for
  // the service manager while git runs for real against a scratch repository.
  constructor({
    version, repository = REPOSITORY, stateDir, exec = execCommand, now = () => Date.now(),
    pid = process.pid, platform = process.platform, environment = process.env, nodeBin = process.execPath,
    originAllowed = (url) => OFFICIAL_ORIGINS.has(url),
    // Herdr's own update (HerdrUpdater), checked with this one and never run
    // at the same time as it.
    herdr = null,
    // { id, binary } when Herdr started this server as that plugin: the run
    // is `herdr plugin update` and the plugin's restart, started detached.
    plugin = null, spawnImpl = spawn, alive = processAlive,
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
    this.herdr = herdr;
    this.plugin = plugin && PLUGIN_ID.test(plugin.id ?? "") && plugin.binary
      ? {
        id: plugin.id, binary: plugin.binary,
        configDir: pluginFolder(plugin.configDir), stateDir: pluginFolder(plugin.stateDir),
      }
      : null;
    this.spawnImpl = spawnImpl;
    this.alive = alive;
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
      this.plugin ? true : this.#isService(),
    ]);
    // The remote's address is compared and never repeated: it may carry a token.
    const officialOrigin = origin.code === 0 && this.originAllowed(origin.stdout.trim());
    // An address that is not the official one is never even reached: no
    // connection, no credential helper, nothing fetched from it.
    if (!officialOrigin) return answer({ blocked: "wrong_origin" });
    const fetched = await this.#git("fetch", "--quiet", "--no-tags", "origin", "main");
    // Herdr installs the plugin into a fresh checkout of its own, so the branch
    // and anything changed in this one do not matter to it.
    const precondition = !service ? "not_service"
      : this.plugin ? null
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

  // A run being started right now, before its record says so.
  get starting() {
    return this.#starting;
  }

  // HerdRabbit's answer and Herdr's, asked at the same moments. Herdr's is
  // left out when this PC has no Herdr updater.
  async check({ fresh = false } = {}) {
    const herdr = this.herdr?.check({ fresh }).catch(() => null);
    const [found, herdrAnswer] = await Promise.all([this.#check({ fresh }), herdr]);
    // How an update would run here, so the page can say what it does.
    const answer = { ...found, mode: this.plugin ? "plugin" : "script" };
    return this.herdr ? { ...answer, herdr: herdrAnswer } : answer;
  }

  async #herdrRunning() {
    return Boolean(this.herdr) && (this.herdr.starting || (await this.herdr.runStatus()).state === "running");
  }

  // Coalesced: one look at origin at a time, and a recent one is the answer.
  // While an update runs nothing is fetched: update.sh owns FETCH_HEAD then.
  // A Herdr update counts as one: update.sh would update Herdr too.
  async #check({ fresh = false } = {}) {
    const running = (await this.runStatus()).state === "running" || await this.#herdrRunning();
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
    const named = typeof record?.unit === "string" && UNIT.test(record.unit);
    const tracked = Number.isSafeInteger(record?.pid) && record.pid > 0;
    if (record?.state === "running" && !settling) {
      if (!named && !tracked) {
        record = { ...record, state: "failed", reason: "interrupted", finishedAt: new Date(this.now()).toISOString() };
        await writeRecord(this.stateDir, record).catch(() => {});
      }
    }
    if (record?.state === "running" && !settling && tracked && !named) {
      // A plugin run has no unit: its process is asked instead, and one
      // older than any update is taken for ended (its pid may be someone else's now).
      const overdue = this.now() - Date.parse(record.startedAt ?? "") > MAX_RUN_MS;
      if (overdue || !this.alive(record.pid)) {
        const again = await readRecord(this.stateDir);
        if (again?.state === "running") {
          record = { ...again, state: "failed", reason: "interrupted", finishedAt: new Date(this.now()).toISOString() };
          await writeRecord(this.stateDir, record).catch(() => {});
        } else {
          record = again;
        }
      }
    }
    if (record?.state === "running" && !settling && named) {
      // A run whose unit is gone without saying how it ended was cut short
      // (a reboot, a kill); it is not left "running" for ever.
      const { code: exit, stdout } = await this.#systemctl("is-active", record.unit);
      const state = stdout.trim();
      const overdue = state === "" && this.now() - Date.parse(record.startedAt ?? "") > MAX_RUN_MS;
      if (overdue || (exit !== 0 && state !== "" && state !== "active" && state !== "activating" && state !== "deactivating")) {
        const again = await readRecord(this.stateDir);
        if (again?.state === "running") {
          record = { ...again, state: "failed", reason: "interrupted", finishedAt: new Date(this.now()).toISOString() };
          await writeRecord(this.stateDir, record).catch(() => {});
        } else {
          record = again;
        }
      }
    }
    // A plugin run ends once the restart is under way, while this server is
    // still the one being replaced: its success is the new server's to tell,
    // so until then the page keeps waiting for the restart.
    if (record?.state === "succeeded" && record.restartOf === this.pid) {
      const late = this.now() - Date.parse(record.finishedAt ?? "") > RESTART_WAIT_MS;
      record = late
        ? { ...record, state: "failed", reason: "restart_failed", phase: "restart" }
        : { ...record, state: "running", phase: "restart" };
    }
    const mode = cleanMode(record?.mode) ?? (this.plugin ? "plugin" : "script");
    const text = record ? await readLogText(this.logFile, mode === "script" ? PHASE_LOG_BYTES : LOG_TAIL_BYTES) : "";
    return {
      state: record?.state ?? "idle",
      startedAt: record?.startedAt ?? null,
      finishedAt: record?.finishedAt ?? null,
      exitCode: Number.isSafeInteger(record?.exitCode) ? record.exitCode : null,
      reason: code(record?.reason),
      detail: typeof record?.detail === "string" ? cleanDetail(record.detail) || null : null,
      log: cleanLog(text),
      version: this.version ?? null,
      mode,
      steps: RUN_STEPS[mode],
      phase: this.#phase(record, mode, text),
    };
  }

  // The step a run is at, by the ids of RUN_STEPS: a plugin run's is in its
  // record, update.sh's in its log. A run that ended well leaves only the
  // page's reload; one that failed stays at the step it failed in.
  #phase(record, mode, text) {
    if (!record || record.state === "idle") return null;
    if (record.state === "succeeded") return "reload";
    let phase;
    if (mode === "script") {
      const previous = this.#lastPhase?.startedAt === record.startedAt ? this.#lastPhase.phase : null;
      phase = scriptPhase(text, previous) ?? "fetch";
      this.#lastPhase = { startedAt: record.startedAt, phase };
    } else {
      phase = typeof record.phase === "string" && STEP_IDS.has(record.phase) ? record.phase : "fetch";
    }
    return phase === "done" ? "reload" : phase;
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
      if (await this.#herdrRunning()) throw new HttpError(409, "update_running", "A Herdr update is running.");
      if (this.now() - this.#lastStart < RUN_INTERVAL_MS) {
        throw new HttpError(429, "too_many_requests", "An update was started a moment ago. Try again in a minute.");
      }
      // Asked again right before starting: what was true when the page loaded may not be now.
      this.#last = null;
      const check = await this.#check();
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
      const record = {
        state: "running", unit: null, startedAt, finishedAt: null, exitCode: null, reason: null, detail: null,
        mode: this.plugin ? "plugin" : "script", phase: "fetch",
      };
      await writeRecord(this.stateDir, record);
      // npm and node next to the Node this runs on, wherever the user's
      // manager would otherwise look for them.
      const path = [dirname(this.nodeBin), this.environment.PATH].filter(Boolean).join(":");
      if (this.plugin) return await this.#startPlugin(record, path);
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

  // The plugin run, detached in a session of its own so the restart that
  // stops this server does not stop it too. It is told only which Herdr and
  // which plugin; its folder is the home folder, as Herdr may remove this
  // checkout once nothing runs from it.
  async #startPlugin(record, path) {
    let pid = null;
    try {
      // The plugin's folders, when Herdr named them, let the run restart the
      // plugin itself should Herdr's restart action not run.
      const folders = this.plugin.configDir && this.plugin.stateDir ? [this.plugin.configDir, this.plugin.stateDir] : [];
      const child = this.spawnImpl(this.nodeBin, [
        join(this.repository, "scripts", "run-update.mjs"), this.stateDir, "--plugin", this.plugin.id, this.plugin.binary, ...folders,
      ], {
        cwd: this.environment.HOME || homedir(),
        env: pluginRunEnvironment(this.environment, path),
        detached: true,
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      pid = child.pid;
    } catch {
      await writeRecord(this.stateDir, {
        ...record, state: "failed", reason: "start_failed", finishedAt: new Date(this.now()).toISOString(),
      });
      throw new HttpError(502, "update_start_failed", "Could not start the update.");
    }
    this.#lastStart = this.now();
    const current = await readRecord(this.stateDir);
    if (current?.state === "running") await writeRecord(this.stateDir, { ...current, pid, restartOf: this.pid });
    return this.#status(false);
  }
}

// A plugin folder named to the run: an absolute path, nothing else.
export function pluginFolder(value) {
  return absoluteFolder(value);
}

// What the plugin run needs to find Herdr, git and npm, Herdr's socket, and
// the network the way this server's check reached it (proxies, CAs, npm's
// settings): none of this server's HERDR_WEB_* settings.
const PLUGIN_RUN_VARIABLES = new Set([
  "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO",
]);
const PLUGIN_RUN_PREFIXES = ["npm_config_", "NPM_CONFIG_"];

export function pluginRunEnvironment(environment, path) {
  const env = { PATH: path };
  for (const [name, value] of Object.entries(environment)) {
    const wanted = PLUGIN_RUN_VARIABLES.has(name) || PLUGIN_RUN_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (wanted && typeof value === "string" && value !== "") env[name] = value;
  }
  return env;
}

// SIGTERM now, SIGKILL if the command is still there after KILL_GRACE_MS. The
// kill timer is unref'd and `stop` clears it once the command has ended.
function terminate(child, graceMs) {
  try { child.kill("SIGTERM"); } catch { /* gone */ }
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, graceMs);
  killer.unref?.();
  return () => clearTimeout(killer);
}

// One command with its output appended to the log; its exit code, or -1 when
// it could not even start or took longer than `timeout` (it is then stopped,
// by SIGKILL if it ignores SIGTERM, without waiting for it to be gone).
export function runLogged(spawnImpl, file, args, { cwd, fd, env, timeout = 0, killGraceMs = KILL_GRACE_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(file, args, { cwd, stdio: ["ignore", fd, fd], ...(env ? { env } : {}) });
    } catch {
      resolve(-1);
      return;
    }
    let settled = false;
    let timer = null;
    let stopKiller = () => {};
    const done = (exit) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(exit);
    };
    const onError = () => { stopKiller(); done(-1); };
    const onClose = (exit) => { stopKiller(); done(Number.isInteger(exit) ? exit : -1); };
    child.once("error", onError);
    child.once("close", onClose);
    if (timeout > 0) {
      timer = setTimeout(() => {
        stopKiller = terminate(child, killGraceMs);
        done(-1);
      }, timeout);
    }
  });
}

// One command whose output is read as an answer: { code, stdout, stderr },
// code -1 when it could not start or took longer than `timeout`.
export function runCaptured(spawnImpl, file, args, { cwd, timeout = CAPTURE_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: -1, stdout: "", stderr: "" });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    const keep = (chunks) => (chunk) => {
      size += chunk.length;
      if (size <= MAX_CAPTURED_BYTES) chunks.push(chunk);
    };
    child.stdout?.on("data", keep(out));
    child.stderr?.on("data", keep(err));
    let settled = false;
    let stopKiller = () => {};
    const finish = (exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: exit, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    };
    const timer = setTimeout(() => {
      stopKiller = terminate(child, killGraceMs);
      finish(-1);
    }, timeout);
    child.once("error", () => { stopKiller(); finish(-1); });
    child.once("close", (exit) => { stopKiller(); finish(Number.isInteger(exit) ? exit : -1); });
  });
}

const LOG_ID = /^[A-Za-z0-9._:-]{1,64}$/u;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The id of Herdr's log for the action `herdr plugin action invoke` queued:
// its answer is JSON with the log under `result.log` (or, older, `log`).
export function invokedLogId(stdout) {
  const answer = parseJson(String(stdout ?? "").trim());
  const candidates = [answer?.result?.log?.log_id, answer?.log?.log_id, answer?.result?.log_id, answer?.log_id];
  const id = candidates.find((value) => typeof value === "string" && LOG_ID.test(value));
  return id ?? null;
}

// How an action in `herdr plugin log list` ended: "pending" while it runs,
// "ok" when it exited 0, and otherwise "failed" with what Herdr says about it
// -- its error (a command that could not even start: "No such file or
// directory (os error 2)" when node is not on Herdr's PATH), or the last
// line it printed.
export function actionOutcome(entry) {
  if (!entry || typeof entry !== "object") return { outcome: "pending", detail: null };
  const error = typeof entry.error === "string" && entry.error.trim() ? entry.error.trim() : null;
  const exit = Number.isSafeInteger(entry.exit_code) ? entry.exit_code : null;
  const finished = Number.isFinite(entry.finished_unix_ms) || error !== null || exit !== null ||
    entry.status === "succeeded" || entry.status === "failed";
  if (!finished) return { outcome: "pending", detail: null };
  if (!error && (exit === 0 || (exit === null && entry.status === "succeeded"))) return { outcome: "ok", detail: null };
  const lastLine = (text) => String(typeof text === "string" ? text : "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).at(-1);
  const said = error ?? lastLine(entry.stderr) ?? lastLine(entry.stdout);
  const detail = [said, exit !== null ? `exit code ${exit}` : null].filter(Boolean).join(" -- ") || "the restart action failed";
  return { outcome: "failed", detail: cleanDetail(detail) };
}

// The checkout Herdr installed the plugin into, from `herdr plugin list
// --json`: only an absolute folder that holds scripts/plugin.mjs.
async function installedRoot(spawnImpl, binary, id, cwd) {
  const answer = await runCaptured(spawnImpl, binary, ["plugin", "list", "--plugin", id, "--json"], { cwd });
  if (answer.code !== 0) return null;
  const plugins = parseJson(answer.stdout.trim())?.result?.plugins;
  const plugin = Array.isArray(plugins) ? plugins.find((item) => item?.plugin_id === id) : null;
  const root = pluginFolder(plugin?.plugin_root);
  if (!root) return null;
  try {
    const entry = await lstat(join(root, "scripts", "plugin.mjs"));
    return entry.isFile() ? root : null;
  } catch {
    return null;
  }
}

// The plugin run (scripts/run-update.mjs --plugin): Herdr fetches and builds
// the new checkout, then the plugin's restart action moves the server onto
// it. Herdr only queues that action, so the run follows it in Herdr's log of
// plugin actions until it has ended. An action Herdr could not run (the
// node on its PATH is gone) is done here instead: scripts/plugin.mjs restart
// from the new checkout, with this Node and the folders Herdr gives actions.
// A restart that neither managed is a failed run whose detail is Herdr's
// error. A failed update leaves the server as it is.
export async function runPluginUpdate({
  stateDir, id, binary, cwd = homedir(), spawnImpl = spawn, now = () => Date.now(),
  pluginDirs = null, nodeBin = process.execPath, environment = process.env,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  actionWaitMs = ACTION_WAIT_MS, actionPollMs = ACTION_POLL_MS,
}) {
  if (!PLUGIN_ID.test(id ?? "")) throw new TypeError("a plugin id is required");
  const logFile = join(stateDir, "update.log");
  await checkStateDir(stateDir);
  const log = await open(logFile, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW, 0o600);
  const say = (text) => log.write(`  > ${text}\n`).catch(() => {});
  // The step the page shows, written while the run is still "running".
  const enter = async (phase) => {
    const record = await readRecord(stateDir);
    if (record?.state === "running") await writeRecord(stateDir, { ...record, phase }).catch(() => {});
  };
  let exitCode;
  let reason = null;
  let detail = null;
  let phase = "fetch";
  try {
    await say(`Updating the ${id} plugin with Herdr`);
    exitCode = await runLogged(spawnImpl, binary, ["plugin", "update", id, "--yes"], { cwd, fd: log.fd });
    if (exitCode !== 0) {
      reason = "update_failed";
    } else {
      phase = "restart";
      await enter(phase);
      await say("Restarting HerdRabbit");
      const invoked = await runCaptured(spawnImpl, binary, ["plugin", "action", "invoke", `${id}.restart`], { cwd });
      if (invoked.stdout || invoked.stderr) await log.write(`${invoked.stdout}${invoked.stderr}`.replace(/\n?$/u, "\n")).catch(() => {});
      let failure = null;
      if (invoked.code !== 0) {
        failure = cleanDetail(invoked.stderr.trim().split("\n").at(-1) || `herdr plugin action invoke exited with ${invoked.code}`);
      } else {
        const logId = invokedLogId(invoked.stdout);
        const outcome = logId
          ? await followAction({ spawnImpl, binary, id, cwd, logId, now, sleep, actionWaitMs, actionPollMs })
          : { outcome: "unknown", detail: null };
        if (outcome.outcome === "failed") failure = outcome.detail;
        else if (outcome.outcome !== "ok") await say("Herdr queued the restart; whether it ran is told by the server that answers next");
      }
      if (failure) {
        await say(`Herdr could not restart HerdRabbit: ${failure}`);
        const restarted = await restartDirectly({ spawnImpl, binary, id, cwd, pluginDirs, nodeBin, environment, fd: log.fd, say });
        if (restarted.ok) {
          exitCode = 0;
        } else {
          exitCode = restarted.code ?? 1;
          reason = "restart_failed";
          detail = cleanDetail(restarted.detail ? `${failure}; ${restarted.detail}` : failure);
        }
      } else {
        exitCode = 0;
      }
    }
  } finally {
    await log.close().catch(() => {});
  }
  const record = await readRecord(stateDir) ?? {};
  await writeRecord(stateDir, {
    ...record,
    state: exitCode === 0 ? "succeeded" : "failed",
    finishedAt: new Date(now()).toISOString(),
    exitCode,
    reason,
    detail,
    phase,
  });
  return exitCode;
}

// Herdr's log of the queued action, asked until it has ended or the wait is
// over ("unknown": the restart may still come; the page's own wait decides).
async function followAction({ spawnImpl, binary, id, cwd, logId, now, sleep, actionWaitMs, actionPollMs }) {
  const deadline = now() + actionWaitMs;
  for (;;) {
    const answer = await runCaptured(spawnImpl, binary, ["plugin", "log", "list", "--plugin", id, "--limit", "50"], { cwd });
    const logs = answer.code === 0 ? parseJson(answer.stdout.trim())?.result?.logs : null;
    const entry = Array.isArray(logs) ? logs.find((item) => item?.log_id === logId) : null;
    const outcome = actionOutcome(entry);
    if (outcome.outcome !== "pending") return outcome;
    if (now() >= deadline) return { outcome: "unknown", detail: null };
    await sleep(actionPollMs);
  }
}

// The restart Herdr's action would have run, run from here: only with the
// new checkout and both plugin folders known, so it finds the same settings
// and server record; otherwise it is not tried at all.
async function restartDirectly({ spawnImpl, binary, id, cwd, pluginDirs, nodeBin, environment, fd, say }) {
  const configDir = pluginFolder(pluginDirs?.configDir);
  const stateDir = pluginFolder(pluginDirs?.stateDir);
  if (!configDir || !stateDir) {
    await say("Not restarting it directly: this server was not told the plugin's folders");
    return { ok: false, code: null, detail: "the plugin's folders are unknown, so HerdRabbit did not restart it directly" };
  }
  const root = await installedRoot(spawnImpl, binary, id, cwd);
  if (!root) {
    await say("Not restarting it directly: Herdr did not name the new checkout");
    return { ok: false, code: null, detail: "the new checkout could not be found, so HerdRabbit did not restart it directly" };
  }
  await say(`Restarting it directly with ${nodeBin}`);
  const env = {
    ...pluginRunEnvironment(environment, environment.PATH ?? ""),
    HERDR_PLUGIN_ID: id,
    HERDR_PLUGIN_ROOT: root,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_BIN_PATH: binary,
  };
  const code = await runLogged(spawnImpl, nodeBin, [join(root, "scripts", "plugin.mjs"), "restart"], {
    cwd: root, fd, env, timeout: DIRECT_RESTART_TIMEOUT_MS,
  });
  if (code === 0) {
    await say("Restarted directly");
    return { ok: true, code };
  }
  return { ok: false, code, detail: code === -1 ? "the direct restart could not start" : `the direct restart exited with ${code}` };
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
  const exitCode = await runLogged(spawnImpl, "sh", [script], { cwd: repository, fd: log.fd })
    .finally(() => log.close().catch(() => {}));
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
