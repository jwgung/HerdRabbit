import { defaultAuthFilePath } from "./password-auth.mjs";
import { defaultPushFilePath } from "./web-push-service.mjs";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_PEER_PORT } from "./link-protocol.mjs";

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

// No limit is Infinity, so every comparison against it simply never trips.
// HERDR_WEB_MAX_TRANSFER_MB sets one limit that applies to uploads and downloads.
function parseMaxTransferBytes(value) {
  if (value === undefined || value.trim() === "") return Infinity;
  const megabytes = Number(value.trim());
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(megabytes * 1024 * 1024) || megabytes < 1) {
    throw new Error("HERDR_WEB_MAX_TRANSFER_MB must be a positive whole number of megabytes");
  }
  return megabytes * 1024 * 1024;
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
// password hash and VAPID keys. The uploads folder has no total size
// limit, and keeping it apart means a path bug can never reach a credential.
function defaultFilesDirectory(environment) {
  if (environment.HERDR_WEB_FILES_DIR) {
    return resolve(environment.HERDR_WEB_FILES_DIR);
  }
  const dataHome = environment.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "herdrabbit", "files");
}

// The in-app update's log and outcome (src/app-update.mjs). Not a secret, and
// kept with the uploads rather than the settings: the run writes it from
// outside the service.
function defaultUpdateDirectory(environment) {
  const dataHome = environment.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "herdrabbit", "update");
}

// One spelling per address, so "0:0:0:0:0:0:0:0", "::0" and "::" are the same
// address everywhere they are compared -- and the same text a Host header
// carries for it.
function canonicalAddress(host) {
  const value = String(host ?? "").trim().toLowerCase();
  if (isIP(value) !== 6) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // An IPv4 address written as IPv6 is that IPv4 address.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

// What a listening address looks like in a URL and in a Host header.
export function hostPort(host, port) {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

// Tailscale hands out addresses from these two ranges and no others.
const TAILNET = new BlockList();
TAILNET.addSubnet("100.64.0.0", 10, "ipv4");
TAILNET.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

function inRange(list, host) {
  const canonical = canonicalAddress(host);
  const family = isIP(canonical);
  return family !== 0 && list.check(canonical, family === 6 ? "ipv6" : "ipv4");
}

function isLoopbackHost(host) {
  return inRange(LOOPBACK, host);
}

function isEveryInterface(host) {
  const canonical = canonicalAddress(host);
  return canonical === "0.0.0.0" || canonical === "::";
}

function isTailnetAddress(host) {
  return inRange(TAILNET, host);
}

// The Connect PC port listens on one address, this PC's tailnet address, so
// the caller's address comes off the socket. Every interface would put it on
// the LAN and every container bridge, where a source address proves nothing,
// and so would a LAN address: only Tailscale's own ranges are taken. Loopback
// is taken too -- nothing but this PC reaches it -- for trying it out here.
function parsePeerHost(value) {
  if (value === undefined || value.trim() === "") return null;
  const host = canonicalAddress(value);
  if (isIP(host) === 0 || !(isTailnetAddress(host) || isLoopbackHost(host))) {
    throw new Error("HERDR_WEB_PEER_HOST must be this PC's tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48), such as 100.64.0.2");
  }
  return host;
}

function parsePeerPort(value, fallback = DEFAULT_PEER_PORT) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("HERDR_WEB_PEER_PORT must be an integer between 1024 and 65535");
  }
  return port;
}

function parseRole(value) {
  const role = (value ?? "").trim() || "hub";
  if (!["hub", "leaf"].includes(role)) {
    throw new Error("HERDR_WEB_ROLE must be hub or leaf");
  }
  return role;
}

function parsePeerLogins(value) {
  if (value === undefined || value.trim() === "") return [];
  const logins = value.split(",").map((login) => login.trim().toLowerCase()).filter(Boolean);
  for (const login of logins) {
    if (login.length > 320 || !/^[^\s,@]+@[^\s,@]+$/u.test(login)) {
      throw new Error("HERDR_WEB_PEER_LOGINS must contain comma-separated tailnet logins");
    }
  }
  return [...new Set(logins)];
}

function parsePeerAddresses(value) {
  if (value === undefined || value.trim() === "") return [];
  // One spelling per address, the one a socket reports: fd7a:115c:a1e0:0::9 is fd7a:115c:a1e0::9.
  const addresses = value.split(",").map((address) => canonicalAddress(address)).filter(Boolean);
  // Only a tailnet address proves a device; loopback is this PC's own, for trying it out here.
  for (const address of addresses) {
    if (isIP(address) === 0 || !(isTailnetAddress(address) || isLoopbackHost(address))) {
      throw new Error("HERDR_WEB_PEER_ADDRESSES must contain comma-separated tailnet addresses (100.64.0.0/10 or fd7a:115c:a1e0::/48)");
    }
  }
  return [...new Set(addresses)];
}

// Where this PC says it is (src/link-announce.mjs): the page of the PC that
// connects to it, by its tailnet name, because that page sits behind
// Tailscale Serve and its certificate is for the name.
function parseHubUrl(value) {
  if (value === undefined || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("HERDR_WEB_HUB must be a full URL, such as https://hub.tailnet.ts.net:38787");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("HERDR_WEB_HUB must be a full URL, such as https://hub.tailnet.ts.net:38787");
  }
  return url.origin;
}

