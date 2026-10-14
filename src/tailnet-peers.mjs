import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_PEER_PORT, checkLeafCompatibility, readLimitedText } from "./leaf-protocol.mjs";

const run = promisify(execFile);

// Probing every peer costs one request each, so keep them short and bounded.
const PROBE_TIMEOUT_MS = 1_500;
const MAX_PEERS = 32;
// A hello is a few hundred bytes; a machine that says more is not HerdRabbit.
const MAX_HELLO_BYTES = 16 * 1024;

// Discovery asks the default Connect PC port only. A PC on another port
// announces itself (src/leaf-announce.mjs) -- guessing a range would turn one
// dialog into a port scan.
export { DEFAULT_PEER_PORT };

export async function readTailnetPeers(execute = run) {
  let status;
  try {
    const { stdout } = await execute("tailscale", ["status", "--json"], { timeout: 3_000 });
    status = JSON.parse(stdout);
  } catch {
    return { available: false, self: null, peers: [] };
  }
  if (status?.BackendState !== "Running") return { available: false, self: null, peers: [] };

  const fullName = (value) => String(value?.DNSName || "").replace(/\.$/u, "");
  const name = (value) => fullName(value).split(".")[0];
  const address = (value) => (Array.isArray(value?.TailscaleIPs) ? value.TailscaleIPs : [])
    .find((item) => !String(item).includes(":")) || null;

  const peers = Object.values(status.Peer || {})
    .map((peer) => ({ name: name(peer), fullName: fullName(peer), address: address(peer), online: peer?.Online === true }))
    .filter((peer) => peer.address && peer.name)
    .sort((first, second) => (first.name < second.name ? -1 : 1))
    .slice(0, MAX_PEERS);

  const login = String(status.User?.[status.Self?.UserID]?.LoginName || "").toLowerCase();
  return {
    available: true,
    self: { name: name(status.Self), fullName: fullName(status.Self), address: address(status.Self), login },
    peers,
  };
}

// The tailnet account a tailnet address belongs to, or null. The Connect PC
// port uses it for an allowed list of accounts (HERDR_WEB_PEER_LOGINS).
export async function tailnetLoginOf(address, execute = run) {
  try {
    const { stdout } = await execute("tailscale", ["whois", "--json", String(address)], { timeout: 3_000 });
    const login = JSON.parse(stdout)?.UserProfile?.LoginName;
    return typeof login === "string" && login !== "" ? login.toLowerCase() : null;
  } catch {
    return null;
  }
}

// What a machine is, from this hub's point of view. The reasons matter as much
// as the verdict: "installed but does not accept you" and "nothing there" send
// a person to completely different places.
//
// The clock covers the whole answer, not just its headers, and the answer is
// read no further than a hello could be: whatever is on that port may not be
// HerdRabbit at all, and may never stop talking.
async function probe(peer, { hubVersion, port, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS }) {
  const address = `http://${peer.address}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await answer(peer, address, hubVersion, fetchImpl, controller);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function answer(peer, address, hubVersion, fetchImpl, controller) {
  let response;
  try {
    response = await fetchImpl(`${address}/api/link/hello`, { signal: controller.signal });
  } catch {
    return { ...peer, address, state: "absent", reason: "No HerdRabbit answered on this machine." };
  }
  if (!response.ok) await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) {
    return {
      ...peer,
      address,
      state: "refused",
      reason: "HerdRabbit is running there but does not allow this PC. Add this PC to its allowed list.",
    };
  }
  if (!response.ok) {
    return { ...peer, address, state: "absent", reason: `That address answered with ${response.status}.` };
  }
  let hello = null;
  try { hello = JSON.parse(await readLimitedText(response, MAX_HELLO_BYTES)); } catch { /* handled by the check below */ }
  const verdict = checkLeafCompatibility({ hubVersion, serverName: `"${peer.name}"` }, hello);
  return verdict.ok
    ? { ...peer, address, state: "ready", version: verdict.version }
    : { ...peer, address, state: "incompatible", reason: verdict.reason, version: verdict.version ?? null };
}

export async function discoverLeaves({
  hubVersion,
  port = DEFAULT_PEER_PORT,
  fetchImpl = globalThis.fetch,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  execute = run,
  known = [],
  announced = [],
} = {}) {
  const tailnet = await readTailnetPeers(execute);
  if (!tailnet.available) return { available: false, self: null, candidates: [] };

  const registered = new Set(known);
  const byName = new Map(tailnet.peers.map((peer) => [peer.address, peer.name]));

  const probes = tailnet.peers.map(async (peer) => {
    // An offline peer cannot be probed, and saying so beats a timeout.
    if (!peer.online) {
      return { ...peer, address: `http://${peer.address}:${port}`, state: "offline", reason: "This machine is offline." };
    }
    return probe(peer, { hubVersion, port, fetchImpl, timeoutMs: probeTimeoutMs });
  });

  // A machine that announced itself is on a port no scan would have tried --
  // a second account on a machine that already has one, most often.
  const claims = announced.map(async (claim) => {
    const host = new URL(claim.address).hostname;
    const peer = { name: byName.get(host) ? `${byName.get(host)} (${new URL(claim.address).port})` : claim.name, address: host };
    return probe(peer, { hubVersion, port: new URL(claim.address).port || port, fetchImpl, timeoutMs: probeTimeoutMs });
  });

  const found = await Promise.all([...probes, ...claims]);
  const seen = new Set();
  const candidates = [];
  for (const result of found) {
    if (seen.has(result.address)) continue;
    seen.add(result.address);
    candidates.push(registered.has(result.address) ? { ...result, state: "added" } : result);
  }

  return { available: true, self: tailnet.self, candidates };
}
