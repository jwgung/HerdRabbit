import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { leafLinkRoutes } from "../src/link-server.mjs";
import { PasswordAuth, createPasswordConfiguration } from "../src/password-auth.mjs";
import { PEER_ADDRESS_HEADER, PEER_LOGIN_HEADER, PeerIdentity } from "../src/peer-identity.mjs";
import { MAX_PEER_CONNECTIONS, createPeerServer } from "../src/peer-server.mjs";

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
    link: leafLinkRoutes({ client: herdr, version: "1.2.47" }),
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

// A request with headers fetch would not let a caller set: Host, as a page
// on a rebound name would send it, and the headers a browser adds.
function raw(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers });
    req.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a request that names this port by any other host is refused before anything else", async (context) => {
  const base = await peerPort(context, new PeerIdentity({ addresses: ["127.0.0.1"] }));
  const port = new URL(base).port;
  assert.equal((await raw(base, "/api/link/hello", { Host: `127.0.0.1:${port}` })).status, 200);
  // DNS rebinding: a page on the attacker's name, resolving here, from a
  // browser on an allowed device. The socket address is allowed; the name is not.
  for (const host of [`evil.example:${port}`, `localhost:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `127.0.0.1:${port}.evil.example`]) {
    const answer = await raw(base, "/api/link/hello", { Host: host });
    assert.equal(answer.status, 421, host);
    assert.equal(answer.body.error.code, "wrong_host", host);
  }
  // Even a path that is not served at all is refused for the name first.
  assert.equal((await raw(base, "/", { Host: `evil.example:${port}` })).status, 421);
});

test("a browser is refused even on the right host; a server's fetch is not", async (context) => {
  const base = await peerPort(context, new PeerIdentity({ addresses: ["127.0.0.1"] }));
  // What Node's fetch sends, Sec-Fetch-Mode included, is a server.
  const fromHub = await fetch(`${base}/api/link/hello`);
  assert.equal(fromHub.status, 200);
  for (const headers of [
    { Origin: "http://evil.example" },
    { Origin: base },
    { Origin: "null" },
    { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
    { "Sec-Fetch-Dest": "document" },
    { "Sec-Fetch-User": "?1" },
  ]) {
    const answer = await raw(base, "/api/link/hello", headers);
    assert.equal(answer.status, 403, JSON.stringify(headers));
    assert.equal(answer.body.error.code, "browser_refused", JSON.stringify(headers));
  }
  const write = await fetch(`${base}/api/link/panes/p1/text`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ text: "ls" }),
  });
  assert.equal(write.status, 403);
});

test("this PC's own tailnet name is accepted as well as its address", async (context) => {
  const base = await listen(context, createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: leafLinkRoutes({ client: herdr, version: "1.2.47" }),
    hostNames: () => ["desk.tail1234.ts.net"],
    logger: { error() {} },
  }));
  const port = new URL(base).port;
  assert.equal((await raw(base, "/api/link/hello", { Host: `Desk.tail1234.ts.net:${port}` })).status, 200);
  assert.equal((await raw(base, "/api/link/hello", { Host: `desk.tail1234.ts.net.evil.example:${port}` })).status, 421);
});

test("on IPv6 the host is the bracketed address, as a hub's fetch sends it", async (context) => {
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: ["::1"] }),
    link: leafLinkRoutes({ client: herdr, version: "1.2.47" }),
    logger: { error() {} },
  });
  try {
    server.listen(0, "::1");
    await once(server, "listening");
  } catch {
    context.skip("no IPv6 loopback here");
    return;
  }
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://[::1]:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/link/hello`)).status, 200);
  assert.equal((await raw(base, "/api/link/hello", { Host: `::1:${server.address().port}` })).status, 421);
});

test("the port bounds how long a request may take to arrive and how many sockets it holds", () => {
  const server = createPeerServer({ peer: new PeerIdentity(), link: async () => false, logger: { error() {} } });
  assert.equal(server.headersTimeout, 5_000);
  assert.ok(server.requestTimeout > 0 && server.requestTimeout >= server.headersTimeout);
  assert.equal(server.maxConnections, MAX_PEER_CONNECTIONS);
});

test("status streams beyond the limit are refused until one closes", async (context) => {
  const stops = [];
  const watching = {
    ...herdr,
    async watchStatuses() { const stop = () => {}; stops.push(stop); return stop; },
  };
  const base = await listen(context, createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: leafLinkRoutes({ client: watching, version: "1.2.47", maxStatusStreams: 2 }),
    logger: { error() {} },
  }));
  const open = async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/link/statuses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneIds: ["p1"] }), signal: controller.signal,
    });
    return { response, close: () => controller.abort() };
  };
  const first = await open();
  const second = await open();
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  const third = await open();
  assert.equal(third.response.status, 429);
  assert.equal((await third.response.json()).error.code, "too_many_streams");
  first.close();
  await first.response.body?.cancel().catch(() => {});
  let fourth;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    fourth = await open();
    if (fourth.response.status === 200) break;
    await fourth.response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(fourth.response.status, 200);
  second.close();
  fourth.close();
});
