import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";

const LINK = "link_11111111-1111-1111-1111-111111111111";
const OLD = "link_22222222-2222-2222-2222-222222222222";
const CHECK = {
  checkedAt: "2026-10-17T00:00:00.000Z", current: { sha: "abc1234", version: "2.0.0" },
  latest: { sha: "def5678", version: "2.0.1" }, available: true, notes: ["Release 2.0.1"], blocked: null, error: null,
};
const IDLE = { state: "idle", startedAt: null, finishedAt: null, exitCode: null, reason: null, log: "", version: "2.0.0" };

function fakeUpdater(calls) {
  return {
    async check(options) { calls.push(["check", options]); return CHECK; },
    async runStatus() { calls.push(["runStatus"]); return IDLE; },
    async start() { calls.push(["start"]); return { ...IDLE, state: "running" }; },
  };
}

async function fixture(context, { updater = undefined } = {}) {
  const calls = [];
  const remoteCalls = [];
  const remote = {
    async updateCheck(options) { remoteCalls.push(["check", options]); return { ...CHECK, current: { sha: "1111111", version: "1.9.0" } }; },
    async updateStatus() { remoteCalls.push(["status"]); return { ...IDLE, state: "running", log: "  > Fetching main" }; },
    async updateRun() { remoteCalls.push(["run"]); return { ...IDLE, state: "running" }; },
  };
  // A connected PC from before in-app update: its link says no.
  const old = { async updateCheck() { return null; }, async updateStatus() { return null; } };
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [], agents: [] }; },
    updateClient: (id) => (id === LINK ? remote : id === OLD ? old : null),
  };
  const app = createHerdrHttpServer({
    herdr,
    csrfToken: "csrf",
    logger: { error() {} },
    auth: {
      required: true,
      hasValidSession: (cookie) => cookie === "session=valid",
      hasValidLaunchToken: (token) => token === "launch",
      onSessionsEnded: () => () => {},
    },
    updater: updater === undefined ? fakeUpdater(calls) : updater,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const session = { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" };
  const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers: { ...session, ...headers } });
  const post = (body, headers = {}) => fetch(`${origin}/api/update/run`, {
    method: "POST",
    headers: { ...session, "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
  return { origin, calls, remoteCalls, get, post };
}

test("the update routes sit behind the sign-in", async (context) => {
  const { origin, calls } = await fixture(context);
  for (const [method, path] of [["GET", "/api/update"], ["GET", "/api/update/run"], ["POST", "/api/update/run"]]) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "csrf" }, body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal((await response.json()).error.code, "authentication_required");
  }
  assert.deepEqual(calls, []);
});

test("this PC's check and run status answer for it, with which run of the server answered", async (context) => {
  const { get, calls } = await fixture(context);
  const check = await (await get("/api/update")).json();
  assert.deepEqual(check, { ...CHECK, server: "local", supported: true });
  await get("/api/update?fresh=1");
  assert.deepEqual(calls, [["check", { fresh: false }], ["check", { fresh: true }]]);
  const status = await (await get("/api/update/run")).json();
  assert.equal(status.state, "idle");
  assert.equal(status.version, "2.0.0");
  assert.match(status.boot, /^[A-Za-z0-9_-]{12}$/u);
});

test("reads are same-origin only", async (context) => {
  const { get, calls } = await fixture(context);
  const response = await get("/api/update", { Origin: "https://evil.example" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "origin_rejected");
  assert.deepEqual(calls, []);
});

test("starting an update needs the write token, the same origin, and is limited", async (context) => {
  const { post, calls } = await fixture(context);
  let response = await post({}, { "X-Herdr-CSRF": "wrong" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "csrf_rejected");
  response = await post({}, { Origin: "https://evil.example" });
  assert.equal(response.status, 403);
  response = await post({}, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
  response = await post({});
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ...IDLE, state: "running", server: "local", supported: true });
  response = await post({ server: "local" });
  assert.equal(response.status, 429);
  assert.deepEqual(calls, [["start"]]);
});

test("a connected PC is asked about and updated through its link, by id alone", async (context) => {
  const { get, post, remoteCalls, calls } = await fixture(context);
  const check = await (await get(`/api/update?server=${LINK}&fresh=1`)).json();
  assert.equal(check.server, LINK);
  assert.equal(check.supported, true);
  assert.equal(check.current.version, "1.9.0");
  const status = await (await get(`/api/update/run?server=${LINK}`)).json();
  assert.equal(status.state, "running");
  assert.equal("boot" in status, false, "only this PC says which run of it answered");
  const response = await post({ server: LINK, path: "/etc", ref: "evil" });
  assert.equal(response.status, 202);
  assert.deepEqual(remoteCalls, [["check", { fresh: true }], ["status"], ["run"]]);
  assert.deepEqual(calls, [], "this PC's own updater is not touched");

  const old = await (await get(`/api/update?server=${OLD}`)).json();
  assert.deepEqual(old, { server: OLD, supported: false });
  for (const server of ["link_33333333-3333-3333-3333-333333333333", 42]) {
    const unknown = await post({ server });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "unknown_server");
  }
  assert.equal((await get("/api/update?server=nope")).status, 404);
});

test("a PC that cannot update, or a run that did not start, does not use up the minute", async (context) => {
  const { post, remoteCalls } = await fixture(context);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await post({ server: OLD });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error.code, "link_unsupported");
  }
  assert.deepEqual(remoteCalls, []);
  // A real run afterwards is allowed, and only then is the minute taken.
  assert.equal((await post({ server: LINK })).status, 202);
  assert.equal((await post({ server: LINK })).status, 429);
});

test("a refused local start does not use up the minute", async (context) => {
  let refuse = true;
  const calls = [];
  const updater = {
    ...fakeUpdater(calls),
    async start() {
      if (refuse) throw Object.assign(new Error("up to date"), { status: 409, code: "up_to_date", expose: true });
      return { ...IDLE, state: "running" };
    },
  };
  const { post } = await fixture(context, { updater });
  assert.notEqual((await post({})).status, 202);
  refuse = false;
  assert.equal((await post({})).status, 202);
});

test("a PC that cannot update itself says so", async (context) => {
  const { get, post } = await fixture(context, { updater: null });
  assert.deepEqual(await (await get("/api/update")).json(), { server: "local", supported: false });
  const response = await post({});
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "update_unavailable");
});
