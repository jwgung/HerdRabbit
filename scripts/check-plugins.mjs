// Browser check of Settings → Plugins: with sign-in on the page lists each
// machine's Herdr plugins (name, version, owner/repo@ref), HerdRabbit first
// ("this app", its versions, Update, no switch or menu), the others with an
// enabled switch and a ⋯ menu holding Update and Uninstall… (confirmed). A machine picker shows with more than one machine,
// and a PC on an older HerdRabbit says to update it there. Install plugin…
// shows the GitHub address a source names and a warning naming the machine,
// refuses a bad ref, then asks to confirm before installing; while a change
// runs the controls wait, and the page follows it until it ends. With sign-in
// off there is no Plugins page. On a phone the controls are 44px targets and
// nothing is wider than the screen. Browse lists Herdr's plugin marketplace:
// unreadable, it says so and points to Install plugin…; read, it sorts,
// searches and reads more, marks what is installed, offers no Install for
// HerdRabbit, and a listing's Install… fills in Source and goes through the
// same confirm step; Browse's search and order stay under the page's heading
// as the listings scroll. A plugin whose repository moved on in the
// marketplace carries "Update" and an Update button; HerdRabbit's row says
// "1.4.27 → 1.4.28 · restarts HerdRabbit when done", its Update asks the
// Update window's question and runs HerdRabbit's own update through
// /api/plugins/herdrabbit/update (the fake updater, never `herdr plugin
// update`), its run step by step under the row, while the controls wait.
// The settings list counts the updates beside Plugins. Update all (N) beside
// Installed and Browse updates them one at a time -- plugins, then HerdRabbit
// last -- and stops at the first failure saying what was left; Check for
// updates sees a newer HerdRabbit again. There is no Updates page. Runs on a desktop and a phone
// against an in-process fake herdr, fake `herdr plugin` commands, fake
// updaters and a fake marketplace index.
// A plugin's ⋯ → Actions and panes… runs an action for the pane on show and
// opens a pane as a new tab of its workspace, which is then shown with
// Settings closed; Logs… lists its command logs newest first, without this
// PC's folders; HerdRabbit's own actions and panes are not offered. Link
// local folder… takes a folder typed or picked with Browse…, links it (off
// when asked) after naming the machine and what linking runs; a linked
// plugin's ⋯ has Unlink… (confirmed) in place of Uninstall….
//
// PLUGINS_SHOTS=<folder> keeps pictures of the page and the dialog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { HerdrCommandError } from "../src/herdr-client.mjs";
import { PluginManager } from "../src/herdr-plugins.mjs";
import { RUN_STEPS } from "../src/app-update.mjs";
import { PluginMarketplace } from "../src/plugin-marketplace.mjs";
import { fakeFetch, marketplaceIndex } from "../test/fixtures/fake-plugin-marketplace.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const LAPTOP = "link_11111111-1111-1111-1111-111111111111";
const OLD = "link_22222222-2222-2222-2222-222222222222";
const SESSION = "hs_local";

const herdrabbit = () => ({
  plugin_id: "herdrabbit", name: "HerdRabbit", version: "1.4.27", enabled: true, description: "Open your Herdr sessions from a phone.",
  actions: [{ id: "restart", title: "HerdRabbit: restart", contexts: ["workspace"], command: ["node", "scripts/plugin.mjs", "restart"] }],
  panes: [{ id: "connect", title: "HerdRabbit: connect", placement: "overlay", command: ["node", "scripts/plugin.mjs", "connect"] }],
  source: { kind: "github", owner: "ultivis-iot", repo: "HerdRabbit", requested_ref: "v1.4.27", resolved_commit: "a074fe0dbe4c3d96ed53fdeb325bd6d6cd1e080e" },
});
// Installed from the marketplace's gen/plugin-3 on its default branch, a
// commit behind; gen/plugin-4 at the commit the index names.
const HEAD = "ad4614fcee1a9049a08ea9ca421889b9ce6966f8";
const gen = (index, commit) => ({
  plugin_id: `gen-${index}`, name: `Gen ${index}`, version: "0.1.0", enabled: true,
  source: { kind: "github", owner: "gen", repo: `plugin-${index}`, requested_ref: null, resolved_commit: commit },
  ...(index === 4 ? {
    actions: [{ id: "apply", title: "Apply layout", contexts: ["workspace"], command: ["sh", "/home/me/gen/apply.sh"] }],
    panes: [{ id: "board", title: "Board", placement: "overlay", command: ["sh", "/home/me/gen/board.sh"] }],
  } : {}),
});
// Herdr's command logs for Gen 4, oldest first, as `herdr plugin log list` answers.
const GEN_LOGS = [
  { log_id: "plugin-log-1", plugin_id: "gen-4", event: "startup", command: ["sh"], status: "succeeded", exit_code: 0,
    started_unix_ms: Date.now() - 3 * 3_600_000, finished_unix_ms: Date.now() - 3 * 3_600_000 + 500, stdout: "ready\n", stderr: "" },
  { log_id: "plugin-log-2", plugin_id: "gen-4", action_id: "apply", command: ["sh"], status: "failed", exit_code: 2,
    started_unix_ms: Date.now() - 5 * 60_000, finished_unix_ms: Date.now() - 5 * 60_000 + 800,
    stdout: "\u001b[32mApplying\u001b[0m in /home/me/projects/site\n", stderr: "error: /home/me/gen/layout.json not found\n" },
];
// The panes Herdr opened for a plugin, added to the snapshot.
const pluginPanes = [];
const notes = () => ({
  plugin_id: "notes", name: "Notes", version: "0.2.0", enabled: false, description: "Notes beside a pane.",
  source: { kind: "github", owner: "someone", repo: "herdr-notes", requested_ref: "main", resolved_commit: "1234567890abcdef1234567890abcdef12345678" },
});

