import { isTerminalKey, TERMINAL_KEYS } from "../public/key-combinations.js";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import { subscribeHerdrStatuses } from "./herdr-status-stream.mjs";
import { callHerdrSocket } from "./herdr-rpc.mjs";

const execFileAsync = promisify(execFile);
// Herdr IDs may contain letters (for example wB:p1). Require the exact end
// of the input, including rejecting a trailing newline.
const PANE_ID_PATTERN = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+(?![\s\S])/;
const WORKSPACE_ID_PATTERN = /^w[A-Za-z0-9]+(?![\s\S])/;
const TAB_ID_PATTERN = /^w[A-Za-z0-9]+:t[A-Za-z0-9]+(?![\s\S])/;
const MAX_TEXT_LENGTH = 8_000;
const MAX_WORKSPACE_LABEL_LENGTH = 120;
const MAX_HERDR_SESSION_NAME_LENGTH = 240;
export const MAX_PANE_READ_LINES = 100_001;
// More projects or sessions than anyone keeps open; Herdr refuses an index
// past its own list anyway.
const MAX_INSERT_INDEX = 10_000;

export const ALLOWED_KEYS = Object.freeze([...TERMINAL_KEYS, "ctrl+c", "shift+tab"]);

export class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputValidationError";
  }
}

export class HerdrCommandError extends Error {
  constructor(message, { code = "herdr_command_failed", cause } = {}) {
    super(message, { cause });
    this.name = "HerdrCommandError";
    this.code = code;
  }
}

function validatePaneId(paneId) {
  if (typeof paneId !== "string" || !PANE_ID_PATTERN.test(paneId)) {
    throw new InputValidationError("Invalid pane id");
  }

  return paneId;
}

function validateHerdrSessionName(sessionName) {
  if (
    typeof sessionName !== "string" ||
    sessionName.length === 0 ||
    Buffer.byteLength(sessionName, "utf8") > MAX_HERDR_SESSION_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(sessionName)
  ) {
    throw new InputValidationError("Invalid Herdr session name");
  }
  return sessionName;
}

function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new InputValidationError("Invalid workspace id");
  }
  return workspaceId;
}

function validateTabId(tabId) {
  if (typeof tabId !== "string" || !TAB_ID_PATTERN.test(tabId)) {
    throw new InputValidationError("Invalid tab id");
  }
  return tabId;
}

// Projects and sessions are both named by the same hand, in the same sidebar,
// so they get the same rules; only the word in the message differs.
function validateLabel(label, noun) {
  if (typeof label !== "string") {
    throw new InputValidationError(`${noun} name must be text`);
  }
  const value = label.trim();
  if (value.length === 0) {
    throw new InputValidationError(`${noun} name must not be empty`);
  }
  if (value.length > MAX_WORKSPACE_LABEL_LENGTH) {
    throw new InputValidationError(
      `${noun} name must be at most ${MAX_WORKSPACE_LABEL_LENGTH} characters`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new InputValidationError(`${noun} name must not contain control characters`);
  }
  return value;
}

function validateWorkspaceLabel(label) {
  return validateLabel(label, "Workspace");
}

function validateTabLabel(label) {
  return validateLabel(label, "Session");
}

function validateInsertIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INSERT_INDEX) {
    throw new InputValidationError("Invalid position");
  }
  return index;
}

// Herdr numbers an unnamed tab by its place; a number is no name to carry
// over to another project (displayTabLabel hides it the same way).
function carriedTabLabel(label) {
  if (typeof label !== "string" || /^\d+$/u.test(label.trim())) return null;
  try {
    return validateTabLabel(label);
  } catch {
    return null;
  }
}

