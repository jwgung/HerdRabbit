import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { leafLinkRoutes } from "../src/link-server.mjs";
import { LeafLinkClient } from "../src/leaf-link-client.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";
import { InputValidationError } from "../src/herdr-client.mjs";
import { LINK_PROTOCOL } from "../src/leaf-protocol.mjs";

const HUB_VERSION = "1.2.0";
const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const SESSION = "hs_ZGVmYXVsdA";
const PANE = `${SESSION}~wB:p1`;

// The Connect PC port lets a caller in by its socket address. Here every PC
// is on loopback, so the hub is "127.0.0.1".
const hubFetch = () => globalThis.fetch;

async function startPeer(context, { link, allowed = ["127.0.0.1"] }) {
  const server = createPeerServer({ peer: new PeerIdentity({ addresses: allowed }), link, logger: { error() {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
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

async function startLeaf(context, { calls = [], version = HUB_VERSION, herdr, herdrVersion, protocol } = {}) {
  let link = leafLinkRoutes({ client: herdr ?? leafHerdr(calls), version, herdrVersion, serverName: "dev-box" });
  if (protocol !== undefined) {
    // A PC on another link protocol: the same routes, answering a different number.
    const routes = link;
    link = async (request, response, url, method) => {
      const json = response.end.bind(response);
      response.end = (body, ...rest) => {
        if (typeof body === "string" && body.includes('"link_protocol"')) {
          body = body.replace(/"link_protocol":\d+/u, `"link_protocol":${protocol}`);
          response.setHeader("Content-Length", Buffer.byteLength(body));
        }
        return json(body, ...rest);
      };
      return routes(request, response, url, method);
    };
  }
  return { address: await startPeer(context, { link }), calls };
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
    profiles: { list: () => [profile] },
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

test("a PC on another app version but the same link protocol connects, and says its version", async (context) => {
  const { address } = await startLeaf(context, { version: "9.9.9" });
  const { herdr } = hubFor(address);
  const snapshot = await settled(herdr);
  assert.equal(snapshot.servers[1].available, true);
  assert.equal(snapshot.servers[1].version, "9.9.9");
  assert.equal(snapshot.servers[1].link_protocol, LINK_PROTOCOL);
  assert.equal(snapshot.servers[0].version, null, "this PC's own version is what it was given");
  assert.deepEqual(snapshot.panes.map((pane) => pane.pane_id), [`${LINK_ID}!${PANE}`]);
});

test("a PC on another link protocol is shown offline with both sides' protocol and version", async (context) => {
  const { address } = await startLeaf(context, { version: "2.0.0", protocol: LINK_PROTOCOL + 1 });
  const { herdr } = hubFor(address);
  await herdr.snapshot();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await herdr.snapshot()).servers[1].status !== "Connecting") break;
  }
  const snapshot = await herdr.snapshot();
  const [, leaf] = snapshot.servers;
  assert.equal(leaf.available, false);
  assert.match(leaf.status, /HerdRabbit 2\.0\.0 with connection protocol 2/u);
  assert.match(leaf.status, new RegExp(`HerdRabbit ${HUB_VERSION.replaceAll(".", "\\.")}, protocol ${LINK_PROTOCOL}`, "u"));
  // Details shows what the other PC said even though it is offline.
  assert.deepEqual([leaf.version, leaf.link_protocol], ["2.0.0", LINK_PROTOCOL + 1]);
  assert.equal(snapshot.panes.length, 0, "an incompatible PC contributes nothing");
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

async function settledStatus(herdr) {
  await herdr.snapshot();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await herdr.snapshot()).servers[1].status !== "Connecting") break;
  }
  return (await herdr.snapshot()).servers[1].status;
}

test("a PC that does not allow this one says so instead of blaming SSH", async (context) => {
  const link = leafLinkRoutes({ client: leafHerdr([]), version: HUB_VERSION });
  const outside = await startPeer(context, { link, allowed: ["100.64.0.9"] });
  const status = await settledStatus(hubFor(outside).herdr);
  assert.match(status, /does not allow this PC/u);
  assert.ok(!status.includes("SSH"), "a connected PC has nothing to do with SSH access");
  const empty = await startPeer(context, { link, allowed: [] });
  assert.match(await settledStatus(hubFor(empty).herdr), /does not accept other PCs yet/u);
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

  const address = await startPeer(context, { link: leafLinkRoutes({ client: leafHerdr([]), files, version: HUB_VERSION }) });
  const client = new LeafLinkClient({
    profile: { name: "Dev box", transport: "link", address },
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

test("a file larger than this PC allows is refused before any byte is passed on", async (context) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "herdr-leaf-big-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "big.bin"), Buffer.alloc(64));
  const address = await startPeer(context, { link: leafLinkRoutes({ client: leafHerdr([]), version: HUB_VERSION }) });
  const client = new LeafLinkClient({ profile: { name: "Dev box", transport: "link", address }, hubVersion: HUB_VERSION });
  await assert.rejects(() => client.openFile(join(dir, "big.bin"), { maxBytes: 10 }), { status: 413, code: "file_too_large" });
  client.close();
});

test("sessions dragged on a connected PC move there, and the moved pane comes back under its prefix", async (context) => {
  const calls = [];
  const herdrWithMoves = {
    ...leafHerdr(calls),
    async moveTab(id, index) { calls.push(["moveTab", id, index]); },
    async moveWorkspace(id, index) { calls.push(["moveWorkspace", id, index]); },
    async moveTabToWorkspace(id, workspace, index) {
      calls.push(["moveTabToWorkspace", id, workspace, index]);
      return { tab_id: `${SESSION}~wC:t2`, panes: [{ from: PANE, to: `${SESSION}~wC:p2` }, { from: "x!y", to: "z" }] };
    },
  };
  const { address } = await startLeaf(context, { herdr: herdrWithMoves });
  const { herdr } = hubFor(address);
  await settled(herdr);
  await herdr.moveTab(`${LINK_ID}!${SESSION}~wB:t1`, 1);
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(["moveTab", `${SESSION}~wB:t1`, 1])));
  await herdr.moveWorkspace(`${LINK_ID}!${SESSION}~wB`, 0);
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(["moveWorkspace", `${SESSION}~wB`, 0])));
  const moved = await herdr.moveTabToWorkspace(`${LINK_ID}!${SESSION}~wB:t1`, `${LINK_ID}!${SESSION}~wC`, 0);
  assert.deepEqual(moved.panes, [{ from: `${LINK_ID}!${PANE}`, to: `${LINK_ID}!${SESSION}~wC:p2` }], "a forwarded id is dropped");
  assert.equal(moved.tab_id, `${LINK_ID}!${SESSION}~wC:t2`);
});

test("what a connected PC cannot do yet is refused with a reason, not a crash", async (context) => {
  const { address } = await startLeaf(context);
  const { herdr } = hubFor(address);
  await settled(herdr);
  await assert.rejects(() => herdr.terminalTarget(`${LINK_ID}!${PANE}`), { code: "attach_unsupported" });
  await assert.rejects(() => herdr.paneFind(`${LINK_ID}!${PANE}`, { query: "x" }), { code: "link_unsupported" });
  assert.equal(await herdr.paneProcessInfo(`${LINK_ID}!${PANE}`), null);
});

// A peer that has been allowed is still not trusted to stop talking: these
// stand in for one that sends forever, or sends its headers and then trickles.
function endlessBody(onCancel = () => {}) {
  return new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(256 * 1024).fill(32)); },
    cancel() { onCancel(); },
  });
}

