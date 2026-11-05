import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectPcAccess, peerEnvText } from "../src/connect-pc-access.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { ENV_TEMPLATE, parseEnvFile } from "../src/plugin-runner.mjs";

const TAILNET = {
  available: true,
  self: { name: "mini", fullName: "mini.t.ts.net", address: "100.96.0.2", login: "me@example.com" },
  peers: [
    { name: "laptop", fullName: "laptop.t.ts.net", address: "100.101.0.3", online: true },
    { name: "phone", fullName: "phone.t.ts.net", address: "100.110.0.4", online: false },
  ],
};

async function world(context, { env = `HERDR_WEB_HOST=127.0.0.1\nHERDR_WEB_PORT=38787\n${ENV_TEMPLATE}`, current = {}, tailnet = TAILNET, canListen = async () => null } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "connect-pc-access-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const envFile = join(folder, ".env");
  if (env !== null) await writeFile(envFile, env, { mode: 0o600 });
  let restarts = 0;
  const access = new ConnectPcAccess({
    envFile,
    pagePort: 38787,
    current: { host: null, port: 38788, addresses: [], logins: [], ...current },
    readTailnet: async () => tailnet,
    canListen,
    // As after a real restart, the next save is a new server's.
    restart: async () => { restarts += 1; access.saving = false; },
  });
  return { access, envFile, restarts: () => restarts };
}

test("says whether the port is open, to whom, and offers this PC's tailnet devices", async (context) => {
  const { access } = await world(context, { current: { host: "100.96.0.2", addresses: ["100.101.0.3"] } });
  const state = await access.state();
  assert.equal(state.supported, true);
  assert.equal(state.open, true);
  assert.equal(state.address, "http://100.96.0.2:38788");
  assert.deepEqual(state.self, { name: "mini", address: "100.96.0.2" });
  assert.deepEqual(state.peers.map((peer) => [peer.name, peer.address, peer.online, peer.allowed]), [
    ["laptop", "100.101.0.3", true, true],
    ["phone", "100.110.0.4", false, false],
  ]);
});

