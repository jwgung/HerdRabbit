import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { SECRET, machine, stagedLocation, stagingDirectoryOf, writeClaude } from "./fixtures/ai-accounts.mjs";

const LINK_ID = "link_22222222-2222-2222-2222-222222222222";
const SESSION = "hs_ZGVmYXVsdA";

// A Herdr that opens a project with one shell pane and remembers what was typed.
function fakeHerdr({ prefix = "" } = {}) {
  const calls = [];
  let count = 1;
  let workspaces = [{ workspace_id: `${prefix}w1`, label: "main", herdr_session_id: SESSION }];
  let panes = [{ pane_id: `${prefix}w1:p1`, workspace_id: `${prefix}w1` }];
  return {
    calls,
    async snapshot() {
      return { herdr_sessions: [{ session_id: SESSION, name: "default", running: true, available: true }],
        workspaces: [...workspaces], tabs: [], panes: [...panes], agents: [] };
    },
    async createWorkspace(label, sessionId) {
      calls.push(["createWorkspace", label, sessionId]);
      count += 1;
      workspaces.push({ workspace_id: `${prefix}w${count}`, label, herdr_session_id: SESSION });
      panes.push({ pane_id: `${prefix}w${count}:p1`, workspace_id: `${prefix}w${count}` });
    },
    async closeWorkspace(id) {
      calls.push(["closeWorkspace", id]);
      workspaces = workspaces.filter((item) => item.workspace_id !== id);
      panes = panes.filter((item) => item.workspace_id !== id);
    },
    async sendText(id, text, options) { calls.push(["sendText", id, text, options]); },
  };
}

async function listen(t, options) {
  const created = createHerdrHttpServer({ csrfToken: "fixed-test-token", logger: { error() {} }, ...options });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  t.after(() => new Promise((resolve) => created.server.close(resolve)));
  return `http://127.0.0.1:${created.server.address().port}`;
}

function client(base) {
  const seen = [];
  const request = async (path, { method = "POST", body, headers } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: headers ?? { "content-type": "application/json", "x-herdr-csrf": "fixed-test-token", origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    seen.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { request, seen };
}

test("account changes need the write token", async (t) => {
  const { accounts } = await machine(t);
  const base = await listen(t, { herdr: fakeHerdr(), aiAccounts: accounts });
  const { request } = client(base);
  const refused = await request("/api/ai-accounts/current", {
    body: { cli: "claude" }, headers: { "content-type": "application/json", origin: base },
  });
  assert.equal(refused.status, 403);
  const listed = await request("/api/ai-accounts", { method: "GET", headers: {} });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.server, "local");
  // A listing can wait on a Herdr machine, so another site may not start one.
  const fromElsewhere = await request("/api/ai-accounts", { method: "GET", headers: { origin: "https://example.com" } });
  assert.equal(fromElsewhere.status, 403);
  const crossSite = await request("/api/ai-accounts", { method: "GET", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  const oddId = await request("/api/ai-accounts/logins/..%2F..%2Fx/cancel", { body: { cli: "claude" } });
  assert.equal(oddId.status, 400, "a sign-in id the manager did not issue is refused");
});

test("a sign-in opens a project of its own and closes it when done", async (t) => {
  const { accounts, claude } = await machine(t);
  const herdr = fakeHerdr();
  const base = await listen(t, { herdr, aiAccounts: accounts });
  const { request, seen } = client(base);
  const live = await readFile(claude.credentials, "utf8");

  const started = await request("/api/ai-accounts/logins", { body: { cli: "claude" } });
  assert.equal(started.status, 201);
  assert.equal(started.body.workspaceId, "w2");
  assert.equal(started.body.paneId, "w2:p1");
  const [, label] = herdr.calls.find(([name]) => name === "createWorkspace");
  assert.match(label, /^AI login: Claude Code \([a-f0-9-]{8}\)$/u);
  const [, paneId, command, options] = herdr.calls.find(([name]) => name === "sendText");
  assert.equal(paneId, "w2:p1");
  assert.match(command, /^env CLAUDE_CONFIG_DIR='.+' claude auth login$/u);
  assert.deepEqual(options, { submit: true });

  await writeClaude(stagedLocation("claude", stagingDirectoryOf(command)), { uuid: "uuid-b", email: "b@example.com", token: "b1" });
  const finished = await request(`/api/ai-accounts/logins/${started.body.loginId}/finish`, {
    body: { cli: "claude", workspaceId: "w1" },
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.account.email, "b@example.com");
  assert.ok(!herdr.calls.some(([name]) => name === "closeWorkspace"), "a project that is not a sign-in stays open");

  const again = await request("/api/ai-accounts/logins", { body: { cli: "claude" } });
  await request(`/api/ai-accounts/logins/${again.body.loginId}/cancel`, { body: { cli: "claude", workspaceId: again.body.workspaceId } });
  assert.deepEqual(herdr.calls.filter(([name]) => name === "closeWorkspace"), [["closeWorkspace", again.body.workspaceId]]);

  assert.equal(await readFile(claude.credentials, "utf8"), live);
  assert.ok(!seen.join("\n").includes(SECRET));
});

test("a sign-in must run on the server it is for", async (t) => {
  const { accounts } = await machine(t);
  const base = await listen(t, { herdr: fakeHerdr(), aiAccounts: accounts });
  const { request } = client(base);
  const refused = await request("/api/ai-accounts/logins", { body: { cli: "codex", herdrSessionId: `${LINK_ID}!${SESSION}` } });
  assert.equal(refused.status, 400);
  const listed = await accounts.list();
  assert.ok(listed.clis.every((cli) => cli.accounts.length === 0));
});

test("a switch with agents running answers with the panes and waits for confirmation", async (t) => {
  const { accounts } = await machine(t, { running: [{ paneId: "w1:p1", agent: "claude", label: "main" }] });
  const herdr = fakeHerdr();
  const base = await listen(t, { herdr, aiAccounts: accounts });
  const { request, seen } = client(base);
  const started = await request("/api/ai-accounts/logins", { body: { cli: "claude" } });
  const [, , command] = herdr.calls.find(([name]) => name === "sendText");
  await writeClaude(stagedLocation("claude", stagingDirectoryOf(command)), { uuid: "uuid-b", email: "b@example.com", token: "b1" });
  const { body: { account } } = await request(`/api/ai-accounts/logins/${started.body.loginId}/finish`, { body: { cli: "claude" } });

  const warned = await request("/api/ai-accounts/switch", { body: { cli: "claude", account: account.id } });
  assert.equal(warned.status, 409);
  assert.equal(warned.body.error.code, "agents_running");
  assert.deepEqual(warned.body.error.details, { panes: [{ paneId: "w1:p1", label: "main" }] });

  const switched = await request("/api/ai-accounts/switch", { body: { cli: "claude", account: account.id, confirmRunning: true } });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.account.email, "b@example.com");
  const invalid = await request("/api/ai-accounts/remove", { body: { cli: "claude", account: "../../x" } });
  assert.equal(invalid.status, 400);
  assert.ok(!seen.join("\n").includes(SECRET));
});