// `herdr plugin …` on one machine: list answers from `plugins`, each change
// is recorded and applied; an install waits until it is let go.
// `order` hears each update, plugin or HerdRabbit's, as it starts; an
// update of `failUpdate` fails.
const order = [];
function fakePlugins(initial) {
  const state = { plugins: initial, ran: [], hold: null, failUpdate: null, panes: [] };
  const run = async (args) => {
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify({ id: "cli:plugin", result: { type: "plugin_list", plugins: state.plugins } }), stderr: "" };
    if (args[1] === "log") {
      const logs = GEN_LOGS.filter((log) => log.plugin_id === args[4]);
      return { code: 0, stdout: JSON.stringify({ id: "cli:plugin", result: { type: "plugin_log_list", logs } }), stderr: "" };
    }
    state.ran.push(args.join(" "));
    const [, action, target] = args;
    if (action === "link") {
      state.plugins.push({ plugin_id: "layout", name: "Layout", version: "0.0.1", enabled: !args.includes("--disabled"), source: { kind: "local" } });
    } else if (action === "unlink") {
      state.plugins = state.plugins.filter((item) => item.plugin_id !== target);
    }
    if (action === "update") {
      order.push(`plugin ${target}`);
      if (target === state.failUpdate) return { code: 1, stdout: "", stderr: "error: could not fetch gen/plugin-3\n" };
      const plugin = state.plugins.find((item) => item.plugin_id === target);
      if (plugin.source.kind === "github") plugin.source.resolved_commit = HEAD;
    }
    if (action === "install") {
      await new Promise((resolve) => { state.hold = resolve; });
      const [owner, repo] = target.split("/");
      state.plugins.push({ plugin_id: repo, name: "Tool", version: "1.0.0", enabled: true, source: { kind: "github", owner, repo, requested_ref: args[4] ?? null } });
    } else if (action === "enable" || action === "disable") {
      state.plugins.find((item) => item.plugin_id === target).enabled = action === "enable";
    } else if (action === "uninstall") {
      state.plugins = state.plugins.filter((item) => item.plugin_id !== target);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  // This PC's Herdr for a pane: an action is recorded; a pane opens as a new
  // tab of the pane's workspace and shows up in the snapshot.
  const herdr = {
    async pluginActionInvoke(paneId, pluginId, actionId) {
      state.panes.push(["invoke", paneId, pluginId, actionId]);
      return { log_id: "plugin-log-3", plugin_id: pluginId, action_id: actionId, command: ["sh"], status: "running", started_unix_ms: Date.now() };
    },
    async pluginPaneOpen(paneId, pluginId, entrypoint) {
      state.panes.push(["open", paneId, pluginId, entrypoint]);
      const index = pluginPanes.length + 9;
      pluginPanes.push({ pane_id: `w1:p${index}`, tab_id: `w1:t${index}`, workspace_id: "w1", label: "Board", herdr_session_id: SESSION, server_id: "local" });
      return { pane_id: `w1:p${index}`, tab_id: `w1:t${index}` };
    },
  };
  return { state, manager: new PluginManager({ run, herdr }) };
}

let local;
let laptop;
// The marketplace the hub reads: the fixture's plugins and enough more for
// a second page.
const marketIndex = marketplaceIndex();
for (let index = 1; index <= 55; index += 1) {
  marketIndex.plugins.push({
    ...marketIndex.plugins[1], owner: "gen", name: `plugin-${index}`, fullName: `gen/plugin-${index}`, stars: 0, starsDelta7d: 0,
    description: "Generated", pushedAt: "2026-01-01T00:00:00Z",
    manifests: [{ ...marketIndex.plugins[1].manifests[0], id: `gen-${index}`, name: `Gen ${index}` }],
  });
}
let market;

// HerdRabbit's own update on this PC (src/app-update.mjs's AppUpdater):
// 1.4.27 with 1.4.28 out, a plugin run that waits until let go. Herdr's:
// 0.9.3 with 0.9.5 out, a run that ends at the next look.
const app = { phase: "available", starts: 0, letGo: false, startedAt: null };
const herdrWorld = { version: "0.9.3", running: false };
const appCheck = () => ({
  checkedAt: new Date().toISOString(), mode: "plugin", blocked: null, error: null, notes: ["Plugin updates"],
  current: { sha: app.phase === "updated" ? "def5678" : "abc1234", version: app.phase === "updated" ? "1.4.28" : "1.4.27" },
  latest: { sha: "def5678", version: "1.4.28" }, available: app.phase !== "updated",
  herdr: { checkedAt: new Date().toISOString(), current: herdrWorld.version, latest: "0.9.5", channel: "stable",
    available: herdrWorld.version !== "0.9.5", notes: "", blocked: null, error: null },
});
const herdrIdle = { state: "idle", startedAt: null, finishedAt: null, exitCode: null, reason: null, detail: null, log: "" };
const herdrUpdater = {
  async runStatus() {
    if (!herdrWorld.running) return herdrIdle;
    herdrWorld.running = false;
    herdrWorld.version = "0.9.5";
    return { ...herdrIdle, state: "succeeded", exitCode: 0, finishedAt: new Date().toISOString(), log: "Done." };
  },
  async start() {
    order.push("herdr");
    herdrWorld.running = true;
    return { ...herdrIdle, state: "running", startedAt: new Date().toISOString() };
  },
};
const appRun = (fields) => ({
  state: "idle", startedAt: null, finishedAt: null, exitCode: null, reason: null, log: "", version: "1.4.27",
  mode: "plugin", steps: RUN_STEPS.plugin, ...fields,
});
const updater = {
  async check() { return appCheck(); },
  async runStatus() {
    if (app.phase !== "running") return appRun({});
    if (!app.letGo) return appRun({ state: "running", phase: "fetch", startedAt: app.startedAt, log: "  > Installing release v1.4.28" });
    app.phase = "updated";
    // the same version and boot as the page's: this fake does not restart, so the page does not reload
    return appRun({ state: "succeeded", phase: "reload", startedAt: app.startedAt, finishedAt: new Date().toISOString() });
  },
  async start() {
    order.push("herdrabbit");
    app.starts += 1;
    app.phase = "running";
    app.letGo = false;
    app.startedAt = new Date().toISOString();
    return appRun({ state: "running", phase: "fetch", startedAt: app.startedAt });
  },
};
// The page's server lets one update a minute through; each run here is
// taken to be a few minutes after the last.
let skew = 0;

const herdr = {
  async snapshot() {
    return {
      servers: [
        { id: "local", name: "workstation", machine: "workstation", transport: "local", available: true, status: "Connected" },
        { id: LAPTOP, name: "Laptop", transport: "link", available: true, status: "Connected" },
        { id: OLD, name: "Old box", transport: "link", available: true, status: "Connected" },
      ],
      herdr_sessions: [{ session_id: SESSION, name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "workstation" }],
      workspaces: [{ workspace_id: "w1", label: "Platform", herdr_session_id: SESSION, server_id: "local" },
        { workspace_id: "w2", label: "Docs", active_tab_id: "w2:t1", herdr_session_id: SESSION, server_id: "local" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: SESSION },
        { tab_id: "w2:t1", workspace_id: "w2", label: "1", herdr_session_id: SESSION },
        ...pluginPanes.map((pane) => ({ tab_id: pane.tab_id, workspace_id: "w1", label: "Board", herdr_session_id: SESSION }))],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: "/work", herdr_session_id: SESSION, server_id: "local" },
        { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", label: "docs", cwd: "/docs", focused: true, herdr_session_id: SESSION, server_id: "local" },
        ...pluginPanes],
      agents: [],
    };
  },
  pluginsClient(id) {
    if (id === LAPTOP) return laptop.manager;
    if (id !== OLD) return null;
    const tooOld = () => new HerdrCommandError("HerdRabbit at http://old-box:38788 is too old for managing plugins from here; update it there.", { code: "link_unsupported" });
    return { async list() { throw tooOld(); }, async start() { throw tooOld(); } };
  },
  async readPane() { return "$ "; },
  async sendText() {},
  async sendKeys() {},
};

