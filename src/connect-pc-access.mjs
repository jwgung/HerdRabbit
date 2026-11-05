// Settings → PCs → "Let other PCs connect": this PC's Connect PC port, opened
// to every device of this PC's own tailnet account, or to the tailnet devices
// chosen on the page, or closed. Installed as a Herdr plugin, HerdRabbit reads
// its settings from the plugin's .env (src/plugin-runner.mjs), so that is what
// is written: HERDR_WEB_PEER_HOST (this PC's own tailnet address, which opens
// the port) and who may use it, HERDR_WEB_PEER_LOGINS (this PC's account) or
// HERDR_WEB_PEER_ADDRESSES (the devices). Both set would mean a caller has to
// match both (src/peer-identity.mjs), so one is written, never the two. The
// page keeps these three lines; the port and every other line are left as
// they are. The new settings are
// checked as the server will read them before anything is written, and
// HerdRabbit restarts through Herdr to take them up. A systemd install keeps
// its settings in its unit; the page then says to run the installer there.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open as openFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { HttpError } from "./http-basics.mjs";
import { hostPort, parsePeerAddresses, readConfig } from "./config.mjs";
import { ENV_TEMPLATE, parseEnvFile } from "./plugin-runner.mjs";

const MAX_ALLOWED = 32;
const LIVE_PEER_LINE = /^\s*(?:export\s+)?HERDR_WEB_PEER_(?:HOST|ADDRESSES|LOGINS)\s*=/u;
const MARK = "# Connect PC, set from Settings → PCs";

// `text` without its live HERDR_WEB_PEER_HOST, _ADDRESSES and _LOGINS lines
// (comments stay), and with `peer`'s at the end: { host, addresses, logins },
// the host left out when it is null, an empty list left out.
export function peerEnvText(text, { host = null, addresses = [], logins = [] } = {}) {
  const lines = String(text).split(/\r?\n/u).filter((line) => !LIVE_PEER_LINE.test(line) && line.trim() !== MARK);
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
  const add = [
    ...(host ? [`HERDR_WEB_PEER_HOST=${host}`] : []),
    ...(addresses.length ? [`HERDR_WEB_PEER_ADDRESSES=${addresses.join(",")}`] : []),
    ...(logins.length ? [`HERDR_WEB_PEER_LOGINS=${logins.join(",")}`] : []),
  ];
  if (add.length) lines.push("", MARK, ...add);
  return `${lines.join("\n")}\n`;
}

const invalid = (message) => new HttpError(400, "invalid_input", message);
const linked = () => new HttpError(409, "connect_pc_env_link", "The plugin's .env is a link. Change HERDR_WEB_PEER_HOST and HERDR_WEB_PEER_ADDRESSES in the file it points to.");

// The plugin's .env as text, or null when there is none; never through a link.
async function readEnv(path) {
  let handle;
  try {
    handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") throw linked();
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw linked();
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

// Whether the port can be opened there now: a missing address or a port in
// use would stop the restarted server, page and all.
function canListenOn(host, port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error) => resolve(error.code ?? "error"));
    probe.listen(port, host, () => probe.close(() => resolve(null)));
  });
}

// Tailscale's addresses in the spelling parsePeerAddresses gives, skipping any it would not take.
function canonicalList(addresses) {
  return new Set(addresses.flatMap((address) => {
    try { return parsePeerAddresses(String(address)); } catch { return []; }
  }));
}

export class ConnectPcAccess {
  // `envFile` is the plugin's .env, or null outside the plugin. `current` is
  // what this server runs with ({ host, port, addresses, logins }). `restart`
  // hands the restart to Herdr; it must not wait for this process to end.
  // `canListen(host, port)` answers null when the port can open there, else why not.
  constructor({ envFile, pagePort, current, readTailnet, restart, canListen = canListenOn }) {
    this.canListen = canListen;
    this.envFile = envFile;
    this.pagePort = pagePort;
    this.current = current;
    this.readTailnet = readTailnet;
    this.restart = restart;
    this.saving = false;
  }

  async state() {
    const tailnet = await this.readTailnet();
    const allowed = new Set(this.current.addresses);
    return {
      supported: this.envFile !== null,
      tailnet: tailnet.available === true,
      open: this.current.host !== null,
      address: this.current.host ? `http://${hostPort(this.current.host, this.current.port)}` : null,
      // Every device signed in to Tailscale as this PC's own account may connect.
      mine: Boolean(tailnet.self?.login) && this.current.logins.includes(tailnet.self.login),
      self: tailnet.self ? { name: tailnet.self.name, address: tailnet.self.address, login: tailnet.self.login || null } : null,
      peers: (tailnet.peers ?? []).map((peer) => ({ name: peer.name, address: peer.address, online: peer.online === true, allowed: allowed.has(peer.address) })),
    };
  }

