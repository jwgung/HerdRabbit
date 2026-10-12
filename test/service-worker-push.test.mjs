import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import vm from "node:vm";
const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

async function pushFor(clients, paneId = "w1:p1") {
  const handlers = new Map();
  const shown = [];
  vm.runInNewContext(source, {
    URL, MessageChannel, setTimeout, clearTimeout,
    self: {
      location: { origin: "https://rabbit.example" },
      clients: { async matchAll() { return clients; } },
      registration: { async showNotification(...args) { shown.push(args); } },
      addEventListener(type, handler) { handlers.set(type, handler); },
    },
  });
  let lifetime;
  handlers.get("push")({
    data: { json() { return { title: "Finished", data: { paneId } }; } },
    waitUntil(p) { lifetime = p; },
  });
  await lifetime;
  return shown;
}

function windowClient({ visible = true, viewing = true, responds = true } = {}) {
  return {
    url: "https://rabbit.example/",
    visibilityState: visible ? "visible" : "hidden",
    postMessage(message, ports) {
      assert.equal(message.type, "query-viewing-pane");
      assert.equal(message.paneId, "w1:p1");
      if (responds) ports[0].postMessage({ viewing });
    },
  };
}

test("suppresses pushes for the pane currently visible in an app", async () => {
  assert.equal((await pushFor([windowClient()])).length, 0);
});
test("notifies for a different pane, a background app, or a closed app", async () => {
  for (const clients of [[windowClient({ viewing: false })], [windowClient({ visible: false })], []]) {
    assert.equal((await pushFor(clients)).length, 1);
  }
});
test("keeps notifications when an older app cannot report its visible pane", async () => {
  assert.equal((await pushFor([windowClient({ responds: false })])).length, 1);
});
test("hands an app in front what it needs to show the alert itself", async () => {
  const received = [];
  const client = {
    url: "https://rabbit.example/",
    visibilityState: "visible",
    postMessage(message, ports) { received.push(message); ports[0].postMessage({ viewing: true }); },
  };
  assert.equal((await pushFor([client])).length, 0);
  assert.deepEqual([received[0].title, received[0].paneId], ["Finished", "w1:p1"]);
});
test("shows a test push that names no pane even with the app in front", async () => {
  assert.equal((await pushFor([windowClient()], null)).length, 1);
});
