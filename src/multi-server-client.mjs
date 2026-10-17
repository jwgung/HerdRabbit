import { HerdrCommandError, InputValidationError, mapMovedIds } from "./herdr-client.mjs";
import { MIN_HERDR_VERSION, herdrVersionSupported } from "./herdr-version.mjs";
import { LinkClient } from "./link-client.mjs";
import { LINK_PROTOCOL } from "./link-protocol.mjs";

const collections = ["herdr_sessions", "workspaces", "tabs", "panes", "agents"];
const idFields = ["session_id", "herdr_session_id", "workspace_id", "active_tab_id", "tab_id", "pane_id"];
const empty = () => Object.fromEntries(collections.map((key) => [key, []]));

function scope(snapshot, server) {
  const prefix = (id) => server.id === "local" ? id : `${server.id}!${id}`;
  return Object.fromEntries(collections.map((key) => [key, (snapshot[key] || []).map((record) => {
    const next = { ...record, server_id: server.id, server_name: server.name };
    for (const field of idFields) if (typeof next[field] === "string") next[field] = prefix(next[field]);
    // `default` stays this machine's alone; each machine's own default is kept
    // as `machine_default`, for choosing a session on that machine.
    if (key === "herdr_sessions") {
      next.machine_default = record.default === true;
      if (server.id !== "local") next.default = false;
    }
    return next;
  })]));
}

// Only messages we wrote ourselves are safe to show; anything else could be a
// remote command's output arriving through an error.
export function serverStatusFor(error) {
  return error?.code?.startsWith("link_")
    ? error.message
    : "Could not reach Herdr on this PC. Check that it is running there.";
}

export class MultiServerClient {
  constructor({
    local, hubVersion, machineName = () => null, herdrVersion = () => null,
    // PCs connected with Connect PC (servers.json, src/server-profiles.mjs):
    // another HerdRabbit, asked over its Connect PC port.
    profiles = null,
    // A file a connected PC sends is held to the same limit as one here.
    maxTransferBytes = Infinity,
    remoteFactory = (profile) => new LinkClient({ profile, hubVersion, maxTransferBytes }),
  }) {
    this.profiles = profiles;
    this.remoteFactory = remoteFactory;
    this.local = local;
    this.machineName = machineName;
    this.herdrVersion = herdrVersion;
    this.hubVersion = hubVersion ?? null;
    this.entries = new Map();
    this.stopped = false;
  }

  clientFor(profile) {
    if (profile.id === "local") return this.local;
    return this.remoteFactory(profile);
  }

  syncEntries() {
    const profiles = [
      { id: "local", name: "Local" },
      ...(this.profiles?.list?.() ?? []),
    ];
    for (const id of this.entries.keys()) {
      if (profiles.some((profile) => profile.id === id)) continue;
      this.entries.get(id)?.client?.close?.();
      this.entries.delete(id);
    }
    for (const profile of profiles) {
      const fingerprint = JSON.stringify(profile);
      if (this.entries.get(profile.id)?.fingerprint === fingerprint) continue;
      this.entries.get(profile.id)?.client?.close?.();
      this.entries.set(profile.id, {
        profile, fingerprint,
        client: this.clientFor(profile),
        snapshot: empty(), available: false, status: "Connecting", connecting: true, lastPoll: 0, pending: null,
      });
    }
  }

  // On shutdown: the other PCs' open requests and status streams are let go,
  // so they do not hold the process after it was told to stop.
  close() {
    for (const [id, entry] of this.entries) {
      if (id !== "local") entry.client?.close?.();
    }
  }

  // `again`: what changed may come after the answer a running request will
  // give, so that request is followed by one more.
  async refresh(entry, { again = false } = {}) {
    if (entry.pending) {
      if (again) entry.again = true;
      return entry.pending;
    }
    entry.pending = Promise.resolve().then(async () => {
      try {
        entry.snapshot = await entry.client.snapshot();
        entry.available = true;
        entry.status = "Connected";
        entry.connecting = false;
      } catch (error) {
        entry.available = false;
        entry.status = serverStatusFor(error);
        entry.connecting = error?.connecting === true;
      } finally {
        entry.lastPoll = Date.now();
        entry.pending = null;
        if (entry.again && !this.stopped) {
          entry.again = false;
          void this.refresh(entry);
        }
      }
    });
    return entry.pending;
  }

