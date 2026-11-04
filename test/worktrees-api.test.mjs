import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { HerdrCommandError } from "../src/herdr-client.mjs";

// A herdr whose worktree calls are recorded; `refuse` names a Herdr refusal
// code for every change.
function fakeHerdr({ refuse = null, namePane = true, reopen = false } = {}) {
  const calls = [];
  const workspaces = [{ workspace_id: "w1", label: "shop" }, { workspace_id: "link_1!w1", label: "laptop shop", server_id: "link_1" }];
  const tabs = [{ tab_id: "w1:t1", workspace_id: "w1" }];
  const panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }];
  const fail = () => { if (refuse) throw new HerdrCommandError(`Herdr said ${refuse}`, { code: refuse }); };
  return {
    calls,
    async snapshot() { return { workspaces: [...workspaces], tabs: [...tabs], panes: [...panes], agents: [] }; },
    async sendText(paneId, text, options) { calls.push(["type", paneId, text, options]); },
    async listWorktrees(id) {
      calls.push(["list", id]);
      if (refuse) fail();
      return { source: { repo_name: "shop", repo_root: "/work/shop" }, worktrees: [{ path: "/work/shop", branch: "main", open_workspace_id: "w1" }] };
    },
    async createWorktree(id, options) {
      calls.push(["create", id, options]);
      fail();
      // A Herdr that answers with a workspace already there (its root pane).
      if (reopen) return { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", path: "/work/shop", branch: options.branch, already_open: true };
      if (id.startsWith("link_1!")) {
        workspaces.push({ workspace_id: "link_1!w2", label: "cart", server_id: "link_1" });
        tabs.push({ tab_id: "link_1!w2:t1", workspace_id: "link_1!w2" });
        panes.push({ pane_id: "link_1!w2:p1", tab_id: "link_1!w2:t1", workspace_id: "link_1!w2" });
        return { workspace_id: "link_1!w2", tab_id: "link_1!w2:t1", pane_id: "link_1!w2:p1", path: "/work/wt/cart", branch: options.branch, already_open: false };
      }
      workspaces.push({ workspace_id: "w2", label: "cart", worktree: { is_linked_worktree: true, branch: options.branch } });
      tabs.push({ tab_id: "w2:t1", workspace_id: "w2" });
      panes.push({ pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" });
      return namePane
        ? { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", path: "/work/wt/cart", branch: options.branch, already_open: false }
        : null;
    },
    async openWorktree(id, options) {
      calls.push(["open", id, options]);
      fail();
      return { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", path: options.path, branch: "cart", already_open: true };
    },
    async removeWorktree(id, options) {
      calls.push(["remove", id, options]);
      fail();
      return { workspace_id: id, path: "/work/wt/cart", forced: options.force === true };
    },
  };
}

async function start(context, herdr = fakeHerdr(), { agents = ["claude", "codex"] } = {}) {
  const installedAgents = { async list() { return agents; } };
  const { server } = createHerdrHttpServer({ herdr, csrfToken: "token", logger: { error() {} }, installedAgents });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = { "X-Herdr-CSRF": "token" }) => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body),
  });
  return { herdr, base, post, get: (path) => fetch(`${base}${path}`, { headers: { Origin: base } }) };
}

test("a workspace's worktrees are listed, and one is made, opened and removed", async (context) => {
  const app = await start(context);
  const list = await app.get("/api/workspaces/w1/worktrees");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).worktrees[0].branch, "main");

  const made = await app.post("/api/workspaces/w1/worktrees", { branch: "feat/cart", base: "main", label: "Cart", extra: "dropped" });
  assert.equal(made.status, 201);
  const madeBody = await made.json();
  assert.equal(madeBody.paneId, "w2:p1");
  assert.equal(madeBody.worktree.branch, "feat/cart");
  assert.ok(madeBody.snapshot.workspaces.some((item) => item.workspace_id === "w2"));

  const opened = await app.post("/api/workspaces/w1/worktrees/open", { path: "/work/wt/cart" });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).worktree.already_open, true);

  assert.equal((await app.post("/api/workspaces/w2/worktree/remove", {})).status, 400, "a remove is confirmed first");
  const removed = await app.post("/api/workspaces/w2/worktree/remove", { confirmed: true, force: true });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).removed, { workspace_id: "w2", path: "/work/wt/cart", forced: true });

  assert.deepEqual(app.herdr.calls, [
    ["list", "w1"],
    ["create", "w1", { branch: "feat/cart", base: "main", label: "Cart" }],
    ["open", "w1", { path: "/work/wt/cart", label: undefined }],
    ["remove", "w2", { force: true }],
  ]);
});

