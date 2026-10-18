const CACHE_NAME = "herd-rabbit-v1.2.71";
const NAVIGATION_CACHE = "herdr-notification-navigation-v1";

async function saveNotificationTarget(target) {
  try {
    const cache = await caches.open(NAVIGATION_CACHE);
    await cache.put("/pending", new Response(JSON.stringify(target)));
  } catch { /* URL and direct delivery still work without cache storage. */ }
}

function relayNotificationTarget(target) {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel("herdr-notification-navigation");
    const finish = (applied) => { clearTimeout(timer); channel.close(); resolve(applied); };
    const timer = setTimeout(() => finish(false), 1_500);
    channel.onmessage = ({ data }) => {
      if (data?.type === "notification-target-applied" && data.id === target.id && data.visible === true) finish(true);
    };
    channel.postMessage({ type: "notification-target", ...target });
  });
}
self.addEventListener("message", (event) => {
  if (event.data?.type === "read-notification-target" || event.data?.type === "complete-notification-target") {
    event.waitUntil((async () => {
      const cache = await caches.open(NAVIGATION_CACHE);
      const pending = await cache.match("/pending");
      const target = pending ? await pending.json() : null;
      if (event.data.type === "complete-notification-target") {
        const applied = target?.id === event.data.id;
        if (applied) await cache.put("/applied", new Response(JSON.stringify({ id: target.id })));
        event.ports?.[0]?.postMessage({ applied });
      } else {
        const applied = await cache.match("/applied");
        const completed = applied ? await applied.json() : null;
        event.ports?.[0]?.postMessage({ target: target?.expiresAt > Date.now() && target.id !== completed?.id ? target : null });
      }
    })().catch(() => event.ports?.[0]?.postMessage({ unavailable: true })));
    return;
  }
  if (event.data?.type === "activate-worker") {
    event.waitUntil(self.skipWaiting());
    return;
  }

});
const APP_SHELL = [
  "/ui/ui.css",
  "/ui/tokens.css",
  "/ui/base.css",
  "/ui/components.css",
  "/",
  "/styles.css?v=1.2.71",
  "/theme.js?v=1.2.71",
  "/app.js?v=1.2.71",
  "/app-update.js?v=1.2.71",
  "/vendor/simplewebauthn-browser.js?v=1.2.71",
  "/terminal-links.js?v=1.2.71",
  "/terminal-connection.js?v=1.2.71",
  "/terminal-status.js?v=1.2.71",
  "/xterm-terminal.js?v=1.2.71",
  "/terminal-widths.js?v=1.2.71",
  "/touch-scroll.js?v=1.2.71",
  "/terminal-selection.js?v=1.2.71",
  "/terminal-find.js?v=1.2.71",
  "/vendor/xterm.mjs?v=1.2.71",
  "/vendor/xterm.css?v=1.2.71",
  "/ui-model.js?v=1.2.71",
  "/key-combinations.js?v=1.2.71",
  "/pane-preference.js?v=1.2.71",
  "/browse-preference.js?v=1.2.71",
  "/workspace-preference.js?v=1.2.71",
  "/terminal-preference.js?v=1.2.71",
  "/completion-preference.js?v=1.2.71",
  "/swipe-dismiss.js?v=1.2.71",
  "/path-links.js?v=1.2.71",
  "/sidebar-drag.js?v=1.2.71",
  "/pane-rename.js?v=1.2.71",
  "/input-history-preference.js?v=1.2.71",
  "/composer-draft-preference.js?v=1.2.71",
  "/secret-prompt.js?v=1.2.71",
  "/key-bar-preference.js?v=1.2.71",
  "/key-bar.css?v=1.2.71",
  "/launch-session.js?v=1.2.71",
  "/push-notifications.js?v=1.2.71",
  "/lens-preference.js?v=1.2.71",
  "/chat/markdown.js?v=1.2.71",
  "/chat/diff.js?v=1.2.71",
  "/chat/work-blocks.js?v=1.2.71",
  "/chat/conversation-refresh.js?v=1.2.71",
  "/chat/chat-view.js?v=1.2.71",
  "/chat/chat-view.css?v=1.2.71",
  "/chat/chat-find.js?v=1.2.71",
  "/chat/chat-activity.js?v=1.2.71",
  "/chat/prompt-card.js?v=1.2.71",
  "/chat/prompt-card.css?v=1.2.71",
  "/chat-font-preference.js?v=1.2.71",
  "/composer-at-files.js?v=1.2.71",
  "/composer-popup.js?v=1.2.71",
  "/composer-slash.js?v=1.2.71",
  "/manifest.webmanifest",
  "/icons/rabbit-outline-v33.svg",
  "/icons/app-icon.svg",
  "/icons/rabbit-outline-32-v33.png",
  "/icons/rabbit-outline-app-192-v35.png",
  "/icons/rabbit-outline-app-512-v35.png",
  "/icons/notification-icon-192.png",
  "/icons/notification-badge-96.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
    self.skipWaiting(),
  ]));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME && name !== NAVIGATION_CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function fetchAndRefreshCache(request) {
  const response = await fetch(request);
  if (response.ok) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    } catch {
      // A cache write failure must not hide a successful network response.
    }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/")),
    );
    return;
  }

  event.respondWith(
    fetchAndRefreshCache(event.request).catch(() => caches.match(event.request)),
  );
});

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data?.json() || {};
  } catch {
    message = {};
  }
  const title = typeof message.title === "string" && message.title
    ? message.title
    : "HerdRabbit";
  const body = typeof message.body === "string"
    ? message.body
    : "Agent status changed.";
  const tag = typeof message.tag === "string" ? message.tag : undefined;
  const data = message.data && typeof message.data === "object" ? message.data : {};
  event.waitUntil((async () => {
    if (await appIsInFront({ paneId: data.paneId, url: data.url, title, body })) return;
    await self.registration.showNotification(title, {
      body,
      tag,
      data,
      icon: "/icons/notification-icon-192.png",
      badge: "/icons/notification-badge-96.png",
      renotify: Boolean(tag),
    });
  })());
});

