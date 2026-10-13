import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptKey, createHerdrHttpServer, outputReadLines } from "../src/http-server.mjs";
import {
  createPasswordConfiguration,
  passkeyHandle,
  PasswordAttemptsByKey,
  PasswordAuth,
} from "../src/password-auth.mjs";
import { scrollbackThatTrims } from "./fixtures/short-scrollback.mjs";

async function startServer(herdr, options = {}) {
  const created = createHerdrHttpServer({
    herdr,
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    ...options,
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  const address = created.server.address();
  return {
    ...created,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
  });
}

test("the leaf link routes are gone", async (context) => {
  const herdr = { async snapshot() { return { workspaces: [], tabs: [], panes: [], agents: [] }; } };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));
  const write = { "Content-Type": "application/json", Origin: app.baseUrl, "X-Herdr-CSRF": "fixed-test-token" };
  for (const [method, path] of [
    ["GET", "/api/servers"],
    ["POST", "/api/servers"],
    ["POST", "/api/servers/test"],
    ["POST", "/api/servers/discover"],
    ["DELETE", "/api/servers/link_11111111-1111-1111-1111-111111111111"],
    ["POST", "/api/announce"],
    ["GET", "/api/link/snapshot"],
    ["POST", "/api/link/hello"],
  ]) {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method, headers: method === "GET" ? {} : write, body: method === "GET" ? undefined : "{}",
    });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

test("the page hears once how many old leaf links were saved", async (context) => {
  const herdr = { async snapshot() { return { workspaces: [], tabs: [], panes: [], agents: [] }; } };
  const without = await startServer(herdr);
  context.after(() => closeServer(without.server));
  assert.equal((await (await fetch(`${without.baseUrl}/api/bootstrap`)).json()).legacyServers, 0);
  const saved = await startServer(herdr, { legacyServers: 2 });
  context.after(() => closeServer(saved.server));
  assert.equal((await (await fetch(`${saved.baseUrl}/api/bootstrap`)).json()).legacyServers, 2);
});

