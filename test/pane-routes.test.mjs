import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { createPasswordConfiguration, PasswordAuth } from "../src/password-auth.mjs";

// What every /api/panes/:id/... route has in common, however it is built:
// behind the sign-in gate, the write token asked for before anything else of
// the request is looked at, a bad pane id a 400, and any other method a 404
// or 405. Each route's own behaviour is tested where its feature is.

const CSRF = "fixed-test-token";
const PANE = "w1%3Ap1";
const BAD_PANE = "%E0%A4%A";

// Write routes (POST) and read routes (GET), as the page calls them.
const WRITES = [
  "split", "close", "zoom", "move", "swap", "relocate", "even-layout", "move-out",
  "prompt/answer", "text", "keys", "find", "reveal", "scroll-bottom",
];
const READS = ["layout", "output", "conversation", "conversation/tools/t1", "commands", "prompt"];

function recordingHerdr() {
  const calls = [];
  const record = (name, result = {}) => async (...args) => { calls.push([name, ...args]); return result; };
  return {
    calls,
    snapshot: async () => ({ workspaces: [], tabs: [], panes: [], agents: [] }),
    readPane: async () => "",
    splitPane: record("splitPane"),
    closePane: record("closePane"),
    zoomPane: record("zoomPane"),
    movePaneSplit: record("movePaneSplit"),
    swapPanes: record("swapPanes"),
    relocatePane: record("relocatePane"),
    evenLayout: record("evenLayout"),
    movePaneOut: record("movePaneOut"),
    paneLayout: record("paneLayout"),
    sendText: record("sendText"),
    sendKeys: record("sendKeys"),
    paneFind: record("paneFind"),
    paneReveal: record("paneReveal"),
    paneScrollToBottom: record("paneScrollToBottom"),
  };
}

async function start(herdr, options = {}) {
  const created = createHerdrHttpServer({ herdr, csrfToken: CSRF, logger: { error() {} }, ...options });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  return { ...created, baseUrl: `http://127.0.0.1:${created.server.address().port}` };
}

const stop = (app) => new Promise((resolve, reject) => app.server.close((error) => (error ? reject(error) : resolve())));

