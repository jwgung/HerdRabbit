// Browser check of Settings → Plugins: with sign-in on the page lists each
// machine's Herdr plugins (name, version, owner/repo@ref), HerdRabbit with no
// controls, the others with an enabled switch and a ⋯ menu holding Update and
// Uninstall… (confirmed). A machine picker shows with more than one machine,
// and a PC on an older HerdRabbit says to update it there. Install plugin…
// shows the GitHub address a source names and a warning naming the machine,
// refuses a bad ref, then asks to confirm before installing; while a change
// runs the controls wait, and the page follows it until it ends. With sign-in
// off there is no Plugins page. On a phone the controls are 44px targets and
// nothing is wider than the screen. Browse lists Herdr's plugin marketplace:
// unreadable, it says so and points to Install plugin…; read, it sorts,
// searches and reads more, marks what is installed, offers no Install for
// HerdRabbit, and a listing's Install… fills in Source and goes through the
// same confirm step. Runs on a desktop and a phone against an in-process fake
// herdr, fake `herdr plugin` commands and a fake marketplace index.
//
// PLUGINS_SHOTS=<folder> keeps pictures of the page and the dialog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { HerdrCommandError } from "../src/herdr-client.mjs";
import { PluginManager } from "../src/herdr-plugins.mjs";
import { PluginMarketplace } from "../src/plugin-marketplace.mjs";
import { fakeFetch, marketplaceIndex } from "../test/fixtures/fake-plugin-marketplace.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const LAPTOP = "link_11111111-1111-1111-1111-111111111111";
const OLD = "link_22222222-2222-2222-2222-222222222222";
const SESSION = "hs_local";

const herdrabbit = () => ({
  plugin_id: "herdrabbit", name: "HerdRabbit", version: "1.4.27", enabled: true, description: "Open your Herdr sessions from a phone.",
  source: { kind: "github", owner: "ultivis-iot", repo: "HerdRabbit", requested_ref: "v1.4.27", resolved_commit: "a074fe0dbe4c3d96ed53fdeb325bd6d6cd1e080e" },
});
const notes = () => ({
  plugin_id: "notes", name: "Notes", version: "0.2.0", enabled: false, description: "Notes beside a pane.",
  source: { kind: "github", owner: "someone", repo: "herdr-notes", requested_ref: "main", resolved_commit: "1234567890abcdef1234567890abcdef12345678" },
});

