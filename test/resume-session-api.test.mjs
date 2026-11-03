// The API that lists a project's earlier agent sessions and resumes one: the
// project's folder comes from its panes, each machine answers for its own
// sessions, and only an id the server itself listed is ever typed.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { AgentSessions } from "../src/agent-sessions.mjs";
import { kiroWorkspaceHash } from "../src/conversation/kiro.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";

const LAB = "link_11111111-1111-1111-1111-111111111111";
const OLD = "link_22222222-2222-2222-2222-222222222222";
const CLAUDE_A = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const CLAUDE_GONE = "9d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const OC_A = "ses_0001AAAAAAAAAAAAAAAAAAAAAA";

function fakeHerdr() {
  const calls = [];
  const workspaces = [
    { workspace_id: "w1", label: "Platform" },
    { workspace_id: "w2", label: "Empty" },
    { workspace_id: `${LAB}!hs~w1`, label: "Bench", server_id: LAB },
    { workspace_id: `${OLD}!hs~w1`, label: "Old", server_id: OLD },
  ];
  const tabs = [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }];
  const panes = [
    // a pane with no folder yet, then the one that names the project's folder
    { pane_id: "w1:p0", tab_id: "w1:t1", workspace_id: "w1", cwd: "" },
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: "/home/u", foreground_cwd: "/work/alpha" },
    { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/later" },
    { pane_id: `${LAB}!hs~w1:p1`, tab_id: `${LAB}!hs~w1:t1`, workspace_id: `${LAB}!hs~w1`, cwd: "/srv/bench" },
    { pane_id: `${OLD}!hs~w1:p1`, tab_id: `${OLD}!hs~w1:t1`, workspace_id: `${OLD}!hs~w1`, cwd: "/srv/old" },
  ];
  return {
    calls,
    async snapshot() {
      return { workspaces: [...workspaces], tabs: tabs.map((tab) => ({ ...tab })), panes: panes.map((pane) => ({ ...pane })), agents: [] };
    },
    async createTab(workspaceId, ...options) {
      calls.push(["createTab", workspaceId, ...options]);
      const n = tabs.length + 1;
      tabs.push({ tab_id: `${workspaceId}:t${n}`, workspace_id: workspaceId, label: String(n) });
      panes.push({ pane_id: `${workspaceId}:p${n}`, tab_id: `${workspaceId}:t${n}`, workspace_id: workspaceId, cwd: options[0]?.cwd ?? "/home/u" });
      return { tab_id: `${workspaceId}:t${n}`, pane_id: `${workspaceId}:p${n}` };
    },
    async renameTab(tabId, label) { calls.push(["renameTab", tabId, label]); },
    async sendText(paneId, text, options) { calls.push(["sendText", paneId, text, options]); },
    agentsClient(serverId) {
      if (serverId === LAB) {
        return {
          async installedAgents() { calls.push(["remoteAgents", LAB]); return ["codex", "opencode"]; },
          async agentSessions(agent, cwd) {
            calls.push(["remoteSessions", LAB, agent, cwd]);
            return agent === "opencode" ? [{ id: OC_A, title: "Remote work", updatedAt: 5 }] : [];
          },
        };
      }
      // A connected PC from before resuming: it can tell its agents, not their sessions.
      if (serverId === OLD) return { async installedAgents() { return ["claude"]; } };
      return null;
    },
  };
}

function fakeSessions(calls, list = { claude: [{ id: CLAUDE_A, title: "Fix login", updatedAt: 1000 }] }) {
  return {
    async list(agent, cwd) {
      calls.push(["listSessions", agent, cwd]);
      return Object.hasOwn(list, agent) ? list[agent] : ["claude", "codex", "opencode", "kiro"].includes(agent) ? [] : null;
    },
  };
}