function validateText(text) {
  if (typeof text !== "string" || text.length === 0) {
    throw new InputValidationError("Text must not be empty");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new InputValidationError(`Text must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  if (text.includes("\0")) {
    throw new InputValidationError("Text must not contain null bytes");
  }

  return text;
}

function validateLines(lines) {
  const value = Number(lines);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PANE_READ_LINES) {
    throw new InputValidationError(`Lines must be between 1 and ${MAX_PANE_READ_LINES}`);
  }

  return value;
}

function validateReadFormat(format) {
  if (format !== "text" && format !== "ansi") {
    throw new InputValidationError("Read format must be text or ansi");
  }
  return format;
}

function validateReadSource(source) {
  if (source !== "recent-unwrapped" && source !== "detection") {
    throw new InputValidationError("Read source must be recent-unwrapped or detection");
  }
  return source;
}

function validateKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8) {
    throw new InputValidationError("Provide between 1 and 8 keys");
  }

  for (const key of keys) {
    if (!isTerminalKey(key)) {
      throw new InputValidationError("Invalid key format");
    }
  }

  return keys;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HerdrCommandError("Herdr returned invalid JSON", {
      code: "invalid_herdr_response",
      cause: error,
    });
  }
}

function unwrapResult(payload) {
  return payload && typeof payload === "object" && "result" in payload
    ? payload.result
    : payload;
}

function publicCommandError(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    try {
      const payload = JSON.parse(stderr);
      const detail = payload?.error;
      if (detail && typeof detail === "object") {
        const code = typeof detail.code === "string" ? detail.code : "herdr_command_failed";
        const message =
          typeof detail.message === "string" && detail.message.length <= 300
            ? detail.message
            : "Herdr command failed";
        return new HerdrCommandError(message, { code, cause: error });
      }
    } catch {
      // Herdr sometimes prints human-readable CLI errors. Do not reflect them to the browser.
    }
  }

  if (error?.killed || error?.signal === "SIGTERM") {
    return new HerdrCommandError("Herdr command timed out", {
      code: "herdr_timeout",
      cause: error,
    });
  }

  return new HerdrCommandError("Herdr command failed", { cause: error });
}

export class HerdrClient {
  constructor({
    binary = "herdr",
    timeoutMs = 5_000,
    runner = execFileAsync,
    sessionName = null,
    socketPath = null,
  } = {}) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
    this.sessionName = sessionName === null
      ? null
      : validateHerdrSessionName(sessionName);
    // Another machine's Herdr, reached through a socket forwarded here: every
    // command goes to that socket, and it is the one session there is.
    this.socketPath = socketPath;
  }

  async #run(args, { json = true, timeoutMs = this.timeoutMs } = {}) {
    try {
      const commandArgs = this.sessionName === null || this.socketPath
        ? args
        : [`--session=${this.sessionName}`, ...args];
      const { stdout } = await this.runner(this.binary, commandArgs, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", ...(this.socketPath ? { HERDR_SOCKET_PATH: this.socketPath } : {}) },
        windowsHide: true,
      });

      return json ? unwrapResult(parseJson(stdout)) : stdout;
    } catch (error) {
      if (error instanceof HerdrCommandError) {
        throw error;
      }
      throw publicCommandError(error);
    }
  }

  async snapshot() {
    const result = await this.#run(["api", "snapshot"]);
    return result?.snapshot ?? result;
  }

  async listSessions({ timeoutMs = this.timeoutMs } = {}) {
    // `session list` reads this machine's sessions, never the socket's.
    if (this.socketPath) return [{ name: this.sessionName || "default", default: true, running: true, socket_path: this.socketPath }];
    const result = await this.#run(["session", "list", "--json"], { timeoutMs });
    return result?.sessions ?? result;
  }

  async listAgents() {
    const result = await this.#run(["agent", "list"]);
    return result?.agents ?? result;
  }

  async renameWorkspace(workspaceId, label) {
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    const safeLabel = validateWorkspaceLabel(label);
    return this.#run(["workspace", "rename", safeWorkspaceId, safeLabel]);
  }

  async createWorkspace(label) {
    const safeLabel = validateWorkspaceLabel(label);
    return this.#run(
      ["workspace", "create", "--label", safeLabel, "--no-focus"],
      { json: false },
    );
  }

  async closeWorkspace(workspaceId) {
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    return this.#run(["workspace", "close", safeWorkspaceId], {
      json: false,
    });
  }

  async createTab(workspaceId) {
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    return this.#run(
      ["tab", "create", "--workspace", safeWorkspaceId, "--no-focus"],
      { json: false },
    );
  }

  async renameTab(tabId, label) {
    const safeTabId = validateTabId(tabId);
    const safeLabel = validateTabLabel(label);
    // The CLI takes the label as trailing words; one argv entry stays one name,
    // spaces and all.
    return this.#run(["tab", "rename", safeTabId, safeLabel]);
  }

  async closeTab(tabId) {
    const safeTabId = validateTabId(tabId);
    return this.#run(["tab", "close", safeTabId], { json: false });
  }

  // The socket of the session this client speaks for: the forwarded one of
  // another machine, or the one `session list` names here.
  async #sessionSocket() {
    if (this.socketPath) return this.socketPath;
    const sessions = await this.listSessions();
    const session = sessions.find(item => item.name === (this.sessionName || "default") && item.running);
    if (!session?.socket_path) throw new HerdrCommandError("Herdr socket is unavailable", { code: "server_unavailable" });
    return session.socket_path;
  }

  // Socket API methods the CLI has no command for.
  async #call(method, params) {
    const socketPath = await this.#sessionSocket();
    return callHerdrSocket({
      socketPath, method, params, openSocket: this.runner.openSocket, timeoutMs: this.timeoutMs,
      wrapError: ({ code, message }) => new HerdrCommandError(message, { code }),
    });
  }

  // insert_index is a gap in the list as it is now, the moving one included:
  // 0 puts it first, the list's length puts it last.
  async moveTab(tabId, insertIndex) {
    const safeTabId = validateTabId(tabId);
    const safeIndex = validateInsertIndex(insertIndex);
    return this.#call("tab.move", { tab_id: safeTabId, insert_index: safeIndex });
  }

  async moveWorkspace(workspaceId, insertIndex) {
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    const safeIndex = validateInsertIndex(insertIndex);
    return this.#call("workspace.move", { workspace_id: safeWorkspaceId, insert_index: safeIndex });
  }

  // A session (tab) carried to another project of the same Herdr session.
  // Herdr moves panes, not tabs: the pane opens a new tab there under the
  // session's name and the tab left empty closes. Only a session of one pane
  // moves: carrying several one by one could fail halfway and split the
  // session across two projects. The pane gets a new id, so the move is
  // returned for the page to follow it. `reordered` is false when the session
  // moved but could not be put at the dropped place and is last in the project.
  // insertIndex is the gap among the project's sessions as they are now.
  async moveTabToWorkspace(tabId, workspaceId, insertIndex) {
    const safeTabId = validateTabId(tabId);
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    const safeIndex = validateInsertIndex(insertIndex);
    const snapshot = await this.snapshot();
    const tab = (snapshot?.tabs ?? []).find((item) => item.tab_id === safeTabId);
    if (!tab) throw new HerdrCommandError("That session is no longer open", { code: "tab_not_found" });
    if (tab.workspace_id === safeWorkspaceId) {
      await this.moveTab(safeTabId, safeIndex);
      return { tab_id: safeTabId, panes: [], reordered: true };
    }
    if (!(snapshot.workspaces ?? []).some((item) => item.workspace_id === safeWorkspaceId)) {
      throw new HerdrCommandError("That project is no longer open", { code: "workspace_not_found" });
    }
    const paneIds = (snapshot.panes ?? []).filter((item) => item.tab_id === safeTabId).map((item) => validatePaneId(item.pane_id));
    if (paneIds.length === 0) throw new HerdrCommandError("That session has no panes", { code: "tab_not_found" });
    if (paneIds.length > 1) {
      throw new HerdrCommandError("A split session can only be reordered within its project.", { code: "split_session" });
    }
    const targetTabs = (snapshot.tabs ?? []).filter((item) => item.workspace_id === safeWorkspaceId).length;
    const label = carriedTabLabel(tab.label);
    const result = await this.#run(
      ["pane", "move", paneIds[0], "--new-tab", "--workspace", safeWorkspaceId, ...(label ? [`--label=${label}`] : []), "--no-focus"],
    );
    const moved = result?.move_result ?? result;
    const to = moved?.pane?.pane_id;
    const newTabId = moved?.created_tab?.tab_id ?? moved?.pane?.tab_id;
    if (typeof to !== "string" || !PANE_ID_PATTERN.test(to) || typeof newTabId !== "string" || !TAB_ID_PATTERN.test(newTabId)) {
      throw new HerdrCommandError("Herdr returned an unexpected move result", { code: "invalid_herdr_response" });
    }
    // The new tab opened last; put it where it was dropped.
    let reordered = true;
    if (safeIndex < targetTabs) {
      try {
        await this.moveTab(newTabId, safeIndex);
      } catch {
        reordered = false;
      }
    }
    return { tab_id: newTabId, panes: [{ from: paneIds[0], to }], reordered };
  }

  // The pane's processes as herdr sees them (its shell and the foreground
  // group, each with pid and argv): where a Codex pane's rollout is open.
  async paneProcessInfo(paneId) {
    const safePaneId = validatePaneId(paneId);
    return this.#run(["pane", "process-info", "--pane", safePaneId]);
  }

  // `source` "detection" is the screen as herdr reads it for agent states:
  // the live bottom of the pane, whatever the viewport is scrolled to.
  async readPane(paneId, { lines = 160, format = "ansi", source = "recent-unwrapped" } = {}) {
    const safePaneId = validatePaneId(paneId);
    const safeLines = validateLines(lines);
    const safeFormat = validateReadFormat(format);
    const safeSource = validateReadSource(source);
    return this.#run(
      [
        "pane",
        "read",
        safePaneId,
        "--source",
        safeSource,
        "--lines",
        String(safeLines),
        "--format",
        safeFormat,
      ],
      { json: false },
    );
  }

  async watchStatuses(paneIds, onStatus, onError) {
    const ids = paneIds.map(validatePaneId);
    const sessions = await this.listSessions();
    const session = sessions.find(item => item.name === (this.sessionName || "default") && item.running);
    if (!session?.socket_path) throw new HerdrCommandError("Herdr status socket is unavailable");
    return subscribeHerdrStatuses({ socketPath: session.socket_path, paneIds: ids,
      openSocket: this.runner.openSocket, onStatus, onError });
  }

  // What `terminal attach` needs for a pane: its terminal, the socket of this
  // session (the attach must reach the server the other commands talk to), and
  // the pane's own size for a viewer that does not set one.
  // `timeoutMs` bounds each lookup when an attach is looked up again after
  // herdr ended it, so a herdr that does not answer cannot hold it past its time.
  async terminalTarget(paneId, timeoutMs = this.timeoutMs) {
    const safePaneId = validatePaneId(paneId);
    const run = (args) => this.#run(args, { timeoutMs: Math.min(timeoutMs, this.timeoutMs) });
    const [{ pane }, sessions, layout] = await Promise.all([
      run(["pane", "get", safePaneId]),
      this.listSessions({ timeoutMs: Math.min(timeoutMs, this.timeoutMs) }),
      run(["pane", "layout", "--pane", safePaneId]).catch(() => null),
    ]);
    const session = sessions.find(item => item.name === (this.sessionName || "default") && item.running);
    if (!session?.socket_path) throw new HerdrCommandError("Herdr socket is unavailable", { code: "server_unavailable" });
    // `terminal attach` takes the API socket in HERDR_SOCKET_PATH and finds the
    // client socket beside it as `<name>-client.sock`; on a Herdr machine that
    // is the second socket the SSH link forwards (clientSocketFor).
    // On a Herdr machine this id comes from the other side: it may only ever be
    // an id, never something `terminal attach` would read as an option.
    if (typeof pane?.terminal_id !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u.test(pane.terminal_id)) {
      throw new HerdrCommandError("The pane has no terminal", { code: "no_terminal" });
    }
    const rect = layout?.layout?.panes?.find(item => item.pane_id === safePaneId)?.rect;
    return {
      command: this.binary,
      args: ["terminal", "attach", pane.terminal_id],
      // herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET.
      env: { HERDR_SOCKET_PATH: session.socket_path },
      terminalId: pane.terminal_id,
      cols: rect?.width,
      rows: rect?.height,
    };
  }

  async sendText(paneId, text, { submit = false } = {}) {
    const safePaneId = validatePaneId(paneId);
    const safeText = validateText(text);
    if (submit) {
      return this.#run(["pane", "run", safePaneId, safeText], {
        json: false,
      });
    }
    // This CLI joins trailing arguments as literal text, including "--".
    return this.#run(["pane", "send-text", safePaneId, safeText], { json: false });
  }

  async sendKeys(paneId, keys) {
    const safePaneId = validatePaneId(paneId);
    const safeKeys = validateKeys(keys);
    // Herdr's named-key parser (0.8.2 through 0.9.3) omits these navigation keys. Its
    // send-text API writes bytes directly to the PTY, without paste wrapping.
    const groups = [];
    for (const key of safeKeys) {
      const parts = key.split("+");
      const base = parts.pop();
      const navigationCodes = { home: "H", end: "F", pageup: "5", pagedown: "6", insert: "2", delete: "3" };
      const code = Object.hasOwn(navigationCodes, base) ? navigationCodes[base] : undefined;
      const raw = code !== undefined && parts.every((part) => ["ctrl", "alt", "shift"].includes(part));
      let value = key === "-" ? "minus" : key;
      if (raw) {
        const modifier = 1 + (parts.includes("shift") ? 1 : 0) +
          (parts.includes("alt") ? 2 : 0) + (parts.includes("ctrl") ? 4 : 0);
        const suffix = modifier === 1 ? "" : `;${modifier}`;
        value = base === "home" || base === "end"
          ? `\x1b[${modifier === 1 ? "" : `1${suffix}`}${code}`
          : `\x1b[${code}${suffix}~`;
      }
      const last = groups.at(-1);
      if (last?.raw === raw) last.values.push(value);
      else groups.push({ raw, values: [value] });
    }
    let result;
    for (const group of groups) {
      result = await this.#run(group.raw
        ? ["pane", "send-text", safePaneId, group.values.join("")]
        : ["pane", "send-keys", safePaneId, ...group.values], { json: false });
    }
    return result;
  }
}

export const validation = Object.freeze({
  validateHerdrSessionName,
  validatePaneId,
  validateWorkspaceId,
  validateTabId,
  validateWorkspaceLabel,
  validateInsertIndex,
  validateText,
  validateLines,
  validateReadFormat,
  validateReadSource,
  validateKeys,
});
