import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { leafLinkRoutes } from "../src/link-server.mjs";
import { LeafLinkClient } from "../src/leaf-link-client.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { PEER_LOGIN_HEADER, PeerIdentity } from "../src/peer-identity.mjs";
import { InputValidationError } from "../src/herdr-client.mjs";

const OWNER = "owner@example.com";
const HUB_VERSION = "1.2.0";
const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const SESSION = "hs_ZGVmYXVsdA";
const PANE = `${SESSION}~wB:p1`;

// The peer headers are added by Tailscale Serve in production. Here the client
// talks straight to the leaf, so the test supplies them.
function hubFetch(fetchImpl = globalThis.fetch) {
  return (url, options = {}) => fetchImpl(url, {
    ...options,
    headers: { ...options.headers, [PEER_LOGIN_HEADER]: OWNER },
  });
}

function leafHerdr(calls, snapshotOverrides = {}) {
  return {
    async snapshot() {
      calls.push(["snapshot"]);
      return {
        focused_pane_id: PANE,
        herdr_sessions: [{ session_id: SESSION, name: "default", running: true, available: true }],
        workspaces: [{ workspace_id: `${SESSION}~wB`, label: "ship it!", herdr_session_id: SESSION }],
        tabs: [], agents: [],
        panes: [{ pane_id: PANE, workspace_id: `${SESSION}~wB` }],
        ...snapshotOverrides,
      };
    },
    async readPane(id) { calls.push(["readPane", id]); return "remote output"; },
    async sendText(id, text, options) { calls.push(["sendText", id, text, options]); },
    async sendKeys(id, keys) { calls.push(["sendKeys", id, keys]); },
    async createWorkspace(label, sessionId) { calls.push(["createWorkspace", label, sessionId]); },
    async renameWorkspace(id, label) { calls.push(["renameWorkspace", id, label]); },
    async closeWorkspace(id) { calls.push(["closeWorkspace", id]); },
    async createTab(id) { calls.push(["createTab", id]); },
    async renameTab(id, label) { calls.push(["renameTab", id, label]); },
    async closeTab(id) { calls.push(["closeTab", id]); },
  };
}

async function startLeaf(context, { calls = [], version = HUB_VERSION, herdr, herdrVersion } = {}) {
  const created = createHerdrHttpServer({
    herdr: { async snapshot() { return {}; } },
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    peer: new PeerIdentity({ logins: [OWNER] }),
    link: leafLinkRoutes({ client: herdr ?? leafHerdr(calls), version, herdrVersion, serverName: "dev-box" }),
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));
  return { address: `http://127.0.0.1:${created.server.address().port}`, calls };
}

function hubFor(address, { name = "Dev box" } = {}) {
  const profile = { id: LINK_ID, name, transport: "link", address };
  const localCalls = [];
  const local = {
    async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; },
    async readPane() { localCalls.push("readPane"); return "local"; },
  };
  const herdr = new MultiServerClient({
    local,
    profiles: { list: () => [profile], connectionProfiles: () => [profile] },
    remoteFactory: (item) => new LeafLinkClient({
      profile: item, hubVersion: HUB_VERSION, fetchImpl: hubFetch(),
    }),
  });
  return { herdr, localCalls };
}

async function settled(herdr) {
  await herdr.snapshot();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const snapshot = await herdr.snapshot();
    if (snapshot.servers[1].available) return snapshot;
  }
  return herdr.snapshot();
}

test("a linked leaf appears in the merged snapshot under its own prefix", async (context) => {
  const { address, calls } = await startLeaf(context);
  const { herdr } = hubFor(address);
  const snapshot = await settled(herdr);

  assert.equal(snapshot.servers[1].transport, "link");
  assert.equal(snapshot.servers[1].status, "Connected");
  assert.deepEqual(snapshot.panes.map((pane) => pane.pane_id), [`${LINK_ID}!${PANE}`]);
  assert.equal(snapshot.workspaces[0].label, "ship it!", "a label is not an id and keeps its punctuation");
  assert.equal(snapshot.panes[0].server_name, "Dev box");
  assert.ok(calls.some(([name]) => name === "snapshot"));
});

