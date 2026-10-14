import { Readable } from "node:stream";
import { HerdrCommandError } from "./herdr-client.mjs";
import { FileAccessError } from "./file-browser.mjs";
import { LINK_PROTOCOL, checkLeafCompatibility, normalizeLeafSnapshot } from "./leaf-protocol.mjs";
import { AiAccountError } from "./ai-accounts.mjs";
import { subscribeLeafStatuses } from "./leaf-status-stream.mjs";

const TIMEOUTS = { hello: 5_000, snapshot: 8_000, read: 6_000, write: 6_000 };
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function linkError(code, message, cause) {
  return new HerdrCommandError(message, { code, cause });
}

// What a connected PC cannot do over the link yet: its terminal is shown as a
// copy of its screen, so attaching and searching its scrollback wait.
function notOverLink(what, code = "link_unsupported") {
  return linkError(code, `${what} is not available for a connected PC yet.`);
}

const MAX_ID_LENGTH = 512;
const movedId = (value) => typeof value === "string" && value !== "" && value.length <= MAX_ID_LENGTH && !value.includes("!");

// A move's answer names the tab and panes it made; anything else is dropped
// before the hub puts its own prefix on them.
function movedResult(value, tabId) {
  const moved = value && typeof value === "object" ? value : {};
  return {
    tab_id: movedId(moved.tab_id) ? moved.tab_id : tabId,
    panes: (Array.isArray(moved.panes) ? moved.panes : []).slice(0, 64)
      .filter((pane) => movedId(pane?.from) && movedId(pane?.to))
      .map(({ from, to }) => ({ from, to })),
    reordered: moved.reordered === true,
  };
}

// Anything the leaf says reaches a status line in the sidebar, so it is trimmed
// and stripped of anything that would smear a log or a heading.
function readable(text) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 200);
}

function transportError(error, address) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return linkError("leaf_timeout", `HerdRabbit at ${address} did not answer in time.`, error);
  }
  const code = error?.cause?.code || error?.code;
  if (code === "CERT_HAS_EXPIRED" || String(code).startsWith("ERR_TLS") || String(code).startsWith("UNABLE_TO_")) {
    return linkError("leaf_tls", `The HTTPS certificate at ${address} was rejected.`, error);
  }
  return linkError("leaf_unreachable",
    `Could not reach HerdRabbit at ${address}. Check the address and that HerdRabbit is running there.`, error);
}


// The only detail an account refusal carries is which panes a switch would
// affect; anything else a leaf sends is dropped.
function accountDetails(details) {
  if (!Array.isArray(details?.panes)) return undefined;
  return {
    panes: details.panes.slice(0, 64).filter((pane) => typeof pane?.paneId === "string").map((pane) => ({
      paneId: pane.paneId.slice(0, 512),
      label: typeof pane.label === "string" ? readable(pane.label) : null,
    })),
  };
}

// `Content-Range: bytes <start>-<end>/<size>` is where a partial answer keeps
// both numbers the caller needs: how much came back, and how big the file is.
function leafFile(response, path) {
  const named = response.headers.get("x-herdr-file-name");
  const length = response.headers.get("content-length");
  const served = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
  const range = served ? { start: Number(served[1]), end: Number(served[2]) } : null;
  return {
    name: named ? decodeURIComponent(named) : String(path).split("/").pop(),
    path,
    size: served ? Number(served[3]) : length === null ? null : Number(length),
    range,
    length: length === null ? null : Number(length),
    stream: Readable.fromWeb(response.body),
  };
}

// The hub's half of a link: this PC asking another PC's Connect PC port. It is constructed synchronously because
// MultiServerClient builds clients inside syncEntries and expects an object,
// not a promise, so nothing here touches the network until it is called.
export class LeafLinkClient {
  #handshake = null;
  // What the other PC last said it runs, kept when it could not be connected
  // too, so Details can show both sides' versions.
  #remote = null;

  constructor({ profile, hubVersion, fetchImpl = globalThis.fetch, subscribe = subscribeLeafStatuses }) {
    this.profile = profile;
    this.address = profile.address;
    this.hubVersion = hubVersion;
    this.fetchImpl = fetchImpl;
    this.subscribe = subscribe;
    this.controllers = new Set();
    this.stops = new Set();
  }

  info() {
    return {
      transport: "link",
      version: this.#remote?.version ?? null,
      protocol: this.#remote?.protocol ?? null,
      herdrVersion: this.#handshake?.herdrVersion ?? null,
    };
  }

