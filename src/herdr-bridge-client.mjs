import { Buffer } from "node:buffer";
import {
  HerdrClient,
  HerdrCommandError,
  InputValidationError,
  validation,
} from "./herdr-client.mjs";

const SESSION_ID_PREFIX = "hs_";
const SCOPED_ID_SEPARATOR = "~";
const SESSION_ID_PATTERN = /^hs_([A-Za-z0-9_-]+)$/;

function sessionIdForName(sessionName) {
  const safeName = validation.validateHerdrSessionName(sessionName);
  return `${SESSION_ID_PREFIX}${Buffer.from(safeName, "utf8").toString("base64url")}`;
}

function sessionNameForId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId.length > SESSION_ID_PREFIX.length + 320
  ) {
    throw new InputValidationError("Invalid Herdr session id");
  }
  const match = sessionId.match(SESSION_ID_PATTERN);
  if (!match) throw new InputValidationError("Invalid Herdr session id");

  const name = Buffer.from(match[1], "base64url").toString("utf8");
  if (Buffer.from(name, "utf8").toString("base64url") !== match[1]) {
    throw new InputValidationError("Invalid Herdr session id");
  }
  validation.validateHerdrSessionName(name);
  return name;
}

function scopedId(sessionName, localId) {
  return `${sessionIdForName(sessionName)}${SCOPED_ID_SEPARATOR}${localId}`;
}

function localIdFromScopedId(value, validateLocalId) {
  if (typeof value !== "string") {
    throw new InputValidationError("Invalid scoped Herdr id");
  }
  const separatorIndex = value.indexOf(SCOPED_ID_SEPARATOR);
  if (separatorIndex <= 0 || value.indexOf(SCOPED_ID_SEPARATOR, separatorIndex + 1) !== -1) {
    throw new InputValidationError("Invalid scoped Herdr id");
  }
  const sessionId = value.slice(0, separatorIndex);
  const localId = value.slice(separatorIndex + 1);
  return {
    sessionName: sessionNameForId(sessionId),
    localId: validateLocalId(localId),
  };
}

function scopedRecord(record, sessionName, idKeys) {
  const next = {
    ...record,
    herdr_session_id: sessionIdForName(sessionName),
    herdr_session_name: sessionName,
  };
  for (const key of idKeys) {
    if (typeof next[key] === "string" && next[key].length > 0) {
      next[key] = scopedId(sessionName, next[key]);
    }
  }
  return next;
}

function scopeSnapshot(sessionName, snapshot) {
  const value = snapshot && typeof snapshot === "object" ? snapshot : {};
  const scopeId = (id) => typeof id === "string" && id.length > 0
    ? scopedId(sessionName, id)
    : null;
  return {
    ...value,
    focused_workspace_id: scopeId(value.focused_workspace_id),
    focused_tab_id: scopeId(value.focused_tab_id),
    focused_pane_id: scopeId(value.focused_pane_id),
    workspaces: Array.isArray(value.workspaces)
      ? value.workspaces.map((record) => scopedRecord(
        record,
        sessionName,
        ["workspace_id", "active_tab_id"],
      ))
      : [],
    tabs: Array.isArray(value.tabs)
      ? value.tabs.map((record) => scopedRecord(
        record,
        sessionName,
        ["workspace_id", "tab_id"],
      ))
      : [],
    panes: Array.isArray(value.panes)
      ? value.panes.map((record) => scopedRecord(
        record,
        sessionName,
        ["workspace_id", "tab_id", "pane_id"],
      ))
      : [],
    agents: Array.isArray(value.agents)
      ? value.agents.map((record) => scopedRecord(
        record,
        sessionName,
        ["workspace_id", "tab_id", "pane_id"],
      ))
      : [],
  };
}

