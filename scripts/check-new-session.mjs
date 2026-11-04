// Browser check of New tab with an agent. A workspace's ⋯ menu opens, as a
// popover beside its button, "New tab…"; the dialog offers a shell and the
// agents installed on the workspace's machine (this one's, or a connected PC's
// own answer), each a choice with its program's mark, and a name. Starting
// one makes the tab, names it, types the agent's command into its pane and
// selects it. An agent gone by the time Start is pressed is refused and said
// so in the dialog. Choosing an agent with earlier conversations in the workspace's
// folder offers them, and while one is chosen the Folder row is hidden. The
// Folder row opens with the workspace's folder (~ for this machine's home);
// Browse… opens the Files tab's tree for that machine in folders only (no
// file, no broken link) to go into, up from with ↑, and use, and the folder
// chosen is the one the tab opens in, on this machine or a connected PC. A folder that is not there is refused in the dialog. There is no + at
// the top of the sidebar. Runs on a desktop and a phone against an in-process
// fake herdr, with a home folder of its own.
//
// NEW_SESSION_SHOTS=<folder> keeps pictures of the menu and the dialog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

// This machine's home for the check: Platform works in ~/alpha.
const home = await mkdtemp(join(tmpdir(), "herdrabbit-new-session-"));
for (const folder of ["alpha/src", "beta/inner"]) await mkdir(join(home, folder), { recursive: true });
// Beside the folders, a file and a link to nothing: neither is a folder to offer.
await writeFile(join(home, "notes.txt"), "notes\n");
await symlink(join(home, "gone"), join(home, "dead"));
const ALPHA = join(home, "alpha");

