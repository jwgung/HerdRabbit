import { formerLeafRefusal, hostPort, legacyLeafWarning, readConfig } from "./config.mjs";
import { allowedRequestHosts } from "./allowed-hosts.mjs";
import { AgentNotificationMonitor } from "./agent-notifications.mjs";
import { HerdrBridgeClient } from "./herdr-bridge-client.mjs";
import { createHerdrHttpServer } from "./http-server.mjs";
import { loadPasswordAuth } from "./password-auth.mjs";
import { PasskeyAuth } from "./passkey-auth.mjs";
import { loadWebPushService } from "./web-push-service.mjs";
import { hostname } from "node:os";
import { readAppVersion } from "./app-version.mjs";
import { serveLocked } from "./locked-server.mjs";
import { FileStore } from "./file-store.mjs";
import { MultiServerClient } from "./multi-server-client.mjs";
import { countLegacyMachines } from "./legacy-machines.mjs";
import { PaneAttachments, loadNodePty, nodePtySpawner } from "./pane-attachments.mjs";
import { AiAccounts, runningAgentsIn } from "./ai-accounts.mjs";
import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "./herdr-version.mjs";
import { ServerProfiles } from "./server-profiles.mjs";
import { PeerIdentity } from "./peer-identity.mjs";
import { linkRoutes } from "./link-server.mjs";
import { linkAttachSockets, routedSpawner } from "./link-attach.mjs";
import { createPeerServer } from "./peer-server.mjs";
import { discoverPeers, readTailnetPeers, tailnetLoginOf } from "./tailnet-peers.mjs";
import { announcementRegistry } from "./announcements.mjs";
import { announcementWriter, readAnnouncements } from "./announcement-store.mjs";
import { announceToHub } from "./link-announce.mjs";
import { isProtectedPath, localProtectedPaths } from "./protected-paths.mjs";
import { ConversationService } from "./conversation/service.mjs";
import { SlashCommandCatalog } from "./slash-commands.mjs";
import { AppUpdater } from "./app-update.mjs";

const config = readConfig();
const leafWarning = legacyLeafWarning(config);
if (leafWarning) console.warn(leafWarning);
// Sign-in keys and this app's own settings: the file browser never opens them,
// here or for a PC connected to this one.
const protectedPaths = localProtectedPaths({ data: config });
if (await isProtectedPath(protectedPaths, config.filesDir)) {
  console.error(`The uploads folder ${config.filesDir} is inside a folder HerdRabbit keeps closed (SSH or sign-in keys, or its own settings). Set HERDR_WEB_FILES_DIR somewhere else.`);
  process.exit(1);
}
const auth = await loadPasswordAuth(config.authFile);
// A former leaf without a password: its page only says how to set one; its
// Connect PC port below still answers its hub.
const leafRefusal = formerLeafRefusal(config, auth.required);

// One look at Tailscale serves two things taken from it: the owner login that
// makes an announcement believable, and the names machines are known by there.
// Until it answers, or without Tailscale, this PC goes by its host name.
const tailnet = readTailnetPeers();
let tailnetNames = { self: null, selfFull: null, peers: new Map() };
void tailnet.then((status) => {
  tailnetNames = {
    self: status.self?.name || null,
    selfFull: status.self?.fullName || null,
    peers: new Map(status.peers.map((peer) => [peer.address, peer.name])),
  };
});
// This PC goes by its tailnet (or host) name, and a connected PC by the name
// Tailscale knows its address by.
function machineName(profile) {
  if (profile.id === "local") return tailnetNames.self || hostname();
  try {
    return tailnetNames.peers.get(new URL(profile.address).hostname) || null;
  } catch {
    return null;
  }
}