  async save(body) {
    if (typeof body?.open !== "boolean") throw invalid("Say whether the Connect PC port is open.");
    if (this.envFile === null) {
      throw new HttpError(409, "connect_pc_not_plugin", "This HerdRabbit runs as a systemd service. Run npm run install-service on this PC to open its Connect PC port.");
    }
    if (this.saving) throw new HttpError(409, "connect_pc_busy", "Another change is being saved or HerdRabbit is restarting. Wait for it to finish.");
    this.saving = true;
    try {
      // Saved, this server is about to restart: no second change meanwhile.
      return await this.#save(body);
    } catch (error) {
      this.saving = false;
      throw error;
    }
  }

  async #save({ open, addresses = [], mine = false }) {
    if (typeof mine !== "boolean") throw invalid("Say whether all your PCs may connect.");
    const tailnet = await this.readTailnet();
    const own = tailnet.self?.login || null;
    let peer = {};
    if (open) {
      if (!Array.isArray(addresses) || addresses.length > MAX_ALLOWED || addresses.some((item) => typeof item !== "string" || item.includes(","))) {
        throw invalid(`Choose up to ${MAX_ALLOWED} PCs from the list.`);
      }
      if (!tailnet.available || !tailnet.self?.address) {
        throw new HttpError(409, "tailscale_unavailable", "Tailscale is not running on this PC, so it has no tailnet address to open the port on.");
      }
      if (mine && addresses.length > 0) throw invalid("Choose all your PCs or some devices, not both.");
      if (!mine && addresses.length === 0) throw invalid("Choose who may connect.");
      if (mine && !(own && own.length <= 320 && /^[^\s,@]+@[^\s,@]+$/u.test(own))) {
        throw new HttpError(409, "tailscale_account_unknown", "Tailscale did not name an account this PC is signed in as, so all your PCs cannot be told apart. Choose the devices instead.");
      }
      let chosen;
      try {
        chosen = parsePeerAddresses(addresses.join(","));
      } catch {
        throw invalid("Choose PCs from the list.");
      }
      // Only devices Tailscale lists for this tailnet, and never this PC itself.
      const listed = canonicalList((tailnet.peers ?? []).map((item) => item.address));
      if (chosen.some((address) => !listed.has(address))) throw invalid("Choose PCs from the list.");
      if (this.current.port === this.pagePort) {
        throw new HttpError(409, "connect_pc_port_taken", `The Connect PC port ${this.current.port} is this page's own port. Set HERDR_WEB_PEER_PORT to another port in the plugin's .env.`);
      }
      // A list of devices with accounts beside it would let in only devices of those accounts.
      peer = mine ? { host: tailnet.self.address, logins: [own] } : { host: tailnet.self.address, addresses: chosen };
    }

    const before = (await readEnv(this.envFile)) ?? ENV_TEMPLATE;
    const text = peerEnvText(before, peer);
    // As the server will read it on the restart: a setting it would refuse
    // would keep the page from coming back.
    let next;
    try {
      next = readConfig(parseEnvFile(text));
    } catch (error) {
      throw new HttpError(409, "connect_pc_settings_invalid", `The plugin's .env would not start: ${error.message}. Fix it on this PC.`);
    }
    // An older version's leaf opens its port from HERDR_WEB_HOST, which this does not change.
    if (next.wasLeaf) {
      throw new HttpError(409, "connect_pc_legacy_leaf", "This PC's settings are an older version's leaf (HERDR_WEB_ROLE=leaf). Run npm run install-service here first.");
    }
    if (next.peerHost && !(next.peerHost === this.current.host && next.peerPort === this.current.port)) {
      const failed = await this.canListen(next.peerHost, next.peerPort);
      if (failed) {
        throw new HttpError(409, "connect_pc_port_unavailable", failed === "EADDRINUSE"
          ? `Port ${next.peerPort} is in use on this PC. Set HERDR_WEB_PEER_PORT to another port in the plugin's .env.`
          : `The Connect PC port cannot open on ${next.peerHost}:${next.peerPort} (${failed}).`);
      }
    }
    const temp = join(dirname(this.envFile), `.env.herdrabbit-${randomBytes(6).toString("hex")}`);
    try {
      await writeFile(temp, text, { mode: 0o600, flag: "wx" });
      await rename(temp, this.envFile);
    } catch (error) {
      await rm(temp, { force: true });
      throw new HttpError(500, "connect_pc_write_failed", `The plugin's .env could not be written: ${error?.code ?? "error"}.`);
    }
    await this.restart();
    return {
      restarting: true,
      open: Boolean(peer.host),
      address: peer.host ? `http://${hostPort(peer.host, next.peerPort)}` : null,
      addresses: peer.addresses ?? [],
      mine: Boolean(own) && (peer.logins ?? []).includes(own),
    };
  }
}
