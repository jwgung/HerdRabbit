import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { AGENT_COMMANDS } from "../src/agent-launch.mjs";

const LAB = "link_11111111-1111-1111-1111-111111111111";
const OLD = "link_22222222-2222-2222-2222-222222222222";
// A PC that lists its agents but, from before this, does not name a new project's ids.
const QUIET = "link_33333333-3333-3333-3333-333333333333";

// A herdr that makes projects the way the multi-server client reports them:
// a connected PC's ids carry its prefix and its records name it. Its create
// call names the project, tab and pane it made, as Herdr's answer does;
// `answer` replaces that answer (null: a Herdr or PC that does not say).
function fakeHerdr({ answer } = {}) {
  const calls = [];
  const sessions = [
    { session_id: "hs", name: "default", server_id: "local", running: true, available: true },
    { session_id: `${LAB}!hs`, name: "default", server_id: LAB, running: true, available: true },
    { session_id: `${OLD}!hs`, name: "default", server_id: OLD, running: true, available: true },
    { session_id: `${QUIET}!hs`, name: "default", server_id: QUIET, running: true, available: true },
  ];
  const workspaces = [{ workspace_id: "hs~w1", label: "Platform", server_id: "local", herdr_session_id: "hs" }];
  const tabs = [{ tab_id: "hs~w1:t1", workspace_id: "hs~w1", label: "1" }];
  const panes = [{ pane_id: "hs~w1:p1", tab_id: "hs~w1:t1", workspace_id: "hs~w1" }];
  return {
    calls,
    async snapshot() {
      return { herdr_sessions: [...sessions], workspaces: [...workspaces], tabs: [...tabs], panes: [...panes], agents: [] };
    },
    async createWorkspace(label, sessionId) {
      calls.push(["createWorkspace", label, sessionId]);
      const session = sessions.find((item) => item.session_id === (sessionId ?? "hs"));
      const n = workspaces.length + 1;
      const id = `${session.session_id}~w${n}`;
      workspaces.push({ workspace_id: id, label, server_id: session.server_id, herdr_session_id: session.session_id });
      tabs.push({ tab_id: `${id}:t1`, workspace_id: id, label: "1" });
      panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id });
      const made = { workspace_id: id, tab_id: `${id}:t1`, pane_id: `${id}:p1` };
      return answer === undefined ? made : typeof answer === "function" ? answer(made) : answer;
    },
    async sendText(paneId, text, options) { calls.push(["sendText", paneId, text, options]); },
    agentsClient(serverId) {
      if (serverId === LAB) {
        return {
          async installedAgents() { calls.push(["remoteAgents", LAB]); return ["codex", "opencode"]; },
          async namesNewProjects() { return true; },
        };
      }
      // A connected PC from before this answers nothing about its agents.
      if (serverId === OLD) return { async installedAgents() { return null; }, async namesNewProjects() { return false; } };
      if (serverId === QUIET) return { async installedAgents() { return ["codex"]; }, async namesNewProjects() { return false; } };
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
  const post = (body, headers = {}) => fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", Origin: baseUrl, ...headers },
    body: JSON.stringify(body),
  });
  return { herdr, baseUrl, post };
}

test("a plain new project is made as before, and names its first pane", async (context) => {
  const app = await start(context);
  const response = await app.post({ label: "Shop" });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.paneId, "hs~w2:p1");
  assert.ok(payload.snapshot.workspaces.some((item) => item.label === "Shop"));
  assert.deepEqual(app.herdr.calls, [["createWorkspace", "Shop", undefined]]);
});

test("a plain new project from a Herdr that names nothing answers as it always did", async (context) => {
  const app = await start(context, fakeHerdr({ answer: null }));
  const response = await app.post({ label: "Shop", herdrSessionId: "hs", agent: "" });
  assert.equal(response.status, 201);
  assert.equal("paneId" in await response.json(), false);
  assert.deepEqual(app.herdr.calls, [["createWorkspace", "Shop", "hs"]]);
});

test("a new project with an agent types that agent's command into the pane the create call named", async (context) => {
  const app = await start(context);
  const response = await app.post({ label: "Shop", herdrSessionId: "hs", agent: "claude" });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).paneId, "hs~w2:p1");
  assert.deepEqual(app.herdr.calls, [
    ["createWorkspace", "Shop", "hs"],
    ["sendText", "hs~w2:p1", "claude", { submit: true }],
  ]);
});

test("without a Herdr session named, the agent is checked on this machine", async (context) => {
  const app = await start(context);
  assert.equal((await app.post({ label: "Shop", agent: "codex" })).status, 201);
  assert.deepEqual(app.herdr.calls.at(-1), ["sendText", "hs~w2:p1", "codex", { submit: true }]);
});

