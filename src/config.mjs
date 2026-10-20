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

function parseAutoFit(value) {
  if (value === undefined || value === "") return false;
  if (!["1", "0", "true", "false", "on", "off"].includes(String(value).toLowerCase())) {
    throw new Error("HERDR_WEB_AUTO_FIT must be 1 or 0");
  }
  return ["1", "true", "on"].includes(String(value).toLowerCase());
}

function parseRole(value) {
  const role = value || "hub";
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
  const addresses = value.split(",").map((address) => address.trim().toLowerCase()).filter(Boolean);
  for (const address of addresses) {
    if (isIP(address) === 0) {
      throw new Error("HERDR_WEB_PEER_ADDRESSES must contain comma-separated IP addresses");
    }
  }
  return [...new Set(addresses)];
}

// Where a leaf reports itself. The same install answer that says which hub may
// call it also says which hub to call -- as a name, because the hub sits behind
// Tailscale Serve and its certificate is for the tailnet name, not the address.
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

function isLoopbackHost(host) {
  return host === "::1" || host.startsWith("127.");
}

function isEveryInterface(host) {
  return host === "0.0.0.0" || host === "::";
}

// A leaf proves its caller from headers Tailscale Serve stamps on, which are
// only trustworthy while Serve is the one thing that can reach the socket. Every
// rule here exists because the alternative fails open and stays quiet about it.
function checkPeerConfiguration({ role, peerLogins, peerAddresses, host }) {
  const configured = peerLogins.length > 0 || peerAddresses.length > 0;
  if (role === "leaf" && !configured) {
    throw new Error("HERDR_WEB_ROLE=leaf requires HERDR_WEB_PEER_LOGINS or HERDR_WEB_PEER_ADDRESSES");
  }
  // Two shapes are safe, and they differ in where the proof comes from.
  //
  //   loopback  Tailscale Serve sits in front and stamps the caller's identity
  //             on; that is only trustworthy because nothing else can reach
  //             the socket.
  //   one address  the leaf listens on its own tailnet address and reads the
  //             caller straight off the socket, which the kernel sets from a
  //             WireGuard-authenticated peer. No Serve, no HTTPS needed.
  //
  // Every interface is neither: it would put the leaf on the LAN and on every
  // container bridge, where a source address proves nothing.
  if (role === "leaf" && isEveryInterface(host)) {
    throw new Error("HERDR_WEB_ROLE=leaf cannot bind every interface; use 127.0.0.1 behind Tailscale Serve, or this machine's tailnet address");
  }
  if (role === "leaf" && !isLoopbackHost(host) && peerAddresses.length === 0) {
    throw new Error("A leaf bound to its tailnet address identifies its hub by that hub's address, so HERDR_WEB_PEER_ADDRESSES is required");
  }
  // Peers configured without the role would leave the API open to the whole
  // tailnet while the hub keeps working and nothing looks wrong.
  if (role !== "leaf" && configured) {
    throw new Error("HERDR_WEB_PEER_LOGINS and HERDR_WEB_PEER_ADDRESSES only apply with HERDR_WEB_ROLE=leaf");
  }
}

export function readConfig(environment = process.env) {
  const peer = {
    role: parseRole(environment.HERDR_WEB_ROLE),
    peerLogins: parsePeerLogins(environment.HERDR_WEB_PEER_LOGINS),
    peerAddresses: parsePeerAddresses(environment.HERDR_WEB_PEER_ADDRESSES),
    hub: parseHubUrl(environment.HERDR_WEB_HUB),
  };
  checkPeerConfiguration({ ...peer, host: parseHost(environment.HERDR_WEB_HOST) });
  return Object.freeze({
    host: parseHost(environment.HERDR_WEB_HOST),
    port: parsePort(environment.HERDR_WEB_PORT),
    herdrBin: environment.HERDR_BIN || "herdr",
    authFile: defaultAuthFilePath(environment),
    serversFile: environment.HERDR_WEB_SERVERS_FILE || join(dirname(defaultAuthFilePath(environment)), "servers.json"),
    announcementsFile: join(dirname(defaultAuthFilePath(environment)), "announced.json"),
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
    autoFit: parseAutoFit(environment.HERDR_WEB_AUTO_FIT),
    ...peer,
  });
}

export { parseAllowedHosts, parseAutoFit, parseHost, parseHubUrl, parsePeerAddresses, parsePeerLogins, parsePort, parseRole };
