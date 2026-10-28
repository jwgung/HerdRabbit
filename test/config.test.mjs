import test from "node:test";
import assert from "node:assert/strict";
import {
  formerLeafRefusal, hostPort, legacyLeafWarning, parseAllowedHosts, parseHost, parseHubUrl, parseMaxTransferBytes,
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
  // a LAN address proves no device: only tailnet addresses (and this PC's loopback)
  assert.throws(() => parsePeerAddresses("192.168.0.20"), /HERDR_WEB_PEER_ADDRESSES/u);
  assert.deepEqual(parsePeerAddresses("127.0.0.1, fd7a:115c:a1e0::9"), ["127.0.0.1", "fd7a:115c:a1e0::9"]);
  // written the long way, an address is the one a socket reports
  assert.deepEqual(parsePeerAddresses("FD7A:115C:A1E0:0:0:0:0:9, fd7a:115c:a1e0::9"), ["fd7a:115c:a1e0::9"]);
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

test("the Connect PC port listens only on a tailnet address, however the address is spelled", () => {
  // Every spelling of "every interface", and any address outside Tailscale's ranges.
  for (const value of ["::0", "0:0:0:0:0:0:0:0", "0::0", "::ffff:0.0.0.0", "::ffff:0:0", "0.0.0.0",
    "192.168.1.10", "10.0.0.2", "172.17.0.1", "100.128.0.1", "100.63.255.255", "fe80::1", "fd7a:115c:a1e1::1", "2001:db8::1"]) {
    assert.throws(() => parsePeerHost(value), /HERDR_WEB_PEER_HOST must be this PC's tailnet address/u, value);
  }
  assert.equal(parsePeerHost("100.64.0.2"), "100.64.0.2");
  assert.equal(parsePeerHost("100.127.255.254"), "100.127.255.254");
  assert.equal(parsePeerHost("FD7A:115C:A1E0:0:0:0:0:1"), "fd7a:115c:a1e0::1", "kept in the spelling a Host header carries");
  assert.equal(parsePeerHost("::ffff:100.64.0.2"), "100.64.0.2");
  // Loopback reaches nothing but this PC, so trying it out here is allowed.
  assert.equal(parsePeerHost("127.0.0.1"), "127.0.0.1");
  assert.equal(parsePeerHost("::1"), "::1");
});

test("a former leaf on a LAN address does not start answering the LAN", () => {
  assert.throws(() => readConfig({ HERDR_WEB_ROLE: "leaf", HERDR_WEB_HOST: "192.168.1.10" }), /HERDR_WEB_PEER_HOST/u);
  assert.equal(readConfig({ HERDR_WEB_ROLE: "leaf", HERDR_WEB_HOST: "::0" }).peerHost, null);
});

test("an IPv6 address is bracketed wherever it is written with a port", () => {
  assert.equal(hostPort("fd7a:115c:a1e0::1", 38_788), "[fd7a:115c:a1e0::1]:38788");
  assert.equal(hostPort("100.64.0.2", 38_788), "100.64.0.2:38788");
});

test("the plugin id is Herdr's id or nothing", () => {
  assert.equal(readConfig({}).pluginId, null);
  assert.equal(readConfig({ HERDR_WEB_PLUGIN_ID: " herdrabbit " }).pluginId, "herdrabbit");
  for (const value of ["", "../x", "-rf", "a b", "x".repeat(65)]) {
    assert.equal(readConfig({ HERDR_WEB_PLUGIN_ID: value }).pluginId, null, value);
  }
});

test("the plugin's folders are absolute paths Herdr named, or nothing", () => {
  const config = readConfig({ HERDR_WEB_PLUGIN_CONFIG_DIR: "/cfg/herdrabbit", HERDR_WEB_PLUGIN_STATE_DIR: " /state/herdrabbit " });
  assert.equal(config.pluginConfigDir, "/cfg/herdrabbit");
  assert.equal(config.pluginStateDir, "/state/herdrabbit");
  assert.equal(readConfig({}).pluginConfigDir, null);
  for (const value of ["", "relative/dir", "/a\nb"]) {
    assert.equal(readConfig({ HERDR_WEB_PLUGIN_STATE_DIR: value }).pluginStateDir, null, JSON.stringify(value));
  }
});
