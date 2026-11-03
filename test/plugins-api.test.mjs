import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PluginManager } from "../src/herdr-plugins.mjs";
import { HttpError } from "../src/http-basics.mjs";
import { fakeHerdr } from "./fixtures/fake-herdr-plugins.mjs";

const LINK = "link_11111111-1111-1111-1111-111111111111";
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(context, { required = true, plugins = undefined, remote = null } = {}) {
  const local = fakeHerdr();
  const remoteCalls = [];
  const remoteSource = remote ?? {
    async list() { remoteCalls.push(["list"]); return { plugins: [{ plugin_id: "far", name: "Far", enabled: true }], operation: null }; },
    async start(action, input) { remoteCalls.push([action, input]); return { plugins: [], operation: null }; },
  };
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [], agents: [] }; },
    pluginsClient: (id) => (id === LINK ? remoteSource : null),
  };
  const app = createHerdrHttpServer({
    herdr,
    csrfToken: "csrf",
    logger: { error() {} },
    auth: {
      required,
      hasValidSession: (cookie) => cookie === "session=valid",
      hasValidLaunchToken: (token) => token === "launch",
      onSessionsEnded: () => () => {},
    },
    plugins: plugins === undefined ? new PluginManager({ run: local.run }) : plugins,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const session = { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" };
  const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers: { ...session, ...headers } });
  const send = (method, path, body, headers = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { ...session, "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ran = () => local.calls.filter((call) => call.args[1] !== "list").map((call) => call.args);
  return { origin, get, send, ran, remoteCalls, local };
}

test("the plugin routes sit behind the sign-in and the write token", async (context) => {
  const { origin, send, ran } = await fixture(context);
  assert.equal((await fetch(`${origin}/api/plugins`)).status, 401);
  assert.equal((await send("POST", "/api/plugins/notes/enable", {}, { "X-Herdr-CSRF": "wrong" })).status, 403);
  assert.equal((await send("POST", "/api/plugins/notes/enable", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await send("DELETE", "/api/plugins/notes", undefined, { "X-Herdr-CSRF": "wrong" })).status, 403);
  assert.deepEqual(ran(), []);
});

test("with sign-in off every plugin route refuses, and bootstrap says plugins are there", async (context) => {
  const { origin, ran } = await fixture(context, { required: false });
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  assert.equal(bootstrap.plugins, true);
  assert.equal(bootstrap.authRequired, false);
  for (const [method, path] of [["GET", "/api/plugins"], ["POST", "/api/plugins/install"], ["POST", "/api/plugins/notes/enable"], ["DELETE", "/api/plugins/notes"]]) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin },
      body: method === "POST" ? JSON.stringify({ source: "someone/tool" }) : undefined,
    });
    assert.equal(response.status, 409, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "password_auth_required");
  }
  assert.deepEqual(ran(), []);
});

