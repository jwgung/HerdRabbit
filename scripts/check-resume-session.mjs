// Browser check of resuming an agent's earlier conversation from New tab. Once
// an agent is chosen, the dialog offers "Start new" and that agent's earlier
// conversations in the workspace's folder, by title and time, as text only. Picking
// one makes the tab in that folder and types the agent's resume command. A
// connected PC from before this says it cannot list them, and a new conversation
// still starts; a conversation gone by the time Resume is pressed is refused and
// said so. Runs on a desktop and a phone against an in-process fake herdr.
//
// RESUME_SESSION_SHOTS=<folder> keeps pictures of the dialog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const CLAUDE_A = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const CLAUDE_B = "1d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const MARKUP = "<img src=x onerror=\"window.__injected=1\">Fix login";
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
let claudeSessions = [
  { id: CLAUDE_A, title: MARKUP, updatedAt: Date.now() - 5 * 60_000 },
  { id: CLAUDE_B, title: "", updatedAt: Date.now() - 3 * 3_600_000 },
];
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
  async createTab(workspaceId, ...options) {
    calls.push(["createTab", workspaceId, ...options]);
    const n = tabs.length + 1;
    const workspace = workspaces.find((item) => item.workspace_id === workspaceId);
    tabs.push({ tab_id: `${workspaceId}:t${n}`, workspace_id: workspaceId, label: String(n), herdr_session_id: workspace.herdr_session_id });
    panes.push({ pane_id: `${workspaceId}:p${n}`, tab_id: `${workspaceId}:t${n}`, workspace_id: workspaceId, label: "shell",
      cwd: options[0]?.cwd ?? "/home/u", herdr_session_id: workspace.herdr_session_id, server_id: workspace.server_id });
  },
  async renameTab(tabId, label) {
    calls.push(["renameTab", tabId, label]);
    tabs.find((item) => item.tab_id === tabId).label = label;
  },
  async sendText(paneId, text, options) { calls.push(["sendText", paneId, text, options]); },
  async sendKeys() {},
  async readPane() { return "$ "; },
  // The lab PC is from before resuming: it tells its agents, not their sessions.
  agentsClient(serverId) {
    return serverId === "lab" ? { async installedAgents() { return ["opencode"]; } } : null;
  },
};
const agentSessions = {
  async list(agent, cwd) {
    calls.push(["listSessions", agent, cwd]);
    if (agent === "claude") return cwd === "/work/alpha" ? claudeSessions : [];
    return agent === "codex" ? [] : null;
  },
};
const { server } = createHerdrHttpServer({
  herdr, installedAgents: { async list() { return ["claude", "codex", "agy"]; } }, agentSessions, logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.RESUME_SESSION_SHOTS;

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
    const dialog = page.locator("#session-dialog");
    const resume = dialog.locator("#session-resume");
    const feedback = dialog.locator("#session-dialog-feedback");
    const submit = dialog.locator('button[type="submit"]');
    const openDialog = async (project) => {
      await openSidebar();
      await page.locator(`summary[aria-label="More actions for ${project}"]`).click();
      await page.locator(".sidebar-action-item:visible", { hasText: "New tab…" }).click();
      await dialog.waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("#session-agent").disabled);
    };
    const choose = async (agent) => {
      await dialog.locator(`#session-agent .agent-choice[data-agent="${agent || "shell"}"]`).click();
      await page.waitForFunction(() => !/Looking for/u.test(document.querySelector("#session-dialog-feedback").textContent));
    };
    const offered = () => resume.locator("option").evaluateAll((options) => options.map((option) => [option.value, option.textContent]));

    // A shell offers no earlier conversations.
    await openDialog("Platform");
    assert.equal(await resume.isVisible(), false, `${where}: a shell offers earlier conversations`);

    // Claude: "Start new" first, then the folder's sessions by title and time, the title as text.
    calls = [];
    await choose("claude");
    await resume.waitFor({ state: "visible" });
    assert.deepEqual(await offered(), [
      ["", "Start new"],
      [CLAUDE_A, `${MARKUP} · 5 min ago`],
      [CLAUDE_B, "Untitled conversation · 3 h ago"],
    ], `${where}: the earlier conversations are not offered as listed`);
    assert.equal(await dialog.locator("img").count(), 0, `${where}: a title was rendered as markup`);
    assert.equal(await page.evaluate(() => window.__injected ?? null), null, `${where}: a title ran as markup`);
    assert.match(await feedback.textContent(), /Earlier conversations in \/work\/alpha\./u);
    assert.equal(await submit.textContent(), "Start");
    assert.deepEqual(calls, [["listSessions", "claude", "/work/alpha"]]);
    if (mobile) {
      const look = await resume.evaluate((element) => ({
        height: element.getBoundingClientRect().height, font: parseFloat(getComputedStyle(element).fontSize),
      }));
      assert.ok(look.height >= 44, `${where}: the session choice is under 44px tall (${look.height})`);
      assert.ok(look.font >= 16, `${where}: the session choice text is under 16px`);
    }
    if (shots) await page.screenshot({ path: join(shots, `resume-${where}.png`) });

    // An agent with no earlier conversations here says so; one that cannot resume says nothing.
    await choose("codex");
    assert.equal(await resume.isVisible(), false, `${where}: an empty list is shown`);
    assert.match(await feedback.textContent(), /No earlier conversations in \/work\/alpha\./u);
    await choose("agy");
    assert.equal(await resume.isVisible(), false, `${where}: agy offers earlier conversations`);
    assert.equal(await feedback.textContent(), "");

    // Resume one: made in the folder, named, the resume command typed, selected.
    await choose("claude");
    await resume.selectOption(CLAUDE_A);
    assert.equal(await submit.textContent(), "Resume");
    await dialog.locator("#session-name").fill(`Login ${where}`);
    calls = [];
    await submit.click();
    await dialog.waitFor({ state: "hidden" });
    const madeTab = tabs.at(-1);
    const madePane = panes.at(-1).pane_id;
    assert.deepEqual(calls, [
      ["listSessions", "claude", "/work/alpha"],
      ["createTab", "w1", { cwd: "/work/alpha" }],
      ["renameTab", madeTab.tab_id, `Login ${where}`],
      ["sendText", madePane, `claude --resume ${CLAUDE_A}`, { submit: true }],
    ], `${where}: the session was not resumed as asked`);
    await page.waitForFunction((pane) => document.querySelector(`.pane-button[data-pane-id="${pane}"]`)?.getAttribute("aria-pressed") === "true", madePane);
    if (mobile) await page.locator("#mobile-sidebar-open").click().catch(() => {});

    // A session gone before Resume is pressed: refused, said, nothing made.
    await openDialog("Platform");
    await choose("claude");
    await resume.selectOption(CLAUDE_B);
    claudeSessions = claudeSessions.filter((session) => session.id !== CLAUDE_B);
    calls = [];
    await submit.click();
    await page.waitForFunction(() => document.querySelector("#session-dialog-feedback").dataset.error === "true");
    assert.match(await feedback.textContent(), /no longer in that folder/u);
    assert.deepEqual(calls, [["listSessions", "claude", "/work/alpha"]], `${where}: a session was made for one that is gone`);
    await dialog.locator("#session-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden" });
    claudeSessions = [{ id: CLAUDE_A, title: MARKUP, updatedAt: Date.now() - 5 * 60_000 },
      { id: CLAUDE_B, title: "", updatedAt: Date.now() - 3 * 3_600_000 }];

    // A connected PC from before this cannot list them; a new session still starts there.
    await openDialog("Bench");
    await choose("opencode");
    assert.equal(await resume.isVisible(), false, `${where}: an older PC's sessions are offered`);
    assert.match(await feedback.textContent(), /cannot list earlier conversations/u);
    calls = [];
    await submit.click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(calls.map(([name, ...rest]) => [name, rest[0]]), [["createTab", "lab:w1"], ["sendText", panes.at(-1).pane_id]],
      `${where}: a new session on the older PC did not start`);
    assert.equal(calls[1][2], "opencode");

    assert.deepEqual(errors, [], `${where}: page errors: ${errors.join("; ")}`);
    await context.close();
  }
  console.log("resume an agent's earlier conversation from New tab: ok");
} finally {
  await browser.close();
  server.close();
}
