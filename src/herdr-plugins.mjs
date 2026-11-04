import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./http-basics.mjs";
import { cleanDetail, cleanLog as cleanLogText, officialSource, runCaptured } from "./app-update.mjs";
import { PLUGIN_ID } from "./config.mjs";
import { existingFolder } from "./project-folder.mjs";

// Herdr's plugins on this PC (Settings → Plugins): `herdr plugin list --json`,
// and enable, disable, update, uninstall or install one. A plugin runs code on
// this PC, so every name that reaches the command line is checked here first,
// and the command runs from argv, never a shell. HerdRabbit itself is listed
// but left alone: its update is Settings → Updates (src/app-update.mjs), and
// its own actions and panes are neither shown nor run from here.
//
// Beyond a change (one at a time): a plugin's action is run and its pane
// opened for the pane chosen on the page, through Herdr's socket
// (plugin.action.invoke with that pane's workspace as context,
// plugin.pane.open as a new tab of its workspace); its command logs are read
// with `herdr plugin log list`; a local folder is linked with `herdr plugin
// link` and a linked plugin unlinked with `herdr plugin unlink`.

// The plugin ids this page acts on are Herdr's (PLUGIN_ID, src/config.mjs):
// short words, nothing that could read as an option or a path.
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
const ACTIONS = new Set(["install", "enable", "disable", "update", "uninstall", "link", "unlink"]);
// Herdr's rule for an action or pane id inside a plugin: letters, digits,
// colon, underscore and hyphen, no dots. Not a leading hyphen here either: the
// id reaches Herdr's command line, where it would read as an option.
const ENTRY_ID = /^[A-Za-z0-9:_][A-Za-z0-9:_-]{0,63}$/u;
const LOG_ID = /^[A-Za-z0-9._:-]{1,80}$/u;
const PLACEMENTS = new Set(["overlay", "popup", "split", "tab", "zoomed"]);
const MAX_ENTRIES = 50;
const MAX_LOGS = 50;
const DEFAULT_LOGS = 20;
const MANIFEST = "herdr-plugin.toml";
const MAX_MANIFEST_BYTES = 256 * 1024;
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

export function validatePluginActionId(value) {
  if (typeof value !== "string" || !ENTRY_ID.test(value)) {
    throw invalid("invalid_plugin_action", "That is not one of the plugin's actions.");
  }
  return value;
}

export function validatePluginPaneId(value) {
  if (typeof value !== "string" || !ENTRY_ID.test(value)) {
    throw invalid("invalid_plugin_pane", "That is not one of the plugin's panes.");
  }
  return value;
}

// How many logs to read: 1-50, 20 when not given.
export function validateLogLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LOGS;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOGS) {
    throw invalid("invalid_log_limit", `Ask for 1 to ${MAX_LOGS} logs.`);
  }
  return limit;
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

// One line of text another program wrote: control, direction-changing and
// invisible characters become spaces, runs of space one, at most `max` characters.
export function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

// Where a plugin came from, as much as the page shows: a GitHub repository,
// the ref asked for and the commit it resolved to. A linked plugin is only
// "local"; its folder is not named.
function cleanSource(source) {
  if (!source || typeof source !== "object") return null;
  if (source.kind !== "github") return { kind: cleanText(source.kind, 16) === "local" ? "local" : "other" };
  const owner = typeof source.owner === "string" && OWNER.test(source.owner) ? source.owner : null;
  const repo = typeof source.repo === "string" && validName(source.repo) ? source.repo : null;
  if (!owner || !repo) return { kind: "other" };
  const subdir = typeof source.subdir === "string" && source.subdir.split("/").every(validName) &&
    source.subdir.length <= MAX_SOURCE ? source.subdir : null;
  const ref = cleanText(source.ref ?? source.requested_ref, MAX_REF);
  const commit = typeof (source.commit ?? source.resolved_commit) === "string" &&
    COMMIT.test(source.commit ?? source.resolved_commit) ? (source.commit ?? source.resolved_commit) : null;
  return { kind: "github", owner, repo, subdir, ref, commit };
}

// A plugin's actions or panes as the page offers them: id, title, and an
// action's contexts or a pane's placement. Herdr's list names them
// `action_id`/`id`; a list already cleaned names them `id`.
function cleanEntries(raw, kind) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const entries = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    const id = item?.id ?? item?.action_id;
    if (typeof id !== "string" || !ENTRY_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const title = cleanText(item.title, 100) ?? id;
    if (kind === "action") {
      const contexts = Array.isArray(item.contexts)
        ? item.contexts.filter((context) => typeof context === "string" && /^[a-z_]{1,20}$/u.test(context)).slice(0, 8) : [];
      entries.push({ id, title, contexts });
    } else {
      entries.push({ id, title, placement: PLACEMENTS.has(item.placement) ? item.placement : "overlay" });
    }
  }
  return entries;
}

