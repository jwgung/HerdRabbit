import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { HerdrCommandError } from "../src/herdr-client.mjs";

// A herdr whose worktree calls are recorded; `refuse` names a Herdr refusal
// code for every change.
function fakeHerdr({ refuse = null } = {}) {
  const calls = [];
  const workspaces = [{ workspace_id: "w1", label: "shop" }];
  const fail = () => { if (refuse) throw new HerdrCommandError(`Herdr said ${refuse}`, { code: refuse }); };
  return {
    calls,
    async snapshot() { return { workspaces: [...workspaces], tabs: [], panes: [], agents: [] }; },
    async listWorktrees(id) {
      calls.push(["list", id]);
      if (refuse) fail();
      return { source: { repo_name: "shop", repo_root: "/work/shop" }, worktrees: [{ path: "/work/shop", branch: "main", open_workspace_id: "w1" }] };
    },
    async createWorktree(id, options) {
      calls.push(["create", id, options]);
      fail();
      workspaces.push({ workspace_id: "w2", label: "cart", worktree: { is_linked_worktree: true, branch: options.branch } });
      return { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", path: "/work/wt/cart", branch: options.branch, already_open: false };
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

async function start(context, herdr = fakeHerdr()) {
  const { server } = createHerdrHttpServer({ herdr, csrfToken: "token", logger: { error() {} } });
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