// Every PC has its own page and login (HERDR_WEB_HOST, behind Tailscale Serve)
// and may also open a Connect PC port (HERDR_WEB_PEER_HOST) for other PCs to
// connect to. HERDR_WEB_ROLE=leaf is how an older version said the latter: a
// leaf had no page and listened on its tailnet address for its hub alone. Such
// a unit keeps answering its hub on that same address and port, and its page
// moves to loopback.
function peerSettings(environment, host, port) {
  const role = parseRole(environment.HERDR_WEB_ROLE);
  let peerHost = parsePeerHost(environment.HERDR_WEB_PEER_HOST);
  let peerPort = parsePeerPort(environment.HERDR_WEB_PEER_PORT);
  let pageHost = host;
  if (role === "leaf") {
    if (peerHost === null && !isLoopbackHost(host) && !isEveryInterface(host)) {
      peerHost = parsePeerHost(host);
      peerPort = parsePeerPort(environment.HERDR_WEB_PEER_PORT, port);
    }
    pageHost = "127.0.0.1";
  }
  if (peerHost !== null && peerHost === pageHost && peerPort === port) {
    throw new Error("HERDR_WEB_PEER_PORT must differ from HERDR_WEB_PORT when both listen on the same address");
  }
  return {
    host: pageHost,
    wasLeaf: role === "leaf",
    peerHost,
    peerPort,
    peerLogins: parsePeerLogins(environment.HERDR_WEB_PEER_LOGINS),
    peerAddresses: parsePeerAddresses(environment.HERDR_WEB_PEER_ADDRESSES),
    hub: parseHubUrl(environment.HERDR_WEB_HUB),
  };
}

// Where HerdRabbit keeps what it remembers: the password hash, push keys, the
// connected PCs and the saved AI sign-ins. The file browser refuses all of it
// (src/protected-paths.mjs), so this is the one place that says where it is.
export function dataPaths(environment = process.env) {
  const authFile = defaultAuthFilePath(environment);
  return {
    authFile,
    // PCs connected with Connect PC.
    serversFile: environment.HERDR_WEB_SERVERS_FILE
      ? resolve(environment.HERDR_WEB_SERVERS_FILE)
      : join(dirname(authFile), "servers.json"),
    // Where PCs that announced themselves said they are.
    announcementsFile: join(dirname(authFile), "announced.json"),
    // Saved AI CLI sign-ins sit with the other credentials, not with uploads.
    aiAccountsDir: environment.HERDR_WEB_AI_ACCOUNTS_DIR
      ? resolve(environment.HERDR_WEB_AI_ACCOUNTS_DIR)
      : join(dirname(authFile), "ai-accounts"),
    pushFile: defaultPushFilePath(environment),
  };
}

export function readConfig(environment = process.env) {
  const port = parsePort(environment.HERDR_WEB_PORT);
  const peer = peerSettings(environment, parseHost(environment.HERDR_WEB_HOST), port);
  return Object.freeze({
    port,
    herdrBin: environment.HERDR_BIN || "herdr",
    ...dataPaths(environment),
    extraAllowedHosts: parseAllowedHosts(environment.HERDR_WEB_ALLOWED_HOSTS),
    filesDir: defaultFilesDirectory(environment),
    updateDir: defaultUpdateDirectory(environment),
    commandTimeoutMs: 5_000,
    maxBodyBytes: 16 * 1024,
    maxTransferBytes: parseMaxTransferBytes(environment.HERDR_WEB_MAX_TRANSFER_MB),
    ...peer,
  });
}

// One line at startup for a unit an older version wrote, or null.
export function legacyLeafWarning({ wasLeaf = false, peerHost = null, peerPort = null, port } = {}) {
  if (!wasLeaf) return null;
  const peer = peerHost
    ? `It keeps answering its hub on the Connect PC port ${peerHost}:${peerPort}.`
    : "Its hub cannot connect: a leaf behind Tailscale Serve needs HERDR_WEB_PEER_HOST set to this PC's tailnet address.";
  return `HERDR_WEB_ROLE=leaf is from an older version. This PC now has its own page on 127.0.0.1:${port}. ${peer} ` +
    "Run npm run install-service to set it up again.";
}

// A leaf never had a password: the old server refused one and relied on the
// peer gate instead. Its page is new, and some leaves sat on loopback behind
// Tailscale Serve, which forwards the whole tailnet to it -- so without a
// password a former leaf's page serves only this message. Its Connect PC port
// is unaffected.
export function formerLeafRefusal({ wasLeaf = false } = {}, passwordRequired) {
  if (!wasLeaf || passwordRequired) return null;
  return "HerdRabbit's page is locked: this PC was installed as a leaf and has no password. Run npm run install-service here to set it up again (it asks for a password), or npm run password and restart the service.";
}

export { parseAllowedHosts, parseHubUrl, parseMaxTransferBytes, parseHost, parsePeerAddresses, parsePeerHost, parsePeerLogins, parsePeerPort, parsePort, parseRole };
