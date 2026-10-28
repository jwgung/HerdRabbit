// Browser check of in-app update, against a fake updater and fake connected
// PCs (nothing is fetched, run or restarted). The page checks when it opens:
// a newer version puts a dot on the ⚙ button and an "Update available" item
// in its menu. The Update window lists this PC with what changed, a connected
// PC whose update is blocked with the reason, and a connected PC too old to
// be updated from here. Update asks first, then follows the run step by step
// (Step n of N, the time it has taken, the log folded under "Log") through a
// restart (the server not answering for a while: "Waiting for HerdRabbit to
// come back…"), shows the reload as the last step and reloads once a new
// version answers. A run that fails marks its step with a cross, says so and
// keeps its log open. A plugin run whose restart failed says the new version
// is installed and how to restart it, with Herdr's error -- never update.sh.
// Then Herdr: with HerdRabbit up to date, a newer Herdr alone puts the dot
// up; its row shows the versions, notes folded away, and Update Herdr asks
// first, follows the run's log, and checks again so the new Herdr shows.
// A connected PC whose Herdr came from a package manager says
// so; a refused run shows Herdr's own words.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { RUN_STEPS, scriptPhase } from "../src/app-update.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const LINK = "link_11111111-1111-1111-1111-111111111111";
const OLD = "link_22222222-2222-2222-2222-222222222222";

// What the fake PC does: "available" until updated, then "updated".
const world = { phase: "available", outcome: "succeeded", polls: 0, starts: 0 };
// update.sh's lines, one more each answer, and the step they put the run at.
const SCRIPT_LOG = [
  "  > Fetching main in /home/me/HerdRabbit", "  > Updating Herdr", "  > Installing runtime dependencies",
  "  > Verifying the updated code", "  > Restarting herdrabbit.service",
];
const PLUGIN_LOG = ["  > Updating the herdrabbit plugin with Herdr", "Updated herdrabbit.", "  > Restarting HerdRabbit"];
const RESTART_ERROR = "No such file or directory (os error 2); the direct restart exited with 1";

const check = (fields) => ({
  checkedAt: new Date().toISOString(), current: { sha: "abc1234", version: "2.0.0" }, latest: { sha: "def5678", version: "2.0.1" },
  available: true, notes: ["Update HerdRabbit from the settings menu", "Fix the sidebar"], blocked: null, error: null, ...fields,
});
const idle = { state: "idle", startedAt: null, finishedAt: null, exitCode: null, reason: null, log: "" };