function tricklingBody(signal) {
  return new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (signal?.aborted) { controller.error(signal.reason); return; }
      controller.enqueue(new TextEncoder().encode(" "));
    },
  });
}

// A PC on this link protocol: its hello answers, `fetchImpl` answers the rest.
const PEER_HELLO = { product: "herdrabbit", version: HUB_VERSION, link_protocol: LINK_PROTOCOL, scope: "local" };

function peerClient(fetchImpl, options = {}) {
  return new LeafLinkClient({
    profile: { name: "Dev box", transport: "link", address: "http://100.64.0.2:38788" },
    hubVersion: HUB_VERSION,
    fetchImpl: async (url, init) => new URL(url).pathname === "/api/link/hello"
      ? new Response(JSON.stringify(PEER_HELLO), { status: 200, headers: { "content-type": "application/json" } })
      : fetchImpl(url, init),
    timeouts: { read: 300, snapshot: 300, write: 300 },
    ...options,
  });
}

test("nothing is asked of a PC before its link protocol is known to match", async () => {
  const asked = [];
  const answer = (hello) => async (url) => {
    asked.push(new URL(url).pathname);
    if (new URL(url).pathname === "/api/link/hello") return new Response(JSON.stringify(hello), { status: 200 });
    return new Response(JSON.stringify({ output: "screen" }), { status: 200 });
  };
  // a PC on another protocol: the hello is all that is sent, the text never goes
  const other = new LeafLinkClient({ profile: { name: "Old box", transport: "link", address: "http://100.64.0.3:38788" }, hubVersion: HUB_VERSION,
    fetchImpl: answer({ product: "herdrabbit", version: "0.9.0", link_protocol: LINK_PROTOCOL + 1, scope: "local" }) });
  await assert.rejects(() => other.sendText("p1", "rm -rf /tmp/x", { submit: true }), { code: "leaf_protocol_mismatch" });
  assert.deepEqual(asked, ["/api/link/hello"]);
  // a matching PC is greeted once, then asked
  asked.length = 0;
  const same = new LeafLinkClient({ profile: { name: "Dev box", transport: "link", address: "http://100.64.0.2:38788" }, hubVersion: HUB_VERSION,
    fetchImpl: answer({ product: "herdrabbit", version: HUB_VERSION, link_protocol: LINK_PROTOCOL, scope: "local" }) });
  await same.readPane("p1");
  await same.readPane("p1");
  assert.deepEqual(asked, ["/api/link/hello", "/api/link/panes/p1/output", "/api/link/panes/p1/output"]);
});

