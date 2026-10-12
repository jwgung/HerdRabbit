import { readConfig } from "./config.mjs";
import { allowedRequestHosts } from "./allowed-hosts.mjs";
import { AgentNotificationMonitor } from "./agent-notifications.mjs";
import { HerdrBridgeClient } from "./herdr-bridge-client.mjs";
import { createHerdrHttpServer } from "./http-server.mjs";
import { loadPasswordAuth } from "./password-auth.mjs";
import { PasskeyAuth } from "./passkey-auth.mjs";
import { loadWebPushService } from "./web-push-service.mjs";
import { hostname } from "node:os";
import { ServerProfiles } from "./server-profiles.mjs";
import { PeerIdentity } from "./peer-identity.mjs";
import { leafLinkRoutes } from "./link-server.mjs";
import { readAppVersion } from "./app-version.mjs";
import { discoverLeaves, readTailnetPeers } from "./tailnet-peers.mjs";
import { announcementRegistry } from "./announcements.mjs";
import { announcementWriter, readAnnouncements } from "./announcement-store.mjs";
import { announceToHub } from "./leaf-announce.mjs";
import { FileStore } from "./file-store.mjs";
import { MultiServerClient } from "./multi-server-client.mjs";
import { HerdrMachines, machineSocketDirectory } from "./herdr-machines.mjs";
import { PaneAttachments, loadNodePty, nodePtySpawner } from "./pane-attachments.mjs";
import { AiAccounts, runningAgentsIn } from "./ai-accounts.mjs";
import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "./herdr-version.mjs";

const config = readConfig();
const auth = await loadPasswordAuth(config.authFile);
// One look at Tailscale serves both things taken from it: the owner login that
// makes an announcement believable, and the names machines are known by there.
// Until it answers, or if there is no Tailscale, this machine goes by its own
// host name and a linked one by nothing.
const tailnet = readTailnetPeers();
let tailnetNames = { self: null, peers: new Map() };
void tailnet.then((status) => {
  tailnetNames = { self: status.self?.name || null, peers: new Map(status.peers.map((peer) => [peer.address, peer.name])) };
});
function machineName(profile) {
  if (profile.id === "local") return tailnetNames.self || hostname();
  try {
    return tailnetNames.peers.get(new URL(profile.address).hostname) || null;
  } catch {
    return null;
  }
}
// A leaf that also had a password would look protected while its real boundary
// is the peer gate, and a session it handed out could not be revoked for seven
// days. Refusing here beats discovering the mismatch later.
if (config.role === "leaf" && auth.required) {
  console.error("A leaf must not have password authentication. Clear it with: npm run password");
  process.exit(1);
}
// A hub keeps what leaves say about themselves; the owner login is what makes
// an announcement believable, and Tailscale is the only thing that can say it.
const announcements = config.role === "leaf" ? null : await (async () => {
  const registry = announcementRegistry({
    initial: await readAnnouncements(config.announcementsFile),
    save: announcementWriter(config.announcementsFile),
  });
  let owner = null;
  void tailnet.then((status) => { owner = status.self?.login || null; });
  return Object.assign(registry, { ownerLogin: () => owner });
})();

const peer = config.role === "leaf"
  ? new PeerIdentity({ logins: config.peerLogins, addresses: config.peerAddresses })
  : null;
const passkeys = new PasskeyAuth({ auth });
const local = new HerdrBridgeClient({
  binary: config.herdrBin,
  timeoutMs: config.commandTimeoutMs,
});
const push = await loadWebPushService(config.pushFile);
const profiles = await ServerProfiles.load(config.serversFile);
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
// A hub reaches Herdr's own SSH machines (`herdr machine add`) without
// anything installed on them; a leaf answers only for itself.
const machineDirectory = peer ? null : await machineSocketDirectory().catch((error) => {
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
// Without node-pty's native module every pane keeps the screen-text view.
const nodePty = await loadNodePty();
if (!nodePty) console.warn("node-pty is unavailable; terminals show screen text instead of attaching.");
const attachments = nodePty
  ? new PaneAttachments({ resolveTerminal: (paneId, timeoutMs) => herdr.terminalTarget(paneId, timeoutMs), spawnPty: nodePtySpawner(nodePty) })
  : null;
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  machines,
  profiles,
  files,
  auth,
  passkeys,
  push,
  notificationMonitor,
  allowedHosts: allowedRequestHosts(config.host, {
    extraHosts: config.extraAllowedHosts,
  }),
  peer,
  // A leaf answers its hub with its own sessions only, so the link routes get
  // the local Herdr client rather than the aggregating one.
  // Only a hub goes looking: a leaf has no dialog and no one to show it to.
  discover: peer ? null : async (known) => {
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
  announcements: peer ? null : announcements,
  aiAccounts: peer ? null : aiAccounts,
  link: peer ? leafLinkRoutes({ client: local, files, aiAccounts, version: hubVersion, herdrVersion: () => herdrVersion, serverName: hostname() }) : null,
  maxBodyBytes: config.maxBodyBytes,
  maxTransferBytes: config.maxTransferBytes,
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use.`);
  } else {
    console.error("Server failed:", error.message);
  }
  process.exitCode = 1;
});

// A leaf says where it is, because a hub scanning the default port cannot find
// a machine that runs more than one of these.
const announcer = peer
  ? announceToHub({
    hub: config.hub,
    address: `http://${config.host}:${config.port}`,
    name: hostname(),
    version: hubVersion,
  })
  : { stop() {} };

server.listen(config.port, config.host, () => {
  notificationMonitor.start();
  console.log(`HerdRabbit: http://${config.host}:${config.port}`);
  console.log(`Password authentication: ${auth.required ? "enabled" : "disabled"}`);
  if (peer) console.log(`Leaf mode: only ${config.peerLogins.join(", ") || "the configured device"} may call this server`);
  console.log(
    config.host === "0.0.0.0"
      ? "Listening on all IPv4 interfaces. Press Ctrl+C to stop."
      : "Loopback only. Press Ctrl+C to stop.",
  );
});

async function shutdown() {
  herdr.stopped = true;
  notificationMonitor.stop();
  attachments?.close();
  // The machines' SSH connections close before the server stops listening.
  await machines?.stop().catch((error) => console.error("Closing Herdr machines failed:", error.message));
  server.close((error) => {
    if (error) {
      console.error("Shutdown failed:", error.message);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