const updater = {
  async check() {
    const mode = world.outcome === "restart_failed" ? "plugin" : "script";
    return world.phase === "updated"
      ? check({ current: { sha: "def5678", version: "2.0.1" }, available: false, notes: [], mode })
      : check({ mode });
  },
  async runStatus() {
    if (world.phase === "available") return { ...idle, version: "2.0.0" };
    if (world.phase === "updated") {
      return {
        ...idle, state: "succeeded", finishedAt: new Date().toISOString(), version: "2.0.1", log: "  > Updated to def5678.",
        mode: "script", steps: RUN_STEPS.script, phase: "reload", startedAt: world.startedAt,
      };
    }
    world.polls += 1;
    const plugin = world.outcome === "restart_failed";
    const mode = plugin ? "plugin" : "script";
    const run = { ...idle, mode, steps: RUN_STEPS[mode], startedAt: world.startedAt, version: "2.0.0" };
    if (plugin) {
      const log = PLUGIN_LOG.slice(0, Math.min(3, world.polls + 1)).join("\n");
      if (world.polls < 3) return { ...run, state: "running", phase: world.polls < 2 ? "fetch" : "restart", log };
      return {
        ...run, state: "failed", exitCode: 1, reason: "restart_failed", phase: "restart", finishedAt: new Date().toISOString(),
        detail: RESTART_ERROR, log: `${log}\n  > Herdr could not restart HerdRabbit: No such file or directory (os error 2)`,
      };
    }
    const lines = SCRIPT_LOG.slice(0, world.outcome === "failed" ? Math.min(4, world.polls) : Math.min(5, world.polls));
    const log = lines.join("\n");
    const phase = scriptPhase(log) ?? "fetch";
    if (world.outcome === "failed" && world.polls >= 5) {
      return {
        ...run, state: "failed", exitCode: 1, reason: "script_failed", phase, finishedAt: new Date().toISOString(),
        log: `${log}\n  x verification failed; rolled back to abc1234`,
      };
    }
    if (world.polls <= 5) return { ...run, state: "running", phase, log };
    world.phase = "updated";
    return { ...run, state: "succeeded", phase: "reload", log: `${log}\n  > Updated to def5678.`, version: "2.0.1" };
  },
  async start() {
    world.starts += 1;
    world.phase = "running";
    world.polls = 0;
    world.startedAt = new Date(Date.now() - 60_000).toISOString();
    const mode = world.outcome === "restart_failed" ? "plugin" : "script";
    return { ...idle, state: "running", startedAt: world.startedAt, version: "2.0.0", mode, steps: RUN_STEPS[mode], phase: "fetch" };
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
  for (const outcome of ["succeeded", "failed", "restart_failed"]) {
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
      // update.sh is restarting the service: nothing answers for a while
      if (outcome === "succeeded" && world.polls === 5 && down < 3) {
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
    if (outcome === "restart_failed") {
      assert.doesNotMatch(dialogs[0], /update\.sh/u, "a plugin update is not update.sh's");
      assert.match(dialogs[0], /installed version keeps running/u);
    } else {
      assert.match(dialogs[0], /previous version back/u);
    }
    await page.waitForFunction(() => /Updating/u.test(document.querySelector(".update-run-state")?.textContent ?? ""));
    assert.equal(world.starts, 1);
    assert.equal(await local.locator(".update-run").isDisabled(), true, "one run at a time");

    // The steps, the one in progress with its time, and the log folded away.
    const step = (id) => local.locator(`.update-step[data-step="${id}"]`);
    const stepState = (id) => step(id).getAttribute("data-state");
    const steps = local.locator(".update-steps");
    assert.equal(await steps.getAttribute("role"), "list");
    if (outcome === "restart_failed") {
      assert.deepEqual(await local.locator(".update-step .update-step-label").allTextContents(),
        ["In progress: Download and build the new version", "Not started: Restart HerdRabbit", "Not started: Reload this page"]);
      assert.equal((await local.locator(".update-step-count").textContent()).trim(), "Step 1 of 3");
      await waitForStep(local, "restart", "current");
      assert.equal(await stepState("fetch"), "done");
      assert.equal((await local.locator(".update-step-count").textContent()).trim(), "Step 2 of 3");
    } else {
      assert.equal(await local.locator(".update-step").count(), 6);
      for (const [index, id] of ["herdr", "install", "verify"].entries()) {
        await waitForStep(local, id, "current");
        assert.equal((await local.locator(".update-step-count").textContent()).trim(), `Step ${index + 2} of 6`);
        assert.equal(await stepState("fetch"), "done");
        assert.equal(await step(id).getAttribute("aria-current"), "step");
        assert.equal(await stepState("reload"), "pending");
      }
    }
    const current = local.locator('.update-step[aria-current="step"]');
    assert.match(await current.locator(".update-elapsed").textContent(), /^1:0\d$/u, "the time since the run began");
    assert.equal(await local.locator(".update-step .update-elapsed").count(), 1, "only the step in progress has a time");
    const fold = local.locator("details.update-log-fold");
    assert.equal(await fold.evaluate((node) => node.open), false, "the log is folded away while it runs");
    assert.equal((await fold.locator("summary").textContent()).trim(), "Log");
    await shot(page, `${outcome}-running`);

    if (outcome === "succeeded") {
      await page.waitForFunction(() => /Waiting for HerdRabbit to come back/u.test(
        document.querySelector('.update-step[data-step="restart"] .update-step-note')?.textContent ?? ""));
      assert.equal(await stepState("restart"), "current");
      assert.equal(await stepState("verify"), "done");
      assert.equal((await local.locator(".update-step-count").textContent()).trim(), "Step 5 of 6");
      await shot(page, "succeeded-waiting");
      // Back, with a new version: the reload is the step left, then the page goes.
      await page.waitForFunction(() => document.querySelector('.update-step[data-step="reload"]')?.dataset.state === "current", null, { timeout: 20_000 });
      assert.match(await local.locator(".update-run-state").textContent(), /Reloading this page/u);
      assert.equal(await stepState("restart"), "done");
      await shot(page, "succeeded-reload");
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
      assert.equal((await after.locator(".update-run-state").textContent()).trim(), "Updated.");
      assert.deepEqual(await after.locator(".update-step").evaluateAll((nodes) => nodes.map((node) => node.dataset.state)),
        ["done", "done", "done", "done", "done", "done"]);
      assert.equal(await after.locator(".update-step-count").count(), 0);
      assert.equal(await after.locator("details.update-log-fold").evaluate((node) => node.open), false, "a finished run's log is folded away");
      assert.equal((await after.locator("details.update-log-fold > summary").textContent()).trim(), "Log");
      // seen once: after closing, the finished run does not come back
      await page.locator("#update-close").click();
      await page.locator('.settings-button').click();
      await page.locator('.settings-menu [data-action="update"]').click();
      await after.waitFor({ state: "visible" });
      assert.equal(await after.locator(".update-progress").count(), 0, "a finished run seen once is gone");
    } else if (outcome === "failed") {
      await page.waitForFunction(() => /update failed/u.test(document.querySelector(".update-run-state")?.textContent ?? ""), null, { timeout: 20_000 });
      assert.equal(await local.locator(".update-run-state").getAttribute("data-error"), "true");
      assert.match(await local.locator(".update-run-state").textContent(), /update\.sh put the previous version back/u);
      assert.equal(await stepState("verify"), "failed");
      assert.equal(await step("verify").locator(".update-step-mark").textContent(), "✕");
      assert.equal(await stepState("install"), "done");
      assert.equal(await stepState("restart"), "pending");
      assert.equal((await local.locator(".update-step-count").textContent()).trim(), "Step 4 of 6");
      assert.match(await local.locator(".update-log").textContent(), /rolled back to abc1234/u);
      assert.equal(await local.locator("details.update-log-fold").evaluate((node) => node.open), true, "a failed run keeps its log open");
      assert.equal(await page.evaluate(() => window.beforeUpdate), true, "a failed run does not reload");
      await shot(page, "failed");
    } else {
      await page.waitForFunction(() => document.querySelector('.update-step[data-step="restart"]')?.dataset.state === "failed", null, { timeout: 20_000 });
      const said = await local.locator(".update-run-state").textContent();
      assert.match(said, /new version is installed, but HerdRabbit could not restart/u);
      assert.match(said, /herdr plugin action invoke herdrabbit\.restart/u);
      assert.match(said, /shell where node is on PATH/u);
      assert.doesNotMatch(said, /update\.sh/u);
      assert.equal(await local.locator(".update-run-state").getAttribute("data-error"), "true");
      assert.equal((await local.locator(".update-detail").textContent()).trim(), RESTART_ERROR);
      assert.equal(await stepState("fetch"), "done");
      assert.equal(await stepState("reload"), "pending");
      assert.equal(await local.locator("details.update-log-fold").evaluate((node) => node.open), true, "a failed run keeps its log open");
      assert.equal(await page.evaluate(() => window.beforeUpdate), true, "a failed run does not reload");
      await shot(page, "restart-failed");
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

async function waitForStep(scope, id, state) {
  await scope.locator(`.update-step[data-step="${id}"][data-state="${state}"]`).waitFor({ timeout: 20_000 });
}

// UPDATE_SHOTS=<folder> keeps a screenshot of each state shown.
async function shot(page, name) {
  if (process.env.UPDATE_SHOTS) await page.screenshot({ path: `${process.env.UPDATE_SHOTS}/update-${name}.png` });
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
      return { ...herdrIdle, state: "succeeded", exitCode: 0, finishedAt: new Date().toISOString(), log: `${log}\nDone.\ninstalled herdr integrations need updating; run herdr integration install claude, herdr integration install codex` };
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
    assert.match(await row.locator(".update-herdr-run-head .update-elapsed").textContent(), /^\d+:\d\d$/u, "Herdr's run shows its time");
    assert.equal(await row.locator(".update-steps").count(), 0, "Herdr's run has no steps");
    assert.equal(herdrWorld.starts, 1);
    assert.equal(await local.locator(".update-herdr-run").isDisabled(), true, "one run at a time");

    if (outcome === "succeeded") {
      await page.waitForFunction(() => /Herdr updated/u.test(document.querySelector(".update-herdr-run-state")?.textContent ?? ""), null, { timeout: 20_000 });
      await page.waitForFunction(() => /Running 0\.9\.5/u.test(document.querySelector('.update-server[data-server-id="local"] .update-herdr-versions')?.textContent ?? ""));
      assert.equal((await row.locator(".update-herdr-status").textContent()).trim(), "Up to date.");
      assert.equal(await row.locator(".update-herdr-run").count(), 0);
      assert.match(await row.locator(".update-herdr-log").textContent(), /Done\./u);
      assert.equal(await row.locator("details.update-log-fold").evaluate((node) => node.open), false, "a finished run's log is folded away");
      assert.match(await row.locator(".update-herdr-integrations").textContent(), /^Herdr asks to update its agent integrations: run the herdr integration install commands shown in the log in a terminal\.$/u);
      // seen once: after closing, the finished run does not come back
      await page.locator("#update-close").click();
      await page.locator(".settings-button").click();
      await page.locator('.settings-menu [data-action="update"]').click();
      await dialog.waitFor({ state: "visible" });
      assert.equal(await row.locator(".update-progress").count(), 0, "a finished Herdr run seen once is gone");
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
      assert.equal(await row.locator("details.update-log-fold").evaluate((node) => node.open), true, "a failed run keeps its log open");
      assert.equal(await row.locator(".update-herdr-integrations").count(), 0);
    }
    assert.deepEqual(errors, []);
    await context.close();
    server.closeAllConnections();
    server.close();
  }
}