function normalizedSessions(value) {
  if (!Array.isArray(value)) {
    throw new HerdrCommandError("Herdr returned an invalid session list", {
      code: "invalid_herdr_response",
    });
  }

  const seen = new Set();
  const sessions = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    let name;
    try {
      name = validation.validateHerdrSessionName(item.name);
    } catch {
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    sessions.push({
      name,
      default: item.default === true || name === "default",
      running: item.running === true,
    });
  }

  return sessions.sort((left, right) => {
    if (left.default !== right.default) return left.default ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export class HerdrBridgeClient {
  constructor({
    binary = "herdr",
    timeoutMs = 5_000,
    runner,
  } = {}) {
    this.clientOptions = { binary, timeoutMs };
    if (runner) this.clientOptions.runner = runner;
    this.rootClient = new HerdrClient(this.clientOptions);
    this.runningSessionNames = new Set(["default"]);
  }

  #clientForSession(sessionName) {
    return new HerdrClient({
      ...this.clientOptions,
      sessionName,
    });
  }

  #sessionForId(sessionId) {
    const sessionName = sessionNameForId(sessionId || sessionIdForName("default"));
    if (!this.runningSessionNames.has(sessionName)) {
      throw new InputValidationError("Herdr session is not running");
    }
    return sessionName;
  }

  #targetForScopedId(value, validateLocalId) {
    const target = localIdFromScopedId(value, validateLocalId);
    this.#sessionForId(sessionIdForName(target.sessionName));
    return target;
  }

  async snapshot() {
    const sessions = normalizedSessions(await this.rootClient.listSessions());
    this.runningSessionNames = new Set(
      sessions.filter((session) => session.running).map((session) => session.name),
    );
    const publicSessions = sessions.map((session) => ({
      session_id: sessionIdForName(session.name),
      name: session.name,
      default: session.default,
      running: session.running,
      available: false,
    }));

    const results = await Promise.all(
      sessions.map(async (session, index) => {
        if (!session.running) return null;
        try {
          const snapshot = await this.#clientForSession(session.name).snapshot();
          publicSessions[index].available = true;
          return scopeSnapshot(session.name, snapshot);
        } catch {
          return null;
        }
      }),
    );
    const snapshots = results.filter(Boolean);
    const focusedSnapshot = snapshots.find((snapshot) => snapshot.focused_pane_id) || snapshots[0];

    return {
      protocol: focusedSnapshot?.protocol,
      version: focusedSnapshot?.version,
      focused_workspace_id: focusedSnapshot?.focused_workspace_id ?? null,
      focused_tab_id: focusedSnapshot?.focused_tab_id ?? null,
      focused_pane_id: focusedSnapshot?.focused_pane_id ?? null,
      herdr_sessions: publicSessions,
      workspaces: snapshots.flatMap((snapshot) => snapshot.workspaces),
      tabs: snapshots.flatMap((snapshot) => snapshot.tabs),
      panes: snapshots.flatMap((snapshot) => snapshot.panes),
      agents: snapshots.flatMap((snapshot) => snapshot.agents),
    };
  }

  async renameWorkspace(workspaceId, label) {
    const target = this.#targetForScopedId(workspaceId, validation.validateWorkspaceId);
    return this.#clientForSession(target.sessionName).renameWorkspace(target.localId, label);
  }

  async createWorkspace(label, herdrSessionId) {
    const sessionName = this.#sessionForId(herdrSessionId);
    return this.#clientForSession(sessionName).createWorkspace(label);
  }

  async closeWorkspace(workspaceId) {
    const target = this.#targetForScopedId(workspaceId, validation.validateWorkspaceId);
    return this.#clientForSession(target.sessionName).closeWorkspace(target.localId);
  }

  async createTab(workspaceId) {
    const target = this.#targetForScopedId(workspaceId, validation.validateWorkspaceId);
    return this.#clientForSession(target.sessionName).createTab(target.localId);
  }

  async renameTab(tabId, label) {
    const target = this.#targetForScopedId(tabId, validation.validateTabId);
    return this.#clientForSession(target.sessionName).renameTab(target.localId, label);
  }

  async closeTab(tabId) {
    const target = this.#targetForScopedId(tabId, validation.validateTabId);
    return this.#clientForSession(target.sessionName).closeTab(target.localId);
  }

  async readPane(paneId, options) {
    const target = this.#targetForScopedId(paneId, validation.validatePaneId);
    return this.#clientForSession(target.sessionName).readPane(target.localId, options);
  }

  async terminalTarget(paneId) {
    const target = this.#targetForScopedId(paneId, validation.validatePaneId);
    return this.#clientForSession(target.sessionName).terminalTarget(target.localId);
  }

  async sendText(paneId, text, options) {
    const target = this.#targetForScopedId(paneId, validation.validatePaneId);
    return this.#clientForSession(target.sessionName).sendText(target.localId, text, options);
  }

  async sendKeys(paneId, keys) {
    const target = this.#targetForScopedId(paneId, validation.validatePaneId);
    return this.#clientForSession(target.sessionName).sendKeys(target.localId, keys);
  }

  async watchStatuses(paneIds, onStatus, onError) {
    const groups = new Map();
    for (const paneId of paneIds) {
      const target = this.#targetForScopedId(paneId, validation.validatePaneId);
      if (!groups.has(target.sessionName)) groups.set(target.sessionName, []);
      groups.get(target.sessionName).push(target.localId);
    }
    const results = await Promise.allSettled([...groups].map(([name, ids]) =>
      this.#clientForSession(name).watchStatuses(ids, event => onStatus({ ...event, pane_id: scopedId(name, event.pane_id) }), onError)));
    const stops = results.filter(result => result.status === "fulfilled").map(result => result.value);
    for (const result of results) if (result.status === "rejected") onError(result.reason);
    return () => stops.forEach(stop => stop());
  }
}

export const sessionIds = Object.freeze({
  sessionIdForName,
  sessionNameForId,
  scopedId,
});
