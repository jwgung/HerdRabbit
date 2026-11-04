// A plugin's actions run and panes opened for a pane, its logs read, a local
// folder linked and a linked plugin unlinked (src/herdr-plugins.mjs): on this
// PC's manager, through Herdr's socket (src/herdr-client.mjs), the page's
// routes (src/http-server.mjs) and a connected PC's link.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, cleanPluginState, hidePaths, manifestPluginId } from "../src/herdr-plugins.mjs";
import { HerdrClient } from "../src/herdr-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { linkRoutes } from "../src/link-server.mjs";
import { LinkClient } from "../src/link-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";
import { HERDRABBIT, LINKED, NOTES, fakeHerdr, fakePaneHerdr } from "./fixtures/fake-herdr-plugins.mjs";

const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const PANE = "hs_ZGVmYXVsdA~w1:p1";
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const ran = (fake) => fake.calls.filter((call) => call.args[1] !== "list").map((call) => call.args);

async function pluginFolder(context, manifest) {
  // Its real path: a link in the temp folder's own path (macOS's /tmp) is resolved before linking.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-plugin-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  if (manifest !== null) await writeFile(join(directory, "herdr-plugin.toml"), manifest);
  return directory;
}

test("the list carries each plugin's actions and panes, and none of HerdRabbit's", () => {
  const { plugins } = cleanPluginState({
    plugins: [HERDRABBIT, NOTES, {
      ...LINKED,
      actions: [...LINKED.actions, { id: "bad.dot", title: "x" }, { id: "apply", title: "again" }, { id: "--x" },
        { action_id: "tidy", title: "Tidy\u202e up", contexts: ["pane", "Not A Context"] }],
      panes: [...LINKED.panes, { id: "pop", title: "Pop", placement: "popup" }, { id: "odd", placement: "sideways" }],
    }],
  });
  assert.deepEqual(plugins[0].actions, []);
  assert.deepEqual(plugins[0].panes, []);
  assert.deepEqual(plugins[1].actions, []);
  assert.deepEqual(plugins[2].actions, [
    { id: "apply", title: "Apply layout", contexts: ["workspace"] },
    { id: "tidy", title: "Tidy up", contexts: ["pane"] },
  ]);
  assert.deepEqual(plugins[2].panes, [
    { id: "board", title: "Board", placement: "overlay" },
    { id: "pop", title: "Pop", placement: "popup" },
    { id: "odd", title: "odd", placement: "overlay" },
  ]);
  assert.doesNotMatch(JSON.stringify(plugins), /\/home\/me|apply\.sh/u);
});

test("an action runs for the pane chosen through Herdr's socket, or where Herdr's focus is without one", async () => {
  const fake = fakeHerdr();
  const herdr = fakePaneHerdr();
  const manager = new PluginManager({ run: fake.run, herdr });
  const withPane = await manager.invoke("local-tool", "apply", { paneId: PANE });
  assert.deepEqual(herdr.calls, [["invoke", PANE, "local-tool", "apply"]]);
  assert.deepEqual(withPane.action, { id: "apply", title: "Apply layout" });
  assert.equal(withPane.log.id, "plugin-log-10");
  assert.equal(withPane.log.status, "running");
  assert.deepEqual(ran(fake), []);

  const without = await manager.invoke("local-tool", "apply");
  assert.deepEqual(ran(fake), [["plugin", "action", "invoke", "apply", "--plugin", "local-tool"]]);
  assert.equal(without.log.id, "plugin-log-9");
  assert.equal(herdr.calls.length, 1);
});

test("a pane opens as a new tab of the chosen pane's workspace and answers its id", async () => {
  const herdr = fakePaneHerdr();
  const manager = new PluginManager({ run: fakeHerdr().run, herdr });
  const opened = await manager.openPane("local-tool", "board", { paneId: PANE });
  assert.deepEqual(opened, { pane: { id: "board", title: "Board" }, paneId: "hs_ZGVmYXVsdA~w1:p9" });
  assert.deepEqual(herdr.calls, [["open", PANE, "local-tool", "board"]]);
});

