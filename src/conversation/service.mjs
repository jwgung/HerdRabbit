// A pane's conversation, from the pane id the browser knows: which agent it
// runs (Claude Code, Codex or OpenCode, each with its own format), which file
// (or, for OpenCode, which session of its database) of this machine's holds
// it, and the page or tool output asked for. A PC connected with Connect PC
// reads its own transcripts: its panes' pages, tool output, change signature and
// pending plan or question are asked of it over its link, never read here.
import { createHash, randomUUID } from "node:crypto";
import { CLAUDE_TRANSCRIPT, SESSION_ID, locateClaudeTranscript, pendingClaudeAsk, readTail } from "./claude.mjs";
import { CODEX_TRANSCRIPT, THREAD_ID, isCodexProcess, locateCodexRollout } from "./codex.mjs";
import { KIRO_TRANSCRIPT, SESSION_ID as KIRO_SESSION_ID, kiroWorkspaceHash } from "./kiro.mjs";
import { OPENCODE_SESSION, OPENCODE_SESSION_ID } from "./opencode.mjs";
import { opencodeRunningVersion } from "./opencode-process.mjs";
import {
  ConversationError,
  ConversationUnavailable,
  HistoryChanged,
  TOOL_ID,
  answerVersion,
  isReadBusy,
  transcriptPage,
  transcriptToolOutput,
  versionMatches, remember } from "./pages.mjs";
import { paneAgentName } from "../pane-agent.mjs";
import { localTranscriptStore } from "./stores.mjs";

const LOCAL = "local";
// A located file is trusted this long before it is looked up again; a
// session with no file yet is looked for again sooner.
const LOCATE_TTL_MS = 5_000;
const MISSING_LOCATE_TTL_MS = 2_000;
// The screen a Codex pane is matched by, as a last resort.
const MATCH_SCREEN_LINES = 400;

const FORMATS = { claude: CLAUDE_TRANSCRIPT, codex: CODEX_TRANSCRIPT, opencode: OPENCODE_SESSION, kiro: KIRO_TRANSCRIPT };

// What a link's client must answer for its panes' conversations to be relayed.
const LINK_CALLS = ["conversationPage", "conversationToolOutput", "conversationSignature", "conversationPendingAsk"];

// How much of a transcript's end is read for the call a prompt card waits on:
// the call is the last thing Claude wrote, a long plan included.
const ASK_TAIL_BYTES = 2 * 1024 * 1024;
// Panes whose last read call is kept, at most.
const MAX_REMEMBERED_ASKS = 64;

export class ConversationService {
  constructor({
    herdr,
    localStore = localTranscriptStore(),
    now = () => Date.now(),
    runningVersion = opencodeRunningVersion(),
  }) {
    this.herdr = herdr;
    // pids -> the version of the OpenCode program among them, or null
    this.runningVersion = runningVersion;
    this.localStore = localStore;
    this.now = now;
    this.located = new Map();
    // serverId -> { client, store }: what the monitor stats a connected PC's panes through
    this.linkStores = new Map();
    // paneId -> { key, ask }: the asking tool call last read from that file version
    this.asks = new Map();
    // paneId -> { key, version }: the agent version last read for that session state
    this.versions = new Map();
    // Signatures handed out are hashed with this, so they say nothing of the file.
    this.salt = randomUUID();
  }

