import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PendingInputs, bracketedPaste } from "../src/pending-input.mjs";

function fakeHerdr() {
  const herdr = {
    statuses: { "w1:p1": "working", "w1:p2": "working" },
    screens: {},
    sent: [],
    statusListeners: [],
    async snapshot() {
      return {
        workspaces: [], tabs: [], agents: [],
        panes: Object.entries(herdr.statuses).map(([pane_id, agent_status]) => ({ pane_id, agent: "claude", agent_status })),
      };
    },
    async readPane(paneId) { return herdr.screens[paneId] ?? "> "; },
    async sendText(paneId, text) { herdr.sent.push({ paneId, text }); },
    async sendKeys(paneId, keys) { herdr.sent.push({ paneId, keys }); },
    async watchStatuses(paneIds, onStatus) {
      herdr.statusListeners.push(onStatus);
      return () => {};
    },
  };
  return herdr;
}

async function fixture(context) {
  let authenticated = true;
  const herdr = fakeHerdr();
  const requests = [];
  const pending = new PendingInputs({ herdr, pollMs: 30, enterDelayMs: 0, turnTimeoutMs: 200 });
  const app = createHerdrHttpServer({
    herdr,
    pending,
    csrfToken: "csrf",
    logger: { error() {} },
    notificationMonitor: { recordRequest: (paneId, text) => requests.push({ paneId, text }) },
    auth: {
      required: true,
      hasValidSession: (cookie) => authenticated && cookie === "session=valid",
      hasValidLaunchToken: (token) => authenticated && token === "launch",
      onSessionsEnded: () => () => {},
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" };
  const post = async (path, body, extra = { "X-Herdr-CSRF": "csrf" }) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST", headers: { ...headers, ...extra, "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const list = async (paneId) => (await (await fetch(`${origin}/api/panes/${encodeURIComponent(paneId)}/pending`, { headers })).json()).items;
  const socket = async () => {
    const ws = new WebSocket(`${origin.replace("http", "ws")}/api/terminal`, { origin, headers: { Cookie: "session=valid" } });
    context.after(() => ws.terminate());
    const messages = [];
    ws.on("message", (bytes) => messages.push(JSON.parse(bytes.toString())));
    const next = (predicate) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Missing socket message")), 3000);
      const check = () => {
        const index = messages.findIndex(predicate);
        if (index >= 0) { clearTimeout(timer); resolve(messages.splice(index, 1)[0]); } else setTimeout(check, 5);
      };
      check();
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", csrf: "csrf", launchToken: "launch" }));
    await next((message) => message.type === "ready");
    return { ws, messages, next };
  };
  return { herdr, pending, requests, post, list, socket, logout: () => { authenticated = false; } };
}

const until = async (check) => {
  for (let index = 0; index < 200; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
};

test("the queue routes sit behind the sign-in and the write token", async (context) => {
  const { post, herdr, logout, list } = await fixture(context);
  assert.equal((await post("/api/panes/w1%3Ap1/pending", { text: "x" }, {})).body.error.code, "csrf_rejected");
  assert.deepEqual(await list("w1:p1"), []);
  logout();
  assert.equal((await post("/api/panes/w1%3Ap1/pending", { text: "x" })).status, 401);
  assert.equal((await post("/api/panes/w1%3Ap1/pending/m1", { action: "cancel" })).status, 401);
  assert.deepEqual(herdr.sent, []);
});

test("a queued message is listed, changed, and delivered with paste and Enter once the pane is ready", async (context) => {
  const { post, list, herdr, requests } = await fixture(context);
  const first = await post("/api/panes/w1%3Ap1/pending", { text: "first\nwith two lines" });
  assert.equal(first.status, 200);
  assert.equal(first.body.item.state, "queued");
  const second = await post("/api/panes/w1%3Ap1/pending", { text: "second" });
  const third = await post("/api/panes/w1%3Ap1/pending", { text: "third" });
  const at = (path) => `/api/panes/w1%3Ap1/pending/${encodeURIComponent(path)}`;
  assert.equal((await post(at(third.body.item.id), { action: "up" })).status, 200);
  assert.equal((await post(at(second.body.item.id), { action: "edit", text: "second, edited" })).status, 200);
  assert.equal((await post(at(first.body.item.id), { action: "cancel" })).status, 200);
  assert.deepEqual((await list("w1:p1")).map((item) => item.text), ["third", "second, edited"]);
  assert.equal((await post(at("nope"), { action: "cancel" })).status, 404);
  assert.equal((await post(at(third.body.item.id), { action: "explode" })).body.error.code, "invalid_action");
  assert.equal((await post("/api/panes/w1%3Ap1/pending", { text: "bad\x1b[201~" })).body.error.code, "invalid_text");
  assert.equal((await post("/api/panes/w9%3Ap9/pending", { text: "x" })).status, 404);
  assert.deepEqual(herdr.sent, []);

  herdr.statuses["w1:p1"] = "idle";
  await until(() => herdr.sent.length === 2);
  assert.deepEqual(herdr.sent, [{ paneId: "w1:p1", text: bracketedPaste("third") }, { paneId: "w1:p1", keys: ["enter"] }]);
  assert.deepEqual(requests, [{ paneId: "w1:p1", text: "third" }], "a delivered message is a request like one typed");
  // the turn gate: the agent works on it, is ready again, and the next goes
  herdr.statuses["w1:p1"] = "working";
  await new Promise((resolve) => setTimeout(resolve, 80));
  herdr.statuses["w1:p1"] = "idle";
  await until(() => herdr.sent.length === 4);
  assert.deepEqual(herdr.sent[2], { paneId: "w1:p1", text: bracketedPaste("second, edited") });
  assert.deepEqual(await list("w1:p1"), []);
});

test("a long message in three-byte characters fits the body limit", async (context) => {
  const { post } = await fixture(context);
  const text = "가".repeat(7_000);
  const response = await post("/api/panes/w1%3Ap1/pending", { text });
  assert.equal(response.status, 200);
  assert.equal(response.body.item.text, text);
});

test("an answer to a password prompt is refused, never queued", async (context) => {
  const { post, list, herdr } = await fixture(context);
  herdr.screens["w1:p1"] = "[sudo] password for me:";
  const response = await post("/api/panes/w1%3Ap1/pending", { text: "hunter2" });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "secret_prompt");
  assert.deepEqual(await list("w1:p1"), []);
});

test("send now delivers one message at once while the agent still works", async (context) => {
  const { post, herdr, list } = await fixture(context);
  const queued = await post("/api/panes/w1%3Ap1/pending", { text: "right away" });
  await post("/api/panes/w1%3Ap1/pending", { text: "later" });
  const response = await post(`/api/panes/w1%3Ap1/pending/${queued.body.item.id}`, { action: "send-now" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map((item) => item.text), ["later"]);
  assert.deepEqual(herdr.sent, [{ paneId: "w1:p1", text: bracketedPaste("right away") }, { paneId: "w1:p1", keys: ["enter"] }]);
  assert.deepEqual((await list("w1:p1")).map((item) => item.text), ["later"]);
});

test("watching pages hear the list on every change, and a new socket hears it whole again", async (context) => {
  const { post, socket, herdr } = await fixture(context);
  const first = await socket();
  first.ws.send(JSON.stringify({ type: "watch-pending", paneId: "w1:p1" }));
  assert.deepEqual(await first.next((message) => message.type === "pending-messages"), { type: "pending-messages", pane_id: "w1:p1", items: [] });
  const second = await socket();
  second.ws.send(JSON.stringify({ type: "watch-pending", paneId: "w1:p1" }));
  await second.next((message) => message.type === "pending-messages");
  await post("/api/panes/w1%3Ap1/pending", { text: "for both" });
  for (const page of [first, second]) {
    const pushed = await page.next((message) => message.type === "pending-messages" && message.items.length === 1);
    assert.equal(pushed.items[0].text, "for both");
  }
  // a page that reconnects watches again and gets the whole list
  first.ws.terminate();
  const again = await socket();
  again.ws.send(JSON.stringify({ type: "watch-pending", paneId: "w1:p1" }));
  const whole = await again.next((message) => message.type === "pending-messages");
  assert.deepEqual(whole.items.map((item) => item.text), ["for both"]);
  // delivered: the push says which went, and as what
  herdr.statuses["w1:p1"] = "done";
  const delivered = await again.next((message) => message.type === "pending-messages" && message.removed);
  assert.deepEqual(delivered.items, []);
  assert.equal(delivered.removed[0].outcome, "sent");
  assert.equal(delivered.removed[0].text, "for both");
  // unwatched, nothing more comes
  again.ws.send(JSON.stringify({ type: "unwatch-pending", paneId: "w1:p1" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  again.messages.length = 0;
  await post("/api/panes/w1%3Ap1/pending", { text: "unheard" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(again.messages.some((message) => message.type === "pending-messages"), false);
});

test("one socket watches the queues of a few panes at most", async (context) => {
  const { socket } = await fixture(context);
  const page = await socket();
  for (const id of ["w1:a", "w1:b", "w1:c", "w1:d", "w1:e"]) page.ws.send(JSON.stringify({ type: "watch-pending", paneId: id }));
  const refused = await page.next((message) => message.type === "pending-unavailable");
  assert.deepEqual(refused, { type: "pending-unavailable", pane_id: "w1:e", code: "busy" });
});

test("a status a page's stream hears reaches the queue at once", async (context) => {
  const { post, socket, herdr, pending } = await fixture(context);
  const page = await socket();
  page.ws.send(JSON.stringify({ type: "watch-statuses", paneIds: ["w1:p2"] }));
  await page.next((message) => message.type === "statuses-ready");
  await post("/api/panes/w1%3Ap2/pending", { text: "x" });
  herdr.statusListeners[0]({ pane_id: "w1:p2", agent_status: "working" });
  assert.equal(pending.panes.get("w1:p2").status, "working");
  await page.next((message) => message.type === "status" && message.agent_status === "working");
});