const writeHeaders = (app) => ({ "Content-Type": "application/json", Origin: app.baseUrl, "X-Herdr-CSRF": CSRF });
const post = (app, path, { body = {}, headers = writeHeaders(app) } = {}) =>
  fetch(`${app.baseUrl}/api/panes/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const errorCode = async (response) => (await response.json()).error?.code;

test("every pane route is behind the sign-in gate", async (context) => {
  const herdr = recordingHerdr();
  const app = await start(herdr, { auth: new PasswordAuth(await createPasswordConfiguration("secret")) });
  context.after(() => stop(app));
  for (const tail of WRITES) {
    const response = await post(app, `${PANE}/${tail}`);
    assert.equal(response.status, 401, `POST ${tail}`);
    assert.equal(await errorCode(response), "authentication_required", `POST ${tail}`);
  }
  for (const tail of READS) {
    const response = await fetch(`${app.baseUrl}/api/panes/${PANE}/${tail}`);
    assert.equal(response.status, 401, `GET ${tail}`);
    assert.equal(await errorCode(response), "authentication_required", `GET ${tail}`);
  }
  assert.deepEqual(herdr.calls, [], "nothing reached Herdr");
});

test("a write without the token is refused before the pane id is even read", async (context) => {
  const herdr = recordingHerdr();
  const app = await start(herdr);
  context.after(() => stop(app));
  const noToken = { "Content-Type": "application/json", Origin: app.baseUrl };
  for (const tail of WRITES) {
    for (const pane of [PANE, BAD_PANE]) {
      const response = await post(app, `${pane}/${tail}`, { headers: noToken });
      assert.equal(response.status, 403, `${tail} on ${pane}`);
      assert.equal(await errorCode(response), "csrf_rejected", `${tail} on ${pane}`);
    }
  }
  assert.deepEqual(herdr.calls, []);
});

test("a pane id that does not decode is a 400, for writes with the token and for reads", async (context) => {
  const herdr = recordingHerdr();
  const app = await start(herdr);
  context.after(() => stop(app));
  for (const tail of WRITES) {
    const response = await post(app, `${BAD_PANE}/${tail}`);
    assert.equal(response.status, 400, `POST ${tail}`);
  }
  for (const tail of READS) {
    const response = await fetch(`${app.baseUrl}/api/panes/${BAD_PANE}/${tail}`);
    assert.equal(response.status, 400, `GET ${tail}`);
  }
  assert.deepEqual(herdr.calls, []);
});

test("another method on a pane route is a 404, and a method the server never takes a 405", async (context) => {
  const herdr = recordingHerdr();
  const app = await start(herdr);
  context.after(() => stop(app));
  for (const tail of WRITES) {
    assert.equal((await fetch(`${app.baseUrl}/api/panes/${PANE}/${tail}`)).status, 404, `GET ${tail}`);
    const put = await fetch(`${app.baseUrl}/api/panes/${PANE}/${tail}`, { method: "PUT", headers: writeHeaders(app), body: "{}" });
    assert.equal(put.status, 405, `PUT ${tail}`);
    assert.equal(put.headers.get("allow"), "GET, HEAD, POST, DELETE");
  }
  for (const tail of READS) {
    assert.equal((await post(app, `${PANE}/${tail}`)).status, 404, `POST ${tail}`);
    const put = await fetch(`${app.baseUrl}/api/panes/${PANE}/${tail}`, { method: "PUT", headers: writeHeaders(app), body: "{}" });
    assert.equal(put.status, 405, `PUT ${tail}`);
  }
  assert.equal((await fetch(`${app.baseUrl}/api/panes/${PANE}/nothing`)).status, 404);
  assert.equal((await post(app, `${PANE}/nothing`)).status, 404);
  assert.deepEqual(herdr.calls, []);
});

test("zoom toggles a pane and refuses any other mode", async (context) => {
  const herdr = recordingHerdr();
  const app = await start(herdr);
  context.after(() => stop(app));
  const refused = await post(app, `${PANE}/zoom`, { body: { mode: "on" } });
  assert.equal(refused.status, 400);
  assert.deepEqual(herdr.calls, []);
  const done = await post(app, `${PANE}/zoom`, { body: { mode: "toggle" } });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), {});
  assert.deepEqual(herdr.calls, [["zoomPane", "w1:p1"]]);
});

test("closing a pane needs the page's confirmation", async (context) => {
  const herdr = recordingHerdr();
  const app = await start(herdr);
  context.after(() => stop(app));
  const refused = await post(app, `${PANE}/close`, { body: {} });
  assert.equal(refused.status, 400);
  assert.equal(await errorCode(refused), "confirmation_required");
  assert.deepEqual(herdr.calls, []);
  const done = await post(app, `${PANE}/close`, { body: { confirmed: true } });
  assert.equal(done.status, 200);
  assert.deepEqual(herdr.calls, [["closePane", "w1:p1"]]);
});

test("relocating a pane names its target and side, and needs a target", async (context) => {
  const herdr = recordingHerdr();
  const app = await start(herdr);
  context.after(() => stop(app));
  const refused = await post(app, `${PANE}/relocate`, { body: { side: "left" } });
  assert.equal(refused.status, 400);
  assert.deepEqual(herdr.calls, []);
  const done = await post(app, `${PANE}/relocate`, { body: { targetPaneId: "w1:p2", side: "left" } });
  assert.equal(done.status, 200);
  assert.deepEqual(herdr.calls, [["relocatePane", "w1:p1", "w1:p2", "left"]]);
});

test("a PC that cannot rearrange panes yet answers link_unsupported, not a crash", async (context) => {
  const herdr = recordingHerdr();
  delete herdr.paneLayout;
  delete herdr.swapPanes;
  delete herdr.evenLayout;
  const app = await start(herdr);
  context.after(() => stop(app));
  for (const response of [
    await fetch(`${app.baseUrl}/api/panes/${PANE}/layout`),
    await post(app, `${PANE}/swap`, { body: { targetPaneId: "w1:p2" } }),
    await post(app, `${PANE}/even-layout`),
  ]) {
    assert.equal(response.status, 501);
    assert.equal(await errorCode(response), "link_unsupported");
  }
});
