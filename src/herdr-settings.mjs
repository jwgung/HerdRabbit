import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HttpError } from "./http-basics.mjs";
import { cleanDetail, runCaptured } from "./app-update.mjs";

// Herdr's own settings on this PC (Settings → Herdr): its update channel
// (`herdr channel show|set`), its agent integrations (`herdr integration
// status|install|uninstall`) and its config.toml. Every command runs from
// argv, never a shell, and every name that reaches it is checked first.
//
// config.toml is never written unchecked: the text is written to a private
// temporary file and `herdr config check` reads it there (HERDR_CONFIG_PATH).
// Only text Herdr accepts replaces the file: the old one is copied to
// config.toml.bak-<YYYYMMDD-HHMMSS> beside it (Herdr's own backup name), the
// new one written next to it and renamed over it, checked once more in
// place (the old one is put back if that fails), then the running server
// reloads it (`herdr server reload-config`). A save names the version it
// edited, so a file changed meanwhile (another editor, `herdr channel set`)
// is not overwritten.

export const CHANNELS = Object.freeze(["stable", "preview"]);
// Herdr's integration targets (`herdr integration install --help`): short
// lowercase words with inner hyphens, nothing that reads as an option.
const INTEGRATION = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_INTEGRATION = 32;
const MAX_INTEGRATIONS = 64;
const INTEGRATION_ACTIONS = new Set(["install", "uninstall"]);
// What `herdr integration status` says of one, as the page names it.
const INTEGRATION_STATES = new Map([
  ["not installed", "not_installed"], ["current", "current"], ["outdated", "outdated"], ["needs repair", "needs_repair"],
]);
export const MAX_CONFIG_BYTES = 512 * 1024;
// A JSON body that carries the largest config: every newline or quote is two bytes.
export const CONFIG_BODY_BYTES = 2 * MAX_CONFIG_BYTES + 16 * 1024;
const MAX_DIAGNOSTICS = 8 * 1024;
const VERSION = /^(?:none|[A-Za-z0-9_-]{43})$/u;
const READ_TIMEOUT_MS = 15_000;
const CHANGE_TIMEOUT_MS = 60_000;

const invalid = (code, message) => new HttpError(400, code, message);

export function validateChannel(value) {
  if (!CHANNELS.includes(value)) throw invalid("invalid_channel", "The update channel is stable or preview.");
  return value;
}

export function validateIntegrationName(value) {
  if (typeof value !== "string" || value.length > MAX_INTEGRATION || !INTEGRATION.test(value)) {
    throw invalid("invalid_integration", "That is not one of Herdr's integrations.");
  }
  return value;
}

export function validateIntegrationAction(value) {
  if (!INTEGRATION_ACTIONS.has(value)) throw new HttpError(404, "not_found", "Not found");
  return value;
}

// The text of a config.toml as it may be saved or checked: a string of at
// most MAX_CONFIG_BYTES, without NUL (TOML has none, and a file with one is
// not what was shown).
export function validateConfigText(value) {
  if (typeof value !== "string") throw invalid("invalid_config", "The config is text.");
  if (Buffer.byteLength(value, "utf8") > MAX_CONFIG_BYTES) {
    throw new HttpError(413, "config_too_large", `The config may be at most ${MAX_CONFIG_BYTES / 1024} KB.`);
  }
  if (value.includes("\u0000")) throw invalid("invalid_config", "The config cannot hold a NUL character.");
  return value;
}

export function validateConfigVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) {
    throw invalid("invalid_config_version", "Read the config again before saving.");
  }
  return value;
}

export const configVersion = (bytes) => bytes === null ? "none" : createHash("sha256").update(bytes).digest("base64url");

// The routes under `prefix` (/api/herdr on the page's server, /api/link/herdr
// on the Connect PC port): what is asked, or null for a path that is none.
//   /settings                                  GET   channel, integrations, where config.toml is
//   /channel                                   POST  { channel }
//   /integrations/<name>/<install|uninstall>   POST
//   /config                                    GET   the text and its version; PUT { text, version } saves
//   /config/check                              POST  { text }
//   /config/default                            GET   Herdr's defaults, to read
export function herdrSettingsRoute(pathname, prefix) {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest === "/settings") return { kind: "settings" };
  if (rest === "/channel") return { kind: "channel" };
  if (rest === "/config") return { kind: "config" };
  if (rest === "/config/check") return { kind: "check" };
  if (rest === "/config/default") return { kind: "default" };
  const integration = rest.match(/^\/integrations\/([^/]{1,64})\/(install|uninstall)$/u);
  if (integration) return { kind: "integration", name: integration[1], action: integration[2] };
  return { kind: "unknown" };
}

