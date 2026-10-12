import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const snapshot = JSON.parse(await readFile(new URL("../test/fixtures/fake-state.template.json", import.meta.url), "utf8")).snapshot;
const subscribers = new Set();
const { server } = createHerdrHttpServer({ herdr: {
  async snapshot() { return snapshot; }, async readPane() { return "ready"; },
  async watchStatuses(ids, update) {
    const entry = { ids, update }; subscribers.add(entry);
    return () => subscribers.delete(entry);
  },
}, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ serviceWorkers: "block" });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#terminal-xterm").filter({ hasText: "ready" }).waitFor();
  while (!subscribers.size) await new Promise(resolve => setTimeout(resolve, 10));
  const target = page.locator('.pane-button[data-pane-id="w2:p1"]');
  assert.equal(await target.getAttribute("aria-pressed"), "false");
  const emit = agent_status => {
    for (const entry of subscribers) {
      assert(entry.ids.includes("w2:p1"));
      entry.update({ pane_id: "w2:p1", agent_status });
    }
  };
  emit("blocked");
  await page.waitForFunction(() => document.querySelector('[data-pane-id="w2:p1"]').dataset.status === "blocked");
  // Hold an old HTTP list response while a newer status event arrives.
  let intercepted;
  const pending = new Promise(resolve => { intercepted = resolve; });
  await page.route("**/api/snapshot", async route => {
    intercepted();
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({ json: { snapshot } });
  });
  await pending;
  const started = Date.now();
  emit("working");
  await page.waitForFunction(() => document.querySelector('[data-pane-id="w2:p1"]').dataset.status === "working");
  assert(Date.now() - started < 400, "status must not wait for the HTTP list response");
  await page.waitForTimeout(650);
  assert.equal(await target.getAttribute("data-status"), "working");
  assert.equal(await target.getAttribute("aria-pressed"), "false");
  console.log("Unselected blocked→working via WebSocket, stale HTTP response protection, focus preserved: passed");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  assert.equal(subscribers.size, 0);
}
