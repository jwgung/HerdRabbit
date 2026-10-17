import { Readable, Transform, pipeline } from "node:stream";
import { HerdrCommandError, TERMINAL_ID } from "./herdr-client.mjs";
import { validSize } from "./pane-attachments.mjs";
import { FileAccessError, UNKNOWN_SIZE_STREAM_BYTES } from "./file-browser.mjs";
import { LINK_PROTOCOL, ResponseTooLarge, checkLinkCompatibility, normalizeLinkSnapshot, readLimitedText } from "./link-protocol.mjs";
import { AiAccountError } from "./ai-accounts.mjs";
import { subscribeLinkStatuses } from "./link-status-stream.mjs";
import { openRemotePty } from "./link-attach.mjs";
import { ConversationError, ConversationUnavailable, HistoryChanged, TOOL_ID } from "./conversation/pages.mjs";
import { cleanCheck, cleanRunStatus } from "./app-update.mjs";

// fileIdle: how long a file being passed on may go quiet before it fails
const TIMEOUTS = { hello: 5_000, snapshot: 8_000, read: 6_000, write: 6_000, fileIdle: 60_000 };
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// A refusal is a short JSON error; nothing a connected PC says about one needs more.
const MAX_ERROR_BYTES = 64 * 1024;

function linkError(code, message, cause) {
  return new HerdrCommandError(message, { code, cause });
}

// What a connected PC on an older HerdRabbit cannot do over the link.
function tooOld(address, what) {
  return linkError("link_unsupported", `HerdRabbit at ${address} is too old for ${what}; update it there.`);
}

// What a terminal lookup may say and keep saying here: a pane that is gone ends
// the attach for good, and a PC that cannot attach is mirrored instead.
const FIND_CODES = new Set(["stale_content", "pane_not_found", "invalid_herdr_response", "herdr_timeout", "not_found"]);
const TERMINAL_CODES = new Set(["pane_not_found", "pane_not_restored", "no_terminal", "attach_unsupported", "not_found"]);
const gridSize = (value) => validSize(value) ? value : undefined;
// Why a connected PC would not start its update, passed on with its code.
const UPDATE_CODES = new Set([
  "update_running", "too_many_requests", "update_check_failed", "up_to_date", "update_blocked", "update_start_failed",
]);

// What a connected PC answers about one pane's conversation and this hub
// passes on as it is: why there is none, a cursor from another transcript,
// a malformed cursor or tool id, a tool call without output.
const CONVERSATION_CODES = new Set(["invalid_cursor", "invalid_tool_id", "tool_output_not_found", "invalid_path"]);
const REASON = /^[a-z_]{1,64}$/u;
// A page's version (its ETag) and a change signature: short base64url hashes.
const VERSION = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_VERSIONS = 16;

// The If-None-Match a connected PC is sent for the versions a browser named.
function ifNoneMatchHeader(versions) {
  if (versions === "*" || (Array.isArray(versions) && versions.includes("*"))) return "*";
  const list = (Array.isArray(versions) ? versions : [versions])
    .filter((version) => typeof version === "string" && VERSION.test(version)).slice(0, MAX_VERSIONS);
  return list.length > 0 ? list.map((version) => `"${version}"`).join(", ") : null;
}

// What a connected PC said about a pane's conversation, as the error this
// hub's own conversation service would have thrown; null for anything else.
function conversationRefusal(status, error) {
  if (error?.code === "conversation_unavailable") {
    const reason = error.details?.reason;
    return new ConversationUnavailable(typeof reason === "string" && REASON.test(reason) ? reason : "unknown");
  }
  if (error?.code === "history_changed") return new HistoryChanged();
  if (CONVERSATION_CODES.has(error?.code) && status >= 400 && status < 500) {
    return new ConversationError(status, error.code, readable(error.message) || "The connected PC refused that.");
  }
  return null;
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

// Anything the connected PC says reaches a status line in the sidebar, so it is trimmed
// and stripped of anything that would smear a log or a heading.
function readable(text) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 200);
}

function transportError(error, address) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return linkError("link_timeout", `HerdRabbit at ${address} did not answer in time.`, error);
  }
  const code = error?.cause?.code || error?.code;
  if (code === "CERT_HAS_EXPIRED" || String(code).startsWith("ERR_TLS") || String(code).startsWith("UNABLE_TO_")) {
    return linkError("link_tls", `The HTTPS certificate at ${address} was rejected.`, error);
  }
  return linkError("link_unreachable",
    `Could not reach HerdRabbit at ${address}. Check the address and that HerdRabbit is running there.`, error);
}


