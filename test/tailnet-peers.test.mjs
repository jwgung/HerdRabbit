import test from "node:test";
import assert from "node:assert/strict";
import { discoverLeaves, readTailnetPeers, tailnetLoginOf } from "../src/tailnet-peers.mjs";

const HUB_VERSION = "1.4.0";

const status = {
  BackendState: "Running",
  Self: { DNSName: "hub.tailnet.ts.net.", TailscaleIPs: ["100.64.0.1", "fd7a::1"] },
  Peer: {
    a: { DNSName: "ready-box.tailnet.ts.net.", TailscaleIPs: ["100.64.0.2"], Online: true },
    b: { DNSName: "sleeping.tailnet.ts.net.", TailscaleIPs: ["100.64.0.3"], Online: false },
    c: { DNSName: "bare.tailnet.ts.net.", TailscaleIPs: ["100.64.0.4"], Online: true },
    d: { DNSName: "strict.tailnet.ts.net.", TailscaleIPs: ["100.64.0.5"], Online: true },
    e: { DNSName: "older.tailnet.ts.net.", TailscaleIPs: ["100.64.0.6"], Online: true },
  },
};

const execute = async () => ({ stdout: JSON.stringify(status) });

const answers = {
  "100.64.0.2": { status: 200, body: { product: "herdrabbit", version: HUB_VERSION, link_protocol: 1, scope: "local" } },
  "100.64.0.4": "refuse-connection",
  "100.64.0.5": { status: 403, body: { error: { code: "peer_address_rejected" } } },
  "100.64.0.6": { status: 200, body: { product: "herdrabbit", version: "1.1.0", link_protocol: 99, scope: "local" } },
};

const fetchImpl = async (url) => {
  const address = new URL(url).hostname;
  const answer = answers[address];
  if (answer === "refuse-connection") throw new Error("ECONNREFUSED");
  return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
};

function stateOf(candidates, name) {
  return candidates.find((candidate) => candidate.name === name)?.state;
}

test("reads the tailnet, dropping what cannot be addressed", async () => {
  const tailnet = await readTailnetPeers(execute);
  assert.equal(tailnet.available, true);
  assert.deepEqual(tailnet.self,
    { name: "hub", fullName: "hub.tailnet.ts.net", address: "100.64.0.1", login: "" });
  assert.deepEqual(tailnet.peers.map((peer) => peer.name), ["bare", "older", "ready-box", "sleeping", "strict"]);
});

test("says what each machine is rather than hiding the ones that will not work", async () => {
  // A machine missing from the list is indistinguishable from a machine that
  // is refusing this hub, and those need completely different fixes.
  const { candidates, self } = await discoverLeaves({ hubVersion: HUB_VERSION, execute, fetchImpl });
  assert.equal(self.address, "100.64.0.1");
  assert.equal(stateOf(candidates, "ready-box"), "ready");
  assert.equal(stateOf(candidates, "sleeping"), "offline", "an offline peer is named, not probed");
  assert.equal(stateOf(candidates, "bare"), "absent");
  assert.equal(stateOf(candidates, "strict"), "refused");
  assert.equal(stateOf(candidates, "older"), "incompatible", "another link protocol cannot be connected");
  const older = candidates.find((candidate) => candidate.name === "older");
  assert.match(older.reason, /1\.1\.0 with connection protocol 99/u);
  assert.equal(older.version, "1.1.0");
  // Every probe asks the default Connect PC port.
  assert.equal(candidates.find((candidate) => candidate.name === "ready-box").address, "http://100.64.0.2:38788");
});

test("marks a machine that is already registered", async () => {
  const { candidates } = await discoverLeaves({
    hubVersion: HUB_VERSION, execute, fetchImpl,
    known: ["http://100.64.0.2:38788"],
  });
  assert.equal(stateOf(candidates, "ready-box"), "added");
});

test("a PC on another app version but the same link protocol is ready to connect", async () => {
  const answering = async () => ({ ok: true, status: 200, json: async () => ({ product: "herdrabbit", version: "9.0.0", link_protocol: 1, scope: "local" }) });
  const { candidates } = await discoverLeaves({ hubVersion: HUB_VERSION, execute, fetchImpl: answering });
  assert.equal(stateOf(candidates, "ready-box"), "ready");
  assert.equal(candidates.find((candidate) => candidate.name === "ready-box").version, "9.0.0");
});

test("looks up the tailnet account of an address, and says nothing when it cannot", async () => {
  const calls = [];
  const whois = async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: JSON.stringify({ UserProfile: { LoginName: "Owner@Example.com" } }) };
  };
  assert.equal(await tailnetLoginOf("100.64.0.2", whois), "owner@example.com");
  assert.deepEqual(calls[0], ["tailscale", "whois", "--json", "100.64.0.2"]);
  assert.equal(await tailnetLoginOf("100.64.0.2", async () => { throw new Error("not on the tailnet"); }), null);
  assert.equal(await tailnetLoginOf("100.64.0.2", async () => ({ stdout: "{}" })), null);
});

test("reports plainly when there is no tailnet to read", async () => {
  const found = await discoverLeaves({
    hubVersion: HUB_VERSION,
    execute: async () => { throw new Error("tailscale: not found"); },
  });
  assert.deepEqual(found, { available: false, self: null, candidates: [] });
});
