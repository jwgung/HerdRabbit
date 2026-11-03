import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { linkRoutes } from "../src/link-server.mjs";
import { LinkClient } from "../src/link-client.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";

const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const herdr = { async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; } };

async function startPeer(context, { installedAgents = null, allowed = ["127.0.0.1"] } = {}) {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: allowed }),
    link: linkRoutes({ client: herdr, installedAgents, version: "2.0.0", serverName: "dev-box" }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const client = (address) => new LinkClient({ profile: { id: LINK_ID, name: "Dev box", address }, hubVersion: "2.0.0" });

test("a PC that can tell its installed agents names it among its features", async (context) => {
  const withAgents = await startPeer(context, { installedAgents: { async list() { return ["claude"]; } } });
  assert.deepEqual((await (await fetch(`${withAgents}/api/link/hello`)).json()).features, ["scroll_bottom", "commands", "project_ids", "agents"]);
  const without = await startPeer(context);
  assert.deepEqual((await (await fetch(`${without}/api/link/hello`)).json()).features, ["scroll_bottom", "commands", "project_ids"]);
});

test("the hub hears which agents a connected PC has, and keeps only agents it knows", async (context) => {
  const address = await startPeer(context, {
    installedAgents: { async list() { return ["codex", "claude", "codex", "rm -rf /", { evil: true }, "toString"]; } },
  });
  assert.deepEqual(await client(address).installedAgents(), ["claude", "codex"]);
});

test("an older PC is not asked, and says nothing about its agents", async (context) => {
  const address = await startPeer(context);
  assert.equal(await client(address).installedAgents(), null);
  assert.equal((await fetch(`${address}/api/link/agents`)).status, 404);
});

test("the agents route is let in exactly like every other link route", async (context) => {
  let asked = 0;
  const address = await startPeer(context, { installedAgents: { async list() { asked += 1; return ["claude"]; } }, allowed: ["100.64.0.9"] });
  assert.equal((await fetch(`${address}/api/link/agents`)).status, 403);
  assert.equal(asked, 0);
});

test("the hub asks a connected PC through its own link, and never for this PC", () => {
  const profile = { id: LINK_ID, name: "Dev box", transport: "link", address: "http://127.0.0.1:1" };
  const multi = new MultiServerClient({
    local: herdr, profiles: { list: () => [profile] }, remoteFactory: () => ({ marker: "link", close() {} }),
  });
  assert.equal(multi.agentsClient(LINK_ID).marker, "link");
  assert.equal(multi.agentsClient("local"), null);
  assert.equal(multi.agentsClient("link_00000000-0000-0000-0000-000000000000"), null);
});

// ---------------------------------------------------------------------------
// Earlier sessions: the connected PC lists its own; the hub keeps what it can type.

const CLAUDE_A = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";

async function startSessionsPeer(context, { agentSessions, client: peerClient = herdr, allowed } = {}) {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: allowed ?? ["127.0.0.1"] }),
    link: linkRoutes({ client: peerClient, installedAgents: { async list() { return ["claude"]; } }, agentSessions, version: "2.0.0", serverName: "dev-box" }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("a PC that lists its earlier sessions names it, and answers for the folder asked", async (context) => {
  const asked = [];
  const address = await startSessionsPeer(context, {
    agentSessions: {
      async list(agent, cwd) {
        asked.push([agent, cwd]);
        return [
          { id: CLAUDE_A, title: "Fix\nlogin", updatedAt: 10 },
          { id: "$(reboot)", title: "bad", updatedAt: 1 },
        ];
      },
    },
  });
  assert.deepEqual((await (await fetch(`${address}/api/link/hello`)).json()).features,
    ["scroll_bottom", "commands", "project_ids", "agents", "agent_sessions"]);
  assert.deepEqual(await client(address).agentSessions("claude", "/work/My App"), [{ id: CLAUDE_A, title: "Fix login", updatedAt: 10 }]);
  assert.deepEqual(asked, [["claude", "/work/My App"]]);
});

test("a PC refuses to list for an unknown agent or a folder that is not absolute", async (context) => {
  let asked = 0;
  const address = await startSessionsPeer(context, { agentSessions: { async list() { asked += 1; return []; } } });
  for (const query of ["agent=rm&cwd=%2Fw", "agent=claude&cwd=relative", "agent=claude", "cwd=%2Fw"]) {
    assert.equal((await fetch(`${address}/api/link/agent-sessions?${query}`)).status, 400, query);
  }
  assert.equal(asked, 0);
});

test("an older PC is not asked for its sessions, and the route is gated like the others", async (context) => {
  const older = await startPeer(context, { installedAgents: { async list() { return ["claude"]; } } });
  assert.equal(await client(older).agentSessions("claude", "/w"), null);
  let asked = 0;
  const closed = await startSessionsPeer(context, { agentSessions: { async list() { asked += 1; return []; } }, allowed: ["100.64.0.9"] });
  assert.equal((await fetch(`${closed}/api/link/agent-sessions?agent=claude&cwd=%2Fw`)).status, 403);
  assert.equal(asked, 0);
});

// This PC's snapshot: project hs~w1 works in /work/My App (its first pane with
// a folder); hs~w2 has no folder yet.
const folderHerdr = {
  async snapshot() {
    return {
      herdr_sessions: [], agents: [],
      workspaces: [{ workspace_id: "hs~w1" }, { workspace_id: "hs~w2" }],
      tabs: [{ tab_id: "hs~w1:t0", workspace_id: "hs~w1" }, { tab_id: "hs~w2:t0", workspace_id: "hs~w2" }],
      panes: [
        { pane_id: "hs~w1:p0", tab_id: "hs~w1:t0", workspace_id: "hs~w1", cwd: "" },
        { pane_id: "hs~w1:p9", tab_id: "hs~w1:t0", workspace_id: "hs~w1", cwd: "/home/u", foreground_cwd: "/work/My App" },
        { pane_id: "hs~w2:p0", tab_id: "hs~w2:t0", workspace_id: "hs~w2", cwd: "" },
      ],
    };
  },
};

test("a session made over the link opens in the folder asked, and as before without one, and names its ids", async (context) => {
  const calls = [];
  const peerClient = {
    ...folderHerdr,
    async createTab(...args) {
      calls.push(args);
      return { tab_id: `hs~w1:t${calls.length}`, pane_id: `hs~w1:p${calls.length}` };
    },
  };
  const address = await startSessionsPeer(context, { agentSessions: { async list() { return []; } }, client: peerClient });
  const link = client(address);
  assert.deepEqual(await link.createTab("hs~w1", { cwd: "/work/My App" }), { tab_id: "hs~w1:t1", pane_id: "hs~w1:p1" });
  assert.deepEqual(await link.createTab("hs~w1"), { tab_id: "hs~w1:t2", pane_id: "hs~w1:p2" });
  assert.deepEqual(calls, [["hs~w1", { cwd: "/work/My App" }], ["hs~w1", { cwd: undefined }]]);
});

test("a PC opens a tab in a folder only when it is that project's own folder", async (context) => {
  const calls = [];
  const peerClient = { ...folderHerdr, async createTab(...args) { calls.push(args); return { tab_id: "hs~w1:t1", pane_id: "hs~w1:p1" }; } };
  const address = await startSessionsPeer(context, { agentSessions: { async list() { return []; } }, client: peerClient });
  const post = (workspace, body) => fetch(`${address}/api/link/workspaces/${encodeURIComponent(workspace)}/tabs`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const [workspace, cwd] of [
    ["hs~w1", "/etc"],
    // another pane's folder in the same project is not the project's folder
    ["hs~w1", "/home/u"],
    ["hs~w1", "/work/My App/"],
    ["hs~w1", "relative"],
    ["hs~w1", null],
    ["hs~w1", 7],
    // a project with no folder takes none
    ["hs~w2", "/work/My App"],
    ["hs~w2", null],
    ["hs~w9", "/work/My App"],
  ]) {
    const response = await post(workspace, { cwd });
    assert.equal(response.status, 400, `${workspace} ${JSON.stringify(cwd)}`);
    assert.equal((await response.json()).error.code, "invalid_input");
  }
  assert.deepEqual(calls, []);
  assert.equal((await post("hs~w1", { cwd: "/work/My App" })).status, 200);
  assert.deepEqual(calls, [["hs~w1", { cwd: "/work/My App" }]]);
});

test("the hub's client hands the folder to whichever machine makes the tab, and gives back its ids", async () => {
  const calls = [];
  const local = { ...herdr, async createTab(...args) { calls.push(["local", ...args]); return { tab_id: "w1:t2", pane_id: "w1:p2" }; } };
  const remote = {
    ...herdr,
    marker: "link",
    close() {},
    async createTab(...args) { calls.push(["remote", ...args]); return { tab_id: "hs~w1:t5", pane_id: "hs~w1:p5" }; },
  };
  const profile = { id: LINK_ID, name: "Dev box", address: "http://127.0.0.1:1" };
  const multi = new MultiServerClient({ local, profiles: { list: () => [profile] }, remoteFactory: () => remote });
  assert.deepEqual(await multi.createTab("w1", { cwd: "/work/a" }), { tab_id: "w1:t2", pane_id: "w1:p2" });
  assert.deepEqual(await multi.createTab("w1"), { tab_id: "w1:t2", pane_id: "w1:p2" });
  assert.deepEqual(await multi.createTab(`${LINK_ID}!hs~w1`, { cwd: "/srv/b" }), { tab_id: `${LINK_ID}!hs~w1:t5`, pane_id: `${LINK_ID}!hs~w1:p5` });
  assert.deepEqual(calls, [["local", "w1", { cwd: "/work/a" }], ["local", "w1", { cwd: undefined }], ["remote", "hs~w1", { cwd: "/srv/b" }]]);
});

// ---------------------------------------------------------------------------
// A new project's ids: a PC names the pane it made, so the hub types only there.

test("a project made over the link names its ids, and the hub's client prefixes them", async (context) => {
  const calls = [];
  const peerClient = {
    ...herdr,
    async createWorkspace(...args) { calls.push(args); return { workspace_id: "hs~w7", tab_id: "hs~w7:t1", pane_id: "hs~w7:p1" }; },
  };
  const address = await startSessionsPeer(context, { client: peerClient });
  const link = client(address);
  assert.equal(await link.namesNewProjects(), true);
  assert.deepEqual(await link.createWorkspace("Shop", "hs"), { workspace_id: "hs~w7", tab_id: "hs~w7:t1", pane_id: "hs~w7:p1" });
  assert.deepEqual(calls, [["Shop", "hs"]]);

  const profile = { id: LINK_ID, name: "Dev box", address };
  const multi = new MultiServerClient({ local: herdr, profiles: { list: () => [profile] }, remoteFactory: () => link });
  assert.deepEqual(await multi.createWorkspace("Shop", `${LINK_ID}!hs`), {
    workspace_id: `${LINK_ID}!hs~w7`, tab_id: `${LINK_ID}!hs~w7:t1`, pane_id: `${LINK_ID}!hs~w7:p1`,
  });
});

test("a PC whose client names no ids gives the hub none, and an older PC says it does not name them", async (context) => {
  const silent = await startSessionsPeer(context, { client: { ...herdr, async createWorkspace() {} } });
  assert.equal(await client(silent).createWorkspace("Shop"), null);
  // A PC from before this does not list project_ids among its features.
  const routes = linkRoutes({ client: herdr, version: "2.0.0", serverName: "old-box" });
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: async (request, response, url, method) => {
      const end = response.end.bind(response);
      response.end = (body, ...rest) => {
        if (typeof body === "string" && body.includes('"features"')) {
          body = body.replace(/,?"project_ids"/u, "");
          response.setHeader("Content-Length", Buffer.byteLength(body));
        }
        return end(body, ...rest);
      };
      return routes(request, response, url, method);
    },
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal(await client(`http://127.0.0.1:${server.address().port}`).namesNewProjects(), false);
});

test("the hub's client gives back a new local project's ids as this PC's client names them", async () => {
  const local = { ...herdr, async createWorkspace() { return { workspace_id: "w3", tab_id: "w3:t1", pane_id: "w3:p1" }; } };
  const multi = new MultiServerClient({ local, profiles: { list: () => [] } });
  assert.deepEqual(await multi.createWorkspace("Shop"), { workspace_id: "w3", tab_id: "w3:t1", pane_id: "w3:p1" });
});
