import { obsoleteSettingsWarning, readConfig } from "./config.mjs";
import { allowedRequestHosts } from "./allowed-hosts.mjs";
import { AgentNotificationMonitor } from "./agent-notifications.mjs";
import { HerdrBridgeClient } from "./herdr-bridge-client.mjs";
import { createHerdrHttpServer } from "./http-server.mjs";
import { loadPasswordAuth } from "./password-auth.mjs";
import { PasskeyAuth } from "./passkey-auth.mjs";
import { loadWebPushService } from "./web-push-service.mjs";
import { hostname } from "node:os";
import { readAppVersion } from "./app-version.mjs";
import { countLegacyServers } from "./legacy-servers.mjs";
import { FileStore } from "./file-store.mjs";
import { MultiServerClient } from "./multi-server-client.mjs";
import { HerdrMachines, machineSocketDirectory } from "./herdr-machines.mjs";
import { PaneAttachments, loadNodePty, nodePtySpawner } from "./pane-attachments.mjs";
import { AiAccounts, runningAgentsIn } from "./ai-accounts.mjs";
import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "./herdr-version.mjs";

const config = readConfig();
const obsoleteWarning = obsoleteSettingsWarning(config);
if (obsoleteWarning) console.warn(obsoleteWarning);
const auth = await loadPasswordAuth(config.authFile);
// This machine goes by its host name; a Herdr machine by its own label.
function machineName(profile) {
  return profile.id === "local" ? hostname() : null;
}
const passkeys = new PasskeyAuth({ auth });
const local = new HerdrBridgeClient({
  binary: config.herdrBin,
  timeoutMs: config.commandTimeoutMs,
});
const push = await loadWebPushService(config.pushFile);
// Saved links to leaves are not used any more; the page asks once for those
// PCs to be added again with herdr machine.
const legacyServers = await countLegacyServers(config.serversFile).catch((error) => {
  console.warn(`Could not read ${config.serversFile}: ${error.message}`);
  return 0;
});
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
// installed on them.
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
const herdr = new MultiServerClient({ local, hubVersion, machineName, herdrVersion: () => herdrVersion, machines });
// Only this machine's panes decide whether a switch here would disturb anything.
const aiAccounts = new AiAccounts({ directory: config.aiAccountsDir, runningAgents: () => runningAgentsIn(local) });
const notificationMonitor = new AgentNotificationMonitor({ herdr, push });
// Without node-pty's native module every pane is a read-only mirror of its screen.
const nodePty = await loadNodePty();
if (!nodePty) console.warn("node-pty is unavailable; terminals mirror the screen instead of attaching.");
const attachments = nodePty
  ? new PaneAttachments({ resolveTerminal: (paneId, timeoutMs) => herdr.terminalTarget(paneId, timeoutMs), spawnPty: nodePtySpawner(nodePty) })
  : null;
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  machines,
  legacyServers,
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

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use.`);
  } else {
    console.error("Server failed:", error.message);
  }
  process.exitCode = 1;
});

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