const passkeys = new PasskeyAuth({ auth });
const local = new HerdrBridgeClient({
  binary: config.herdrBin,
  timeoutMs: config.commandTimeoutMs,
});
const push = await loadWebPushService(config.pushFile);
// PCs connected with Connect PC. A file this version cannot read is left as it
// is, and Connect PC stays off rather than overwrite it.
const profiles = await ServerProfiles.load(config.serversFile).catch((error) => {
  console.warn(`Connect PC is off: could not read ${config.serversFile}: ${error.message}`);
  return null;
});
// What other PCs said about where they are; the owner login is what makes an
// announcement believable, and Tailscale is the only thing that can say it.
const announcements = await (async () => {
  const registry = announcementRegistry({
    initial: await readAnnouncements(config.announcementsFile),
    save: announcementWriter(config.announcementsFile),
  });
  let owner = null;
  void tailnet.then((status) => { owner = status.self?.login || null; });
  return Object.assign(registry, { ownerLogin: () => owner });
})();
const files = await FileStore.load(config.filesDir, { maxBytes: config.maxTransferBytes });
const hubVersion = readAppVersion();
// Read once: the updater restarts this service after it updates Herdr.
let herdrVersion = null;
void readHerdrVersion(config.herdrBin).then((version) => {
  herdrVersion = version;
  if (!herdrVersionSupported(version)) {
    console.warn(`Herdr ${version || "(unknown version)"} is older than ${MIN_HERDR_VERSION}. Run: ${config.herdrBin} update --handoff`);
  }
});
// Herdr SSH machines are not shown any more; the page says once how to bring
// those PCs back when Herdr still lists some. Asked in the background, so a
// Herdr that hangs never holds the page up.
let legacyMachines = 0;
void countLegacyMachines({ binary: config.herdrBin }).then((count) => { legacyMachines = count; });
const herdr = new MultiServerClient({
  local, profiles, hubVersion, machineName, herdrVersion: () => herdrVersion,
  maxTransferBytes: config.maxTransferBytes,
});
// Panes' conversations: this PC's page reads them, and so does a PC that
// connected to this one, for this PC's own panes (its link refuses any other).
// One service for both, so a transcript found for one is found for the other.
const conversations = new ConversationService({ herdr });
// Panes' `/` commands: this PC's page lists them, and so does a PC that
// connected to this one, for this PC's own panes. One catalog for both.
const slashCommands = new SlashCommandCatalog({ guard: protectedPaths });
// Only this machine's panes decide whether a switch here would disturb anything.
const aiAccounts = new AiAccounts({ directory: config.aiAccountsDir, runningAgents: () => runningAgentsIn(local) });
const notificationMonitor = new AgentNotificationMonitor({ herdr, push });
// In-app update: this checkout against origin's main, and update.sh run from
// the page (or from a PC this one is connected to) in a unit of its own.
const updater = new AppUpdater({ version: hubVersion, stateDir: config.updateDir });
// Without node-pty's native module this PC's panes are read-only mirrors of
// their screens. A connected PC's panes still attach: that PC runs the pty.
const nodePty = await loadNodePty();
if (!nodePty) console.warn("node-pty is unavailable; terminals mirror the screen instead of attaching.");
const localPty = nodePty ? nodePtySpawner(nodePty) : null;
const attachments = new PaneAttachments({
  resolveTerminal: async (paneId, timeoutMs) => {
    const target = await herdr.terminalTarget(paneId, timeoutMs);
    // Refused before anything is spawned, so the page mirrors the pane for good.
    if (!target.remote && !localPty) {
      throw Object.assign(new Error("Terminals cannot attach on this PC (node-pty is unavailable)."), { code: "attach_unsupported" });
    }
    return target;
  },
  spawnPty: routedSpawner(localPty),
});
// Shown in this PC's Details: where other PCs connect, and how many may.
const connectPc = config.peerHost
  ? { address: `http://${hostPort(config.peerHost, config.peerPort)}`, allowed: config.peerAddresses.length + config.peerLogins.length }
  : null;
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  legacyMachines: () => legacyMachines,
  profiles,
  announcements,
  connectPc,
  updater,
  // Only this PC goes looking; what it finds is offered, never added by itself.
  discover: async (known) => {
    const announced = announcements.list();
    const found = await discoverPeers({ hubVersion, known, announced });
    // Drop what a look just proved is not there. "offline" is not that: the
    // machine is merely asleep and will announce itself again when it wakes.
    const claimed = new Set(announced.map((entry) => entry.address));
    announcements.forget(found.candidates
      .filter((candidate) => candidate.state === "absent" && claimed.has(candidate.address))
      .map((candidate) => candidate.address));
    return found;
  },
  files,
  conversations,
  slashCommands,
  auth,
  passkeys,
  push,
  notificationMonitor,
  allowedHosts: allowedRequestHosts(config.host, {
    extraHosts: config.extraAllowedHosts,
  }),
  aiAccounts,
  maxBodyBytes: config.maxBodyBytes,
  maxTransferBytes: config.maxTransferBytes,
  protectedPaths,
});