test("serves the UI and read-only API with hardened headers", async (context) => {
  const readCalls = [];
  const herdr = {
    async snapshot() {
      return { workspaces: [{ workspace_id: "w1" }], tabs: [], panes: [], agents: [] };
    },
    async readPane(...args) {
      readCalls.push(args);
      return "terminal output";
    },
    async sendText() {},
    async sendKeys() {},
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const page = await fetch(`${app.baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  // xterm adds <style> elements of its own, so the app page alone allows
  // inline styles; scripts stay with this origin everywhere.
  const policyOf = (response) => Object.fromEntries(response.headers.get("content-security-policy").split("; ").map((rule) => {
    const [name, ...sources] = rule.split(" ");
    return [name, sources];
  }));
  assert.deepEqual(policyOf(page)["script-src"], ["'self'"]);
  assert.deepEqual(policyOf(page)["style-src"], ["'self'", "'unsafe-inline'"]);
  const library = await fetch(`${app.baseUrl}/ui/index.html`);
  assert.deepEqual(policyOf(library)["style-src"], ["'self'"]);
  assert.deepEqual(policyOf(library)["script-src"], ["'self'"]);
  const pageSource = await page.text();
  assert.doesNotMatch(pageSource, /<h2>Sessions<\/h2>/);
  assert.doesNotMatch(pageSource, /id="pane-state"/);
  assert.match(pageSource, /id="login-form"/);
  assert.match(pageSource, /id="sidebar-toggle"/);
  assert.equal((await fetch(`${app.baseUrl}/ui-model.js`)).status, 200);
  // The screen-text renderer is gone: every pane is drawn by xterm.
  assert.equal((await fetch(`${app.baseUrl}/ansi.js`)).status, 404);
  assert.equal((await fetch(`${app.baseUrl}/direct-terminal-input.js`)).status, 404);
  assert.equal((await fetch(`${app.baseUrl}/theme.js`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/workspace-preference.js`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/terminal-preference.js`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/completion-preference.js`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/launch-session.js`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/push-notifications.js`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/vendor/simplewebauthn-browser.js`)).status, 200);
  const manifestResponse = await fetch(`${app.baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, "HerdRabbit");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.some((icon) => icon.sizes === "512x512"), true);
  assert.equal((await fetch(`${app.baseUrl}/sw.js`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/icons/herdr-192.png`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/icons/notification-icon-192.png`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/icons/notification-badge-96.png`)).status, 200);
  const faviconSvg = await fetch(`${app.baseUrl}/icons/favicon.svg`);
  assert.equal(faviconSvg.status, 200);
  assert.match(faviconSvg.headers.get("content-type"), /^image\/svg\+xml/);
  const faviconPng = await fetch(`${app.baseUrl}/icons/favicon-32.png`);
  assert.equal(faviconPng.status, 200);
  assert.match(faviconPng.headers.get("content-type"), /^image\/png/);
  const faviconIco = await fetch(`${app.baseUrl}/favicon.ico`);
  assert.equal(faviconIco.status, 200);
  assert.match(faviconIco.headers.get("content-type"), /^image\/x-icon/);
  const uncachedFavicon = await fetch(`${app.baseUrl}/icons/rabbit-outline-v33.svg`);
  assert.equal(uncachedFavicon.status, 200);
  assert.match(uncachedFavicon.headers.get("content-type"), /^image\/svg\+xml/);

  const bootstrap = await fetch(`${app.baseUrl}/api/bootstrap`).then((response) => response.json());
  assert.equal(bootstrap.csrfToken, "fixed-test-token");
  assert.equal(bootstrap.pollIntervalMs, 1_000);

  const snapshot = await fetch(`${app.baseUrl}/api/snapshot`).then((response) => response.json());
  assert.equal(snapshot.snapshot.workspaces[0].workspace_id, "w1");

  const output = await fetch(`${app.baseUrl}/api/panes/w1%3Ap1/output?lines=80`).then((response) => response.json());
  assert.equal(output.output, "terminal output");
  assert.equal(output.requestedLines, 80);
  assert.equal(output.returnedLines, 1);
  assert.equal(output.hasMore, false);
  assert.deepEqual(readCalls, [["w1:p1", { lines: outputReadLines(80), format: "ansi" }]]);
});

test("returns an output revision and no body when the terminal is unchanged", async (context) => {
  const herdr = {
    async snapshot() { return {}; },
    async readPane() { return "alpha\nbeta"; },
    async sendText() {},
    async sendKeys() {},
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const firstResponse = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=200`,
  );
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.update, "replace");
  assert.equal(first.output, "alpha\nbeta");
  assert.match(first.revision, /^[A-Za-z0-9_-]{16,64}$/);

  const unchanged = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=200&since=${first.revision}`,
  );
  assert.equal(unchanged.status, 204);
  assert.equal(await unchanged.text(), "");

  const resynchronized = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=200&since=${"A".repeat(32)}`,
  ).then((response) => response.json());
  assert.equal(resynchronized.update, "replace");
  assert.equal(resynchronized.output, "alpha\nbeta");
});

test("returns only the changed terminal text after a known revision", async (context) => {
  const outputs = [
    "Working (30s • esc to interrupt)",
    "Working (31s • esc to interrupt)",
  ];
  const herdr = {
    async snapshot() { return {}; },
    async readPane() { return outputs.shift(); },
    async sendText() {},
    async sendKeys() {},
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const first = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=200`,
  ).then((response) => response.json());
  const changedResponse = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=200&since=${first.revision}`,
  );
  assert.equal(changedResponse.status, 200);
  const changed = await changedResponse.json();
  assert.equal(changed.update, "delta");
  assert.equal(changed.output, undefined);
  assert.deepEqual(changed.patches, [
    { start: 10, deleteCount: 1, text: "1" },
  ]);
  assert.notEqual(changed.revision, first.revision);
});

test("keeps a one-character working update much smaller than the full window", async (context) => {
  const history = Array.from(
    { length: 199 },
    (_, index) => `terminal history ${String(index).padStart(3, "0")} ${"x".repeat(48)}`,
  ).join("\n");
  const outputs = [
    `${history}\nWorking (30s • esc to interrupt)`,
    `${history}\nWorking (31s • esc to interrupt)`,
  ];
  const herdr = {
    async snapshot() { return {}; },
    async readPane() { return outputs.shift(); },
    async sendText() {},
    async sendKeys() {},
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const firstResponse = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=200`,
  );
  const firstBody = await firstResponse.text();
  const first = JSON.parse(firstBody);
  const changedResponse = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=200&since=${first.revision}`,
  );
  const changedBody = await changedResponse.text();
  assert.ok(
    Buffer.byteLength(changedBody) < Buffer.byteLength(firstBody) / 10,
    `expected ${Buffer.byteLength(changedBody)} bytes to be below one tenth of ${Buffer.byteLength(firstBody)}`,
  );
});

test("returns a compact delta when the live output window rolls forward", async (context) => {
  const outputs = ["old\nalpha\nbeta", "alpha\nbeta\ngamma"];
  const herdr = {
    async snapshot() { return {}; },
    async readPane() { return outputs.shift(); },
    async sendText() {},
    async sendKeys() {},
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const first = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=3`,
  ).then((response) => response.json());
  const changed = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=3&since=${first.revision}`,
  ).then((response) => response.json());

  assert.equal(changed.update, "delta");
  assert.deepEqual(changed.patches, [
    { start: 14, deleteCount: 0, text: "\ngamma" },
    { start: 0, deleteCount: 4, text: "" },
  ]);
});

test("accepts configured interface hosts and rejects unrelated hostnames", async (context) => {
  const herdr = {
    async snapshot() { return {}; },
    async readPane() { return ""; },
    async sendText() {},
    async sendKeys() {},
  };
  const app = await startServer(herdr, {
    allowedHosts: new Set(["127.0.0.1", "192.168.1.20"]),
  });
  context.after(() => closeServer(app.server));

  assert.equal(
    await requestWithHost(`${app.baseUrl}/api/bootstrap`, "192.168.1.20:38787"),
    200,
  );
  assert.equal(
    await requestWithHost(`${app.baseUrl}/api/bootstrap`, "attacker.example:38787"),
    421,
  );
});

test("returns a bounded output window and reports whether older rows exist", async (context) => {
  const herdr = {
    async snapshot() {
      return {};
    },
    async readPane(_paneId, { lines }) {
      assert.equal(lines, outputReadLines(3));
      return "line 1\nline 2\nline 3\nline 4";
    },
    async sendText() {},
    async sendKeys() {},
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const response = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=3`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual({
    output: payload.output,
    requestedLines: payload.requestedLines,
    returnedLines: payload.returnedLines,
    hasMore: payload.hasMore,
    update: payload.update,
  }, {
    output: "line 2\nline 3\nline 4",
    requestedLines: 3,
    returnedLines: 3,
    hasMore: true,
    update: "replace",
  });
  assert.match(payload.revision, /^[A-Za-z0-9_-]{16,64}$/);

  const invalid = await fetch(
    `${app.baseUrl}/api/panes/w1%3Ap1/output?lines=100001`,
  );
  assert.equal(invalid.status, 400);
});

test("rejects writes without both token and same origin", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() {
      return {};
    },
    async readPane() {
      return "";
    },
    async sendText(...args) {
      calls.push(args);
    },
    async sendKeys(...args) {
      calls.push(args);
    },
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));
  const endpoint = `${app.baseUrl}/api/panes/w1%3Ap1/text`;

  const missingToken = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ text: "hello", submit: true }),
  });
  assert.equal(missingToken.status, 403);

  const crossOrigin = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Herdr-CSRF": "fixed-test-token",
      Origin: "https://attacker.example",
    },
    body: JSON.stringify({ text: "hello", submit: true }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(calls.length, 0);
});

test("forwards an authorized, bounded write", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() {
      return {};
    },
    async readPane() {
      return "";
    },
    async sendText(...args) {
      calls.push(args);
    },
    async sendKeys(...args) {
      calls.push(args);
    },
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const response = await fetch(`${app.baseUrl}/api/panes/w1%3Ap9/text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Herdr-CSRF": "fixed-test-token",
      Origin: app.baseUrl,
    },
    body: JSON.stringify({ text: "review this", submit: true }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["w1:p9", "review this", { submit: true }]]);
});

