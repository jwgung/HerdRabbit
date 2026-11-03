// Browser check of New session with an agent. A project's ⋯ menu opens, as a
// popover beside its button, "New session…"; the dialog offers a shell and the
// agents installed on the project's machine (this one's, or a connected PC's
// own answer), and a name. Starting one makes the tab, names it, types the
// agent's command into its pane and selects it. An agent gone by the time
// Start is pressed is refused and said so in the dialog. The top + menu's
// "New session…" opens the same dialog with a Project select: the selected
// pane's project first, every machine's projects named with their machine;
// choosing another project asks its machine for its agents and the earlier
// sessions there again. Runs on a desktop and a phone against an in-process
// fake herdr.
//
// NEW_SESSION_SHOTS=<folder> keeps pictures of the menu and the dialog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const workspaces = [
  { workspace_id: "w1", label: "Platform", herdr_session_id: "hs_local", server_id: "local" },
  { workspace_id: "lab:w1", label: "Bench", herdr_session_id: "lab!hs_work", server_id: "lab" },
];
const tabs = [
  { tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: "hs_local" },
  { tab_id: "lab:w1:t1", workspace_id: "lab:w1", label: "1", herdr_session_id: "lab!hs_work" },
];
const panes = [
  { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: "/work/alpha", herdr_session_id: "hs_local", server_id: "local" },
  { pane_id: "lab:w1:p1", tab_id: "lab:w1:t1", workspace_id: "lab:w1", label: "shell", cwd: "/work/bench", herdr_session_id: "lab!hs_work", server_id: "lab" },
];
let calls = [];
let localAgents = ["codex", "claude"];
// Claude's one earlier session in Platform's folder, offered to resume.
const EARLIER = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const agentSessions = {
  async list(agent, folder) {
    return agent === "claude" && folder === "/work/alpha" ? [{ id: EARLIER, title: "Fix login", updatedAt: Date.now() - 60_000 }] : [];
  },
};
const herdr = {
  async snapshot() {
    return {
      servers: [
        { id: "local", name: "workstation", available: true, status: "Connected" },
        { id: "lab", name: "lab", available: true, status: "Connected" },
      ],
      herdr_sessions: [
        { session_id: "hs_local", name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "workstation" },
        { session_id: "lab!hs_work", name: "work", default: false, machine_default: true, running: true, available: true, server_id: "lab", server_name: "lab" },
      ],
      workspaces: workspaces.map((item) => ({ ...item })),
      tabs: tabs.map((item) => ({ ...item })),
      panes: panes.map((item) => ({ ...item })),
      agents: [],
    };
  },
  async createTab(workspaceId) {
    calls.push(["createTab", workspaceId]);
    const n = tabs.length + 1;
    const workspace = workspaces.find((item) => item.workspace_id === workspaceId);
    tabs.push({ tab_id: `${workspaceId}:t${n}`, workspace_id: workspaceId, label: String(n), herdr_session_id: workspace.herdr_session_id });
    panes.push({ pane_id: `${workspaceId}:p${n}`, tab_id: `${workspaceId}:t${n}`, workspace_id: workspaceId, label: "shell", cwd: "/work",
      herdr_session_id: workspace.herdr_session_id, server_id: workspace.server_id });
  },
  async renameTab(tabId, label) {
    calls.push(["renameTab", tabId, label]);
    tabs.find((item) => item.tab_id === tabId).label = label;
  },
  async sendText(paneId, text, options) { calls.push(["sendText", paneId, text, options]); },
  async sendKeys() {},
  async readPane() { return "$ "; },
  agentsClient(serverId) {
    return serverId === "lab" ? { async installedAgents() { return ["opencode"]; } } : null;
  },
};
const { server } = createHerdrHttpServer({
  herdr, installedAgents: { async list() { return localAgents; } }, agentSessions, logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.NEW_SESSION_SHOTS;

try {
  for (const mobile of [false, true]) {
    const where = mobile ? "phone" : "desktop";
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });

    const openSidebar = async () => {
      if (!mobile) return;
      await page.waitForTimeout(400);
      if (await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForTimeout(400); // the phone sidebar slides in
      }
    };
    const openDialog = async (project) => {
      await openSidebar();
      const summary = page.locator(`summary[aria-label="More actions for ${project}"]`);
      await summary.click();
      const item = page.locator(".sidebar-action-item:visible", { hasText: "New session…" });
      await item.waitFor({ state: "visible" });
      return { summary, item };
    };
    const choices = (dialog) => dialog.locator("#session-agent option").evaluateAll((options) =>
      options.map((option) => [option.value, option.textContent]));

    // The menu item is a popover beside the ⋯ button, not a sheet at the foot.
    const { summary, item } = await openDialog("Platform");
    const button = await summary.boundingBox();
    const menu = await item.locator("xpath=..").boundingBox();
    assert.ok(Math.abs(menu.y - (button.y + button.height)) < 40 || Math.abs(menu.y + menu.height - button.y) < 40,
      `${where}: the menu is not beside its button: ${JSON.stringify({ button, menu })}`);
    assert.ok(menu.width < (mobile ? 390 : 1280) * 0.9, `${where}: the menu spans the screen like a sheet`);
    if (mobile) assert.ok((await item.boundingBox()).height >= 44, `${where}: the menu item is under 44px`);
    if (shots) await page.screenshot({ path: join(shots, `menu-${where}.png`) });
    await item.click();

    const dialog = page.locator("#session-dialog");
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    assert.deepEqual(await choices(dialog), [["", "Shell"], ["claude", "Claude Code"], ["codex", "Codex"]],
      `${where}: this machine's installed agents are not offered`);
    assert.match(await dialog.locator("#session-dialog-context").textContent(), /Platform.*workstation/u);
    if (mobile) {
      for (const selector of ["#session-agent", "#session-name", 'button[type="submit"]']) {
        const look = await dialog.locator(selector).evaluate((element) => ({
          // A button drawn smaller takes taps on a 44px ::before (docs/design.md).
          height: Math.max(element.getBoundingClientRect().height, parseFloat(getComputedStyle(element, "::before").height) || 0),
          font: parseFloat(getComputedStyle(element).fontSize),
        }));
        assert.ok(look.height >= 44, `${where}: ${selector} is under 44px tall (${look.height})`);
        if (selector !== 'button[type="submit"]') assert.ok(look.font >= 16, `${where}: ${selector} text is under 16px`);
      }
    }
    if (shots) await page.screenshot({ path: join(shots, `dialog-${where}.png`) });

    // Codex, named: made, named, started, selected.
    calls = [];
    await dialog.locator("#session-agent").selectOption("codex");
    await dialog.locator("#session-name").fill(`Review ${where}`);
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    const madeTab = calls[0]?.[1] === "w1" ? tabs.at(-1) : null;
    assert.ok(madeTab, `${where}: no session was made: ${JSON.stringify(calls)}`);
    const madePane = panes.at(-1).pane_id;
    assert.deepEqual(calls, [
      ["createTab", "w1"],
      ["renameTab", madeTab.tab_id, `Review ${where}`],
      ["sendText", madePane, "codex", { submit: true }],
    ], `${where}: the agent was not started as asked`);
    await page.waitForFunction((pane) => document.querySelector(`.pane-button[data-pane-id="${pane}"]`)?.getAttribute("aria-pressed") === "true", madePane);
    await openSidebar();
    await page.locator(".pane-button", { hasText: `Review ${where}` }).first().waitFor({ state: "visible" });
    if (mobile) await page.locator("#mobile-sidebar-open").click().catch(() => {});

    // A connected PC's project offers that PC's agents, and only them.
    await (await openDialog("Bench")).item.click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    assert.deepEqual(await choices(dialog), [["", "Shell"], ["opencode", "OpenCode"]], `${where}: the PC's agents are not its own`);
    assert.match(await dialog.locator("#session-dialog-context").textContent(), /Bench.* on lab\./u);
    // A shell with no name is made just as before.
    calls = [];
    await dialog.locator("#session-agent").selectOption("");
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls, [["createTab", "lab:w1"]], `${where}: a plain shell session did more than make a tab`);

    // An agent uninstalled while the dialog is open: refused, said, nothing made.
    await (await openDialog("Platform")).item.click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    assert.equal(await dialog.locator("#session-agent").inputValue(), "", `${where}: the last choice (a shell) is not chosen first`);
    await dialog.locator("#session-agent").selectOption("codex");
    localAgents = ["claude"];
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#session-dialog-feedback").dataset.error === "true");
    assert.match(await dialog.locator("#session-dialog-feedback").textContent(), /not installed/u);
    assert.deepEqual(calls, [], `${where}: a session was made for an agent that is gone`);
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    localAgents = ["codex", "claude"];

    // + → New session…: a Project select, the selected pane's project first.
    await openSidebar();
    await page.locator('.pane-button[data-pane-id="w1:p1"]').click();
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p1"]')?.getAttribute("aria-pressed") === "true");
    await openSidebar();
    await page.locator("#add-menu > summary").click();
    await page.locator("#create-session").click();
    await dialog.waitFor({ state: "visible" });
    const project = dialog.locator("#session-project");
    assert.equal(await project.isVisible(), true, `${where}: + → New session has no Project select`);
    assert.deepEqual(await project.locator("option").evaluateAll((options) => options.map((option) => [option.value, option.textContent])),
      [["w1", "workstation / Platform"], ["lab:w1", "lab / Bench"]], `${where}: every machine's projects are not offered by machine`);
    assert.equal(await project.inputValue(), "w1", `${where}: the selected pane's project is not chosen first`);
    if (mobile) {
      const look = await project.evaluate((element) => ({ height: element.getBoundingClientRect().height, font: parseFloat(getComputedStyle(element).fontSize) }));
      assert.ok(look.height >= 44 && look.font >= 16, `${where}: the Project select is too small: ${JSON.stringify(look)}`);
    }
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    assert.deepEqual(await choices(dialog), [["", "Shell"], ["claude", "Claude Code"], ["codex", "Codex"]]);
    // Claude in Platform's folder has an earlier session to resume.
    await dialog.locator("#session-agent").selectOption("claude");
    await dialog.locator("#session-resume").waitFor({ state: "visible" });
    assert.match(await dialog.locator("#session-resume").textContent(), /Fix login/u);
    if (shots) await page.screenshot({ path: join(shots, `plus-dialog-${where}.png`) });
    // Another machine's project: its own agents, and no Platform session left to resume.
    await project.selectOption("lab:w1");
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled &&
      [...document.querySelector("#session-agent").options].map((option) => option.value).join() === ",opencode");
    assert.equal(await dialog.locator("#session-resume").isVisible(), false, `${where}: the earlier sessions were not asked again`);
    await dialog.locator("#session-agent").selectOption("opencode");
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    const benchPane = panes.at(-1).pane_id;
    assert.deepEqual(calls, [["createTab", "lab:w1"], ["sendText", benchPane, "opencode", { submit: true }]],
      `${where}: the session was not made in the project chosen`);
    // A project's ⋯ menu still opens it for that project, without the select.
    await (await openDialog("Platform")).item.click();
    await dialog.waitFor({ state: "visible" });
    assert.equal(await project.isVisible(), false, `${where}: a project's own New session shows the Project select`);
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });

    assert.deepEqual(errors, [], `${where}: page errors: ${errors.join("; ")}`);
    await context.close();
  }
  console.log("new session with an installed agent and a name: ok");
} finally {
  await browser.close();
  server.close();
}
