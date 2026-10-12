import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { serveLocked } from "../src/locked-server.mjs";

function listening() {
  let ready;
  const address = new Promise((resolve) => { ready = resolve; });
  return { address, onListening: ready };
}

test("a locked server answers every request and upgrade with 503 and its message, until it is stopped", async () => {
  const { address, onListening } = listening();
  const stop = new AbortController();
  const closed = serveLocked({ host: "127.0.0.1", port: 0 }, "set a password", { signals: [], stop: stop.signal, onListening });
  const { port } = await address;

  for (const path of ["/", "/api/bootstrap", "/api/panes/1/output"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "set a password\n");
  }

  const upgrade = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/terminal", headers: { Connection: "Upgrade", Upgrade: "websocket" } });
    req.on("response", (response) => { response.resume(); resolve(response.statusCode); });
    req.on("upgrade", () => reject(new Error("upgraded")));
    req.on("error", reject);
    req.end();
  });
  assert.equal(upgrade, 503);

  stop.abort();
  await closed;
});

test("a locked server that cannot listen resolves and marks the exit as failed", async (t) => {
  const { address, onListening } = listening();
  const stop = new AbortController();
  const first = serveLocked({ host: "127.0.0.1", port: 0 }, "x", { signals: [], stop: stop.signal, onListening });
  const { port } = await address;
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  t.mock.method(console, "error", () => {});
  await serveLocked({ host: "127.0.0.1", port }, "x", { signals: [] });
  assert.equal(process.exitCode, 1);
  process.exitCode = exitCode;
  stop.abort();
  await first;
});
