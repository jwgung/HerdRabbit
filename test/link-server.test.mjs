import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { leafLinkRoutes } from "../src/link-server.mjs";
import { LINK_PROTOCOL } from "../src/leaf-protocol.mjs";
import { PEER_ADDRESS_HEADER, PEER_LOGIN_HEADER, PeerIdentity } from "../src/peer-identity.mjs";

const OWNER = "owner@example.com";
const HUB = "100.101.171.95";
const asHub = { [PEER_LOGIN_HEADER]: OWNER, [PEER_ADDRESS_HEADER]: HUB };
const PANE = "hs_ZGVmYXVsdA~wB:p1";

function fakeLeaf(overrides = {}) {
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

async function startLeaf(context, client, version = "1.2.0") {
  const created = createHerdrHttpServer({
    herdr: { async snapshot() { return {}; } },
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    peer: new PeerIdentity({ logins: [OWNER], addresses: [HUB] }),
    link: leafLinkRoutes({ client, version, serverName: "dev-box" }),
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));
  return `http://127.0.0.1:${created.server.address().port}`;
}

test("announces what it is and what it will report", async (context) => {
  const base = await startLeaf(context, fakeLeaf());
  const hello = await (await fetch(`${base}/api/link/hello`, { headers: asHub })).json();
  assert.deepEqual(hello, {
    product: "herdrabbit",
    version: "1.2.0",
    link_protocol: LINK_PROTOCOL,
    scope: "local",
    server_name: "dev-box",
    herdr_version: null,
  });
});

test("carries the handshake with every snapshot", async (context) => {
  // The hub re-checks compatibility on each poll; riding along saves a trip
  // and catches a leaf that was updated underneath us.
  const base = await startLeaf(context, fakeLeaf());
  const body = await (await fetch(`${base}/api/link/snapshot`, { headers: asHub })).json();
  assert.equal(body.hello.product, "herdrabbit");
  assert.equal(body.snapshot.panes[0].pane_id, PANE);
});

test("reads a pane as plain text, not as a revision window", async (context) => {
  // The hub's own watcher does the diffing, so it needs what a local read
  // would have returned.
  const client = fakeLeaf();
  const base = await startLeaf(context, client);
  const url = `${base}/api/link/panes/${encodeURIComponent(PANE)}/output?lines=40&format=ansi`;
  const body = await (await fetch(url, { headers: asHub })).json();
  assert.deepEqual(body, { output: "pane text" });
  assert.deepEqual(client.calls.at(-1), ["readPane", PANE, { lines: 40, format: "ansi" }]);
});

test("passes input through with the same validation the browser API uses", async (context) => {
  const client = fakeLeaf();
  const base = await startLeaf(context, client);
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
  const client = fakeLeaf({
    watchStatuses: async (paneIds, onStatus) => {
      assert.deepEqual(paneIds, [PANE]);
      emit = onStatus;
      return () => { stopped += 1; };
    },
  });
  const base = await startLeaf(context, client);
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
  const client = fakeLeaf({ watchStatuses: async () => { throw new Error("herdr socket is unavailable"); } });
  const base = await startLeaf(context, client);
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
  const base = await startLeaf(context, fakeLeaf());
  for (const paneIds of [[], "pane", [""], [123], new Array(513).fill(PANE)]) {
    const response = await fetch(`${base}/api/link/statuses`, {
      method: "POST",
      headers: { ...asHub, "content-type": "application/json" },
      body: JSON.stringify({ paneIds }),
    });
    assert.equal(response.status, 400, JSON.stringify(paneIds).slice(0, 30));
  }
});

test("an unknown link path is not found", async (context) => {
  const base = await startLeaf(context, fakeLeaf());
  const response = await fetch(`${base}/api/link/nonsense`, { headers: asHub });
  assert.equal(response.status, 404);
});