test("a linked leaf reports its Herdr version, and an older leaf reports none", async (context) => {
  const current = await startLeaf(context, { herdrVersion: () => "0.8.2" });
  const { servers: [, leaf] } = await settled(hubFor(current.address).herdr);
  assert.deepEqual([leaf.herdr_version, leaf.herdr_supported], ["0.8.2", false]);
  const older = await startLeaf(context);
  const { servers: [, silent] } = await settled(hubFor(older.address).herdr);
  assert.deepEqual([silent.herdr_version, silent.herdr_supported], [null, null]);
});

test("commands reach the leaf with the prefix taken off again", async (context) => {
  const { address, calls } = await startLeaf(context);
  const { herdr, localCalls } = hubFor(address);
  await settled(herdr);

  assert.equal(await herdr.readPane(`${LINK_ID}!${PANE}`, { lines: 40 }), "remote output");
  assert.deepEqual(calls.at(-1), ["readPane", PANE]);
  await herdr.sendText(`${LINK_ID}!${PANE}`, "hello", { submit: true });
  assert.deepEqual(calls.at(-1), ["sendText", PANE, "hello", { submit: true }]);
  await herdr.sendKeys(`${LINK_ID}!${PANE}`, ["enter"]);
  assert.deepEqual(calls.at(-1), ["sendKeys", PANE, ["enter"]]);
  assert.equal(localCalls.length, 0, "nothing was routed to the local machine");
});

test("a leaf on another version is shown offline with the reason", async (context) => {
  const { address } = await startLeaf(context, { version: "9.9.9" });
  const { herdr } = hubFor(address);
  await herdr.snapshot();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await herdr.snapshot()).servers[1].status !== "Connecting") break;
  }
  const snapshot = await herdr.snapshot();
  assert.equal(snapshot.servers[1].available, false);
  assert.match(snapshot.servers[1].status, /9\.9\.9/u);
  assert.match(snapshot.servers[1].status, /1\.2\.0/u);
  assert.equal(snapshot.panes.length, 0, "an incompatible leaf contributes nothing");
});

test("records a leaf should not be reporting are dropped", async (context) => {
  // The leaf declares scope "local" and the hub still filters, because a
  // declaration is easy to get wrong and a silent forwarded record would carry
  // an id this hub cannot route.
  const calls = [];
  const herdrWithStrays = leafHerdr(calls, {
    panes: [
      { pane_id: PANE },
      { pane_id: "ssh_22222222-2222-2222-2222-222222222222!wC:p1" },
      { pane_id: "wD:p1", server_id: "ssh_22222222-2222-2222-2222-222222222222" },
    ],
  });
  const { address } = await startLeaf(context, { herdr: herdrWithStrays });
  const { herdr } = hubFor(address);
  const snapshot = await settled(herdr);
  assert.deepEqual(snapshot.panes.map((pane) => pane.pane_id), [`${LINK_ID}!${PANE}`]);
});

test("a leaf that refuses this hub says so instead of blaming SSH", async (context) => {
  const created = createHerdrHttpServer({
    herdr: { async snapshot() { return {}; } },
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    peer: new PeerIdentity({ logins: ["someone@else"] }),
    link: leafLinkRoutes({ client: leafHerdr([]), version: HUB_VERSION }),
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));

  const { herdr } = hubFor(`http://127.0.0.1:${created.server.address().port}`);
  await herdr.snapshot();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await herdr.snapshot()).servers[1].status !== "Connecting") break;
  }
  const status = (await herdr.snapshot()).servers[1].status;
  assert.match(status, /did not accept this hub/u);
  assert.ok(!status.includes("SSH"), "a linked server has nothing to do with SSH access");
});