test("forwards an authorized workspace rename", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() { return {}; },
    async readPane() { return ""; },
    async sendText() {},
    async sendKeys() {},
    async renameWorkspace(...args) { calls.push(args); },
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const rejected = await fetch(`${app.baseUrl}/api/workspaces/w12/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ label: "거절될 이름" }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(calls.length, 0);

  const response = await fetch(`${app.baseUrl}/api/workspaces/w12/rename`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Herdr-CSRF": "fixed-test-token",
      Origin: app.baseUrl,
    },
    body: JSON.stringify({ label: "새 프로젝트" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["w12", "새 프로젝트"]]);
});

test("forwards an authorized session rename", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() { return {}; },
    async readPane() { return ""; },
    async sendText() {},
    async sendKeys() {},
    async renameTab(...args) { calls.push(args); },
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const rejected = await fetch(`${app.baseUrl}/api/tabs/w12%3At2/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ label: "거절될 이름" }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(calls.length, 0);

  const response = await fetch(`${app.baseUrl}/api/tabs/w12%3At2/rename`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Herdr-CSRF": "fixed-test-token",
      Origin: app.baseUrl,
    },
    body: JSON.stringify({ label: "배포 확인" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["w12:t2", "배포 확인"]]);
});

test("creates shell workspaces and tabs and returns the updated snapshot", async (context) => {
  const calls = [];
  const snapshots = [
    { workspaces: [{ workspace_id: "w3", label: "새 프로젝트" }], tabs: [], panes: [] },
    {
      workspaces: [{ workspace_id: "w3", label: "새 프로젝트" }],
      tabs: [{ tab_id: "w3:t2", workspace_id: "w3" }],
      panes: [{ pane_id: "w3:p2", tab_id: "w3:t2", workspace_id: "w3" }],
    },
  ];
  const herdr = {
    async snapshot() { return snapshots.shift(); },
    async createWorkspace(...args) { calls.push(["createWorkspace", ...args]); },
    async createTab(...args) { calls.push(["createTab", ...args]); },
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));
  const headers = {
    "Content-Type": "application/json",
    "X-Herdr-CSRF": "fixed-test-token",
    Origin: app.baseUrl,
  };

  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "새 프로젝트" }),
  });
  assert.equal(workspaceResponse.status, 201);
  assert.equal((await workspaceResponse.json()).snapshot.workspaces[0].workspace_id, "w3");

  const tabResponse = await fetch(`${app.baseUrl}/api/workspaces/w3/tabs`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(tabResponse.status, 201);
  assert.equal((await tabResponse.json()).snapshot.panes[0].pane_id, "w3:p2");
  assert.deepEqual(calls, [
    ["createWorkspace", "새 프로젝트"],
    ["createTab", "w3"],
  ]);
});

