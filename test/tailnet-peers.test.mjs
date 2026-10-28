import test from "node:test";
import assert from "node:assert/strict";
import { discoverPeers, readTailnetPeers, tailnetLoginOf } from "../src/tailnet-peers.mjs";

const HUB_VERSION = "1.4.1";

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
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
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
  const { candidates, self } = await discoverPeers({ hubVersion: HUB_VERSION, execute, fetchImpl });
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
  const { candidates } = await discoverPeers({
    hubVersion: HUB_VERSION, execute, fetchImpl,
    known: ["http://100.64.0.2:38788"],
  });
  assert.equal(stateOf(candidates, "ready-box"), "added");
});

test("a device with only an IPv6 tailnet address is still found, at a bracketed address", async () => {
  const onlySix = { ...status, Peer: { f: { DNSName: "six.tailnet.ts.net.", TailscaleIPs: ["fd7a:115c:a1e0::6"], Online: true } } };
  const asked = [];
  const { candidates } = await discoverPeers({
    hubVersion: HUB_VERSION,
    execute: async () => ({ stdout: JSON.stringify(onlySix) }),
    fetchImpl: async (url) => { asked.push(url); return new Response(JSON.stringify({ product: "herdrabbit", version: HUB_VERSION, link_protocol: 1, scope: "local" }), { status: 200 }); },
  });
  assert.equal(stateOf(candidates, "six"), "ready");
  assert.equal(candidates.find((candidate) => candidate.name === "six").address, "http://[fd7a:115c:a1e0::6]:38788");
  assert.deepEqual(asked, ["http://[fd7a:115c:a1e0::6]:38788/api/link/hello"]);
});

test("a saved announcement that is not an address is left out, not the whole search", async () => {
  const { candidates } = await discoverPeers({
    hubVersion: HUB_VERSION, execute, fetchImpl,
    announced: [{ name: "broken", address: "not a url" }, { name: "odd", address: "file:///etc/passwd" }, { name: "second", address: "http://100.64.0.2:30002" }],
  });
  assert.equal(stateOf(candidates, "ready-box"), "ready");
  assert.equal(stateOf(candidates, "broken"), undefined);
  assert.equal(stateOf(candidates, "odd"), undefined);
  assert.ok(candidates.some((candidate) => candidate.address === "http://100.64.0.2:30002"), "a good claim is still probed");
});

test("a PC on another app version but the same link protocol is ready to connect", async () => {
  const answering = async () => new Response(JSON.stringify({ product: "herdrabbit", version: "9.0.0", link_protocol: 1, scope: "local" }), { status: 200 });
  const { candidates } = await discoverPeers({ hubVersion: HUB_VERSION, execute, fetchImpl: answering });
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
  const found = await discoverPeers({
    hubVersion: HUB_VERSION,
    execute: async () => { throw new Error("tailscale: not found"); },
  });
  assert.deepEqual(found, { available: false, self: null, candidates: [] });
});

test("a machine that never stops answering, or answers too slowly, is not taken for HerdRabbit", async () => {
  const hello = JSON.stringify({ product: "herdrabbit", version: HUB_VERSION, link_protocol: 1, scope: "local" });
  let cancelled = 0;
  const endless = () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(32)); },
    cancel() { cancelled += 1; },
  }), { status: 200 });
  // Its headers come at once; the body a byte at a time, slower than the clock.
  const slow = (signal) => new Response(new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal.aborted) { controller.error(signal.reason); return; }
      controller.enqueue(new TextEncoder().encode(" "));
    },
  }), { status: 200 });
  const peers = {
    BackendState: "Running",
    Self: { DNSName: "hub.tailnet.ts.net.", TailscaleIPs: ["100.64.0.1"] },
    Peer: {
      a: { DNSName: "endless.tailnet.ts.net.", TailscaleIPs: ["100.64.0.2"], Online: true },
      b: { DNSName: "slow.tailnet.ts.net.", TailscaleIPs: ["100.64.0.3"], Online: true },
      c: { DNSName: "ready.tailnet.ts.net.", TailscaleIPs: ["100.64.0.4"], Online: true },
    },
  };
  const started = Date.now();
  const result = await discoverPeers({
    hubVersion: HUB_VERSION,
    execute: async () => ({ stdout: JSON.stringify(peers) }),
    probeTimeoutMs: 300,
    fetchImpl: async (url, { signal }) => {
      const host = new URL(url).hostname;
      if (host === "100.64.0.2") return endless();
      if (host === "100.64.0.3") return slow(signal);
      return new Response(hello, { status: 200 });
    },
  });
  assert.ok(Date.now() - started < 3_000, "the clock covers the body too");
  assert.equal(stateOf(result.candidates, "endless"), "incompatible");
  assert.equal(stateOf(result.candidates, "slow"), "incompatible");
  assert.equal(stateOf(result.candidates, "ready"), "ready");
  assert.equal(cancelled, 1, "the endless answer is cut off, not read to the end");
});
