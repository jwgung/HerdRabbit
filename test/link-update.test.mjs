import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { linkRoutes } from "../src/link-server.mjs";
import { LinkClient } from "../src/link-client.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";
import { HttpError } from "../src/http-basics.mjs";
import { MAX_LOG_BYTES } from "../src/app-update.mjs";

const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const herdr = { async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; } };

// A connected PC's updater, saying more than it should: the hub keeps only
// what it shows.
function noisyUpdater(calls) {
  return {
    async check(options) {
      calls.push(["check", options]);
      return {
        checkedAt: "2026-10-17T00:00:00.000Z",
        current: { sha: "abc1234", version: "2.0.0" },
        latest: { sha: "def5678", version: "2.0.1", url: "https://token@github.com/x" },
        available: true,
        notes: [...Array.from({ length: 45 }, (_, index) => `Change ${index}`), "y".repeat(900), { evil: true }],
        blocked: null,
        error: null,
        origin: "https://token@github.com/ultivis-iot/HerdRabbit.git",
      };
    },
    async runStatus() {
      calls.push(["runStatus"]);
      return { state: "running", startedAt: "2026-10-17T00:00:00.000Z", finishedAt: null, exitCode: null, log: "x\n".repeat(20_000), version: "2.0.0", boot: "abc" };
    },
    async start() {
      calls.push(["start"]);
      return { state: "running", log: "", version: "2.0.0" };
    },
  };
}

async function startPeer(context, { updater = null, allowed = ["127.0.0.1"] } = {}) {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: allowed }),
    link: linkRoutes({ client: herdr, updater, version: "2.0.0", serverName: "dev-box" }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const client = (address) => new LinkClient({ profile: { id: LINK_ID, name: "Dev box", address }, hubVersion: "2.0.0" });

test("a PC with in-app update names it among its features", async (context) => {
  const withUpdate = await startPeer(context, { updater: noisyUpdater([]) });
  const hello = await (await fetch(`${withUpdate}/api/link/hello`)).json();
  assert.deepEqual(hello.features, ["scroll_bottom", "commands", "update"]);
  const without = await startPeer(context);
  assert.deepEqual((await (await fetch(`${without}/api/link/hello`)).json()).features, ["scroll_bottom", "commands"]);
});

test("the hub asks a connected PC about its update and keeps only what it shows", async (context) => {
  const calls = [];
  const address = await startPeer(context, { updater: noisyUpdater(calls) });
  const link = client(address);
  const check = await link.updateCheck({ fresh: true });
  assert.equal(check.notes.length, 30);
  assert.ok(check.notes.every((note) => typeof note === "string" && note.length <= 200));
  assert.deepEqual(check.latest, { sha: "def5678", version: "2.0.1" });
  assert.doesNotMatch(JSON.stringify(check), /token/u);
  const status = await link.updateStatus();
  assert.equal(status.state, "running");
  assert.ok(Buffer.byteLength(status.log) <= MAX_LOG_BYTES);
  assert.equal("boot" in status, false);
  assert.equal((await link.updateRun()).state, "running");
  assert.deepEqual(calls, [["check", { fresh: true }], ["runStatus"], ["start"]]);
});

test("a PC that refuses to start says why, and the hub passes the reason on", async (context) => {
  const updater = { ...noisyUpdater([]), async start() { throw new HttpError(409, "update_blocked", "This update cannot run here (local_changes)."); } };
  const link = client(await startPeer(context, { updater }));
  await assert.rejects(link.updateRun(), { code: "update_blocked", message: "This update cannot run here (local_changes)." });
});

test("an older PC is not asked at all, and says it is too old to update from here", async (context) => {
  const address = await startPeer(context);
  const link = client(address);
  assert.equal(await link.updateCheck(), null);
  assert.equal(await link.updateStatus(), null);
  await assert.rejects(link.updateRun(), { code: "link_unsupported" });
  // Its port has no such route either.
  assert.equal((await fetch(`${address}/api/link/update`)).status, 404);
});

test("the update routes are let in exactly like every other link route", async (context) => {
  const calls = [];
  const address = await startPeer(context, { updater: noisyUpdater(calls), allowed: ["100.64.0.9"] });
  for (const [method, path] of [["GET", "/api/link/update"], ["GET", "/api/link/update/run"], ["POST", "/api/link/update/run"]]) {
    assert.equal((await fetch(`${address}${path}`, { method })).status, 403, `${method} ${path}`);
  }
  await assert.rejects(client(address).updateCheck(), { code: "link_unauthorized" });
  // A browser that found the port is turned away before anything else.
  const open = await startPeer(context, { updater: noisyUpdater(calls) });
  assert.equal((await fetch(`${open}/api/link/update/run`, { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  assert.deepEqual(calls, []);
});

test("the hub reaches a connected PC's update through its own link, and never this PC's", () => {
  const profile = { id: LINK_ID, name: "Dev box", transport: "link", address: "http://127.0.0.1:1" };
  const multi = new MultiServerClient({
    local: herdr, profiles: { list: () => [profile] }, remoteFactory: () => ({ marker: "link", close() {} }),
  });
  assert.equal(multi.updateClient(LINK_ID).marker, "link");
  assert.equal(multi.updateClient("local"), null);
  assert.equal(multi.updateClient("link_00000000-0000-0000-0000-000000000000"), null);
});
