import test from "node:test";
import assert from "node:assert/strict";
import {
  formerLeafRefusal, legacyLeafWarning, parseAllowedHosts, parseHost, parseHubUrl, parseMaxTransferBytes,
  parsePeerAddresses, parsePeerHost, parsePeerLogins, parsePeerPort, parsePort, parseRole, readConfig,
} from "../src/config.mjs";

test("uses safe loopback defaults", () => {
  const config = readConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 38_787);
  assert.equal(config.herdrBin, "herdr");
  assert.match(config.authFile, /\/\.config\/herdr-bridge\/auth\.json$/);
  assert.match(config.pushFile, /\/\.config\/herdr-bridge\/push\.json$/);
  assert.deepEqual(config.extraAllowedHosts, []);
});

test("accepts an explicit authentication file", () => {
  assert.equal(
    readConfig({ HERDR_WEB_AUTH_FILE: "/tmp/herdr-auth.json" }).authFile,
    "/tmp/herdr-auth.json",
  );
});

test("accepts an explicit push configuration file", () => {
  assert.equal(
    readConfig({ HERDR_WEB_PUSH_FILE: "/tmp/herdr-push.json" }).pushFile,
    "/tmp/herdr-push.json",
  );
});

test("accepts explicit proxy hostnames without accepting paths or ports", () => {
  assert.deepEqual(
    parseAllowedHosts("Workstation.tailnet.ts.net, local.example"),
    ["workstation.tailnet.ts.net", "local.example"],
  );
  assert.throws(() => parseAllowedHosts("https://local.example"));
  assert.throws(() => parseAllowedHosts("local.example:443"));
});

test("accepts an explicit unprivileged port", () => {
  assert.equal(parsePort("30001"), 30_001);
});

test("binds where it is told, defaulting to loopback", () => {
  assert.equal(parseHost(undefined), "127.0.0.1");
  assert.equal(parseHost("0.0.0.0"), "0.0.0.0");
  assert.equal(readConfig({ HERDR_WEB_HOST: "0.0.0.0" }).host, "0.0.0.0");
  // One interface only -- a Tailscale address -- keeps the service off every
  // other network the machine is on, which 0.0.0.0 cannot do.
  assert.equal(parseHost("100.101.171.95"), "100.101.171.95");
  assert.equal(parseHost("::1"), "::1");
});

test("refuses a host that is not a literal address", () => {
  // A name is resolved when the socket is opened, so it could bind an
  // interface the operator never meant to expose.
  for (const value of ["gungbuntu.example.ts.net", "localhost", "0.0.0.0:38787", "100.101.171"]) {
    assert.throws(() => parseHost(value), /HERDR_WEB_HOST/u);
  }
});

test("rejects privileged or malformed ports", () => {
  for (const value of ["80", "0", "abc", "65536", "8787.5"]) {
    assert.throws(() => parsePort(value));
  }
});

test("the Connect PC port is closed on a fresh install", () => {
  const config = readConfig({});
  assert.equal(config.peerHost, null);
  assert.equal(config.peerPort, 38_788);
  assert.deepEqual(config.peerAddresses, []);
  assert.deepEqual(config.peerLogins, []);
  assert.equal(config.wasLeaf, false);
  assert.equal(legacyLeafWarning(config), null);
});

test("opens the Connect PC port on one tailnet address beside the page", () => {
  const config = readConfig({
    HERDR_WEB_PEER_HOST: "100.101.171.95",
    HERDR_WEB_PEER_ADDRESSES: "100.64.0.9, 100.64.0.9",
    HERDR_WEB_PEER_LOGINS: "Owner@Example.com",
    HERDR_WEB_HUB: "https://hub.example.ts.net:38787/",
  });
  // The page stays on loopback behind Tailscale Serve, with its login.
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.peerHost, "100.101.171.95");
  assert.equal(config.peerPort, 38_788);
  assert.deepEqual(config.peerAddresses, ["100.64.0.9"]);
  assert.deepEqual(config.peerLogins, ["owner@example.com"]);
  assert.equal(config.hub, "https://hub.example.ts.net:38787");
  assert.equal(readConfig({ HERDR_WEB_PEER_HOST: "100.101.171.95", HERDR_WEB_PEER_PORT: "30002" }).peerPort, 30_002);
});

