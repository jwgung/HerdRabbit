import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";

async function startServer({ herdr, push, notificationMonitor }) {
  const created = createHerdrHttpServer({
    herdr,
    push,
    notificationMonitor,
    csrfToken: "fixed-test-token",
    logger: { error() {} },
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  return {
    ...created,
    baseUrl: `http://127.0.0.1:${created.server.address().port}`,
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

const subscription = {
  endpoint: "https://push.example.test/device-1",
  expirationTime: null,
  keys: { p256dh: "device-public-key", auth: "device-auth-key" },
};

test("exposes the VAPID key and protects push subscription writes", async (context) => {
  const calls = [];
  const app = await startServer({
    herdr: { async snapshot() { return {}; } },
    push: {
      publicKey: "public-vapid-key",
      async subscribe(value) { calls.push(["subscribe", value]); },
      async unsubscribe(value) { calls.push(["unsubscribe", value]); },
    },
    notificationMonitor: {
      async poll() { calls.push(["poll"]); },
    },
  });
  context.after(() => closeServer(app.server));

  const bootstrap = await fetch(`${app.baseUrl}/api/bootstrap`).then((response) => response.json());
  assert.equal(bootstrap.pushPublicKey, "public-vapid-key");

  const rejected = await fetch(`${app.baseUrl}/api/push/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ subscription }),
  });
  assert.equal(rejected.status, 403);

  const headers = {
    "Content-Type": "application/json",
    "X-Herdr-CSRF": "fixed-test-token",
    Origin: app.baseUrl,
  };
  const added = await fetch(`${app.baseUrl}/api/push/subscriptions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ subscription }),
  });
  assert.equal(added.status, 201);

  const removed = await fetch(`${app.baseUrl}/api/push/subscriptions`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  assert.equal(removed.status, 204);
  assert.deepEqual(calls, [
    ["subscribe", subscription],
    ["poll"],
    ["unsubscribe", subscription.endpoint],
  ]);
});

test("records submitted pane activity so completion notifications are not missed", async (context) => {
  const calls = [];
  const app = await startServer({
    herdr: {
      async readPane() { return "$ "; },
      async sendText(...args) { calls.push(["send", ...args]); },
    },
    push: { publicKey: "public-vapid-key" },
    notificationMonitor: {
      recordRequest(...args) { calls.push(["request", ...args]); },
    },
  });
  context.after(() => closeServer(app.server));
  const headers = {
    "Content-Type": "application/json",
    "X-Herdr-CSRF": "fixed-test-token",
    Origin: app.baseUrl,
  };

  const response = await fetch(`${app.baseUrl}/api/panes/w1%3Ap1/text`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "알림 문구를 바꿔줘", submit: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    ["send", "w1:p1", "알림 문구를 바꿔줘", { submit: true }],
    ["request", "w1:p1", "알림 문구를 바꿔줘"],
  ]);
});

test("a message sent over HTTP while the pane asks for a password is marked secret and records no request", async (context) => {
  const calls = [];
  let screen = "[sudo] password for alice: ";
  const app = await startServer({
    herdr: {
      async readPane() { return screen; },
      async sendText(...args) { calls.push(["send", ...args]); },
    },
    push: { publicKey: "public-vapid-key" },
    notificationMonitor: {
      recordRequest(...args) { calls.push(["request", ...args]); },
    },
  });
  context.after(() => closeServer(app.server));
  const send = (text) => fetch(`${app.baseUrl}/api/panes/w1%3Ap1/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", Origin: app.baseUrl },
    body: JSON.stringify({ text, submit: true }),
  });

  assert.deepEqual(await (await send("hunter2")).json(), { ok: true, secret: true });
  screen = "$ ";
  assert.deepEqual(await (await send("ls")).json(), { ok: true });
  assert.deepEqual(calls, [
    ["send", "w1:p1", "hunter2", { submit: true }],
    ["send", "w1:p1", "ls", { submit: true }],
    ["request", "w1:p1", "ls"],
  ]);
});

test("a message whose screen could not be read is not recorded, in case it answered a password prompt", async (context) => {
  const calls = [];
  const app = await startServer({
    herdr: {
      async readPane() { throw new Error("herdr did not answer"); },
      async sendText(...args) { calls.push(["send", ...args]); },
    },
    push: { publicKey: "public-vapid-key" },
    notificationMonitor: { recordRequest(...args) { calls.push(["request", ...args]); } },
  });
  context.after(() => closeServer(app.server));
  const response = await fetch(`${app.baseUrl}/api/panes/w1%3Ap1/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", Origin: app.baseUrl },
    body: JSON.stringify({ text: "maybe a password", submit: true }),
  });
  assert.deepEqual(await response.json(), { ok: true, secret: true });
  assert.deepEqual(calls, [["send", "w1:p1", "maybe a password", { submit: true }]]);
});