  // A pane of a PC connected with Connect PC: { serverId, id, client }, the
  // id being that PC's own; null for a pane this server reads itself.
  #linked(paneId) {
    const linked = this.herdr.linkedPane?.(paneId);
    return linked && LINK_CALLS.every((name) => typeof linked.client?.[name] === "function") ? linked : null;
  }

  // A connected PC that cannot be reached has no conversation to show here;
  // what it said itself about a pane (ConversationError) is passed on as it is.
  async #relay(work, paneId = null) {
    try {
      return await work();
    } catch (error) {
      // A PC from before an agent was supported answers "not supported" for it;
      // this hub knows the agent is one it supports, so that PC needs updating.
      if (error instanceof ConversationUnavailable && error.reason === "not_supported_agent" && paneId !== null) {
        let pane = null;
        try { pane = ((await this.herdr.snapshot())?.panes ?? []).find((candidate) => candidate?.pane_id === paneId); } catch { /* keeps its own answer */ }
        if (pane && FORMATS[paneAgentName(pane)]) throw new ConversationUnavailable("linked_pc_old");
      }
      if (error instanceof ConversationError) throw error;
      throw new ConversationUnavailable("server_unavailable");
    }
  }

  // The store the monitor stats a connected PC's pane through: each "stat" is
  // one signature asked of that PC, which changes whenever its own monitor
  // would have said so. One per PC, so the monitor sees the same store again.
  #linkStore(linked) {
    const known = this.linkStores.get(linked.serverId);
    if (known?.client === linked.client) return known.store;
    const store = {
      key: `link:${linked.serverId}`,
      remote: true,
      stat: async (id) => {
        try {
          return { identity: await linked.client.conversationSignature(id), size: 0, mtimeMs: 0 };
        } catch (error) {
          // what the PC said about the pane is a state of its own to report
          // a database busy this time says nothing new: the next stat asks again
          if (isReadBusy(error)) throw error;
          if (error instanceof ConversationUnavailable) return { identity: `unavailable:${error.reason}`, size: 0, mtimeMs: 0 };
          throw error;
        }
      },
    };
    this.linkStores.set(linked.serverId, { client: linked.client, store });
    return store;
  }

  // A short value that changes whenever the pane's conversation does (the
  // file, its size or time, the session, why it cannot be read), and says
  // nothing else: what a hub's monitor polls for this PC's pane.
  async signature(paneId) {
    let observed;
    try {
      const target = await this.resolve(paneId);
      if (target.path === null) observed = `unwritten\0${target.serverId}\0${target.session}`;
      else {
        const stat = await target.store.stat(target.path);
        if (!stat) this.forget(target);
        observed = stat
          ? `file\0${target.serverId}\0${target.path}\0${stat.identity}\0${stat.size}\0${stat.mtimeMs}`
          : `missing\0${target.serverId}\0${target.path}`;
      }
    } catch (error) {
      // busy this time is no change of the conversation: the hub's stat says nothing and asks again
      if (!(error instanceof ConversationUnavailable) || isReadBusy(error)) throw error;
      observed = `unavailable\0${error.reason}`;
    }
    return createHash("sha256").update(`${this.salt}\0${paneId}\0${observed}`).digest("base64url").slice(0, 22);
  }

  // The plan or question a Claude pane's agent waits on, from its transcript's
  // tail, or the question an OpenCode pane's waits on, from its database:
  // { name, input } or null. Any other pane, or one whose record cannot be
  // read, has none. Read again only when the file (or session) changed.
  // `snapshot`: a herdr snapshot already in hand, so a watch looking at many
  // panes asks herdr once.
  async pendingAsk(paneId, snapshot = null) {
    try {
      const linked = this.#linked(paneId);
      if (linked) return await linked.client.conversationPendingAsk(linked.id);
      const found = await this.resolve(paneId, snapshot);
      if (found.agent === "opencode") return found.path ? await this.#pendingQuestion(paneId, found) : null;
      if (found.agent !== "claude" || !found.path) return null;
      const stat = await found.store.stat(found.path);
      if (!stat) return null;
      const key = `${found.serverId}\0${found.path}\0${stat.identity}\0${stat.size}\0${stat.mtimeMs}`;
      const known = this.asks.get(paneId);
      if (known?.key === key) return known.ask;
      const ask = pendingClaudeAsk(await readTail(found.store, found.path, stat, ASK_TAIL_BYTES));
      remember(this.asks, paneId, { key, ask }, MAX_REMEMBERED_ASKS);
      return ask;
    } catch {
      return null;
    }
  }

  // The version of the agent a pane runs, or null: for an OpenCode pane whose
  // session is read, the version of the OpenCode program running in the pane
  // (it draws the screen), or where that cannot be told, the version that
  // created the pane's session (its database's session row, which a newer
  // OpenCode carrying the session on leaves as it was). What a prompt card's
  // reader was checked against is told by it; any other pane, or one that
  // cannot be read, has none. A connected PC's pane is the PC's to read: its
  // screen, its processes and its database are all there.
  async agentVersion(paneId, snapshot = null) {
    try {
      const linked = this.#linked(paneId);
      if (linked) return typeof linked.client.conversationAgentVersion === "function" ? await linked.client.conversationAgentVersion(linked.id) : null;
      const found = await this.resolve(paneId, snapshot);
      if (found.agent !== "opencode" || !found.path) return null;
      const stat = await found.store.stat(found.session);
      if (!stat) return null;
      const key = `${found.serverId}\0opencode\0${found.session}\0${stat.identity}`;
      const known = this.versions.get(paneId);
      let version = known?.key === key ? known.version : undefined;
      if (version === undefined) {
        version = await found.store.sessionVersion(found.session);
        remember(this.versions, paneId, { key, version }, MAX_REMEMBERED_ASKS);
      }
      if (version === null) return null;
      return (await this.#runningOpencodeVersion(paneId)) ?? version;
    } catch {
      return null;
    }
  }

  // The question an OpenCode session waits on, read again only once the
  // session changed.
  async #pendingQuestion(paneId, found) {
    const stat = await found.store.stat(found.session);
    if (!stat) return null;
    const key = `${found.serverId}\0opencode\0${found.session}\0${stat.identity}`;
    const known = this.asks.get(paneId);
    if (known?.key === key) return known.ask;
    const ask = await found.store.pendingQuestion(found.session);
    remember(this.asks, paneId, { key, ask }, MAX_REMEMBERED_ASKS);
    return ask;
  }

  // Only this machine's transcripts are read here: a connected PC's pane is
  // its own to read (#linked), and any other server has none to offer.
  #store(serverId) {
    return serverId === LOCAL ? this.localStore : null;
  }

  // A pane of a server with no store here: nothing to read it from.
  #noStore() {
    return new ConversationUnavailable("server_unavailable");
  }

  // The pane's transcript: { paneId, serverId, agent, format, store, session,
  // path }, path null while the session has written nothing. Throws
  // ConversationUnavailable. `given` is a snapshot already in hand.
  async resolve(paneId, given = null) {
    if (typeof paneId !== "string" || !paneId || paneId.length > 512) throw new ConversationUnavailable("pane_not_found");
    // A connected PC's pane is the PC's to look up; the monitor stats it through its link.
    const linked = this.#linked(paneId);
    if (linked) {
      return { paneId, serverId: linked.serverId, agent: null, format: null, store: this.#linkStore(linked), session: "", path: linked.id, key: null, linked };
    }
    const snapshot = given ?? await this.herdr.snapshot();
    const pane = (snapshot?.panes ?? []).find((candidate) => candidate?.pane_id === paneId);
    if (!pane) throw new ConversationUnavailable("pane_not_found");
    const agent = paneAgentName(pane);
    const format = FORMATS[agent];
    if (!format) throw new ConversationUnavailable("not_supported_agent");
    const reported = pane.agent_session && typeof pane.agent_session === "object" ? pane.agent_session : null;
    // a session another agent left behind says nothing about this one
    const own = reported && (typeof reported.agent !== "string" || reported.agent.toLowerCase() === agent) ? reported : null;
    const serverId = typeof pane.server_id === "string" && pane.server_id ? pane.server_id : LOCAL;
    const cwds = [pane.cwd, pane.foreground_cwd].filter((cwd) => typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 4096);
    if (agent === "claude") {
      // Herdr's Claude hook reports the session by id; a path or anything else is not one.
      const reportedSession = own && (own.kind === undefined || own.kind === "id") ? own.value : null;
      const store = this.#store(serverId);
      if (!store) throw this.#noStore();
      // The session the pane's Claude process runs wins over herdr's report: after
      // a /branch or /resume the hook may still name the session left behind.
      const running = await this.#located(`claude-pid\0${serverId}\0${paneId}\0${reportedSession}`, () => this.#claudeRunningSession(store, paneId));
      const session = running.value ?? reportedSession;
      if (typeof session !== "string" || !SESSION_ID.test(session)) throw new ConversationUnavailable("no_session_id");
      const found = await this.#located(`claude\0${serverId}\0${session}\0${cwds.join("\0")}`,
        () => locateClaudeTranscript(store, session, cwds));
      return { paneId, serverId, agent, format, store, session, path: found.value, key: found.key };
    }
    if (agent === "opencode") return this.#resolveOpencode(paneId, { serverId, agent, format, own, pane, panes: snapshot?.panes ?? [] });
    if (agent === "kiro") return this.#resolveKiro(paneId, { serverId, agent, format, own, cwds });
    return this.#resolveCodex(paneId, { serverId, agent, format, own, cwds });
  }

  // Kiro writes its transcript under a directory named for the workspace it ran
  // in: `<config>/sessions/<sha256(cwd) first 16 hex>/sess_<uuid>/messages.jsonl`.
  // Herdr reports no Kiro session id, so the pane's cwd names the workspace
  // directory and the newest `sess_` in it is the pane's conversation. With more
  // than one cwd (foreground and start), each is tried in turn.
  async #resolveKiro(paneId, { serverId, agent, format, own, cwds }) {
    const store = this.#store(serverId)?.kiro;
    if (!store) throw this.#noStore();
    // Herdr may one day report a session id; prefer it when it is a sess uuid.
    const reported = own && (own.kind === undefined || own.kind === "id") && typeof own.value === "string"
      && KIRO_SESSION_ID.test(own.value) ? own.value : null;
    const hashes = cwds.map((cwd) => kiroWorkspaceHash(cwd)).filter((hash) => hash !== null);
    const found = await this.#located(`kiro\0${serverId}\0${reported ?? ""}\0${hashes.join("\0")}`,
      () => store.locate({ session: reported, hashes }));
    if (found.value === null) {
      // nothing names the workspace or its session yet: wait for herdr to report the pane
      throw new ConversationUnavailable(hashes.length === 0 ? "no_session_id" : "transcript_missing");
    }
    const { session, path } = found.value;
    return { paneId, serverId, agent, format, store: this.#store(serverId), session, path, key: found.key };
  }

  // OpenCode's session is a row of its database: the store is that database,
  // the "path" the session's id. Herdr's OpenCode plugin reports the session
  // shown; with none reported, the newest one begun in the pane's folder.
  async #resolveOpencode(paneId, { serverId, agent, format, own, pane, panes }) {
    const store = this.#store(serverId)?.opencode;
    if (!store) throw this.#noStore();
    const reportedBy = (candidate) => candidate && (candidate.kind === undefined || candidate.kind === "id")
      && typeof candidate.value === "string" && OPENCODE_SESSION_ID.test(candidate.value) ? candidate.value : null;
    const reported = reportedBy(own);
    // herdr named a session but not one that can be read: showing the folder's newest instead would show another conversation
    if (reported === null && own && own.value !== undefined && own.value !== null && own.value !== "") {
      throw new ConversationUnavailable("no_session_id");
    }
    const cwdOf = (candidate) => [candidate.foreground_cwd, candidate.cwd]
      .find((value) => typeof value === "string" && value.startsWith("/") && value.length <= 4096) ?? null;
    const cwd = cwdOf(pane);
    // Without a reported id the folder's newest session is the pane's only if no other
    // OpenCode pane of that folder could equally claim it.
    const taken = [];
    if (reported === null && cwd !== null) {
      for (const peer of panes) {
        if (!peer || peer === pane || peer.pane_id === paneId || paneAgentName(peer) !== "opencode") continue;
        const peerServer = typeof peer.server_id === "string" && peer.server_id ? peer.server_id : LOCAL;
        if (peerServer !== serverId || cwdOf(peer) !== cwd) continue;
        const session = peer.agent_session && typeof peer.agent_session === "object" ? peer.agent_session : null;
        const peerId = reportedBy(session && (typeof session.agent !== "string" || session.agent.toLowerCase() === "opencode") ? session : null);
        if (peerId === null) throw new ConversationUnavailable("no_session_id");
        taken.push(peerId);
      }
      taken.sort();
    }
    const found = await this.#located(`opencode\0${serverId}\0${reported ?? ""}\0${reported ? "" : cwd ?? ""}\0${taken.join(",")}`,
      () => store.locate({ session: reported, cwd: reported ? null : cwd, taken }));
    if (found.value === null) {
      if (reported === null) throw new ConversationUnavailable("no_session_id");
      // a session herdr reports that OpenCode has not written yet reads as no turns
      return { paneId, serverId, agent, format, store, session: reported, path: null, key: found.key };
    }
    // a subagent's session whose top-level session is not there: no conversation of the pane's to show
    if (found.value.child) throw new ConversationUnavailable("no_session_id");
    const { session, found: written } = found.value;
    return { paneId, serverId, agent, format, store, session, path: written ? session : null, key: found.key };
  }

  async #resolveCodex(paneId, { serverId, agent, format, own, cwds }) {
    const store = this.#store(serverId);
    if (!store) throw this.#noStore();
    const session = own && typeof own.value === "string" && own.value.length <= 4096
      ? { kind: own.kind, value: own.value } : null;
    const thread = session && (session.kind === undefined || session.kind === "id") && THREAD_ID.test(session.value) ? session.value : null;
    // per pane: the open files and the screen that may decide it are the pane's own
    const found = await this.#located(`codex\0${serverId}\0${paneId}\0${session?.kind ?? ""}\0${session?.value ?? ""}\0${cwds.join("\0")}`,
      async () => locateCodexRollout(store, {
        session,
        cwd: cwds[0] ?? null,
        pids: await this.#codexPids(paneId),
        readScreen: () => this.herdr.readPane(paneId, { lines: MATCH_SCREEN_LINES, format: "text", source: "recent-unwrapped" }),
      }));
    // nothing names the session and nothing tells which file is the pane's: wait for herdr to report it
    if (found.value === null && thread === null) {
      throw new ConversationUnavailable(session?.kind === "path" ? "transcript_missing" : "no_session_id");
    }
    // a thread herdr reported that Codex has not written yet reads as no turns
    return { paneId, serverId, agent, format, store, session: thread ?? session?.value ?? "", path: found.value, key: found.key };
  }

  // The version of the OpenCode program among the pane's processes, by herdr's
  // process info; null when this herdr or this system cannot tell.
  async #runningOpencodeVersion(paneId) {
    if (typeof this.herdr.paneProcessInfo !== "function" || typeof this.runningVersion !== "function") return null;
    try {
      const info = await this.herdr.paneProcessInfo(paneId);
      const processes = info?.process_info?.foreground_processes ?? info?.foreground_processes ?? [];
      return Array.isArray(processes) ? await this.runningVersion(processes.map((item) => item?.pid)) : null;
    } catch {
      return null;
    }
  }

  // The one session the pane's foreground processes run Claude on, by Claude's
  // per-process registry; null when none or more than one says (then herdr's
  // report decides).
  async #claudeRunningSession(store, paneId) {
    if (typeof this.herdr.paneProcessInfo !== "function" || typeof store.sessionsOfPids !== "function") return null;
    try {
      const info = await this.herdr.paneProcessInfo(paneId);
      const processes = info?.process_info?.foreground_processes ?? info?.foreground_processes ?? [];
      if (!Array.isArray(processes)) return null;
      const sessions = await store.sessionsOfPids(processes.map((item) => item?.pid));
      return sessions.length === 1 ? sessions[0] : null;
    } catch {
      return null;
    }
  }

  // The pids of the pane's Codex processes, by herdr's process info; none
  // when this herdr cannot tell.
  async #codexPids(paneId) {
    if (typeof this.herdr.paneProcessInfo !== "function") return [];
    try {
      const info = await this.herdr.paneProcessInfo(paneId);
      const processes = info?.process_info?.foreground_processes ?? info?.foreground_processes ?? [];
      return Array.isArray(processes)
        ? processes.filter((item) => Number.isSafeInteger(item?.pid) && isCodexProcess(item.argv)).map((item) => item.pid)
        : [];
    } catch {
      return [];
    }
  }

  async #located(key, locate) {
    const now = this.now();
    let entry = this.located.get(key);
    if (!entry || entry.expires <= now) {
      const value = await locate();
      entry = { value, expires: now + (value ? LOCATE_TTL_MS : MISSING_LOCATE_TTL_MS) };
      this.located.delete(key);
      this.located.set(key, entry);
      if (this.located.size > 256) this.located.delete(this.located.keys().next().value);
    }
    return { value: entry.value, key };
  }

  // A file that went away is looked up afresh next time.
  forget(target) {
    if (target?.key) this.located.delete(target.key);
  }

  async page(paneId, { before, since, ifNoneMatch } = {}) {
    const linked = typeof paneId === "string" && paneId.length <= 512 ? this.#linked(paneId) : null;
    if (linked) return this.#relay(() => linked.client.conversationPage(linked.id, { before, since, ifNoneMatch }), paneId);
    const target = await this.resolve(paneId);
    if (target.path === null) {
      // the agent writes the file with its first message: until then there is
      // nothing before, and a cursor into it is another conversation's
      if (before !== undefined || since !== undefined) throw new HistoryChanged();
      const version = answerVersion(`unwritten\0${target.agent}\0${target.serverId}`, target.session);
      if (versionMatches(ifNoneMatch, version)) return { notModified: true, version };
      return {
        source: target.format.source, turns: [], metadata: { model: null, reasoning_effort: null },
        cursor: null, history_id: `unwritten-${target.session}`, version,
      };
    }
    try {
      if (target.agent === "opencode") return await target.store.page(target.path, { before, since, ifNoneMatch });
      return await transcriptPage(target.format, target.store, target.path, { before, since, ifNoneMatch });
    } catch (error) {
      if (error instanceof ConversationUnavailable && !isReadBusy(error)) this.forget(target);
      throw error;
    }
  }

  // The whole output of one tool call, capped. Throws a 404 when there is none.
  async toolOutput(paneId, toolId) {
    if (typeof toolId !== "string" || !TOOL_ID.test(toolId)) {
      throw new ConversationError(400, "invalid_tool_id", "That tool call id is not valid.");
    }
    const linked = typeof paneId === "string" && paneId.length <= 512 ? this.#linked(paneId) : null;
    if (linked) return this.#relay(() => linked.client.conversationToolOutput(linked.id, toolId), paneId);
    const target = await this.resolve(paneId);
    if (target.path === null) throw new ConversationError(404, "tool_output_not_found", "That tool call has no output.");
    let found;
    try {
      found = target.agent === "opencode"
        ? await target.store.toolOutput(target.path, toolId)
        : await transcriptToolOutput(target.format, target.store, target.path, toolId);
    } catch (error) {
      if (error instanceof ConversationUnavailable && !isReadBusy(error)) this.forget(target);
      throw error;
    }
    if (found === null) throw new ConversationError(404, "tool_output_not_found", "That tool call has no output.");
    return { id: toolId, output: found.output, output_size: found.size, truncated: found.size > found.output.length };
  }
}