test("project and tab changes reach the leaf with the prefix taken off", async (context) => {
  const { address, calls } = await startLeaf(context);
  const { herdr } = hubFor(address);
  await settled(herdr);

  // A mutation is followed by a refresh, so the call under test is not the last
  // one the leaf saw.
  const sawCall = (expected) => assert.ok(
    calls.some((call) => JSON.stringify(call) === JSON.stringify(expected)),
    `${expected[0]} reached the leaf as ${JSON.stringify(expected)}`,
  );

  await herdr.createWorkspace("New project", `${LINK_ID}!${SESSION}`);
  sawCall(["createWorkspace", "New project", SESSION]);
  await herdr.renameWorkspace(`${LINK_ID}!${SESSION}~wB`, "Renamed");
  sawCall(["renameWorkspace", `${SESSION}~wB`, "Renamed"]);
  await herdr.createTab(`${LINK_ID}!${SESSION}~wB`);
  sawCall(["createTab", `${SESSION}~wB`]);
  await herdr.renameTab(`${LINK_ID}!${SESSION}~wB:t1`, "Deploy check");
  sawCall(["renameTab", `${SESSION}~wB:t1`, "Deploy check"]);
  await herdr.closeTab(`${LINK_ID}!${SESSION}~wB:t1`);
  sawCall(["closeTab", `${SESSION}~wB:t1`]);
  await herdr.closeWorkspace(`${LINK_ID}!${SESSION}~wB`);
  sawCall(["closeWorkspace", `${SESSION}~wB`]);
});

test("a change the leaf refuses arrives as the leaf's own complaint", async (context) => {
  // The rules live on the machine that owns the session, so a bad label has to
  // come back saying so rather than as a generic link failure.
  const calls = [];
  const strict = {
    ...leafHerdr(calls),
    async renameWorkspace() { throw new InputValidationError("Enter a project name."); },
  };
  const { address } = await startLeaf(context, { herdr: strict });
  const { herdr } = hubFor(address);
  await settled(herdr);
  await assert.rejects(() => herdr.renameWorkspace(`${LINK_ID}!${SESSION}~wB`, ""), /Enter a project name/u);
});

test("a leaf answers for its own files, and the hub never reads a disk", async (context) => {
  // The point of moving browsing onto the link: each machine uses the same
  // local browser a person opening it directly would get. Nothing on the hub
  // knows how to read another machine's filesystem.
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Readable } = await import("node:stream");
  const { FileStore } = await import("../src/file-store.mjs");

  const dir = await mkdtemp(join(tmpdir(), "herdr-leaf-files-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "notes.txt"), "leaf side");
  const uploads = await mkdtemp(join(tmpdir(), "herdr-leaf-uploads-"));
  context.after(() => rm(uploads, { recursive: true, force: true }));
  const files = await FileStore.load(uploads);

  const created = createHerdrHttpServer({
    herdr: { async snapshot() { return {}; } },
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    peer: new PeerIdentity({ logins: [OWNER] }),
    link: leafLinkRoutes({ client: leafHerdr([]), files, version: HUB_VERSION }),
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));
  const client = new LeafLinkClient({
    profile: { name: "Dev box", transport: "link", address: `http://127.0.0.1:${created.server.address().port}` },
    hubVersion: HUB_VERSION,
    fetchImpl: hubFetch(),
  });

  const listing = await client.listDirectory(dir);
  assert.equal(listing.path, dir);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["notes.txt"]);

  const opened = await client.openFile(join(dir, "notes.txt"));
  assert.equal(opened.name, "notes.txt");
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "leaf side", "bytes survive the link");

  assert.equal(await client.uploadsDirectory(), uploads);
  const saved = await client.saveUpload("보고서.txt", Readable.from([Buffer.from("uploaded")]), { bytes: 8 });
  assert.equal(saved.name, "보고서.txt", "a name keeps its own alphabet");
  assert.equal(await readFile(join(uploads, saved.name), "utf8"), "uploaded");
  assert.deepEqual((await client.listUploads()).map((file) => file.name), ["보고서.txt"]);

  await client.removeUpload(saved.name);
  assert.deepEqual(await client.listUploads(), []);
  client.close();
});

test("a folder the leaf will not open is refused with its own reason", async (context) => {
  const { address } = await startLeaf(context);
  const client = new LeafLinkClient({
    profile: { name: "Dev box", transport: "link", address },
    hubVersion: HUB_VERSION,
    fetchImpl: hubFetch(),
  });
  // The leaf decided this, so the status is its status rather than a generic
  // link failure that tells the person nothing.
  await assert.rejects(() => client.listDirectory("/definitely/not/here"), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
  client.close();
});