test("opening writes this PC's tailnet address and the PCs chosen into .env, keeping the rest, then restarts", async (context) => {
  const { access, envFile, restarts } = await world(context);
  const saved = await access.save({ open: true, addresses: ["100.101.0.3"] });
  assert.equal(saved.restarting, true);
  const text = await readFile(envFile, "utf8");
  const values = parseEnvFile(text);
  assert.equal(values.HERDR_WEB_PEER_HOST, "100.96.0.2");
  assert.equal(values.HERDR_WEB_PEER_ADDRESSES, "100.101.0.3");
  assert.equal(values.HERDR_WEB_PORT, "38787", "other settings stay");
  assert.match(text, /# HERDR_WEB_MAX_TRANSFER_MB=512/u, "comments stay");
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  assert.equal(restarts(), 1);
});

test("a second save replaces the lines, closing removes them, and hand-set logins stay", async (context) => {
  const env = `HERDR_WEB_PORT=38787\nHERDR_WEB_PEER_HOST=100.96.0.2\nexport HERDR_WEB_PEER_ADDRESSES="100.101.0.9"\nHERDR_WEB_PEER_LOGINS=me@example.com\n`;
  const { access, envFile } = await world(context, { env });
  await access.save({ open: true, addresses: ["100.101.0.3", "100.110.0.4"] });
  let values = parseEnvFile(await readFile(envFile, "utf8"));
  assert.equal(values.HERDR_WEB_PEER_ADDRESSES, "100.101.0.3,100.110.0.4");
  assert.equal(values.HERDR_WEB_PEER_LOGINS, "me@example.com");
  assert.equal((await readFile(envFile, "utf8")).match(/HERDR_WEB_PEER_ADDRESSES=/gu).length, 1);
  await access.save({ open: false });
  const text = await readFile(envFile, "utf8");
  values = parseEnvFile(text);
  assert.equal(values.HERDR_WEB_PEER_HOST, undefined);
  assert.equal(values.HERDR_WEB_PEER_ADDRESSES, undefined);
  assert.equal(values.HERDR_WEB_PEER_LOGINS, "me@example.com");
  assert.equal(values.HERDR_WEB_PORT, "38787");
});

test("only devices of this tailnet may be allowed, and nothing is written for a refusal", async (context) => {
  const { access, envFile, restarts } = await world(context);
  const before = await readFile(envFile, "utf8");
  for (const addresses of [["100.64.9.9"], ["8.8.8.8"], ["100.101.0.3,100.110.0.4"], "100.101.0.3", [7], Array.from({ length: 40 }, () => "100.101.0.3")]) {
    await assert.rejects(access.save({ open: true, addresses }), { status: 400 }, JSON.stringify(addresses));
  }
  await assert.rejects(access.save({ open: "yes" }), { status: 400 });
  assert.equal(await readFile(envFile, "utf8"), before);
  assert.equal(restarts(), 0);
});

test("without Tailscale, outside the plugin, or with the page on the peer port, it says so and writes nothing", async (context) => {
  const off = await world(context, { tailnet: { available: false, self: null, peers: [] } });
  await assert.rejects(off.access.save({ open: true, addresses: [] }), { status: 409, code: "tailscale_unavailable" });
  assert.equal((await off.access.state()).tailnet, false);

  const clash = await world(context);
  clash.access.pagePort = 38788;
  await assert.rejects(clash.access.save({ open: true, addresses: ["100.101.0.3"] }), { status: 409, code: "connect_pc_port_taken" });

  const service = new ConnectPcAccess({ envFile: null, pagePort: 38787, current: { host: null, port: 38788, addresses: [], logins: [] }, readTailnet: async () => TAILNET, restart: async () => {} });
  assert.equal((await service.state()).supported, false);
  await assert.rejects(service.save({ open: true, addresses: [] }), { status: 409, code: "connect_pc_not_plugin" });
});

test("a missing .env is made from the template; a linked .env is refused", async (context) => {
  const fresh = await world(context, { env: null });
  await fresh.access.save({ open: true, addresses: ["100.101.0.3"] });
  const text = await readFile(fresh.envFile, "utf8");
  assert.match(text, /^# HerdRabbit settings for the Herdr plugin\./mu);
  assert.equal(parseEnvFile(text).HERDR_WEB_PEER_HOST, "100.96.0.2");

  const linked = await world(context);
  await rm(linked.envFile);
  await writeFile(`${linked.envFile}.real`, "HERDR_WEB_PORT=38787\n");
  await symlink(`${linked.envFile}.real`, linked.envFile);
  await assert.rejects(linked.access.save({ open: true, addresses: [] }), { status: 409, code: "connect_pc_env_link" });
});

test("peerEnvText drops only the live peer lines", () => {
  const text = "# HERDR_WEB_PEER_HOST=100.64.0.2\nHERDR_WEB_PEER_HOST = 100.1.1.1\nHERDR_WEB_PEER_PORT=38790\nHERDR_WEB_PEER_ADDRESSES=x\nOTHER=1";
  assert.equal(peerEnvText(text, null), "# HERDR_WEB_PEER_HOST=100.64.0.2\nHERDR_WEB_PEER_PORT=38790\nOTHER=1\n");
  assert.equal(peerEnvText(text, { host: "100.96.0.2", addresses: ["100.101.0.3"] }),
    "# HERDR_WEB_PEER_HOST=100.64.0.2\nHERDR_WEB_PEER_PORT=38790\nOTHER=1\n\n# Connect PC, set from Settings → PCs\nHERDR_WEB_PEER_HOST=100.96.0.2\nHERDR_WEB_PEER_ADDRESSES=100.101.0.3\n");
});

async function app(context, { required = true, access } = {}) {
  const saves = [];
  const fake = access === undefined ? {
    async state() { return { supported: true, open: false, peers: [] }; },
    async save(body) { saves.push(body); return { restarting: true, ...body }; },
  } : access;
  const server = createHerdrHttpServer({
    herdr: { async snapshot() { return { workspaces: [], tabs: [], panes: [], agents: [] }; } },
    csrfToken: "csrf",
    logger: { error() {} },
    auth: {
      required,
      hasValidSession: (cookie) => cookie === "session=valid",
      hasValidLaunchToken: (token) => token === "launch",
      onSessionsEnded: () => () => {},
      verifyPassword: async (password) => password === "secret",
    },
    connectPcAccess: fake,
  }).server;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" };
  const get = (headers = {}) => fetch(`${origin}/api/connect-pc/access`, { headers: { ...session, Origin: origin, ...headers } });
  const post = (body, headers = {}) => fetch(`${origin}/api/connect-pc/access`, {
    method: "POST", headers: { ...session, "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin, ...headers }, body: JSON.stringify(body),
  });
  return { origin, get, post, saves };
}

test("the route needs sign-in, the same origin, the write token and the password again", async (context) => {
  const { origin, get, post, saves } = await app(context);
  assert.equal((await fetch(`${origin}/api/connect-pc/access`)).status, 401);
  assert.equal((await get({ Origin: "https://evil.example" })).status, 403);
  assert.equal((await get()).status, 200);
  assert.equal((await post({ open: true, addresses: [], password: "secret" }, { "X-Herdr-CSRF": "wrong" })).status, 403);
  const wrong = await post({ open: true, addresses: [], password: "nope" });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, "invalid_password");
  assert.deepEqual(saves, []);
  const saved = await post({ open: true, addresses: ["100.101.0.3"], password: "secret", extra: 1 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saves, [{ open: true, addresses: ["100.101.0.3"] }]);
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`, { headers: { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" } })).json();
  assert.equal(bootstrap.connectPcAccess, true);
});

test("with sign-in off, or without the manager, nothing is offered or changed", async (context) => {
  const off = await app(context, { required: false });
  const response = await fetch(`${off.origin}/api/connect-pc/access`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "password_auth_required");
  const none = await app(context, { access: null });
  assert.equal((await none.get()).status, 404);
  assert.equal((await (await fetch(`${none.origin}/api/bootstrap`, { headers: { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" } })).json()).connectPcAccess, false);
});

test("a save waits for the restart, refuses this PC itself, takes 32 PCs, and a port that cannot open or a broken .env writes nothing", async (context) => {
  const many = { ...TAILNET, peers: Array.from({ length: 33 }, (_, index) => ({ name: `pc${index}`, address: `100.101.1.${index + 1}`, online: true })) };
  const big = await world(context, { tailnet: many });
  await big.access.save({ open: true, addresses: many.peers.slice(0, 32).map((peer) => peer.address) });
  assert.equal(parseEnvFile(await readFile(big.envFile, "utf8")).HERDR_WEB_PEER_ADDRESSES.split(",").length, 32);

  const self = await world(context);
  await assert.rejects(self.access.save({ open: true, addresses: ["100.96.0.2"] }), { status: 400 });

  // Saved, this server restarts: a second change waits for the new one.
  const busy = await world(context);
  busy.access.restart = async () => {};
  await busy.access.save({ open: true, addresses: ["100.101.0.3"] });
  await assert.rejects(busy.access.save({ open: false }), { status: 409, code: "connect_pc_busy" });

  const taken = await world(context, { canListen: async () => "EADDRINUSE" });
  const before = await readFile(taken.envFile, "utf8");
  await assert.rejects(taken.access.save({ open: true, addresses: ["100.101.0.3"] }), { status: 409, code: "connect_pc_port_unavailable" });
  // the port already open where it is stays as it is, without a second bind
  const running = await world(context, { canListen: async () => "EADDRINUSE", current: { host: "100.96.0.2", addresses: ["100.101.0.3"] } });
  await running.access.save({ open: true, addresses: ["100.110.0.4"] });

  const broken = await world(context, { env: "HERDR_WEB_PORT=38787\nHERDR_WEB_PEER_PORT=nope\n" });
  await assert.rejects(broken.access.save({ open: true, addresses: ["100.101.0.3"] }), { status: 409, code: "connect_pc_settings_invalid" });
  const leaf = await world(context, { env: "HERDR_WEB_ROLE=leaf\nHERDR_WEB_HOST=100.96.0.2\nHERDR_WEB_PORT=38787\n" });
  await assert.rejects(leaf.access.save({ open: false }), { status: 409, code: "connect_pc_legacy_leaf" });
  assert.equal(await readFile(taken.envFile, "utf8"), before);
  assert.equal(taken.restarts() + broken.restarts() + leaf.restarts(), 0);
});