// One line another program wrote, fit for the page.
function text(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

// Herdr's diagnostics as lines: no control characters but the newline,
// bounded, and the temporary file a check read named config.toml.
export function cleanDiagnostics(value, tempPath = null) {
  let out = String(value ?? "").replace(/\r\n?/gu, "\n").replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, "");
  if (tempPath) out = out.split(tempPath).join("config.toml");
  out = out.trim();
  return out.length > MAX_DIAGNOSTICS ? `${out.slice(0, MAX_DIAGNOSTICS)}\n…` : out;
}

// `herdr integration status`: one line per integration,
//   `claude: current (v11) (/home/me/.claude/hooks/herdr-agent-state.sh)`
//   `letta (experimental): not installed (/home/me/.letta/hooks/…)`
//   `antigravity-cli: outdated (v2 < v4) (…)`
// The file it names is this PC's business and is not passed on.
export function parseIntegrationStatus(stdout) {
  const integrations = [];
  for (const raw of String(stdout ?? "").split(/\r?\n/u)) {
    const match = raw.trim().match(/^([a-z][a-z0-9-]{0,31})( \(experimental\))?:\s+(.+)$/u);
    if (!match || !INTEGRATION.test(match[1])) continue;
    let rest = match[3].replace(/\s+\((?:\/|~|[A-Za-z]:\\)[^()]*\)$/u, "").trim();
    const detailMatch = rest.match(/^(.*?)\s+\(([^()]{1,60})\)$/u);
    const detail = detailMatch ? detailMatch[2] : null;
    if (detailMatch) rest = detailMatch[1];
    const label = text(rest, 40);
    if (!label) continue;
    integrations.push({
      name: match[1],
      experimental: Boolean(match[2]),
      state: INTEGRATION_STATES.get(label) ?? "other",
      label,
      detail: text(detail, 60),
    });
    if (integrations.length >= MAX_INTEGRATIONS) break;
  }
  return integrations;
}

function cleanIntegration(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !INTEGRATION.test(raw.name) ||
      raw.name.length > MAX_INTEGRATION) return null;
  const label = text(raw.label, 40);
  const state = [...INTEGRATION_STATES.values(), "other"].includes(raw.state) ? raw.state : "other";
  return { name: raw.name, experimental: raw.experimental === true, state, label: label ?? state.replace(/_/gu, " "), detail: text(raw.detail, 60) };
}

// Where config.toml is, as the page shows it: under the home folder as ~/….
function cleanConfigPath(value) {
  const cleaned = text(value, 300);
  return cleaned && /^(?:~|\/|[A-Za-z]:\\)/u.test(cleaned) ? cleaned : null;
}

function cleanConfigInfo(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    path: cleanConfigPath(value.path),
    exists: value.exists === true,
    bytes: Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? value.bytes : null,
  };
}

// What GET /api/herdr/settings answers, from this PC or a connected PC.
export function cleanHerdrSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    channel: CHANNELS.includes(value.channel) ? value.channel : null,
    integrations: (Array.isArray(value.integrations) ? value.integrations : [])
      .slice(0, MAX_INTEGRATIONS).map(cleanIntegration).filter(Boolean),
    config: cleanConfigInfo(value.config),
  };
}

// What GET /api/herdr/config (and a save) answers: the text and its version.
export function cleanConfigFile(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const textValue = typeof value.text === "string" && Buffer.byteLength(value.text, "utf8") <= MAX_CONFIG_BYTES ? value.text : "";
  const answer = {
    ...cleanConfigInfo(value),
    text: textValue,
    version: typeof value.version === "string" && VERSION.test(value.version) ? value.version : "none",
  };
  if ("backup" in value) answer.backup = typeof value.backup === "string" && /^[A-Za-z0-9._-]{1,120}\.bak-[0-9-]{1,40}$/u.test(value.backup) ? value.backup : null;
  if ("reloaded" in value) answer.reloaded = value.reloaded === true;
  if ("reloadDetail" in value) answer.reloadDetail = value.reloadDetail ? cleanDetail(String(value.reloadDetail)) : null;
  return answer;
}

export function cleanConfigCheck(raw) {
  return { ok: raw?.ok === true, diagnostics: cleanDiagnostics(raw?.diagnostics) };
}

export function cleanDefaultConfig(raw) {
  const value = typeof raw?.text === "string" && Buffer.byteLength(raw.text, "utf8") <= MAX_CONFIG_BYTES ? raw.text : "";
  return { text: value };
}