async function start(context, { herdr = fakeHerdr(), agentSessions, ...options } = {}) {
  const { server } = createHerdrHttpServer({
    herdr,
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    installedAgents: { async list() { return ["claude", "codex", "agy"]; } },
    agentSessions: agentSessions === undefined ? fakeSessions(herdr.calls) : agentSessions,
    ...options,
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

const sessionsOf = (id, agent) => `/api/workspaces/${encodeURIComponent(id)}/agent-sessions?agent=${encodeURIComponent(agent)}`;
const tabsOf = (id) => `/api/workspaces/${encodeURIComponent(id)}/tabs`;

test("lists the earlier sessions of an agent in the project's folder", async (context) => {
  const app = await start(context);
  const response = await app.get(sessionsOf("w1", "claude"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    agent: "claude", folder: "/work/alpha", supported: true, reason: null,
    sessions: [{ id: CLAUDE_A, title: "Fix login", updatedAt: 1000 }],
  });
  // the folder is the first of the project's panes that has one, as the page shows it
  assert.deepEqual(app.herdr.calls, [["listSessions", "claude", "/work/alpha"]]);
});

test("an agent with no verified resume flag, or a project with no folder, lists nothing", async (context) => {
  const app = await start(context);
  assert.deepEqual(await (await app.get(sessionsOf("w1", "agy"))).json(),
    { agent: "agy", folder: "/work/alpha", supported: false, reason: "agent", sessions: [] });
  assert.deepEqual(await (await app.get(sessionsOf("w2", "claude"))).json(),
    { agent: "claude", folder: null, supported: true, reason: null, sessions: [] });
  assert.deepEqual(app.herdr.calls, []);
});

test("a connected PC lists its own sessions; one from before this says it cannot", async (context) => {
  const app = await start(context);
  assert.deepEqual(await (await app.get(sessionsOf(`${LAB}!hs~w1`, "opencode"))).json(), {
    agent: "opencode", folder: "/srv/bench", supported: true, reason: null,
    sessions: [{ id: OC_A, title: "Remote work", updatedAt: 5 }],
  });
  assert.deepEqual(await (await app.get(sessionsOf(`${OLD}!hs~w1`, "claude"))).json(),
    { agent: "claude", folder: "/srv/old", supported: false, reason: "machine", sessions: [] });
  assert.deepEqual(app.herdr.calls, [["remoteSessions", LAB, "opencode", "/srv/bench"]]);
});

test("a server without a session lister says this machine cannot list them", async (context) => {
  const app = await start(context, { agentSessions: null });
  assert.deepEqual(await (await app.get(sessionsOf("w1", "claude"))).json(),
    { agent: "claude", folder: "/work/alpha", supported: false, reason: "machine", sessions: [] });
});

test("the listing refuses unknown agents and projects, and other origins", async (context) => {
  const app = await start(context);
  for (const [path, status, code] of [
    [sessionsOf("w1", "rm -rf /"), 400, "invalid_input"],
    [sessionsOf("w1", "toString"), 400, "invalid_input"],
    ["/api/workspaces/w1/agent-sessions", 400, "invalid_input"],
    [sessionsOf("w9", "claude"), 404, "unknown_workspace"],
  ]) {
    const response = await app.get(path);
    assert.equal(response.status, status, path);
    assert.equal((await response.json()).error.code, code, path);
  }
  const foreign = await fetch(`${app.baseUrl}${sessionsOf("w1", "claude")}`, { headers: { Origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(app.herdr.calls, []);
});

test("a store that cannot be read now is said so, not shown as no sessions", async (context) => {
  const herdr = fakeHerdr();
  const app = await start(context, { herdr, agentSessions: { async list() { throw new Error("database is locked"); } } });
  const response = await app.get(sessionsOf("w1", "claude"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "sessions_unavailable");
});

test("resuming opens a session in the project's folder and types the agent's resume command", async (context) => {
  const app = await start(context);
  const response = await app.post(tabsOf("w1"), { agent: "claude", resume: CLAUDE_A, label: "Login" });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).paneId, "w1:p2");
  assert.deepEqual(app.herdr.calls, [
    ["listSessions", "claude", "/work/alpha"],
    ["createTab", "w1", { cwd: "/work/alpha" }],
    ["renameTab", "w1:t2", "Login"],
    ["sendText", "w1:p2", `claude --resume ${CLAUDE_A}`, { submit: true }],
  ]);
});

test("a connected PC's session is resumed there, with the id that PC listed", async (context) => {
  const app = await start(context);
  const workspace = `${LAB}!hs~w1`;
  assert.equal((await app.post(tabsOf(workspace), { agent: "opencode", resume: OC_A })).status, 201);
  assert.deepEqual(app.herdr.calls, [
    ["remoteAgents", LAB],
    ["remoteSessions", LAB, "opencode", "/srv/bench"],
    ["createTab", workspace, { cwd: "/srv/bench" }],
    ["sendText", `${workspace}:p2`, `opencode --session ${OC_A}`, { submit: true }],
  ]);
});

test("nothing is made for an id that is malformed, not listed here, or for an agent or PC that cannot resume", async (context) => {
  const app = await start(context);
  const cases = [
    // malformed: refused before anything is asked
    [tabsOf("w1"), { agent: "claude", resume: `${CLAUDE_A}; rm -rf /` }, 400, "invalid_input"],
    [tabsOf("w1"), { agent: "claude", resume: "$(reboot)" }, 400, "invalid_input"],
    [tabsOf("w1"), { agent: "claude", resume: OC_A }, 400, "invalid_input"],
    [tabsOf("w1"), { agent: "claude", resume: 7 }, 400, "invalid_input"],
    [tabsOf("w1"), { resume: CLAUDE_A }, 400, "invalid_input"],
    [tabsOf("w1"), { agent: "agy", resume: CLAUDE_A }, 400, "invalid_input"],
    // well formed, but not one this server listed for the folder
    [tabsOf("w1"), { agent: "claude", resume: CLAUDE_GONE }, 409, "session_not_found"],
    [tabsOf("w2"), { agent: "claude", resume: CLAUDE_A }, 409, "session_not_found"],
    [tabsOf(`${LAB}!hs~w1`), { agent: "codex", resume: CLAUDE_A }, 409, "session_not_found"],
    [tabsOf(`${OLD}!hs~w1`), { agent: "claude", resume: CLAUDE_A }, 501, "link_unsupported"],
    [tabsOf("w1"), { agent: "opencode", resume: OC_A }, 409, "agent_not_installed"],
  ];
  for (const [path, body, status, code] of cases) {
    const response = await app.post(path, body);
    assert.equal(response.status, status, `${path} ${JSON.stringify(body)}`);
    assert.equal((await response.json()).error.code, code, `${path} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(app.herdr.calls.filter(([name]) => ["createTab", "renameTab", "sendText"].includes(name)), []);
  // only the well-formed id, in a project with a folder, reached this machine's lister
  assert.deepEqual(app.herdr.calls.filter(([name]) => name === "listSessions"), [["listSessions", "claude", "/work/alpha"]]);
});

test("a plain new session with an agent still opens where Herdr puts it", async (context) => {
  const app = await start(context);
  assert.equal((await app.post(tabsOf("w1"), { agent: "codex", resume: "" })).status, 201);
  assert.deepEqual(app.herdr.calls, [["createTab", "w1", { cwd: undefined }], ["sendText", "w1:p2", "codex", { submit: true }]]);
});

test("a resume types only into the tab the create call named, even when another tab appeared meanwhile", async (context) => {
  const herdr = fakeHerdr();
  const make = herdr.createTab;
  herdr.createTab = async (workspaceId, ...options) => {
    const made = await make(workspaceId, ...options);
    // someone else opened a tab in the same project at the same moment
    await make(workspaceId);
    herdr.calls.pop();
    return made;
  };
  const app = await start(context, { herdr });
  const response = await app.post(tabsOf("w1"), { agent: "claude", resume: CLAUDE_A });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).paneId, "w1:p2");
  assert.deepEqual(app.herdr.calls.filter(([name]) => name !== "listSessions"), [
    ["createTab", "w1", { cwd: "/work/alpha" }],
    ["sendText", "w1:p2", `claude --resume ${CLAUDE_A}`, { submit: true }],
  ]);
});

test("a resume types nothing when the named tab is not in that project", async (context) => {
  const herdr = fakeHerdr();
  const make = herdr.createTab;
  herdr.createTab = async (workspaceId, ...options) => {
    await make(workspaceId, ...options);
    return { tab_id: "w2:t9", pane_id: "w2:p9" };
  };
  const app = await start(context, { herdr });
  const response = await app.post(tabsOf("w1"), { agent: "claude", resume: CLAUDE_A });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "session_missing");
  assert.deepEqual(app.herdr.calls.filter(([name]) => name === "sendText"), []);
});

// ---------------------------------------------------------------------------
// End to end: this machine's own lister over Codex's index and Kiro's session
// folders (synthetic, under a temp root), then the exact command typed.

const THREAD = "019da5c2-66fd-7021-b565-5e94406b028e";
const KIRO = "3d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";

async function realLister(context, sqlite) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-resume-api-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const folder = "/work/alpha";
  // Codex: a rollout and the index row naming it, begun in the folder
  const day = join(root, "codex", "sessions", "2026", "10", "01");
  await mkdir(day, { recursive: true });
  const rollout = join(day, `rollout-2026-10-01T01-00-00-${THREAD}.jsonl`);
  await writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: THREAD, cwd: folder, source: "cli" } })}\n`);
  const db = new sqlite.DatabaseSync(join(root, "codex", "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT, updated_at_ms INTEGER, title TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)").run(THREAD, rollout, folder, "cli", 100_000, "Codex work");
  db.close();
  // Kiro: a session folder under the folder's workspace hash
  const kiro = join(root, "kiro", "sessions", kiroWorkspaceHash(folder), `sess_${KIRO}`);
  await mkdir(kiro, { recursive: true });
  await writeFile(join(kiro, "messages.jsonl"), `${JSON.stringify({ id: "evt", timestamp: "2026-10-01T00:00:00.000Z", payload: { type: "user", content: "Kiro work" } })}\n`);
  const store = localTranscriptStore({
    configDir: join(root, "claude"), codexHome: join(root, "codex"), kiroConfigDir: join(root, "kiro"),
    agyDataDir: join(root, "agy"), opencodeDb: join(root, "none.db"),
  });
  context.after(() => store.opencode.close());
  return new AgentSessions({ store });
}

test("Codex and Kiro sessions listed from their own stores are resumed with their exact commands", async (context) => {
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { context.skip("node:sqlite is not available"); return; }
  const app = await start(context, {
    agentSessions: await realLister(context, sqlite),
    installedAgents: { async list() { return ["codex", "kiro"]; } },
  });
  const codex = await (await app.get(sessionsOf("w1", "codex"))).json();
  assert.deepEqual(codex.sessions.map((session) => session.id), [THREAD]);
  const kiro = await (await app.get(sessionsOf("w1", "kiro"))).json();
  assert.deepEqual(kiro.sessions.map((session) => [session.id, session.title]), [[`sess_${KIRO}`, "Kiro work"]]);

  assert.equal((await app.post(tabsOf("w1"), { agent: "codex", resume: THREAD })).status, 201);
  assert.equal((await app.post(tabsOf("w1"), { agent: "kiro", resume: `sess_${KIRO}` })).status, 201);
  assert.deepEqual(app.herdr.calls, [
    ["createTab", "w1", { cwd: "/work/alpha" }],
    ["sendText", "w1:p2", `codex resume ${THREAD}`, { submit: true }],
    ["createTab", "w1", { cwd: "/work/alpha" }],
    ["sendText", "w1:p3", `kiro-cli chat --resume-id sess_${KIRO}`, { submit: true }],
  ]);
  // the uuid alone, or an id the folder does not hold, is not resumed
  assert.equal((await app.post(tabsOf("w1"), { agent: "kiro", resume: KIRO })).status, 400);
  assert.equal((await app.post(tabsOf("w1"), { agent: "kiro", resume: `sess_${THREAD}` })).status, 409);
});
