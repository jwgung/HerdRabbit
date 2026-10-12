import { LeafLinkClient } from "./leaf-link-client.mjs";
import { HerdrCommandError, InputValidationError } from "./herdr-client.mjs";
import { MIN_HERDR_VERSION, herdrVersionSupported } from "./herdr-version.mjs";

const isMachine = (profile) => profile?.transport === "machine";

const collections = ["herdr_sessions", "workspaces", "tabs", "panes", "agents"];
const idFields = ["session_id", "herdr_session_id", "workspace_id", "active_tab_id", "tab_id", "pane_id"];
const empty = () => Object.fromEntries(collections.map((key) => [key, []]));

function scope(snapshot, server) {
  const prefix = (id) => server.id === "local" ? id : `${server.id}!${id}`;
  return Object.fromEntries(collections.map((key) => [key, (snapshot[key] || []).map((record) => {
    const next = { ...record, server_id: server.id, server_name: server.name };
    for (const field of idFields) if (typeof next[field] === "string") next[field] = prefix(next[field]);
    if (server.id !== "local" && key === "herdr_sessions") next.default = false;
    return next;
  })]));
}

// Only messages we wrote ourselves are safe to show; anything else could be a
// remote command's output arriving through an error.
export function serverStatusFor(error) {
  return error?.code?.startsWith("leaf_") || error?.code?.startsWith("machine_")
    ? error.message
    : "Could not reach HerdRabbit on this server. Check the address and that it is running there.";
}

export class MultiServerClient {
  constructor({
    local, profiles, hubVersion, machineName = () => null, herdrVersion = () => null,
    remoteFactory = (profile) => new LeafLinkClient({ profile, hubVersion }),
    // Herdr's own SSH machines (src/herdr-machines.mjs), next to linked servers.
    machines = null,
  }) {
    this.machines = machines;
    // A machine whose connection just came up or went down is asked again at
    // once, not at its next poll.
    machines?.onLinkChange?.((serverId) => {
      const entry = this.entries.get(serverId);
      if (entry && !this.stopped) void this.refresh(entry);
    });
    this.local = local;
    this.machineName = machineName;
    this.herdrVersion = herdrVersion;
    this.hubVersion = hubVersion ?? null;
    this.profiles = profiles;
    this.remoteFactory = remoteFactory;
    this.entries = new Map();
    this.stopped = false;
  }

  clientFor(profile) {
    if (profile.id === "local") return this.local;
    return isMachine(profile) ? this.machines.client(profile) : this.remoteFactory(profile);
  }

  // A linked HerdRabbit server: it answers for its files and accounts itself.
  linkedEntry(serverId) {
    this.syncEntries();
    const entry = this.entries.get(serverId);
    return entry && serverId !== "local" && !isMachine(entry.profile) ? entry : null;
  }

  syncEntries() {
    const profiles = [
      { id: "local", name: "Local" },
      ...(this.profiles.connectionProfiles?.() ?? this.profiles.list()),
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
        snapshot: empty(), available: false, status: "Connecting", lastPoll: 0, pending: null,
      });
    }
  }

  async refresh(entry) {
    if (entry.pending) return entry.pending;
    entry.pending = Promise.resolve().then(async () => {
      try {
        if (entry.profile.enabled === false) throw Object.assign(new Error("Turned off"), { code: "machine_off" });
        entry.snapshot = await entry.client.snapshot();
        entry.available = true;
        entry.status = "Connected";
      } catch (error) {
        entry.available = false;
        entry.status = serverStatusFor(error);
      } finally {
        entry.lastPoll = Date.now();
        entry.pending = null;
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
      // A machine goes by the name Tailscale knows it by. This one is this
      // HerdRabbit, so it answers for its own version too; a linked one reports
      // what its link says.
      servers: entries.map(({ profile, available, status, client }) => ({
        id: profile.id, name: profile.name, available, status,
        transport: profile.id === "local" ? "local" : profile.transport ?? "link",
        ...(isMachine(profile) ? { enabled: profile.enabled !== false } : {}),
        address: profile.address ?? null,
        machine: this.machineName(profile) ?? null,
        version: profile.id === "local" ? this.hubVersion : client?.info?.().version ?? null,
        // A linked machine reports its Herdr in the handshake.
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

  // File routes address a server by id and need the client that speaks for it.
  // Only a linked server has files to offer; local is handled by the caller.
  fileClient(serverId) {
    return this.linkedEntry(serverId)?.client ?? null;
  }

  // Account routes address a linked server the same way; local is the caller's.
  aiAccountsClient(serverId) {
    return this.linkedEntry(serverId)?.client.aiAccounts?.() ?? null;
  }

  async testProfile(profile) {
    const client = this.remoteFactory(profile);
    const snapshot = await client.snapshot().finally(() => client.close?.());
    if (snapshot.herdr_sessions.some((session) => session.running && !session.available)) {
      throw new InputValidationError("Connected to HerdRabbit, but a running Herdr session could not be read.");
    }
    return {
      ok: true,
      transport: "link",
      version: client.info?.().version ?? null,
      sessions: snapshot.herdr_sessions.length,
      panes: snapshot.panes.length,
    };
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
    const result = await entry.client[method](id, ...args);
    if (mutation && entry.profile.id !== "local") {
      if (entry.pending) await entry.pending;
      await this.refresh(entry);
    }
    return result;
  }

  readPane(id, options) { return this.invoke("readPane", id, [options]); }
  // This machine's panes and Herdr machines' attach; a linked server's keep the screen-text view.
  terminalTarget(id, timeoutMs) {
    const { entry, id: localId } = this.target(id);
    if (entry.profile.id !== "local" && !isMachine(entry.profile)) {
      throw new HerdrCommandError("Terminal attach is not available for this server yet", { code: "attach_unsupported" });
    }
    return entry.client.terminalTarget(localId, timeoutMs);
  }
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
