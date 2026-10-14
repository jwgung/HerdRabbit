import test from "node:test";
import assert from "node:assert/strict";
import * as peerIdentity from "../src/peer-identity.mjs";

const { PeerIdentity, PeerRejected, isLoopbackSocket, nearestForwardedAddress, normalizeLogin, socketAddress } = peerIdentity;
const OWNER = "owner@example.com";
const HUB = "100.101.171.95";

test("still names the headers Tailscale Serve stamps on", () => {
  assert.equal(peerIdentity.PEER_LOGIN_HEADER, "tailscale-user-login");
  assert.equal(peerIdentity.PEER_ADDRESS_HEADER, "x-forwarded-for");
});

const from = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });

async function refusal(identity, request) {
  try {
    await identity.authorize(request);
  } catch (error) {
    assert.ok(error instanceof PeerRejected);
    return error.code;
  }
  return null;
}

test("an empty allowed list lets nobody in", async () => {
  const identity = new PeerIdentity();
  assert.equal(identity.configured, false);
  for (const address of [HUB, "127.0.0.1", "::1"]) {
    assert.equal(await refusal(identity, from(address)), "peer_not_allowed", address);
  }
});

test("a device is let in by the address on its socket, never by a header", async () => {
  const identity = new PeerIdentity({ addresses: [HUB] });
  assert.deepEqual(await identity.authorize(from(`::ffff:${HUB}`)), { address: HUB, login: null });
  assert.equal(await refusal(identity, from("100.64.0.9")), "peer_address_rejected");
  // Serve's headers mean nothing on this port: anyone can write them.
  assert.equal(await refusal(identity, from("127.0.0.1", {
    [peerIdentity.PEER_ADDRESS_HEADER]: HUB, [peerIdentity.PEER_LOGIN_HEADER]: OWNER,
  })), "peer_address_rejected");
  assert.equal(await refusal(identity, { socket: {}, headers: {} }), "peer_transport_rejected");
});

test("an account is looked up for the socket's address, and a failed lookup refuses", async () => {
  const lookups = [];
  const logins = { [HUB]: "Owner@Example.com", "100.64.0.9": "someone@else" };
  const identity = new PeerIdentity({
    logins: [OWNER],
    loginOf: async (address) => { lookups.push(address); if (address === "100.64.0.7") throw new Error("no tailscale"); return logins[address] ?? null; },
  });
  assert.deepEqual(await identity.authorize(from(HUB, { [peerIdentity.PEER_LOGIN_HEADER]: "forged@example" })), { address: HUB, login: OWNER });
  assert.equal(await refusal(identity, from("100.64.0.9", { [peerIdentity.PEER_LOGIN_HEADER]: OWNER })), "peer_identity_rejected");
  assert.equal(await refusal(identity, from("100.64.0.7")), "peer_identity_rejected");
  assert.equal(await refusal(identity, from("100.64.0.8")), "peer_identity_rejected");
  await identity.authorize(from(HUB));
  assert.equal(lookups.filter((address) => address === HUB).length, 1, "a known answer is reused briefly");
});

test("with both lists a caller has to match both", async () => {
  const identity = new PeerIdentity({ addresses: [HUB], logins: [OWNER], loginOf: async () => "someone@else" });
  assert.equal(await refusal(identity, from(HUB)), "peer_identity_rejected");
  const right = new PeerIdentity({ addresses: [HUB], logins: [OWNER], loginOf: async () => OWNER });
  assert.equal(await refusal(right, from("100.64.0.9")), "peer_address_rejected");
  assert.deepEqual(await right.authorize(from(HUB)), { address: HUB, login: OWNER });
});

test("a second forged identity header cannot smuggle the real one in", () => {
  // Node folds repeated headers into one comma-joined value, so an attacker
  // who can add a header would otherwise ride along with the genuine value.
  assert.equal(normalizeLogin(` ${OWNER.toUpperCase()} `), OWNER);
  assert.equal(normalizeLogin(`attacker@example, ${OWNER}`), null);
  assert.equal(normalizeLogin([OWNER]), null);
  assert.equal(normalizeLogin("   "), null);
  assert.equal(normalizeLogin(`${OWNER}\u0000`), null, "control characters are not a login");
});

test("the forwarded address is read from the last hop only", () => {
  // Every proxy appends, so anything before the final entry is caller input.
  assert.equal(nearestForwardedAddress(`10.0.0.1, ${HUB}`), HUB);
  assert.equal(nearestForwardedAddress(HUB), HUB);
  assert.equal(nearestForwardedAddress("not-an-address"), null);
  assert.equal(nearestForwardedAddress(""), null);
});

test("reads the shapes a peer address arrives in", () => {
  assert.equal(socketAddress({ socket: { remoteAddress: "::ffff:100.101.171.95" } }), "100.101.171.95");
  assert.equal(socketAddress({ socket: {} }), null);
  for (const address of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]) {
    assert.ok(isLoopbackSocket({ socket: { remoteAddress: address } }), address);
  }
  for (const address of ["100.101.171.95", "192.168.0.5", "::ffff:10.0.0.1", undefined]) {
    assert.ok(!isLoopbackSocket({ socket: { remoteAddress: address } }), String(address));
  }
});
