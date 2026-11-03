import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";

const LAB = "link_11111111-1111-1111-1111-111111111111";
const OLD = "link_22222222-2222-2222-2222-222222222222";

// A herdr that makes tabs the way the multi-server client reports them: a
// connected PC's ids carry its prefix and its records name it.
function fakeHerdr() {
  const calls = [];
  const workspaces = [
    { workspace_id: "w1", label: "Platform" },
    { workspace_id: `${LAB}!hs~w1`, label: "Bench", server_id: LAB },
    { workspace_id: `${OLD}!hs~w1`, label: "Old", server_id: OLD },
  ];
  const tabs = [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }];
  const panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }];
  return {
    calls,
    async snapshot() {
      return { workspaces: [...workspaces], tabs: tabs.map((tab) => ({ ...tab })), panes: [...panes], agents: [] };
    },
    async createTab(workspaceId) {
      calls.push(["createTab", workspaceId]);
      const n = tabs.length + 1;
      const prefix = `${workspaceId}:`;
      tabs.push({ tab_id: `${prefix}t${n}`, workspace_id: workspaceId, label: String(n) });
      panes.push({ pane_id: `${prefix}p${n}`, tab_id: `${prefix}t${n}`, workspace_id: workspaceId });
    },
    async renameTab(tabId, label) {
      calls.push(["renameTab", tabId, label]);
      tabs.find((tab) => tab.tab_id === tabId).label = label;
    },
    async sendText(paneId, text, options) { calls.push(["sendText", paneId, text, options]); },
    agentsClient(serverId) {
      if (serverId === LAB) return { async installedAgents() { calls.push(["remoteAgents", LAB]); return ["codex", "opencode"]; } };
      // A connected PC from before this answers nothing about its agents.
      if (serverId === OLD) return { async installedAgents() { return null; } };
      return null;
    },
  };
}

const localAgents = { async list() { return ["claude", "codex"]; } };

async function start(context, herdr = fakeHerdr(), options = {}) {
  const { server } = createHerdrHttpServer({
    herdr, csrfToken: "fixed-test-token", logger: { error() {} }, installedAgents: localAgents, ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", Origin: baseUrl },
    body: JSON.stringify(body),
  });
  const get = (path) => fetch(`${baseUrl}${path}`, { headers: { Origin: baseUrl } });
  return { herdr, baseUrl, post, get };
}

const tabsOf = (id) => `/api/workspaces/${encodeURIComponent(id)}/tabs`;

test("lists the agents installed on this machine and on a connected PC", async (context) => {
  const app = await start(context);
  assert.deepEqual(await (await app.get("/api/agents")).json(), { server: "local", supported: true, agents: ["claude", "codex"] });
  assert.deepEqual(await (await app.get("/api/agents?server=local")).json(), { server: "local", supported: true, agents: ["claude", "codex"] });
  assert.deepEqual(await (await app.get(`/api/agents?server=${LAB}`)).json(), { server: LAB, supported: true, agents: ["codex", "opencode"] });
  assert.deepEqual(await (await app.get(`/api/agents?server=${OLD}`)).json(), { server: OLD, supported: false, agents: [] });
  const gone = await app.get("/api/agents?server=link_00000000-0000-0000-0000-000000000000");
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error.code, "unknown_server");
});

test("the agent list is not read across origins", async (context) => {
  const app = await start(context);
  const response = await fetch(`${app.baseUrl}/api/agents`, { headers: { Origin: "https://evil.example" } });
  assert.equal(response.status, 403);
});

test("a server without an agent finder says it cannot tell", async (context) => {
  const app = await start(context, fakeHerdr(), { installedAgents: null });
  assert.deepEqual(await (await app.get("/api/agents")).json(), { server: "local", supported: false, agents: [] });
});

test("a new session with an agent and a name is named, then the agent's command is typed into it", async (context) => {
  const app = await start(context);
  const response = await app.post(tabsOf("w1"), { agent: "claude", label: "  Review  " });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.paneId, "w1:p2");
  assert.equal(payload.snapshot.tabs.find((tab) => tab.tab_id === "w1:t2").label, "Review");
  assert.deepEqual(app.herdr.calls, [
    ["createTab", "w1"],
    ["renameTab", "w1:t2", "Review"],
    ["sendText", "w1:p2", "claude", { submit: true }],
  ]);
});

