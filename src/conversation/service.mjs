// A pane's conversation, from the pane id the browser knows: which agent it
// runs (Claude Code or Codex, each with its own format), which server's store
// holds it (this machine's files, or a Herdr machine's over SSH), which file,
// and the page or tool output asked for.
import { CLAUDE_TRANSCRIPT, SESSION_ID, locateClaudeTranscript, pendingClaudeAsk, readTail } from "./claude.mjs";
import { CODEX_TRANSCRIPT, THREAD_ID, isCodexProcess, locateCodexRollout } from "./codex.mjs";
import {
  ConversationError,
  ConversationUnavailable,
  HistoryChanged,
  TOOL_ID,
  answerVersion,
  transcriptPage,
  transcriptToolOutput,
  versionMatches, remember } from "./pages.mjs";
import { localTranscriptStore, machineTranscriptStore } from "./stores.mjs";

const LOCAL = "local";
// A located file is trusted this long before it is looked up again; a
// session with no file yet is looked for again sooner.
const LOCATE_TTL_MS = 5_000;
const MISSING_LOCATE_TTL_MS = 2_000;
// The screen a Codex pane is matched by, as a last resort.
const MATCH_SCREEN_LINES = 400;

const FORMATS = { claude: CLAUDE_TRANSCRIPT, codex: CODEX_TRANSCRIPT };

// The agent the snapshot names for the pane, lower case, or null.
export function paneAgentName(pane) {
  const reported = pane?.agent_session && typeof pane.agent_session === "object" ? pane.agent_session : null;
  const name = [pane?.agent, reported?.agent].find((value) => typeof value === "string" && value.trim());
  return name ? name.trim().toLowerCase() : null;
}

// How much of a transcript's end is read for the call a prompt card waits on:
// the call is the last thing Claude wrote, a long plan included.
const ASK_TAIL_BYTES = 2 * 1024 * 1024;
// Panes whose last read call is kept, at most.
const MAX_REMEMBERED_ASKS = 64;

export class ConversationService {
  constructor({
    herdr,
    localStore = localTranscriptStore(),
    // A Herdr machine's store, from the file client its SSH connection gives.
    remoteStore = (serverId) => {
      const files = herdr.fileClient?.(serverId);
      if (!files?.locateClaudeTranscript) return null;
      // one store per file client: a new one every call would never compare equal
      const known = this.machineStores.get(serverId);
      if (known?.files === files) return known.store;
      const store = machineTranscriptStore(serverId, files);
      this.machineStores.set(serverId, { files, store });
      return store;
    },
    now = () => Date.now(),
  }) {
    this.herdr = herdr;
    this.machineStores = new Map();
    this.localStore = localStore;
    this.remoteStore = remoteStore;
    this.now = now;
    this.located = new Map();
    this.remoteStores = new Map();
    // paneId -> { key, ask }: the asking tool call last read from that file version
    this.asks = new Map();
  }

  // The plan or question a Claude pane's agent waits on, from its transcript's
  // tail: { name, input } or null. A pane that is not Claude's, or whose
  // transcript cannot be read, has none. Read again only when the file changed.
  async pendingAsk(paneId) {
    try {
      const found = await this.resolve(paneId);
      if (found.agent !== "claude" || !found.path) return null;
      const stat = await found.store.stat(found.path);
      if (!stat) return null;
      const key = `${found.path}\0${stat.identity}\0${stat.size}\0${stat.mtimeMs}`;
      const known = this.asks.get(paneId);
      if (known?.key === key) return known.ask;
      const ask = pendingClaudeAsk(await readTail(found.store, found.path, stat, ASK_TAIL_BYTES));
      remember(this.asks, paneId, { key, ask }, MAX_REMEMBERED_ASKS);
      return ask;
    } catch {
      return null;
    }
  }

