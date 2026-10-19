// Browser check of in-app update, against a fake updater and fake connected
// PCs (nothing is fetched, run or restarted). The page checks when it opens:
// a newer version puts a dot on the ⚙ button and an "Update available" item
// in its menu. The Update window lists this PC with what changed, a connected
// PC whose update is blocked with the reason, and a connected PC too old to
// be updated from here. Update asks first, then follows the run's log through
// a restart (the server not answering for a while) and reloads once a new
// version answers. A run that fails says so and keeps its log.
// Then Herdr: with HerdRabbit up to date, a newer Herdr alone puts the dot
// up; its row shows the versions, notes folded away, and Update Herdr asks
// first, follows the run's log, and checks again so the new Herdr shows.
// A connected PC whose Herdr came from a package manager says
// so; a refused run shows Herdr's own words.
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
  await checkHerdr();
  console.log("in-app update check passed");
} finally {
  await browser.close();
}

async function checkHerdr() {
  const herdrWorld = { version: "0.9.3", polls: 0, starts: 0, outcome: "succeeded" };
  const upToDate = check({ latest: { sha: "abc1234", version: "2.0.0" }, available: false, notes: [] });
  const herdrCheck = () => ({
    checkedAt: new Date().toISOString(), current: herdrWorld.version, latest: "0.9.5", channel: "stable",
    available: herdrWorld.version !== "0.9.5",
    notes: herdrWorld.version !== "0.9.5" ? "Fixed\n- Prefix shortcuts work again." : "", blocked: null, error: null,
  });
  const herdrIdle = { state: "idle", startedAt: null, finishedAt: null, exitCode: null, reason: null, detail: null, log: "" };
  const appUpdater = {
    async check() {
      // the look again after a run, failing once when the outcome asks for it
      if (herdrWorld.outcome === "recheck_fails" && herdrWorld.version === "0.9.5" && !herdrWorld.recheckFailed) {
        herdrWorld.recheckFailed = true;
        throw new Error("origin went away for a moment");
      }
      return { ...upToDate, herdr: herdrCheck() };
    },
    async runStatus() { return { ...idle, version: "2.0.0" }; },
    async start() { throw new Error("not expected"); },
  };
  const herdrUpdater = {
    async runStatus() {
      if (herdrWorld.starts === 0) return herdrIdle;
      herdrWorld.polls += 1;
      const log = ["Downloading herdr 0.9.5", "Installing", "Handing off 3 panes"].slice(0, Math.min(3, herdrWorld.polls)).join("\n");
      if (herdrWorld.polls < 3) return { ...herdrIdle, state: "running", startedAt: new Date().toISOString(), log };
      if (herdrWorld.outcome === "refused") {
        return {
          ...herdrIdle, state: "failed", exitCode: 1, reason: "self_update_refused", finishedAt: new Date().toISOString(),
          detail: "self-update is disabled for Homebrew installs; run brew update && brew upgrade herdr", log,
        };
      }
      herdrWorld.version = "0.9.5";
      return { ...herdrIdle, state: "succeeded", exitCode: 0, finishedAt: new Date().toISOString(), log: `${log}\nDone.` };
    },
    async start() {
      herdrWorld.starts += 1;
      herdrWorld.polls = 0;
      return { ...herdrIdle, state: "running", startedAt: new Date().toISOString() };
    },
  };
  const herdrClient = {
    ...herdr,
    updateClient(id) {
      if (id === LINK) {
        return {
          async updateCheck() {
            return { ...upToDate, herdr: { ...herdrCheck(), current: "0.9.3", available: true, blocked: "managed_install" } };
          },
          async updateStatus() { return { ...idle, version: "2.0.0" }; },
          async herdrUpdateStatus() { return herdrIdle; },
          async herdrUpdateRun() { throw new Error("not expected"); },
        };
      }
      return herdr.updateClient(id);
    },
  };

  for (const outcome of ["succeeded", "refused", "recheck_fails"]) {
    Object.assign(herdrWorld, { version: "0.9.3", polls: 0, starts: 0, outcome, recheckFailed: false });
    const { server } = createHerdrHttpServer({ herdr: herdrClient, updater: appUpdater, herdrUpdater, logger: { info() {}, error() {} } });
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
    // HerdRabbit is up to date everywhere: the dot is Herdr's.
    await page.waitForSelector(".settings-button.has-update");
    await page.locator(".settings-button").click();
    await page.locator('.settings-menu [data-action="update"]').click();
    const dialog = page.locator("#update-dialog");
    await dialog.waitFor({ state: "visible" });
    const local = dialog.locator('.update-server[data-server-id="local"]');
    assert.equal((await local.locator(".update-status").first().textContent()).trim(), "Up to date.");
    assert.equal(await local.locator(".update-run").count(), 0);
    const row = local.locator(".update-herdr");
    assert.equal((await row.locator(".update-herdr-versions").textContent()).trim(), "Running 0.9.3 · Latest 0.9.5");
    assert.equal((await row.locator(".update-herdr-status").textContent()).trim(), "A new Herdr is ready to install.");
    // Notes are folded away until opened.
    const notes = row.locator(".update-herdr-notes");
    assert.equal(await notes.evaluate((node) => node.open), false);
    await notes.locator("summary").click();
    assert.match(await notes.locator(".update-herdr-notes-text").textContent(), /Prefix shortcuts work again/u);

    // A Homebrew Herdr on devbox is updated with Homebrew: no button.
    const remote = dialog.locator(`.update-server[data-server-id="${LINK}"] .update-herdr`);
    assert.match(await remote.locator(".update-herdr-status").textContent(), /package manager/u);
    assert.equal(await remote.locator(".update-herdr-run").count(), 0);
    // oldbox says nothing about Herdr.
    assert.equal(await dialog.locator(`.update-server[data-server-id="${OLD}"] .update-herdr`).count(), 0);

    await row.locator(".update-herdr-run").click();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /^Update Herdr on This PC \(testbox\) from 0\.9\.3 to 0\.9\.5\?/u);
    assert.match(dialogs[0], /hands the running panes over to it live/u);
    assert.match(dialogs[0], /agents and shells keep running/u);
    assert.match(dialogs[0], /can take a moment/u);
    await page.waitForFunction(() => /Updating Herdr/u.test(document.querySelector(".update-herdr-run-state")?.textContent ?? ""));
    await page.waitForFunction(() => /Installing/u.test(document.querySelector(".update-herdr-log")?.textContent ?? ""));
    assert.equal(herdrWorld.starts, 1);
    assert.equal(await local.locator(".update-herdr-run").isDisabled(), true, "one run at a time");

    if (outcome === "succeeded") {
      await page.waitForFunction(() => /Herdr updated/u.test(document.querySelector(".update-herdr-run-state")?.textContent ?? ""), null, { timeout: 20_000 });
      await page.waitForFunction(() => /Running 0\.9\.5/u.test(document.querySelector('.update-server[data-server-id="local"] .update-herdr-versions')?.textContent ?? ""));
      assert.equal((await row.locator(".update-herdr-status").textContent()).trim(), "Up to date.");
      assert.equal(await row.locator(".update-herdr-run").count(), 0);
      assert.match(await row.locator(".update-herdr-log").textContent(), /Done\./u);
      // devbox still has a newer Herdr, so the dot stays for it.
      assert.equal(await page.locator(".settings-button.has-update").count(), 1);
    } else if (outcome === "recheck_fails") {
      // the run ended well but the look again failed: the buttons are not left busy
      await page.waitForFunction(() => /Herdr updated/u.test(document.querySelector(".update-herdr-run-state")?.textContent ?? ""), null, { timeout: 20_000 });
      assert.ok(herdrWorld.recheckFailed, "the look again was not asked");
      await page.waitForFunction(() => !document.querySelector('.update-server[data-server-id="local"] .update-herdr-run')?.disabled);
    } else {
      await page.waitForFunction(() => /will not update itself/u.test(document.querySelector(".update-herdr-run-state")?.textContent ?? ""), null, { timeout: 20_000 });
      assert.equal(await row.locator(".update-herdr-run-state").getAttribute("data-error"), "true");
      assert.match(await row.locator(".update-herdr-detail").textContent(), /brew upgrade herdr/u);
    }
    assert.deepEqual(errors, []);
    await context.close();
    server.closeAllConnections();
    server.close();
  }
}