test("HerdRabbit's own, a plugin turned off, unknown and bad ids, and a gone pane are refused", async () => {
  const fake = fakeHerdr();
  const herdr = fakePaneHerdr({ missing: ["hs_ZGVmYXVsdA~w1:p7"] });
  const manager = new PluginManager({ run: fake.run, herdr });
  for (const [call, expected] of [
    [() => manager.invoke("herdrabbit", "restart", { paneId: PANE }), { status: 403, code: "plugin_protected" }],
    [() => manager.openPane("herdrabbit", "connect", { paneId: PANE }), { status: 403, code: "plugin_protected" }],
    [() => manager.invoke("notes", "anything"), { status: 409, code: "plugin_disabled" }],
    [() => manager.invoke("local-tool", "nope"), { status: 404, code: "plugin_action_not_found" }],
    [() => manager.openPane("local-tool", "nope", { paneId: PANE }), { status: 404, code: "plugin_pane_not_found" }],
    [() => manager.invoke("local-tool", "--plugin"), { status: 400, code: "invalid_plugin_action" }],
    [() => manager.invoke("local-tool", "a.b"), { status: 400, code: "invalid_plugin_action" }],
    [() => manager.openPane("local-tool", "../x", { paneId: PANE }), { status: 400, code: "invalid_plugin_pane" }],
    [() => manager.invoke("../x", "apply"), { status: 400, code: "invalid_plugin_id" }],
    [() => manager.invoke("missing", "apply"), { status: 404, code: "plugin_not_found" }],
    [() => manager.openPane("local-tool", "board"), { status: 400, code: "pane_required" }],
    [() => manager.invoke("local-tool", "apply", { paneId: "hs_ZGVmYXVsdA~w1:p7" }), { status: 404, code: "pane_not_found" }],
  ]) {
    await assert.rejects(call(), expected);
  }
  assert.deepEqual(ran(fake), []);
  assert.deepEqual(herdr.calls, [["invoke", "hs_ZGVmYXVsdA~w1:p7", "local-tool", "apply"]]);

  // Herdr's own refusal, without this PC's folders.
  const failing = new PluginManager({ run: fakeHerdr().run, herdr: fakePaneHerdr({ fail: "spawn /home/me/tool/apply.sh failed" }) });
  await assert.rejects(failing.invoke("local-tool", "apply", { paneId: PANE }), (error) =>
    error.status === 502 && error.code === "plugin_action_failed" && /Apply layout: spawn …\/apply\.sh failed/u.test(error.message));
  const cli = new PluginManager({ run: fakeHerdr(undefined, { fail: '{"id":"cli:plugin","error":{"code":"plugin_disabled","message":"plugin x is disabled"}}' }).run });
  await assert.rejects(cli.invoke("local-tool", "apply"), (error) => error.code === "plugin_action_failed" && /plugin x is disabled$/u.test(error.message));
});

test("logs are Herdr's, newest first, without colours or this PC's folders", async () => {
  const fake = fakeHerdr();
  const manager = new PluginManager({ run: fake.run });
  const { logs } = await manager.logs("local-tool", { limit: 5 });
  assert.deepEqual(ran(fake), [["plugin", "log", "list", "--plugin", "local-tool", "--limit", "5"]]);
  assert.deepEqual(logs.map((log) => log.id), ["plugin-log-5", "plugin-log-3"]);
  assert.deepEqual(logs[1], {
    id: "plugin-log-3", action: "apply", event: null, status: "failed", exitCode: 2,
    startedAt: new Date(1793774930134).toISOString(), finishedAt: new Date(1793774931325).toISOString(),
    stdout: "Applying in …/site\n", stderr: "error: …/layout.json not found\n", error: null,
  });
  assert.equal(logs[0].event, "startup");
  assert.doesNotMatch(JSON.stringify(logs), /\/home\/me|\u001b/u);
  // HerdRabbit's own logs are read too; a plugin not here, or a bad count, is not.
  await manager.logs("herdrabbit");
  assert.deepEqual(ran(fake).at(-1), ["plugin", "log", "list", "--plugin", "herdrabbit", "--limit", "20"]);
  await assert.rejects(manager.logs("missing"), { status: 404, code: "plugin_not_found" });
  for (const bad of [0, 51, "x", 1.5]) await assert.rejects(manager.logs("notes", { limit: bad }), { status: 400, code: "invalid_log_limit" });
  await assert.rejects(new PluginManager({ run: fakeHerdr(undefined, { fail: "boom" }).run }).logs("notes"), { status: 502, code: "plugin_log_failed" });
});

