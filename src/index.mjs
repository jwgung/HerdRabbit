import { formerLeafRefusal, legacyLeafWarning, readConfig } from "./config.mjs";
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
import { HerdrMachines, machineSocketDirectory } from "./herdr-machines.mjs";
import { PaneAttachments, loadNodePty, nodePtySpawner } from "./pane-attachments.mjs";
import { AiAccounts, runningAgentsIn } from "./ai-accounts.mjs";
import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "./herdr-version.mjs";
import { ServerProfiles } from "./server-profiles.mjs";
import { PeerIdentity } from "./peer-identity.mjs";
import { leafLinkRoutes } from "./link-server.mjs";
import { createPeerServer } from "./peer-server.mjs";
import { discoverLeaves, readTailnetPeers, tailnetLoginOf } from "./tailnet-peers.mjs";
import { announcementRegistry } from "./announcements.mjs";
import { announcementWriter, readAnnouncements } from "./announcement-store.mjs";
import { announceToHub } from "./leaf-announce.mjs";

const config = readConfig();
const leafWarning = legacyLeafWarning(config);
if (leafWarning) console.warn(leafWarning);
const auth = await loadPasswordAuth(config.authFile);
// A former leaf without a password: its page only says how to set one; its
// Connect PC port below still answers its hub.
const leafRefusal = formerLeafRefusal(config, auth.required);

// One look at Tailscale serves two things taken from it: the owner login that
// makes an announcement believable, and the names machines are known by there.
// Until it answers, or without Tailscale, this PC goes by its host name.
const tailnet = readTailnetPeers();
let tailnetNames = { self: null, peers: new Map() };
void tailnet.then((status) => {
  tailnetNames = { self: status.self?.name || null, peers: new Map(status.peers.map((peer) => [peer.address, peer.name])) };
});
// This PC goes by its tailnet (or host) name, a connected PC by the name
// Tailscale knows its address by, and a Herdr machine by its own label.
function machineName(profile) {
  if (profile.id === "local") return tailnetNames.self || hostname();
  if (profile.transport === "machine") return null;
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
// Herdr's own SSH machines (`herdr machine add`) are reached without anything
// installed on them, and are listed beside the connected PCs.
const machineDirectory = await machineSocketDirectory().catch((error) => {
  // Without a private directory the machines stay unconnected; everything else runs.
  console.warn(`Herdr machines are unavailable: ${error.message}`);
  return null;
});
const machines = !machineDirectory ? null : new HerdrMachines({
  binary: config.herdrBin,
  directory: machineDirectory,
  createBridge: (link) => new HerdrBridgeClient({
    binary: config.herdrBin, timeoutMs: config.commandTimeoutMs, socketPath: link.socketPath, sessionName: link.machine.session,
  }),
  log: (message) => console.warn(message),
  maxTransferBytes: config.maxTransferBytes,
});
machines?.start();
const herdr = new MultiServerClient({ local, profiles, hubVersion, machineName, herdrVersion: () => herdrVersion, machines });
// Only this machine's panes decide whether a switch here would disturb anything.
const aiAccounts = new AiAccounts({ directory: config.aiAccountsDir, runningAgents: () => runningAgentsIn(local) });
const notificationMonitor = new AgentNotificationMonitor({ herdr, push });
// Without node-pty's native module every pane is a read-only mirror of its screen.
const nodePty = await loadNodePty();
if (!nodePty) console.warn("node-pty is unavailable; terminals mirror the screen instead of attaching.");
const attachments = nodePty
  ? new PaneAttachments({ resolveTerminal: (paneId, timeoutMs) => herdr.terminalTarget(paneId, timeoutMs), spawnPty: nodePtySpawner(nodePty) })
  : null;
// Shown in this PC's Details: where other PCs connect, and how many may.
const connectPc = config.peerHost
  ? { address: `http://${config.peerHost}:${config.peerPort}`, allowed: config.peerAddresses.length + config.peerLogins.length }
  : null;
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  machines,
  profiles,
  announcements,
  connectPc,
  // Only this PC goes looking; what it finds is offered, never added by itself.
  discover: async (known) => {
    const announced = announcements.list();
    const found = await discoverLeaves({ hubVersion, known, announced });
    // Drop what a look just proved is not there. "offline" is not that: the
    // machine is merely asleep and will announce itself again when it wakes.
    const claimed = new Set(announced.map((entry) => entry.address));
    announcements.forget(found.candidates
      .filter((candidate) => candidate.state === "absent" && claimed.has(candidate.address))
      .map((candidate) => candidate.address));
    return found;
  },
  files,
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
});

// The Connect PC port: other PCs reach this one's own sessions here, never the
// page. It answers with the local Herdr client, not the aggregating one, so
// this PC reports only its own sessions.
const peerServer = config.peerHost ? createPeerServer({
  peer: new PeerIdentity({
    addresses: config.peerAddresses,
    logins: config.peerLogins,
    loginOf: (address) => tailnetLoginOf(address),
  }),
  link: leafLinkRoutes({
    client: local, files, aiAccounts, version: hubVersion, herdrVersion: () => herdrVersion,
    serverName: hostname(), maxTransferBytes: config.maxTransferBytes,
  }),
}) : null;
// Says where the Connect PC port is, to the PC that should connect to it.
let announcer = { stop() {} };

function listenFailed(port) {
  return (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use.` : `Server failed: ${error.message}`);
    process.exitCode = 1;
  };
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
  server.on("error", listenFailed(config.port));
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
  peerServer.on("error", listenFailed(config.peerPort));
  peerServer.listen(config.peerPort, config.peerHost, () => {
    const allowed = [...config.peerAddresses, ...config.peerLogins];
    console.log(`Connect PC port: http://${config.peerHost}:${config.peerPort}`);
    console.log(allowed.length > 0
      ? `Other PCs allowed to connect: ${allowed.join(", ")}`
      : "No PC is allowed to connect yet: set HERDR_WEB_PEER_ADDRESSES or HERDR_WEB_PEER_LOGINS.");
    announcer = announceToHub({
      hub: config.hub,
      address: `http://${config.peerHost}:${config.peerPort}`,
      name: hostname(),
      version: hubVersion,
    });
  });
}

async function shutdown() {
  herdr.stopped = true;
  notificationMonitor.stop();
  announcer.stop();
  attachments?.close();
  // The machines' SSH connections close before the server stops listening.
  await machines?.stop().catch((error) => console.error("Closing Herdr machines failed:", error.message));
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
