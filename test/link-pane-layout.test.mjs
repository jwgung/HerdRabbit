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
function peerClient() {
  const calls = [];
  return {
    ...base,
    calls,
    async paneLayout(id) {
      calls.push(["paneLayout", id]);
      return { layout: { workspace_id: "hs~w1", tab_id: "hs~w1:t1", focused_pane_id: id, zoomed: false, panes: [{ pane_id: id }, { pane_id: "hs~w1:p2" }] } };
    },
    async splitPane(id, direction) {
      calls.push(["splitPane", id, direction]);
      if (direction === "down") throw new HerdrCommandError("no room", { code: "pane_split_failed" });
      return { pane_id: "hs~w1:p3" };
    },
    async zoomPane(id) { calls.push(["zoomPane", id]); },
    async closePane(id) { calls.push(["closePane", id]); },
    async movePaneOut(id) { calls.push(["movePaneOut", id]); return { pane_id: id, tab_id: "hs~w1:t2" }; },
    async movePaneSplit(id, target, side) { calls.push(["movePaneSplit", id, target, side]); return { pane_id: "hs~w1:p9", placed: false, message: "no swap" }; },
    async swapPanes(id, target) { calls.push(["swapPanes", id, target]); return { pane_id: id }; },
    async relocatePane(id, target, side) { calls.push(["relocatePane", id, target, side]); return { pane_id: id }; },
    async evenLayout(id) { calls.push(["evenLayout", id]); return { pane_id: id, changed: true, steps: 1, even: true }; },
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

async function startHub(context, link) {
  const herdr = new MultiServerClient({ local: base, profiles: { list: () => [{ id: LINK_ID, name: "Dev box", address: link.address }] }, remoteFactory: () => link });
  const { server } = createHerdrHttpServer({ herdr, csrfToken: "token", logger: { error() {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    herdr,
    get: (path) => fetch(`${origin}${path}`, { headers: { Origin: origin } }),
    post: (path, body = {}) => fetch(`${origin}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "token", Origin: origin }, body: JSON.stringify(body),
    }),
  };
}

test("a connected PC says it lays out split tabs, and the hub's page does it there, end to end", async (context) => {
  const client = peerClient();
  const link = linkTo(await startPeer(context, client));
  context.after(() => link.close());
  const hub = await startHub(context, link);
  const at = (id) => `${LINK_ID}!${id}`;
  const pane = encodeURIComponent(at("hs~w1:p1"));

  const layout = await (await hub.get(`/api/panes/${pane}/layout`)).json();
  assert.deepEqual(layout.layout.panes.map((item) => item.pane_id), [at("hs~w1:p1"), at("hs~w1:p2")]);
  assert.equal(layout.layout.tab_id, at("hs~w1:t1"));
  assert.deepEqual(await (await hub.post(`/api/panes/${pane}/split`, { direction: "right" })).json(), { pane_id: at("hs~w1:p3") });
  // That PC's refusal reaches the page as a refusal, not a broken link.
  const full = await hub.post(`/api/panes/${pane}/split`, { direction: "down" });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).error.code, "pane_split_failed");
  assert.equal((await hub.post(`/api/panes/${pane}/zoom`, { mode: "toggle" })).status, 200);
  assert.equal((await hub.post(`/api/panes/${pane}/close`, { confirmed: true })).status, 200);
  assert.deepEqual(await (await hub.post(`/api/panes/${pane}/move-out`)).json(), { pane_id: at("hs~w1:p1"), tab_id: at("hs~w1:t2") });
  assert.deepEqual(await (await hub.post(`/api/panes/${pane}/move`, { targetPaneId: at("hs~w1:p5"), side: "left" })).json(),
    { pane_id: at("hs~w1:p9"), placed: false, message: "no swap" });
  assert.equal((await hub.post(`/api/panes/${pane}/swap`, { targetPaneId: at("hs~w1:p2") })).status, 200);
  assert.equal((await hub.post(`/api/panes/${pane}/relocate`, { targetPaneId: at("hs~w1:p2"), side: "up" })).status, 200);
  assert.equal((await (await hub.post(`/api/panes/${pane}/even-layout`)).json()).even, true);
  assert.deepEqual(client.calls.map((call) => call.slice(0, 2)), [
    ["paneLayout", "hs~w1:p1"], ["splitPane", "hs~w1:p1"], ["splitPane", "hs~w1:p1"], ["zoomPane", "hs~w1:p1"], ["closePane", "hs~w1:p1"],
    ["movePaneOut", "hs~w1:p1"], ["movePaneSplit", "hs~w1:p1"], ["swapPanes", "hs~w1:p1"], ["relocatePane", "hs~w1:p1"], ["evenLayout", "hs~w1:p1"],
  ]);
  assert.deepEqual(client.calls.find((call) => call[0] === "movePaneSplit"), ["movePaneSplit", "hs~w1:p1", "hs~w1:p5", "left"]);
  // The page is told the PC lays them out.
  const snapshot = await hub.herdr.snapshot();
  assert.equal(snapshot.servers.find((server) => server.id === LINK_ID).pane_layout, true);
  assert.equal(snapshot.servers.find((server) => server.id === "local").pane_layout, true);
});

test("the PC itself refuses a close nobody confirmed", async (context) => {
  const client = peerClient();
  const address = await startPeer(context, client);
  const response = await fetch(`${address}/api/link/panes/${encodeURIComponent("hs~w1:p1")}/close`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "confirmation_required");
  assert.deepEqual(client.calls, []);
});

test("a connected PC whose Herdr client cannot split says it cannot, and the page is told so", async (context) => {
  const link = linkTo(await startPeer(context, { ...base }));
  context.after(() => link.close());
  const hub = await startHub(context, link);
  const refused = await hub.post(`/api/panes/${encodeURIComponent(`${LINK_ID}!hs~w1:p1`)}/split`, { direction: "right" });
  assert.equal(refused.status, 501);
  assert.equal((await refused.json()).error.code, "link_unsupported");
  assert.equal((await hub.herdr.snapshot()).servers.find((server) => server.id === LINK_ID).pane_layout, false);
});