test("forwards the selected Herdr session when creating a workspace", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [] }; },
    async createWorkspace(...args) { calls.push(args); },
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));
  const response = await fetch(`${app.baseUrl}/api/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Herdr-CSRF": "fixed-test-token",
      Origin: app.baseUrl,
    },
    body: JSON.stringify({
      label: "새 프로젝트",
      herdrSessionId: "hs_ZGVmYXVsdA",
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(calls, [["새 프로젝트", "hs_ZGVmYXVsdA"]]);
});

test("requires explicit confirmation before closing tabs and workspaces", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [] }; },
    async closeTab(...args) { calls.push(["closeTab", ...args]); },
    async closeWorkspace(...args) { calls.push(["closeWorkspace", ...args]); },
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));
  const headers = {
    "Content-Type": "application/json",
    "X-Herdr-CSRF": "fixed-test-token",
    Origin: app.baseUrl,
  };

  const rejected = await fetch(`${app.baseUrl}/api/tabs/w2%3At4/close`, {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmed: false }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(calls.length, 0);

  const tabResponse = await fetch(`${app.baseUrl}/api/tabs/w2%3At4/close`, {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(tabResponse.status, 200);

  const workspaceResponse = await fetch(`${app.baseUrl}/api/workspaces/w2/close`, {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(workspaceResponse.status, 200);
  assert.deepEqual(calls, [
    ["closeTab", "w2:t4"],
    ["closeWorkspace", "w2"],
  ]);
});

test("accepts a same-host HTTPS origin from a terminating reverse proxy", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() { return {}; },
    async readPane() { return ""; },
    async sendText(...args) { calls.push(args); },
    async sendKeys() {},
  };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const response = await fetch(`${app.baseUrl}/api/panes/w1%3Ap2/text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Herdr-CSRF": "fixed-test-token",
      Origin: app.baseUrl.replace("http://", "https://"),
    },
    body: JSON.stringify({ text: "proxied", submit: false }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("requires the configured password before exposing Herdr APIs", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() {
      calls.push("snapshot");
      return { workspaces: [] };
    },
  };
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const app = await startServer(herdr, { auth });
  context.after(() => closeServer(app.server));

  assert.equal((await fetch(`${app.baseUrl}/`)).status, 200);
  const locked = await fetch(`${app.baseUrl}/api/bootstrap`);
  assert.equal(locked.status, 401);
  assert.equal((await locked.json()).error.code, "authentication_required");
  assert.equal(calls.length, 0);

  const wrong = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: app.baseUrl,
      "X-Forwarded-Proto": "https",
    },
    body: JSON.stringify({ password: "secret" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /^herdr_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=604800/);
  const loginPayload = await login.json();
  assert.match(loginPayload.launchToken, /^[A-Za-z0-9_-]+\.[0-9]+\.[A-Za-z0-9_-]+$/);

  const cookieOnly = await fetch(`${app.baseUrl}/api/bootstrap`, {
    headers: { Cookie: cookie.split(";", 1)[0] },
  });
  assert.equal(cookieOnly.status, 401);

  const launchOnly = await fetch(`${app.baseUrl}/api/bootstrap`, {
    headers: { "X-Herdr-Launch-Token": loginPayload.launchToken },
  });
  assert.equal(launchOnly.status, 401);

  const bootstrap = await fetch(`${app.baseUrl}/api/bootstrap`, {
    headers: {
      Cookie: cookie.split(";", 1)[0],
      "X-Herdr-Launch-Token": loginPayload.launchToken,
    },
  });
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).authRequired, true);

  const snapshot = await fetch(`${app.baseUrl}/api/snapshot`, {
    headers: {
      Cookie: cookie.split(";", 1)[0],
      "X-Herdr-Launch-Token": loginPayload.launchToken,
    },
  });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(calls, ["snapshot"]);
});