test("a manifest's plugin id is read from its top, before any table", () => {
  assert.equal(manifestPluginId('# a plugin\nid = "example.layout"\nname = "Layout"\n'), "example.layout");
  assert.equal(manifestPluginId("id='single' # note\n"), "single");
  assert.equal(manifestPluginId('name = "x"\n[[actions]]\nid = "apply"\n'), null);
  assert.equal(manifestPluginId('id = "-rf"\n'), null);
  assert.equal(manifestPluginId(""), null);
  assert.equal(hidePaths("see https://example.com/a/b and /home/me/x/y"), "see https://example.com/a/b and …/y");
});

test("a local folder is linked by the plugin it holds; the change names the plugin, not the folder", async (context) => {
  const folder = await pluginFolder(context, 'id = "layout"\nname = "Layout"\n');
  const fake = fakeHerdr();
  const manager = new PluginManager({ run: fake.run, now: () => Date.parse("2026-01-01T00:00:00Z") });
  const started = await manager.start("link", { path: folder, enabled: true });
  assert.equal(started.operation.action, "link");
  assert.equal(started.operation.plugin, "layout");
  await settle();
  assert.deepEqual(ran(fake), [["plugin", "link", folder]]);
  assert.doesNotMatch(JSON.stringify(await manager.list()), new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  await manager.start("link", { path: folder, enabled: false });
  await settle();
  assert.deepEqual(ran(fake).at(-1), ["plugin", "link", folder, "--disabled"]);

  // A link to the folder is linked as the folder it points at, the one checked.
  const alias = join(await pluginFolder(context, null), "alias");
  await symlink(folder, alias);
  await manager.start("link", { path: alias });
  await settle();
  assert.deepEqual(ran(fake).at(-1), ["plugin", "link", folder]);
});

test("a folder that is not a plugin, is HerdRabbit, is already here, or is protected is not linked", async (context) => {
  const fake = fakeHerdr();
  const empty = await pluginFolder(context, null);
  const noId = await pluginFolder(context, '[[actions]]\nid = "x"\n');
  const herdrabbit = await pluginFolder(context, 'id = "herdrabbit"\n');
  const self = await pluginFolder(context, 'id = "hr-dev"\n');
  const notes = await pluginFolder(context, 'id = "notes"\n');
  const secret = await pluginFolder(context, 'id = "secret"\n');
  await mkdir(join(secret, "inner"));
  // A manifest that is a link to another file, a pipe, or too big is not read.
  const linkedManifest = await pluginFolder(context, null);
  await symlink(join(notes, "herdr-plugin.toml"), join(linkedManifest, "herdr-plugin.toml"));
  const pipe = await pluginFolder(context, null);
  execFileSync("mkfifo", [join(pipe, "herdr-plugin.toml")]);
  const big = await pluginFolder(context, `id = "big"\n${"#".repeat(300 * 1024)}\n`);
  const guard = { matcher: async () => (path) => path.startsWith(secret) };
  const manager = new PluginManager({ run: fake.run, selfId: "hr-dev", guard });
  for (const [path, expected] of [
    [empty, { status: 400, code: "plugin_manifest_missing" }],
    [linkedManifest, { status: 400, code: "plugin_manifest_missing" }],
    [pipe, { status: 400, code: "plugin_manifest_missing" }],
    [big, { status: 400, code: "plugin_manifest_missing" }],
    [noId, { status: 400, code: "plugin_manifest_missing" }],
    [herdrabbit, { status: 403, code: "plugin_protected" }],
    [self, { status: 403, code: "plugin_protected" }],
    [notes, { status: 409, code: "plugin_exists" }],
    [secret, { status: 400, code: "protected_folder" }],
    [join(secret, "inner"), { status: 400, code: "protected_folder" }],
    [join(empty, "nowhere"), { status: 400, code: "folder_not_found" }],
    ["relative/path", { status: 400, code: "invalid_folder" }],
    ["/tmp/x\nmore", { status: 400, code: "invalid_folder" }],
    [42, { status: 400, code: "invalid_folder" }],
  ]) {
    await assert.rejects(manager.start("link", { path }), expected, String(path));
  }
  assert.deepEqual(ran(fake), []);
});

test("only a linked plugin unlinks, and never HerdRabbit", async () => {
  const fake = fakeHerdr();
  const manager = new PluginManager({ run: fake.run });
  await manager.start("unlink", { plugin: "local-tool" });
  await settle();
  assert.deepEqual(ran(fake), [["plugin", "unlink", "local-tool"]]);
  await assert.rejects(manager.start("unlink", { plugin: "notes" }), { status: 409, code: "plugin_not_linked" });
  await assert.rejects(manager.start("unlink", { plugin: "herdrabbit" }), { status: 403, code: "plugin_protected" });
});

// A Herdr socket answering each JSON line with `answer(request)`.
async function fakeHerdrSocket(context, answer) {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-plugin-socket-"));
  const socketPath = join(directory, "herdr.sock");
  const requests = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
        requests.push({ method: request.method, params: request.params });
        socket.write(`${JSON.stringify({ id: request.id, ...answer(request) })}\n`);
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, requests };
}