test("a file that stops arriving after its headers fails instead of waiting for ever", async () => {
  const silent = new ReadableStream({ pull() { return new Promise(() => {}); } });
  const client = peerClient(async () => new Response(silent, { status: 200, headers: { "content-length": "100" } }), { timeouts: { read: 300, snapshot: 300, write: 300, fileIdle: 50 } });
  const opened = await client.openFile("/srv/stuck");
  await assert.rejects(async () => {
    for await (const chunk of opened.stream) void chunk;
  }, { code: "leaf_timeout" });
});

test("closing the merged client lets go of every connected PC, not this one", () => {
  const closed = [];
  const local = { snapshot: async () => ({}), close: () => closed.push("local") };
  const herdr = new MultiServerClient({
    local, hubVersion: HUB_VERSION,
    profiles: { list: () => [{ id: LINK_ID, name: "Dev box", transport: "link", address: "http://100.64.0.2:38788" }] },
  });
  herdr.syncEntries();
  for (const [id, entry] of herdr.entries) if (id !== "local") entry.client.close = () => closed.push(id);
  herdr.close();
  assert.deepEqual(closed, [LINK_ID]);
});

test("a reader that pauses is not taken for a PC that stopped sending", async () => {
  const chunks = Array.from({ length: 6 }, () => new Uint8Array(64 * 1024));
  const body = new ReadableStream({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); } });
  const client = peerClient(async () => new Response(body, { status: 200, headers: { "content-length": String(6 * 64 * 1024) } }), { timeouts: { read: 300, snapshot: 300, write: 300, fileIdle: 50 } });
  const opened = await client.openFile("/srv/big");
  let total = 0;
  for await (const chunk of opened.stream) {
    if (total === 0) await new Promise((resolve) => setTimeout(resolve, 200));
    total += chunk.length;
  }
  assert.equal(total, 6 * 64 * 1024);
});