function startServer(required) {
  const { server } = createHerdrHttpServer({
    herdr,
    updater,
    herdrUpdater,
    now: () => Date.now() + skew,
    plugins: {
      list: (...args) => local.manager.list(...args), start: (...args) => local.manager.start(...args),
      invoke: (...args) => local.manager.invoke(...args), openPane: (...args) => local.manager.openPane(...args),
      logs: (...args) => local.manager.logs(...args),
    },
    marketplace: { page: (...args) => market.page(...args), updatesFor: (...args) => market.updatesFor(...args) },
    auth: { required, hasValidSession: () => true, hasValidLaunchToken: () => true, onSessionsEnded: () => () => {} },
    logger: { info() {}, error() {} },
  });
  server.listen(0, "127.0.0.1");
  return server;
}

const signedIn = startServer(true);
const signedOut = startServer(false);
await Promise.all([once(signedIn, "listening"), once(signedOut, "listening")]);
const url = (server) => `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.PLUGINS_SHOTS;
// A plugin folder on this PC for Link local folder….
const pluginDir = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-check-plugin-")));
await writeFile(join(pluginDir, "herdr-plugin.toml"), 'id = "layout"\nname = "Layout"\nversion = "0.0.1"\n');

try {
  for (const mobile of [false, true]) {
    const where = mobile ? "phone" : "desktop";
    local = fakePlugins([herdrabbit(), notes(), gen(3, "1234567890abcdef1234567890abcdef12345678"), gen(4, HEAD)]);
    market = new PluginMarketplace({ fetch: fakeFetch(marketIndex).fetch });
    Object.assign(app, { phase: "available", starts: 0, letGo: false });
    Object.assign(herdrWorld, { version: "0.9.3", running: false });
    order.length = 0;
    pluginPanes.length = 0;
    laptop = fakePlugins([{ plugin_id: "far", name: "Far away", version: "3.1.0", enabled: true, source: { kind: "local" } }]);
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const confirms = [];
    page.on("dialog", (prompt) => { confirms.push(prompt.message()); void prompt.accept(); });

    // Sign-in off: no Plugins page.
    await page.goto(`${url(signedOut)}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
    const settings = page.locator("#settings-dialog");
    const openSettings = async () => {
      if (mobile && await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForTimeout(400); // the phone sidebar slides in
      }
      await page.locator("#settings-open").click();
      await settings.waitFor({ state: "visible" });
    };
    await openSettings();
    assert.ok(!(await settings.locator(".settings-page-link").allTextContents()).includes("Plugins"), `${where}: Plugins shows with sign-in off`);

    // Sign-in on: Plugins is there.
    await page.goto(`${url(signedIn)}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
    await openSettings();
    await settings.locator(".settings-page-link", { hasText: "Plugins" }).click();
    const pluginsPage = settings.locator('.settings-page[data-page="plugins"]');
    await pluginsPage.waitFor({ state: "visible" });
    const rows = pluginsPage.locator(".plugin-row");
    await rows.first().waitFor({ state: "visible" });
    const feedback = page.locator("#plugins-feedback");
    // A ⋯ menu's items once its popover has opened (it opens on the toggle event).
    const menuItems = async () => {
      await page.locator(".sidebar-action-popover:popover-open .sidebar-action-item").first().waitFor({ state: "visible" });
      return page.locator(".sidebar-action-popover:popover-open .sidebar-action-item").allTextContents();
    };
    const idle = () => page.waitForFunction(() => !document.querySelector("#plugins-install").disabled);
    const herdrabbitRow = rows.filter({ has: page.locator("strong", { hasText: "HerdRabbit" }) });
    const ids = () => rows.evaluateAll((items) => items.map((row) => row.dataset.plugin));
    await page.locator(".plugin-app-row .plugin-update-badge").waitFor({ state: "visible" });
    await page.locator('.plugin-row[data-plugin="gen-3"] .plugin-update-badge').waitFor({ state: "visible" });

    assert.deepEqual(await rows.evaluateAll((items) => items.map((row) => ({
      id: row.dataset.plugin,
      name: row.querySelector("strong").textContent,
      version: row.querySelector(".plugin-version")?.textContent ?? null,
      source: row.querySelector(".plugin-source")?.textContent ?? null,
      href: row.querySelector("a.plugin-source")?.getAttribute("href") ?? null,
      badges: [...row.querySelectorAll(".plugin-title .ui-badge")].map((badge) => badge.textContent),
      line: row.querySelector(".plugin-update-line")?.textContent ?? null,
      button: row.querySelector(".plugin-update, .plugin-app-update")?.textContent ?? null,
      switch: row.querySelector('[role="switch"]')?.getAttribute("aria-checked") ?? null,
      menu: Boolean(row.querySelector(".sidebar-action-menu")),
    }))), [
      { id: "herdrabbit", name: "HerdRabbit", version: null, source: null, href: null, badges: ["this app", "Update"],
        line: "1.4.27 → 1.4.28 · restarts HerdRabbit when done", button: "Update", switch: null, menu: false },
      // pinned to a branch the index does not name: no badge
      { id: "notes", name: "Notes", version: "0.2.0", source: "someone/herdr-notes@main",
        href: "https://github.com/someone/herdr-notes", badges: [], line: null, button: null, switch: "false", menu: true },
      { id: "gen-3", name: "Gen 3", version: "0.1.0", source: "gen/plugin-3@1234567",
        href: "https://github.com/gen/plugin-3", badges: ["Update"], line: null, button: "Update", switch: "true", menu: true },
      { id: "gen-4", name: "Gen 4", version: "0.1.0", source: "gen/plugin-4@ad4614f",
        href: "https://github.com/gen/plugin-4", badges: [], line: null, button: null, switch: "true", menu: true },
    ], `${where}: the list is wrong`);
    // Update all beside Installed and Browse; the count beside Plugins in the
    // list (HerdRabbit and Gen 3); no Updates page.
    const updateAll = page.locator("#plugins-update-all");
    assert.equal(await updateAll.textContent(), "Update all (2)");
    assert.equal(await updateAll.isVisible(), true);
    await page.waitForFunction(() => document.querySelector('.settings-page-link[data-page="plugins"] .ui-badge')?.textContent === "2");
    assert.ok(!(await settings.locator(".settings-page-link").allTextContents()).includes("Updates"), `${where}: Updates is still listed`);

    // The picker names each machine.
    const picker = page.locator("#plugins-machine");
    assert.equal(await page.locator("#plugins-machine-row").isVisible(), true, `${where}: no machine picker`);
    assert.deepEqual(await picker.locator("option").allTextContents(), ["This PC (workstation)", "Laptop", "Old box"]);

    if (mobile) {
      const notesRow = rows.filter({ hasText: "Notes" });
      for (const target of [notesRow.locator('[role="switch"]'), notesRow.locator(".sidebar-action-menu summary"), picker, page.locator("#plugins-install"),
        herdrabbitRow.locator(".plugin-app-update"), rows.filter({ hasText: "Gen 3" }).locator(".plugin-update"), updateAll, page.locator("#plugins-check")]) {
        const box = await target.boundingBox();
        assert.ok(box.height >= 44, `${where}: ${await target.evaluate((node) => node.id || node.className)} is under 44px tall (${box.height})`);
      }
      const overflow = await page.locator(".settings-body").evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `${where}: the page is wider than the screen (${overflow}px)`);
    }
    if (shots) await page.screenshot({ path: join(shots, `plugins-${where}.png`) });

    // The switch turns Notes on.
    const notesSwitch = rows.filter({ hasText: "Notes" }).locator('[role="switch"]');
    await notesSwitch.click();
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Turned on Notes.");
    assert.equal(await notesSwitch.getAttribute("aria-checked"), "true");
    assert.equal(await notesSwitch.textContent(), "On");

    // ⋯ → Update, then Uninstall… after a confirm.
    const menu = rows.filter({ hasText: "Notes" }).locator(".sidebar-action-menu");
    await menu.locator("summary").click();
    assert.deepEqual(await menuItems(), ["Logs…", "Update", "Uninstall…"]);
    await page.locator(".sidebar-action-popover:visible .sidebar-action-item", { hasText: "Update" }).click();
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Updated Notes.");
    await idle();
    await rows.filter({ hasText: "Notes" }).locator(".sidebar-action-menu summary").click();
    await menuItems();
    await page.locator(".sidebar-action-popover:visible .sidebar-action-item", { hasText: "Uninstall" }).click();
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Uninstalled notes.");
    assert.match(confirms.at(-1), /^Uninstall Notes from This PC \(workstation\)\?/u);
    assert.deepEqual(await ids(), ["herdrabbit", "gen-3", "gen-4"]);
    assert.deepEqual(local.state.ran, ["plugin enable notes", "plugin update notes --yes", "plugin uninstall notes"]);
    await idle();

    // Install plugin…: the address the source names, the warning, a bad ref refused.
    const install = page.locator("#plugin-install-dialog");
    await page.locator("#plugins-install").click();
    await install.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plugin-install-source", `${where}: Source is not focused`);
    assert.match(await page.locator("#plugin-install-warning").textContent(), /runs its build and its own code on This PC \(workstation\)/u);
    if (mobile) {
      for (const target of ["#plugin-install-source", "#plugin-install-ref"]) {
        assert.ok((await page.locator(target).boundingBox()).height >= 44, `${where}: ${target} is under 44px tall`);
      }
    }
    await page.keyboard.type("https://github.com/someone/tool.git");
    assert.equal(await page.locator("#plugin-install-repo a").getAttribute("href"), "https://github.com/someone/tool");
    assert.equal(await page.locator("#plugin-install-repo a").textContent(), "https://github.com/someone/tool");
    await page.locator("#plugin-install-ref").fill("v1 beta");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#plugin-install-feedback").dataset.error === "true");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plugin-install-ref");
    assert.equal(await page.locator("#plugin-install-confirm-step").isVisible(), false, `${where}: a bad ref reached the confirm step`);
    await page.locator("#plugin-install-ref").fill("v1");
    await page.keyboard.press("Enter");
    await page.locator("#plugin-install-confirm-step").waitFor({ state: "visible" });
    assert.equal(await page.locator("#plugin-install-confirm-text").textContent(), "Install someone/tool at v1 on This PC (workstation)?");
    assert.equal(await page.locator("#plugin-install-confirm-repo a").getAttribute("href"), "https://github.com/someone/tool");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plugin-install-submit", `${where}: Install is not focused`);
    assert.equal(await page.locator("#plugin-install-cancel").textContent(), "Back");
    if (shots) await page.screenshot({ path: join(shots, `install-${where}.png`) });
    if (mobile) {
      for (const target of ["#plugin-install-cancel", "#plugin-install-submit"]) {
        assert.ok((await page.locator(target).boundingBox()).height >= 44, `${where}: ${target} is under 44px tall`);
      }
      const overflow = await install.evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `${where}: the install dialog is wider than the screen (${overflow}px)`);
    }
    // Back keeps what was typed; nothing ran yet.
    await page.locator("#plugin-install-cancel").click();
    assert.equal(await page.locator("#plugin-install-source").inputValue(), "https://github.com/someone/tool.git");
    assert.deepEqual(local.state.ran.filter((line) => line.startsWith("plugin install")), []);
    await page.keyboard.press("Enter");
    await page.locator("#plugin-install-submit", { hasText: "Install" }).click();
    await install.waitFor({ state: "hidden" });

    // While it runs: the status says so and the controls wait.
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Installing someone/tool@v1… This can take a few minutes.");
    assert.equal(await page.locator("#plugins-install").isDisabled(), true, `${where}: Install plugin… is not waiting`);
    assert.equal(local.state.ran.at(-1), "plugin install someone/tool --ref v1 --yes");
    local.state.hold();
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Installed someone/tool@v1.");
    await idle();
    assert.deepEqual(await ids(), ["herdrabbit", "gen-3", "gen-4", "tool"]);

    // Escape closes the dialog; nothing is sent.
    await page.locator("#plugins-install").click();
    await install.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await install.waitFor({ state: "hidden" });
    assert.equal(await settings.isVisible(), true, `${where}: Escape closed Settings too`);

    // ⋯ → Actions and panes…: Run for the pane on show, in its workspace.
    const genMenu = () => rows.filter({ hasText: "Gen 4" }).locator(".sidebar-action-menu summary");
    const pickItem = (text) => page.locator(".sidebar-action-popover:popover-open .sidebar-action-item", { hasText: text }).click();
    await genMenu().click();
    assert.deepEqual(await menuItems(), ["Actions and panes…", "Logs…", "Update", "Uninstall…"]);
    await pickItem("Actions and panes…");
    const detailsDialog = page.locator("#plugin-details-dialog");
    await detailsDialog.waitFor({ state: "visible" });
    assert.equal(await page.locator("#plugin-details-title").textContent(), "Gen 4");
    assert.equal(await page.locator("#plugin-details-machine").textContent(), "On This PC (workstation)");
    assert.equal(await page.locator("#plugin-details-actions-where").textContent(), "Runs for the pane you have open, in Platform.");
    assert.equal(await page.locator("#plugin-details-panes-where").textContent(), "Opens as a new tab in Platform, beside the pane you have open.");
    assert.deepEqual(await detailsDialog.locator(".plugin-entry-title").allTextContents(), ["Apply layout", "Board"]);
    if (mobile) {
      for (const target of [detailsDialog.locator(".plugin-entry-run").first(), page.locator("#plugin-details-close"), page.locator("#plugin-details-logs")]) {
        const box = await target.boundingBox();
        assert.ok(box.height >= 44, `${where}: ${await target.evaluate((node) => node.id || node.className)} is under 44px tall (${box.height})`);
      }
      const overflow = await detailsDialog.evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `${where}: Actions and panes is wider than the screen (${overflow}px)`);
    }
    if (shots) await page.screenshot({ path: join(shots, `details-${where}.png`) });
    await detailsDialog.getByRole("button", { name: "Run Apply layout" }).click();
    await page.waitForFunction(() => document.querySelector("#plugin-details-feedback").textContent === "Started Apply layout. Logs… shows how it goes.");
    assert.deepEqual(local.state.panes, [["invoke", "w1:p1", "gen-4", "apply"]]);

    // Another workspace of the machine: its active pane, until Platform is chosen again.
    const workspacePick = page.locator("#plugin-details-workspace");
    assert.deepEqual(await workspacePick.locator("option").allTextContents(), ["Platform", "Docs"]);
    assert.equal(await workspacePick.inputValue(), "w1");
    await workspacePick.selectOption("w2");
    assert.equal(await page.locator("#plugin-details-actions-where").textContent(), "Runs for the active pane of Docs.");
    assert.equal(await page.locator("#plugin-details-panes-where").textContent(), "Opens as a new tab in Docs.");
    await detailsDialog.getByRole("button", { name: "Run Apply layout" }).click();
    await page.waitForFunction(() => document.querySelector("#plugin-details-feedback").textContent === "Started Apply layout. Logs… shows how it goes.");
    assert.deepEqual(local.state.panes.at(-1), ["invoke", "w2:p1", "gen-4", "apply"]);
    await workspacePick.selectOption("w1");
    assert.equal(await page.locator("#plugin-details-actions-where").textContent(), "Runs for the pane you have open, in Platform.");

    // Logs…, from the dialog: newest first, colours and folders gone.
    await page.locator("#plugin-details-logs").click();
    const logsDialog = page.locator("#plugin-logs-dialog");
    await logsDialog.waitFor({ state: "visible" });
    await logsDialog.locator(".plugin-log").first().waitFor({ state: "visible" });
    assert.equal(await page.locator("#plugin-logs-title").textContent(), "Gen 4 logs");
    assert.deepEqual(await logsDialog.locator(".plugin-log-summary").allTextContents(),
      ["Apply layout · Failed (exit 2) · 5 minutes ago", "Startup hook · Succeeded · 3 hours ago"]);
    assert.deepEqual(await logsDialog.locator(".plugin-log").first().locator(".plugin-log-output").allTextContents(),
      ["Applying in …/site\n", "error: …/layout.json not found\n"]);
    assert.doesNotMatch(await logsDialog.textContent(), /\/home\/me/u);
    if (mobile) {
      const overflow = await logsDialog.evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `${where}: Logs is wider than the screen (${overflow}px)`);
    }
    if (shots) await page.screenshot({ path: join(shots, `logs-${where}.png`) });
    await page.keyboard.press("Escape");
    await logsDialog.waitFor({ state: "hidden" });
    assert.equal(await detailsDialog.isVisible(), true, `${where}: Escape in Logs closed Actions and panes too`);

    // Open: a new tab of that workspace, shown, Settings closed.
    await detailsDialog.getByRole("button", { name: "Open Board" }).click();
    await settings.waitFor({ state: "hidden" });
    assert.equal(await detailsDialog.isVisible(), false);
    assert.deepEqual(local.state.panes.at(-1), ["open", "w1:p1", "gen-4", "board"]);
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p9"]')?.getAttribute("aria-pressed") === "true");
    // Back to the first pane and to Plugins.
    if (mobile) await page.locator("#mobile-sidebar-open").click();
    await page.locator('.pane-button[data-pane-id="w1:p1"]').click();
    await openSettings();
    if (!(await pluginsPage.isVisible())) await settings.locator(".settings-page-link", { hasText: "Plugins" }).click();
    await pluginsPage.waitFor({ state: "visible" });
    await rows.filter({ hasText: "Gen 4" }).waitFor({ state: "visible" });

    // Link local folder…: the machine, what it runs, a folder typed and shown in the tree ▾ opens.
    const linkDialog = page.locator("#plugin-link-dialog");
    await page.locator("#plugins-link").click();
    await linkDialog.waitFor({ state: "visible" });
    assert.equal(await page.locator("#plugin-link-machine").textContent(), "On This PC (workstation)");
    assert.match(await page.locator("#plugin-link-warning").textContent(), /without building it, and runs its startup hooks on This PC \(workstation\)/u);
    assert.equal(await page.locator("#plugin-link-folder").inputValue(), "~");
    await page.locator("#plugin-link-folder").fill(pluginDir);
    await linkDialog.locator(".folder-browse").click();
    await linkDialog.locator(".folder-picker").waitFor({ state: "visible" });
    // the tree opens on the folder's parent with the folder marked; ▾ closes it
    await page.waitForFunction((dir) => document.querySelector('#plugin-link-folder-picker .browse-row[data-selected="true"]')?.dataset.path === dir, pluginDir);
    await linkDialog.locator(".folder-browse").click();
    await linkDialog.locator(".folder-picker").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#plugin-link-folder").inputValue(), pluginDir);
    if (mobile) {
      for (const target of ["#plugin-link-folder", "#plugin-link-cancel", "#plugin-link-submit", ".plugin-link-enabled"]) {
        assert.ok((await page.locator(target).boundingBox()).height >= 44, `${where}: ${target} is under 44px tall`);
      }
      const overflow = await linkDialog.evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `${where}: Link is wider than the screen (${overflow}px)`);
    }
    if (shots) await page.screenshot({ path: join(shots, `link-${where}.png`) });
    await page.locator("#plugin-link-enabled").uncheck();
    await page.locator("#plugin-link-submit").click();
    await linkDialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Linked Layout.");
    assert.equal(local.state.ran.at(-1), `plugin link ${pluginDir} --disabled`);
    const layoutRow = rows.filter({ has: page.locator("strong", { hasText: "Layout" }) });
    assert.equal(await layoutRow.locator(".plugin-source").textContent(), "Linked from a folder");
    assert.equal(await layoutRow.locator('[role="switch"]').getAttribute("aria-checked"), "false");
    await idle();

    // Unlink…, confirmed: Herdr forgets it, the folder stays.
    await layoutRow.locator(".sidebar-action-menu summary").click();
    assert.deepEqual(await menuItems(), ["Logs…", "Unlink…"]);
    await pickItem("Unlink…");
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Unlinked layout.");
    assert.match(confirms.at(-1), /^Unlink Layout from This PC \(workstation\)\? Herdr stops using it; its folder stays as it is\.$/u);
    assert.equal(local.state.ran.at(-1), "plugin unlink layout");
    assert.deepEqual(await ids(), ["herdrabbit", "gen-3", "gen-4", "tool"]);
    await idle();

    // Another machine: its own list, and the install warning names it.
    await picker.selectOption(LAPTOP);
    await page.waitForFunction(() => document.querySelector('.plugin-row[data-plugin="far"]'));
    assert.equal(await rows.filter({ hasText: "Far away" }).locator(".plugin-source").textContent(), "Linked from a folder");
    await rows.filter({ hasText: "Far away" }).locator(".sidebar-action-menu summary").click();
    assert.deepEqual(await menuItems(), ["Logs…", "Unlink…"],
      `${where}: a linked plugin offers Update or Uninstall`);
    await page.keyboard.press("Escape");
    await page.locator("#plugins-install").click();
    assert.match(await page.locator("#plugin-install-warning").textContent(), /on Laptop,/u);
    await page.locator("#plugin-install-cancel").click();
    await install.waitFor({ state: "hidden" });

    // A PC on an older HerdRabbit says to update it there.
    await picker.selectOption(OLD);
    await page.waitForFunction(() => /update it there/u.test(document.querySelector("#plugins-feedback").textContent));
    assert.equal(await feedback.getAttribute("data-error"), "true");
    assert.equal(await rows.count(), 0);

    // Browse, on This PC. Unreadable first: it says so and points to Install plugin….
    await picker.selectOption("local");
    await page.waitForFunction(() => document.querySelector('#plugins-list .plugin-row[data-plugin="tool"]'));
    const readable = market;
    market = new PluginMarketplace({ fetch: fakeFetch({}, { status: 503 }).fetch });
    const browseButton = pluginsPage.locator('[data-plugins-view="browse"]');
    await browseButton.click();
    assert.equal(await browseButton.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#plugins-installed-view").isVisible(), false, `${where}: Installed still shows in Browse`);
    const browseStatus = page.locator("#plugins-browse-status");
    await page.waitForFunction(() => document.querySelector("#plugins-browse-status").dataset.error === "true");
    assert.match(await browseStatus.textContent(), /could not be read \(it answered HTTP 503\)\. You can still install a plugin by its GitHub owner\/repo with Install plugin…/u);
    assert.equal(await pluginsPage.locator("#plugins-browse-view .plugin-warning").count(), 0, `${where}: Browse still shows its note`);
    const listings = page.locator("#plugins-browse-list .market-row");
    assert.equal(await listings.count(), 0);

    // Readable: a new order reads it again, Popular first by stars.
    market = readable;
    const sort = page.locator("#plugins-sort");
    const specs = () => listings.evaluateAll((items) => items.map((item) => item.dataset.spec));
    await sort.selectOption("name");
    await page.waitForFunction(() => document.querySelectorAll("#plugins-browse-list .market-row").length === 50);
    const names = await listings.locator("strong").allTextContents();
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })), `${where}: Name is not in order`);
    assert.match(await browseStatus.textContent(), /^61 plugins, listed by Herdr /u);
    await sort.selectOption("popular");
    await page.waitForFunction(() => document.querySelector("#plugins-browse-list .market-row")?.dataset.spec === "zenbu-labs/terminal-browser/herdr-plugin");
    assert.deepEqual((await specs()).slice(0, 4), ["zenbu-labs/terminal-browser/herdr-plugin", "annotate-dev/annotate", "annotate-dev/annotate/links", "someone/herdr-notes"]);
    const first = listings.first();
    assert.equal(await first.locator("a.plugin-source").getAttribute("href"), "https://github.com/zenbu-labs/terminal-browser/tree/HEAD/herdr-plugin");
    assert.match(await first.locator(".market-details").textContent(), /^★ 4,403 · \+127 this week · updated .+ · linux, macos · needs Herdr 0\.8\.2 or later$/u);
    for (const href of await listings.locator("a.plugin-source").evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
      assert.match(href, /^https:\/\/github\.com\/[^/]+\/[^/]+(?:\/tree\/HEAD\/.+)?$/u);
    }
    // HerdRabbit: listed, never installable here.
    const herdrabbitListing = listings.filter({ has: page.locator("strong", { hasText: "HerdRabbit" }) });
    assert.equal(await herdrabbitListing.locator(".market-install").count(), 0, `${where}: HerdRabbit can be installed`);
    assert.equal(await herdrabbitListing.locator(".plugin-badge").textContent(), "This app");
    // Scrolled down the listings, the page's heading and Browse's search and
    // order stay at the top.
    const sticky = await page.evaluate(() => {
      const body = document.querySelector(".settings-body");
      body.scrollTop = body.scrollHeight;
      const top = body.getBoundingClientRect().top;
      const heading = document.querySelector(".settings-page-heading").getBoundingClientRect();
      const tools = document.querySelector(".plugins-browse-tools").getBoundingClientRect();
      const scrolled = body.scrollTop;
      body.scrollTop = 0;
      return { scrolled, heading: heading.top - top, tools: tools.top - heading.bottom };
    });
    assert.ok(sticky.scrolled > 200, `${where}: Browse did not scroll (${sticky.scrolled})`);
    assert.ok(Math.abs(sticky.heading) <= 1, `${where}: the heading scrolled away (${sticky.heading})`);
    assert.ok(Math.abs(sticky.tools) <= 1, `${where}: search and order scrolled away (${sticky.tools})`);
    // Load more reads the next page, then there is no more.
    const more = page.locator("#plugins-more");
    assert.equal(await more.isVisible(), true, `${where}: no Load more`);
    if (mobile) {
      for (const target of [page.locator("#plugins-search"), sort, first.locator(".market-install"), more, browseButton]) {
        const box = await target.boundingBox();
        assert.ok(box.height >= 44, `${where}: ${await target.evaluate((node) => node.id || node.className)} is under 44px tall (${box.height})`);
      }
      const overflow = await page.locator(".settings-body").evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `${where}: Browse is wider than the screen (${overflow}px)`);
    }
    if (shots) await page.screenshot({ path: join(shots, `browse-${where}.png`) });
    await more.click();
    await page.waitForFunction(() => document.querySelectorAll("#plugins-browse-list .market-row").length === 61);
    assert.equal(await more.isVisible(), false, `${where}: Load more after the last page`);

    // Search, typed: a moment after the last key, the matching listings.
    await page.locator("#plugins-search").click();
    await page.keyboard.type("annotate");
    await page.waitForFunction(() => document.querySelectorAll("#plugins-browse-list .market-row").length === 2);
    assert.deepEqual(await specs(), ["annotate-dev/annotate", "annotate-dev/annotate/links"]);
    assert.match(await browseStatus.textContent(), /^2 plugins match "annotate", listed by Herdr .+ ago\.$/u);

    // Install… fills in Source; the same confirm step; Herdr's command runs.
    const annotate = listings.filter({ has: page.locator("strong", { hasText: /^Annotate$/u }) });
    await annotate.locator(".market-install").click();
    await install.waitFor({ state: "visible" });
    assert.equal(await page.locator("#plugin-install-source").inputValue(), "annotate-dev/annotate");
    assert.equal(await page.locator("#plugin-install-repo a").getAttribute("href"), "https://github.com/annotate-dev/annotate");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "plugin-install-submit", `${where}: Continue is not focused`);
    await page.keyboard.press("Enter");
    await page.locator("#plugin-install-confirm-step").waitFor({ state: "visible" });
    assert.equal(await page.locator("#plugin-install-confirm-text").textContent(), "Install annotate-dev/annotate on This PC (workstation)?");
    assert.ok(!local.state.ran.includes("plugin install annotate-dev/annotate --yes"), `${where}: installed before Install`);
    await page.locator("#plugin-install-submit", { hasText: "Install" }).click();
    await install.waitFor({ state: "hidden" });
    await page.waitForFunction(() => /^Installing annotate-dev\/annotate…/u.test(document.querySelector("#plugins-feedback").textContent));
    assert.equal(local.state.ran.at(-1), "plugin install annotate-dev/annotate --yes");
    assert.equal(await annotate.locator(".market-install").isDisabled(), true, `${where}: Install… is not waiting`);
    local.state.hold();
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Installed annotate-dev/annotate.");
    await annotate.locator(".plugin-badge", { hasText: "Installed" }).waitFor({ state: "visible" });
    const links = listings.filter({ has: page.locator("strong", { hasText: "Annotate Links" }) });
    assert.equal(await links.locator(".market-install").isDisabled(), false, `${where}: another folder of the repository counts as installed`);
    // A new order chosen while a search waits for its pause reads that search.
    await page.locator("#plugins-search").fill("herdr-notes");
    await sort.selectOption("recent");
    await page.waitForFunction(() => document.querySelectorAll("#plugins-browse-list .market-row").length === 1);
    assert.deepEqual(await specs(), ["someone/herdr-notes"]);
    await page.waitForTimeout(400);
    assert.deepEqual(await specs(), ["someone/herdr-notes"], `${where}: the search read again after the new order`);

    // Installed again: the new plugin is in its list.
    await pluginsPage.locator('[data-plugins-view="installed"]').click();
    assert.ok((await ids()).includes("annotate"));
    await idle();

    // Update all, where the first plugin's update fails: it stops there,
    // says what was left, and HerdRabbit's update does not start.
    await page.waitForFunction(() => document.querySelector("#plugins-update-all")?.textContent === "Update all (2)");
    local.state.failUpdate = "gen-3";
    order.length = 0;
    await updateAll.click();
    assert.equal(confirms.at(-1).split("\n").slice(0, 3).join("\n"),
      "Update these 2 on This PC (workstation), one at a time?\n• Gen 3\n• HerdRabbit (1.4.27 → 1.4.28), last: it restarts");
    assert.match(confirms.at(-1), /stops at the first update that fails[\s\S]*Herdr downloads and builds this release of the HerdRabbit plugin/u);
    assert.doesNotMatch(confirms.at(-1), /Herdr \(0\.9/u, `${where}: Update all still updates Herdr`);
    await page.waitForFunction(() => /^Update all stopped\./u.test(document.querySelector("#plugins-feedback").textContent));
    assert.equal(await feedback.textContent(), "Update all stopped. Couldn't update Gen 3: error: could not fetch gen/plugin-3. Not updated: HerdRabbit.");
    assert.equal(await feedback.getAttribute("data-error"), "true");
    assert.deepEqual(order, ["plugin gen-3"], `${where}: Update all went on after a failure`);
    assert.equal(app.starts, 0);
    local.state.failUpdate = null;
    await idle();
    if (shots) await page.screenshot({ path: join(shots, `updates-${where}.png`) });

    // HerdRabbit's Update asks the Update window's question and runs
    // HerdRabbit's own update; its row follows it, and the controls wait.
    skew += 5 * 60_000;
    await herdrabbitRow.locator(".plugin-app-update").click();
    assert.match(confirms.at(-1), /^Update This PC \(workstation\) to 1\.4\.28 \(def5678\)\?\n\nHerdr downloads and builds this release of the HerdRabbit plugin/u);
    // The run, step by step, under HerdRabbit's row.
    await page.waitForFunction(() => {
      const row = document.querySelector('#plugins-list [data-update="app"]');
      return /^Updating/u.test(row?.querySelector(".update-run-state")?.textContent ?? "") &&
        row.querySelector(".update-step-count")?.textContent === "Step 1 of 3" &&
        row.querySelector('.update-step[aria-current="step"] .update-step-label')?.textContent === "In progress: Download and build the new version";
    });
    assert.equal(app.starts, 1);
    assert.ok(!local.state.ran.some((line) => /^plugin (?:update|install) .*herdrabbit/iu.test(line)), `${where}: Herdr's plugin command ran for HerdRabbit: ${local.state.ran}`);
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent ===
      "HerdRabbit is updating on This PC (workstation). Plugin changes wait until it finishes.");
    assert.equal(await updateAll.isDisabled(), true, `${where}: Update all works during the update`);
    assert.equal(await rows.filter({ hasText: "Gen 4" }).locator('[role="switch"]').isDisabled(), true, `${where}: a switch works during the update`);
    assert.equal(await page.locator("#plugins-install").isDisabled(), true);
    app.letGo = true;
    await idle();
    await page.waitForFunction(() => document.querySelector('#plugins-list [data-update="app"] .plugin-update-line')?.textContent === "1.4.28 · Up to date");
    assert.equal(await herdrabbitRow.locator(".plugin-app-update").count(), 0, `${where}: Update after HerdRabbit is up to date`);

    // Update all once more, HerdRabbit's update out again (Check for
    // updates sees it): Gen 3 first, waited for, then HerdRabbit last.
    app.phase = "available";
    skew += 5 * 60_000;
    local.state.plugins.find((item) => item.plugin_id === "gen-3").source.resolved_commit = "1234567890abcdef1234567890abcdef12345678";
    await page.locator("#plugins-check").click();
    await page.waitForFunction(() => document.querySelector("#plugins-update-all")?.textContent === "Update all (2)" &&
      !document.querySelector("#plugins-update-all").hidden);
    order.length = 0;
    await updateAll.click();
    await page.waitForFunction(() => document.querySelector('#plugins-list [data-update="app"] .update-progress'));
    assert.deepEqual(order, ["plugin gen-3", "herdrabbit"], `${where}: Update all's order`);
    assert.equal(await updateAll.textContent(), "Updating all…");
    assert.equal(await feedback.textContent(), "Update all: Updating HerdRabbit…");
    app.letGo = true;
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Updated all 2.");
    await page.waitForFunction(() => document.querySelector("#plugins-update-all").hidden);
    assert.equal(await pluginsPage.locator(".plugin-update, .plugin-app-update").count(), 0, `${where}: an update left after Update all`);
    await page.waitForFunction(() => !document.querySelector('.settings-page-link[data-page="plugins"] .ui-badge'));

    assert.deepEqual(errors, [], `${where}: page errors: ${errors.join("; ")}`);
    await context.close();
    console.log(`ok: ${where}`);
  }
  console.log("Plugins page: list, switch, menu, install with confirm, machines, sign-in only, Browse: ok");
} finally {
  await browser.close();
  signedIn.close();
  signedOut.close();
  await rm(pluginDir, { recursive: true, force: true });
}
