import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ServerProfiles } from "../src/server-profiles.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { HerdrBridgeClient } from "../src/herdr-bridge-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";

const sample = { name: "Development", address: "http://100.64.0.9:38787" };
const session = "hs_ZGVmYXVsdA";
const pane = `${session}~wB:p1`;
const REMOTE = "link_11111111-1111-1111-1111-111111111111";

// Stands in for a machine's own Herdr, local or at the other end of a link.
function bridge(label, received) {
  return new HerdrBridgeClient({ runner: async (_binary, args) => {
    const command = args[0]?.startsWith("--session=") ? args.slice(1) : args;
    if (command[0] === "session") return { stdout: JSON.stringify({ sessions: [{ name: "default", running: true, default: true }] }) };
    if (command[0] === "api") return { stdout: JSON.stringify({ snapshot: {
      workspaces: [{ workspace_id: "wB", label }],
      tabs: [{ workspace_id: "wB", tab_id: "wB:t1" }],
      panes: [{ workspace_id: "wB", tab_id: "wB:t1", pane_id: "wB:p1" }], agents: [],
    } }) };
    received.push(command);
    return { stdout: command[1] === "read" ? label : "" };
  } });
}

test("aggregates identical local and remote IDs and routes commands to the right machine", async () => {
  const localCalls = [], remoteCalls = [];
  const profile = { ...sample, transport: "link", id: REMOTE };
  const profiles = { list: () => [profile] };
  const client = new MultiServerClient({ local: bridge("Local", localCalls), profiles, remoteFactory: () => bridge("Remote", remoteCalls) });
  await client.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = await client.snapshot();
  const remotePane = `${profile.id}!${pane}`;
  assert.deepEqual(snapshot.panes.map((item) => item.pane_id), [pane, remotePane]);
  assert.equal(await client.readPane(pane, { lines: 1 }), "Local");
  assert.equal(await client.readPane(remotePane, { lines: 1 }), "Remote");
  await client.sendText(remotePane, "hello", { submit: true });
  assert.deepEqual(remoteCalls.at(-1), ["pane", "run", "wB:p1", "hello"]);
  assert.equal(localCalls.length, 1);
  profiles.list = () => [];
  await assert.rejects(client.readPane(remotePane), /no longer configured/u);
});

test("a stalled remote cannot block local snapshots", { timeout: 1_000 }, async () => {
  const client = new MultiServerClient({ local: bridge("Local", []),
    profiles: { list: () => [{ ...sample, transport: "link", id: REMOTE }] },
    remoteFactory: () => ({ snapshot: () => new Promise(() => {}) }),
  });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.panes[0].pane_id, pane);
  assert.equal(snapshot.servers[1].status, "Connecting");
});

test("names the transport of every server it reports", async () => {
  const client = new MultiServerClient({ local: bridge("Local", []),
    profiles: { list: () => [{ ...sample, transport: "link", id: REMOTE }] },
    remoteFactory: () => bridge("Remote", []),
  });
  const { servers } = await client.snapshot();
  assert.deepEqual(servers.map((server) => server.transport), ["local", "link"]);
});

test("every machine goes by its tailnet name, and this one reports its version", async () => {
  let names = new Map([["local", "Gungbuntu"]]);
  const client = new MultiServerClient({ local: bridge("Local", []),
    profiles: { list: () => [{ ...sample, transport: "link", id: REMOTE }] },
    remoteFactory: () => bridge("Remote", []),
    hubVersion: "1.2.3", machineName: (profile) => names.get(profile.id) ?? null });
  const { servers: [local, remote] } = await client.snapshot();
  assert.equal(local.machine, "Gungbuntu");
  assert.equal(local.version, "1.2.3");
  assert.equal(local.address, null);
  assert.equal(remote.machine, null, "a machine Tailscale does not name goes unnamed");
  // Tailscale answers after startup; the next snapshot carries its names.
  names = new Map([["local", "gungbuntu"], [REMOTE, "devbox"]]);
  const { servers } = await client.snapshot();
  assert.deepEqual(servers.map((server) => server.machine), ["gungbuntu", "devbox"]);
});

test("this machine reports its Herdr version and whether it is supported", async () => {
  let version = null;
  const client = new MultiServerClient({ local: bridge("Local", []),
    profiles: { list: () => [{ ...sample, transport: "link", id: REMOTE }] },
    remoteFactory: () => bridge("Remote", []), herdrVersion: () => version });
  let { servers: [local, remote] } = await client.snapshot();
  assert.equal(local.herdr_version, null);
  assert.equal(local.herdr_supported, null, "an unread version is unknown, not unsupported");
  assert.equal(remote.herdr_version, undefined, "a linked machine answers for its own Herdr");
  version = "0.8.2";
  ({ servers: [local] } = await client.snapshot());
  assert.deepEqual([local.herdr_version, local.herdr_supported], ["0.8.2", false]);
  version = "0.9.3";
  ({ servers: [local] } = await client.snapshot());
  assert.equal(local.herdr_supported, true);
});

test("server HTTP API protects writes and supports test, add, edit, delete", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-profile-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profiles = await ServerProfiles.load(join(dir, "servers.json"));
  const herdr = new MultiServerClient({ local: bridge("Local", []), profiles, remoteFactory: () => bridge("Remote", []) });
  const { server } = createHerdrHttpServer({ herdr, profiles, csrfToken: "test-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method, body, authorized = true) => fetch(base + path, {
    method, headers: { "Content-Type": "application/json", ...(authorized ? { Origin: base, "X-Herdr-CSRF": "test-token" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  assert.equal((await request("/api/servers", "POST", sample, false)).status, 403);
  assert.equal(profiles.list().length, 0);
  assert.equal((await request("/api/servers/test", "POST", { ...sample, address: "not a url" })).status, 400);

  const tested = await request("/api/servers/test", "POST", sample);
  assert.deepEqual(await tested.json(), { ok: true, transport: "link", version: null, sessions: 1, panes: 1 });
  assert.equal(profiles.list().length, 0, "a test does not register anything");

  const saved = await request("/api/servers", "POST", sample);
  assert.equal(saved.status, 200);
  const id = (await saved.json()).profiles[0].id;
  assert.match(id, /^link_/u);

  assert.equal((await request(`/api/servers/${id}`, "PUT", { ...sample, name: "Renamed" })).status, 200);
  const listed = await fetch(base + "/api/servers").then((response) => response.json());
  assert.equal(listed.profiles[0].name, "Renamed");
  assert.equal((await request(`/api/servers/${id}`, "DELETE")).status, 200);
  assert.equal(profiles.list().length, 0);
});
