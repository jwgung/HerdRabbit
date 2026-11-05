import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PluginManager } from "../src/herdr-plugins.mjs";
import { HttpError } from "../src/http-basics.mjs";
import { fakeHerdr } from "./fixtures/fake-herdr-plugins.mjs";
import { PluginMarketplace } from "../src/plugin-marketplace.mjs";
import { fakeFetch } from "./fixtures/fake-plugin-marketplace.mjs";

const LINK = "link_11111111-1111-1111-1111-111111111111";
const settle = () => new Promise((resolve) => setImmediate(resolve));

const IDLE_RUN = { state: "idle", startedAt: null, finishedAt: null, exitCode: null, reason: null, log: "", version: "2.0.0" };

async function fixture(context, {
  required = true, plugins = undefined, remote = null, marketplace = undefined, updater = undefined, remoteUpdate = undefined,
} = {}) {
  const local = fakeHerdr();
  const remoteCalls = [];
  const remoteSource = remote ?? {
    async list() { remoteCalls.push(["list"]); return { plugins: [{ plugin_id: "far", name: "Far", enabled: true }], operation: null }; },
    async start(action, input) { remoteCalls.push([action, input]); return { plugins: [], operation: null }; },
  };
  // HerdRabbit's own update (src/app-update.mjs), here and over a link.
  const updates = [];
  const appUpdater = updater === undefined
    ? { async start() { updates.push(["local"]); return { ...IDLE_RUN, state: "running" }; } }
    : updater;
  const remoteUpdater = remoteUpdate === undefined
    ? { async updateRun() { updates.push([LINK]); return { ...IDLE_RUN, state: "running" }; } }
    : remoteUpdate;
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [], agents: [] }; },
    pluginsClient: (id) => (id === LINK ? remoteSource : null),
    updateClient: (id) => (id === LINK ? remoteUpdater : null),
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
    marketplace: marketplace === undefined ? new PluginMarketplace({ fetch: fakeFetch().fetch }) : marketplace,
    updater: appUpdater,
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
  return { origin, get, send, ran, remoteCalls, local, updates };
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

test("HerdRabbit's Update is HerdRabbit's own update, never herdr plugin update", async (context) => {
  const { send, ran, remoteCalls, updates } = await fixture(context);
  let response = await send("POST", "/api/plugins/herdrabbit/update", { server: "local" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ...IDLE_RUN, state: "running", server: "local", supported: true });
  // A connected PC's goes to its own updater over the link, by id alone.
  response = await send("POST", "/api/plugins/herdrabbit/update", { server: LINK, path: "/etc", ref: "evil" });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).server, LINK);
  assert.deepEqual(updates, [["local"], [LINK]]);
  // One a minute per PC, as Settings' own update allows.
  response = await send("POST", "/api/plugins/herdrabbit/update", {});
  assert.equal(response.status, 429);
  assert.deepEqual(updates, [["local"], [LINK]]);
  assert.deepEqual(ran(), [], "Herdr's plugin commands are not run for HerdRabbit");
  assert.deepEqual(remoteCalls, [], "a connected PC's plugin commands are not asked for HerdRabbit");
});

test("HerdRabbit's Update needs sign-in, the write token and the page's own origin", async (context) => {
  const { origin, send, updates } = await fixture(context);
  const refused = [
    [() => fetch(`${origin}/api/plugins/herdrabbit/update`, { method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin }, body: "{}" }), 401],
    [() => send("POST", "/api/plugins/herdrabbit/update", {}, { "X-Herdr-CSRF": "wrong" }), 403],
    [() => send("POST", "/api/plugins/herdrabbit/update", {}, { Origin: "https://evil.example" }), 403],
    [() => send("POST", "/api/plugins/herdrabbit/update", {}, { "Sec-Fetch-Site": "cross-site" }), 403],
    [() => send("POST", "/api/plugins/herdrabbit/update", { server: "link_99999999-9999-9999-9999-999999999999" }), 404],
  ];
  for (const [request, status] of refused) assert.equal((await request()).status, status);
  assert.deepEqual(updates, []);
  const off = await fixture(context, { required: false });
  const response = await fetch(`${off.origin}/api/plugins/herdrabbit/update`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: off.origin }, body: "{}",
  });
  assert.equal(response.status, 409);
  assert.deepEqual(off.updates, []);
});

test("HerdRabbit stays protected from everything but its Update", async (context) => {
  const { send, ran, updates } = await fixture(context);
  for (const [method, path, body] of [
    ["POST", "/api/plugins/herdrabbit/disable", {}],
    ["POST", "/api/plugins/herdrabbit/enable", {}],
    ["POST", "/api/plugins/herdrabbit/unlink", {}],
    ["DELETE", "/api/plugins/herdrabbit", undefined],
    ["POST", "/api/plugins/herdrabbit/run", { action: "restart" }],
    ["POST", "/api/plugins/herdrabbit/open", { entrypoint: "connect" }],
  ]) {
    const response = await send(method, path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "plugin_protected", `${method} ${path}`);
  }
  assert.deepEqual([ran(), updates], [[], []]);
});

