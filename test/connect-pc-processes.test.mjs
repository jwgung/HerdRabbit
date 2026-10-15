// Two whole HerdRabbits on this machine, on loopback: one opens its Connect PC
// port, the other connects to it. Nothing here talks to a real Herdr or
// Tailscale: both run a fake `herdr`, and `tailscale` is a stub that fails.
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writePasswordConfiguration } from "../src/password-auth.mjs";

const RUNNER = fileURLToPath(new URL("./fixtures/run-until-disconnect.mjs", import.meta.url));
const LINK_ID = "link_22222222-2222-2222-2222-222222222222";

const FAKE_HERDR = `#!/usr/bin/env node
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--session="));
const reply = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] === "--version") { process.stdout.write("herdr 0.9.3\\n"); process.exit(0); }
if (args[0] === "session" && args[1] === "list") reply({ sessions: [{ name: "default", running: true, default: true }] });
if (args[0] === "api" && args[1] === "snapshot") reply({ snapshot: {
  focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1",
  workspaces: [{ workspace_id: "w1", label: process.env.FAKE_LABEL }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "shell" }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }],
  agents: [],
} });
if (args[0] === "machine" && args[1] === "list") reply([]);
if (args[0] === "pane" && args[1] === "read") { process.stdout.write(process.env.FAKE_LABEL + " screen"); process.exit(0); }
process.stderr.write(JSON.stringify({ error: { code: "unsupported", message: "not in this fake" } }));
process.exit(1);
`;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, what, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

async function startHerdRabbit(context, root, name, environment) {
  const home = join(root, name);
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "herdr"), FAKE_HERDR);
  await writeFile(join(bin, "tailscale"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "herdr"), 0o755);
  await chmod(join(bin, "tailscale"), 0o755);
  const runtime = join(home, "run");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const output = [];
  const child = fork(RUNNER, [], {
    cwd: home,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_RUNTIME_DIR: runtime,
      HERDR_BIN: join(bin, "herdr"),
      HERDR_WEB_HOST: "127.0.0.1",
      FAKE_LABEL: `${name} project`,
      ...environment,
    },
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exited = once(child, "exit");
  context.after(async () => {
    if (child.exitCode === null && child.connected) child.disconnect();
    await exited;
  });
  return { child, output };
}

test("one HerdRabbit connects to another's Connect PC port, and each keeps its own page and login", { timeout: 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "herdrabbit-connect-pc-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const [hubPort, peerPagePort, peerPort] = [await freePort(), await freePort(), await freePort()];

  // The PC being connected to: a page with a password, and a Connect PC port
  // that allows only loopback (the other HerdRabbit here).
  await writePasswordConfiguration(join(root, "desk", "config", "herdr-bridge", "auth.json"), "correct horse");
  const desk = await startHerdRabbit(context, root, "desk", {
    HERDR_WEB_PORT: String(peerPagePort),
    HERDR_WEB_PEER_HOST: "127.0.0.1",
    HERDR_WEB_PEER_PORT: String(peerPort),
    HERDR_WEB_PEER_ADDRESSES: "127.0.0.1",
  });

  // The PC that connects: no password, and desk saved under Connect PC.
  const serversFile = join(root, "laptop", "config", "herdr-bridge", "servers.json");
  await mkdir(dirname(serversFile), { recursive: true });
  await writeFile(serversFile, JSON.stringify([{ id: LINK_ID, name: "desk", address: `http://127.0.0.1:${peerPort}` }]));
  const laptop = await startHerdRabbit(context, root, "laptop", { HERDR_WEB_PORT: String(hubPort) });

  const deskPage = `http://127.0.0.1:${peerPagePort}`;
  const deskPeer = `http://127.0.0.1:${peerPort}`;
  const laptopPage = `http://127.0.0.1:${hubPort}`;
  await waitFor(async () => (await fetch(`${deskPeer}/api/link/hello`)).ok, `desk's Connect PC port (${desk.output.join("")})`);
  await waitFor(async () => (await fetch(`${laptopPage}/api/bootstrap`)).ok, `laptop's page (${laptop.output.join("")})`);

  // desk has its own page, behind its login.
  assert.equal((await fetch(`${deskPage}/`)).status, 200);
  assert.equal((await fetch(`${deskPage}/api/bootstrap`)).status, 401);
  const login = await fetch(`${deskPage}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: deskPage },
    body: JSON.stringify({ password: "correct horse" }),
  });
  assert.equal(login.status, 200);
  const session = {
    Cookie: login.headers.get("set-cookie").split(";", 1)[0],
    "X-Herdr-Launch-Token": (await login.json()).launchToken,
  };
  const { snapshot: deskSnapshot } = await (await fetch(`${deskPage}/api/snapshot`, { headers: session })).json();
  assert.deepEqual(deskSnapshot.workspaces.map((workspace) => workspace.label), ["desk project"]);

  // The two doors stay apart: the page has no link API, the port no page.
  assert.equal((await fetch(`${deskPage}/api/link/hello`, { headers: session })).status, 404);
  assert.equal((await fetch(`${deskPeer}/`)).status, 404);
  assert.equal((await fetch(`${deskPeer}/api/snapshot`)).status, 404);

  // laptop shows desk's sessions beside its own, under desk's id.
  const merged = await waitFor(async () => {
    const { snapshot } = await (await fetch(`${laptopPage}/api/snapshot`)).json();
    return snapshot.servers.find((server) => server.id === LINK_ID)?.available ? snapshot : null;
  }, "laptop to connect to desk");
  const deskServer = merged.servers.find((server) => server.id === LINK_ID);
  assert.equal(deskServer.transport, "link");
  assert.equal(deskServer.link_protocol, 1);
  assert.deepEqual(merged.workspaces.map((workspace) => workspace.label).sort(), ["desk project", "laptop project"]);
  const remotePane = merged.panes.find((pane) => pane.pane_id.startsWith(`${LINK_ID}!`));
  assert.ok(remotePane, "desk's pane is listed on laptop");
  const output = await (await fetch(`${laptopPage}/api/panes/${encodeURIComponent(remotePane.pane_id)}/output?lines=20`)).json();
  assert.match(output.output, /desk project screen/u);
});

test("a Connect PC port that cannot open stops the whole HerdRabbit, page and all", { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "herdrabbit-connect-pc-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const pagePort = await freePort();
  // Something else already holds the Connect PC port.
  const holder = createServer();
  holder.listen(0, "127.0.0.1");
  await once(holder, "listening");
  context.after(() => new Promise((resolve) => holder.close(resolve)));
  const { child, output } = await startHerdRabbit(context, root, "desk", {
    HERDR_WEB_PORT: String(pagePort),
    HERDR_WEB_PEER_HOST: "127.0.0.1",
    HERDR_WEB_PEER_PORT: String(holder.address().port),
    HERDR_WEB_PEER_ADDRESSES: "127.0.0.1",
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1, output.join(""));
  assert.match(output.join(""), /already in use/u);
  await assert.rejects(() => fetch(`http://127.0.0.1:${pagePort}/`), "the page is not left running");
});
