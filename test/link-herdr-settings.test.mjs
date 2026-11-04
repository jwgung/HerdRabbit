import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkRoutes } from "../src/link-server.mjs";
import { LinkClient } from "../src/link-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { HerdrSettings } from "../src/herdr-settings.mjs";
import { fakeHerdrSettings } from "./fixtures/fake-herdr-settings.mjs";

const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const herdr = { async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; } };

// The connected PC: its own Herdr (a fake) and its own config.toml in a temporary home.
async function connectedPc(context) {
  const home = await mkdtemp(join(tmpdir(), "link-herdr-settings-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".config", "herdr"), { recursive: true });
  const configPath = join(home, ".config", "herdr", "config.toml");
  await writeFile(configPath, "onboarding = false\n");
  const fake = fakeHerdrSettings({ configPath });
  return { fake, configPath, settings: new HerdrSettings({ run: fake.run, home }) };
}

async function startPeer(context, { herdrSettings = null, allowed = ["127.0.0.1"], signIn = true } = {}) {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: allowed }),
    link: linkRoutes({ client: herdr, herdrSettings, pluginsAllowed: () => signIn, version: "2.0.0", serverName: "dev-box" }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const client = (address) => new LinkClient({ profile: { id: LINK_ID, name: "Dev box", address }, hubVersion: "2.0.0" });

async function startHub(context, remote) {
  const app = createHerdrHttpServer({
    herdr: { ...herdr, herdrSettingsClient: (id) => (id === LINK_ID ? remote.herdrSettings() : null) },
    csrfToken: "csrf",
    logger: { error() {} },
    auth: { required: true, hasValidSession: () => true, hasValidLaunchToken: () => true, onSessionsEnded: () => () => {} },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const send = (method, path, body) => fetch(`${origin}${path}`, {
    method, headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin }, body: JSON.stringify(body),
  });
  return { get: (path) => fetch(`${origin}${path}`), send };
}

const changes = (fake) => fake.state.calls.map((call) => call.args.join(" "))
  .filter((args) => !["--help", "channel show", "integration status", "config check"].includes(args));

test("a PC that manages Herdr's settings names it among its features", async (context) => {
  const { settings } = await connectedPc(context);
  const address = await startPeer(context, { herdrSettings: settings });
  assert.ok((await (await fetch(`${address}/api/link/hello`)).json()).features.includes("herdr_settings"));
  const without = await startPeer(context);
  assert.ok(!(await (await fetch(`${without}/api/link/hello`)).json()).features.includes("herdr_settings"));
});

test("the hub reads and changes a connected PC's Herdr settings, which runs Herdr and writes there", async (context) => {
  const { fake, configPath, settings } = await connectedPc(context);
  const hub = await startHub(context, client(await startPeer(context, { herdrSettings: settings })));
  const state = await (await hub.get(`/api/herdr/settings?server=${LINK_ID}`)).json();
  assert.deepEqual([state.server, state.channel, state.config.path], [LINK_ID, "stable", "~/.config/herdr/config.toml"]);
  assert.ok(state.integrations.some((item) => item.name === "antigravity-cli" && item.state === "outdated"));

  assert.equal((await (await hub.send("POST", "/api/herdr/channel", { server: LINK_ID, channel: "preview" })).json()).channel, "preview");
  assert.equal((await hub.send("POST", "/api/herdr/integrations/pi/install", { server: LINK_ID })).status, 200);

  const read = await (await hub.get(`/api/herdr/config?server=${LINK_ID}`)).json();
  assert.equal(read.text, "onboarding = false\n");
  const checked = await (await hub.send("POST", "/api/herdr/config/check", { server: LINK_ID, text: "onboarding = 3\n" })).json();
  assert.equal(checked.ok, false);
  assert.match(checked.diagnostics, /expected a boolean/u);

  let response = await hub.send("PUT", "/api/herdr/config", { server: LINK_ID, text: "[ui\n", version: read.version });
  assert.equal(response.status, 422);
  const refused = await response.json();
  assert.equal(refused.error.code, "config_invalid");
  assert.match(refused.error.details.diagnostics, /invalid table header/u);

  response = await hub.send("PUT", "/api/herdr/config", { server: LINK_ID, text: "onboarding = true\n", version: read.version });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.server, LINK_ID);
  assert.equal(saved.reloaded, true);
  assert.match(saved.backup, /^config\.toml\.bak-/u);
  assert.equal(await readFile(configPath, "utf8"), "onboarding = true\n");

  response = await hub.send("PUT", "/api/herdr/config", { server: LINK_ID, text: "x = 1\n", version: read.version });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "config_changed");
  const defaults = await (await hub.get(`/api/herdr/config/default?server=${LINK_ID}`)).json();
  assert.match(defaults.text, /herdr configuration/u);
  assert.deepEqual(changes(fake), ["channel set preview", "integration install pi", "server reload-config", "--default-config"]);
});

test("the connected PC checks what it is asked even when a hub skips its own checks", async (context) => {
  const { fake, settings } = await connectedPc(context);
  const address = await startPeer(context, { herdrSettings: settings });
  const send = (method, path, body) => fetch(`${address}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const [method, path, body, code] of [
    ["POST", "/api/link/herdr/channel", { channel: "--x" }, "invalid_channel"],
    ["POST", "/api/link/herdr/integrations/--all/install", {}, "invalid_integration"],
    ["POST", "/api/link/herdr/integrations/copilot/install", {}, "integration_not_found"],
    ["PUT", "/api/link/herdr/config", { text: "a\u0000", version: "none" }, "invalid_config"],
    ["PUT", "/api/link/herdr/config", { text: "a = 1\n", version: "../x" }, "invalid_config_version"],
  ]) {
    assert.equal((await (await send(method, path, body)).json()).error.code, code, path);
  }
  assert.deepEqual(changes(fake), []);
});

test("an older connected PC answers 501 and says to update it there", async (context) => {
  const hub = await startHub(context, client(await startPeer(context)));
  const listed = await hub.get(`/api/herdr/settings?server=${LINK_ID}`);
  assert.equal(listed.status, 501);
  assert.match((await listed.json()).error.message, /too old for changing Herdr's settings from here; update it there/u);
  assert.equal((await hub.send("PUT", "/api/herdr/config", { server: LINK_ID, text: "", version: "none" })).status, 501);
});

test("the Herdr settings routes are let in exactly like every other link route", async (context) => {
  const { fake, settings } = await connectedPc(context);
  const address = await startPeer(context, { herdrSettings: settings, allowed: ["100.64.0.9"] });
  assert.equal((await fetch(`${address}/api/link/herdr/settings`)).status, 403);
  assert.deepEqual(fake.state.calls, []);
});

test("a connected PC with its own sign-in off refuses, and the hub says so", async (context) => {
  const { fake, settings } = await connectedPc(context);
  const hub = await startHub(context, client(await startPeer(context, { herdrSettings: settings, signIn: false })));
  const response = await hub.get(`/api/herdr/settings?server=${LINK_ID}`);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /sign-in password on this PC/u);
  assert.equal((await hub.send("POST", "/api/herdr/channel", { server: LINK_ID, channel: "preview" })).status, 409);
  assert.deepEqual(fake.state.calls, []);
});
