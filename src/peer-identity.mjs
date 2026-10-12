// Who a request comes from, as far as this server can tell. The password
// check counts wrong guesses per caller (see attemptKey in http-server.mjs),
// and behind Tailscale Serve every caller arrives on loopback: Serve stamps
// the caller's tailnet login and address onto each request it forwards, and
// strips those headers from public (Funnel) traffic. They are only worth
// reading on a loopback socket; anywhere else they are client input.

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