// `herdr plugin …` on one machine: list answers from `plugins`, each change
// is recorded and applied; an install waits until it is let go.
function fakePlugins(initial) {
  const state = { plugins: initial, ran: [], hold: null };
  const run = async (args) => {
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify({ id: "cli:plugin", result: { type: "plugin_list", plugins: state.plugins } }), stderr: "" };
    state.ran.push(args.join(" "));
    const [, action, target] = args;
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
  return { state, manager: new PluginManager({ run }) };
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
const herdr = {
  async snapshot() {
    return {
      servers: [
        { id: "local", name: "workstation", machine: "workstation", transport: "local", available: true, status: "Connected" },
        { id: LAPTOP, name: "Laptop", transport: "link", available: true, status: "Connected" },
        { id: OLD, name: "Old box", transport: "link", available: true, status: "Connected" },
      ],
      herdr_sessions: [{ session_id: SESSION, name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "workstation" }],
      workspaces: [{ workspace_id: "w1", label: "Platform", herdr_session_id: SESSION, server_id: "local" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: SESSION }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: "/work", herdr_session_id: SESSION, server_id: "local" }],
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
    plugins: { list: (...args) => local.manager.list(...args), start: (...args) => local.manager.start(...args) },
    marketplace: { page: (...args) => market.page(...args) },
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

try {
  for (const mobile of [false, true]) {
    const where = mobile ? "phone" : "desktop";
    local = fakePlugins([herdrabbit(), notes()]);
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

    assert.deepEqual(await rows.evaluateAll((items) => items.map((row) => ({
      id: row.dataset.plugin,
      name: row.querySelector("strong").textContent,
      version: row.querySelector(".plugin-version")?.textContent ?? null,
      source: row.querySelector(".plugin-source").textContent,
      href: row.querySelector("a.plugin-source")?.getAttribute("href") ?? null,
      state: row.querySelector(".plugin-state")?.textContent ?? null,
      switch: row.querySelector('[role="switch"]')?.getAttribute("aria-checked") ?? null,
      menu: Boolean(row.querySelector(".sidebar-action-menu")),
    }))), [
      { id: "herdrabbit", name: "HerdRabbit", version: "1.4.27", source: "ultivis-iot/HerdRabbit@v1.4.27",
        href: "https://github.com/ultivis-iot/HerdRabbit", state: "Updated from About", switch: null, menu: false },
      { id: "notes", name: "Notes", version: "0.2.0", source: "someone/herdr-notes@main",
        href: "https://github.com/someone/herdr-notes", state: null, switch: "false", menu: true },
    ], `${where}: the list is wrong`);

    // The picker names each machine.
    const picker = page.locator("#plugins-machine");
    assert.equal(await page.locator("#plugins-machine-row").isVisible(), true, `${where}: no machine picker`);
    assert.deepEqual(await picker.locator("option").allTextContents(), ["This PC (workstation)", "Laptop", "Old box"]);

    if (mobile) {
      const notesRow = rows.filter({ hasText: "Notes" });
      for (const target of [notesRow.locator('[role="switch"]'), notesRow.locator(".sidebar-action-menu summary"), picker, page.locator("#plugins-install")]) {
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
    assert.deepEqual(await menuItems(), ["Update", "Uninstall…"]);
    await page.locator(".sidebar-action-popover:visible .sidebar-action-item", { hasText: "Update" }).click();
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Updated Notes.");
    await idle();
    await rows.filter({ hasText: "Notes" }).locator(".sidebar-action-menu summary").click();
    await menuItems();
    await page.locator(".sidebar-action-popover:visible .sidebar-action-item", { hasText: "Uninstall" }).click();
    await page.waitForFunction(() => document.querySelector("#plugins-feedback").textContent === "Uninstalled notes.");
    assert.match(confirms.at(-1), /^Uninstall Notes from This PC \(workstation\)\?/u);
    assert.deepEqual(await rows.evaluateAll((items) => items.map((row) => row.dataset.plugin)), ["herdrabbit"]);
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
    assert.deepEqual(await rows.evaluateAll((items) => items.map((row) => row.dataset.plugin)), ["herdrabbit", "tool"]);

    // Escape closes the dialog; nothing is sent.
    await page.locator("#plugins-install").click();
    await install.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await install.waitFor({ state: "hidden" });
    assert.equal(await settings.isVisible(), true, `${where}: Escape closed Settings too`);

    // Another machine: its own list, and the install warning names it.
    await picker.selectOption(LAPTOP);
    await page.waitForFunction(() => document.querySelector('.plugin-row[data-plugin="far"]'));
    assert.equal(await rows.filter({ hasText: "Far away" }).locator(".plugin-source").textContent(), "Linked from a folder");
    await rows.filter({ hasText: "Far away" }).locator(".sidebar-action-menu summary").click();
    assert.deepEqual(await menuItems(), ["Uninstall…"],
      `${where}: a linked plugin offers Update`);
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
    market = new PluginMarketplace({ fetch: fakeFetch({}, { status: 503 }).fetch });
    const browseButton = pluginsPage.locator('[data-plugins-view="browse"]');
    await browseButton.click();
    assert.equal(await browseButton.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#plugins-installed-view").isVisible(), false, `${where}: Installed still shows in Browse`);
    const browseStatus = page.locator("#plugins-browse-status");
    await page.waitForFunction(() => document.querySelector("#plugins-browse-status").dataset.error === "true");
    assert.match(await browseStatus.textContent(), /could not be read \(it answered HTTP 503\)\. You can still install a plugin by its GitHub owner\/repo with Install plugin…/u);
    assert.match(await pluginsPage.locator("#plugins-browse-view .plugin-warning").textContent(), /Nobody reviews them/u);
    const listings = page.locator("#plugins-browse-list .market-row");
    assert.equal(await listings.count(), 0);

    // Readable: a new order reads it again, Popular first by stars.
    market = new PluginMarketplace({ fetch: fakeFetch(marketIndex).fetch });
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
    assert.equal(await herdrabbitListing.locator(".plugin-state").textContent(), "Updated from About");
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
    assert.ok((await page.locator("#plugins-list .plugin-row").evaluateAll((items) => items.map((row) => row.dataset.plugin))).includes("annotate"));

    assert.deepEqual(errors, [], `${where}: page errors: ${errors.join("; ")}`);
    await context.close();
    console.log(`ok: ${where}`);
  }
  console.log("Plugins page: list, switch, menu, install with confirm, machines, sign-in only, Browse: ok");
} finally {
  await browser.close();
  signedIn.close();
  signedOut.close();
}