test("HerdRabbit's Update says so where this PC cannot update itself, or that PC is too old", async (context) => {
  const { send } = await fixture(context, { updater: null, remoteUpdate: { async updateCheck() { return null; } } });
  let response = await send("POST", "/api/plugins/herdrabbit/update", {});
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "update_unavailable");
  response = await send("POST", "/api/plugins/herdrabbit/update", { server: LINK });
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error.code, "link_unsupported");
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

test("the marketplace answers only with sign-in on, signed in, and from the page itself", async (context) => {
  const fake = fakeFetch();
  const { origin, get } = await fixture(context, { marketplace: new PluginMarketplace({ fetch: fake.fetch }) });
  assert.equal((await fetch(`${origin}/api/plugins/marketplace`)).status, 401);
  assert.equal((await get("/api/plugins/marketplace", { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" })).status, 403);
  const refused = await fixture(context, { required: false, marketplace: new PluginMarketplace({ fetch: fake.fetch }) });
  const response = await fetch(`${refused.origin}/api/plugins/marketplace`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "password_auth_required");
  assert.equal(fake.calls.length, 0, "the index was read for a refused request");
});

test("the marketplace is searched, sorted and paged; bad queries are refused", async (context) => {
  const { get, ran } = await fixture(context);
  let response = await get("/api/plugins/marketplace");
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.total, 6);
  assert.equal(body.sort, "popular");
  assert.equal(body.generatedAt, "2026-11-03T21:00:33.655Z");
  assert.match(body.fetchedAt, /^\d{4}-\d\d-\d\dT/u);
  assert.deepEqual(Object.keys(body.items[0]).sort(), [
    "description", "id", "listedAt", "minHerdrVersion", "name", "owner", "platforms", "protected", "pushedAt", "repo",
    "spec", "stars", "starsThisWeek", "subdir", "url", "version",
  ]);
  assert.equal(body.items.find((item) => item.id === "herdrabbit").protected, true);
  body = await (await get("/api/plugins/marketplace?q=annotate&sort=name&offset=1&limit=1")).json();
  assert.deepEqual([body.total, body.offset, body.limit, body.items.map((item) => item.id)], [2, 1, 1, ["annotate-links"]]);
  body = await (await get("/api/plugins/marketplace?sort=updated")).json();
  assert.equal(body.sort, "recent");
  for (const query of ["sort=random", "limit=500", "offset=x", `q=${"a".repeat(101)}`]) {
    response = await get(`/api/plugins/marketplace?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "invalid_input", query);
  }
  assert.equal((await get("/api/plugins/marketplace/extra")).status, 404);
  assert.deepEqual(ran(), [], "browsing ran a plugin command");
});

test("an unreadable marketplace is a 502 that says how to install anyway", async (context) => {
  const { get } = await fixture(context, { marketplace: new PluginMarketplace({ fetch: fakeFetch({}, { status: 503 }).fetch }) });
  const response = await get("/api/plugins/marketplace");
  assert.equal(response.status, 502);
  const { error } = await response.json();
  assert.equal(error.code, "marketplace_unavailable");
  assert.match(error.message, /could not be read \(it answered HTTP 503\)\. You can still install a plugin by its GitHub owner\/repo with Install plugin…/u);
  const none = await fixture(context, { marketplace: null });
  assert.equal((await none.get("/api/plugins/marketplace")).status, 404);
});

test("the list says which plugins have an update in Herdr's marketplace, on this PC and a connected PC", async (context) => {
  const behind = { kind: "github", owner: "someone", repo: "herdr-notes", resolved_commit: "1234567890abcdef1234567890abcdef12345678" };
  const remote = {
    async list() { return { plugins: [{ plugin_id: "notes", name: "Notes", source: behind }], operation: null }; },
    async start() { return { plugins: [], operation: null }; },
  };
  const { get, local } = await fixture(context, { remote });
  // NOTES is pinned to main (the index names no default branch): not compared.
  let body = await (await get("/api/plugins")).json();
  assert.deepEqual(body.plugins.map((item) => [item.id, item.updateAvailable]),
    [["herdrabbit", null], ["notes", null], ["local-tool", null]]);
  body = await (await get(`/api/plugins?server=${LINK}`)).json();
  assert.deepEqual(body.plugins.map((item) => [item.id, item.updateAvailable]), [["notes", true]]);
  assert.ok(local.calls.every((call) => call.args[1] === "list"));
});

test("a marketplace that is down, or none, leaves updateAvailable null and the list answers", async (context) => {
  const plugins = [{ plugin_id: "notes", name: "Notes", source: { kind: "github", owner: "someone", repo: "herdr-notes", resolved_commit: "1234567" } }];
  const manager = () => new PluginManager({ run: fakeHerdr(plugins).run });
  for (const marketplace of [new PluginMarketplace({ fetch: fakeFetch({}, { status: 503 }).fetch }), null,
    { updatesFor: async () => { throw new Error("broken"); } }]) {
    const { get } = await fixture(context, { plugins: manager(), marketplace });
    const response = await get("/api/plugins");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).plugins.map((item) => item.updateAvailable), [null]);
  }
  const { get } = await fixture(context, { plugins: manager() });
  assert.deepEqual((await (await get("/api/plugins")).json()).plugins.map((item) => item.updateAvailable), [true]);
});