test("offers passkey login beside password login and creates the same session", async (context) => {
  const calls = [];
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const passkeys = {
    get hasCredentials() { return true; },
    async beginAuthentication(origin) {
      calls.push(["begin", origin]);
      return {
        attemptId: "passkey-attempt",
        options: { challenge: "authentication-challenge" },
      };
    },
    async finishAuthentication(origin, attemptId, credential) {
      calls.push(["finish", origin, attemptId, credential]);
      return true;
    },
  };
  const app = await startServer({ async snapshot() { return {}; } }, {
    auth,
    passkeys,
  });
  context.after(() => closeServer(app.server));

  const status = await fetch(`${app.baseUrl}/api/auth/status`).then((response) => response.json());
  assert.deepEqual(status, {
    required: true,
    authenticated: false,
    passkeyAvailable: true,
  });

  const optionsResponse = await fetch(`${app.baseUrl}/api/auth/passkeys/login/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({}),
  });
  assert.equal(optionsResponse.status, 200);
  assert.deepEqual(await optionsResponse.json(), {
    attemptId: "passkey-attempt",
    options: { challenge: "authentication-challenge" },
  });

  const credential = { id: "credential-id", response: { signature: "signature" } };
  const login = await fetch(`${app.baseUrl}/api/auth/passkeys/login/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: app.baseUrl,
      "X-Forwarded-Proto": "https",
    },
    body: JSON.stringify({ attemptId: "passkey-attempt", credential }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /Secure/);
  assert.match((await login.json()).launchToken, /^[A-Za-z0-9_-]+\.[0-9]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(calls, [
    ["begin", app.baseUrl],
    ["finish", app.baseUrl, "passkey-attempt", credential],
  ]);
});

test("registers passkeys only from an authenticated password session", async (context) => {
  const calls = [];
  let hasCredentials = false;
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const passkeys = {
    get hasCredentials() { return hasCredentials; },
    async beginRegistration(origin) {
      calls.push(["begin", origin]);
      return {
        attemptId: "registration-attempt",
        options: { challenge: "registration-challenge" },
      };
    },
    async finishRegistration(origin, attemptId, credential, details) {
      calls.push(["finish", origin, attemptId, credential, details]);
      hasCredentials = true;
      return true;
    },
  };
  let clock = 1_000_000;
  const app = await startServer({ async snapshot() { return {}; } }, {
    auth,
    passkeys,
    now: () => clock,
  });
  context.after(() => closeServer(app.server));

  const locked = await fetch(`${app.baseUrl}/api/auth/passkeys/register/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({}),
  });
  assert.equal(locked.status, 401);

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { launchToken } = await login.json();
  const authorizedHeaders = {
    "Content-Type": "application/json",
    "X-Herdr-CSRF": "fixed-test-token",
    "X-Herdr-Launch-Token": launchToken,
    Cookie: cookie,
    Origin: app.baseUrl,
  };

  // Just signed in with the password, the window is not asked for it again.
  const fresh = await fetch(`${app.baseUrl}/api/auth/passkeys/register/options`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(fresh.status, 200);
  calls.length = 0;
  // Once: the next one asks.
  const again = await fetch(`${app.baseUrl}/api/auth/passkeys/register/options`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(again.status, 401);

  // Five minutes on, the session alone is not enough.
  clock += 5 * 60_000;
  for (const body of [{}, { password: "wrong" }]) {
    const refused = await fetch(`${app.baseUrl}/api/auth/passkeys/register/options`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).error.code, "invalid_password");
  }
  assert.deepEqual(calls, []);

  const optionsResponse = await fetch(`${app.baseUrl}/api/auth/passkeys/register/options`, {
    method: "POST",
    headers: authorizedHeaders,
    body: JSON.stringify({ password: "secret" }),
  });
  assert.equal(optionsResponse.status, 200);
  assert.deepEqual(await optionsResponse.json(), {
    attemptId: "registration-attempt",
    options: { challenge: "registration-challenge" },
  });

  const credential = { id: "credential-id", response: { attestationObject: "data" } };
  const verification = await fetch(`${app.baseUrl}/api/auth/passkeys/register/verify`, {
    method: "POST",
    headers: {
      ...authorizedHeaders,
      "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
    },
    body: JSON.stringify({ attemptId: "registration-attempt", credential }),
  });
  assert.equal(verification.status, 200);
  assert.deepEqual(await verification.json(), { ok: true, passkeyAvailable: true });
  assert.deepEqual(calls, [
    ["begin", app.baseUrl],
    ["finish", app.baseUrl, "registration-attempt", credential, { label: "Chrome · Android" }],
  ]);
});

test("lists passkeys by name only and removes one after the password", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-passkeys-"));
  const configuration = await createPasswordConfiguration("secret");
  const stored = (id, extra = {}) => ({
    id,
    publicKey: `public-key-of-${id}`,
    counter: 7,
    transports: ["internal"],
    deviceType: "multiDevice",
    backedUp: true,
    ...extra,
  });
  configuration.passkeys = [
    stored("phone-credential", { label: "Safari · iOS", createdAt: 1_700_000_000_000, lastUsedAt: 1_700_000_500_000 }),
    stored("old-credential"),
  ];
  await writeFile(join(directory, "auth.json"), JSON.stringify(configuration));
  const auth = new PasswordAuth(configuration, { authFile: join(directory, "auth.json") });
  const app = await startServer({ async snapshot() { return {}; } }, {
    auth,
    passkeys: { get hasCredentials() { return auth.hasPasskeys; } },
  });
  context.after(() => closeServer(app.server));

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { launchToken } = await login.json();
  const headers = {
    "Content-Type": "application/json",
    "X-Herdr-CSRF": "fixed-test-token",
    "X-Herdr-Launch-Token": launchToken,
    Cookie: cookie,
    Origin: app.baseUrl,
  };

  const unauthenticated = await fetch(`${app.baseUrl}/api/auth/passkeys`);
  assert.equal(unauthenticated.status, 401);

  const listed = await fetch(`${app.baseUrl}/api/auth/passkeys`, { headers });
  assert.equal(listed.status, 200);
  const text = await listed.text();
  // Credential IDs and public keys stay inside the auth file.
  assert.doesNotMatch(text, /phone-credential|old-credential|public-key-of/);
  assert.deepEqual(JSON.parse(text), {
    passkeys: [
      {
        handle: passkeyHandle("phone-credential"),
        label: "Safari · iOS",
        createdAt: 1_700_000_000_000,
        lastUsedAt: 1_700_000_500_000,
        deviceType: "multiDevice",
        backedUp: true,
      },
      {
        handle: passkeyHandle("old-credential"),
        label: null,
        createdAt: null,
        lastUsedAt: null,
        deviceType: "multiDevice",
        backedUp: true,
      },
    ],
  });

  const remove = (body, extraHeaders = headers) => fetch(`${app.baseUrl}/api/auth/passkeys/remove`, {
    method: "POST",
    headers: extraHeaders,
    body: JSON.stringify(body),
  });
  const handle = passkeyHandle("phone-credential");
  const { "X-Herdr-CSRF": _csrf, ...withoutCsrf } = headers;
  assert.equal((await remove({ handle, password: "secret" }, withoutCsrf)).status, 403);
  assert.equal((await remove({ handle })).status, 401);
  assert.equal((await remove({ handle, password: "wrong" })).status, 401);
  assert.equal((await remove({ handle: "A".repeat(22), password: "secret" })).status, 404);
  assert.equal(auth.passkeySummaries().length, 2);

  const removed = await remove({ handle, password: "secret" });
  assert.equal(removed.status, 200);
  const renewed = await removed.json();
  assert.equal(renewed.passkeyAvailable, true);
  assert.deepEqual(auth.passkeySummaries().map((passkey) => passkey.handle), [passkeyHandle("old-credential")]);

  // Every session made before the removal is over, including a lost device's.
  const stale = await fetch(`${app.baseUrl}/api/auth/passkeys`, { headers });
  assert.equal(stale.status, 401);
  // The browser that removed it carries on with the session it was handed.
  const renewedHeaders = {
    ...headers,
    "X-Herdr-Launch-Token": renewed.launchToken,
    Cookie: removed.headers.get("set-cookie").split(";", 1)[0],
  };
  assert.equal((await fetch(`${app.baseUrl}/api/auth/passkeys`, { headers: renewedHeaders })).status, 200);

  const last = await remove({ handle: passkeyHandle("old-credential"), password: "secret" }, renewedHeaders);
  assert.equal((await last.json()).passkeyAvailable, false);
});

test("locks password checks after repeated wrong passwords, sign-in and recheck alike", async (context) => {
  let clock = 1_000_000;
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const app = await startServer({ async snapshot() { return {}; } }, {
    auth,
    passwordAttempts: new PasswordAttemptsByKey({ now: () => clock }),
    now: () => clock,
  });
  context.after(() => closeServer(app.server));
  const login = (password) => fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password }),
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal((await login("wrong")).status, 401);
  }
  // Locked: even the right password is refused, and the wait is stated.
  const locked = await login("secret");
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get("retry-after"), "1");
  assert.equal((await locked.json()).error.code, "too_many_attempts");

  clock += 1_000;
  const signedIn = await login("secret");
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get("set-cookie").split(";", 1)[0];
  const { launchToken } = await signedIn.json();
  clock += 5 * 60_000;

  // The recheck behind adding or removing a passkey counts the same way.
  const headers = {
    "Content-Type": "application/json",
    "X-Herdr-CSRF": "fixed-test-token",
    "X-Herdr-Launch-Token": launchToken,
    Cookie: cookie,
    Origin: app.baseUrl,
  };
  const remove = (password) => fetch(`${app.baseUrl}/api/auth/passkeys/remove`, {
    method: "POST",
    headers,
    body: JSON.stringify({ handle: "A".repeat(22), password }),
  });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal((await remove("wrong")).status, 401);
  }
  assert.equal((await remove("secret")).status, 429);
});

test("refuses a password guess sent while another is being checked", async (context) => {
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const app = await startServer({ async snapshot() { return {}; } }, { auth });
  context.after(() => closeServer(app.server));
  const statuses = await Promise.all(Array.from({ length: 4 }, () => fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "wrong" }),
  }).then((response) => response.status)));
  assert.equal(statuses.filter((status) => status === 401).length, 1);
  assert.equal(statuses.filter((status) => status === 429).length, 3);
});

test("reports disabled authentication without creating a login session", async (context) => {
  const herdr = { async snapshot() { return {}; } };
  const app = await startServer(herdr);
  context.after(() => closeServer(app.server));

  const status = await fetch(`${app.baseUrl}/api/auth/status`).then((response) => response.json());
  assert.deepEqual(status, {
    required: false,
    authenticated: true,
    passkeyAvailable: false,
  });

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "" }),
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("set-cookie"), null);
});



test("a window reads half as many rows again, at least 64, and never past herdr's limit", () => {
  // Pinned as numbers: other tests compute their expected read size with this
  // function, so only this one notices if the formula itself goes wrong.
  assert.equal(outputReadLines(1), 65);
  assert.equal(outputReadLines(80), 144);
  assert.equal(outputReadLines(200), 300);
  assert.equal(outputReadLines(1_000), 1_500);
  assert.equal(outputReadLines(100_000), 100_001);
});

test("older rows are offered while herdr still holds them, though it answers short", async (context) => {
  const read = scrollbackThatTrims(1_000);
  const app = await startServer({
    async snapshot() { return {}; },
    async readPane(_paneId, { lines }) { return read(lines); },
  });
  context.after(() => closeServer(app.server));
  const window = async (lines) =>
    (await fetch(`${app.baseUrl}/api/panes/w1%3Ap1/output?lines=${lines}`)).json();

  const first = await window(200);
  assert.equal(first.hasMore, true, "a pane with 1,000 rows has more than 200");
  assert.equal(first.returnedLines, 200);
  assert.equal((await window(990)).hasMore, true);
  const all = await window(1_200);
  assert.equal(all.hasMore, false, "everything herdr holds has been shown");
  assert.equal(all.output.split("\n")[0], "row 0");
});

test("uses ANSI scrollback even for legacy hybrid requests without consulting session logs", async (context) => {
  const reads = [];
  const app = await startServer({
    async snapshot() { throw new Error("Output must not look up agent log directories"); },
    async readPane(paneId, options) {
      reads.push({ paneId, ...options });
      return "older\n\x1b[32mterminal history\x1b[0m\nlatest";
    },
  }, { transcripts: { async rowsFor() { assert.fail("Session logs must not be read"); } } });
  context.after(() => closeServer(app.server));
  for (const suffix of ["", "&history=hybrid"]) {
    const response = await fetch(`${app.baseUrl}/api/panes/w1%3Ap1/output?lines=2${suffix}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.output, "\x1b[32mterminal history\x1b[0m\nlatest");
    assert.equal(payload.hasMore, true);
  }
  assert.deepEqual(reads, Array(2).fill({ paneId: "w1:p1", lines: outputReadLines(2), format: "ansi" }));
});