// A window in front takes the notification itself: silently for the pane it
// shows, as an alert inside the app for any other. Only when none answers does
// the system notification appear.
async function appIsInFront({ paneId, url, title, body }) {
  if (typeof paneId !== "string" || !paneId) return false;
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const responses = await Promise.all(windows.filter((client) =>
      client.visibilityState === "visible" && new URL(client.url).origin === self.location.origin,
    ).map((client) => requestClient(client, { type: "query-viewing-pane", paneId, url, title, body }, 500)));
    return responses.some((response) => response?.viewing === true);
  } catch {
    return false;
  }
}

function notificationUrl(value) {
  try {
    const target = new URL(value || "/", self.location.origin);
    return target.origin === self.location.origin
      ? target.href
      : self.location.origin;
  } catch {
    return self.location.origin;
  }
}

// Every pane gets its own tag, so opening one pane leaves the notifications of
// the other panes on screen. Clear the ones for the pane being opened.
async function dismissPaneNotifications(paneId) {
  if (!paneId || typeof self.registration.getNotifications !== "function") return;
  try {
    const delivered = await self.registration.getNotifications();
    for (const notification of delivered) {
      if (notification.data?.paneId === paneId) notification.close();
    }
  } catch {
    // Failing to tidy notifications must not stop the app from opening.
  }
}

function requestClient(client, message, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (received) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(received);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    channel.port1.onmessage = (event) => finish(event.data);
    try {
      client.postMessage(message, [channel.port2]);
    } catch { finish(null); }
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = notificationUrl(event.notification.data?.url);
  const paneId = event.notification.data?.paneId;
  event.waitUntil((async () => {
    const target = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, url: targetUrl, expiresAt: Date.now() + 5 * 60_000 };
    await saveNotificationTarget(target);
    await dismissPaneNotifications(paneId);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin || url.pathname !== "/") continue;
      try {
        // Focus may fail during Android activity restoration even though the
        // document is alive. Still deliver the target before opening another.
        try {
          if (client.visibilityState !== "visible") {
            await client.focus();
          }
        } catch { /* Delivery can still succeed without focusing the window. */ }
        const response = await requestClient(client, { type: "open-notification-pane", url: targetUrl, target });
        if (response?.accepted !== true) {
          const navigated = await client.navigate(targetUrl);
          if (!navigated) continue;
        }
        return;
      } catch {
        // A window may close between enumeration and focus; try the next one.
      }
    }
    // Some Android launches report no WindowClient even while an app is
    // visible. Ask live pages independently before creating another activity.
    if (await relayNotificationTarget(target)) {
      return;
    }
    const client = await self.clients.openWindow(targetUrl);
    return client && typeof client.focus === "function" ? client.focus() : client;
  })());
});