  async snapshot() {
    this.syncEntries();
    const entries = [...this.entries.values()];
    // Remote polling is independent so an unreachable host cannot delay local data.
    for (const entry of entries) {
      if (!this.stopped && entry.profile.id !== "local" &&
          Date.now() - entry.lastPoll >= (entry.available ? 2_000 : 10_000)) void this.refresh(entry);
    }
    await this.refresh(this.entries.get("local"));
    const snapshots = entries.map((entry) => {
      const value = scope(entry.snapshot, entry.profile);
      if (!entry.available) {
        value.herdr_sessions = value.herdr_sessions.map((session) => ({ ...session, available: false }));
      }
      return value;
    });
    return {
      ...this.entries.get("local").snapshot,
      ...Object.fromEntries(collections.map((key) => [key, snapshots.flatMap((snapshot) => snapshot[key])])),
      // Address and version travel with the server so the sidebar can say what
      // a machine is without asking again.
      // This PC is this HerdRabbit, so it answers for its own version and
      // link protocol too; a connected PC reports what its handshake said,
      // even when the protocols differ and it is shown offline.
      servers: entries.map(({ profile, available, status, connecting, client }) => ({
        // Connecting: not reached yet, but still trying; a page waits for its panes.
        id: profile.id, name: profile.name, available, status, connecting: !available && connecting,
        transport: profile.id === "local" ? "local" : "link",
        address: profile.address ?? null,
        machine: this.machineName(profile) ?? null,
        version: profile.id === "local" ? this.hubVersion : client?.info?.().version ?? null,
        link_protocol: profile.id === "local" ? LINK_PROTOCOL : client?.info?.().protocol ?? null,
        ...this.herdrFields(profile.id === "local" ? this.herdrVersion() : client?.info?.().herdrVersion ?? null),
      })),
    };
  }

  herdrFields(version) {
    // Supported is null while the version is unknown, which is not the same as too old.
    return {
      herdr_version: version, herdr_min_version: MIN_HERDR_VERSION,
      herdr_supported: version === null ? null : herdrVersionSupported(version),
    };
  }

  // File routes address a server by id and need the client that speaks for it:
  // a connected PC answers for its own files over its Connect PC port. Local
  // is handled by the caller.
  fileClient(serverId) {
    this.syncEntries();
    const entry = serverId === "local" ? null : this.entries.get(serverId);
    return entry ? entry.client : null;
  }

  // A pane of a PC connected with Connect PC: { serverId, id, client }, where
  // `id` is the pane's id on that PC and `client` the link that asks it. That
  // PC reads its panes' conversations itself; null for any other pane.
  linkedPane(paneId) {
    if (typeof paneId !== "string" || !paneId.includes("!")) return null;
    let found;
    try { found = this.target(paneId); } catch { return null; }
    const { entry, id } = found;
    if (entry.profile.id === "local") return null;
    return { serverId: entry.profile.id, id, client: entry.client };
  }

  // Connect PC's "Test connection": one snapshot through a client of its own.
  async testProfile(profile) {
    const client = this.remoteFactory(profile);
    try {
      const snapshot = await client.snapshot();
      if (snapshot.herdr_sessions.some((session) => session.running && !session.available)) {
        throw new InputValidationError("Connected to HerdRabbit, but a running Herdr session could not be read.");
      }
      const info = client.info?.() ?? {};
      return {
        ok: true,
        transport: "link",
        version: info.version ?? null,
        link_protocol: info.protocol ?? null,
        sessions: snapshot.herdr_sessions.length,
        panes: snapshot.panes.length,
      };
    } finally {
      client.close?.();
    }
  }

  // A connected PC's own update goes through its link; this PC's is the
  // caller's. Null for this PC and for a PC no longer configured.
  updateClient(serverId) {
    this.syncEntries();
    const entry = serverId === "local" ? null : this.entries.get(serverId);
    return entry?.client ?? null;
  }

  // Account routes address a server the same way: a connected PC switches its
  // own accounts. Local is the caller's.
  aiAccountsClient(serverId) {
    this.syncEntries();
    const entry = serverId === "local" ? null : this.entries.get(serverId);
    return entry?.client.aiAccounts?.() ?? null;
  }

  target(id) {
    this.syncEntries();
    if (typeof id !== "string") throw new InputValidationError("Invalid target id");
    const separator = id.indexOf("!");
    const serverId = separator < 0 ? "local" : id.slice(0, separator);
    const entry = this.entries.get(serverId);
    if (!entry) throw new InputValidationError("That server is no longer configured.");
    return { entry, id: separator < 0 ? id : id.slice(separator + 1) };
  }