test("lists this PC's plugins, HerdRabbit marked protected", async (context) => {
  const { get } = await fixture(context);
  const response = await get("/api/plugins");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.server, "local");
  assert.deepEqual(body.plugins.map((item) => [item.id, item.protected, item.enabled]),
    [["herdrabbit", true, true], ["notes", false, false], ["local-tool", false, true]]);
  assert.equal(body.operation, null);
  assert.equal((await get("/api/plugins", { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" })).status, 403);
});

test("each change starts Herdr's command and answers 202 with the change running", async (context) => {
  const { get, send, ran } = await fixture(context);
  let response = await send("POST", "/api/plugins/notes/enable", { server: "local" });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.server, "local");
  assert.equal(body.operation.action, "enable");
  await settle();
  assert.equal((await (await get("/api/plugins")).json()).operation.state, "succeeded");
  for (const [method, path, payload] of [
    ["POST", "/api/plugins/notes/disable", {}],
    ["POST", "/api/plugins/notes/update", {}],
    ["DELETE", "/api/plugins/notes?server=local", undefined],
    ["POST", "/api/plugins/install", { source: "someone/tool", ref: "v1.0.0" }],
    ["POST", "/api/plugins/install", { source: "org/mono/plugins/x", ref: "" }],
  ]) {
    response = await send(method, path, payload);
    assert.equal(response.status, 202, `${method} ${path}`);
    await settle();
  }
  assert.deepEqual(ran(), [
    ["plugin", "enable", "notes"],
    ["plugin", "disable", "notes"],
    ["plugin", "update", "notes", "--yes"],
    ["plugin", "uninstall", "notes"],
    ["plugin", "install", "someone/tool", "--ref", "v1.0.0", "--yes"],
    ["plugin", "install", "org/mono/plugins/x", "--yes"],
  ]);
});

test("bad ids, sources and refs, HerdRabbit, and unknown PCs are refused before anything runs", async (context) => {
  const { send, ran } = await fixture(context);
  const refusals = [
    ["POST", "/api/plugins/install", { source: "https://github.com/a/b" }, 400, "invalid_plugin_source"],
    ["POST", "/api/plugins/install", { source: "a/b c" }, 400, "invalid_plugin_source"],
    ["POST", "/api/plugins/install", { source: "-a/b" }, 400, "invalid_plugin_source"],
    ["POST", "/api/plugins/install", { source: "a/b", ref: "--upload-pack=x" }, 400, "invalid_plugin_ref"],
    ["POST", "/api/plugins/install", { source: "a/b", ref: "a..b" }, 400, "invalid_plugin_ref"],
    ["POST", "/api/plugins/install", { source: "a/b", ref: "a b" }, 400, "invalid_plugin_ref"],
    ["POST", "/api/plugins/install", { source: "ultivis-iot/HerdRabbit" }, 403, "plugin_protected"],
    ["POST", "/api/plugins/%2Drf/enable", {}, 400, "invalid_plugin_id"],
    ["POST", "/api/plugins/a%20b/enable", {}, 400, "invalid_plugin_id"],
    ["POST", "/api/plugins/herdrabbit/disable", {}, 403, "plugin_protected"],
    ["POST", "/api/plugins/herdrabbit/update", {}, 403, "plugin_protected"],
    ["DELETE", "/api/plugins/herdrabbit", undefined, 403, "plugin_protected"],
    ["POST", "/api/plugins/missing/enable", {}, 404, "plugin_not_found"],
    ["POST", "/api/plugins/notes/enable", { server: "link_99999999-9999-9999-9999-999999999999" }, 404, "unknown_server"],
    ["POST", "/api/plugins/notes/remove", {}, 404, "not_found"],
    ["PUT", "/api/plugins/notes", {}, 405, "method_not_allowed"],
  ];
  for (const [method, path, body, status, code] of refusals) {
    const response = await send(method, path, body);
    assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(body)}`);
    assert.equal((await response.json()).error.code, code, `${method} ${path}`);
  }
  assert.deepEqual(ran(), []);
});

test("a second change while one runs is refused", async (context) => {
  const held = fakeHerdr(undefined, { hold: true });
  const { send } = await fixture(context, { plugins: new PluginManager({ run: held.run }) });
  assert.equal((await send("POST", "/api/plugins/notes/enable", {})).status, 202);
  const busy = await send("POST", "/api/plugins/install", { source: "someone/tool" });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error.code, "plugin_busy");
  held.release();
});

test("a connected PC's plugins go to that PC, checked here first", async (context) => {
  const { get, send, remoteCalls, ran } = await fixture(context);
  const listed = await (await get(`/api/plugins?server=${LINK}`)).json();
  assert.equal(listed.server, LINK);
  assert.deepEqual(listed.plugins.map((item) => item.id), ["far"]);
  assert.equal((await send("POST", "/api/plugins/far/disable", { server: LINK })).status, 202);
  assert.equal((await send("DELETE", `/api/plugins/far?server=${LINK}`)).status, 202);
  assert.equal((await send("POST", "/api/plugins/install", { server: LINK, source: "a/b", ref: "main" })).status, 202);
  assert.equal((await send("POST", "/api/plugins/install", { server: LINK, source: "a/b", ref: "-x" })).status, 400);
  assert.equal((await send("POST", "/api/plugins/herdrabbit/disable", { server: LINK })).status, 403);
  assert.deepEqual(remoteCalls, [
    ["list"],
    ["disable", { plugin: "far" }],
    ["uninstall", { plugin: "far" }],
    ["install", { source: "a/b", ref: "main" }],
  ]);
  assert.deepEqual(ran(), []);
});

test("an older connected PC answers 501 and says to update it there", async (context) => {
  const tooOld = () => new HttpError(501, "link_unsupported", "HerdRabbit at http://old is too old for managing plugins from here; update it there.");
  const { get } = await fixture(context, {
    remote: { async list() { throw tooOld(); }, async start() { throw tooOld(); } },
  });
  const response = await get(`/api/plugins?server=${LINK}`);
  assert.equal(response.status, 501);
  assert.match((await response.json()).error.message, /update it there/u);
});

test("without a plugin manager this PC says it cannot", async (context) => {
  const { get } = await fixture(context, { plugins: null });
  const response = await get("/api/plugins");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "plugins_unavailable");
  assert.equal((await (await get("/api/bootstrap")).json()).plugins, false);
});