test("each agent is started by its own command", async (context) => {
  const app = await start(context, fakeHerdr(), { installedAgents: { async list() { return ["kiro", "cursor"]; } } });
  assert.equal((await app.post(tabsOf("w1"), { agent: "kiro" })).status, 201);
  assert.equal((await app.post(tabsOf("w1"), { agent: "cursor" })).status, 201);
  assert.deepEqual(app.herdr.calls.filter(([name]) => name === "sendText").map(([, , text]) => text), ["kiro-cli", "cursor-agent"]);
  assert.equal(app.herdr.calls.some(([name]) => name === "renameTab"), false, "no name, no rename");
});

test("a shell session may still be named, and a plain one is made as before", async (context) => {
  const app = await start(context);
  assert.equal((await app.post(tabsOf("w1"), { label: "Logs" })).status, 201);
  assert.equal((await app.post(tabsOf("w1"), { agent: "", label: "" })).status, 201);
  const plain = await app.post(tabsOf("w1"), {});
  assert.equal(plain.status, 201);
  assert.equal("paneId" in await plain.json(), false, "a plain session answers as it always did");
  assert.deepEqual(app.herdr.calls, [
    ["createTab", "w1"],
    ["renameTab", "w1:t2", "Logs"],
    ["createTab", "w1"],
    ["createTab", "w1"],
  ]);
});

test("a connected PC's session starts an agent that PC has", async (context) => {
  const app = await start(context);
  const workspace = `${LAB}!hs~w1`;
  const response = await app.post(tabsOf(workspace), { agent: "opencode", label: "Fix" });
  assert.equal(response.status, 201);
  assert.deepEqual(app.herdr.calls, [
    ["remoteAgents", LAB],
    ["createTab", workspace],
    ["renameTab", `${workspace}:t2`, "Fix"],
    ["sendText", `${workspace}:p2`, "opencode", { submit: true }],
  ]);
});

test("nothing is made for an agent that is unknown, not installed there, or on a PC too old to say", async (context) => {
  const app = await start(context);
  const cases = [
    [tabsOf("w1"), { agent: "rm -rf /" }, 400, "invalid_input"],
    [tabsOf("w1"), { agent: "toString" }, 400, "invalid_input"],
    [tabsOf("w1"), { agent: 7 }, 400, "invalid_input"],
    [tabsOf("w1"), { agent: "opencode" }, 409, "agent_not_installed"],
    [tabsOf(`${LAB}!hs~w1`), { agent: "claude" }, 409, "agent_not_installed"],
    [tabsOf(`${OLD}!hs~w1`), { agent: "codex" }, 501, "link_unsupported"],
    [tabsOf("w9"), { agent: "claude" }, 404, "unknown_workspace"],
  ];
  for (const [path, body, status, code] of cases) {
    const response = await app.post(path, body);
    assert.equal(response.status, status, `${path} ${JSON.stringify(body)}`);
    assert.equal((await response.json()).error.code, code, `${path} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(app.herdr.calls.filter(([name]) => name !== "remoteAgents"), []);
});

test("a name Herdr would refuse is refused before the session is made", async (context) => {
  const app = await start(context);
  for (const label of ["x".repeat(121), "bad\nname", 5]) {
    const response = await app.post(tabsOf("w1"), { agent: "claude", label });
    assert.equal(response.status, 400, JSON.stringify(label));
  }
  assert.deepEqual(app.herdr.calls, []);
});

test("a session Herdr made but that cannot be found is reported, not typed into blindly", async (context) => {
  const herdr = fakeHerdr();
  herdr.createTab = async (workspaceId) => { herdr.calls.push(["createTab", workspaceId]); };
  const app = await start(context, herdr);
  const response = await app.post(tabsOf("w1"), { agent: "claude", label: "Lost" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "session_missing");
  assert.deepEqual(herdr.calls, [["createTab", "w1"]]);
});

test("starting an agent needs the page's write token", async (context) => {
  const app = await start(context);
  const response = await fetch(`${app.baseUrl}${tabsOf("w1")}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ agent: "claude" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(app.herdr.calls, []);
});
