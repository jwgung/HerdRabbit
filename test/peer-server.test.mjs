import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { leafLinkRoutes } from "../src/link-server.mjs";
import { PasswordAuth, createPasswordConfiguration } from "../src/password-auth.mjs";
import { PEER_ADDRESS_HEADER, PEER_LOGIN_HEADER, PeerIdentity } from "../src/peer-identity.mjs";
import { createPeerServer } from "../src/peer-server.mjs";

const herdr = {
  async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; },
  async readPane() { return "output"; },
  async sendText() {}, async sendKeys() {},
};

async function listen(context, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function peerPort(context, peer) {
  return listen(context, createPeerServer({
    peer,
    link: leafLinkRoutes({ client: herdr, version: "1.2.46" }),
    logger: { error() {} },
  }));
}

async function signedIn(base) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ password: "correct horse" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { launchToken } = await login.json();
  return { Cookie: cookie, "X-Herdr-Launch-Token": launchToken };
}

test("with an empty allowed list the Connect PC port lets nobody in", async (context) => {
  const base = await peerPort(context, new PeerIdentity());
  for (const path of ["/api/link/hello", "/api/link/snapshot"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error.code, "peer_not_allowed");
  }
});

test("a device outside the allowed list is refused, whatever headers it sends", async (context) => {
  const base = await peerPort(context, new PeerIdentity({ addresses: ["100.64.0.9"] }));
  const response = await fetch(`${base}/api/link/hello`, {
    headers: { [PEER_ADDRESS_HEADER]: "100.64.0.9", [PEER_LOGIN_HEADER]: "owner@example.com" },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "peer_address_rejected");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("the Connect PC port serves the link API and nothing of the page", async (context) => {
  const base = await peerPort(context, new PeerIdentity({ addresses: ["127.0.0.1"] }));
  assert.equal((await fetch(`${base}/api/link/hello`)).status, 200);
  // An allowed PC still cannot reach the page, its login, or the browser API.
  for (const path of ["/", "/app.js", "/api/auth/status", "/api/bootstrap", "/api/snapshot", "/api/panes/p1/output"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, "not_found", path);
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "x" }),
  });
  assert.equal(login.status, 404);
  // Nothing on this port speaks WebSocket, so the terminal socket is not here either.
  const upgrade = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/terminal`, { headers: { Connection: "Upgrade", Upgrade: "websocket" } });
    req.on("response", (response) => { response.resume(); resolve(response.statusCode); });
    req.on("upgrade", () => reject(new Error("upgraded")));
    req.on("error", reject);
    req.end();
  });
  assert.equal(upgrade, 404);
});

test("a signed-in browser cannot reach the link API through the page", async (context) => {
  const auth = new PasswordAuth(await createPasswordConfiguration("correct horse"));
  const page = createHerdrHttpServer({ herdr, auth, csrfToken: "fixed-test-token", logger: { error() {} } });
  const base = await listen(context, page.server);
  const session = await signedIn(base);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: session })).status, 200);
  for (const path of ["/api/link/hello", "/api/link/snapshot"]) {
    const response = await fetch(`${base}${path}`, { headers: session });
    assert.equal(response.status, 404, path);
  }
  const write = await fetch(`${base}/api/link/panes/p1/text`, {
    method: "POST",
    headers: { ...session, "Content-Type": "application/json", Origin: base, "X-Herdr-CSRF": "fixed-test-token" },
    body: JSON.stringify({ text: "ls" }),
  });
  assert.equal(write.status, 404);
});

test("a page with a password keeps its login whatever a Connect PC port allows", async (context) => {
  // Every PC has its own page and login; opening the Connect PC port changes
  // nothing about who may use the page.
  const auth = new PasswordAuth(await createPasswordConfiguration("correct horse"));
  const page = createHerdrHttpServer({ herdr, auth, csrfToken: "fixed-test-token", logger: { error() {} } });
  const base = await listen(context, page.server);
  await peerPort(context, new PeerIdentity({ addresses: ["127.0.0.1"] }));
  assert.equal((await fetch(`${base}/`)).status, 200, "the page itself is served");
  const forged = await fetch(`${base}/api/snapshot`, {
    headers: { [PEER_LOGIN_HEADER]: "owner@example.com", [PEER_ADDRESS_HEADER]: "127.0.0.1" },
  });
  assert.equal(forged.status, 401);
  assert.equal((await forged.json()).error.code, "authentication_required");
  const session = await signedIn(base);
  assert.equal((await fetch(`${base}/api/snapshot`, { headers: session })).status, 200);
});