test("refuses a Connect PC port that would listen everywhere or clash with the page", () => {
  for (const value of ["0.0.0.0", "::", "box.ts.net", "100.101.171"]) {
    assert.throws(() => parsePeerHost(value), /HERDR_WEB_PEER_HOST/u, value);
  }
  for (const value of ["80", "abc", "65536"]) {
    assert.throws(() => parsePeerPort(value), /HERDR_WEB_PEER_PORT/u, value);
  }
  assert.throws(() => readConfig({ HERDR_WEB_HOST: "100.64.0.2", HERDR_WEB_PEER_HOST: "100.64.0.2", HERDR_WEB_PEER_PORT: "38787" }),
    /HERDR_WEB_PEER_PORT must differ/u);
  assert.throws(() => parsePeerAddresses("100.64.0.9, box"), /HERDR_WEB_PEER_ADDRESSES/u);
  assert.throws(() => parsePeerLogins("owner"), /HERDR_WEB_PEER_LOGINS/u);
  assert.throws(() => parseHubUrl("https://hub.example.ts.net/path"), /HERDR_WEB_HUB/u);
  assert.throws(() => parseRole("server"), /HERDR_WEB_ROLE/u);
});

test("a former leaf keeps answering its hub on the same address and port, and its page moves to loopback", () => {
  const config = readConfig({
    HERDR_WEB_ROLE: "leaf",
    HERDR_WEB_HOST: "100.101.171.95",
    HERDR_WEB_PEER_ADDRESSES: "100.64.0.9",
    HERDR_WEB_HUB: "https://hub.example.ts.net:38787",
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.wasLeaf, true);
  assert.equal(config.peerHost, "100.101.171.95");
  assert.equal(config.peerPort, 38_787, "the hub's saved address keeps working");
  assert.deepEqual(config.peerAddresses, ["100.64.0.9"]);
  const warning = legacyLeafWarning(config);
  assert.match(warning, /127\.0\.0\.1:38787/u);
  assert.match(warning, /100\.101\.171\.95:38787/u);
  assert.equal(warning.includes("\n"), false);
});

test("a former leaf behind Tailscale Serve gets a page but no Connect PC port", () => {
  const config = readConfig({ HERDR_WEB_ROLE: "leaf", HERDR_WEB_HOST: "127.0.0.1", HERDR_WEB_PEER_LOGINS: "owner@example.com" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.peerHost, null);
  assert.match(legacyLeafWarning(config), /HERDR_WEB_PEER_HOST/u);
});

test("a former leaf without a password keeps its page locked", () => {
  // Behind Tailscale Serve a loopback page still reaches the tailnet, and a
  // leaf never had a password; only setting one opens the page.
  const leaf = readConfig({ HERDR_WEB_ROLE: "leaf", HERDR_WEB_HOST: "127.0.0.1", HERDR_WEB_PEER_LOGINS: "owner@example.com" });
  assert.match(formerLeafRefusal(leaf, false), /no password.*npm run install-service/u);
  assert.equal(formerLeafRefusal(leaf, true), null);
  assert.equal(formerLeafRefusal(readConfig({}), false), null);
  assert.equal(formerLeafRefusal(readConfig({ HERDR_WEB_ROLE: "hub" }), false), null);
});

test("has no transfer size limit unless HERDR_WEB_MAX_TRANSFER_MB sets one", () => {
  assert.equal(readConfig({}).maxTransferBytes, Infinity);
  assert.equal(readConfig({ HERDR_WEB_MAX_TRANSFER_MB: "" }).maxTransferBytes, Infinity);
  assert.equal(readConfig({ HERDR_WEB_MAX_TRANSFER_MB: "50" }).maxTransferBytes, 50 * 1024 * 1024);
  assert.equal(parseMaxTransferBytes(" 4096 "), 4096 * 1024 * 1024);
});

test("refuses a transfer limit that is not a positive whole number", () => {
  for (const value of ["0", "-5", "1.5", "abc", "50MB", "1e3", "999999999999999"]) {
    assert.throws(() => readConfig({ HERDR_WEB_MAX_TRANSFER_MB: value }), /HERDR_WEB_MAX_TRANSFER_MB/u, value);
  }
});
