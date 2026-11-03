// Browser check of AI accounts: one tab per CLI, each with its program's mark,
// over the list of the one chosen. A CLI with nothing here that the machine
// does not have installed has no tab; one gets a tab once it is installed. A
// CLI's note (unsupported, keyring) shows in its own tab. Arrow keys, Home
// and End move between tabs with one tab in the Tab order, + Add account is
// reached from the tab and opens a sign-in, and the tab of a sign-in still
// open is chosen first, else the one last chosen. On a phone every tab is a
// 44px target and a row of tabs too wide scrolls inside the dialog. Runs on a
// desktop and a phone against an in-process fake herdr and a fake account
// source.
//
// AI_ACCOUNTS_SHOTS=<folder> keeps pictures of the dialog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { AiAccountError } from "../src/ai-accounts.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "hs_local";
let workspaces = [{ workspace_id: "w1", label: "Platform", herdr_session_id: SESSION, server_id: "local" }];
let tabs = [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: SESSION }];
let panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: "/work", herdr_session_id: SESSION, server_id: "local" }];
let count = 1;
let typed = [];
const herdr = {
  async snapshot() {
    return {
      servers: [{ id: "local", name: "workstation", available: true, status: "Connected" }],
      herdr_sessions: [{ session_id: SESSION, name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "workstation" }],
      workspaces: workspaces.map((item) => ({ ...item })),
      tabs: tabs.map((item) => ({ ...item })),
      panes: panes.map((item) => ({ ...item })),
      agents: [],
    };
  },
  async createWorkspace(label) {
    count += 1;
    const id = `w${count}`;
    workspaces.push({ workspace_id: id, label, herdr_session_id: SESSION, server_id: "local" });
    tabs.push({ tab_id: `${id}:t1`, workspace_id: id, label: "1", herdr_session_id: SESSION });
    panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id, label: "shell", cwd: "/tmp", herdr_session_id: SESSION, server_id: "local" });
  },
  async closeWorkspace(id) {
    workspaces = workspaces.filter((item) => item.workspace_id !== id);
    tabs = tabs.filter((item) => item.workspace_id !== id);
    panes = panes.filter((item) => item.workspace_id !== id);
  },
  async sendText(paneId, text) { typed.push([paneId, text]); },
  async sendKeys() {},
  async readPane() { return "$ "; },
};

const account = (id, email, active = false) => ({ id, email, active, plan: null, refreshExpiresAt: null });
const LOGIN_ID = "login_11111111-2222-3333-4444-555555555555";
let openLogins = [];
const accounts = {
  async list() {
    return { clis: [
      { id: "claude", label: "Claude Code", supported: true, reason: null,
        current: account("c2", "jw@example.com", true),
        accounts: [account("c1", "hy@example.com"), account("c2", "jw@example.com", true)],
        logins: openLogins.filter((login) => login.cli === "claude").map((login) => login.id) },
      { id: "codex", label: "Codex", supported: false,
        reason: "Codex keeps its sign-in in the keyring here, so it cannot be switched.",
        current: null, accounts: [], logins: [] },
      { id: "agy", label: "Antigravity CLI", supported: false, reason: "The keyring holds the Antigravity sign-in.",
        current: null, accounts: [], logins: [] },
      { id: "kiro", label: "Kiro CLI", supported: true, reason: null, current: null,
        accounts: [account("k1", "kiro@example.com")],
        logins: openLogins.filter((login) => login.cli === "kiro").map((login) => login.id) },
    ] };
  },
  async saveCurrent(cli) { return { cli, account: null }; },
  async switch() { throw new AiAccountError("not_here", "Not used by this check."); },
  async remove() { throw new AiAccountError("not_here", "Not used by this check."); },
  async startLogin(cli) {
    openLogins.push({ cli, id: LOGIN_ID });
    return { cli, label: cli === "kiro" ? "Kiro CLI" : "Claude Code", loginId: LOGIN_ID, command: "kiro-cli login --use-device-flow" };
  },
  async finishLogin() { throw new AiAccountError("login_incomplete", "Finish signing in in the terminal first"); },
  async cancelLogin(cli, loginId) {
    openLogins = openLogins.filter((login) => login.id !== loginId);
    return { cli, loginId };
  },
};
let installed = ["claude", "codex", "kiro"];