// A hub attaching to one of this PC's panes: this PC's own Herdr and node-pty
// run the attach, exactly as for this PC's page.
const linkAttach = config.peerHost
  ? linkAttachSockets({ terminalTarget: (paneId, timeoutMs) => local.terminalTarget(paneId, timeoutMs), spawnPty: localPty })
  : null;
// The Connect PC port: other PCs reach this one's own sessions here, never the
// page. It answers with the local Herdr client, not the aggregating one, so
// this PC reports only its own sessions.
const peerServer = config.peerHost ? createPeerServer({
  peer: new PeerIdentity({
    addresses: config.peerAddresses,
    logins: config.peerLogins,
    loginOf: (address) => tailnetLoginOf(address),
  }),
  link: linkRoutes({
    client: local, files, aiAccounts, attach: linkAttach, conversations, slashCommands, updater, version: hubVersion, herdrVersion: () => herdrVersion,
    serverName: hostname(), maxTransferBytes: config.maxTransferBytes, protectedPaths,
  }),
  attach: linkAttach,
  // A PC added by this one's tailnet name reaches it under that name.
  hostNames: () => [tailnetNames.selfFull].filter(Boolean),
}) : null;
// Says where the Connect PC port is, to the PC that should connect to it.
let announcer = { stop() {} };

// Either listener failing to open stops the whole service, so systemd sees
// the failure and restarts it, instead of a page without its Connect PC port
// running on -- or a Connect PC port without its page. An error once it
// listens is reported, as before, and the service keeps running.
function listenFailed(server, port) {
  const failed = (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use.` : `Server failed: ${error.message}`);
    void shutdown().finally(() => process.exit(1));
  };
  server.once("error", failed);
  server.once("listening", () => {
    server.off("error", failed);
    server.on("error", (error) => {
      console.error(`Server failed: ${error.message}`);
      process.exitCode = 1;
    });
  });
}

const lockedStop = new AbortController();
let locked = null;
if (leafRefusal) {
  console.error(leafRefusal);
  locked = serveLocked(config, leafRefusal, {
    signals: [],
    stop: lockedStop.signal,
    onListening: () => console.log(`HerdRabbit page locked: http://${config.host}:${config.port}`),
  });
} else {
  listenFailed(server, config.port);
  server.listen(config.port, config.host, () => {
    notificationMonitor.start();
    console.log(`HerdRabbit: http://${config.host}:${config.port}`);
    console.log(`Password authentication: ${auth.required ? "enabled" : "disabled"}`);
    console.log(
      config.host === "0.0.0.0"
        ? "Listening on all IPv4 interfaces. Press Ctrl+C to stop."
        : "Loopback only. Press Ctrl+C to stop.",
    );
  });
}

if (peerServer) {
  listenFailed(peerServer, config.peerPort);
  peerServer.listen(config.peerPort, config.peerHost, () => {
    const allowed = [...config.peerAddresses, ...config.peerLogins];
    console.log(`Connect PC port: http://${hostPort(config.peerHost, config.peerPort)}`);
    console.log(allowed.length > 0
      ? `Other PCs allowed to connect: ${allowed.join(", ")}`
      : "No PC is allowed to connect yet: set HERDR_WEB_PEER_ADDRESSES or HERDR_WEB_PEER_LOGINS.");
    announcer = announceToHub({
      hub: config.hub,
      address: `http://${hostPort(config.peerHost, config.peerPort)}`,
      name: hostname(),
      version: hubVersion,
    });
  });
}

async function shutdown() {
  herdr.stopped = true;
  herdr.close();
  notificationMonitor.stop();
  announcer.stop();
  attachments.close();
  linkAttach?.close();
  // A hub's status stream would otherwise hold the port open.
  peerServer?.close();
  peerServer?.closeAllConnections();
  lockedStop.abort();
  if (locked) return;
  server.close((error) => {
    if (error) {
      console.error("Shutdown failed:", error.message);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
