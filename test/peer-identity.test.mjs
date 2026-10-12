import test from "node:test";
import assert from "node:assert/strict";
import * as peerIdentity from "../src/peer-identity.mjs";

const { isLoopbackSocket, nearestForwardedAddress, normalizeLogin, socketAddress } = peerIdentity;
const OWNER = "owner@example.com";
const HUB = "100.101.171.95";

test("the leaf gate is gone; only the caller helpers remain", () => {
  assert.equal("PeerIdentity" in peerIdentity, false);
  assert.equal("PeerRejected" in peerIdentity, false);
  assert.equal(peerIdentity.PEER_LOGIN_HEADER, "tailscale-user-login");
  assert.equal(peerIdentity.PEER_ADDRESS_HEADER, "x-forwarded-for");
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
