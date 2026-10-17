// A connected PC's pane attached for real: a hub's LinkClient against a
// real Connect PC port on loopback, with a fake pty on the PC that has the
// pane. No herdr and no node-pty run here.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { HerdrCommandError } from "../src/herdr-client.mjs";
import { LinkClient } from "../src/link-client.mjs";
import { linkAttachSockets, openRemotePty, routedSpawner } from "../src/link-attach.mjs";
import { linkRoutes } from "../src/link-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";

const VERSION = "1.2.71";
const SESSION = "hs_ZGVmYXVsdA";
const PANE = `${SESSION}~w1:p1`;

// The PC that has the pane: its own herdr lookup and a pty that plays the attach.
function fakePeer() {
  const spawns = [];
  const client = {
    async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; },
    async terminalTarget(paneId) {
      if (paneId !== PANE) throw new HerdrCommandError("Pane not found", { code: "pane_not_found" });
      return {
        command: "/usr/bin/herdr", args: ["terminal", "attach", "term_1"], env: { HERDR_SOCKET_PATH: "/run/herdr.sock" },
        terminalId: "term_1", cols: 100, rows: 30,
      };
    },
  };
  const spawnPty = (options) => {
    let resolveExit;
    const pty = {
      options, written: [], sizes: [], pauses: 0, resumes: 0, killed: false,
      exited: new Promise((resolve) => { resolveExit = resolve; }),
      write(data) { this.written.push(data); },
      resize(cols, rows) { this.sizes.push([cols, rows]); },
      pause() { this.pauses += 1; },
      resume() { this.resumes += 1; },
      kill() { if (!this.killed) { this.killed = true; resolveExit(); } },
      emit(data) { options.onData(data); },
      exit(code) { this.killed = true; resolveExit(); options.onExit(code); },
    };
    spawns.push(pty);
    return pty;
  };
  return { client, spawns, spawnPty };
}

async function startPeer(context, { allowed = ["127.0.0.1"], spawnPty, client, maxAttaches, withAttach = true } = {}) {
  const peer = fakePeer();
  const attach = withAttach ? linkAttachSockets({
    terminalTarget: (paneId, timeoutMs) => (client ?? peer.client).terminalTarget(paneId, timeoutMs),
    spawnPty: spawnPty === undefined ? peer.spawnPty : spawnPty,
    maxAttaches,
    log: () => {},
  }) : null;
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: allowed }),
    link: linkRoutes({ client: client ?? peer.client, attach, version: VERSION }),
    attach,
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { attach?.close(); server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...peer, attach, base, port: server.address().port };
}

function hubFor(base) {
  return new LinkClient({ profile: { id: "link_1", name: "desk", address: base }, hubVersion: VERSION });
}

async function until(check, what, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Opens the hub's remote pty and collects what it says.
function openFrom(target, options = {}) {
  const seen = { data: "", exit: undefined };
  const pty = target.remote.open({
    cols: 80, rows: 24, ...options,
    onData: (data) => { seen.data += data; },
    onExit: (code) => { seen.exit = code; },
  });
  return { pty, seen };
}

// An upgrade request as any client could send it, headers and all.
function upgrade(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, {
      headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers,
      },
    });
    req.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on("upgrade", (response, socket) => { socket.destroy(); resolve({ status: 101 }); });
    req.on("error", reject);
    req.end();
  });
}

const ATTACH = `/api/link/panes/${encodeURIComponent(PANE)}/attach?cols=80&rows=24`;

test("the hub learns which terminal a pane has, never how the PC runs it", async (context) => {
  const peer = await startPeer(context);
  const answer = await fetch(`${peer.base}/api/link/panes/${encodeURIComponent(PANE)}/terminal`);
  assert.deepEqual(await answer.json(), { terminal_id: "term_1", cols: 100, rows: 30 });
  const target = await hubFor(peer.base).terminalTarget(PANE);
  assert.equal(target.terminalId, "term_1");
  assert.equal(target.cols, 100);
  assert.equal(target.rows, 30);
  assert.equal(target.command, null);
  assert.deepEqual(target.args, []);
  assert.equal(typeof target.remote.open, "function");
  await assert.rejects(hubFor(peer.base).terminalTarget(`${SESSION}~w9:p9`), { code: "pane_not_found" });
});