// One plugin as the page shows it. `protected` is HerdRabbit: listed, never
// acted on here, its actions and panes not shown. An answer that already
// says protected stays protected.
function cleanPlugin(raw, selfId = null) {
  const id = raw?.plugin_id ?? raw?.id;
  if (typeof id !== "string" || !PLUGIN_ID.test(id)) return null;
  const source = cleanSource(raw.source);
  const isProtected = raw.protected === true || isHerdRabbitPlugin(id, source, selfId);
  return {
    id,
    name: cleanText(raw.name, 100) ?? id,
    version: cleanText(raw.version, 40),
    description: cleanText(raw.description, 300),
    enabled: raw.enabled !== false,
    source,
    protected: isProtected,
    updatable: !isProtected && source?.kind === "github",
    actions: isProtected ? [] : cleanEntries(raw.actions, "action"),
    panes: isProtected ? [] : cleanEntries(raw.panes, "pane"),
  };
}

// Folders in what a plugin printed are this PC's business, not the page's:
// an absolute or ~ path is shown as its last part. A URL's path is left be.
export function hidePaths(text) {
  return String(text ?? "").replace(/(?<![\w:/.~-])(?:~?\/)(?:[^\s/'"`]+\/)+([^\s/'"`]+)/gu, "…/$1");
}

// What a plugin printed, as a log shows it: its last lines, nothing that
// draws on the screen or turns text around, no folders, no user:password.
function cleanOutput(value) {
  if (typeof value !== "string" || value === "") return "";
  return hidePaths(cleanLogText(value.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu, ""))
    .replace(/[\u0080-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, ""));
}

function unixTime(value) {
  return Number.isSafeInteger(value) && value > 0 ? new Date(value).toISOString() : null;
}

// One run of a plugin's command, as Herdr's log list (or a connected PC's
// cleaned answer) names it: which action or event, how it went, and its output.
export function cleanPluginLog(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.log_id ?? raw.id;
  if (typeof id !== "string" || !LOG_ID.test(id)) return null;
  const action = raw.action_id ?? raw.action;
  const exitCode = raw.exit_code ?? raw.exitCode;
  return {
    id,
    action: typeof action === "string" && ENTRY_ID.test(action) ? action : null,
    event: cleanText(raw.event, 40),
    status: STATES.has(raw.status) ? raw.status : null,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    startedAt: unixTime(raw.started_unix_ms) ?? cleanTime(raw.startedAt),
    finishedAt: unixTime(raw.finished_unix_ms) ?? cleanTime(raw.finishedAt),
    stdout: cleanOutput(raw.stdout),
    stderr: cleanOutput(raw.stderr),
    error: raw.error ? cleanDetail(hidePaths(String(raw.error))) : null,
  };
}

// Newest first.
export function cleanPluginLogs(raw) {
  const logs = Array.isArray(raw) ? raw.slice(-MAX_LOGS).map(cleanPluginLog).filter(Boolean) : [];
  return logs.sort((a, b) => Date.parse(b.startedAt ?? 0) - Date.parse(a.startedAt ?? 0));
}

// The pane a plugin pane opened as, by its id on that machine.
export function cleanOpenedPane(raw) {
  const paneId = raw?.paneId;
  return { paneId: typeof paneId === "string" && paneId.length > 0 && paneId.length <= 512 && !/[\s\u0000-\u001f]/u.test(paneId) ? paneId : null };
}

export function cleanTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

// The change last started on this PC: what, on which plugin, and how it went.
function cleanOperation(raw) {
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
// else of stdout. Folders in it are this PC's business, not the page's: an
// absolute path is shown as its last part.
function failureDetail(answer, fallback) {
  const last = (value) => String(value ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
  if (answer.timedOut) return "Herdr took too long and was stopped.";
  if (answer.code === -1 && !answer.stderr && !answer.stdout) return "Herdr could not be run on this PC.";
  let line = last(answer.stderr) ?? last(answer.stdout) ?? fallback;
  // Herdr's CLI writes a refusal as its JSON answer: its message is the reason.
  try {
    const message = JSON.parse(line)?.error?.message;
    if (typeof message === "string" && message) line = message;
  } catch { /* a line of text */ }
  return cleanDetail(line.replace(/(?:~|\/)(?:[^\s/'"`]+\/)+([^\s/'"`]+)/gu, "…/$1"));
}

// A folder's manifest, as text: a regular file of its own (not a link, a pipe
// or a device), at most 256 KB. Null when there is none such.
async function readManifestFile(folder) {
  let handle;
  try {
    handle = await open(join(folder, MANIFEST), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// The `id = "…"` at the top of a plugin folder's manifest, before any table:
// enough to know what a link would register. Null when there is none.
export function manifestPluginId(text) {
  for (const raw of String(text ?? "").split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith("[")) return null;
    const match = line.match(/^id\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/u);
    if (match) {
      const id = match[1] ?? match[2];
      return PLUGIN_ID.test(id) ? id : null;
    }
  }
  return null;
}

export class PluginManager {
  #operation = null;
  #starting = false;
  // One `herdr plugin list` at a time: every reader waiting meanwhile gets its answer.
  #listing = null;

  // `run(args, { timeout })` answers { code, stdout, stderr, timedOut } as
  // runCaptured does; tests stand in for Herdr with it. `busy()` is true
  // while HerdRabbit's own update runs (it installs this PC's HerdRabbit
  // plugin), and nothing starts then. `herdr` is this PC's Herdr client
  // (src/herdr-bridge-client.mjs): pluginActionInvoke and pluginPaneOpen for
  // one of its panes. `guard` is the Files tab's protected paths: a folder
  // it will not open is not linked either. `home` expands a `~` folder.
  constructor({
    binary = "herdr", selfId = null, cwd = homedir(), now = () => Date.now(),
    run = (args, options) => runCaptured(spawn, binary, args, { cwd, ...options }),
    busy = async () => false,
    herdr = null, guard = null, home = homedir(),
    readManifest = readManifestFile,
  } = {}) {
    this.selfId = selfId && PLUGIN_ID.test(selfId) ? selfId : null;
    this.run = run;
    this.now = now;
    this.busy = busy;
    this.herdr = herdr;
    this.guard = guard;
    this.home = home;
    this.readManifest = readManifest;
  }

  #plugins() {
    this.#listing ??= this.#readPlugins().finally(() => { this.#listing = null; });
    return this.#listing;
  }

  async #readPlugins() {
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
  async start(action, { plugin, source, ref, path, enabled } = {}) {
    if (!ACTIONS.has(action)) throw new HttpError(404, "not_found", "Not found");
    const busy = () => new HttpError(409, "plugin_busy", "Another plugin change or update is running on this PC. Wait for it to finish.");
    if (this.#starting || this.#operation?.state === "running") throw busy();
    this.#starting = true;
    try {
      if (await this.busy()) throw busy();
      const { args, target, pinned, timeout } = action === "install"
        ? this.#installCommand(source, ref)
        : action === "link"
          ? await this.#linkCommand(path, enabled)
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
    if (action === "unlink" && found.source?.kind !== "local") {
      throw new HttpError(409, "plugin_not_linked", "Only a plugin linked from a folder can be unlinked; uninstall this one.");
    }
    const args = action === "update" ? ["plugin", "update", id, "--yes"] : ["plugin", action, id];
    return { args, target: id, pinned: null, timeout: action === "update" ? LONG_TIMEOUT_MS : QUICK_TIMEOUT_MS };
  }

  // `herdr plugin link <folder>`: a folder on this PC, as the Files tab may
  // open it, holding a manifest whose plugin is not HerdRabbit and not one
  // already here. The change names the plugin, never the folder.
  async #linkCommand(path, enabled) {
    // The folder Herdr links is the one checked: its real path, links resolved.
    const folder = await realpath(await existingFolder(path, { home: this.home, guard: this.guard }));
    const text = await this.readManifest(folder);
    if (typeof text !== "string" || text.length > MAX_MANIFEST_BYTES) {
      throw new HttpError(400, "plugin_manifest_missing", `That folder has no ${MANIFEST} of its own (a file of at most 256 KB), so it is not a Herdr plugin.`);
    }
    const id = manifestPluginId(text);
    if (!id) throw new HttpError(400, "plugin_manifest_missing", `That folder's ${MANIFEST} names no plugin id.`);
    if (isHerdRabbitPlugin(id, null, this.selfId)) {
      throw new HttpError(403, "plugin_protected", "That folder is HerdRabbit's own plugin; HerdRabbit is updated from Settings → Updates.");
    }
    if ((await this.#plugins()).some((item) => item.id === id)) {
      throw new HttpError(409, "plugin_exists", `A plugin called ${id} is already on this PC. Unlink or uninstall it first.`);
    }
    return {
      args: ["plugin", "link", folder, ...(enabled === false ? ["--disabled"] : [])],
      target: id, pinned: null, timeout: QUICK_TIMEOUT_MS,
    };
  }

  // A plugin on this PC that is not HerdRabbit, and is on.
  async #runnable(value) {
    const id = validatePluginId(value);
    const found = (await this.#plugins()).find((item) => item.id === id);
    if (!found) throw new HttpError(404, "plugin_not_found", "That plugin is not installed on this PC.");
    if (found.protected) {
      throw new HttpError(403, "plugin_protected", "HerdRabbit's own actions and panes are not run from here.");
    }
    if (!found.enabled) throw new HttpError(409, "plugin_disabled", `${found.name} is off. Turn it on first.`);
    return found;
  }

  // Runs one of a plugin's actions. With `paneId` (one of this PC's panes)
  // the action runs for that pane's workspace, tab and folder; without one,
  // where Herdr's own focus is. Herdr starts it and answers at once: its log
  // says how it goes.
  async invoke(plugin, action, { paneId = null } = {}) {
    const actionId = validatePluginActionId(action);
    const found = await this.#runnable(plugin);
    const entry = found.actions.find((item) => item.id === actionId);
    if (!entry) throw new HttpError(404, "plugin_action_not_found", `${found.name} has no action ${actionId}.`);
    const failed = (detail) => new HttpError(502, "plugin_action_failed", `Herdr could not run ${entry.title}: ${detail}`);
    let log;
    if (paneId !== null) {
      if (!this.herdr?.pluginActionInvoke) throw new HttpError(501, "plugins_unavailable", "This PC cannot run plugin actions for a pane.");
      try {
        log = await this.herdr.pluginActionInvoke(paneId, found.id, actionId);
      } catch (error) {
        if (error?.code === "pane_not_found" || error?.name === "InputValidationError") {
          throw new HttpError(404, "pane_not_found", "That pane is no longer open.");
        }
        throw failed(cleanDetail(hidePaths(String(error?.message ?? "Herdr reported an error."))));
      }
    } else {
      const answer = await this.run(["plugin", "action", "invoke", actionId, "--plugin", found.id], { timeout: QUICK_TIMEOUT_MS });
      if (answer.code !== 0) throw failed(failureDetail(answer, "herdr plugin action invoke failed"));
      try { log = JSON.parse(String(answer.stdout ?? "").trim())?.result?.log ?? null; } catch { log = null; }
    }
    return { action: { id: entry.id, title: entry.title }, log: cleanPluginLog(log) };
  }

  // Opens one of a plugin's panes as a new tab of `paneId`'s workspace,
  // without moving Herdr's own focus. Answers the new pane's id here.
  async openPane(plugin, pane, { paneId } = {}) {
    const entrypoint = validatePluginPaneId(pane);
    const found = await this.#runnable(plugin);
    const entry = found.panes.find((item) => item.id === entrypoint);
    if (!entry) throw new HttpError(404, "plugin_pane_not_found", `${found.name} has no pane ${entrypoint}.`);
    if (typeof paneId !== "string" || paneId === "") {
      throw new HttpError(400, "pane_required", "Open a pane on this machine first: the plugin's pane opens as a new tab of its workspace.");
    }
    if (!this.herdr?.pluginPaneOpen) throw new HttpError(501, "plugins_unavailable", "This PC cannot open plugin panes.");
    let opened;
    try {
      opened = await this.herdr.pluginPaneOpen(paneId, found.id, entrypoint);
    } catch (error) {
      if (error?.code === "pane_not_found" || error?.name === "InputValidationError") {
        throw new HttpError(404, "pane_not_found", "That pane is no longer open.");
      }
      throw new HttpError(502, "plugin_pane_failed",
        `Herdr could not open ${entry.title}: ${cleanDetail(hidePaths(String(error?.message ?? "Herdr reported an error.")))}`);
    }
    return { pane: { id: entry.id, title: entry.title }, ...cleanOpenedPane({ paneId: opened?.pane_id }) };
  }

  // The plugin's last command logs (its actions, panes' starts, hooks),
  // newest first. HerdRabbit's own are read too: reading changes nothing.
  async logs(plugin, { limit } = {}) {
    const id = validatePluginId(plugin);
    const count = validateLogLimit(limit);
    if (!(await this.#plugins()).some((item) => item.id === id)) {
      throw new HttpError(404, "plugin_not_found", "That plugin is not installed on this PC.");
    }
    const answer = await this.run(["plugin", "log", "list", "--plugin", id, "--limit", String(count)], { timeout: LIST_TIMEOUT_MS });
    if (answer.code !== 0) {
      throw new HttpError(502, "plugin_log_failed", `Could not read the plugin's logs: ${failureDetail(answer, "herdr plugin log list failed")}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(String(answer.stdout ?? "").trim());
    } catch {
      throw new HttpError(502, "plugin_log_failed", "Herdr's plugin logs could not be read.");
    }
    const logs = parsed?.result?.logs;
    if (!Array.isArray(logs)) throw new HttpError(502, "plugin_log_failed", "Herdr's plugin logs could not be read.");
    return { logs: cleanPluginLogs(logs.filter((log) => log?.plugin_id === undefined || log.plugin_id === id)) };
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
