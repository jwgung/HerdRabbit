import { parseHerdrVersion } from "./herdr-version.mjs";

export const LINK_PROTOCOL = 1;

// The fields MultiServerClient.scope() prefixes with a server id. Only these
// carry routing meaning, so only these are checked for a foreign namespace --
// a project named "ship it!" is not a forwarded record.
const ID_FIELDS = ["session_id", "herdr_session_id", "workspace_id", "active_tab_id", "tab_id", "pane_id"];

const COLLECTIONS = ["herdr_sessions", "workspaces", "tabs", "panes", "agents"];
const FOCUSED = ["focused_workspace_id", "focused_tab_id", "focused_pane_id"];
// Enough for any real machine, and a bound on what a leaf can make the hub hold.
const MAX_RECORDS = 2_000;

// Both machines are moved by the same update script and nothing in a snapshot
// records which HerdRabbit shaped it, so an exact match is the honest test.
// The protocol number is carried separately so relaxing this later -- "same
// protocol, warn on version" -- is a change inside this function alone.
export function checkLeafCompatibility({ hubVersion, hubProtocol = LINK_PROTOCOL, serverName = "that server" }, hello) {
  if (!hello || typeof hello !== "object" || hello.product !== "herdrabbit" ||
      typeof hello.version !== "string" || hello.version === "") {
    return {
      ok: false,
      code: "leaf_not_herdrabbit",
      reason: "That address answered, but it is not a HerdRabbit server.",
    };
  }
  if (hello.link_protocol !== hubProtocol) {
    return {
      ok: false,
      code: "leaf_version_mismatch",
      reason: `HerdRabbit ${hello.version} on ${serverName} speaks a different link protocol. Update both machines.`,
    };
  }
  if (hello.version !== hubVersion) {
    return {
      ok: false,
      code: "leaf_version_mismatch",
      reason: `HerdRabbit ${hello.version} on ${serverName} does not match ${hubVersion} here. Update both machines to the same version.`,
    };
  }
  // A leaf that forwards other servers would hand back ids from a namespace
  // this hub has no way to route.
  if (hello.scope !== "local") {
    return {
      ok: false,
      code: "leaf_scope",
      reason: "That HerdRabbit reports servers other than its own, which a link cannot represent.",
    };
  }
  return { ok: true, version: hello.version, herdrVersion: parseHerdrVersion(hello.herdr_version)?.join(".") ?? null };
}

function usableRecord(record) {
  if (!record || typeof record !== "object") return false;
  // A leaf reports its own sessions and nothing else. It says so in the
  // handshake, but saying so is easy to get wrong, so anything that looks
  // forwarded is dropped here regardless of what it claimed.
  if (typeof record.server_id === "string" && record.server_id !== "local") return false;
  return !ID_FIELDS.some((field) => typeof record[field] === "string" && record[field].includes("!"));
}

// The hub stamps its own server_id and prefixes every id, so whatever the leaf
// put there would only collide with that.
function stripOwnership({ server_id, server_name, ...record }) {
  return record;
}

export function normalizeLeafSnapshot(value) {
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