test("a redirect from a connected PC is refused, never followed", async () => {
  const asked = [];
  const client = peerClient(async (url, init) => {
    asked.push(init?.redirect);
    return new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data" } });
  });
  await assert.rejects(() => client.listDirectory("/srv"), (error) => {
    assert.equal(error.code, "leaf_error");
    assert.match(error.message, /redirect/u);
    return true;
  });
  assert.deepEqual(asked, ["manual"]);
});

test("an answer that never ends is cut off at the hub's limit, not read to the end", async () => {
  let cancelled = 0;
  const client = peerClient(async () => new Response(endlessBody(() => { cancelled += 1; }), { status: 200 }));
  await assert.rejects(() => client.readPane("p1"), (error) => {
    assert.equal(error.code, "leaf_error");
    assert.match(error.message, /more than this hub will read/u);
    return true;
  });
  await assert.rejects(() => client.listDirectory("/srv"), /more than this hub will read/u);
  // A refusal is only ever a short JSON error.
  const failing = peerClient(async () => new Response(endlessBody(() => { cancelled += 1; }), { status: 500 }));
  await assert.rejects(() => failing.listDirectory("/srv"), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.code, "leaf_error");
    return true;
  });
  assert.equal(cancelled, 3);
});

test("an answer whose body trickles is given up on the same clock as its headers", async () => {
  const fetchImpl = async (url, { signal }) => new Response(tricklingBody(signal), { status: 200 });
  const client = peerClient(fetchImpl);
  const started = Date.now();
  await assert.rejects(() => client.snapshot(), (error) => {
    assert.equal(error.code, "leaf_timeout");
    return true;
  });
  await assert.rejects(() => client.listDirectory("/srv"), { code: "leaf_timeout" });
  await assert.rejects(() => client.directoryFingerprint("/srv"), { code: "leaf_timeout" });
  assert.ok(Date.now() - started < 3_000);
  client.close();
});

test("a file sent past this PC's transfer limit, or past what it declared, fails instead of ending whole", async () => {
  const readAll = async (stream) => {
    let total = 0;
    for await (const chunk of stream) total += chunk.length;
    return total;
  };
  // No length said, and no end.
  const unsized = peerClient(async () => new Response(endlessBody(), { status: 200 }), { maxTransferBytes: 1024 * 1024 });
  const opened = await unsized.openFile("/srv/endless");
  await assert.rejects(() => readAll(opened.stream), { code: "leaf_error" });
  const upload = await unsized.openUpload("endless.bin");
  await assert.rejects(() => readAll(upload.stream), { code: "leaf_error" });

  // A length said, and more sent.
  const liar = peerClient(async () => new Response(new TextEncoder().encode("0123456789abcdef"), {
    status: 200, headers: { "content-length": "4" },
  }));
  await assert.rejects(async () => readAll((await liar.openFile("/srv/short")).stream), { code: "leaf_error" });

  // An upload that says it is larger than this PC takes is refused up front.
  const large = peerClient(async () => new Response("x".repeat(64), { status: 200, headers: { "content-length": "64" } }), { maxTransferBytes: 10 });
  await assert.rejects(() => large.openUpload("big.bin"), { status: 413, code: "file_too_large" });

  // An honest file still arrives whole.
  const honest = peerClient(async () => new Response("hello", { status: 200, headers: { "content-length": "5" } }), { maxTransferBytes: 1024 });
  assert.equal(await readAll((await honest.openFile("/srv/hello")).stream), 5);
});

test("a file whose connection breaks part-way fails on the hub's side with that error", async () => {
  let sent = false;
  const broken = new ReadableStream({
    pull(controller) {
      if (sent) { controller.error(new Error("connection reset")); return; }
      sent = true;
      controller.enqueue(new TextEncoder().encode("partial"));
    },
  });
  const client = peerClient(async () => new Response(broken, { status: 200, headers: { "content-length": "100" } }));
  const opened = await client.openFile("/srv/dropped");
  await assert.rejects(async () => {
    for await (const chunk of opened.stream) void chunk;
  }, /connection reset/u);
});