test("a connected PC's new project starts an agent that PC has", async (context) => {
  const app = await start(context);
  const response = await app.post({ label: "Bench", herdrSessionId: `${LAB}!hs`, agent: "opencode" });
  assert.equal(response.status, 201);
  assert.deepEqual(app.herdr.calls, [
    ["remoteAgents", LAB],
    ["createWorkspace", "Bench", `${LAB}!hs`],
    ["sendText", `${LAB}!hs~w2:p1`, "opencode", { submit: true }],
  ]);
});

test("nothing is made for an agent that is unknown, not installed there, or on a PC too old to say", async (context) => {
  const app = await start(context);
  const cases = [
    [{ label: "A", agent: "rm -rf ~" }, 400, "invalid_input"],
    [{ label: "A", agent: { name: "claude" } }, 400, "invalid_input"],
    [{ label: "A", agent: "toString" }, 400, "invalid_input"],
    [{ label: "A", herdrSessionId: "hs", agent: "opencode" }, 409, "agent_not_installed"],
    [{ label: "A", herdrSessionId: `${LAB}!hs`, agent: "claude" }, 409, "agent_not_installed"],
    [{ label: "A", herdrSessionId: `${OLD}!hs`, agent: "codex" }, 501, "link_unsupported"],
    [{ label: "A", herdrSessionId: `${QUIET}!hs`, agent: "codex" }, 501, "link_unsupported"],
    [{ label: "A", herdrSessionId: "nowhere", agent: "codex" }, 400, "invalid_input"],
    [{ label: "A", herdrSessionId: 7, agent: "codex" }, 400, "invalid_input"],
  ];
  for (const [body, status, code] of cases) {
    const response = await app.post(body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal((await response.json()).error.code, code, JSON.stringify(body));
  }
  assert.equal(app.herdr.calls.some(([name]) => name === "createWorkspace" || name === "sendText"), false);
});

test("a project made whose first pane the create call did not name is reported, not typed into", async (context) => {
  for (const answer of [
    null,
    (made) => ({ ...made, pane_id: undefined }),
    // a pane that is not in the snapshot
    (made) => ({ ...made, pane_id: `${made.workspace_id}:p9` }),
    // a pane of a project that was already there
    () => ({ workspace_id: "hs~w1", tab_id: "hs~w1:t1", pane_id: "hs~w1:p1" }),
    // the new project's pane, named under another tab
    (made) => ({ ...made, tab_id: "hs~w1:t1" }),
  ]) {
    const app = await start(context, fakeHerdr({ answer }));
    const response = await app.post({ label: "Shop", herdrSessionId: "hs", agent: "claude" });
    assert.equal(response.status, 502, String(answer));
    assert.equal((await response.json()).error.code, "project_pane_missing");
    assert.deepEqual(app.herdr.calls, [["createWorkspace", "Shop", "hs"]], "made once, typed into nowhere");
  }
});

test("a connected PC's answer naming a pane on another machine is not typed into", async (context) => {
  const app = await start(context, fakeHerdr({ answer: () => ({ workspace_id: "hs~w1", tab_id: "hs~w1:t1", pane_id: "hs~w1:p1" }) }));
  const response = await app.post({ label: "Bench", herdrSessionId: `${LAB}!hs`, agent: "codex" });
  assert.equal(response.status, 502);
  assert.equal(app.herdr.calls.some(([name]) => name === "sendText"), false);
});

test("every agent is started in a new project by exactly its command from the agent table", async (context) => {
  const app = await start(context, fakeHerdr(), { installedAgents: { async list() { return Object.keys(AGENT_COMMANDS); } } });
  for (const agent of Object.keys(AGENT_COMMANDS)) {
    assert.equal((await app.post({ label: agent, herdrSessionId: "hs", agent })).status, 201, agent);
  }
  assert.deepEqual(app.herdr.calls.filter(([name]) => name === "sendText").map(([, , text]) => text), Object.values(AGENT_COMMANDS));
});

test("a JSON null body is refused as bad input, not a server error", async (context) => {
  const app = await start(context);
  const response = await app.post(null);
  assert.equal(response.status, 400);
  assert.deepEqual(app.herdr.calls, []);
});

test("starting an agent in a new project needs the page's write token", async (context) => {
  const app = await start(context);
  const response = await app.post({ label: "Shop", agent: "claude" }, { "X-Herdr-CSRF": "wrong" });
  assert.equal(response.status, 403);
  assert.deepEqual(app.herdr.calls, []);
});
