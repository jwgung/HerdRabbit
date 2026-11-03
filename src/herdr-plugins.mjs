import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { HttpError } from "./http-basics.mjs";
import { cleanDetail, officialSource, runCaptured } from "./app-update.mjs";

// Herdr's plugins on this PC (Settings → Plugins): `herdr plugin list --json`,
// and enable, disable, update, uninstall or install one. A plugin runs code on
// this PC, so every name that reaches the command line is checked here first,
// and the command runs from argv, never a shell. HerdRabbit itself is listed
// but left alone: its update is Settings → Updates (src/app-update.mjs).

// The plugin ids this page acts on: Herdr's are short words; nothing that
// could read as an option or a path.
export const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
// GitHub's own rules: an owner is 1-39 letters, digits and single inner
// hyphens; a repository 1-100 letters, digits, `.`, `_` and `-`.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const MAX_SUBDIR_PARTS = 8;
const MAX_SOURCE = 300;
const MAX_REF = 200;
const REF_CHARS = /^[A-Za-z0-9._/+-]+$/u;
const COMMIT = /^[0-9a-f]{7,40}$/u;
// HerdRabbit's own plugin id, and its repository's name (a fork included).
export const HERDRABBIT_ID = "herdrabbit";
const HERDRABBIT_REPO = /^herdrabbit$/iu;
export const PLUGIN_ACTIONS = Object.freeze(["install", "enable", "disable", "update", "uninstall"]);
const ACTIONS = new Set(PLUGIN_ACTIONS);
const STATES = new Set(["running", "succeeded", "failed"]);
// Enabling, disabling and uninstalling are quick; an install or an update
// clones and builds, which on a slow PC takes minutes.
const QUICK_TIMEOUT_MS = 60_000;
const LONG_TIMEOUT_MS = 15 * 60_000;
const LIST_TIMEOUT_MS = 15_000;
const MAX_PLUGINS = 200;

const invalid = (code, message) => new HttpError(400, code, message);

export function validatePluginId(value) {
  if (typeof value !== "string" || !PLUGIN_ID.test(value)) {
    throw invalid("invalid_plugin_id", "That is not a plugin id.");
  }
  return value;
}

function validName(part) {
  return NAME.test(part) && part !== "." && part !== "..";
}

// `owner/repo[/subdir]` as `herdr plugin install` takes it, split into its
// parts. A URL, `.git`, spaces or `..` are refused, not repaired: what runs
// is exactly what was shown and confirmed.
export function validatePluginSource(value) {
  const refuse = () => invalid("invalid_plugin_source", "Enter the plugin's GitHub repository as owner/repo, or owner/repo/folder.");
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE) throw refuse();
  const parts = value.split("/");
  const [owner, repo, ...subdir] = parts;
  if (parts.length < 2 || parts.length > 2 + MAX_SUBDIR_PARTS) throw refuse();
  if (!OWNER.test(owner) || !validName(repo) || /\.git$/iu.test(repo) || !subdir.every(validName)) throw refuse();
  return { owner, repo, subdir: subdir.length ? subdir.join("/") : null, spec: value };
}

// A git ref name (`git check-ref-format`'s rules, narrowed): a branch, a tag
// or a commit, without spaces, `..`, `//`, a leading `-` or `/`, a part that
// starts with `.`, or a trailing `/`, `.` or `.lock`. Absent or empty is none.
export function validatePluginRef(value) {
  if (value === undefined || value === null || value === "") return null;
  const refuse = () => invalid("invalid_plugin_ref", "That is not a branch, tag or commit name.");
  if (typeof value !== "string" || value.length > MAX_REF || !REF_CHARS.test(value)) throw refuse();
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") ||
      value.endsWith(".lock") || value.includes("..") || value.includes("//") ||
      value.split("/").some((part) => part.startsWith("."))) throw refuse();
  return value;
}

// Whether a plugin is HerdRabbit: its id, the id this server runs as, an
// official repository, or any repository named HerdRabbit (a fork).
export function isHerdRabbitPlugin(id, source, selfId = null) {
  if (id === HERDRABBIT_ID || (selfId && id === selfId)) return true;
  if (source?.kind !== "github") return false;
  return officialSource({ kind: "github", owner: source.owner, repo: source.repo }) !== null ||
    HERDRABBIT_REPO.test(String(source.repo ?? ""));
}

