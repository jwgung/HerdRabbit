import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./http-basics.mjs";
import {
  CHECK_REUSE_MS, FRESH_CHECK_REUSE_MS, NOFOLLOW, RUN_INTERVAL_MS, RUN_STATES,
  checkStateDir, cleanLog, execCommand, line, readLogTail, readRecord, writeFileSafely, writeRecord,
} from "./app-update.mjs";
import { compareHerdrVersions, parseHerdrVersion } from "./herdr-version.mjs";

// Herdr's own update, beside HerdRabbit's (src/app-update.mjs): whether
// herdr.dev has a newer Herdr for the channel this PC follows, and running
// `herdr update --handoff` for it from the page. Herdr stays its own updater;
// this asks what it would ask, and starts it outside this service, in a unit
// of its own with nothing of this service's environment but PATH, HOME and
// the XDG folders that say where Herdr keeps its config and sockets.

// The only places a newer Herdr is looked up, as Herdr itself does. Never
// taken from settings or from a request.
export const MANIFEST_URLS = Object.freeze({
  stable: "https://herdr.dev/latest.json",
  preview: "https://herdr.dev/preview.json",
});
export const MANIFEST_TIMEOUT_MS = 10_000;
// herdr.dev's manifest carries the release notes (some 190 KB in 2026-10).
export const MAX_MANIFEST_BYTES = 1024 * 1024;
// Where Herdr finds its config and sockets when they are not the defaults:
// without them `--handoff` could not reach the running server.
export const HERDR_LOCATION_VARIABLES = Object.freeze(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]);

// PATH, HOME and those folders, as absolute paths only; nothing else.
function herdrEnvironment(environment, path) {
  const env = { PATH: path, HOME: environment.HOME || homedir() };
  for (const name of HERDR_LOCATION_VARIABLES) {
    const value = environment[name];
    if (typeof value === "string" && isAbsolute(value) && !/[\0\n]/u.test(value)) env[name] = value;
  }
  return env;
}
export const MAX_HERDR_NOTES = 1_500;
export const MAX_DETAIL = 300;
export const HERDR_STATE_FILE = "herdr-update-state.json";
export const HERDR_LOG_FILE = "herdr-update.log";
const COMMAND_TIMEOUT_MS = 10_000;
const START_GRACE_MS = 10_000;
const HERDR_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/u;
const CODE = /^[a-z_]{1,32}$/u;
const UNIT = /^herdr-update-[0-9]{1,20}$/u;
const REPOSITORY = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
// Installs Herdr will not update itself: the package manager does.
const MANAGED_INSTALL = [/\/Cellar\//u, /\/(?:home)?brew\//iu, /\/\.?linuxbrew\//u, /^\/nix\/store\//u, /\/mise\/installs\//u];
// What Herdr says when it will not update itself, shown as the reason.
const REFUSAL = /self-update is disabled|outside herdr/iu;

const code = (value) => typeof value === "string" && CODE.test(value) ? value : null;
const time = (value) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;

export function herdrVersion(value) {
  return typeof value === "string" && value.length <= 64 && HERDR_VERSION.test(value) ? value : null;
}

// "herdr 0.9.3" read as the version alone; build metadata is not kept.
function versionFrom(stdout) {
  const parsed = parseHerdrVersion(stdout);
  if (!parsed) return null;
  return herdrVersion(`${parsed.core.join(".")}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`);
}

// Release notes come as Markdown; the page shows them as plain text, so the
// marks go and nothing that would draw on a screen stays.
export function plainNotes(text) {
  return String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/gu, "$1")
    .replace(/^#{1,6}[ \t]+/gmu, "")
    .replace(/\*\*|__|`/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, MAX_HERDR_NOTES)
    .trimEnd();
}

// A manifest is JSON naming a version; anything else is not one.
export function parseManifest(text) {
  const manifest = JSON.parse(text);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("not a manifest");
  const version = herdrVersion(manifest.version);
  if (!version) throw new Error("manifest version is not a version");
  return { version, notes: typeof manifest.notes === "string" ? plainNotes(manifest.notes) : "" };
}

export async function fetchManifest(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS), redirect: "error", headers: { Accept: "application/json" },
  });
  const tooLarge = Number(response.headers?.get?.("content-length")) > MAX_MANIFEST_BYTES;
  if (!response.ok || tooLarge || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(tooLarge ? "manifest too large" : `manifest returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MANIFEST_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("manifest too large");
    }
    chunks.push(value);
  }
  return parseManifest(Buffer.concat(chunks).toString("utf8"));
}

