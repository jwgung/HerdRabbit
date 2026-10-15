import { Readable, Transform, pipeline } from "node:stream";
import { HerdrCommandError } from "./herdr-client.mjs";
import { FileAccessError, UNKNOWN_SIZE_STREAM_BYTES } from "./file-browser.mjs";
import { LINK_PROTOCOL, ResponseTooLarge, checkLeafCompatibility, normalizeLeafSnapshot, readLimitedText } from "./leaf-protocol.mjs";
import { AiAccountError } from "./ai-accounts.mjs";
import { subscribeLeafStatuses } from "./leaf-status-stream.mjs";
import { openRemotePty } from "./link-attach.mjs";

// fileIdle: how long a file being passed on may go quiet before it fails
const TIMEOUTS = { hello: 5_000, snapshot: 8_000, read: 6_000, write: 6_000, fileIdle: 60_000 };
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// A refusal is a short JSON error; nothing a leaf says about one needs more.
const MAX_ERROR_BYTES = 64 * 1024;

function linkError(code, message, cause) {
  return new HerdrCommandError(message, { code, cause });
}

// What a connected PC cannot do over the link yet: searching its scrollback.
function notOverLink(what, code = "link_unsupported") {
  return linkError(code, `${what} is not available for a connected PC yet.`);
}

// What a terminal lookup may say and keep saying here: a pane that is gone ends
// the attach for good, and a PC that cannot attach is mirrored instead.
const TERMINAL_CODES = new Set(["pane_not_found", "pane_not_restored", "no_terminal", "attach_unsupported", "not_found"]);
const TERMINAL_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u;
const gridSize = (value) => Number.isInteger(value) && value >= 1 && value <= 1000 ? value : undefined;

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

// Passes bytes through, failing once more than `limit` has gone by.
// A file that stops arriving -- headers, then silence -- would hold the
// download open for ever; one quiet for `idleMs` fails instead. The clock runs
// only while the reader is asking for more, so a reader that pauses (a slow
// browser, backpressure) does not count as the PC going quiet.
function capped(limit, idleMs) {
  let seen = 0;
  let timer = null;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      clearTimeout(timer);
      seen += chunk.length;
      if (seen > limit) {
        callback(new FileAccessError(502, "leaf_error", "The connected PC sent more of that file than it should have."));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) { clearTimeout(timer); callback(); },
    destroy(error, callback) { clearTimeout(timer); callback(error); },
  });
  const read = stream._read.bind(stream);
  stream._read = (size) => {
    clearTimeout(timer);
    timer = setTimeout(() => stream.destroy(new FileAccessError(504, "leaf_timeout", "The connected PC stopped sending that file.")), idleMs);
    timer.unref?.();
    read(size);
  };
  return stream;
}