test("a worktree change needs the page's write token", async (context) => {
  const app = await start(context);
  for (const path of ["/api/workspaces/w1/worktrees", "/api/workspaces/w1/worktrees/open", "/api/workspaces/w2/worktree/remove"]) {
    assert.equal((await app.post(path, { branch: "x", path: "/x", confirmed: true }, {})).status, 403, path);
  }
  assert.deepEqual(app.herdr.calls, []);
});

test("Herdr's refusals reach the page as 409 with their code", async (context) => {
  for (const code of ["not_git_worktree", "dirty_worktree_requires_force", "linked_worktree_source", "worktree_create_failed"]) {
    const app = await start(context, fakeHerdr({ refuse: code }));
    const response = code === "dirty_worktree_requires_force"
      ? await app.post("/api/workspaces/w2/worktree/remove", { confirmed: true })
      : code === "not_git_worktree" ? await app.get("/api/workspaces/w1/worktrees")
        : await app.post("/api/workspaces/w1/worktrees", { branch: "cart" });
    assert.equal(response.status, 409, code);
    assert.equal((await response.json()).error.code, code);
  }
});

test("a server without worktrees says so", async (context) => {
  const app = await start(context, { async snapshot() { return { workspaces: [] }; } });
  const response = await app.get("/api/workspaces/w1/worktrees");
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error.code, "worktrees_unsupported");
});

test("a new worktree may start an agent in its first pane, the one the create call named", async (context) => {
  const app = await start(context);
  const made = await app.post("/api/workspaces/w1/worktrees", { branch: "feat/cart", agent: "claude" });
  assert.equal(made.status, 201);
  assert.equal((await made.json()).paneId, "w2:p1");
  assert.deepEqual(app.herdr.calls, [
    ["create", "w1", { branch: "feat/cart", base: undefined, label: undefined }],
    ["type", "w2:p1", "claude", { submit: true }],
  ]);
});

test("an unknown or missing agent is refused before a worktree is made", async (context) => {
  const app = await start(context, fakeHerdr(), { agents: ["codex"] });
  const unknown = await app.post("/api/workspaces/w1/worktrees", { branch: "feat/cart", agent: "rm -rf" });
  assert.equal(unknown.status, 400);
  const missing = await app.post("/api/workspaces/w1/worktrees", { branch: "feat/cart", agent: "claude" });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error.code, "agent_not_installed");
  const gone = await app.post("/api/workspaces/w9/worktrees", { branch: "feat/cart", agent: "codex" });
  assert.equal(gone.status, 404);
  assert.deepEqual(app.herdr.calls, []);
});

test("a worktree made without a named pane is kept, and no agent is typed anywhere", async (context) => {
  const app = await start(context, fakeHerdr({ namePane: false }));
  const made = await app.post("/api/workspaces/w1/worktrees", { branch: "feat/cart", agent: "claude" });
  assert.equal(made.status, 502);
  assert.equal((await made.json()).error.code, "worktree_pane_missing");
  assert.deepEqual(app.herdr.calls.map((call) => call[0]), ["create"]);
});

test("an answer naming a workspace that was already there gets no agent typed into it", async (context) => {
  const herdr = fakeHerdr({ reopen: true });
  const app = await start(context, herdr);
  const made = await app.post("/api/workspaces/w1/worktrees", { branch: "feat/cart", agent: "claude" });
  assert.equal(made.status, 502);
  assert.deepEqual(app.herdr.calls.map((call) => call[0]), ["create"]);
});

test("a connected PC's worktree starts an agent that PC has, and is refused one it lacks or an old PC", async (context) => {
  for (const [remote, status, typed] of [
    [{ async installedAgents() { return ["codex"]; } }, 201, [["type", "link_1!w2:p1", "codex", { submit: true }]]],
    [{ async installedAgents() { return ["claude"]; } }, 409, []],
    [{}, 501, []],
  ]) {
    const herdr = fakeHerdr();
    herdr.agentsClient = (id) => (id === "link_1" ? remote : null);
    const app = await start(context, herdr, { agents: ["codex"] });
    const made = await app.post(`/api/workspaces/${encodeURIComponent("link_1!w1")}/worktrees`, { branch: "feat/cart", agent: "codex" });
    assert.equal(made.status, status);
    assert.deepEqual(herdr.calls.filter((call) => call[0] === "type"), typed);
    if (status !== 201) assert.deepEqual(herdr.calls, [], "refused before anything is made");
  }
});