const { server } = createHerdrHttpServer({
  herdr, aiAccounts: accounts, installedAgents: { async list() { return installed; } }, logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.AI_ACCOUNTS_SHOTS;

try {
  for (const mobile of [false, true]) {
    const where = mobile ? "phone" : "desktop";
    installed = ["claude", "codex", "kiro"];
    openLogins = [];
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 360 : 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });

    const dialog = page.locator("#ai-accounts-dialog");
    const tabList = dialog.locator('[role="tablist"]');
    const openDialog = async () => {
      if (mobile) {
        await page.waitForTimeout(400);
        if (await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
          await page.locator("#mobile-sidebar-open").click();
          await page.waitForTimeout(400); // the phone sidebar slides in
        }
      }
      await page.locator('summary[aria-label="More actions for workstation"]').click();
      await page.locator(".sidebar-action-item:visible", { hasText: "AI accounts" }).click();
      await dialog.waitFor({ state: "visible" });
      await tabList.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector("#ai-accounts-feedback").textContent === "");
    };
    const closeDialog = async () => {
      await dialog.locator("#ai-accounts-close").click();
      await dialog.waitFor({ state: "hidden" });
    };
    const tabState = () => tabList.locator('[role="tab"]').evaluateAll((items) => items.map((item) => ({
      cli: item.dataset.cli,
      selected: item.getAttribute("aria-selected"),
      tabindex: item.getAttribute("tabindex"),
      mark: item.querySelector("svg.agent-icon")?.getAttribute("class") ?? null,
      name: item.querySelector(".ai-accounts-tab-name")?.textContent,
      count: item.querySelector(".ai-accounts-tab-count")?.textContent ?? null,
      inUse: Boolean(item.querySelector(".ai-accounts-tab-in-use")),
      label: item.getAttribute("aria-label"),
      controls: item.getAttribute("aria-controls"),
    })));
    const chosen = async () => (await tabState()).find((tab) => tab.selected === "true")?.cli;
    const visiblePanel = () => dialog.locator('[role="tabpanel"]:visible');

    // Tabs for the CLIs this machine has or that have accounts; Antigravity has neither.
    await openDialog();
    let state = await tabState();
    assert.deepEqual(state.map((tab) => tab.cli), ["claude", "codex", "kiro"], `${where}: the wrong CLIs have tabs`);
    assert.deepEqual(state.map((tab) => tab.mark), ["agent-icon agent-icon-claude", "agent-icon agent-icon-codex", "agent-icon agent-icon-kiro"],
      `${where}: a tab does not wear its program's mark`);
    assert.deepEqual(state.map((tab) => tab.name), ["Claude Code", "Codex", "Kiro CLI"]);
    assert.deepEqual(state.map((tab) => [tab.count, tab.inUse]), [["2", true], [null, false], ["1", false]],
      `${where}: the counts or the in-use mark are wrong`);
    assert.equal(state[0].label, "Claude Code, 2 accounts, one in use");
    assert.deepEqual(state.map((tab) => [tab.selected, tab.tabindex]), [["true", "0"], ["false", "-1"], ["false", "-1"]],
      `${where}: the first tab is not chosen first, or more than one tab is in the Tab order`);
    for (const tab of state) {
      const panel = dialog.locator(`#${tab.controls}`);
      assert.equal(await panel.getAttribute("role"), "tabpanel");
      assert.equal(await panel.getAttribute("aria-labelledby"), `ai-accounts-tab-${tab.cli}`);
    }
    assert.equal(await visiblePanel().count(), 1, `${where}: more than one list shows`);
    const claudeRows = await visiblePanel().locator(".ai-account-row strong").allTextContents();
    assert.deepEqual(claudeRows, ["hy@example.com", "jw@example.com"], `${where}: Claude Code's list is not alone in its tab`);
    assert.equal(await visiblePanel().locator(".ai-account-row.is-active .ai-account-state").textContent(), "In use");
    assert.equal(await visiblePanel().locator(".sidebar-action-menu").count(), 1, `${where}: the other account has no ⋯ menu`);

    // On a phone: each tab is a 44px target, and the row of tabs scrolls inside the dialog.
    if (mobile) {
      for (const box of await tabList.locator('[role="tab"]').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) {
        assert.ok(box >= 44, `${where}: a tab is under 44px tall (${box})`);
      }
      const fit = await dialog.evaluate((element) => ({ dialog: element.scrollWidth - element.clientWidth }));
      assert.ok(fit.dialog <= 1, `${where}: the tabs widen the dialog (${fit.dialog}px)`);
      const overflow = await tabList.evaluate((element) => ({ style: getComputedStyle(element).overflowX }));
      assert.equal(overflow.style, "auto", `${where}: the tab row does not scroll sideways`);
    }
    if (shots) await page.screenshot({ path: join(shots, `claude-${where}.png`) });

    // A click shows only that CLI's list, with its note and no Add account where it cannot switch.
    await tabList.locator('[data-cli="codex"]').click();
    assert.equal(await chosen(), "codex");
    assert.match(await visiblePanel().locator(".ai-cli-reason").textContent(), /keyring/u, `${where}: Codex's note is not in its tab`);
    assert.equal(await visiblePanel().locator(".ai-account-add").count(), 0, `${where}: an unsupported CLI offers Add account`);
    assert.equal(await visiblePanel().getAttribute("tabindex"), "0", `${where}: a panel with no control cannot be focused`);
    assert.equal(await dialog.locator(".ai-cli-reason:visible").count(), 1);

    // Arrow keys, Home and End move the choice and the focus, wrapping at the ends.
    await tabList.locator('[data-cli="codex"]').focus();
    const press = async (key, expected) => {
      await page.keyboard.press(key);
      assert.equal(await chosen(), expected, `${where}: ${key} did not choose ${expected}`);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.cli), expected, `${where}: ${key} did not move the focus`);
      const order = (await tabState()).filter((tab) => tab.tabindex === "0").map((tab) => tab.cli);
      assert.deepEqual(order, [expected], `${where}: the Tab order is not roving`);
    };
    await press("ArrowRight", "kiro");
    await press("ArrowRight", "claude");
    await press("ArrowLeft", "kiro");
    await press("Home", "claude");
    await press("End", "kiro");
    if (mobile) {
      const seen = await tabList.evaluate((element) => {
        const tab = element.querySelector('[data-cli="kiro"]').getBoundingClientRect();
        const row = element.getBoundingClientRect();
        return tab.left >= row.left - 1 && tab.right <= row.right + 1;
      });
      assert.ok(seen, `${where}: the chosen tab is scrolled out of view`);
    }

    // Tab reaches Kiro's list; + Add account is there and opens a sign-in.
    const kiroRows = await visiblePanel().locator(".ai-account-row strong").allTextContents();
    assert.deepEqual(kiroRows, ["kiro@example.com"]);
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest("#ai-accounts-panel-kiro"))),
      `${where}: Tab from the tab does not reach its list`);
    const add = visiblePanel().locator(".ai-account-add");
    await add.waitFor({ state: "visible" });
    assert.ok(await add.isEnabled(), `${where}: Add account is not enabled`);
    if (mobile) assert.ok((await add.boundingBox()).height >= 44, `${where}: Add account is under 44px tall`);
    if (shots) await page.screenshot({ path: join(shots, `kiro-${where}.png`) });
    typed = [];
    await add.click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(typed.map(([, text]) => text), ["kiro-cli login --use-device-flow"], `${where}: Add account did not start the sign-in`);

    // The last tab chosen was Kiro; while its sign-in is open, Kiro is chosen
    // even after Claude Code is clicked and the dialog closed.
    await openDialog();
    await tabList.locator('[data-cli="claude"]').click();
    await closeDialog();
    await openDialog();
    assert.equal(await chosen(), "kiro", `${where}: the CLI being signed in is not chosen first`);
    await dialog.locator("#ai-accounts-login-cancel").click();
    await page.waitForFunction(() => document.querySelector("#ai-accounts-feedback").textContent === "Sign-in cancelled.");
    assert.equal(await chosen(), "kiro", `${where}: reloading the list moved off the chosen tab`);
    await closeDialog();
    // No sign-in open now: the tab last chosen in this browser (Claude Code).
    await openDialog();
    assert.equal(await chosen(), "claude", `${where}: the last tab chosen is not remembered`);
    await closeDialog();

    // Installed now: Antigravity gets a tab, its note inside it.
    installed = ["claude", "codex", "agy", "kiro"];
    await openDialog();
    state = await tabState();
    assert.deepEqual(state.map((tab) => tab.cli), ["claude", "codex", "agy", "kiro"], `${where}: an installed CLI has no tab`);
    await tabList.locator('[data-cli="agy"]').click();
    assert.match(await visiblePanel().locator(".ai-cli-reason").textContent(), /keyring/u);
    if (mobile) {
      const row = await tabList.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
      if (row.scroll > row.client + 1) {
        await page.keyboard.press("End");
        assert.ok(await tabList.evaluate((element) => element.scrollLeft > 0), `${where}: the tab row does not scroll to the last tab`);
      }
      if (shots) await page.screenshot({ path: join(shots, `four-tabs-${where}.png`) });
    }
    await closeDialog();

    assert.deepEqual(errors, [], `${where}: page errors: ${errors.join("; ")}`);
    await context.close();
  }
  console.log("AI accounts tabs with marks, keyboard, hidden CLI and notes: ok");
} finally {
  await browser.close();
  server.close();
}
