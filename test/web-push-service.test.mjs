import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWebPushService } from "../src/web-push-service.mjs";

const subscription = {
  endpoint: "https://push.example.test/device-1",
  expirationTime: null,
  keys: {
    p256dh: "BNcY0-test-device-public-key",
    auth: "test-auth-secret",
  },
};

test("persists VAPID keys and deduplicated device subscriptions privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herd-rabbit-push-"));
  const filePath = join(directory, "push.json");
  const setupCalls = [];
  const fakeWebPush = {
    generateVAPIDKeys() {
      return { publicKey: "public-vapid", privateKey: "private-vapid" };
    },
    setVapidDetails(...args) {
      setupCalls.push(args);
    },
    async sendNotification() {},
  };

  const service = await loadWebPushService(filePath, { webPush: fakeWebPush });
  assert.equal(service.publicKey, "public-vapid");
  assert.deepEqual(setupCalls, [[
    "https://github.com/jwgung/HerdRabbit",
    "public-vapid",
    "private-vapid",
  ]]);

  await service.subscribe(subscription);
  await service.subscribe(subscription);
  assert.equal(service.hasSubscriptions(), true);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(stored.subscriptions.length, 1);

  const reloaded = await loadWebPushService(filePath, { webPush: fakeWebPush });
  assert.equal(reloaded.publicKey, "public-vapid");
  assert.equal(reloaded.hasSubscriptions(), true);
});

test("sends JSON notifications and removes expired subscriptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herd-rabbit-push-"));
  const filePath = join(directory, "push.json");
  const sends = [];
  const fakeWebPush = {
    generateVAPIDKeys() {
      return { publicKey: "public-vapid", privateKey: "private-vapid" };
    },
    setVapidDetails() {},
    async sendNotification(target, payload) {
      sends.push({ target, payload: JSON.parse(payload) });
      const error = new Error("gone");
      error.statusCode = 410;
      throw error;
    },
  };
  const service = await loadWebPushService(filePath, {
    webPush: fakeWebPush,
    logger: { error() {} },
  });
  await service.subscribe(subscription);

  const notification = {
    title: "HerdRabbit · 알림 구현",
    body: "작업을 완료했습니다.",
    tag: "event-1",
    data: { paneId: "w1:p1", status: "done", url: "/?pane=w1%3Ap1" },
  };
  await service.send(notification);

  assert.deepEqual(sends, [{ target: subscription, payload: notification }]);
  assert.equal(service.hasSubscriptions(), false);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).subscriptions, []);
});