test("bytes go both ways, a resize reaches the pty, and the pty's exit ends the hub's pty", async (context) => {
  const peer = await startPeer(context);
  const target = await hubFor(peer.base).terminalTarget(PANE);
  const { pty, seen } = openFrom(target);
  pty.resize(90, 33); // before the socket opens: sent once it does
  pty.write("ls\r");
  await until(() => peer.spawns.length === 1, "the attach to start on the PC");
  const far = peer.spawns[0];
  assert.equal(far.options.command, "/usr/bin/herdr");
  assert.deepEqual(far.options.args, ["terminal", "attach", "term_1"]);
  assert.deepEqual(far.options.env, { HERDR_SOCKET_PATH: "/run/herdr.sock" });
  assert.equal(far.options.cols, 80);
  assert.equal(far.options.rows, 24);
  await until(() => far.written.join("") === "ls\r" && far.sizes.length === 1, "queued typing and size");
  assert.deepEqual(far.sizes, [[90, 33]]);

  far.emit("héllo ✓ 世界\r\n");
  await until(() => seen.data === "héllo ✓ 世界\r\n", "output on the hub");
  pty.write("é");
  pty.resize(120, 40);
  await until(() => far.written.at(-1) === "é" && far.sizes.length === 2, "typing and resize");
  assert.deepEqual(far.sizes.at(-1), [120, 40]);

  far.emit("bye\r\n");
  far.exit(3);
  await pty.exited;
  assert.equal(seen.exit, 3);
  assert.ok(seen.data.endsWith("bye\r\n"), "the last words arrive before the exit");
  await until(() => peer.attach.open === 0, "the slot to be released");
});

test("a takeover asks the far attach to take the slot", async (context) => {
  const peer = await startPeer(context);
  const target = await hubFor(peer.base).terminalTarget(PANE);
  const { pty } = openFrom(target, { takeover: true });
  await until(() => peer.spawns.length === 1, "the attach");
  assert.deepEqual(peer.spawns[0].options.args, ["terminal", "attach", "term_1", "--takeover"]);
  pty.kill();
  await pty.exited;
});

test("closing the hub's pty kills the far one, and so does the hub dropping its link", async (context) => {
  const peer = await startPeer(context);
  const hub = hubFor(peer.base);
  const target = await hub.terminalTarget(PANE);
  const first = openFrom(target);
  await until(() => peer.spawns.length === 1, "the attach");
  first.pty.kill();
  await first.pty.exited;
  assert.equal(first.seen.exit, null);
  await until(() => peer.spawns[0].killed, "the far pty to be killed");

  const second = openFrom(target);
  await until(() => peer.spawns.length === 2, "the second attach");
  hub.close();
  await second.pty.exited;
  await until(() => peer.spawns[1].killed, "the far pty to be killed on close");
});

test("a hub that stops reading pauses the far pty, and reading again resumes it", async (context) => {
  const peer = await startPeer(context);
  const target = await hubFor(peer.base).terminalTarget(PANE);
  const { pty, seen } = openFrom(target);
  await until(() => peer.spawns.length === 1, "the attach");
  const far = peer.spawns[0];
  far.emit("start\r\n");
  await until(() => seen.data === "start\r\n", "first output");
  pty.pause();
  const chunk = "x".repeat(64 * 1024);
  // Enough to fill loopback's socket buffers and then the sender's queue.
  for (let index = 0; index < 512 && far.pauses === 0; index += 1) {
    far.emit(chunk);
    if (index % 16 === 15) await sleep(5);
  }
  assert.ok(far.pauses > 0, "the far pty was paused");
  pty.resume();
  await until(() => far.resumes > 0, "the far pty to resume", 10_000);
  pty.kill();
  await pty.exited;
});

