import test from "node:test";
import assert from "node:assert/strict";
import { formerLeafRefusal, obsoleteSettingsWarning, parseAllowedHosts, parseHost, parsePort, readConfig } from "../src/config.mjs";

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

test("nothing obsolete is set on a fresh install", () => {
  const config = readConfig({});
  assert.deepEqual(config.obsoleteSettings, []);
  assert.equal(config.wasLeaf, false);
  assert.equal(obsoleteSettingsWarning(config), null);
});

test("a former leaf still starts, on loopback only, with one warning", () => {
  // Its unit still says leaf and binds its tailnet address with no password.
  // Leaf mode is gone, so kept there it would be an open terminal on the tailnet.
  const config = readConfig({
    HERDR_WEB_ROLE: "leaf",
    HERDR_WEB_HOST: "100.101.171.95",
    HERDR_WEB_PEER_ADDRESSES: "100.64.0.9",
    HERDR_WEB_HUB: "https://hub.example.ts.net:38787",
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.wasLeaf, true);
  assert.equal("role" in config, false);
  assert.equal("peerAddresses" in config, false);
  assert.deepEqual(config.obsoleteSettings, ["HERDR_WEB_ROLE", "HERDR_WEB_PEER_ADDRESSES", "HERDR_WEB_HUB"]);
  const warning = obsoleteSettingsWarning(config);
  assert.match(warning, /^Ignoring HERDR_WEB_ROLE, HERDR_WEB_PEER_ADDRESSES, HERDR_WEB_HUB:/u);
  assert.match(warning, /herdr machine/u);
  assert.match(warning, /127\.0\.0\.1 only/u);
  assert.equal(warning.includes("\n"), false);
});

test("stray leaf settings on a normal server are ignored, not fatal", () => {
  // These used to refuse to start; now they mean nothing and the bind stays.
  const config = readConfig({ HERDR_WEB_HOST: "100.101.171.95", HERDR_WEB_PEER_LOGINS: "owner@example.com", HERDR_WEB_ROLE: "hub" });
  assert.equal(config.host, "100.101.171.95");
  assert.equal(config.wasLeaf, false);
  assert.deepEqual(config.obsoleteSettings, ["HERDR_WEB_ROLE", "HERDR_WEB_PEER_LOGINS"]);
  assert.doesNotMatch(obsoleteSettingsWarning(config), /127\.0\.0\.1/u);
});

test("a former leaf without a password refuses to start", () => {
  // Behind Tailscale Serve a loopback bind still reaches the tailnet, and the
  // peer gate that guarded it is gone; only a password closes it now.
  const leaf = readConfig({ HERDR_WEB_ROLE: "leaf", HERDR_WEB_HOST: "127.0.0.1", HERDR_WEB_PEER_LOGINS: "owner@example.com" });
  assert.match(formerLeafRefusal(leaf, false), /no password.*npm run install-service/u);
  assert.equal(formerLeafRefusal(leaf, true), null);
  assert.equal(formerLeafRefusal(readConfig({}), false), null);
  assert.equal(formerLeafRefusal(readConfig({ HERDR_WEB_ROLE: "hub" }), false), null);
});
