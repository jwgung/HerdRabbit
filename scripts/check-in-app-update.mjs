// Browser check of in-app update, against a fake updater and fake connected
// PCs (nothing is fetched, run or restarted). The page checks when it opens:
// a newer version puts a dot on the ⚙ button and an "Update available" item
// in its menu. The Update window lists this PC with what changed, a connected
// PC whose update is blocked with the reason, and a connected PC too old to
// be updated from here. Update asks first, then follows the run's log through
// a restart (the server not answering for a while) and reloads once a new
// version answers. A run that fails says so and keeps its log.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const LINK = "link_11111111-1111-1111-1111-111111111111";
const OLD = "link_22222222-2222-2222-2222-222222222222";

// What the fake PC does: "available" until updated, then "updated".
const world = { phase: "available", outcome: "succeeded", polls: 0, starts: 0 };

const check = (fields) => ({
  checkedAt: new Date().toISOString(), current: { sha: "abc1234", version: "2.0.0" }, latest: { sha: "def5678", version: "2.0.1" },
  available: true, notes: ["Update HerdRabbit from the settings menu", "Fix the sidebar"], blocked: null, error: null, ...fields,
});
const idle = { state: "idle", startedAt: null, finishedAt: null, exitCode: null, reason: null, log: "" };

const updater = {
  async check() {
    return world.phase === "updated"
      ? check({ current: { sha: "def5678", version: "2.0.1" }, available: false, notes: [] })
      : check();
  },
  async runStatus() {
    if (world.phase === "available") return { ...idle, version: "2.0.0" };
    if (world.phase === "updated") {
      return { ...idle, state: "succeeded", finishedAt: new Date().toISOString(), version: "2.0.1", log: "  > Updated to def5678." };
    }
    world.polls += 1;
    const log = ["  > Fetching main in /home/me/HerdRabbit", "  > Updating Herdr", "  > Verifying the updated code"]
      .slice(0, Math.min(3, world.polls)).join("\n");
    if (world.polls < 3) return { ...idle, state: "running", startedAt: new Date().toISOString(), log, version: "2.0.0" };
    if (world.outcome === "failed") {
      return { ...idle, state: "failed", exitCode: 1, reason: "script_failed", log: `${log}\n  x verification failed; rolled back to abc1234`, version: "2.0.0" };
    }
    world.phase = "updated";
    return { ...idle, state: "succeeded", log: `${log}\n  > Updated to def5678.`, version: "2.0.1" };
  },
  async start() {
    world.starts += 1;
    world.phase = "running";
    world.polls = 0;
    return { ...idle, state: "running", startedAt: new Date().toISOString(), version: "2.0.0" };
  },
};

const servers = [
  { id: "local", name: "Local", transport: "local", available: true, status: "Connected", machine: "testbox" },
  { id: LINK, name: "devbox", transport: "link", available: true, status: "Connected" },
  { id: OLD, name: "oldbox", transport: "link", available: true, status: "Connected" },
];
const herdr = {
  async snapshot() {
    return {
      servers,
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Shells" }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Alpha", cwd: "/work/alpha" }],
      agents: [],
    };
  },
  async readPane() { return "$ "; },
  async sendText() {},
  async sendKeys() {},
  updateClient(id) {
    if (id === LINK) {
      return {
        async updateCheck() { return check({ current: { sha: "1111111", version: "1.9.0" }, notes: ["Remote change"], blocked: "local_changes" }); },
        async updateStatus() { return { ...idle, version: "1.9.0" }; },
        async updateRun() { throw new Error("not expected"); },
      };
    }
    if (id === OLD) return { async updateCheck() { return null; }, async updateStatus() { return null; } };
    return null;
  },
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });

try {
  for (const outcome of ["succeeded", "failed"]) {
    Object.assign(world, { phase: "available", outcome, polls: 0, starts: 0 });
    // A server per run: the page's server lets one update a minute through.
    const { server } = createHerdrHttpServer({ herdr, updater, logger: { info() {}, error() {} } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    const button = page.locator(".settings-button");
    await button.waitFor({ state: "visible" });

    // Checked on open: the dot appears without anyone asking.
    await page.waitForSelector(".settings-button.has-update");
    assert.equal(await button.getAttribute("aria-label"), "Settings (update available)");
    await button.click();
    const item = page.locator('.settings-menu [data-action="update"]');
    await item.waitFor({ state: "visible" });
    assert.equal((await item.textContent()).trim(), "Update available");
    await item.click();

    const dialog = page.locator("#update-dialog");
    await dialog.waitFor({ state: "visible" });
    const local = dialog.locator('.update-server[data-server-id="local"]');
    assert.match(await local.locator("strong").textContent(), /This PC \(testbox\)/u);
    assert.match(await local.locator(".update-versions").textContent(), /Running 2\.0\.0 \(abc1234\) · Latest 2\.0\.1 \(def5678\)/u);
    assert.deepEqual(await local.locator(".update-notes li").allTextContents(),
      ["Update HerdRabbit from the settings menu", "Fix the sidebar"]);

    // A connected PC whose update would stop says why, with no button.
    const remote = dialog.locator(`.update-server[data-server-id="${LINK}"]`);
    assert.match(await remote.locator(".update-status").textContent(), /local changes/u);
    assert.equal(await remote.locator(".update-run").count(), 0);
    assert.deepEqual(await remote.locator(".update-notes li").allTextContents(), ["Remote change"]);
    // One too old to know about this is updated there.
    assert.equal((await dialog.locator(`.update-server[data-server-id="${OLD}"] .update-status`).textContent()).trim(),
      "Update it there (older version).");

    // Check asks again.
    let asked = 0;
    page.on("request", (request) => { if (request.url().includes("/api/update?") && request.url().includes("fresh=1")) asked += 1; });
    await dialog.locator("#update-check").click();
    await page.waitForFunction(() => !document.querySelector("#update-check").disabled);
    assert.equal(asked, 3, "every PC is checked again");

    // Update: asked first, then followed. A restart in the middle is waited out.
    await page.evaluate(() => { window.beforeUpdate = true; });
    let down = 0;
    await page.route("**/api/update/run?server=local", async (route) => {
      if (world.polls === 2 && down < 2) {
        down += 1;
        await route.abort("connectionrefused");
        return;
      }
      await route.continue();
    });
    await local.locator(".update-run").click();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /^Update This PC \(testbox\) to 2\.0\.1 \(def5678\)\?/u);
    assert.match(dialogs[0], /restarts HerdRabbit/u);
    assert.match(dialogs[0], /previous version back/u);
    await page.waitForFunction(() => /Updating/u.test(document.querySelector(".update-run-state")?.textContent ?? ""));
    await page.waitForFunction(() => /Updating Herdr/u.test(document.querySelector(".update-log")?.textContent ?? ""));
    assert.equal(world.starts, 1);
    assert.equal(await local.locator(".update-run").isDisabled(), true, "one run at a time");

    if (outcome === "succeeded") {
      await page.waitForFunction(() => /Waiting for HerdRabbit/u.test(document.querySelector(".update-run-state")?.textContent ?? ""));
      // A new version answers: the page reloads into it. This PC is up to
      // date now; the dot stays for devbox, which still has an update.
      await page.waitForFunction(() => window.beforeUpdate !== true, null, { timeout: 20_000 });
      await page.locator(".settings-button").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector('.settings-menu [data-action="update"]')?.hidden === false);
      await page.locator(".settings-button").click();
      await page.locator('.settings-menu [data-action="update"]').click();
      const after = page.locator('#update-dialog .update-server[data-server-id="local"]');
      await after.waitFor({ state: "visible" });
      assert.equal((await after.locator(".update-status").textContent()).trim(), "Up to date.");
      assert.match(await after.locator(".update-versions").textContent(), /Running 2\.0\.1/u);
      assert.match(await after.locator(".update-log").textContent(), /Updated to def5678/u, "the finished run is still shown");
    } else {
      await page.waitForFunction(() => /update failed/u.test(document.querySelector(".update-run-state")?.textContent ?? ""), null, { timeout: 20_000 });
      assert.equal(await local.locator(".update-run-state").getAttribute("data-error"), "true");
      assert.match(await local.locator(".update-log").textContent(), /rolled back to abc1234/u);
      assert.equal(await page.evaluate(() => window.beforeUpdate), true, "a failed run does not reload");
    }
    assert.deepEqual(errors, []);
    await context.close();
    server.closeAllConnections();
    server.close();
  }
  console.log("in-app update check passed");
} finally {
  await browser.close();
}
