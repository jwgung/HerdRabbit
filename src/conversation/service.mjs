// A pane's Claude conversation, from the pane id the browser knows: which
// server's store holds it (this machine's files, or a Herdr machine's over
// SSH), which file, and the page or tool output asked for.
import {
  ConversationError,
  ConversationUnavailable,
  HistoryChanged,
  SESSION_ID,
  TOOL_ID,
  answerVersion,
  locateClaudeTranscript,
  transcriptPage,
  transcriptToolOutput,
  versionMatches,
} from "./claude.mjs";
import { localTranscriptStore, machineTranscriptStore } from "./stores.mjs";

const LOCAL = "local";
// A located file is trusted this long before it is looked up again; a
// session with no file yet is looked for again sooner.
const LOCATE_TTL_MS = 5_000;
const MISSING_LOCATE_TTL_MS = 2_000;

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

  // The pane's transcript: { paneId, serverId, store, session, path }, path
  // null while the session has written nothing. Throws ConversationUnavailable.
  async resolve(paneId) {
    if (typeof paneId !== "string" || !paneId || paneId.length > 512) throw new ConversationUnavailable("pane_not_found");
    const snapshot = await this.herdr.snapshot();
    const pane = (snapshot?.panes ?? []).find((candidate) => candidate?.pane_id === paneId);
    if (!pane) throw new ConversationUnavailable("pane_not_found");
    const reported = pane.agent_session && typeof pane.agent_session === "object" ? pane.agent_session : null;
    const agent = pane.agent ?? reported?.agent ?? null;
    if (agent !== "claude") throw new ConversationUnavailable("not_claude");
    // Herdr's Claude hook reports the session by id; a path or anything else is not one.
    const session = reported && (reported.kind === undefined || reported.kind === "id") ? reported.value : null;
    if (typeof session !== "string" || !SESSION_ID.test(session)) throw new ConversationUnavailable("no_session_id");
    const serverId = typeof pane.server_id === "string" && pane.server_id ? pane.server_id : LOCAL;
    const store = this.#store(serverId);
    if (!store) throw new ConversationUnavailable("server_unavailable");
    const cwds = [pane.cwd, pane.foreground_cwd].filter((cwd) => typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 4096);
    const key = `${serverId}\0${session}\0${cwds.join("\0")}`;
    const now = this.now();
    let entry = this.located.get(key);
    if (!entry || entry.expires <= now) {
      const path = await locateClaudeTranscript(store, session, cwds);
      entry = { path, expires: now + (path ? LOCATE_TTL_MS : MISSING_LOCATE_TTL_MS) };
      this.located.delete(key);
      this.located.set(key, entry);
      if (this.located.size > 256) this.located.delete(this.located.keys().next().value);
    }
    return { paneId, serverId, store, session, path: entry.path, key };
  }

  // A file that went away is looked up afresh next time.
  forget(target) {
    if (target?.key) this.located.delete(target.key);
  }

  async page(paneId, { before, since, ifNoneMatch } = {}) {
    const target = await this.resolve(paneId);
    if (target.path === null) {
      // Claude writes the file with its first message: until then there is
      // nothing before, and a cursor into it is another conversation's.
      if (before !== undefined || since !== undefined) throw new HistoryChanged();
      const version = answerVersion(`unwritten\0${target.serverId}`, target.session);
      if (versionMatches(ifNoneMatch, version)) return { notModified: true, version };
      return {
        source: "claude-transcript", turns: [], metadata: { model: null, reasoning_effort: null },
        cursor: null, history_id: `unwritten-${target.session}`, version,
      };
    }
    try {
      return await transcriptPage(target.store, target.path, { before, since, ifNoneMatch });
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
      found = await transcriptToolOutput(target.store, target.path, toolId);
    } catch (error) {
      if (error instanceof ConversationUnavailable) this.forget(target);
      throw error;
    }
    if (found === null) throw new ConversationError(404, "tool_output_not_found", "That tool call has no output.");
    return { id: toolId, output: found.output, output_size: found.size, truncated: found.size > found.output.length };
  }
}
