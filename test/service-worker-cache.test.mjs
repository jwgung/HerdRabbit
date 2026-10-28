import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(
  new URL("../public/sw.js", import.meta.url),
  "utf8",
);

function loadFetchHandler({ cachedBody = "cached", networkBody = "network" } = {}) {
  const listeners = new Map();
  let storedBody = cachedBody;
  const self = {
    location: { origin: "https://herd-rabbit.test" },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    skipWaiting() {},
  };
  const caches = {
    async match() {
      return new Response(storedBody);
    },
    async open() {
      return {
        async put(_request, response) {
          storedBody = await response.text();
        },
      };
    },
  };
  const fetch = async () => new Response(networkBody);

  vm.runInNewContext(workerSource, {
    Boolean,
    Promise,
    Response,
    URL,
    caches,
    fetch,
    self,
  });
  return {
    fetchHandler: listeners.get("fetch"),
    storedBody: () => storedBody,
  };
}

test("serves the latest application asset instead of a stale cached copy", async () => {
  const { fetchHandler } = loadFetchHandler();
  let responsePromise;
  fetchHandler({
    request: new Request("https://herd-rabbit.test/app.js?v=1.4.1"),
    respondWith(value) {
      responsePromise = value;
    },
  });

  const response = await responsePromise;
  assert.equal(await response.text(), "network");
});

test("stores the latest application asset for the next offline launch", async () => {
  const { fetchHandler, storedBody } = loadFetchHandler();
  let responsePromise;
  fetchHandler({
    request: new Request("https://herd-rabbit.test/app.js?v=1.4.1"),
    respondWith(value) {
      responsePromise = value;
    },
  });

  await responsePromise;
  assert.equal(storedBody(), "network");
});
