import { parseHerdrVersion } from "./herdr-version.mjs";

export const LINK_PROTOCOL = 1;

// The Connect PC port a PC opens unless told otherwise (HERDR_WEB_PEER_PORT).
// It sits beside the page's port, which Tailscale Serve holds on the tailnet
// address.
export const DEFAULT_PEER_PORT = 38_788;

// The fields MultiServerClient.scope() prefixes with a server id. Only these
// carry routing meaning, so only these are checked for a foreign namespace --
// a project named "ship it!" is not a forwarded record.
const ID_FIELDS = ["session_id", "herdr_session_id", "workspace_id", "active_tab_id", "tab_id", "pane_id"];

const COLLECTIONS = ["herdr_sessions", "workspaces", "tabs", "panes", "agents"];
const FOCUSED = ["focused_workspace_id", "focused_tab_id", "focused_pane_id"];
// Enough for any real machine, and a bound on what a connected PC can make the hub hold.
const MAX_RECORDS = 2_000;

// What decides whether two PCs can be connected is the link protocol: the
// shape of the snapshot and the routes under /api/link/. It changes only when
// those do, so two PCs a few releases apart still connect. The app version is
// carried along to be shown (Details), never compared.
//
// A refusal names both sides' protocol and app version, so the person can see
// which PC to update without opening either one.
export function checkLinkCompatibility({ hubVersion = null, hubProtocol = LINK_PROTOCOL, serverName = "that PC" }, hello) {
  if (!hello || typeof hello !== "object" || hello.product !== "herdrabbit" ||
      typeof hello.version !== "string" || hello.version === "") {
    return {
      ok: false,
      code: "link_not_herdrabbit",
      reason: "That address answered, but it is not a HerdRabbit server.",
    };
  }
  const version = hello.version.slice(0, 40);
  const protocol = Number.isSafeInteger(hello.link_protocol) ? hello.link_protocol : null;
  if (protocol !== hubProtocol) {
    const here = hubVersion ? `HerdRabbit ${hubVersion}, protocol ${hubProtocol}` : `protocol ${hubProtocol}`;
    return {
      ok: false,
      code: "link_protocol_mismatch",
      version,
      protocol,
      reason: `${serverName} runs HerdRabbit ${version} with connection protocol ${protocol ?? "unknown"}; ` +
        `this PC runs ${here}. Update the older one.`,
    };
  }
  // A connected PC that forwards other servers would hand back ids from a namespace
  // this hub has no way to route.
  if (hello.scope !== "local") {
    return {
      ok: false,
      code: "link_scope",
      reason: "That HerdRabbit reports servers other than its own, which a link cannot represent.",
    };
  }
  return {
    ok: true,
    version,
    protocol,
    herdrVersion: parseHerdrVersion(hello.herdr_version)?.text ?? null,
  };
}

function usableRecord(record) {
  if (!record || typeof record !== "object") return false;
  // A connected PC reports its own sessions and nothing else. It says so in the
  // handshake, but saying so is easy to get wrong, so anything that looks
  // forwarded is dropped here regardless of what it claimed.
  if (typeof record.server_id === "string" && record.server_id !== "local") return false;
  return !ID_FIELDS.some((field) => typeof record[field] === "string" && record[field].includes("!"));
}

// The hub stamps its own server_id and prefixes every id, so whatever the connected PC
// put there would only collide with that.
function stripOwnership({ server_id, server_name, ...record }) {
  return record;
}

export function normalizeLinkSnapshot(value) {
  const snapshot = value && typeof value === "object" ? value : {};
  const normalized = {
    protocol: snapshot.protocol,
    version: snapshot.version,
  };
  for (const key of FOCUSED) {
    normalized[key] = typeof snapshot[key] === "string" ? snapshot[key] : null;
  }
  for (const key of COLLECTIONS) {
    const records = Array.isArray(snapshot[key]) ? snapshot[key] : [];
    normalized[key] = records.filter(usableRecord).slice(0, MAX_RECORDS).map(stripOwnership);
  }
  return normalized;
}

export class ResponseTooLarge extends Error {
  constructor(limit) {
    super(`The answer was larger than ${limit} bytes.`);
    this.name = "ResponseTooLarge";
  }
}

// A peer's answer, read no further than `limit` bytes. What another PC says is
// not trusted to end, so the count is kept as it arrives and the read is
// cancelled the moment it goes past -- whatever Content-Length claimed.
export async function readLimitedText(response, limit) {
  if (!response.body) return "";
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body.cancel().catch(() => {});
    throw new ResponseTooLarge(limit);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLarge(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