// `Content-Range: bytes <start>-<end>/<size>` is where a partial answer keeps
// both numbers the caller needs: how much came back, and how big the file is.
//
// The bytes are counted as they pass: a leaf may not send more than it said,
// nor more than `maxBytes`, nor -- saying nothing -- more than a file of
// unknown size may be. One that does is cut off with an error, so the
// download fails rather than ends looking whole.
function leafFile(response, path, maxBytes = Infinity, idleMs = TIMEOUTS.fileIdle) {
  const named = response.headers.get("x-herdr-file-name");
  const length = response.headers.get("content-length");
  const served = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
  const range = served ? { start: Number(served[1]), end: Number(served[2]) } : null;
  const declared = length === null ? null : Number(length);
  const limit = Math.min(maxBytes, Number.isFinite(declared) ? declared : UNKNOWN_SIZE_STREAM_BYTES);
  let name = String(path).split("/").pop();
  if (named) {
    try { name = decodeURIComponent(named); } catch { /* keep the name from the path */ }
  }
  return {
    name,
    path,
    size: served ? Number(served[3]) : declared,
    range,
    length: declared,
    stream: pipeline(Readable.fromWeb(response.body), capped(limit, idleMs), () => {}),
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

  constructor({ profile, hubVersion, fetchImpl = globalThis.fetch, subscribe = subscribeLeafStatuses, maxTransferBytes = Infinity, timeouts = TIMEOUTS }) {
    this.profile = profile;
    this.maxTransferBytes = maxTransferBytes;
    this.timeouts = { ...TIMEOUTS, ...timeouts };
    this.address = profile.address;
    this.hubVersion = hubVersion;
    this.fetchImpl = fetchImpl;
    this.subscribe = subscribe;
    this.controllers = new Set();
    this.stops = new Set();
    this.ptys = new Set();
  }

  info() {
    return {
      transport: "link",
      version: this.#remote?.version ?? null,
      protocol: this.#remote?.protocol ?? null,
      herdrVersion: this.#handshake?.herdrVersion ?? null,
    };
  }

  // One call to the leaf. The clock runs until `done` is called -- after the
  // body is read, for an answer that is read whole -- so a leaf that answers
  // its headers and then trickles cannot hold a request open for good.
  async #open(path, { method = "GET", body, headers = {}, timeoutMs, duplex }) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new DOMException("The leaf did not answer in time.", "TimeoutError")), timeoutMs);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      this.controllers.delete(controller);
    };
    let response;
    try {
      // A redirect is not followed: it could send the hub anywhere.
      response = await this.fetchImpl(`${this.address}${path}`, {
        method, headers, body, duplex, redirect: "manual", signal: controller.signal,
      });
    } catch (error) {
      done();
      throw transportError(error, this.address);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      done();
      throw linkError("leaf_error", `HerdRabbit at ${this.address} answered with a redirect, which this hub does not follow.`);
    }
    return { response, done, abort: () => controller.abort() };
  }

  // An answer read whole, never past `limit` bytes, within the call's clock.
  async #readBody({ response, done, abort }, limit) {
    try {
      return await readLimitedText(response, limit);
    } catch (error) {
      abort();
      if (error instanceof ResponseTooLarge) {
        throw linkError("leaf_error", `HerdRabbit at ${this.address} sent more than this hub will read.`);
      }
      throw transportError(error, this.address);
    } finally {
      done();
    }
  }

  // Nothing is asked of a PC before its link protocol is known to match: the
  // snapshot carries the handshake, and anything else asked first says hello.
  async #ready() {
    if (this.#handshake) return;
    this.#verify(await this.#request("/api/link/hello", { timeoutMs: this.timeouts.hello, checked: true }));
  }

  async #request(path, { method = "GET", body, timeoutMs = this.timeouts.read, accountErrors = false, checked = false, codes = null } = {}) {
    if (!checked) await this.#ready();
    const call = await this.#open(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    const response = call.response;
    const text = await this.#readBody(call, MAX_RESPONSE_BYTES);
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* handled below */ }

    if (!response.ok) {
      // An account refusal keeps its own status and code, so "that account is
      // active" is not flattened into "the leaf is broken".
      const refusal = payload?.error;
      if (codes?.has(refusal?.code)) {
        throw linkError(refusal.code, readable(refusal.message) || `HerdRabbit at ${this.address} returned ${response.status}.`);
      }
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
    const body = await this.#request("/api/link/snapshot", { timeoutMs: this.timeouts.snapshot, checked: true });
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
      method: "POST", body: { text, submit }, timeoutMs: this.timeouts.write,
    });
  }

  // A connected PC's terminal attaches for real: that PC runs the attach on its
  // own pty, and this hub relays it over a WebSocket on the same Connect PC
  // port (src/link-attach.mjs). The target has no command: PaneAttachments'
  // spawner sees `remote` and opens that instead. A PC from before this could
  // attach answers not_found, and its panes stay mirrored.
  async terminalTarget(paneId, timeoutMs = this.timeouts.read) {
    const path = `/api/link/panes/${encodeURIComponent(paneId)}`;
    let body;
    try {
      body = await this.#request(`${path}/terminal`, { timeoutMs: Math.min(timeoutMs, this.timeouts.read), codes: TERMINAL_CODES });
    } catch (error) {
      if (error.code === "not_found") throw linkError("attach_unsupported", `HerdRabbit at ${this.address} is too old to attach its terminals.`);
      throw error;
    }
    if (typeof body.terminal_id !== "string" || !TERMINAL_ID.test(body.terminal_id)) {
      throw linkError("no_terminal", "The pane has no terminal");
    }
    return {
      remote: { open: (options) => this.#openTerminal(path, options) },
      command: null,
      args: [],
      env: {},
      terminalId: body.terminal_id,
      cols: gridSize(body.cols),
      rows: gridSize(body.rows),
    };
  }

  #openTerminal(path, { cols, rows, takeover = false, onData, onExit }) {
    const query = new URLSearchParams({ cols: String(cols), rows: String(rows) });
    if (takeover) query.set("takeover", "1");
    // The same address, same checks, as every other call: only the scheme is a socket's.
    const address = this.address.replace(/^http(s?):/u, "ws$1:");
    const pty = openRemotePty({
      url: `${address}${path}/attach?${query}`,
      onData,
      onExit: (code) => { this.ptys.delete(pty); onExit(code); },
    });
    this.ptys.add(pty);
    return pty;
  }

  async paneFind() {
    throw notOverLink("Searching the terminal");
  }

  async paneReveal() {
    throw notOverLink("Searching the terminal");
  }

  async sendKeys(paneId, keys) {
    return this.#request(`/api/link/panes/${encodeURIComponent(paneId)}/keys`, {
      method: "POST", body: { keys }, timeoutMs: this.timeouts.write,
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
  //
  // `stream`: the body is a file, handed on as it arrives, so the clock stops
  // at the headers and the bytes are bounded by leafFile instead. Otherwise
  // the body is JSON and is read here, whole and bounded, on the clock.
  async #fileRequest(path, { method = "GET", body, headers = {}, timeoutMs = this.timeouts.read, stream = false } = {}) {
    await this.#ready();
    const call = await this.#open(path, {
      method, body, headers, timeoutMs, duplex: body === undefined ? undefined : "half",
    });
    const { response } = call;
    if (!response.ok) {
      let payload = null;
      try { payload = JSON.parse(await this.#readBody(call, MAX_ERROR_BYTES)); } catch { /* keep the status */ }
      // The leaf already decided what this is; passing its status through keeps
      // "no such folder" from arriving as a generic failure.
      const code = typeof payload?.error?.code === "string" && /^[a-z_]{1,64}$/u.test(payload.error.code)
        ? payload.error.code : "leaf_error";
      throw new FileAccessError(
        response.status,
        code,
        readable(payload?.error?.message) || `HerdRabbit at ${this.address} returned ${response.status}.`,
      );
    }
    if (stream) {
      call.done();
      return response;
    }
    const text = await this.#readBody(call, MAX_RESPONSE_BYTES);
    // A delete answers 204 with nothing at all.
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new FileAccessError(502, "leaf_error", `HerdRabbit at ${this.address} sent an answer this hub cannot read.`);
    }
  }

  async listDirectory(path, { prefix = "" } = {}) {
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    if (prefix) query.set("prefix", prefix);
    return this.#fileRequest(`/api/link/browse?${query}`);
  }

  async directoryFingerprint(path) {
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    const { fingerprint } = await this.#fileRequest(`/api/link/browse/fingerprint?${query}`);
    return fingerprint;
  }

  async home() {
    return (await this.listDirectory(null)).path;
  }

  async openFile(path, { rangeHeader = null, maxBytes = this.maxTransferBytes } = {}) {
    const response = await this.#fileRequest(
      `/api/link/browse/file?path=${encodeURIComponent(path)}`,
      { headers: rangeHeader ? { range: rangeHeader } : {}, stream: true },
    );
    const file = leafFile(response, path, maxBytes, this.timeouts.fileIdle);
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
    return this.#fileRequest("/api/link/files");
  }

  async openUpload(name) {
    const response = await this.#fileRequest(`/api/link/files/${encodeURIComponent(name)}`, { stream: true });
    const file = leafFile(response, name, this.maxTransferBytes, this.timeouts.fileIdle);
    if (file.size !== null && file.size > this.maxTransferBytes) {
      file.stream.destroy();
      throw new FileAccessError(413, "file_too_large", "That file is too large to download here.");
    }
    return file;
  }

  // The declared size travels with the body: the leaf refuses an upload it
  // cannot size, the same way this hub refuses one from a browser.
  async saveUpload(name, source, { bytes } = {}) {
    const answer = await this.#fileRequest(`/api/link/files/${encodeURIComponent(name)}`, {
      method: "POST",
      body: Readable.toWeb(source),
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes ?? 0) },
      timeoutMs: 120_000,
    });
    return answer.file;
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
    return this.#request("/api/link/workspaces", { method: "POST", body, timeoutMs: this.timeouts.write });
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
      method: "POST", body, timeoutMs: this.timeouts.write,
    });
  }

  async #workspace(workspaceId, action, body) {
    return this.#request(`/api/link/workspaces/${encodeURIComponent(workspaceId)}/${action}`, {
      method: "POST", body, timeoutMs: this.timeouts.write,
    });
  }

  // AI CLI accounts on the leaf, shaped like the local account manager so the
  // hub's routes do not care which machine they are talking to.
  aiAccounts() {
    const post = (path, body) => this.#request(`/api/link/ai-accounts${path}`, {
      method: "POST", body, timeoutMs: this.timeouts.write, accountErrors: true,
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
    for (const pty of this.ptys) pty.kill();
  }
}
