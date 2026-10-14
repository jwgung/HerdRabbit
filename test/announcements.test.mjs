import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { announcementRegistry } from "../src/announcements.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PEER_ADDRESS_HEADER, PEER_LOGIN_HEADER } from "../src/peer-identity.mjs";

const OWNER = "owner@example.com";
const LEAF = "100.64.0.2";

function claim(overrides = {}) {
  return {
    from: LEAF,
    name: "dev-box",
    address: `http://${LEAF}:30001`,
    version: "1.4.0",
    protocol: 1,
    ...overrides,
  };
}

test("a machine may announce itself and nothing else", () => {
  // Without this one leaf could fill the dialog with rows pointing anywhere,
  // including at machines it has nothing to do with.
  const registry = announcementRegistry();
  assert.equal(registry.record(claim()).ok, true);
  assert.deepEqual(registry.list(), [{
    name: "dev-box", address: `http://${LEAF}:30001`, version: "1.4.0", protocol: 1,
  }]);

  assert.equal(registry.record(claim({ address: "http://100.64.0.9:30001" })).ok, false);
  assert.equal(registry.record(claim({ address: "not a url" })).ok, false);
  assert.equal(registry.record(claim({ address: "ftp://100.64.0.2:30001" })).ok, false);
  assert.equal(registry.size, 1);
});

test("keeps one row per address and holds on to it", () => {
  // What a machine said about itself does not stop being true because it went
  // quiet; a machine that is really gone falls out of the dialog anyway,
  // because every candidate is probed before it is offered.
  let now = 1_000;
  const registry = announcementRegistry({ now: () => now });
  registry.record(claim());
  registry.record(claim({ name: "renamed" }));
  assert.equal(registry.size, 1, "a second announcement replaces the first");
  assert.equal(registry.list()[0].name, "renamed");

  now += 60 * 60 * 1000;
  assert.equal(registry.size, 1, "and it is still there an hour later");
});

test("carries what it was told across a restart", () => {
  const saved = [];
  const first = announcementRegistry({ save: (entries) => saved.splice(0, saved.length, ...entries) });
  first.record(claim());
  assert.equal(saved.length, 1);

  const second = announcementRegistry({ initial: saved });
  assert.deepEqual(second.list(), first.list());
});

test("makes room for a new machine by dropping the quietest one", () => {
  // Nothing expires, so without this a decommissioned machine could keep a new
  // one out for good.
  let now = 0;
  const registry = announcementRegistry({ now: () => (now += 1) });
  for (let index = 0; index < 32; index += 1) {
    const host = `100.64.1.${index}`;
    registry.record(claim({ from: host, address: `http://${host}:30001` }));
  }
  const oldest = registry.list()[0].address;
  registry.record(claim({ from: "100.64.2.1", address: "http://100.64.2.1:30001" }));
  assert.equal(registry.size, 32);
  assert.ok(!registry.list().some((entry) => entry.address === oldest), "the quietest made way");
  assert.ok(registry.list().some((entry) => entry.address === "http://100.64.2.1:30001"));
});

test("refuses a name it would have to render", () => {
  const registry = announcementRegistry();
  assert.equal(registry.record(claim({ name: "" })).ok, false);
  assert.equal(registry.record(claim({ name: "a".repeat(81) })).ok, false);
  assert.equal(registry.record(claim({ name: 7 })).ok, false);
});

test("caps how many machines can be waiting to be added", () => {
  const registry = announcementRegistry();
  for (let index = 0; index < 40; index += 1) {
    const host = `100.64.1.${index}`;
    registry.record(claim({ from: host, address: `http://${host}:30001` }));
  }
  assert.equal(registry.size, 32);
});

async function hub(context, registry) {
  const created = createHerdrHttpServer({
    herdr: { async snapshot() { return {}; } },
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    announcements: Object.assign(registry, { ownerLogin: () => OWNER }),
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));
  return `http://127.0.0.1:${created.server.address().port}`;
}

const announce = (base, headers, body) => fetch(`${base}/api/announce`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body ?? { name: "dev-box", address: `http://${LEAF}:30001`, version: "1.4.0", link_protocol: 1 }),
});

test("the hub takes an announcement only from its own tailnet", async (context) => {
  const registry = announcementRegistry();
  const base = await hub(context, registry);

  // Both headers are written by Tailscale Serve, which is the only thing that
  // can reach this socket. Neither one alone says the caller is on the tailnet.
  assert.equal((await announce(base, {})).status, 403);
  assert.equal((await announce(base, { [PEER_LOGIN_HEADER]: OWNER })).status, 403);
  assert.equal((await announce(base, { [PEER_ADDRESS_HEADER]: LEAF })).status, 403);
  assert.equal((await announce(base, {
    [PEER_LOGIN_HEADER]: "someone@else", [PEER_ADDRESS_HEADER]: LEAF,
  })).status, 403);
  assert.equal(registry.size, 0);

  const accepted = await announce(base, { [PEER_LOGIN_HEADER]: OWNER, [PEER_ADDRESS_HEADER]: LEAF });
  assert.equal(accepted.status, 202);
  assert.equal(registry.size, 1);
});

test("the hub refuses an announcement that points somewhere else", async (context) => {
  const registry = announcementRegistry();
  const base = await hub(context, registry);
  const response = await announce(
    base,
    { [PEER_LOGIN_HEADER]: OWNER, [PEER_ADDRESS_HEADER]: LEAF },
    { name: "impostor", address: "http://100.64.0.9:30001", version: "1.4.0", link_protocol: 1 },
  );
  assert.equal(response.status, 400);
  assert.equal(registry.size, 0);
});

test("a hub without announcements enabled has no such route", async (context) => {
  const created = createHerdrHttpServer({
    herdr: { async snapshot() { return {}; } },
    csrfToken: "fixed-test-token",
    logger: { error() {} },
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));
  const base = `http://127.0.0.1:${created.server.address().port}`;
  assert.equal((await announce(base, { [PEER_LOGIN_HEADER]: OWNER, [PEER_ADDRESS_HEADER]: LEAF })).status, 404);
});

test("forgets an address a look proved is not there", () => {
  // Nothing expires here, so without this a machine that changed port would
  // leave its old row behind for good.
  const saved = [];
  const registry = announcementRegistry({ save: (entries) => saved.splice(0, saved.length, ...entries) });
  registry.record(claim());
  registry.record(claim({ from: "100.64.0.3", address: "http://100.64.0.3:30001" }));
  assert.equal(registry.size, 2);

  assert.equal(registry.forget([`http://${LEAF}:30001`, "http://100.64.9.9:1"]), 1);
  assert.deepEqual(registry.list().map((entry) => entry.address), ["http://100.64.0.3:30001"]);
  assert.equal(saved.length, 1, "the file is rewritten only when something went");
});