const workspaces = [
  { workspace_id: "w1", label: "Platform", herdr_session_id: "hs_local", server_id: "local" },
  { workspace_id: "lab:w1", label: "Bench", herdr_session_id: "lab!hs_work", server_id: "lab" },
];
const tabs = [
  { tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: "hs_local" },
  { tab_id: "lab:w1:t1", workspace_id: "lab:w1", label: "1", herdr_session_id: "lab!hs_work" },
];
const panes = [
  { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: ALPHA, herdr_session_id: "hs_local", server_id: "local" },
  { pane_id: "lab:w1:p1", tab_id: "lab:w1:t1", workspace_id: "lab:w1", label: "shell", cwd: "/work/bench", herdr_session_id: "lab!hs_work", server_id: "lab" },
];
let calls = [];
let localAgents = ["codex", "claude"];
// Claude's one earlier conversation in Platform's folder, offered to resume.
const EARLIER = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const agentSessions = {
  async list(agent, folder) {
    return agent === "claude" && folder === ALPHA ? [{ id: EARLIER, title: "Fix login", updatedAt: Date.now() - 60_000 }] : [];
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
  async createTab(workspaceId, { cwd } = {}) {
    calls.push(["createTab", workspaceId, ...(cwd === undefined ? [] : [cwd])]);
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
    return serverId === "lab" ? { async installedAgents() { return ["opencode"]; }, async opensFolders() { return true; } } : null;
  },
  // The lab PC's own folders: its home, and Bench's folder with one inside.
  fileClient(serverId) {
    if (serverId !== "lab") return null;
    const folder = (path, names) => ({ path, parent: path === "/" ? null : path.replace(/\/[^/]+$/u, "") || "/", truncated: false, total: names.length,
      entries: names.map((name) => ({ name, path: `${path === "/" ? "" : path}/${name}`, kind: "directory", hidden: false, readable: true })) });
    return {
      async home() { return "/home/lab"; },
      async listDirectory(path) {
        if (!path) return folder("/home/lab", ["notes"]);
        if (path === "/work/bench") return folder(path, ["api", "web"]);
        return folder(path, []);
      },
    };
  },
};
const { server } = createHerdrHttpServer({
  herdr, installedAgents: { async list() { return localAgents; } }, agentSessions, logger: { info() {}, error() {} }, homeDirectory: home,
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
      const item = page.locator(".sidebar-action-item:visible", { hasText: "New tab…" });
      await item.waitFor({ state: "visible" });
      return { summary, item };
    };
    // The Agent choices, [value, name], each with a mark drawn beside its name.
    const choices = (dialog) => dialog.locator("#session-agent .agent-choice").evaluateAll((labels) =>
      labels.map((label) => [label.querySelector("input").value, label.querySelector("span").textContent,
        // its own mark: agent-icon-claude for Claude Code, the shell's for Shell
        label.querySelector(`svg.agent-icon-${label.querySelector("input").value || "shell"}`) ? "mark" : "no mark"]));
    const choose = (dialog, agent) => dialog.locator(`#session-agent .agent-choice[data-agent="${agent || "shell"}"]`).click();
    const chosen = (dialog) => dialog.locator("#session-agent").evaluate((field) => field.querySelector("input:checked")?.value ?? null);
    assert.equal(await page.locator("#add-menu, #create-session, #create-project").count(), 0, `${where}: the + menu is still there`);

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
    assert.deepEqual(await choices(dialog), [["", "Shell", "mark"], ["claude", "Claude Code", "mark"], ["codex", "Codex", "mark"]],
      `${where}: this machine's installed agents are not offered, each with its mark`);
    assert.equal(await chosen(dialog), "", `${where}: Shell is not chosen first`);
    assert.match(await dialog.locator("#session-dialog-context").textContent(), /Platform.*workstation/u);
    if (mobile) {
      for (const selector of ['#session-agent .agent-choice[data-agent="codex"]', "#session-name", "#session-folder", "#session-folder-field .folder-browse", 'button[type="submit"]']) {
        const look = await dialog.locator(selector).evaluate((element) => ({
          // A button drawn smaller takes taps on a 44px ::before (docs/design.md).
          height: Math.max(element.getBoundingClientRect().height, parseFloat(getComputedStyle(element, "::before").height) || 0),
          font: parseFloat(getComputedStyle(element).fontSize),
        }));
        assert.ok(look.height >= 44, `${where}: ${selector} is under 44px tall (${look.height})`);
        if (selector === "#session-name" || selector === "#session-folder") assert.ok(look.font >= 16, `${where}: ${selector} text is under 16px`);
      }
    }
    if (shots) await page.screenshot({ path: join(shots, `dialog-${where}.png`) });

    // Codex, named: made, named, started, selected.
    calls = [];
    await choose(dialog, "codex");
    assert.equal(await chosen(dialog), "codex", `${where}: a click on Codex does not choose it`);
    await dialog.locator("#session-name").fill(`Review ${where}`);
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    const madeTab = calls[0]?.[1] === "w1" ? tabs.at(-1) : null;
    assert.ok(madeTab, `${where}: no session was made: ${JSON.stringify(calls)}`);
    const madePane = panes.at(-1).pane_id;
    assert.deepEqual(calls, [
      ["createTab", "w1", ALPHA],
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
    assert.deepEqual(await choices(dialog), [["", "Shell", "mark"], ["opencode", "OpenCode", "mark"]], `${where}: the PC's agents are not its own`);
    assert.match(await dialog.locator("#session-dialog-context").textContent(), /Bench.* on lab\./u);
    // A shell with no name is made just as before.
    calls = [];
    await choose(dialog, "");
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls, [["createTab", "lab:w1", "/work/bench"]], `${where}: a plain shell session did more than make a tab`);

    // An agent uninstalled while the dialog is open: refused, said, nothing made.
    await (await openDialog("Platform")).item.click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    assert.equal(await chosen(dialog), "", `${where}: the last choice (a shell) is not chosen first`);
    await choose(dialog, "codex");
    localAgents = ["claude"];
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#session-dialog-feedback").dataset.error === "true");
    assert.match(await dialog.locator("#session-dialog-feedback").textContent(), /not installed/u);
    assert.deepEqual(calls, [], `${where}: a session was made for an agent that is gone`);
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    localAgents = ["codex", "claude"];

    // Claude in Platform's folder has an earlier conversation to resume; back to a
    // shell, there is none to offer.
    await (await openDialog("Platform")).item.click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    await choose(dialog, "claude");
    await dialog.locator("#session-resume").waitFor({ state: "visible" });
    assert.match(await dialog.locator("#session-resume").textContent(), /Fix login/u);
    if (shots) await page.screenshot({ path: join(shots, `resume-dialog-${where}.png`) });
    // Resuming keeps the workspace's folder: there is none to choose meanwhile.
    await dialog.locator("#session-resume").selectOption(EARLIER);
    await dialog.locator("#session-folder-field").waitFor({ state: "hidden" });
    await dialog.locator("#session-resume").selectOption("");
    await dialog.locator("#session-folder-field").waitFor({ state: "visible" });
    await choose(dialog, "");
    await dialog.locator("#session-resume").waitFor({ state: "hidden" });
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });

    // The Folder row opens with the workspace's folder, shown from ~; Browse…
    // opens the Files tree there in folders only, goes up, into a folder, and
    // uses it, and the tab opens there.
    const folderInput = dialog.locator("#session-folder");
    const picker = dialog.locator("#session-folder-picker");
    const pathIs = (wanted) => page.waitForFunction((text) =>
      document.querySelector("#session-folder-picker .file-path")?.value === text, wanted);
    const listed = () => picker.locator(".browse-row .transfer-name").allTextContents();
    const into = (name) => picker.locator(".browse-row", { has: page.locator(".transfer-name", { hasText: new RegExp(`^${name}$`, "u") }) }).click();
    await (await openDialog("Platform")).item.click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    await page.waitForFunction(() => document.querySelector("#session-folder").value === "~/alpha");
    await dialog.locator("#session-folder-field .folder-browse").click();
    await picker.waitFor({ state: "visible" });
    await pathIs("~/alpha");
    assert.deepEqual(await listed(), ["src"], `${where}: ~/alpha's folders are not listed`);
    if (mobile) {
      for (const selector of [".browse-row", ".file-up", ".folder-choose"]) {
        const height = await picker.locator(selector).first().evaluate((element) =>
          Math.max(element.getBoundingClientRect().height, parseFloat(getComputedStyle(element, "::before").height) || 0));
        assert.ok(height >= 44, `${where}: ${selector} is under 44px tall (${height})`);
      }
    }
    if (shots) await page.screenshot({ path: join(shots, `folder-picker-${where}.png`) });
    await picker.locator(".file-up").click();
    await pathIs("~");
    // notes.txt is a file and dead a link to nothing: only folders are offered.
    assert.deepEqual(await listed(), ["alpha", "beta"], `${where}: the home folder's folders are not listed, or more than its folders are`);
    // The path field completes from ~ too, and a pick is written from ~.
    const pathField = picker.locator(".file-path");
    await pathField.fill("~/be");
    await picker.locator(".file-suggestion", { hasText: "beta" }).waitFor({ state: "visible" });
    await picker.locator(".file-suggestion", { hasText: "beta" }).click();
    await page.waitForFunction(() => document.querySelector("#session-folder-picker .file-path")?.value === "~/beta");
    await picker.locator(".file-up").click();
    await pathIs("~");
    await into("beta");
    await pathIs("~/beta");
    // Escape closes the picker, and the dialog stays.
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "hidden" });
    assert.ok(await dialog.isVisible(), `${where}: Escape in the folder picker closed the dialog`);
    assert.equal(await folderInput.inputValue(), "~/alpha", `${where}: closing the picker changed the folder`);
    await dialog.locator("#session-folder-field .folder-browse").click();
    await pathIs("~/alpha");
    await picker.locator(".file-up").click();
    await pathIs("~");
    await into("beta");
    await pathIs("~/beta");
    await picker.locator(".folder-choose").click();
    await picker.waitFor({ state: "hidden" });
    assert.equal(await folderInput.inputValue(), "~/beta", `${where}: Use this folder did not fill the folder`);
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls, [["createTab", "w1", join(home, "beta")]], `${where}: the tab did not open in the folder chosen`);

    // A folder typed that is not there is refused in the dialog, and nothing is made.
    await (await openDialog("Platform")).item.click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    await folderInput.fill("~/missing");
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#session-dialog-feedback").dataset.error === "true");
    assert.match(await dialog.locator("#session-dialog-feedback").textContent(), /no folder/u);
    assert.deepEqual(calls, [], `${where}: a tab was made in a folder that is not there`);
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });

    // A connected PC's folders are that PC's own, and its tab opens in the one chosen.
    await (await openDialog("Bench")).item.click();
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    assert.equal(await folderInput.inputValue(), "/work/bench", `${where}: Bench's folder is not the one offered`);
    await dialog.locator("#session-folder-field .folder-browse").click();
    await pathIs("/work/bench");
    assert.deepEqual(await listed(), ["api", "web"], `${where}: the PC's folders are not its own`);
    await into("api");
    await pathIs("/work/bench/api");
    await picker.locator(".folder-choose").click();
    await picker.waitFor({ state: "hidden" });
    assert.equal(await folderInput.inputValue(), "/work/bench/api", `${where}: Use this folder did not fill the PC's folder`);
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls, [["createTab", "lab:w1", "/work/bench/api"]], `${where}: the PC's tab did not open in the folder chosen`);

    assert.deepEqual(errors, [], `${where}: page errors: ${errors.join("; ")}`);
    await context.close();
  }
  console.log("new session with an installed agent and a name: ok");
} finally {
  await browser.close();
  server.close();
  await rm(home, { recursive: true, force: true });
}
