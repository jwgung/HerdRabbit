// Who a request comes from, as far as this server can tell. The password
// check counts wrong guesses per caller (see attemptKey in http-server.mjs),
// and behind Tailscale Serve every caller arrives on loopback: Serve stamps
// the caller's tailnet login and address onto each request it forwards, and
// strips those headers from public (Funnel) traffic. They are only worth
// reading on a loopback socket; anywhere else they are client input.
//
// The Connect PC port is the other case, and PeerIdentity below decides it
// from the socket alone.

const LOGIN_HEADER = "tailscale-user-login";
const FORWARDED_FOR_HEADER = "x-forwarded-for";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export { LOGIN_HEADER as PEER_LOGIN_HEADER, FORWARDED_FOR_HEADER as PEER_ADDRESS_HEADER };

// Node folds repeated headers into one comma-joined value, so a forged second
// Tailscale-User-Login arrives as "attacker@example, owner@example". There is
// no legitimate comma in a login, so any comma means someone sent a second
// header and the value cannot be trusted at all.
export function normalizeLogin(value) {
  if (typeof value !== "string") return null;
  if (value.includes(",") || CONTROL_CHARACTERS.test(value)) return null;
  const login = value.trim().toLowerCase();
  return login === "" ? null : login;
}

// X-Forwarded-For is the opposite case: each proxy appends, so commas are
// expected and only the last entry was written by the proxy nearest to us.
// Anything earlier is whatever the caller chose to send.
export function nearestForwardedAddress(value) {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return null;
  const hops = value.split(",").map((hop) => hop.trim()).filter(Boolean);
  if (hops.length === 0) return null;
  const address = hops[hops.length - 1].toLowerCase();
  // Serve hands us a bare address, never a port, so anything else is unexpected.
  return /^[0-9a-f.:]+$/u.test(address) ? address : null;
}

export function socketAddress(request) {
  const address = request?.socket?.remoteAddress;
  if (typeof address !== "string" || address === "") return null;
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  return bare.toLowerCase();
}

export function isLoopbackAddress(address) {
  return address === "::1" || (typeof address === "string" && address.startsWith("127."));
}

export function isLoopbackSocket(request) {
  return isLoopbackAddress(socketAddress(request));
}

export class PeerRejected extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PeerRejected";
    this.status = status;
    this.code = code;
  }
}

const LOGIN_CACHE_MS = 30_000;
const FAILED_LOGIN_CACHE_MS = 5_000;

// Who may use the Connect PC port (src/peer-server.mjs). That port listens on
// this PC's own tailnet address, never behind Tailscale Serve, so the caller's
// address is read straight off the socket: the kernel sets it from a
// WireGuard-authenticated peer, and no process can claim another device's
// address the way it could write a header. Headers are ignored entirely here.
//
//   addresses  tailnet addresses allowed to connect
//   logins     tailnet accounts allowed to connect, looked up for the socket's
//              address with `tailscale whois` (`loginOf`)
//
// With both set a caller must match both. With neither set nobody is let in:
// an empty list closes the port rather than opening it to the whole tailnet.
export class PeerIdentity {
  constructor({ logins = [], addresses = [], socketOf = socketAddress, loginOf = async () => null, now = () => Date.now() } = {}) {
    this.logins = new Set(logins.map((login) => String(login).trim().toLowerCase()).filter(Boolean));
    this.addresses = new Set(addresses.map((address) => String(address).trim().toLowerCase()).filter(Boolean));
    this.socketOf = socketOf;
    this.loginOf = loginOf;
    this.now = now;
    this.knownLogins = new Map();
  }

  get configured() {
    return this.logins.size > 0 || this.addresses.size > 0;
  }

  async authorize(request) {
    const from = this.socketOf(request);
    if (from === null) {
      throw new PeerRejected(403, "peer_transport_rejected",
        "This PC could not tell where that request came from.");
    }
    if (!this.configured) {
      throw new PeerRejected(403, "peer_not_allowed",
        "This PC does not accept other PCs: its allowed list is empty.");
    }
    if (this.addresses.size > 0 && !this.addresses.has(from)) {
      throw new PeerRejected(403, "peer_address_rejected",
        "This PC does not accept requests from that device.");
    }
    if (this.logins.size === 0) return { address: from, login: null };
    const login = await this.#login(from);
    if (login === null || !this.logins.has(login)) {
      throw new PeerRejected(403, "peer_identity_rejected",
        "This PC does not accept requests from that account.");
    }
    return { address: from, login };
  }

  // A lookup runs `tailscale`, so an answer is kept briefly: a known login for
  // a while, a failed lookup (which refuses) for a few seconds, so a device
  // that keeps knocking does not start a process each time.
  async #login(address) {
    const known = this.knownLogins.get(address);
    if (known && this.now() - known.at < (known.login === null ? FAILED_LOGIN_CACHE_MS : LOGIN_CACHE_MS)) return known.login;
    let login = null;
    try { login = normalizeLogin(await this.loginOf(address)); } catch { login = null; }
    if (this.knownLogins.size > 256) this.knownLogins.clear();
    this.knownLogins.set(address, { login, at: this.now() });
    return login;
  }
}
