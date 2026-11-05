// Browser check of the New tab dialog. The + at the top of the sidebar opens
// it on the workspace on show (Machine and Workspace selects, the machines
// with their status), and a workspace's ⋯ menu "New tab…", a popover beside
// its button, opens it on that workspace. From the top it asks Machine and
// Workspace, Folder, Agent (a one-row tab strip of the shell and the agents
// installed on that machine, this one's or a connected PC's own answer, each
// with its program's mark), the agent's earlier conversations in the Folder
// as radio rows, and a tab name. Starting one makes the tab, names it, types
// the agent's command into its pane and selects it. An agent gone by the time
// Start is pressed is refused and said so in the dialog. Choosing an agent
// with earlier conversations offers them; changing the Folder lists that
// folder's. The Folder opens with the workspace's folder (~ for this
// machine's home); ▾ opens the Files tab's tree under it for that machine in
// folders only (no file, no broken link), on the folder's parent, without the
// tree's own path field and ↑: a row's click chooses that folder, its arrow
// opens it; ▾, Escape or a click outside closes it. The Folder input completes
// as the Files path field does, and the tab opens in the folder chosen, on
// this machine or a connected PC. A folder that is not there is refused in
// the dialog. "New workspace…" makes the workspace and its first tab in one
// go. The Files tab keeps its own path field and ↑. Runs on a desktop and a
// phone against an in-process fake herdr, with a home folder of its own.
//
// NEW_SESSION_SHOTS=<folder> keeps pictures of the menu and the dialog, in
// both themes.
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
// and one in ~/beta, listed once the Folder is changed to it.
const IN_BETA = "1d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const agentSessions = {
  async list(agent, folder) {
    if (agent !== "claude") return [];
    if (folder === ALPHA) return [{ id: EARLIER, title: "Fix login", updatedAt: Date.now() - 60_000 }];
    return folder === join(home, "beta") ? [{ id: IN_BETA, title: "Beta work", updatedAt: Date.now() - 60_000 }] : [];
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
  // New workspace…: Herdr's create call names what it made, as Herdr's does.
  async createWorkspace(label, herdrSessionId, { cwd } = {}) {
    calls.push(["createWorkspace", label, herdrSessionId, ...(cwd === undefined ? [] : [cwd])]);
    const n = workspaces.length + 1;
    const server_id = herdrSessionId?.startsWith("lab!") ? "lab" : "local";
    const id = server_id === "lab" ? `lab:w${n}` : `w${n}`;
    workspaces.push({ workspace_id: id, label, herdr_session_id: herdrSessionId, server_id });
    tabs.push({ tab_id: `${id}:t1`, workspace_id: id, label: "1", herdr_session_id: herdrSessionId });
    panes.push({ pane_id: `${id}:p1`, tab_id: `${id}:t1`, workspace_id: id, label: "shell", cwd: cwd ?? home, herdr_session_id: herdrSessionId, server_id });
    return { workspace_id: id, tab_id: `${id}:t1`, pane_id: `${id}:p1` };
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
        if (path === "/work") return folder(path, ["bench"]);
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
    const closeSidebar = async () => {
      if (mobile) await page.locator("#mobile-sidebar-open").click().catch(() => {});
    };
    const openDialog = async (project) => {
      await openSidebar();
      const summary = page.locator(`summary[aria-label="More actions for ${project}"]`);
      await summary.click();
      const item = page.locator(".sidebar-action-item:visible", { hasText: "New tab…" });
      await item.waitFor({ state: "visible" });
      return { summary, item };
    };
    const dialog = page.locator("#session-dialog");
    const agentsReady = () => page.waitForFunction(() => !document.querySelector("#session-agent").disabled &&
      !/Looking for installed/u.test(document.querySelector("#session-dialog-feedback").textContent));
    // From the + at the top of the sidebar.
    const plus = async () => {
      await openSidebar();
      await page.locator("#new-tab-open").click();
      await dialog.waitFor({ state: "visible" });
      await agentsReady();
    };
    const fromMenu = async (project) => {
      await (await openDialog(project)).item.click();
      await dialog.waitFor({ state: "visible" });
      await agentsReady();
    };
    // The Agent tabs, [agent, name, mark], each with its mark drawn beside its name.
    const choices = () => dialog.locator('#session-agent [role="tab"]').evaluateAll((tabs) =>
      tabs.map((tab) => [tab.dataset.agent, tab.querySelector(".ui-tab-name").textContent,
        tab.querySelector(`svg.agent-icon-${tab.dataset.agent}`) ? "mark" : "no mark"]));
    const choose = (agent) => dialog.locator(`#session-agent [role="tab"][data-agent="${agent || "shell"}"]`).click();
    const chosen = () => dialog.locator("#session-agent").evaluate((field) => {
      const agent = field.querySelector('[role="tab"][aria-selected="true"]')?.dataset.agent ?? null;
      return agent === "shell" ? "" : agent;
    });
    const place = () => page.evaluate(() => [document.querySelector("#session-machine").value, document.querySelector("#session-workspace").value]);
    const conversations = dialog.locator("#session-conversations .conversation-list");
    const rows = () => conversations.locator(".conversation-choice").evaluateAll((labels) =>
      labels.map((label) => [label.querySelector("input").value, label.querySelector(".conversation-title").textContent, label.querySelector("input").checked]));
    const pickConversation = (id) => conversations.locator(`.conversation-choice:has(input[value="${id}"])`).click();
    assert.equal(await page.locator("#add-menu, #create-session, #create-project").count(), 0, `${where}: the old + menu is still there`);

    // The + sits at the top of the sidebar, on the logo's row, at its right.
    await openSidebar();
    const plusBox = await page.locator("#new-tab-open").boundingBox();
    const logoBox = await page.locator("#sidebar-toggle").boundingBox();
    const sidebarBox = await page.locator("#navigator").boundingBox();
    assert.ok(Math.abs((plusBox.y + plusBox.height / 2) - (logoBox.y + logoBox.height / 2)) < 4 && plusBox.x > logoBox.x + logoBox.width
      && sidebarBox.x + sidebarBox.width - (plusBox.x + plusBox.width) < 24, `${where}: the + is not at the right of the logo row: ${JSON.stringify({ plusBox, logoBox, sidebarBox })}`);
    if (mobile) assert.ok(plusBox.height >= 44 && plusBox.width >= 44, `${where}: the + is under 44px`);

    // + opens the dialog on the workspace on show, Machine and Workspace first.
    await page.locator("#new-tab-open").click();
    await dialog.waitFor({ state: "visible" });
    await agentsReady();
    assert.deepEqual(await place(), ["local", "w1"], `${where}: + did not open on the workspace on show`);
    assert.deepEqual(await page.locator("#session-machine option").evaluateAll((options) => options.map((option) => [option.value, option.textContent, option.dataset.status])),
      [["local", "workstation", "online"], ["lab", "lab", "online"]], `${where}: the machines are not listed with their status`);
    // (the desktop run's new workspace is on this machine too, by the phone's)
    const offered = await page.locator("#session-workspace option").evaluateAll((options) => options.map((option) => [option.value, option.textContent]));
    assert.deepEqual([offered[0], offered.at(-1)], [["w1", "Platform"], ["+new", "New workspace…"]], `${where}: the machine's workspaces and New workspace… are not offered`);
    assert.ok(!offered.some(([value]) => value.startsWith("lab:")), `${where}: another machine's workspace is offered`);
    assert.equal(await page.locator('#session-workspace option[value="w1"]').getAttribute("data-description"), "current", `${where}: the workspace on show is not marked current`);
    assert.equal(await dialog.locator("#session-new-workspace").isVisible(), false, `${where}: the workspace name shows for an existing workspace`);
    const tops = await page.evaluate(() => ["#session-machine", "#session-folder", "#session-agent", "#session-conversations", "#session-name", "#session-dialog-cancel"]
      .map((selector) => document.querySelector(selector).getBoundingClientRect().top));
    assert.deepEqual([...tops].sort((a, b) => a - b), tops, `${where}: the dialog is not Machine, Folder, Agent, conversations, Tab name, buttons: ${tops}`);
    assert.deepEqual(await choices(), [["shell", "Shell", "mark"], ["claude", "Claude Code", "mark"], ["codex", "Codex", "mark"]],
      `${where}: this machine's installed agents are not offered, each with its mark`);
    assert.equal(await chosen(), "", `${where}: Shell is not chosen first`);
    // the agents are one row, never wrapped
    const tabTops = await dialog.locator('#session-agent [role="tab"]').evaluateAll((tabs) => tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
    assert.equal(new Set(tabTops).size, 1, `${where}: the agent tabs wrap: ${tabTops}`);
    if (mobile) {
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 390, `${where}: the dialog is wider than the phone: ${JSON.stringify(box)}`);
      for (const selector of ['#session-agent [role="tab"][data-agent="codex"]', "#session-machine", "#session-workspace", "#session-name", "#session-folder", "#session-folder-field .folder-browse", 'button[type="submit"]', "#session-dialog-cancel"]) {
        const look = await dialog.locator(selector).evaluate((element) => ({
          // A button drawn smaller takes taps on a 44px ::before (docs/design.md).
          height: Math.max(element.getBoundingClientRect().height, parseFloat(getComputedStyle(element, "::before").height) || 0),
          font: parseFloat(getComputedStyle(element).fontSize),
        }));
        assert.ok(look.height >= 44, `${where}: ${selector} is under 44px tall (${look.height})`);
        if (selector === "#session-name" || selector === "#session-folder") assert.ok(look.font >= 16, `${where}: ${selector} text is under 16px`);
      }
    }
    const shoot = async (name) => {
      if (!shots) return;
      for (const theme of ["dark", "light"]) {
        await page.evaluate((wanted) => window.herdrTheme?.set(wanted), theme);
        await page.waitForTimeout(150);
        await page.screenshot({ path: join(shots, `${name}-${where}-${theme}.png`) });
      }
      await page.evaluate(() => window.herdrTheme?.set("dark"));
    };
    await shoot("dialog");

    // Codex, named: made, named, started, selected.
    calls = [];
    await choose("codex");
    assert.equal(await chosen(), "codex", `${where}: a click on Codex does not choose it`);
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
    await closeSidebar();

    // The ⋯ menu's item is a popover beside the ⋯ button, not a sheet at the
    // foot; it opens the dialog on that workspace. A connected PC's offers that
    // PC's agents, and only them.
    const { summary, item } = await openDialog("Bench");
    const button = await summary.boundingBox();
    const menu = await item.locator("xpath=..").boundingBox();
    assert.ok(Math.abs(menu.y - (button.y + button.height)) < 40 || Math.abs(menu.y + menu.height - button.y) < 40,
      `${where}: the menu is not beside its button: ${JSON.stringify({ button, menu })}`);
    assert.ok(menu.width < (mobile ? 390 : 1280) * 0.9, `${where}: the menu spans the screen like a sheet`);
    if (mobile) assert.ok((await item.boundingBox()).height >= 44, `${where}: the menu item is under 44px`);
    if (shots) await page.screenshot({ path: join(shots, `menu-${where}.png`) });
    await item.click();
    await dialog.waitFor({ state: "visible" });
    await agentsReady();
    assert.deepEqual(await place(), ["lab", "lab:w1"], `${where}: the ⋯ menu did not open on its workspace`);
    assert.deepEqual(await choices(), [["shell", "Shell", "mark"], ["opencode", "OpenCode", "mark"]], `${where}: the PC's agents are not its own`);
    // Choosing this machine again lists its own agents.
    await page.locator("#session-machine").selectOption("local");
    await page.waitForFunction(() => document.querySelector("#session-workspace").value === "w1");
    await agentsReady();
    assert.deepEqual((await choices()).map(([agent]) => agent), ["shell", "claude", "codex"], `${where}: another machine's agents were not asked for`);
    await page.locator("#session-machine").selectOption("lab");
    await page.waitForFunction(() => document.querySelector("#session-workspace").value === "lab:w1");
    await agentsReady();
    await page.waitForFunction(() => document.querySelector("#session-folder").value === "/work/bench");
    // A shell with no name is made just as before.
    calls = [];
    await choose("");
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls, [["createTab", "lab:w1", "/work/bench"]], `${where}: a plain shell session did more than make a tab`);
    await closeSidebar();

    // + follows what is on show: now the PC's new tab.
    await plus();
    assert.deepEqual(await place(), ["lab", "lab:w1"], `${where}: + did not follow the pane on show`);
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    await closeSidebar();

    // An agent uninstalled while the dialog is open: refused, said, nothing made.
    await fromMenu("Platform");
    assert.equal(await chosen(), "", `${where}: the last choice (a shell) is not chosen first`);
    await choose("codex");
    localAgents = ["claude"];
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#session-dialog-feedback").dataset.error === "true");
    assert.match(await dialog.locator("#session-dialog-feedback").textContent(), /not installed/u);
    assert.deepEqual(calls, [], `${where}: a session was made for an agent that is gone`);
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    localAgents = ["codex", "claude"];
    await closeSidebar();

    // Claude in Platform's folder has an earlier conversation to resume, under
    // Start new conversation; back to a shell, there is none to offer.
    await fromMenu("Platform");
    await choose("claude");
    await conversations.waitFor({ state: "visible" });
    assert.deepEqual((await rows()).map(([id, title, checked]) => [id, title, checked]),
      [["", "Start new conversation", true], [EARLIER, "Fix login", false]], `${where}: the conversations are not listed under Start new conversation`);
    assert.equal(await dialog.locator("#session-conversations").getAttribute("role"), "tabpanel");
    if (mobile) {
      for (const height of await conversations.locator(".conversation-choice").evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().height))) {
        assert.ok(height >= 44, `${where}: a conversation row is under 44px (${height})`);
      }
    }
    await shoot("resume-dialog");
    // Resuming keeps the Folder on view; changing it lists that folder's conversations.
    await pickConversation(EARLIER);
    assert.equal(await dialog.locator('button[type="submit"]').textContent(), "Resume", `${where}: picking a conversation does not say Resume`);
    assert.ok(await dialog.locator("#session-folder-field").isVisible(), `${where}: the Folder row was hidden while resuming`);
    await pickConversation("");
    await dialog.locator("#session-folder").fill("~/beta");
    await page.waitForFunction(() => /Beta work/u.test(document.querySelector("#session-conversations").textContent));
    assert.doesNotMatch(await conversations.textContent(), /Fix login/u, `${where}: the workspace's conversations stayed listed for another folder`);
    await pickConversation(IN_BETA);
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls.filter(([name]) => name !== "renameTab").map((call) => call.slice(0, 3)),
      [["createTab", "w1", join(home, "beta")], ["sendText", calls[1][1], `claude --resume ${IN_BETA}`]],
      `${where}: the conversation was not resumed in the folder chosen`);
    await closeSidebar();
    await fromMenu("Platform");
    await choose("claude");
    await conversations.waitFor({ state: "visible" });
    await choose("");
    await conversations.waitFor({ state: "hidden" });
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    await closeSidebar();

    // The Folder opens with the workspace's folder, shown from ~; ▾ opens the
    // Files tree under it on the folder's parent, the folder marked, without
    // the tree's own path field and ↑. A row's click chooses the folder (the
    // Folder input takes it), its arrow opens it in place.
    const folderInput = dialog.locator("#session-folder");
    const toggle = dialog.locator("#session-folder-field .folder-browse");
    const picker = dialog.locator("#session-folder-picker");
    const listed = () => picker.locator(".browse-tree > .browse-row .transfer-name").allTextContents();
    const row = (name) => picker.locator(".browse-row", { has: page.locator(".transfer-name", { hasText: new RegExp(`^${name}$`, "u") }) });
    const marked = () => picker.locator('.browse-row[data-selected="true"] .transfer-name').allTextContents();
    await fromMenu("Platform");
    await page.waitForFunction(() => document.querySelector("#session-folder").value === "~/alpha");
    // the agent last used (Claude, resumed above) is remembered: these are shell tabs
    await choose("");
    await toggle.click();
    await picker.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#session-folder-picker .browse-row"));
    assert.equal(await picker.locator(".file-path, .file-up, .folder-choose, .folder-close").count(), 0, `${where}: the picker still has its own path field, ↑ or buttons`);
    // notes.txt is a file and dead a link to nothing: only folders are offered.
    assert.deepEqual(await listed(), ["alpha", "beta"], `${where}: the home folder's folders are not listed, or more than its folders are`);
    assert.deepEqual(await marked(), ["alpha"], `${where}: the folder in the input is not marked in the tree`);
    if (mobile) {
      const height = await picker.locator(".browse-row").first().evaluate((element) => element.getBoundingClientRect().height);
      assert.ok(height >= 44, `${where}: a folder row is under 44px tall (${height})`);
    }
    await shoot("folder-picker");
    // a row's click chooses it, and the tree stays open
    await row("beta").click();
    await page.waitForFunction(() => document.querySelector("#session-folder").value === "~/beta");
    assert.ok(await picker.isVisible(), `${where}: choosing a folder closed the tree`);
    assert.deepEqual(await marked(), ["beta"], `${where}: the folder chosen is not marked`);
    // its arrow only opens it
    await row("beta").locator(".browse-twisty").click();
    await row("inner").waitFor({ state: "visible" });
    assert.equal(await folderInput.inputValue(), "~/beta", `${where}: opening a folder chose it`);
    await row("inner").click();
    await page.waitForFunction(() => document.querySelector("#session-folder").value === "~/beta/inner");
    // Escape closes the tree, and the dialog stays.
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "hidden" });
    assert.ok(await dialog.isVisible(), `${where}: Escape in the folder tree closed the dialog`);
    assert.equal(await folderInput.inputValue(), "~/beta/inner", `${where}: closing the tree changed the folder`);
    // ▾ again opens it on the folder chosen; ▾ closes it, and so does a click outside.
    await toggle.click();
    await picker.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('#session-folder-picker .browse-row[data-selected="true"]'));
    assert.deepEqual(await listed(), ["inner"], `${where}: the tree did not open on the chosen folder's parent`);
    await toggle.click();
    await picker.waitFor({ state: "hidden" });
    await toggle.click();
    await picker.waitFor({ state: "visible" });
    await dialog.locator("#session-dialog-title").click();
    await picker.waitFor({ state: "hidden" });
    // The Folder input completes from ~ too, and a pick is written from ~.
    await folderInput.fill("~/be");
    const suggestion = dialog.locator("#session-folder-field .file-suggestion", { hasText: "beta" });
    await suggestion.waitFor({ state: "visible" });
    await suggestion.click();
    await page.waitForFunction(() => document.querySelector("#session-folder").value === "~/beta");
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls, [["createTab", "w1", join(home, "beta")]], `${where}: the tab did not open in the folder chosen`);
    await closeSidebar();

    // A folder typed that is not there is refused in the dialog, and nothing is made.
    await fromMenu("Platform");
    await folderInput.fill("~/missing");
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#session-dialog-feedback").dataset.error === "true");
    assert.match(await dialog.locator("#session-dialog-feedback").textContent(), /no folder/u);
    assert.deepEqual(calls, [], `${where}: a tab was made in a folder that is not there`);
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    await closeSidebar();

    // A connected PC's folders are that PC's own, and its tab opens in the one chosen.
    await fromMenu("Bench");
    assert.equal(await folderInput.inputValue(), "/work/bench", `${where}: Bench's folder is not the one offered`);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('#session-folder-picker .browse-row[data-selected="true"]'));
    assert.deepEqual(await listed(), ["bench"], `${where}: the PC's folders are not its own`);
    await row("bench").locator(".browse-twisty").click();
    await row("api").waitFor({ state: "visible" });
    await row("api").click();
    await page.waitForFunction(() => document.querySelector("#session-folder").value === "/work/bench/api");
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls, [["createTab", "lab:w1", "/work/bench/api"]], `${where}: the PC's tab did not open in the folder chosen`);
    await closeSidebar();

    // New workspace…: a name, and the workspace is made with this tab as its
    // first, in the Folder, with the agent started and the tab named.
    await plus();
    await page.locator("#session-machine").selectOption("local");
    await page.waitForFunction(() => document.querySelector("#session-workspace").value === "w1");
    await agentsReady();
    await page.locator("#session-workspace").selectOption("+new");
    await dialog.locator("#session-new-workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#session-folder").value === "~");
    await choose("claude");
    assert.match(await dialog.locator("#session-conversations-note").textContent(), /new workspace starts a new conversation/u,
      `${where}: a new workspace offers earlier conversations`);
    assert.equal(await conversations.isVisible(), false);
    await choose("codex");
    assert.equal(await dialog.locator('button[type="submit"]').textContent(), "Create");
    // no name, no workspace
    calls = [];
    await dialog.locator('button[type="submit"]').click();
    assert.equal(await dialog.isVisible(), true);
    assert.deepEqual(calls, [], `${where}: a workspace was made with no name`);
    await dialog.locator("#session-workspace-name").fill(`Fresh ${where}`);
    await folderInput.fill("~/beta");
    await dialog.locator("#session-name").fill("First");
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    const fresh = workspaces.at(-1);
    assert.equal(fresh.label, `Fresh ${where}`);
    assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
      ["createWorkspace", `Fresh ${where}`, "hs_local"],
      ["sendText", `${fresh.workspace_id}:p1`, "codex"],
      ["renameTab", `${fresh.workspace_id}:t1`, "First"],
    ], `${where}: New workspace did not make the workspace and its first tab`);
    assert.equal(calls[0][3], join(home, "beta"), `${where}: the new workspace did not open in the Folder chosen`);
    await page.waitForFunction((pane) => document.querySelector(`.pane-button[data-pane-id="${pane}"]`)?.getAttribute("aria-pressed") === "true", `${fresh.workspace_id}:p1`);

    // Many agents stay one row that scrolls sideways (a swipe on a phone), the
    // far side faded with a › to page to it.
    localAgents = ["claude", "codex", "opencode", "kiro", "agy", "cursor"];
    await closeSidebar();
    await plus();
    const strip = await dialog.locator("#session-agent .ui-tab-strip-scroller").evaluate(async (scroller) => {
      const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      scroller.scrollLeft = 0;
      await settle();
      const before = { overflow: getComputedStyle(scroller).overflowX, wider: scroller.scrollWidth > scroller.clientWidth,
        end: scroller.parentElement.hasAttribute("data-overflow-end"),
        rows: new Set([...scroller.children].map((tab) => Math.round(tab.getBoundingClientRect().top))).size };
      scroller.scrollLeft = scroller.scrollWidth;
      await settle();
      return { ...before, moved: scroller.scrollLeft > 0, start: scroller.parentElement.hasAttribute("data-overflow-start") };
    });
    assert.deepEqual(strip, { overflow: "auto", wider: true, end: true, rows: 1, moved: true, start: true }, `${where}: many agents do not scroll in one row`);
    await shoot("many-agents");
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    localAgents = ["codex", "claude"];

    // The Files tab keeps its own path field and ↑, and a click on a folder
    // there opens it in place, as before.
    await openSidebar();
    await page.locator("#tab-files").click();
    await page.locator("#file-panel").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#file-tree .browse-row"));
    assert.ok(await page.locator("#file-path").isVisible() && await page.locator("#file-up").isVisible(), `${where}: the Files tab lost its path field or ↑`);
    const filesPath = await page.locator("#file-path").inputValue();
    const filesRow = page.locator("#file-tree > .browse-row", { has: page.locator(".browse-twisty") }).first();
    await filesRow.click();
    await page.waitForFunction(() => document.querySelector('#file-tree .browse-twisty[aria-expanded="true"]'));
    assert.equal(await page.locator("#file-path").inputValue(), filesPath, `${where}: a click on a Files folder went into it instead of opening it in place`);
    await page.locator("#tab-sessions").click();

    assert.deepEqual(errors, [], `${where}: page errors: ${errors.join("; ")}`);
    await context.close();
  }
  console.log("New tab from + and ⋯ (machine, workspace, new workspace, folder tree, agent strip, conversations): ok");
} finally {
  await browser.close();
  server.close();
  await rm(home, { recursive: true, force: true });
}