function failureDetail(answer, fallback) {
  if (answer.timedOut) return "Herdr took too long and was stopped.";
  if (answer.code === -1 && !answer.stderr && !answer.stdout) return "Herdr could not be run on this PC.";
  const last = (value) => String(value ?? "").split(/\r?\n/u).map((part) => part.trim()).filter(Boolean).at(-1);
  const found = last(answer.stderr) ?? last(answer.stdout) ?? fallback;
  return cleanDetail(found.replace(/(?:~|\/)(?:[^\s/'"`]+\/)+([^\s/'"`]+)/gu, "…/$1"));
}

// `Config: <path>` in `herdr --help`, which is Herdr's own answer (it
// follows HERDR_CONFIG_PATH).
export function helpConfigPath(stdout) {
  const match = String(stdout ?? "").match(/^Config:\s+(\S.*?)\s*$/mu);
  return match ? match[1] : null;
}

// Local time as Herdr names its backups: 20260904-191115.
function stamp(ms) {
  const date = new Date(ms);
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

async function readIfThere(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export class HerdrSettings {
  #changing = false;
  #path = null;

  // `run(args, { timeout, env })` answers { code, stdout, stderr, timedOut }
  // as runCaptured does; tests stand in for Herdr with it. `configPath` skips
  // asking Herdr where its config is. `busy()` is true while Herdr's own
  // update runs, and nothing changes then.
  constructor({
    binary = "herdr", cwd = homedir(), home = homedir(), env = process.env, now = () => Date.now(),
    run = (args, { env: runEnv, ...options } = {}) =>
      runCaptured((file, argv, spawnOptions) => spawn(file, argv, { ...spawnOptions, env: runEnv ?? env }), binary, args, { cwd, ...options }),
    configPath = null, busy = async () => false, tempRoot = tmpdir(),
  } = {}) {
    this.run = run;
    this.env = env;
    this.home = home;
    this.now = now;
    this.busy = busy;
    this.tempRoot = tempRoot;
    this.#path = configPath;
  }

  async #configPath() {
    if (this.#path) return this.#path;
    const answer = await this.run(["--help"], { timeout: READ_TIMEOUT_MS });
    const found = answer.code === 0 ? helpConfigPath(answer.stdout) : null;
    if (!found || !found.startsWith("/")) {
      throw new HttpError(502, "herdr_config_unknown", "Herdr did not say where its config.toml is on this PC.");
    }
    this.#path = found;
    return found;
  }

  #shown(path) {
    return this.home && (path === this.home || path.startsWith(`${this.home}/`)) ? `~${path.slice(this.home.length)}` : path;
  }

  async #channel() {
    const answer = await this.run(["channel", "show"], { timeout: READ_TIMEOUT_MS });
    const value = String(answer.stdout ?? "").trim();
    return answer.code === 0 && CHANNELS.includes(value) ? value : null;
  }

  async #integrations() {
    const answer = await this.run(["integration", "status"], { timeout: READ_TIMEOUT_MS });
    if (answer.code !== 0) {
      throw new HttpError(502, "herdr_settings_failed", `Could not read Herdr's integrations: ${failureDetail(answer, "herdr integration status failed")}`);
    }
    return parseIntegrationStatus(answer.stdout);
  }

  async #info() {
    const path = await this.#configPath();
    let info = null;
    try { info = await stat(path); } catch { info = null; }
    return { path: this.#shown(path), exists: Boolean(info?.isFile()), bytes: info?.isFile() ? info.size : null };
  }

  async state() {
    const [channel, integrations, config] = await Promise.all([this.#channel(), this.#integrations(), this.#info()]);
    return cleanHerdrSettings({ channel, integrations, config });
  }

  // One change at a time on this PC, whoever asks, and none while Herdr updates.
  async #change(work) {
    const busy = () => new HttpError(409, "herdr_settings_busy", "Another change to Herdr is running on this PC. Wait for it to finish.");
    if (this.#changing) throw busy();
    this.#changing = true;
    try {
      if (await this.busy()) throw new HttpError(409, "herdr_settings_busy", "Herdr is updating on this PC. Wait for it to finish.");
      return await work();
    } finally {
      this.#changing = false;
    }
  }

  async setChannel(value) {
    const channel = validateChannel(value);
    return this.#change(async () => {
      const answer = await this.run(["channel", "set", channel], { timeout: CHANGE_TIMEOUT_MS });
      if (answer.code !== 0) {
        throw new HttpError(502, "herdr_change_failed", `Herdr did not change its channel: ${failureDetail(answer, "herdr channel set failed")}`);
      }
      return this.state();
    });
  }

  async integration(actionValue, nameValue) {
    const action = validateIntegrationAction(actionValue);
    const name = validateIntegrationName(nameValue);
    return this.#change(async () => {
      // Only a name Herdr lists here: it decides what an integration is.
      if (!(await this.#integrations()).some((item) => item.name === name)) {
        throw new HttpError(404, "integration_not_found", "Herdr on this PC has no such integration.");
      }
      const answer = await this.run(["integration", action, name], { timeout: CHANGE_TIMEOUT_MS });
      if (answer.code !== 0) {
        throw new HttpError(502, "herdr_change_failed", `Herdr did not ${action} ${name}: ${failureDetail(answer, `herdr integration ${action} failed`)}`);
      }
      return this.state();
    });
  }

  async readConfig() {
    const path = await this.#configPath();
    const bytes = await readIfThere(path);
    if (bytes && bytes.length > MAX_CONFIG_BYTES) {
      throw new HttpError(413, "config_too_large", `Herdr's config.toml is larger than ${MAX_CONFIG_BYTES / 1024} KB; edit it on that PC.`);
    }
    return cleanConfigFile({
      ...(await this.#info()), text: bytes ? bytes.toString("utf8") : "", version: configVersion(bytes),
    });
  }

  async defaultConfig() {
    const answer = await this.run(["--default-config"], { timeout: READ_TIMEOUT_MS });
    if (answer.code !== 0) {
      throw new HttpError(502, "herdr_settings_failed", `Could not read Herdr's default config: ${failureDetail(answer, "herdr --default-config failed")}`);
    }
    return cleanDefaultConfig({ text: String(answer.stdout ?? "") });
  }

  // `herdr config check` on a file. Answers { ok, diagnostics }.
  async #check(path, shownPath = null) {
    const answer = await this.run(["config", "check"], { timeout: READ_TIMEOUT_MS, env: { ...this.env, HERDR_CONFIG_PATH: path } });
    if (answer.code === -1 && !answer.stdout && !answer.stderr) {
      throw new HttpError(502, "herdr_settings_failed", "Herdr could not be run on this PC.");
    }
    if (answer.timedOut) throw new HttpError(502, "herdr_settings_failed", "Herdr took too long to check the config.");
    const output = [answer.stdout, answer.stderr].filter(Boolean).join("\n");
    return { ok: answer.code === 0, diagnostics: cleanDiagnostics(output, shownPath) };
  }

  // The text checked as it would be saved, in a private temporary folder.
  async checkConfig(value) {
    const configText = validateConfigText(value);
    const folder = await mkdtemp(join(this.tempRoot, "herdrabbit-config-"));
    try {
      const path = join(folder, "config.toml");
      await writeFile(path, configText, { mode: 0o600 });
      return await this.#check(path, path);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async saveConfig(value, versionValue) {
    const configText = validateConfigText(value);
    const version = validateConfigVersion(versionValue);
    return this.#change(async () => {
      const shownPath = await this.#configPath();
      // A config.toml that is a link (a dotfiles checkout) keeps being one: the file it names is written.
      const target = await realpath(shownPath).catch(() => shownPath);
      const before = await readIfThere(target);
      if (configVersion(before) !== version) {
        throw new HttpError(409, "config_changed", "config.toml changed since it was read. Read it again, then save.");
      }
      const checked = await this.checkConfig(configText);
      if (!checked.ok) {
        throw new HttpError(422, "config_invalid", "Herdr found problems in this config. Nothing was saved.", { diagnostics: checked.diagnostics });
      }
      const folder = dirname(target);
      let backup = null;
      if (before !== null) {
        let name = `${basename(target)}.bak-${stamp(this.now())}`;
        for (let n = 2; await exists(join(folder, name)); n += 1) name = `${basename(target)}.bak-${stamp(this.now())}-${n}`;
        backup = join(folder, name);
        await copyFile(target, backup);
      }
      const mode = before !== null ? (await stat(target)).mode & 0o777 : 0o644;
      const temp = join(folder, `.${basename(target)}.herdrabbit-${randomBytes(6).toString("hex")}`);
      try {
        await writeFile(temp, configText, { mode, flag: "wx" });
        await chmod(temp, mode);
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw new HttpError(500, "config_write_failed", `config.toml could not be written: ${cleanDetail(error?.code ?? error?.message ?? "")}`);
      }
      // Herdr reads it where it lives; should it disagree with the check, the old file comes back.
      const inPlace = await this.#check(shownPath);
      if (!inPlace.ok) {
        if (backup) await copyFile(backup, target);
        else await rm(target, { force: true });
        throw new HttpError(422, "config_invalid", "Herdr found problems in the saved config, so the old one was put back.", { diagnostics: inPlace.diagnostics });
      }
      const reload = await this.run(["server", "reload-config"], { timeout: READ_TIMEOUT_MS });
      return {
        ...(await this.readConfig()),
        backup: backup ? basename(backup) : null,
        reloaded: reload.code === 0,
        reloadDetail: reload.code === 0 ? null : failureDetail(reload, "herdr server reload-config failed"),
      };
    });
  }
}