const SNAPSHOT = {
  workspaces: [{ workspace_id: "w1", label: "Platform" }, { workspace_id: "w2", label: "Other" }],
  tabs: [{ tab_id: "w1:t2", workspace_id: "w1", label: "api" }],
  panes: [{ pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1", cwd: "/work/api", foreground_cwd: "/work/api/src", agent: "claude" }],
};

test("Herdr is asked over its socket: the action with the pane's context, the pane as a tab of its workspace", async (context) => {
  const herdrSocket = await fakeHerdrSocket(context, (request) => (request.method === "plugin.action.invoke"
    ? { result: { type: "plugin_action_invoked", log: { log_id: "plugin-log-1", plugin_id: "local-tool", status: "running" } } }
    : { result: { type: "plugin_pane_opened", plugin_pane: { plugin_id: "local-tool", entrypoint: "board", pane: { pane_id: "w1:p8", tab_id: "w1:t5" } } } }));
  const runner = async (binary, args) => {
    assert.deepEqual(args, ["api", "snapshot"]);
    return { stdout: JSON.stringify({ result: { snapshot: SNAPSHOT } }), stderr: "" };
  };
  const client = new HerdrClient({ runner, socketPath: herdrSocket.socketPath, sessionName: "default" });
  assert.deepEqual(await client.pluginActionInvoke("w1:p3", "local-tool", "apply"),
    { log_id: "plugin-log-1", plugin_id: "local-tool", status: "running" });
  assert.deepEqual(await client.pluginPaneOpen("w1:p3", "local-tool", "board"), { pane_id: "w1:p8", tab_id: "w1:t5" });
  assert.deepEqual(herdrSocket.requests, [
    { method: "plugin.action.invoke", params: { action_id: "apply", plugin_id: "local-tool", context: {
      workspace_id: "w1", workspace_label: "Platform", tab_id: "w1:t2", tab_label: "api",
      focused_pane_id: "w1:p3", focused_pane_cwd: "/work/api/src", focused_pane_agent: "claude",
    } } },
    { method: "plugin.pane.open", params: { plugin_id: "local-tool", entrypoint: "board", placement: "tab", workspace_id: "w1", focus: false } },
  ]);
  await assert.rejects(client.pluginActionInvoke("w9:p9", "local-tool", "apply"), { code: "pane_not_found" });
  await assert.rejects(client.pluginPaneOpen("w1:p3", "local-tool", "a.b"), { name: "InputValidationError" });
  await assert.rejects(client.pluginActionInvoke("w1:p3", "--x", "apply"), { name: "InputValidationError" });
  assert.equal(herdrSocket.requests.length, 2);
});

// The page's server with sign-in on: this PC's manager, and a connected PC's
// plugins through `remote`.
async function startHub(context, { local, remote = null } = {}) {
  const app = createHerdrHttpServer({
    herdr: {
      async snapshot() { return { workspaces: [], tabs: [], panes: [], agents: [] }; },
      pluginsClient: (id) => (id === LINK_ID && remote ? remote.plugins() : null),
    },
    csrfToken: "csrf",
    logger: { error() {} },
    auth: { required: true, hasValidSession: () => true, hasValidLaunchToken: () => true, onSessionsEnded: () => () => {} },
    plugins: local,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const read = async (response) => ({ status: response.status, body: await response.json() });
  return {
    origin,
    get: async (path, headers = {}) => read(await fetch(`${origin}${path}`, { headers: { Origin: origin, ...headers } })),
    post: async (path, body, headers = {}) => read(await fetch(`${origin}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin, ...headers }, body: JSON.stringify(body),
    })),
  };
}

test("the page runs, opens and reads logs on this PC, with the write token, HerdRabbit refused", async (context) => {
  const fake = fakeHerdr();
  const herdr = fakePaneHerdr();
  const hub = await startHub(context, { local: new PluginManager({ run: fake.run, herdr }) });

  let answer = await hub.post("/api/plugins/local-tool/run", { server: "local", action: "apply", pane: PANE });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.action.title, "Apply layout");
  assert.equal(answer.body.log.id, "plugin-log-10");
  answer = await hub.post("/api/plugins/local-tool/open", { entrypoint: "board", pane: PANE });
  assert.deepEqual(answer.body, { pane: { id: "board", title: "Board" }, paneId: "hs_ZGVmYXVsdA~w1:p9", plugin: "local-tool", server: "local" });
  answer = await hub.get("/api/plugins/local-tool/logs?limit=2");
  assert.deepEqual(answer.body.logs.map((log) => log.id), ["plugin-log-5", "plugin-log-3"]);
  assert.equal(answer.body.server, "local");
  assert.deepEqual(herdr.calls, [["invoke", PANE, "local-tool", "apply"], ["open", PANE, "local-tool", "board"]]);

  for (const [path, body, status, code] of [
    ["/api/plugins/herdrabbit/run", { action: "restart", pane: PANE }, 403, "plugin_protected"],
    ["/api/plugins/herdrabbit/open", { entrypoint: "connect", pane: PANE }, 403, "plugin_protected"],
    ["/api/plugins/local-tool/run", { action: "--x" }, 400, "invalid_plugin_action"],
    ["/api/plugins/local-tool/open", { entrypoint: "a b", pane: PANE }, 400, "invalid_plugin_pane"],
    ["/api/plugins/local-tool/run", { action: "apply", pane: `${LINK_ID}!w1:p1` }, 400, "invalid_pane"],
    ["/api/plugins/local-tool/run", { action: "apply", pane: 5 }, 400, "invalid_pane"],
    ["/api/plugins/local-tool/logs", {}, 405, "method_not_allowed"],
  ]) {
    answer = await hub.post(path, body);
    assert.equal(answer.status, status, path);
    assert.equal(answer.body.error.code, code, path);
  }
  // A write without the token, or logs read from another site.
  assert.equal((await hub.post("/api/plugins/local-tool/run", { action: "apply" }, { "X-Herdr-CSRF": "wrong" })).status, 403);
  assert.equal((await hub.get("/api/plugins/local-tool/logs", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await hub.get("/api/plugins/local-tool/logs?limit=99")).body.error.code, "invalid_log_limit");
  assert.equal(herdr.calls.length, 2);
  assert.deepEqual(ran(fake).filter((args) => args[1] !== "log"), []);
});

test("the page links a folder and unlinks a linked plugin on this PC", async (context) => {
  const folder = await pluginFolder(context, 'id = "layout"\n');
  const fake = fakeHerdr();
  const hub = await startHub(context, { local: new PluginManager({ run: fake.run }) });
  let answer = await hub.post("/api/plugins/link", { server: "local", path: folder, enabled: false });
  assert.equal(answer.status, 202);
  assert.equal(answer.body.operation.action, "link");
  assert.equal(answer.body.operation.plugin, "layout");
  await settle();
  answer = await hub.post("/api/plugins/local-tool/unlink", { server: "local" });
  assert.equal(answer.status, 202);
  await settle();
  assert.deepEqual(ran(fake), [["plugin", "link", folder, "--disabled"], ["plugin", "unlink", "local-tool"]]);
  for (const [body, code] of [
    [{ path: "relative" }, "invalid_folder"],
    [{ path: folder, enabled: "yes" }, "invalid_request"],
    [{ path: join(folder, "missing") }, "folder_not_found"],
  ]) {
    answer = await hub.post("/api/plugins/link", body);
    assert.equal(answer.body.error.code, code, JSON.stringify(body));
  }
  assert.equal((await hub.post("/api/plugins/herdrabbit/unlink", {})).body.error.code, "plugin_protected");
});

async function startPeer(context, { plugins = null, signIn = true } = {}) {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: linkRoutes({
      client: { async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; } },
      plugins, pluginsAllowed: () => signIn, version: "2.0.0", serverName: "dev-box",
    }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const linkClient = (address) => new LinkClient({ profile: { id: LINK_ID, name: "Dev box", address }, hubVersion: "2.0.0" });

test("a connected PC runs, opens, reads logs, links and unlinks itself; its panes keep their server id", async (context) => {
  const fake = fakeHerdr();
  const herdr = fakePaneHerdr();
  const folder = await pluginFolder(context, 'id = "layout"\n');
  const address = await startPeer(context, { plugins: new PluginManager({ run: fake.run, herdr }) });
  assert.ok((await (await fetch(`${address}/api/link/hello`)).json()).features.includes("plugin_extras"));
  const hub = await startHub(context, { local: null, remote: linkClient(address) });

  let answer = await hub.post("/api/plugins/local-tool/run", { server: LINK_ID, action: "apply", pane: `${LINK_ID}!${PANE}` });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.log.id, "plugin-log-10");
  answer = await hub.post("/api/plugins/local-tool/open", { server: LINK_ID, entrypoint: "board", pane: `${LINK_ID}!${PANE}` });
  assert.equal(answer.body.paneId, `${LINK_ID}!hs_ZGVmYXVsdA~w1:p9`);
  assert.deepEqual(herdr.calls, [["invoke", PANE, "local-tool", "apply"], ["open", PANE, "local-tool", "board"]]);
  answer = await hub.get(`/api/plugins/local-tool/logs?server=${LINK_ID}&limit=3`);
  assert.deepEqual(answer.body.logs.map((log) => log.id), ["plugin-log-5", "plugin-log-3"]);
  assert.doesNotMatch(JSON.stringify(answer.body), /\/home\/me/u);

  // A pane of this PC is not the connected PC's.
  answer = await hub.post("/api/plugins/local-tool/run", { server: LINK_ID, action: "apply", pane: PANE });
  assert.equal(answer.body.error.code, "invalid_pane");
  // That PC's own refusals reach the page.
  answer = await hub.post("/api/plugins/notes/run", { server: LINK_ID, action: "x" });
  assert.equal(answer.status, 409);
  assert.equal(answer.body.error.code, "plugin_disabled");
  answer = await hub.post("/api/plugins/local-tool/open", { server: LINK_ID, entrypoint: "board" });
  assert.equal(answer.body.error.code, "pane_required");

  answer = await hub.post("/api/plugins/link", { server: LINK_ID, path: folder });
  assert.equal(answer.status, 202);
  await settle();
  answer = await hub.post("/api/plugins/link", { server: LINK_ID, path: join(folder, "missing") });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.error.code, "folder_not_found");
  answer = await hub.post("/api/plugins/local-tool/unlink", { server: LINK_ID });
  assert.equal(answer.status, 202);
  await settle();
  assert.deepEqual(ran(fake).filter((args) => args[1] !== "log" && args[1] !== "action"), [["plugin", "link", folder], ["plugin", "unlink", "local-tool"]]);
});

test("the connected PC checks what it is asked even when a hub skips its own checks", async (context) => {
  const fake = fakeHerdr();
  const herdr = fakePaneHerdr();
  const address = await startPeer(context, { plugins: new PluginManager({ run: fake.run, herdr }) });
  const post = async (path, body) => (await (await fetch(`${address}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json()).error?.code;
  assert.equal(await post("/api/link/plugins/herdrabbit/run", { action: "restart" }), "plugin_protected");
  assert.equal(await post("/api/link/plugins/herdrabbit/open", { entrypoint: "connect", pane: PANE }), "plugin_protected");
  assert.equal(await post("/api/link/plugins/local-tool/run", { action: "--x" }), "invalid_plugin_action");
  assert.equal(await post("/api/link/plugins/link", { path: "~/../../etc\n" }), "invalid_folder");
  assert.equal(await post("/api/link/plugins/notes/unlink", {}), "plugin_not_linked");
  assert.equal((await (await fetch(`${address}/api/link/plugins/local-tool/logs?limit=500`)).json()).error.code, "invalid_log_limit");
  assert.deepEqual(herdr.calls, []);
  assert.deepEqual(ran(fake), []);
});

test("an older connected PC says to update it there for the new parts, and lists as before", async (context) => {
  // A PC that lists and changes plugins but names no plugin_extras.
  const address = await startPeer(context, { plugins: new PluginManager({ run: fakeHerdr().run }) });
  // Its hello, as an older HerdRabbit answers it.
  const olderFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (!String(url).endsWith("/api/link/hello")) return response;
    const body = await response.json();
    body.features = body.features.filter((feature) => feature !== "plugin_extras");
    return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
  };
  const plugins = new LinkClient({ profile: { id: LINK_ID, name: "Dev box", address }, hubVersion: "2.0.0", fetchImpl: olderFetch }).plugins();
  assert.equal((await plugins.list()).plugins.length, 3);
  await assert.rejects(plugins.invoke("local-tool", "apply"), /too old for running plugin actions from here/u);
  await assert.rejects(plugins.logs("local-tool"), /too old for reading plugin logs from here/u);
  await assert.rejects(plugins.start("link", { path: "/tmp" }), /too old for linking a plugin folder from here/u);
  await assert.rejects(plugins.start("unlink", { plugin: "local-tool" }), /too old for unlinking a plugin from here/u);
});

test("a manifest's id is read outside its multi-line strings, and file:// folders are hidden", async () => {
  const { manifestPluginId, hidePaths } = await import("../src/herdr-plugins.mjs");
  assert.equal(manifestPluginId('description = """\nid = "fakeplug"\n"""\nid = "herdrabbit"\n'), "herdrabbit");
  assert.equal(manifestPluginId("description = '''\nid = \"x\"\n'''\nid = \"notes\"\n"), "notes");
  assert.equal(hidePaths("see file:///home/u/k and /home/u/w/log.txt"), "see …/k and …/log.txt");
});

test("a link Herdr registers as HerdRabbit, or as another id than the manifest said, is unlinked again", async (context) => {
  const folder = await pluginFolder(context, 'id = "layout"\n');
  for (const registered of ["herdrabbit", "other"]) {
    const fake = fakeHerdr([NOTES, LINKED]);
    let linked = false;
    const run = async (args, options) => {
      if (args[1] === "link") linked = true;
      if (args[1] === "list" && linked) {
        const answer = await fake.run(args, options);
        const parsed = JSON.parse(answer.stdout);
        parsed.result.plugins.push({ plugin_id: registered, name: registered, enabled: true, source: { kind: "local" } });
        return { ...answer, stdout: JSON.stringify(parsed) };
      }
      return fake.run(args, options);
    };
    const manager = new PluginManager({ run });
    await manager.start("link", { path: folder });
    await settle();
    await settle();
    const { operation } = await manager.list();
    assert.equal(operation.state, "failed", `${registered}: the link was kept`);
    assert.deepEqual(ran(fake).at(-1), ["plugin", "unlink", registered], `${registered}: it was not unlinked`);
  }
});
