import { HerdrCommandError, InputValidationError, mapMovedIds } from "./herdr-client.mjs";
import { MIN_HERDR_VERSION, herdrVersionSupported } from "./herdr-version.mjs";
import { LeafLinkClient } from "./leaf-link-client.mjs";
import { LINK_PROTOCOL } from "./leaf-protocol.mjs";

const isMachine = (profile) => profile?.transport === "machine";

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
  return error?.code?.startsWith("leaf_") || error?.code?.startsWith("machine_")
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
    remoteFactory = (profile) => new LeafLinkClient({ profile, hubVersion, maxTransferBytes }),
    // Herdr's own SSH machines (src/herdr-machines.mjs), listed beside them.
    machines = null,
  }) {
    this.profiles = profiles;
    this.remoteFactory = remoteFactory;
    this.machines = machines;
    // A machine whose connection just came up or went down is asked again at
    // once, not at its next poll.
    machines?.onLinkChange?.((serverId) => {
      const entry = this.entries.get(serverId);
      if (entry && !this.stopped) void this.refresh(entry, { again: true });
    });
    this.local = local;
    this.machineName = machineName;
    this.herdrVersion = herdrVersion;
    this.hubVersion = hubVersion ?? null;
    this.entries = new Map();
    this.stopped = false;
  }

  clientFor(profile) {
    if (profile.id === "local") return this.local;
    return isMachine(profile) ? this.machines.client(profile) : this.remoteFactory(profile);
  }

  syncEntries() {
    const profiles = [
      { id: "local", name: "Local" },
      ...(this.profiles?.connectionProfiles?.() ?? this.profiles?.list?.() ?? []),
      ...(this.machines?.profiles() ?? []),
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

  // `again`: what changed may come after the answer a running request will
  // give, so that request is followed by one more.
  async refresh(entry, { again = false } = {}) {
    if (entry.pending) {
      if (again) entry.again = true;
      return entry.pending;
    }
    entry.pending = Promise.resolve().then(async () => {
      try {
        if (entry.profile.enabled === false) throw Object.assign(new Error("Turned off"), { code: "machine_off" });
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
      // Machines not listed yet: a page opening on one of their panes waits
      // (up to its own limit).
      servers_pending: Boolean(this.machines && !this.machines.listed),
      ...Object.fromEntries(collections.map((key) => [key, snapshots.flatMap((snapshot) => snapshot[key])])),
      // Address and version travel with the server so the sidebar can say what
      // a machine is without asking again.
      // This PC is this HerdRabbit, so it answers for its own version and
      // link protocol too; a connected PC reports what its handshake said,
      // even when the protocols differ and it is shown offline.
      servers: entries.map(({ profile, available, status, connecting, client }) => ({
        // Connecting: not reached yet, but still trying; a page waits for its panes.
        id: profile.id, name: profile.name, available, status, connecting: !available && connecting,
        transport: profile.id === "local" ? "local" : profile.transport ?? "link",
        ...(isMachine(profile) ? { enabled: profile.enabled !== false } : {}),
        address: profile.address ?? null,
        machine: this.machineName(profile) ?? null,
        version: profile.id === "local" ? this.hubVersion : client?.info?.().version ?? null,
        ...(profile.id === "local" || !isMachine(profile)
          ? { link_protocol: profile.id === "local" ? LINK_PROTOCOL : client?.info?.().protocol ?? null }
          : {}),
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
  // a Herdr SSH machine answers through its SSH connection. Local is handled
  // by the caller.
  fileClient(serverId) {
    this.syncEntries();
    const entry = serverId === "local" ? null : this.entries.get(serverId);
    if (!entry) return null;
    // A connected PC answers for its own files over its Connect PC port.
    return isMachine(entry.profile) ? entry.client.files?.() ?? null : entry.client;
  }

  // "local", "link" (Connect PC) or "machine" (Herdr SSH machine), or null for
  // a server that is not configured.
  serverTransport(serverId) {
    if (serverId === "local") return "local";
    this.syncEntries();
    const entry = this.entries.get(serverId);
    return entry ? entry.profile.transport ?? "link" : null;
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

  // Account routes address a server the same way: a Herdr SSH machine runs
  // the account manager there over SSH. Local is the caller's.
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
  // This machine's panes only: a Herdr machine's processes are not this one's to look into.
  async paneProcessInfo(id) {
    const { entry, id: localId } = this.target(id);
    if (entry.profile.id !== "local" || typeof entry.client.paneProcessInfo !== "function") return null;
    return entry.client.paneProcessInfo(localId);
  }
  // This machine's panes and Herdr machines' attach; a connected PC's client
  // refuses (attach_unsupported), and the page mirrors its screen instead.
  terminalTarget(id, timeoutMs) {
    const { entry, id: localId } = this.target(id);
    return entry.client.terminalTarget(localId, timeoutMs);
  }
  // The answer names no ids, only history cells: nothing to put a prefix on.
  paneFind(id, request) { return this.invoke("paneFind", id, [request]); }
  paneReveal(id, request) { return this.invoke("paneReveal", id, [request]); }
  sendText(id, text, options) { return this.invoke("sendText", id, [text, options]); }
  sendKeys(id, keys) { return this.invoke("sendKeys", id, [keys]); }
  async watchStatuses(paneIds, onStatus, onError) {
    const groups = new Map();
    for (const paneId of paneIds) {
      const { entry, id } = this.target(paneId);
      if (!groups.has(entry)) groups.set(entry, []);
      groups.get(entry).push(id);
    }
    // A machine that is not connected has nothing to watch yet, and must not
    // stop every other server's statuses; the next list refresh asks again.
    const results = await Promise.allSettled([...groups].filter(([entry]) => entry.client.ready !== false).map(([entry, ids]) =>
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