test("an attach is refused before the upgrade by the same checks as any request, and spawns nothing", async (context) => {
  const peer = await startPeer(context);
  const host = { Host: `127.0.0.1:${peer.port}` };
  assert.equal((await upgrade(peer.base, ATTACH)).status, 101, "the right request is upgraded");
  await until(() => peer.spawns.length === 1, "the allowed attach");
  const before = peer.spawns.length;
  const cases = [
    [{ Host: `evil.example:${peer.port}` }, ATTACH, 421, "wrong_host"],
    [{ ...host, Origin: peer.base }, ATTACH, 403, "browser_refused"],
    [{ ...host, "Sec-Fetch-Site": "cross-site" }, ATTACH, 403, "browser_refused"],
    [{ ...host, "Sec-Fetch-Dest": "websocket" }, ATTACH, 403, "browser_refused"],
    [host, "/api/terminal", 404, "not_found"],
    [host, "/api/link/hello", 404, "not_found"],
    [host, `/api/link/panes/${encodeURIComponent(`${SESSION}~w9:p9`)}/attach`, 502, "pane_not_found"],
    [host, `/api/link/panes/${encodeURIComponent(PANE)}/attach?cols=0&rows=24`, 400, "invalid_input"],
    [host, `/api/link/panes/${encodeURIComponent(PANE)}/attach?cols=80&rows=1e3`, 400, "invalid_input"],
  ];
  for (const [headers, path, status, code] of cases) {
    const answer = await upgrade(peer.base, path, headers);
    assert.equal(answer.status, status, `${path} ${JSON.stringify(headers)}`);
    assert.equal(answer.body.error.code, code, `${path} ${JSON.stringify(headers)}`);
  }
  assert.equal(peer.spawns.length, before);

  const stranger = await startPeer(context, { allowed: ["100.64.0.9"] });
  const refused = await upgrade(stranger.base, ATTACH);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "peer_address_rejected");
  assert.equal(stranger.spawns.length, 0);

  const nobody = await startPeer(context, { allowed: [] });
  assert.equal((await upgrade(nobody.base, ATTACH)).status, 403);
  assert.equal(nobody.spawns.length, 0);

  const without = await startPeer(context, { withAttach: false });
  assert.equal((await upgrade(without.base, ATTACH)).status, 404);
});

test("a PC without node-pty refuses as attach_unsupported, and so does one from before attaching", async (context) => {
  const noPty = await startPeer(context, { spawnPty: null });
  const answer = await upgrade(noPty.base, ATTACH);
  assert.equal(answer.status, 501);
  assert.equal(answer.body.error.code, "attach_unsupported");
  await assert.rejects(hubFor(noPty.base).terminalTarget(PANE), { code: "attach_unsupported" });

  // An older PC has no terminal route at all: its 404 means "mirror it".
  const routes = linkRoutes({ client: fakePeer().client, version: VERSION });
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: async (request, response, url, method) => (url.pathname.endsWith("/terminal") ? false : routes(request, response, url, method)),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(hubFor(`http://127.0.0.1:${server.address().port}`).terminalTarget(PANE), { code: "attach_unsupported" });
});

test("attaches beyond the limit are refused until one closes", async (context) => {
  const peer = await startPeer(context, { maxAttaches: 1 });
  const target = await hubFor(peer.base).terminalTarget(PANE);
  const first = openFrom(target);
  await until(() => peer.spawns.length === 1, "the first attach");
  const busy = await upgrade(peer.base, ATTACH);
  assert.equal(busy.status, 429);
  assert.equal(busy.body.error.code, "too_many_attachments");
  first.pty.kill();
  await until(() => peer.attach.open === 0, "the slot to be released");
  const second = openFrom(target);
  await until(() => peer.spawns.length === 2, "the second attach");
  second.pty.kill();
  await second.pty.exited;
});

