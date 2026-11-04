import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { linkRoutes } from "../src/link-server.mjs";
import { LinkClient } from "../src/link-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { HerdrCommandError } from "../src/herdr-client.mjs";

const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const base = { async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; } };

// The connected PC's own Herdr client, recording what it is asked.
function peerClient({ refuse = null } = {}) {
  const calls = [];
  return {
    ...base,
    calls,
    async listWorktrees(id) {
      calls.push(["list", id]);
      return { source: { repo_name: "shop", repo_root: "/srv/shop" }, worktrees: [
        { path: "/srv/shop", branch: "main", open_workspace_id: "hs~w1", is_linked_worktree: false },
        { path: "/srv/wt/cart", branch: "cart", open_workspace_id: null, is_linked_worktree: true },
      ] };
    },
    async createWorktree(id, options) {
      calls.push(["create", id, options]);
      return { workspace_id: "hs~w5", tab_id: "hs~w5:t1", pane_id: "hs~w5:p1", path: "/srv/wt/cart", branch: options.branch, already_open: false };
    },
    async openWorktree(id, options) {
      calls.push(["open", id, options]);
      return { workspace_id: "hs~w5", tab_id: "hs~w5:t1", pane_id: "hs~w5:p1", path: options.path, branch: "cart", already_open: true };
    },
    async removeWorktree(id, options) {
      calls.push(["remove", id, options]);
      if (refuse) throw new HerdrCommandError("worktree has changes", { code: refuse });
      return { workspace_id: id, path: "/srv/wt/cart", forced: options.force };
    },
  };
}

async function startPeer(context, client) {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: linkRoutes({ client, version: "2.0.0", serverName: "dev-box" }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const linkTo = (address) => new LinkClient({ profile: { id: LINK_ID, name: "Dev box", address }, hubVersion: "2.0.0" });

// The hub's page, reaching the connected PC through the multi-server client.
async function startHub(context, link) {
  const herdr = new MultiServerClient({ local: base, profiles: { list: () => [{ id: LINK_ID, name: "Dev box", address: link.address }] }, remoteFactory: () => link });
  const { server } = createHerdrHttpServer({ herdr, csrfToken: "token", logger: { error() {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (path) => fetch(`${origin}${path}`, { headers: { Origin: origin } }),
    post: (path, body) => fetch(`${origin}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "token", Origin: origin }, body: JSON.stringify(body),
    }),
  };
}

test("a PC whose client has worktrees names it among its features", async (context) => {
  const hello = async (client) => (await (await fetch(`${await startPeer(context, client)}/api/link/hello`)).json()).features;
  assert.ok((await hello(peerClient())).includes("worktrees"));
  assert.ok(!(await hello(base)).includes("worktrees"));
});

test("the hub lists, makes, opens and removes a connected PC's worktrees, ids prefixed with that PC", async (context) => {
  const client = peerClient();
  const hub = await startHub(context, linkTo(await startPeer(context, client)));
  const workspace = encodeURIComponent(`${LINK_ID}!hs~w1`);

  const list = await (await hub.get(`/api/workspaces/${workspace}/worktrees`)).json();
  assert.deepEqual(list.worktrees.map((item) => item.open_workspace_id), [`${LINK_ID}!hs~w1`, null]);

  const made = await hub.post(`/api/workspaces/${workspace}/worktrees`, { branch: "cart", base: "main", label: "Cart" });
  assert.equal(made.status, 201);
  assert.equal((await made.json()).paneId, `${LINK_ID}!hs~w5:p1`);

  const opened = await (await hub.post(`/api/workspaces/${workspace}/worktrees/open`, { path: "/srv/wt/cart" })).json();
  assert.deepEqual([opened.worktree.workspace_id, opened.worktree.already_open], [`${LINK_ID}!hs~w5`, true]);

  const removed = await (await hub.post(`/api/workspaces/${encodeURIComponent(`${LINK_ID}!hs~w5`)}/worktree/remove`, { confirmed: true, force: true })).json();
  assert.deepEqual(removed.removed, { workspace_id: `${LINK_ID}!hs~w5`, path: "/srv/wt/cart", forced: true });

  assert.deepEqual(client.calls, [
    ["list", "hs~w1"],
    ["create", "hs~w1", { branch: "cart", base: "main", label: "Cart" }],
    ["open", "hs~w1", { path: "/srv/wt/cart", label: undefined }],
    ["remove", "hs~w5", { force: true }],
  ]);
});

test("a bad name is refused on the hub before the PC is asked", async (context) => {
  const client = peerClient();
  const hub = await startHub(context, linkTo(await startPeer(context, client)));
  const workspace = encodeURIComponent(`${LINK_ID}!hs~w1`);
  for (const body of [{ branch: "--force" }, { branch: "ok", base: "-x" }, { branch: "ok", label: "" }]) {
    assert.equal((await hub.post(`/api/workspaces/${workspace}/worktrees`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await hub.post(`/api/workspaces/${workspace}/worktrees/open`, { path: "relative" })).status, 400);
  assert.deepEqual(client.calls, []);
});

test("the PC's Herdr refusal comes back with its code, so the page can offer to force", async (context) => {
  const hub = await startHub(context, linkTo(await startPeer(context, peerClient({ refuse: "dirty_worktree_requires_force" }))));
  const response = await hub.post(`/api/workspaces/${encodeURIComponent(`${LINK_ID}!hs~w5`)}/worktree/remove`, { confirmed: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "dirty_worktree_requires_force");
});

test("an older PC without worktrees is too old, said as 501", async (context) => {
  const hub = await startHub(context, linkTo(await startPeer(context, base)));
  const response = await hub.get(`/api/workspaces/${encodeURIComponent(`${LINK_ID}!hs~w1`)}/worktrees`);
  assert.equal(response.status, 501);
  const { error } = await response.json();
  assert.equal(error.code, "link_unsupported");
  assert.match(error.message, /too old for Git worktrees; update it there/u);
});