  async invoke(method, targetId, args, mutation = false) {
    const { entry, id } = this.target(targetId);
    if (typeof entry.client[method] !== "function") {
      throw new HerdrCommandError("That is not available for this PC yet.", { code: "link_unsupported" });
    }
    const result = await entry.client[method](id, ...args);
    if (mutation && entry.profile.id !== "local") {
      if (entry.pending) await entry.pending;
      await this.refresh(entry);
    }
    return result;
  }

  readPane(id, options) { return this.invoke("readPane", id, [options]); }
  // This machine's panes only: a connected PC's processes are not this one's to look into.
  async paneProcessInfo(id) {
    const { entry, id: localId } = this.target(id);
    if (entry.profile.id !== "local" || typeof entry.client.paneProcessInfo !== "function") return null;
    return entry.client.paneProcessInfo(localId);
  }
  // This machine's panes attach here; a connected PC's client answers a
  // target that attaches on that PC (src/link-attach.mjs).
  terminalTarget(id, timeoutMs) {
    const { entry, id: localId } = this.target(id);
    return entry.client.terminalTarget(localId, timeoutMs);
  }
  // The answer names no ids, only history cells: nothing to put a prefix on.
  paneFind(id, request) { return this.invoke("paneFind", id, [request]); }
  paneReveal(id, request) { return this.invoke("paneReveal", id, [request]); }
  paneScrollToBottom(id) { return this.invoke("paneScrollToBottom", id, []); }
  // A connected PC's pane: that PC's own `/` commands (src/link-client.mjs).
  // This machine's are listed by the page's own catalog, not asked of Herdr.
  paneCommands(id) { return this.invoke("paneCommands", id, []); }
  sendText(id, text, options) { return this.invoke("sendText", id, [text, options]); }
  sendKeys(id, keys) { return this.invoke("sendKeys", id, [keys]); }
  async watchStatuses(paneIds, onStatus, onError) {
    const groups = new Map();
    for (const paneId of paneIds) {
      const { entry, id } = this.target(paneId);
      if (!groups.has(entry)) groups.set(entry, []);
      groups.get(entry).push(id);
    }
    // One server failing to watch must not stop every other server's statuses.
    const results = await Promise.allSettled([...groups].map(([entry, ids]) =>
      entry.client.watchStatuses(ids, event => onStatus({ ...event,
        pane_id: entry.profile.id === "local" ? event.pane_id : `${entry.profile.id}!${event.pane_id}` }), onError)));
    const stops = results.filter(result => result.status === "fulfilled").map(result => result.value);
    for (const result of results) if (result.status === "rejected") onError(result.reason);
    return () => stops.forEach(stop => stop());
  }
  renameWorkspace(id, label) { return this.invoke("renameWorkspace", id, [label], true); }
  closeWorkspace(id) { return this.invoke("closeWorkspace", id, [], true); }
  createTab(id) { return this.invoke("createTab", id, [], true); }
  renameTab(id, label) { return this.invoke("renameTab", id, [label], true); }
  closeTab(id) { return this.invoke("closeTab", id, [], true); }
  moveTab(id, insertIndex) { return this.invoke("moveTab", id, [insertIndex], true); }
  moveWorkspace(id, insertIndex) { return this.invoke("moveWorkspace", id, [insertIndex], true); }
  // Only within one server: a pane cannot cross to another machine.
  async moveTabToWorkspace(tabId, workspaceId, insertIndex) {
    const tab = this.target(tabId);
    const workspace = this.target(workspaceId);
    if (tab.entry !== workspace.entry) {
      throw new InputValidationError("A session can only move to a project on the same machine");
    }
    const { entry } = tab;
    const result = await entry.client.moveTabToWorkspace(tab.id, workspace.id, insertIndex);
    if (entry.profile.id !== "local") {
      if (entry.pending) await entry.pending;
      await this.refresh(entry);
    }
    return mapMovedIds(result, (id) => entry.profile.id === "local" ? id : `${entry.profile.id}!${id}`);
  }
  async createWorkspace(label, sessionId) {
    if (!sessionId) return this.local.createWorkspace(label);
    const { entry, id } = this.target(sessionId);
    const result = await entry.client.createWorkspace(label, id);
    if (entry.profile.id !== "local") {
      if (entry.pending) await entry.pending;
      await this.refresh(entry);
    }
    return result;
  }
}
