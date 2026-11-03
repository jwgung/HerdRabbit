import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { linkRoutes } from "../src/link-server.mjs";
import { LinkClient } from "../src/link-client.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";

const LINK_ID = "link_11111111-1111-1111-1111-111111111111";
const herdr = { async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; } };

async function startPeer(context, { installedAgents = null, allowed = ["127.0.0.1"] } = {}) {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: allowed }),
    link: linkRoutes({ client: herdr, installedAgents, version: "2.0.0", serverName: "dev-box" }),
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const client = (address) => new LinkClient({ profile: { id: LINK_ID, name: "Dev box", address }, hubVersion: "2.0.0" });

test("a PC that can tell its installed agents names it among its features", async (context) => {
  const withAgents = await startPeer(context, { installedAgents: { async list() { return ["claude"]; } } });
  assert.deepEqual((await (await fetch(`${withAgents}/api/link/hello`)).json()).features, ["scroll_bottom", "commands", "agents"]);
  const without = await startPeer(context);
  assert.deepEqual((await (await fetch(`${without}/api/link/hello`)).json()).features, ["scroll_bottom", "commands"]);
});

test("the hub hears which agents a connected PC has, and keeps only agents it knows", async (context) => {
  const address = await startPeer(context, {
    installedAgents: { async list() { return ["codex", "claude", "codex", "rm -rf /", { evil: true }, "toString"]; } },
  });
  assert.deepEqual(await client(address).installedAgents(), ["claude", "codex"]);
});

test("an older PC is not asked, and says nothing about its agents", async (context) => {
  const address = await startPeer(context);
  assert.equal(await client(address).installedAgents(), null);
  assert.equal((await fetch(`${address}/api/link/agents`)).status, 404);
});

test("the agents route is let in exactly like every other link route", async (context) => {
  let asked = 0;
  const address = await startPeer(context, { installedAgents: { async list() { asked += 1; return ["claude"]; } }, allowed: ["100.64.0.9"] });
  assert.equal((await fetch(`${address}/api/link/agents`)).status, 403);
  assert.equal(asked, 0);
});

test("the hub asks a connected PC through its own link, and never for this PC", () => {
  const profile = { id: LINK_ID, name: "Dev box", transport: "link", address: "http://127.0.0.1:1" };
  const multi = new MultiServerClient({
    local: herdr, profiles: { list: () => [profile] }, remoteFactory: () => ({ marker: "link", close() {} }),
  });
  assert.equal(multi.agentsClient(LINK_ID).marker, "link");
  assert.equal(multi.agentsClient("local"), null);
  assert.equal(multi.agentsClient("link_00000000-0000-0000-0000-000000000000"), null);
});