test("lists sign-ins, ends another one, and signs this one out", async (context) => {
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const app = await startServer({ async snapshot() { return {}; } }, { auth });
  context.after(() => closeServer(app.server));
  const signIn = async (userAgent) => {
    const response = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: app.baseUrl, "User-Agent": userAgent },
      body: JSON.stringify({ password: "secret" }),
    });
    const cookie = response.headers.get("set-cookie").split(";", 1)[0];
    const { launchToken } = await response.json();
    return {
      "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token",
      "X-Herdr-Launch-Token": launchToken, Cookie: cookie, Origin: app.baseUrl,
    };
  };
  const phone = await signIn("Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36");
  const laptop = await signIn("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0");

  const listed = await (await fetch(`${app.baseUrl}/api/auth/sessions`, { headers: laptop })).json();
  assert.equal(listed.sessions.length, 2);
  const current = listed.sessions.find((session) => session.current);
  const other = listed.sessions.find((session) => !session.current);
  assert.match(current.agent, /Firefox/);
  assert.match(other.agent, /Chrome/);
  assert.equal(JSON.stringify(listed).includes(phone.Cookie.split("=")[1]), false, "no token is listed");

  const end = await fetch(`${app.baseUrl}/api/auth/sessions/end`, {
    method: "POST", headers: laptop, body: JSON.stringify({ id: other.id }),
  });
  assert.equal(end.status, 200);
  assert.equal((await fetch(`${app.baseUrl}/api/auth/sessions`, { headers: phone })).status, 401);
  const again = await fetch(`${app.baseUrl}/api/auth/sessions/end`, {
    method: "POST", headers: laptop, body: JSON.stringify({ id: other.id }),
  });
  assert.equal(again.status, 404);

  const unauthorizedWrite = await fetch(`${app.baseUrl}/api/auth/logout`, {
    method: "POST", headers: { ...laptop, "X-Herdr-CSRF": "wrong" }, body: "{}",
  });
  assert.equal(unauthorizedWrite.status, 403);
  const logout = await fetch(`${app.baseUrl}/api/auth/logout`, { method: "POST", headers: laptop, body: "{}" });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /herdr_session=;.*Max-Age=0/);
  assert.equal((await fetch(`${app.baseUrl}/api/auth/sessions`, { headers: laptop })).status, 401);
});