test("a handshake the socket library will not take gives its slot back", async (context) => {
  const peer = await startPeer(context, { maxAttaches: 1 });
  const statusOf = (headers) => new Promise((resolve, reject) => {
    const req = request(`${peer.base}${ATTACH}`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", ...headers } });
    req.on("response", (response) => { response.resume(); resolve(response.statusCode); });
    req.on("upgrade", (response, socket) => { socket.destroy(); resolve(101); });
    req.on("error", () => resolve(null));
    req.end();
  });
  for (let index = 0; index < 3; index += 1) {
    assert.notEqual(await statusOf({ "Sec-WebSocket-Key": "abc" }), 101);
    assert.notEqual(await statusOf({ "Sec-WebSocket-Version": "7", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" }), 101);
  }
  assert.equal(peer.attach.open, 0, "a slot was kept by a refused handshake");
  assert.equal(peer.spawns.length, 0);
  assert.equal((await upgrade(peer.base, ATTACH)).status, 101, "a good attach still gets the one slot");
});

test("an attach still being looked up when this PC stops spawns nothing", async (context) => {
  const base = fakePeer();
  let answer;
  const slow = { ...base.client, terminalTarget: (paneId, timeoutMs) => new Promise((resolve, reject) => {
    answer = () => base.client.terminalTarget(paneId, timeoutMs).then(resolve, reject);
  }) };
  const peer = await startPeer(context, { client: slow });
  const asked = upgrade(peer.base, ATTACH).catch(() => ({ status: null }));
  await until(() => answer, "the look-up to start");
  peer.attach.close();
  answer();
  const result = await asked;
  assert.notEqual(result.status, 101, "upgraded after close()");
  assert.equal(peer.spawns.length, 0);
  assert.equal(peer.attach.open, 0);
  // and nothing new is taken once stopped
  const late = await upgrade(peer.base, ATTACH).catch(() => ({ status: null }));
  assert.notEqual(late.status, 101);
  assert.equal(peer.spawns.length, 0);
});

test("a refused or unreachable attach ends the hub's pty without output", async (context) => {
  const peer = await startPeer(context, { allowed: ["100.64.0.9"] });
  const seen = { data: "", exit: undefined };
  const pty = openRemotePty({
    url: `${peer.base.replace("http", "ws")}${ATTACH}`,
    onData: (data) => { seen.data += data; },
    onExit: (code) => { seen.exit = code; },
  });
  await pty.exited;
  assert.equal(seen.exit, null);
  assert.equal(seen.data, "");
  pty.write("ignored");
  pty.kill();
});

test("the spawner opens a connected PC's target there and refuses a local one without node-pty", () => {
  const opened = [];
  const spawn = routedSpawner(null);
  const remote = { open: (options) => { opened.push(options); return { remote: true }; } };
  assert.deepEqual(spawn({ remote, cols: 80, rows: 24, takeover: true }), { remote: true });
  assert.deepEqual(opened, [{ cols: 80, rows: 24, takeover: true }]);
  assert.throws(() => spawn({ command: "herdr", args: [] }), { code: "attach_unsupported" });
  const local = [];
  routedSpawner((options) => { local.push(options); return {}; })({ command: "herdr", args: ["x"], remote: undefined });
  assert.deepEqual(local, [{ command: "herdr", args: ["x"] }]);
});

test("PaneAttachments attaches a connected PC's pane through the link, unchanged", async (context) => {
  const peer = await startPeer(context);
  const hub = hubFor(peer.base);
  const attachments = new PaneAttachments({
    resolveTerminal: (paneId, timeoutMs) => hub.terminalTarget(paneId, timeoutMs),
    spawnPty: routedSpawner(null),
    log: () => {},
    options: { holdMs: 5, relookupMs: 5, relookupForMs: 100, refusalExitMs: 50 },
  });
  context.after(() => attachments.close());
  const viewer = {
    mode: "interact", closed: false, messages: [],
    send(message) { this.messages.push(message); },
    bufferedAmount() { return 0; },
    close() { this.closed = true; },
  };
  await attachments.attach(viewer, PANE, { cols: 80, rows: 24 });
  await until(() => peer.spawns.length === 1, "the far attach");
  const far = peer.spawns[0];
  far.emit("\x1b[H\x1b[2Jdesk attached\r\n$ ");
  await until(() => viewer.messages.some((message) => message.type === "input-ready"), "input-ready");
  const output = viewer.messages.filter((message) => message.type === "pty-data").map((message) => message.data).join("");
  assert.match(output, /desk attached/u);
  assert.equal(attachments.input(viewer, PANE, "echo hi\r"), true);
  await until(() => far.written.join("") === "echo hi\r", "typing on the PC");
  far.exit(0);
  await until(() => viewer.messages.some((message) => message.type === "pty-exit"), "pty-exit after the far attach ends");
});