// The only detail an account refusal carries is which panes a switch would
// affect; anything else a connected PC sends is dropped.
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
        callback(new FileAccessError(502, "link_error", "The connected PC sent more of that file than it should have."));
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
    timer = setTimeout(() => stream.destroy(new FileAccessError(504, "link_timeout", "The connected PC stopped sending that file.")), idleMs);
    timer.unref?.();
    read(size);
  };
  return stream;
}

// `Content-Range: bytes <start>-<end>/<size>` is where a partial answer keeps
// both numbers the caller needs: how much came back, and how big the file is.
//
// The bytes are counted as they pass: a connected PC may not send more than it said,
// nor more than `maxBytes`, nor -- saying nothing -- more than a file of
// unknown size may be. One that does is cut off with an error, so the
// download fails rather than ends looking whole.
function linkedFile(response, path, maxBytes = Infinity, idleMs = TIMEOUTS.fileIdle) {
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
export class LinkClient {
  #handshake = null;
  // What the PC said it answers beyond the base protocol (its hello's features).
  #features = new Set();
  // What the other PC last said it runs, kept when it could not be connected
  // too, so Details can show both sides' versions.
  #remote = null;

  constructor({ profile, hubVersion, fetchImpl = globalThis.fetch, subscribe = subscribeLinkStatuses, maxTransferBytes = Infinity, timeouts = TIMEOUTS }) {
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

  // One call to the connected PC. The clock runs until `done` is called -- after the
  // body is read, for an answer that is read whole -- so a connected PC that answers
  // its headers and then trickles cannot hold a request open for good.
  async #open(path, { method = "GET", body, headers = {}, timeoutMs, duplex }) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new DOMException("The connected PC did not answer in time.", "TimeoutError")), timeoutMs);
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
    // 304 is the one 3xx that is an answer: an unchanged conversation page.
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await response.body?.cancel().catch(() => {});
      done();
      throw linkError("link_error", `HerdRabbit at ${this.address} answered with a redirect, which this hub does not follow.`);
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
        throw linkError("link_error", `HerdRabbit at ${this.address} sent more than this hub will read.`);
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
      // active" is not flattened into "the connected PC is broken".
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
        throw linkError("link_not_linked",
          `${this.address} is a HerdRabbit page, not its Connect PC port. Use the address its Connect PC setting shows.`);
      }
      if (response.status === 401 || response.status === 403) {
        throw linkError("link_unauthorized", payload?.error?.code === "peer_not_allowed"
          ? `HerdRabbit at ${this.address} does not accept other PCs yet. Add this PC to its allowed list there.`
          : `HerdRabbit at ${this.address} does not allow this PC. Add this PC to its allowed list there.`);
      }
      if (response.status === 404) {
        throw linkError("link_not_linked",
          `${this.address} answered, but not as a HerdRabbit Connect PC port.`);
      }
      const message = readable(payload?.error?.message) || `HerdRabbit at ${this.address} returned ${response.status}.`;
      throw linkError(payload?.error?.code?.startsWith?.("link_") ? payload.error.code : "link_error", message);
    }
    if (payload === null || typeof payload !== "object") {
      throw linkError("link_not_herdrabbit", `That address answered, but it is not a HerdRabbit server.`);
    }
    return payload;
  }

  #verify(hello) {
    const result = checkLinkCompatibility(
      { hubVersion: this.hubVersion, hubProtocol: LINK_PROTOCOL, serverName: `"${this.profile.name}"` },
      hello,
    );
    this.#remote = result.version ? { version: result.version, protocol: result.protocol ?? null } : null;
    if (!result.ok) {
      this.#handshake = null;
      throw linkError(result.code, result.reason);
    }
    this.#handshake = result;
    this.#features = new Set((Array.isArray(hello?.features) ? hello.features : [])
      .filter((feature) => typeof feature === "string" && /^[a-z_]{1,32}$/u.test(feature)).slice(0, 32));
  }

  async snapshot() {
    // The handshake rides along, so an incompatible connected PC is caught on the same
    // poll that would have merged its records.
    const body = await this.#request("/api/link/snapshot", { timeoutMs: this.timeouts.snapshot, checked: true });
    this.#verify(body.hello);
    return normalizeLinkSnapshot(body.snapshot);
  }

  // `source` reaches the PC too, so a prompt card there reads the region
  // herdr reads agent states from, as it would here; a PC from before this
  // ignores it.
  async readPane(paneId, { lines = 160, format = "ansi", source } = {}) {
    const query = new URLSearchParams({ lines: String(lines), format });
    if (source !== undefined) query.set("source", source);
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

  // Find and reveal run on the connected PC, against its own Herdr; a history
  // that changed since the match before stays a 409 stale_content here too.
  async paneFind(paneId, request) {
    return this.#search(`/api/link/panes/${encodeURIComponent(paneId)}/find`, request);
  }

  async paneReveal(paneId, request) {
    return this.#search(`/api/link/panes/${encodeURIComponent(paneId)}/reveal`, request);
  }

  // A PC that does not name scroll_bottom has no such route: nothing is asked.
  async paneScrollToBottom(paneId) {
    if (!this.#features.has("scroll_bottom")) return { scroll: null };
    return this.#search(`/api/link/panes/${encodeURIComponent(paneId)}/scroll-bottom`, {});
  }

  // The `/` commands one of the PC's panes takes, which it builds from its
  // own files and snapshot. A PC that does not name commands has no such
  // route: nothing is asked, and null says so.
  async paneCommands(paneId) {
    await this.#ready();
    if (!this.#features.has("commands")) return null;
    return this.#request(`/api/link/panes/${encodeURIComponent(paneId)}/commands`, { timeoutMs: this.timeouts.read });
  }

  // The PC's own update. A PC that does not name `update` has no such
  // routes: nothing is asked, and null says it is too old to be updated
  // from here. What comes back is held to the shape this hub shows.
  async updateCheck({ fresh = false } = {}) {
    await this.#ready();
    if (!this.#features.has("update")) return null;
    return cleanCheck(await this.#request(`/api/link/update${fresh ? "?fresh=1" : ""}`, { timeoutMs: 45_000 }));
  }

  async updateStatus() {
    await this.#ready();
    if (!this.#features.has("update")) return null;
    return cleanRunStatus(await this.#request("/api/link/update/run", { timeoutMs: this.timeouts.read }));
  }

  async updateRun() {
    await this.#ready();
    if (!this.#features.has("update")) throw tooOld(this.address, "updating from here");
    return cleanRunStatus(await this.#request("/api/link/update/run", {
      method: "POST", timeoutMs: 60_000, codes: UPDATE_CODES,
    }));
  }

  async #search(path, request) {
    try {
      return await this.#request(path, { method: "POST", body: request, timeoutMs: this.timeouts.write, codes: FIND_CODES });
    } catch (error) {
      // A PC from before find went over the link has no such route.
      if (error.code === "not_found") throw tooOld(this.address, "searching its terminals");
      throw error;
    }
  }

  // Conversations. The connected PC reads its own transcripts (it has the
  // files, and for Codex the processes and screen that tell which is the
  // pane's); this hub only relays. What it says about a pane comes back as the
  // error this hub's own service would throw; a PC from before this has no
  // such routes and reads as one to update.
  async #conversation(path, { headers = {} } = {}) {
    await this.#ready();
    // Asked only of a PC that said it answers it, not guessed from a 404.
    if (!this.#features.has("conversation")) throw new ConversationUnavailable("linked_pc_old");
    const call = await this.#open(path, { headers, timeoutMs: this.timeouts.read });
    const { response } = call;
    const etag = response.headers.get("etag");
    if (response.status === 304) {
      await response.body?.cancel().catch(() => {});
      call.done();
      return { notModified: true, etag, body: null };
    }
    const text = await this.#readBody(call, response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BYTES);
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* handled below */ }
    if (!response.ok) {
      const refusal = conversationRefusal(response.status, payload?.error);
      if (refusal) throw refusal;
      if (response.status === 401 || response.status === 403) {
        throw linkError("link_unauthorized", `HerdRabbit at ${this.address} does not allow this PC. Add this PC to its allowed list there.`);
      }
      throw linkError("link_error", readable(payload?.error?.message) || `HerdRabbit at ${this.address} returned ${response.status}.`);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw linkError("link_error", `HerdRabbit at ${this.address} sent an answer this hub cannot read.`);
    }
    return { notModified: false, etag, body: payload };
  }

  #unreadable() {
    return linkError("link_error", `HerdRabbit at ${this.address} sent an answer this hub cannot read.`);
  }

  // A page of turns, as this hub's own page read answers one: the page with
  // its version, or { notModified, version } for versions the browser holds.
  async conversationPage(paneId, { before, since, ifNoneMatch } = {}) {
    const query = new URLSearchParams();
    if (before !== undefined) query.set("before", before);
    if (since !== undefined) query.set("since", since);
    const tags = ifNoneMatchHeader(ifNoneMatch);
    const answer = await this.#conversation(
      `/api/link/panes/${encodeURIComponent(paneId)}/conversation${query.size > 0 ? `?${query}` : ""}`,
      { headers: tags ? { "if-none-match": tags } : {} },
    );
    if (answer.notModified) {
      const version = /^"(.*)"$/u.exec(answer.etag ?? "")?.[1];
      if (!VERSION.test(version ?? "")) throw this.#unreadable();
      return { notModified: true, version };
    }
    const page = answer.body;
    if (typeof page.version !== "string" || !VERSION.test(page.version) || !Array.isArray(page.turns)) throw this.#unreadable();
    return page;
  }

  async conversationToolOutput(paneId, toolId) {
    if (typeof toolId !== "string" || !TOOL_ID.test(toolId)) {
      throw new ConversationError(400, "invalid_tool_id", "That tool call id is not valid.");
    }
    const { body } = await this.#conversation(
      `/api/link/panes/${encodeURIComponent(paneId)}/conversation/tools/${encodeURIComponent(toolId)}`,
    );
    if (typeof body.output !== "string" || !Number.isSafeInteger(body.output_size)) throw this.#unreadable();
    return { id: toolId, output: body.output, output_size: body.output_size, truncated: body.truncated === true };
  }

  // A value that changes whenever the pane's conversation does: what this
  // hub's monitor polls instead of a file's stat.
  async conversationSignature(paneId) {
    const { body } = await this.#conversation(`/api/link/panes/${encodeURIComponent(paneId)}/conversation/signature`);
    if (typeof body.signature !== "string" || !VERSION.test(body.signature)) throw this.#unreadable();
    return body.signature;
  }

  // The plan or question the pane's Claude waits on, { name, input } or null:
  // the whole words a prompt card shows. Anything that fails is none.
  async conversationPendingAsk(paneId) {
    try {
      const { body } = await this.#conversation(`/api/link/panes/${encodeURIComponent(paneId)}/pending-ask`);
      const ask = body.ask;
      if (!ask || typeof ask !== "object" || typeof ask.name !== "string" || ask.name.length > 64 ||
          !ask.input || typeof ask.input !== "object" || Array.isArray(ask.input)) return null;
      return { name: ask.name, input: ask.input };
    } catch {
      return null;
    }
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

  // Files. The connected PC answers these with its own local browser, so nothing here
  // needs to know how to read a disk -- only how to ask.
  //
  // `stream`: the body is a file, handed on as it arrives, so the clock stops
  // at the headers and the bytes are bounded by linkedFile instead. Otherwise
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
      // The connected PC already decided what this is; passing its status through keeps
      // "no such folder" from arriving as a generic failure.
      const code = typeof payload?.error?.code === "string" && /^[a-z_]{1,64}$/u.test(payload.error.code)
        ? payload.error.code : "link_error";
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
      throw new FileAccessError(502, "link_error", `HerdRabbit at ${this.address} sent an answer this hub cannot read.`);
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
    const file = linkedFile(response, path, maxBytes, this.timeouts.fileIdle);
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
    const file = linkedFile(response, name, this.maxTransferBytes, this.timeouts.fileIdle);
    if (file.size !== null && file.size > this.maxTransferBytes) {
      file.stream.destroy();
      throw new FileAccessError(413, "file_too_large", "That file is too large to download here.");
    }
    return file;
  }

  // The declared size travels with the body: the connected PC refuses an upload it
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

  // Project and tab changes. The connected PC runs them through its own Herdr client,
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

  // AI CLI accounts on the connected PC, shaped like the local account manager so the
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