function text(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

// Where a plugin came from, as much as the page shows: a GitHub repository,
// the ref asked for and the commit it resolved to. A linked plugin is only
// "local"; its folder is not named.
function cleanSource(source) {
  if (!source || typeof source !== "object") return null;
  if (source.kind !== "github") return { kind: text(source.kind, 16) === "local" ? "local" : "other" };
  const owner = typeof source.owner === "string" && OWNER.test(source.owner) ? source.owner : null;
  const repo = typeof source.repo === "string" && validName(source.repo) ? source.repo : null;
  if (!owner || !repo) return { kind: "other" };
  const subdir = typeof source.subdir === "string" && source.subdir.split("/").every(validName) &&
    source.subdir.length <= MAX_SOURCE ? source.subdir : null;
  const ref = text(source.ref ?? source.requested_ref, MAX_REF);
  const commit = typeof (source.commit ?? source.resolved_commit) === "string" &&
    COMMIT.test(source.commit ?? source.resolved_commit) ? (source.commit ?? source.resolved_commit) : null;
  return { kind: "github", owner, repo, subdir, ref, commit };
}

// One plugin as the page shows it. `protected` is HerdRabbit: listed, never
// acted on here. An answer that already says protected stays protected.
export function cleanPlugin(raw, selfId = null) {
  const id = raw?.plugin_id ?? raw?.id;
  if (typeof id !== "string" || !PLUGIN_ID.test(id)) return null;
  const source = cleanSource(raw.source);
  const isProtected = raw.protected === true || isHerdRabbitPlugin(id, source, selfId);
  return {
    id,
    name: text(raw.name, 100) ?? id,
    version: text(raw.version, 40),
    description: text(raw.description, 300),
    enabled: raw.enabled !== false,
    source,
    protected: isProtected,
    updatable: !isProtected && source?.kind === "github",
  };
}

function cleanTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

// The change last started on this PC: what, on which plugin, and how it went.
export function cleanOperation(raw) {
  if (!raw || typeof raw !== "object" || !ACTIONS.has(raw.action) || !STATES.has(raw.state)) return null;
  const target = typeof raw.plugin === "string" && raw.plugin.length <= MAX_SOURCE && /^[A-Za-z0-9._/-]+$/u.test(raw.plugin)
    ? raw.plugin : null;
  if (!target) return null;
  let ref = null;
  try { ref = validatePluginRef(raw.ref); } catch { ref = null; }
  return {
    action: raw.action, plugin: target, ref, state: raw.state,
    detail: raw.detail ? cleanDetail(String(raw.detail)) : null,
    startedAt: cleanTime(raw.startedAt), finishedAt: cleanTime(raw.finishedAt),
  };
}

// What GET /api/plugins answers, from this PC's manager or a connected PC's.
export function cleanPluginState(raw, selfId = null) {
  const plugins = Array.isArray(raw?.plugins)
    ? raw.plugins.slice(0, MAX_PLUGINS).map((item) => cleanPlugin(item, selfId)).filter(Boolean) : [];
  return { plugins, operation: cleanOperation(raw?.operation) };
}

// What Herdr said last, for a change that failed: its last line of stderr,
// else of stdout.
function failureDetail(answer, fallback) {
  const last = (value) => String(value ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
  if (answer.timedOut) return "Herdr took too long and was stopped.";
  if (answer.code === -1 && !answer.stderr && !answer.stdout) return "Herdr could not be run on this PC.";
  return cleanDetail(last(answer.stderr) ?? last(answer.stdout) ?? fallback);
}

export class PluginManager {
  #operation = null;
  #starting = false;

  // `run(args, { timeout })` answers { code, stdout, stderr, timedOut } as
  // runCaptured does; tests stand in for Herdr with it. `busy()` is true
  // while HerdRabbit's own update runs (it installs this PC's HerdRabbit
  // plugin), and nothing starts then.
  constructor({
    binary = "herdr", selfId = null, cwd = homedir(), now = () => Date.now(),
    run = (args, options) => runCaptured(spawn, binary, args, { cwd, ...options }),
    busy = async () => false,
  } = {}) {
    this.selfId = selfId && PLUGIN_ID.test(selfId) ? selfId : null;
    this.run = run;
    this.now = now;
    this.busy = busy;
  }

  async #plugins() {
    const answer = await this.run(["plugin", "list", "--json"], { timeout: LIST_TIMEOUT_MS });
    if (answer.code !== 0) {
      throw new HttpError(502, "plugin_list_failed", `Could not list Herdr's plugins: ${failureDetail(answer, "herdr plugin list failed")}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(String(answer.stdout ?? "").trim());
    } catch {
      throw new HttpError(502, "plugin_list_failed", "Herdr's plugin list could not be read.");
    }
    const plugins = parsed?.result?.plugins;
    if (!Array.isArray(plugins)) throw new HttpError(502, "plugin_list_failed", "Herdr's plugin list could not be read.");
    return cleanPluginState({ plugins }, this.selfId).plugins;
  }

  async list() {
    return { plugins: await this.#plugins(), operation: cleanOperation(this.#operation) };
  }

  // Starts one change and answers at once; GET tells how it went. One change
  // at a time on this PC, whoever asks (this PC's page or a hub).
  async start(action, { plugin, source, ref } = {}) {
    if (!ACTIONS.has(action)) throw new HttpError(404, "not_found", "Not found");
    const busy = () => new HttpError(409, "plugin_busy", "Another plugin change or update is running on this PC. Wait for it to finish.");
    if (this.#starting || this.#operation?.state === "running") throw busy();
    this.#starting = true;
    try {
      if (await this.busy()) throw busy();
      const { args, target, pinned, timeout } = action === "install"
        ? this.#installCommand(source, ref)
        : await this.#pluginCommand(action, plugin);
      const operation = {
        action, plugin: target, ref: pinned, state: "running", detail: null,
        startedAt: new Date(this.now()).toISOString(), finishedAt: null,
      };
      this.#operation = operation;
      void this.#follow(operation, args, timeout);
      return { plugins: await this.#plugins().catch(() => []), operation: cleanOperation(operation) };
    } finally {
      this.#starting = false;
    }
  }

  #installCommand(sourceValue, refValue) {
    const source = validatePluginSource(sourceValue);
    const ref = validatePluginRef(refValue);
    if (isHerdRabbitPlugin(null, { kind: "github", owner: source.owner, repo: source.repo })) {
      throw new HttpError(403, "plugin_protected", "HerdRabbit itself is updated from Settings → Updates, not installed here.");
    }
    return {
      args: ["plugin", "install", source.spec, ...(ref ? ["--ref", ref] : []), "--yes"],
      target: source.spec, pinned: ref, timeout: LONG_TIMEOUT_MS,
    };
  }

  async #pluginCommand(action, value) {
    const id = validatePluginId(value);
    const found = (await this.#plugins()).find((item) => item.id === id);
    if (!found) throw new HttpError(404, "plugin_not_found", "That plugin is not installed on this PC.");
    if (found.protected) {
      throw new HttpError(403, "plugin_protected", "HerdRabbit's own plugin is left alone here; update it from Settings → Updates.");
    }
    if (action === "update" && !found.updatable) {
      throw new HttpError(409, "plugin_not_updatable", "Only a plugin installed from GitHub can be updated.");
    }
    const args = action === "update" ? ["plugin", "update", id, "--yes"] : ["plugin", action, id];
    return { args, target: id, pinned: null, timeout: action === "update" ? LONG_TIMEOUT_MS : QUICK_TIMEOUT_MS };
  }

  async #follow(operation, args, timeout) {
    let answer;
    try {
      answer = await this.run(args, { timeout });
    } catch (error) {
      answer = { code: -1, stdout: "", stderr: String(error?.message ?? ""), timedOut: false };
    }
    operation.finishedAt = new Date(this.now()).toISOString();
    if (answer.code === 0) {
      operation.state = "succeeded";
    } else {
      operation.state = "failed";
      operation.detail = failureDetail(answer, `herdr plugin ${operation.action} failed`);
    }
  }
}