  #store(serverId) {
    if (serverId === LOCAL) return this.localStore;
    const store = this.remoteStore(serverId);
    if (!store) return null;
    // One store per machine, so its identity (and cached reads) carry over.
    const known = this.remoteStores.get(serverId);
    if (known && (known === store || known.locate === store.locate)) return known;
    this.remoteStores.set(serverId, store);
    return store;
  }

  // The pane's transcript: { paneId, serverId, agent, format, store, session,
  // path }, path null while the session has written nothing. Throws
  // ConversationUnavailable.
  async resolve(paneId) {
    if (typeof paneId !== "string" || !paneId || paneId.length > 512) throw new ConversationUnavailable("pane_not_found");
    const snapshot = await this.herdr.snapshot();
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
      const session = own && (own.kind === undefined || own.kind === "id") ? own.value : null;
      if (typeof session !== "string" || !SESSION_ID.test(session)) throw new ConversationUnavailable("no_session_id");
      const store = this.#store(serverId);
      if (!store) throw new ConversationUnavailable("server_unavailable");
      const found = await this.#located(`claude\0${serverId}\0${session}\0${cwds.join("\0")}`,
        () => locateClaudeTranscript(store, session, cwds));
      return { paneId, serverId, agent, format, store, session, path: found.value, key: found.key };
    }
    return this.#resolveCodex(paneId, { serverId, agent, format, own, cwds });
  }

  async #resolveCodex(paneId, { serverId, agent, format, own, cwds }) {
    const store = this.#store(serverId);
    if (!store) throw new ConversationUnavailable("server_unavailable");
    const session = own && typeof own.value === "string" && own.value.length <= 4096
      ? { kind: own.kind, value: own.value } : null;
    const thread = session && (session.kind === undefined || session.kind === "id") && THREAD_ID.test(session.value) ? session.value : null;
    const local = serverId === LOCAL;
    // per pane: the open files and the screen that may decide it are the pane's own
    const found = await this.#located(`codex\0${serverId}\0${paneId}\0${session?.kind ?? ""}\0${session?.value ?? ""}\0${cwds.join("\0")}`,
      async () => locateCodexRollout(store, {
        session,
        cwd: cwds[0] ?? null,
        pids: local ? await this.#codexPids(paneId) : [],
        // this machine's panes only: on a Herdr machine every candidate would be a read over SSH
        readScreen: local ? () => this.herdr.readPane(paneId, { lines: MATCH_SCREEN_LINES, format: "text", source: "recent-unwrapped" }) : null,
      }));
    // nothing names the session and nothing tells which file is the pane's: wait for herdr to report it
    if (found.value === null && thread === null) {
      throw new ConversationUnavailable(session?.kind === "path" ? "transcript_missing" : "no_session_id");
    }
    // a thread herdr reported that Codex has not written yet reads as no turns
    return { paneId, serverId, agent, format, store, session: thread ?? session?.value ?? "", path: found.value, key: found.key };
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
      return await transcriptPage(target.format, target.store, target.path, { before, since, ifNoneMatch });
    } catch (error) {
      if (error instanceof ConversationUnavailable) this.forget(target);
      throw error;
    }
  }

  // The whole output of one tool call, capped. Throws a 404 when there is none.
  async toolOutput(paneId, toolId) {
    if (typeof toolId !== "string" || !TOOL_ID.test(toolId)) {
      throw new ConversationError(400, "invalid_tool_id", "That tool call id is not valid.");
    }
    const target = await this.resolve(paneId);
    if (target.path === null) throw new ConversationError(404, "tool_output_not_found", "That tool call has no output.");
    let found;
    try {
      found = await transcriptToolOutput(target.format, target.store, target.path, toolId);
    } catch (error) {
      if (error instanceof ConversationUnavailable) this.forget(target);
      throw error;
    }
    if (found === null) throw new ConversationError(404, "tool_output_not_found", "That tool call has no output.");
    return { id: toolId, output: found.output, output_size: found.size, truncated: found.size > found.output.length };
  }
}