  async #request(path, { method = "GET", body, timeoutMs = TIMEOUTS.read, accountErrors = false } = {}) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(`${this.address}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw transportError(error, this.address);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw linkError("leaf_error", `HerdRabbit at ${this.address} sent more than this hub will read.`);
    }
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* handled below */ }

    if (!response.ok) {
      // An account refusal keeps its own status and code, so "that account is
      // active" is not flattened into "the leaf is broken".
      const refusal = payload?.error;
      if (accountErrors && response.status < 500 && typeof refusal?.code === "string" &&
          /^[a-z_]{1,64}$/u.test(refusal.code) && refusal.code !== "not_found" &&
          response.status !== 401 && response.status !== 403) {
        throw new AiAccountError(refusal.code, readable(refusal.message) || "The server refused that change.", {
          status: response.status,
          details: accountDetails(refusal.details),
        });
      }
      // The page's own port asks for a login; that is the wrong port, not a refusal.
      if (response.status === 401 && payload?.error?.code === "authentication_required") {
        throw linkError("leaf_not_linked",
          `${this.address} is a HerdRabbit page, not its Connect PC port. Use the address its Connect PC setting shows.`);
      }
      if (response.status === 401 || response.status === 403) {
        throw linkError("leaf_unauthorized", payload?.error?.code === "peer_not_allowed"
          ? `HerdRabbit at ${this.address} does not accept other PCs yet. Add this PC to its allowed list there.`
          : `HerdRabbit at ${this.address} does not allow this PC. Add this PC to its allowed list there.`);
      }
      if (response.status === 404) {
        throw linkError("leaf_not_linked",
          `${this.address} answered, but not as a HerdRabbit Connect PC port.`);
      }
      const message = readable(payload?.error?.message) || `HerdRabbit at ${this.address} returned ${response.status}.`;
      throw linkError(payload?.error?.code?.startsWith?.("leaf_") ? payload.error.code : "leaf_error", message);
    }
    if (payload === null || typeof payload !== "object") {
      throw linkError("leaf_not_herdrabbit", `That address answered, but it is not a HerdRabbit server.`);
    }
    return payload;
  }

  #verify(hello) {
    const result = checkLeafCompatibility(
      { hubVersion: this.hubVersion, hubProtocol: LINK_PROTOCOL, serverName: `"${this.profile.name}"` },
      hello,
    );
    this.#remote = result.version ? { version: result.version, protocol: result.protocol ?? null } : null;
    if (!result.ok) {
      this.#handshake = null;
      throw linkError(result.code, result.reason);
    }
    this.#handshake = result;
  }

  async snapshot() {
    // The handshake rides along, so an incompatible leaf is caught on the same
    // poll that would have merged its records.
    const body = await this.#request("/api/link/snapshot", { timeoutMs: TIMEOUTS.snapshot });
    this.#verify(body.hello);
    return normalizeLeafSnapshot(body.snapshot);
  }

  async readPane(paneId, { lines = 160, format = "ansi" } = {}) {
    const query = new URLSearchParams({ lines: String(lines), format });
    const body = await this.#request(`/api/link/panes/${encodeURIComponent(paneId)}/output?${query}`);
    return typeof body.output === "string" ? body.output : "";
  }

  async sendText(paneId, text, { submit = false } = {}) {
    return this.#request(`/api/link/panes/${encodeURIComponent(paneId)}/text`, {
      method: "POST", body: { text, submit }, timeoutMs: TIMEOUTS.write,
    });
  }

  // The terminal of a connected PC is mirrored from its screen for now.
  async terminalTarget() {
    throw notOverLink("Attaching to the terminal", "attach_unsupported");
  }

  async paneFind() {
    throw notOverLink("Searching the terminal");
  }

  async paneReveal() {
    throw notOverLink("Searching the terminal");
  }

  async sendKeys(paneId, keys) {
    return this.#request(`/api/link/panes/${encodeURIComponent(paneId)}/keys`, {
      method: "POST", body: { keys }, timeoutMs: TIMEOUTS.write,
    });
  }

  async watchStatuses(paneIds, onStatus, onError) {
    const stop = await this.subscribe({
      url: `${this.address}/api/link/statuses`,
      paneIds,
      fetchImpl: this.fetchImpl,
      onStatus,
      onError,
    });
    this.stops.add(stop);
    return () => { this.stops.delete(stop); stop(); };
  }

  // Files. The leaf answers these with its own local browser, so nothing here
  // needs to know how to read a disk -- only how to ask.
  async #fileRequest(path, { method = "GET", body, headers = {}, timeoutMs = TIMEOUTS.read } = {}) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(`${this.address}${path}`, {
        method,
        body,
        headers,
        duplex: body === undefined ? undefined : "half",
        signal: controller.signal,
      });
    } catch (error) {
      throw transportError(error, this.address);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
    if (!response.ok) {
      let payload = null;
      try { payload = JSON.parse(await response.text()); } catch { /* keep the status */ }
      // The leaf already decided what this is; passing its status through keeps
      // "no such folder" from arriving as a generic failure.
      throw new FileAccessError(
        response.status,
        payload?.error?.code || "leaf_error",
        readable(payload?.error?.message) || `HerdRabbit at ${this.address} returned ${response.status}.`,
      );
    }
    return response;
  }

  async listDirectory(path, { prefix = "" } = {}) {
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    if (prefix) query.set("prefix", prefix);
    const response = await this.#fileRequest(`/api/link/browse?${query}`);
    return response.json();
  }

  async directoryFingerprint(path) {
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    const response = await this.#fileRequest(`/api/link/browse/fingerprint?${query}`);
    const { fingerprint } = await response.json();
    return fingerprint;
  }

  async home() {
    return (await this.listDirectory(null)).path;
  }

  async openFile(path, { rangeHeader = null, maxBytes = Infinity } = {}) {
    const response = await this.#fileRequest(
      `/api/link/browse/file?path=${encodeURIComponent(path)}`,
      rangeHeader ? { headers: { range: rangeHeader } } : undefined,
    );
    const file = leafFile(response, path);
    // The same limit a file on this PC is held to, checked before any byte is passed on.
    if (file.size !== null && file.size > maxBytes) {
      file.stream.destroy();
      throw new FileAccessError(413, "file_too_large", "That file is too large to download here.");
    }
    return file;
  }

  async uploadsDirectory() {
    return (await this.#uploads()).directory;
  }

  async listUploads() {
    return (await this.#uploads()).files;
  }

  async #uploads() {
    return (await this.#fileRequest("/api/link/files")).json();
  }

  async openUpload(name) {
    const response = await this.#fileRequest(`/api/link/files/${encodeURIComponent(name)}`);
    return leafFile(response, name);
  }

  // The declared size travels with the body: the leaf refuses an upload it
  // cannot size, the same way this hub refuses one from a browser.
  async saveUpload(name, source, { bytes } = {}) {
    const response = await this.#fileRequest(`/api/link/files/${encodeURIComponent(name)}`, {
      method: "POST",
      body: Readable.toWeb(source),
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes ?? 0) },
      timeoutMs: 120_000,
    });
    return (await response.json()).file;
  }

  async removeUpload(name) {
    await this.#fileRequest(`/api/link/files/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  // The SFTP browser held a connection open across a download ticket. HTTP has
  // nothing to hold, so these exist only to keep the caller uniform.
  hold() {}
  release() {}

  // Project and tab changes. The leaf runs them through its own Herdr client,
  // so its validation is what decides -- this side only carries the request.
  async createWorkspace(label, herdrSessionId) {
    const body = herdrSessionId === undefined ? { label } : { label, herdrSessionId };
    return this.#request("/api/link/workspaces", { method: "POST", body, timeoutMs: TIMEOUTS.write });
  }

  async renameWorkspace(workspaceId, label) {
    return this.#workspace(workspaceId, "rename", { label });
  }

  async closeWorkspace(workspaceId) {
    return this.#workspace(workspaceId, "close", {});
  }

  async createTab(workspaceId) {
    return this.#workspace(workspaceId, "tabs", {});
  }

  async moveWorkspace(workspaceId, insertIndex) {
    return this.#workspace(workspaceId, "move", { insertIndex });
  }

  async moveTab(tabId, insertIndex) {
    await this.#tab(tabId, "move", { insertIndex });
  }

  async moveTabToWorkspace(tabId, workspaceId, insertIndex) {
    const body = await this.#tab(tabId, "move", { workspaceId, insertIndex });
    return movedResult(body.moved, tabId);
  }

  async renameTab(tabId, label) {
    return this.#tab(tabId, "rename", { label });
  }

  async closeTab(tabId) {
    return this.#tab(tabId, "close", {});
  }

  async #tab(tabId, action, body) {
    return this.#request(`/api/link/tabs/${encodeURIComponent(tabId)}/${action}`, {
      method: "POST", body, timeoutMs: TIMEOUTS.write,
    });
  }

  async #workspace(workspaceId, action, body) {
    return this.#request(`/api/link/workspaces/${encodeURIComponent(workspaceId)}/${action}`, {
      method: "POST", body, timeoutMs: TIMEOUTS.write,
    });
  }

  // AI CLI accounts on the leaf, shaped like the local account manager so the
  // hub's routes do not care which machine they are talking to.
  aiAccounts() {
    const post = (path, body) => this.#request(`/api/link/ai-accounts${path}`, {
      method: "POST", body, timeoutMs: TIMEOUTS.write, accountErrors: true,
    });
    return {
      list: () => this.#request("/api/link/ai-accounts", { accountErrors: true }),
      saveCurrent: (cli) => post("/current", { cli }),
      startLogin: (cli) => post("/logins", { cli }),
      finishLogin: (cli, loginId) => post(`/logins/${encodeURIComponent(loginId)}/finish`, { cli }),
      cancelLogin: (cli, loginId) => post(`/logins/${encodeURIComponent(loginId)}/cancel`, { cli }),
      switch: (cli, account, { confirmRunning = false } = {}) => post("/switch", { cli, account, confirmRunning }),
      remove: (cli, account) => post("/remove", { cli, account }),
    };
  }

  close() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const stop of this.stops) stop();
    this.stops.clear();
  }
}