test("signing out everywhere ends every session, the caller's too", async (context) => {
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const app = await startServer({ async snapshot() { return {}; } }, { auth });
  context.after(() => closeServer(app.server));
  const response = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "secret" }),
  });
  const headers = {
    "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token",
    "X-Herdr-Launch-Token": (await response.json()).launchToken,
    Cookie: response.headers.get("set-cookie").split(";", 1)[0], Origin: app.baseUrl,
  };
  const all = await fetch(`${app.baseUrl}/api/auth/sessions/end-all`, { method: "POST", headers, body: "{}" });
  assert.equal(all.status, 200);
  assert.equal((await fetch(`${app.baseUrl}/api/auth/sessions`, { headers })).status, 401);
});

test("a browser that signs in again replaces its own entry; its device cookie outlives sign-out", async (context) => {
  // Each sign-in here comes well after the last, as a person signs in again.
  let clock = Date.now();
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"), { now: () => clock });
  const app = await startServer({ async snapshot() { return {}; } }, { auth });
  context.after(() => closeServer(app.server));
  const signIn = async (cookie = "") => {
    clock += 31_000;
    const response = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: app.baseUrl, "X-Forwarded-Proto": "https", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ password: "secret" }),
    });
    assert.equal(response.status, 200);
    const [session, device] = response.headers.getSetCookie();
    const { launchToken } = await response.json();
    return {
      device, deviceCookie: device.split(";", 1)[0],
      headers: {
        "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", "X-Herdr-Launch-Token": launchToken,
        Cookie: session.split(";", 1)[0], Origin: app.baseUrl,
      },
    };
  };
  const listed = async (headers) => (await (await fetch(`${app.baseUrl}/api/auth/sessions`, { headers })).json()).sessions;

  const first = await signIn();
  assert.match(first.device, /^herdr_device=[A-Za-z0-9_-]{43}; /u);
  for (const attribute of ["Path=/", "HttpOnly", "SameSite=Strict", "Secure", "Max-Age=34560000"]) {
    assert.equal(first.device.split("; ").includes(attribute), true, attribute);
  }
  const other = await signIn();
  assert.notEqual(other.deviceCookie, first.deviceCookie, "each browser gets its own");
  assert.equal((await listed(other.headers)).length, 2, "another browser adds a row");

  const again = await signIn(first.deviceCookie);
  assert.equal(again.deviceCookie, first.deviceCookie);
  assert.equal((await fetch(`${app.baseUrl}/api/auth/sessions`, { headers: first.headers })).status, 401, "the replaced sign-in is refused");
  const sessions = await listed(again.headers);
  assert.equal(sessions.length, 2);
  const text = JSON.stringify(sessions);
  assert.equal(text.includes(first.deviceCookie.split("=")[1]), false, "the device is never listed");
  assert.equal(sessions.some((session) => "device" in session), false);

  // Still signed in: the session cookie alone names what to replace.
  const renewed = await signIn(again.headers.Cookie);
  assert.equal((await fetch(`${app.baseUrl}/api/auth/sessions`, { headers: again.headers })).status, 401);
  assert.equal((await listed(renewed.headers)).length, 2, "replaced, though no device cookie was sent");

  const logout = await fetch(`${app.baseUrl}/api/auth/logout`, { method: "POST", headers: other.headers, body: "{}" });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.headers.getSetCookie().map((cookie) => cookie.split("=", 1)[0]), ["herdr_session"], "sign-out keeps the device cookie");
  assert.equal((await listed(renewed.headers)).length, 1);
  const back = await signIn(other.deviceCookie);
  assert.equal((await listed(back.headers)).length, 2);
  assert.equal((await signIn(other.deviceCookie)).deviceCookie, other.deviceCookie);
  assert.equal((await listed(renewed.headers)).length, 2, "signing in again after sign-out adds no row");
});