// A check's answer as this PC passes it on: what a connected PC sent is held
// to exactly this before a page sees it.
export function cleanHerdrCheck(value) {
  if (!value || typeof value !== "object") return null;
  return {
    checkedAt: time(value.checkedAt),
    current: herdrVersion(value.current),
    latest: herdrVersion(value.latest),
    channel: value.channel === "stable" || value.channel === "preview" ? value.channel : null,
    available: value.available === true,
    notes: typeof value.notes === "string" ? plainNotes(value.notes) : "",
    blocked: code(value.blocked),
    error: code(value.error),
  };
}

export function cleanHerdrRunStatus(value) {
  const status = value && typeof value === "object" ? value : {};
  return {
    state: RUN_STATES.has(status.state) ? status.state : "idle",
    startedAt: time(status.startedAt),
    finishedAt: time(status.finishedAt),
    exitCode: Number.isSafeInteger(status.exitCode) ? status.exitCode : null,
    reason: code(status.reason),
    detail: typeof status.detail === "string" ? line(status.detail, MAX_DETAIL) : null,
    log: typeof status.log === "string" ? cleanLog(status.log) : "",
  };
}

async function canExecute(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class HerdrUpdater {
  #last = null;
  #checking = null;
  #starting = false;
  #lastStart = -Infinity;

  // `binary` is the Herdr this service runs (HERDR_BIN, or "herdr" on its
  // PATH). `exec` answers { code, stdout } (execCommand) for that Herdr's
  // read-only questions, systemctl and systemd-run; `fetchImpl` reads the
  // manifest. `busy()` says whether HerdRabbit's own update is under way.
  constructor({
    binary = "herdr", stateDir, exec = execCommand, fetchImpl = fetch, now = () => Date.now(),
    platform = process.platform, environment = process.env, nodeBin = process.execPath, repository = REPOSITORY,
    isExecutable = canExecute, resolvePath = realpath, busy = async () => false,
  }) {
    if (!stateDir) throw new TypeError("stateDir is required");
    this.binary = String(binary || "herdr");
    this.stateDir = stateDir;
    this.exec = exec;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.platform = platform;
    this.environment = environment;
    this.nodeBin = nodeBin;
    this.repository = repository;
    this.isExecutable = isExecutable;
    this.resolvePath = resolvePath;
    this.busy = busy;
    this.logFile = join(stateDir, HERDR_LOG_FILE);
  }

  get starting() {
    return this.#starting;
  }

  // The Herdr binary as an absolute path: a name is looked up on the PATH this
  // service has, the way it runs that name itself.
  async #resolveBinary() {
    if (this.binary.includes("/")) {
      const path = resolve(this.binary);
      return await this.isExecutable(path) ? path : null;
    }
    for (const directory of String(this.environment.PATH ?? "").split(delimiter)) {
      if (!directory || !isAbsolute(directory)) continue;
      const candidate = join(directory, this.binary);
      if (await this.isExecutable(candidate)) return candidate;
    }
    return null;
  }

  // All Herdr is given, here and in the run: PATH (its own folder first),
  // HOME and the XDG folders. Nothing of this service's HERDR_* settings, or
  // of a pane this service was started from, reaches it.
  environmentFor(binary) {
    return herdrEnvironment(this.environment, [dirname(binary), this.environment.PATH].filter(Boolean).join(":"));
  }

  async #precondition(binary) {
    if (this.platform !== "linux") return "unsupported_platform";
    const real = await this.resolvePath(binary).catch(() => binary);
    if (MANAGED_INSTALL.some((pattern) => pattern.test(real))) return "managed_install";
    const systemdRun = await this.exec("systemd-run", ["--version"], { timeout: COMMAND_TIMEOUT_MS });
    return systemdRun.code === 0 ? null : "no_systemd_run";
  }

  async #inspect() {
    const answer = (fields) => ({
      checkedAt: new Date(this.now()).toISOString(), current: null, latest: null, channel: null, available: false,
      notes: "", blocked: null, error: null, ...fields,
    });
    const binary = await this.#resolveBinary();
    if (!binary) return answer({ error: "herdr_missing" });
    const options = { env: this.environmentFor(binary), timeout: COMMAND_TIMEOUT_MS };
    const [version, channelShown, blocked] = await Promise.all([
      this.exec(binary, ["--version"], options),
      this.exec(binary, ["channel", "show"], options),
      this.#precondition(binary),
    ]);
    const current = version.code === 0 ? versionFrom(version.stdout) : null;
    // A Herdr from before channels follows stable.
    const channel = channelShown.code === 0 && channelShown.stdout.trim() === "preview" ? "preview" : "stable";
    let manifest;
    try {
      manifest = await fetchManifest(MANIFEST_URLS[channel], this.fetchImpl);
    } catch {
      return answer({ current, channel, blocked, error: "manifest_failed" });
    }
    if (!current) return answer({ latest: manifest.version, channel, blocked, error: "version_unknown" });
    const available = compareHerdrVersions(manifest.version, current) > 0;
    return answer({ current, latest: manifest.version, channel, available, notes: available ? manifest.notes : "", blocked });
  }

  async #running() {
    return this.#starting || (await this.runStatus()).state === "running" || await this.busy();
  }

  // Coalesced like HerdRabbit's: one look at a time, a recent one is the
  // answer, and nothing is asked while an update of either runs.
  async check({ fresh = false } = {}) {
    const running = await this.#running();
    const reuse = fresh ? FRESH_CHECK_REUSE_MS : CHECK_REUSE_MS;
    let result = this.#last?.result;
    if (!running && (!this.#last || this.now() - this.#last.at >= reuse)) {
      result = await this.#lookNow();
    }
    result ??= {
      checkedAt: null, current: null, latest: null, channel: null, available: false, notes: "", blocked: null, error: null,
    };
    return running ? { ...result, blocked: "running" } : result;
  }

  #lookNow() {
    this.#checking ??= this.#inspect().then((value) => {
      this.#last = { at: this.now(), result: value };
      return value;
    }).finally(() => { this.#checking = null; });
    return this.#checking;
  }

  runStatus() {
    return this.#status(false);
  }

  async #status(starting) {
    let record = await readRecord(this.stateDir, HERDR_STATE_FILE);
    const settling = !starting && (this.#starting
      || this.now() - Date.parse(record?.startedAt ?? "") < START_GRACE_MS);
    if (record?.state === "running" && !settling) {
      const named = typeof record.unit === "string" && UNIT.test(record.unit);
      let gone = !named;
      if (named) {
        const { code: exit, stdout } = await this.exec("systemctl", ["--user", "is-active", record.unit], { timeout: COMMAND_TIMEOUT_MS });
        const state = stdout.trim();
        gone = exit !== 0 && state !== "" && state !== "active" && state !== "activating" && state !== "deactivating";
      }
      if (gone) {
        const again = named ? await readRecord(this.stateDir, HERDR_STATE_FILE) : record;
        record = again?.state === "running"
          ? { ...again, state: "failed", reason: "interrupted", finishedAt: new Date(this.now()).toISOString() }
          : again;
        if (again?.state === "running") await writeRecord(this.stateDir, record, HERDR_STATE_FILE).catch(() => {});
      }
    }
    // A run that ended after the last look makes that look stale: the
    // version it read is no longer the one installed.
    if (record && record.state !== "running" && this.#last && Date.parse(record.finishedAt ?? "") >= this.#last.at) {
      this.#last = null;
    }
    return {
      state: record?.state ?? "idle",
      startedAt: record?.startedAt ?? null,
      finishedAt: record?.finishedAt ?? null,
      exitCode: Number.isSafeInteger(record?.exitCode) ? record.exitCode : null,
      reason: code(record?.reason),
      detail: typeof record?.detail === "string" ? line(record.detail, MAX_DETAIL) : null,
      log: record ? await readLogTail(this.logFile) : "",
    };
  }

  // Starts `herdr update --handoff` in a transient user unit: outside this
  // service and outside any Herdr pane, which Herdr asks for. What it runs is
  // fixed here: this Herdr, this state folder, this Node.
  async start() {
    if (this.#starting) throw new HttpError(409, "update_running", "A Herdr update is already starting.");
    this.#starting = true;
    try {
      if ((await this.#status(true)).state === "running") {
        throw new HttpError(409, "update_running", "A Herdr update is already running.");
      }
      if (await this.busy()) throw new HttpError(409, "update_running", "A HerdRabbit update is running.");
      if (this.now() - this.#lastStart < RUN_INTERVAL_MS) {
        throw new HttpError(429, "too_many_requests", "An update was started a moment ago. Try again in a minute.");
      }
      // Asked again right before starting.
      const check = await this.#lookNow();
      if (check.error) throw new HttpError(409, "update_check_failed", "Could not check herdr.dev for a new Herdr.");
      if (!check.available) throw new HttpError(409, "up_to_date", "Herdr is already up to date.");
      if (check.blocked) throw new HttpError(409, "update_blocked", `Herdr cannot be updated from here (${check.blocked}).`);
      const binary = await this.#resolveBinary();
      if (!binary) throw new HttpError(409, "update_check_failed", "Herdr is not installed where this service looks for it.");
      const environment = this.environmentFor(binary);
      const startedAt = new Date(this.now()).toISOString();
      const unit = `herdr-update-${this.now()}`;
      await checkStateDir(this.stateDir, { create: true });
      try {
        await writeFileSafely(this.logFile, "", fsConstants.O_TRUNC);
      } catch {
        throw new HttpError(500, "update_state_unsafe", "The update log cannot be written safely.");
      }
      const record = { state: "running", unit: null, startedAt, finishedAt: null, exitCode: null, reason: null, detail: null };
      await writeRecord(this.stateDir, record, HERDR_STATE_FILE);
      const started = await this.exec("systemd-run", [
        "--user", `--unit=${unit}`, "--collect", "--quiet",
        `--property=WorkingDirectory=${environment.HOME}`,
        ...Object.entries(environment).map(([name, value]) => `--setenv=${name}=${value}`),
        this.nodeBin, join(this.repository, "scripts", "run-herdr-update.mjs"), this.stateDir, binary,
      ], { timeout: COMMAND_TIMEOUT_MS });
      if (started.code !== 0) {
        await writeRecord(this.stateDir, {
          ...record, state: "failed", reason: "start_failed", finishedAt: new Date(this.now()).toISOString(),
        }, HERDR_STATE_FILE);
        throw new HttpError(502, "update_start_failed", "Could not start the Herdr update.");
      }
      // Only a run that started counts against the minute.
      this.#lastStart = this.now();
      const current = await readRecord(this.stateDir, HERDR_STATE_FILE);
      if (current?.state === "running") await writeRecord(this.stateDir, { ...current, unit }, HERDR_STATE_FILE);
      return this.#status(false);
    } finally {
      this.#starting = false;
    }
  }
}

async function readOutput(path, offset) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW);
    const { size } = await handle.stat();
    const start = Math.max(offset, size - 64 * 1024);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    await handle.read(buffer, 0, buffer.length, start);
    return cleanLog(buffer.toString("utf8"));
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

