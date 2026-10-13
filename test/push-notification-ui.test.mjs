import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applicationServerKeyBytes,
  pushButtonPresentation,
} from "../public/push-notifications.js";

const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("offers the notification toggle as an item of the settings menu, hidden when push is unsupported", () => {
  assert.doesNotMatch(page, /id="notification-toggle"/);
  assert.match(app, /key: "notifications", label: "Notifications"/);
  assert.match(app, /notifications\.hidden = !push \|\| push\.hidden;/);
});

test("describes enabled, disabled, denied, and unavailable push states", () => {
  assert.deepEqual(
    pushButtonPresentation({ supported: true, permission: "granted", subscribed: true }),
    { hidden: false, disabled: false, pressed: true, label: "Turn off notifications", state: "enabled" },
  );
  assert.deepEqual(
    pushButtonPresentation({ supported: true, permission: "default", subscribed: false }),
    { hidden: false, disabled: false, pressed: false, label: "Turn on notifications", state: "disabled" },
  );
  assert.deepEqual(
    pushButtonPresentation({ supported: true, permission: "denied", subscribed: false }),
    { hidden: false, disabled: true, pressed: false, label: "Allow notifications in your browser settings", state: "denied" },
  );
  assert.equal(
    pushButtonPresentation({ supported: false, permission: "default", subscribed: false }).hidden,
    true,
  );
});

test("decodes a URL-safe VAPID public key for PushManager", () => {
  assert.deepEqual(
    [...applicationServerKeyBytes("AQID-_8")],
    [1, 2, 3, 251, 255],
  );
});

test("the service worker receives pushes and opens the targeted pane", () => {
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /showNotification/);
  assert.match(worker, /addEventListener\("notificationclick"/);
  assert.match(worker, /openWindow/);
});

test("notification artwork has transparency instead of rendering as a square", async () => {
  const artwork = [
    {
      pngPath: "/icons/notification-icon-192.png",
      svgPath: "../public/icons/notification-icon.svg",
    },
    {
      pngPath: "/icons/notification-badge-96.png",
      svgPath: "../public/icons/notification-badge.svg",
    },
  ];

  for (const { pngPath, svgPath } of artwork) {
    assert.match(worker, new RegExp(`(?:icon|badge):\\s*"${pngPath}"`, "u"));
    const png = await readFile(new URL(`../public${pngPath}`, import.meta.url));
    const svg = await readFile(new URL(svgPath, import.meta.url), "utf8");
    assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71]);
    assert.ok(
      png[25] === 4 || png[25] === 6,
      `${pngPath} must have an alpha channel`,
    );
    assert.doesNotMatch(svg, /<(?:rect|image)\b/u);
    assert.match(svg, /fill="none"/u);
  }
});

test("subscribes on demand and restores the pane from a notification URL", () => {
  assert.match(app, /Notification\.requestPermission\(\)/);
  assert.match(app, /pushManager\.subscribe/);
  assert.match(app, /\/api\/push\/subscriptions/);
  assert.match(app, /searchParams\.get\("pane"\)/);
});

test("clears delivered notifications once the app is in front of the user", () => {
  assert.match(app, /async function dismissDeliveredNotifications\(\)/);
  assert.match(app, /registration\.getNotifications/);
  assert.match(
    app,
    /addEventListener\("visibilitychange", \(\) => \{[\s\S]*?void dismissDeliveredNotifications\(\);/,
    "returning to the app must clear the notifications that opened it",
  );
});

test("clears the notifications of the pane a click opens", () => {
  assert.match(worker, /async function dismissPaneNotifications\(paneId\)/);
  assert.match(worker, /notification\.data\?\.paneId === paneId/);
});