test("a passkey sign-in from the same browser replaces its entry too, and leaves other browsers alone", async (context) => {
  // Each sign-in here comes well after the last, as a person signs in again.
  let clock = Date.now();
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"), { now: () => clock });
  const passkeys = {
    get hasCredentials() { return true; },
    async beginAuthentication() { return { attemptId: "passkey-attempt", options: { challenge: "c" } }; },
    async finishAuthentication() { return true; },
  };
  const app = await startServer({ async snapshot() { return {}; } }, { auth, passkeys });
  context.after(() => closeServer(app.server));
  const signedIn = async (response) => {
    assert.equal(response.status, 200);
    const [session, device] = response.headers.getSetCookie();
    const { launchToken } = await response.json();
    return {
      deviceCookie: device.split(";", 1)[0],
      headers: { "X-Herdr-CSRF": "fixed-test-token", "X-Herdr-Launch-Token": launchToken, Cookie: session.split(";", 1)[0], Origin: app.baseUrl },
    };
  };
  const post = (path, body, cookie) => fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const withPasskey = async (cookie) => (clock += 31_000, signedIn(await post("/api/auth/passkeys/login/verify", { attemptId: "passkey-attempt", credential: { id: "c" } }, cookie)));
  const listed = async (headers) => (await (await fetch(`${app.baseUrl}/api/auth/sessions`, { headers })).json()).sessions;

  const other = await signedIn(await post("/api/auth/login", { password: "secret" }));
  const first = await withPasskey();
  assert.equal((await listed(first.headers)).length, 2);
  const again = await withPasskey(first.deviceCookie);
  assert.equal(again.deviceCookie, first.deviceCookie, "the device cookie is kept");
  assert.equal((await fetch(`${app.baseUrl}/api/auth/sessions`, { headers: first.headers })).status, 401, "the replaced sign-in is refused");
  assert.equal((await listed(again.headers)).length, 2, "replaced, not added");
  assert.equal((await fetch(`${app.baseUrl}/api/auth/sessions`, { headers: other.headers })).status, 200, "the other browser is still signed in");
});

test("counts wrong passwords by the caller Tailscale names, not for everyone", () => {
  const request = (headers, remoteAddress = "127.0.0.1") => ({ headers, socket: { remoteAddress } });
  assert.equal(attemptKey(request({ "tailscale-user-login": "Owner@Example.com" })), "login:owner@example.com");
  assert.equal(attemptKey(request({ "x-forwarded-for": "1.2.3.4, 100.64.0.7" })), "address:100.64.0.7");
  assert.equal(attemptKey(request({})), "loopback");
  // Off loopback the headers are client input and are ignored.
  assert.equal(attemptKey(request({ "tailscale-user-login": "owner@example.com" }, "192.168.0.9")), "address:192.168.0.9");
});

test("Herdr machines are added, renamed, turned off and removed through write-protected routes", async (context) => {
  const calls = [];
  const machines = {
    machineIdFor: (serverId) => serverId === "machine-4c139ff50dfb" ? "4c139ff50dfb4a0dcda27e728dc50ef9" : null,
    async add(value) { calls.push(["add", value]); },
    async rename(id, label) { calls.push(["rename", id, label]); },
    async disable(id) { calls.push(["disable", id]); },
    async enable(id) { calls.push(["enable", id]); },
    async remove(id) { calls.push(["remove", id]); },
  };
  const app = await startServer({ async snapshot() { return {}; } }, { machines });
  context.after(() => closeServer(app.server));
  assert.equal((await (await fetch(`${app.baseUrl}/api/bootstrap`)).json()).machines, true, "the page offers to add one");
  const send = (path, method, body, headers = { "X-Herdr-CSRF": "fixed-test-token", Origin: app.baseUrl }) => fetch(`${app.baseUrl}${path}`, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  assert.equal((await send("/api/machines", "POST", { target: "me@lab", label: "Lab" })).status, 200);
  assert.equal((await send("/api/machines/machine-4c139ff50dfb", "PUT", { label: "Desk" })).status, 200);
  assert.equal((await send("/api/machines/machine-4c139ff50dfb/disable", "POST", {})).status, 200);
  assert.equal((await send("/api/machines/machine-4c139ff50dfb/enable", "POST", {})).status, 200);
  assert.equal((await send("/api/machines/machine-4c139ff50dfb", "DELETE")).status, 200);
  assert.deepEqual(calls, [
    ["add", { target: "me@lab", label: "Lab" }],
    ["rename", "4c139ff50dfb4a0dcda27e728dc50ef9", "Desk"],
    ["disable", "4c139ff50dfb4a0dcda27e728dc50ef9"],
    ["enable", "4c139ff50dfb4a0dcda27e728dc50ef9"],
    ["remove", "4c139ff50dfb4a0dcda27e728dc50ef9"],
  ]);

  assert.equal((await send("/api/machines", "POST", { target: "-oProxyCommand=touch /tmp/x" })).status, 400);
  assert.equal((await send("/api/machines/machine-4c139ff50dfb", "PUT", { label: "x".repeat(61) })).status, 400, "names stop at 60 characters");
  assert.equal((await send("/api/machines/machine-000000000000", "DELETE")).status, 404);
  assert.equal((await send("/api/machines", "POST", { target: "me@lab" }, { Origin: app.baseUrl })).status, 403, "the write token is required");
  assert.equal((await send("/api/machines/machine-4c139ff50dfb", "PUT", { label: "x".repeat(60) })).status, 200);
  assert.equal(calls.length, 6);
});

test("a server without Herdr machines does not offer to add one, and has no machine routes", async (context) => {
  const app = await startServer({ async snapshot() { return {}; } });
  context.after(() => closeServer(app.server));
  assert.equal((await (await fetch(`${app.baseUrl}/api/bootstrap`)).json()).machines, false);
  const response = await fetch(`${app.baseUrl}/api/machines`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", Origin: app.baseUrl }, body: "{}",
  });
  assert.equal(response.status, 404);
});
