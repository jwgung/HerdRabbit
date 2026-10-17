import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { linkRoutes } from "../src/link-server.mjs";
import { LINK_PROTOCOL } from "../src/link-protocol.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";

// The Connect PC port lets a caller in by its socket address; here the hub is
// this test, on loopback.
const asHub = {};
const PANE = "hs_ZGVmYXVsdA~wB:p1";

function fakePeer(overrides = {}) {
  const calls = [];
  return {
    calls,
    async snapshot() { calls.push(["snapshot"]); return { herdr_sessions: [{ session_id: "s1" }], panes: [{ pane_id: PANE }] }; },
    async readPane(id, options) { calls.push(["readPane", id, options]); return "pane text"; },
    async sendText(id, text, options) { calls.push(["sendText", id, text, options]); },
    async sendKeys(id, keys) { calls.push(["sendKeys", id, keys]); },
    ...overrides,
  };
}

async function startPeer(context, client, version = "1.2.0") {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: linkRoutes({ client, version, serverName: "dev-box" }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("announces what it is and what it will report", async (context) => {
  const base = await startPeer(context, fakePeer());
  const hello = await (await fetch(`${base}/api/link/hello`, { headers: asHub })).json();
  assert.deepEqual(hello, {
    product: "herdrabbit",
    version: "1.2.0",
    link_protocol: LINK_PROTOCOL,
    scope: "local",
    server_name: "dev-box",
    herdr_version: null,
    // without this PC's conversations, it offers no chat
    features: ["scroll_bottom"],
  });
});

test("carries the handshake with every snapshot", async (context) => {
  // The hub re-checks compatibility on each poll; riding along saves a trip
  // and catches a connected PC that was updated underneath us.
  const base = await startPeer(context, fakePeer());
  const body = await (await fetch(`${base}/api/link/snapshot`, { headers: asHub })).json();
  assert.equal(body.hello.product, "herdrabbit");
  assert.equal(body.snapshot.panes[0].pane_id, PANE);
});

test("reads a pane as plain text, not as a revision window", async (context) => {
  // The hub's own watcher does the diffing, so it needs what a local read
  // would have returned.
  const client = fakePeer();
  const base = await startPeer(context, client);
  const url = `${base}/api/link/panes/${encodeURIComponent(PANE)}/output?lines=40&format=ansi`;
  const body = await (await fetch(url, { headers: asHub })).json();
  assert.deepEqual(body, { output: "pane text" });
  assert.deepEqual(client.calls.at(-1), ["readPane", PANE, { lines: 40, format: "ansi" }]);
});

test("passes input through with the same validation the browser API uses", async (context) => {
  const client = fakePeer();
  const base = await startPeer(context, client);
  const send = (kind, body) => fetch(`${base}/api/link/panes/${encodeURIComponent(PANE)}/${kind}`, {
    method: "POST",
    headers: { ...asHub, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await send("text", { text: "hello", submit: true })).status, 200);
  assert.deepEqual(client.calls.at(-1), ["sendText", PANE, "hello", { submit: true }]);
  assert.equal((await send("keys", { keys: ["enter"] })).status, 200);
  assert.deepEqual(client.calls.at(-1), ["sendKeys", PANE, ["enter"]]);

  const refused = await send("keys", { keys: ["rm -rf"] });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "invalid_input");
});

// One reader for the life of the stream: taking a second would throw, and
// cancelling in between would close the very thing under test.
function frameReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async until(predicate) {
      while (!predicate(buffer)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

test("streams status only after the subscription is live", async (context) => {
  // A hub must be able to tell "watching" from "asked but never started",
  // so ready is written after watchStatuses resolves and not before.
  let emit;
  let stopped = 0;
  const client = fakePeer({
    watchStatuses: async (paneIds, onStatus) => {
      assert.deepEqual(paneIds, [PANE]);
      emit = onStatus;
      return () => { stopped += 1; };
    },
  });
  const base = await startPeer(context, client);
  const response = await fetch(`${base}/api/link/statuses`, {
    method: "POST",
    headers: { ...asHub, "content-type": "application/json" },
    body: JSON.stringify({ paneIds: [PANE, PANE] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);

  const stream = frameReader(response);
  assert.match(await stream.until((text) => text.includes("event: ready")), /event: ready/u);
  emit({ pane_id: PANE, agent_status: "done", extra: "dropped" });
  const frames = await stream.until((text) => text.includes("agent_status"));
  assert.match(frames, /data: \{"pane_id":"[^"]+","agent_status":"done"\}/u);
  assert.ok(!frames.includes("dropped"), "only the two fields the hub uses are forwarded");

  await stream.close();
  for (let attempt = 0; attempt < 50 && stopped === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(stopped, 1, "closing the stream releases the subscription");
});

test("a subscription that never starts fails as a stream that says so", async (context) => {
  const client = fakePeer({ watchStatuses: async () => { throw new Error("herdr socket is unavailable"); } });
  const base = await startPeer(context, client);
  const response = await fetch(`${base}/api/link/statuses`, {
    method: "POST",
    headers: { ...asHub, "content-type": "application/json" },
    body: JSON.stringify({ paneIds: [PANE] }),
  });
  const text = await response.text();
  assert.match(text, /event: error/u);
  assert.match(text, /herdr socket is unavailable/u);
  assert.ok(!text.includes("event: ready"));
});

test("refuses a status subscription that is not a list of pane ids", async (context) => {
  const base = await startPeer(context, fakePeer());
  for (const paneIds of [[], "pane", [""], [123], new Array(513).fill(PANE)]) {
    const response = await fetch(`${base}/api/link/statuses`, {
      method: "POST",
      headers: { ...asHub, "content-type": "application/json" },
      body: JSON.stringify({ paneIds }),
    });
    assert.equal(response.status, 400, JSON.stringify(paneIds).slice(0, 30));
  }
});

test("moves a session or a project through the PC's own Herdr, and hands back the moved ids", async (context) => {
  const moved = { tab_id: "wC:t2", panes: [{ from: PANE, to: "wC:p2" }], reordered: false };
  const client = fakePeer({
    async moveTab(id, index) { client.calls.push(["moveTab", id, index]); },
    async moveTabToWorkspace(id, workspace, index) { client.calls.push(["moveTabToWorkspace", id, workspace, index]); return moved; },
    async moveWorkspace(id, index) { client.calls.push(["moveWorkspace", id, index]); },
  });
  const base = await startPeer(context, client);
  const post = (path, body) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((response) => response.json());
  assert.deepEqual((await post("/api/link/tabs/wB%3At1/move", { insertIndex: 2 })).moved, { tab_id: "wB:t1", panes: [], reordered: true });
  assert.deepEqual(client.calls.at(-1), ["moveTab", "wB:t1", 2]);
  assert.deepEqual((await post("/api/link/tabs/wB%3At1/move", { workspaceId: "wC", insertIndex: 0 })).moved, moved);
  assert.deepEqual(client.calls.at(-1), ["moveTabToWorkspace", "wB:t1", "wC", 0]);
  await post("/api/link/workspaces/wB/move", { insertIndex: 1 });
  assert.deepEqual(client.calls.at(-1), ["moveWorkspace", "wB", 1]);
});

test("an unknown link path is not found", async (context) => {
  const base = await startPeer(context, fakePeer());
  const response = await fetch(`${base}/api/link/nonsense`, { headers: asHub });
  assert.equal(response.status, 404);
});
