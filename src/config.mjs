import { defaultAuthFilePath } from "./password-auth.mjs";
import { defaultPushFilePath } from "./web-push-service.mjs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_PORT = 38_787;
// Any single address is narrower than 0.0.0.0, so binding to one interface --
// a Tailscale address, say -- is a tightening rather than a risk. Only literal
// addresses are taken: a hostname would be resolved at listen time and could
// land somewhere other than the interface the operator meant.
function parseHost(value) {
  const host = value || "127.0.0.1";
  if (isIP(host) === 0) {
    throw new Error("HERDR_WEB_HOST must be an IP address, such as 127.0.0.1, 0.0.0.0, or this host's Tailscale address");
  }
  return host;
}

function parsePort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("HERDR_WEB_PORT must be an integer between 1024 and 65535");
  }

  return port;
}

function parseAllowedHosts(value) {
  if (value === undefined || value.trim() === "") return [];
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  for (const host of hosts) {
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
      throw new Error("HERDR_WEB_ALLOWED_HOSTS must contain comma-separated hostnames");
    }
  }
  return [...new Set(hosts)];
}

// Transferred files live outside the configuration directory that holds the
// password hash, SSH passwords, and VAPID keys. The uploads folder has no total size
// limit, and keeping it apart means a path bug can never reach a credential.
function defaultFilesDirectory(environment) {
  if (environment.HERDR_WEB_FILES_DIR) {
    return resolve(environment.HERDR_WEB_FILES_DIR);
  }
  const dataHome = environment.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "herdrabbit", "files");
}

// Settings that only ever applied to a leaf (a second HerdRabbit linked over
// Tailscale), which is gone: remote PCs are Herdr's own SSH machines now. An old
// leaf's unit still carries them, and it must keep starting rather than crash.
const OBSOLETE_LEAF_SETTINGS = ["HERDR_WEB_ROLE", "HERDR_WEB_PEER_LOGINS", "HERDR_WEB_PEER_ADDRESSES", "HERDR_WEB_HUB"];

// A leaf listened on its tailnet address with no password, trusting a peer
// gate that no longer exists. Kept there it would hand every device on the
// tailnet an open terminal, so a former leaf answers on loopback only.
export function obsoleteLeafSettings(environment) {
  const names = OBSOLETE_LEAF_SETTINGS.filter((name) => (environment[name] ?? "").trim() !== "");
  return { names, wasLeaf: (environment.HERDR_WEB_ROLE ?? "").trim() === "leaf" };
}

export function readConfig(environment = process.env) {
  const obsolete = obsoleteLeafSettings(environment);
  const host = parseHost(environment.HERDR_WEB_HOST);
  return Object.freeze({
    host: obsolete.wasLeaf ? "127.0.0.1" : host,
    port: parsePort(environment.HERDR_WEB_PORT),
    herdrBin: environment.HERDR_BIN || "herdr",
    authFile: defaultAuthFilePath(environment),
    // Links to leaves saved by an older version. Only read, to tell the owner
    // to add those PCs again with herdr machine; never written or removed.
    serversFile: environment.HERDR_WEB_SERVERS_FILE || join(dirname(defaultAuthFilePath(environment)), "servers.json"),
    // Saved AI CLI sign-ins sit with the other credentials, not with uploads.
    aiAccountsDir: environment.HERDR_WEB_AI_ACCOUNTS_DIR
      ? resolve(environment.HERDR_WEB_AI_ACCOUNTS_DIR)
      : join(dirname(defaultAuthFilePath(environment)), "ai-accounts"),
    pushFile: defaultPushFilePath(environment),
    extraAllowedHosts: parseAllowedHosts(environment.HERDR_WEB_ALLOWED_HOSTS),
    filesDir: defaultFilesDirectory(environment),
    commandTimeoutMs: 5_000,
    maxBodyBytes: 16 * 1024,
    maxTransferBytes: 50 * 1024 * 1024,
    // Named by the startup warning, then ignored.
    obsoleteSettings: Object.freeze(obsolete.names),
    wasLeaf: obsolete.wasLeaf,
  });
}

// One line at startup, or null when nothing obsolete is set.
export function obsoleteSettingsWarning({ obsoleteSettings = [], wasLeaf = false } = {}) {
  if (obsoleteSettings.length === 0) return null;
  const ignored = `Ignoring ${obsoleteSettings.join(", ")}: leaf mode was removed, and remote PCs are added with herdr machine.`;
  return wasLeaf
    ? `${ignored} This former leaf listens on 127.0.0.1 only; run npm run install-service to set it up again.`
    : ignored;
}

// A leaf never had a password: the old server refused one and relied on the
// peer gate instead. Some sat on loopback behind Tailscale Serve, which still
// forwards the tailnet to them, so loopback alone does not close them. Without
// a password a former leaf serves only this message.
export function formerLeafRefusal({ wasLeaf = false } = {}, passwordRequired) {
  if (!wasLeaf || passwordRequired) return null;
  return "HerdRabbit is locked: this former leaf has no password, and leaf mode with its peer gate was removed. Run npm run install-service here to set it up again (it asks for a password), or npm run password and restart the service.";
}

export { parseAllowedHosts, parseHost, parsePort };
