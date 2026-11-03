import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { linkRoutes } from "../src/link-server.mjs";
import { LinkClient } from "../src/link-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PluginManager } from "../src/herdr-plugins.mjs";
import { fakeHerdr } from "./fixtures/fake-herdr-plugins.mjs";

const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const herdr = { async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; } };
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function startPeer(context, { plugins = null, allowed = ["127.0.0.1"] } = {}) {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: allowed }),
    link: linkRoutes({ client: herdr, plugins, version: "2.0.0", serverName: "dev-box" }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const client = (address) => new LinkClient({ profile: { id: LINK_ID, name: "Dev box", address }, hubVersion: "2.0.0" });

// The hub's page, with sign-in on, reaching the connected PC's plugins through `remote`.
async function startHub(context, remote) {
  const app = createHerdrHttpServer({
    herdr: { ...herdr, pluginsClient: (id) => (id === LINK_ID ? remote.plugins() : null) },
    csrfToken: "csrf",
    logger: { error() {} },
    auth: { required: true, hasValidSession: () => true, hasValidLaunchToken: () => true, onSessionsEnded: () => () => {} },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return {
    get: (path) => fetch(`${origin}${path}`),
    post: (path, body) => fetch(`${origin}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin }, body: JSON.stringify(body),
    }),
  };
}

test("a PC that manages plugins names it among its features", async (context) => {
  const address = await startPeer(context, { plugins: new PluginManager({ run: fakeHerdr().run }) });
  assert.ok((await (await fetch(`${address}/api/link/hello`)).json()).features.includes("plugins"));
  const without = await startPeer(context);
  assert.ok(!(await (await fetch(`${without}/api/link/hello`)).json()).features.includes("plugins"));
});

test("the hub lists and changes a connected PC's plugins, which runs Herdr there", async (context) => {
  const fake = fakeHerdr();
  const address = await startPeer(context, { plugins: new PluginManager({ run: fake.run }) });
  const hub = await startHub(context, client(address));
  const listed = await (await hub.get(`/api/plugins?server=${LINK_ID}`)).json();
  assert.equal(listed.server, LINK_ID);
  assert.deepEqual(listed.plugins.map((item) => [item.id, item.protected]), [["herdrabbit", true], ["notes", false], ["local-tool", false]]);
  assert.doesNotMatch(JSON.stringify(listed), /\/home\/me|secret/u);

  for (const [path, body] of [
    ["/api/plugins/notes/enable", { server: LINK_ID }],
    ["/api/plugins/notes/update", { server: LINK_ID }],
    ["/api/plugins/install", { server: LINK_ID, source: "someone/tool", ref: "v2" }],
  ]) {
    const response = await hub.post(path, body);
    assert.equal(response.status, 202, path);
    assert.equal((await response.json()).server, LINK_ID);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(fake.calls.filter((call) => call.args[1] !== "list").map((call) => call.args), [
    ["plugin", "enable", "notes"],
    ["plugin", "update", "notes", "--yes"],
    ["plugin", "install", "someone/tool", "--ref", "v2", "--yes"],
  ]);
  const after = await (await hub.get(`/api/plugins?server=${LINK_ID}`)).json();
  assert.equal(after.operation.action, "install");
  assert.equal(after.operation.state, "succeeded");
});

test("the connected PC's own refusals reach the page with their status", async (context) => {
  const fake = fakeHerdr(undefined, { hold: true });
  const address = await startPeer(context, { plugins: new PluginManager({ run: fake.run, selfId: "hr-dev" }) });
  const hub = await startHub(context, client(address));
  // A plugin this PC runs as, protected only over there.
  const protectedThere = await startPeer(context, {
    plugins: new PluginManager({ run: fakeHerdr([{ plugin_id: "hr-dev", name: "Dev", source: { kind: "local" } }]).run, selfId: "hr-dev" }),
  });
  const otherHub = await startHub(context, client(protectedThere));
  let response = await otherHub.post("/api/plugins/hr-dev/disable", { server: LINK_ID });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "plugin_protected");

  response = await hub.post("/api/plugins/missing/enable", { server: LINK_ID });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "plugin_not_found");
  assert.equal((await hub.post("/api/plugins/notes/enable", { server: LINK_ID })).status, 202);
  response = await hub.post("/api/plugins/notes/disable", { server: LINK_ID });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "plugin_busy");
  fake.release();
});

test("the connected PC checks what it is asked even when a hub skips its own checks", async (context) => {
  const fake = fakeHerdr();
  const address = await startPeer(context, { plugins: new PluginManager({ run: fake.run }) });
  const post = (path, body) => fetch(`${address}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const [path, body, code] of [
    ["/api/link/plugins/install", { source: "a/b c" }, "invalid_plugin_source"],
    ["/api/link/plugins/install", { source: "a/b", ref: "--x" }, "invalid_plugin_ref"],
    ["/api/link/plugins/install", { source: "ultivis-iot/HerdRabbit" }, "plugin_protected"],
    ["/api/link/plugins/%2Dx/enable", {}, "invalid_plugin_id"],
    ["/api/link/plugins/herdrabbit/uninstall", {}, "plugin_protected"],
  ]) {
    const response = await post(path, body);
    assert.equal((await response.json()).error.code, code, path);
  }
  assert.deepEqual(fake.calls.filter((call) => call.args[1] !== "list"), []);
});

test("an older connected PC answers 501 and says to update it there", async (context) => {
  const address = await startPeer(context);
  const hub = await startHub(context, client(address));
  const listed = await hub.get(`/api/plugins?server=${LINK_ID}`);
  assert.equal(listed.status, 501);
  assert.match((await listed.json()).error.message, /too old for managing plugins from here; update it there/u);
  const started = await hub.post("/api/plugins/notes/enable", { server: LINK_ID });
  assert.equal(started.status, 501);
});

test("the plugin routes are let in exactly like every other link route", async (context) => {
  const fake = fakeHerdr();
  const address = await startPeer(context, { plugins: new PluginManager({ run: fake.run }), allowed: ["100.64.0.9"] });
  assert.equal((await fetch(`${address}/api/link/plugins`)).status, 403);
  assert.deepEqual(fake.calls, []);
});