// What Herdr said that explains how the run ended: its refusal when it gave
// one, otherwise, for a failure, its last line.
function runDetail(log, failed) {
  const lines = String(log).split("\n").map((entry) => entry.trim()).filter(Boolean);
  const refusal = lines.find((entry) => REFUSAL.test(entry));
  if (refusal) return { refused: true, detail: line(refusal, MAX_DETAIL) };
  return { refused: false, detail: failed && lines.length > 0 ? line(lines.at(-1), MAX_DETAIL) : null };
}

// The run itself (scripts/run-herdr-update.mjs, inside the transient unit):
// `herdr update --handoff`, given only PATH and HOME, with its output in the
// log and how it ended in the record.
export async function runHerdrUpdateScript({
  stateDir, binary, spawnImpl = spawn, environment = process.env, now = () => Date.now(),
}) {
  if (typeof binary !== "string" || !isAbsolute(binary)) throw new TypeError("binary must be an absolute path");
  const logFile = join(stateDir, HERDR_LOG_FILE);
  await checkStateDir(stateDir);
  const env = herdrEnvironment(environment, environment.PATH ?? "");
  const log = await open(logFile, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW, 0o600);
  // Only what this run wrote explains it.
  const { size: offset } = await log.stat();
  const exitCode = await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(binary, ["update", "--handoff"], { cwd: env.HOME, env, stdio: ["ignore", log.fd, log.fd] });
    } catch {
      resolvePromise(-1);
      return;
    }
    child.once("error", () => resolvePromise(-1));
    child.once("close", (exit) => resolvePromise(Number.isInteger(exit) ? exit : -1));
  }).finally(() => log.close().catch(() => {}));
  // A refusal is a failure whatever Herdr exits with: nothing was updated.
  const { refused, detail } = runDetail(await readOutput(logFile, offset), exitCode !== 0);
  const succeeded = exitCode === 0 && !refused;
  const record = await readRecord(stateDir, HERDR_STATE_FILE) ?? {};
  await writeRecord(stateDir, {
    ...record,
    state: succeeded ? "succeeded" : "failed",
    finishedAt: new Date(now()).toISOString(),
    exitCode,
    reason: succeeded ? null : refused ? "self_update_refused" : "script_failed",
    detail: succeeded ? null : detail,
  }, HERDR_STATE_FILE);
  return succeeded ? 0 : (exitCode === 0 ? 1 : exitCode);
}
