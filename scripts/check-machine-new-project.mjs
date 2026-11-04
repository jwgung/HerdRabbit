// Browser check of where a workspace is made and of the sidebar footer. There is
// no + at the top of the sidebar: a machine's ⋯ menu offers New workspace…, as a
// popover beside its button, and only while a Herdr session runs there. The
// dialog makes the workspace on that machine, in the selected pane's session
// when that is there, else the machine's default; a machine with more than one
// running session lets another be picked, one with a single session shows no
// picker. Its Agent choices are that machine's installed agents, each with its
// program's mark, and one chosen is started in the new workspace's first pane.
// Its Folder opens as ~ (the machine's home, sent as the folder);
// Browse… opens the Files tab's tree for this machine in folders only, and
// the folder gone into and used is where the workspace opens, and a folder typed for a connected PC goes to that PC.
// The footer's uploads and settings buttons look alike, their icons centred.
// Runs on a desktop and a phone against an in-process fake herdr.
//
// NEW_PROJECT_SHOTS=<folder> keeps pictures of the footer and the open menu.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

// This machine's home for the check, with ~/projects/shop in it.
const home = await mkdtemp(join(tmpdir(), "herdrabbit-new-project-"));
await mkdir(join(home, "projects", "shop"), { recursive: true });

const workspaces = [
  { workspace_id: "w1", label: "Platform", herdr_session_id: "hs_local", server_id: "local" },
  { workspace_id: "lab:w1", label: "Bench", herdr_session_id: "lab!hs_work", server_id: "lab" },
];
const tabs = [
  { tab_id: "w1:t1", workspace_id: "w1", label: "Shells", herdr_session_id: "hs_local" },
  { tab_id: "lab:w1:t1", workspace_id: "lab:w1", label: "Bench", herdr_session_id: "lab!hs_work" },
];
const panes = [
  { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Alpha", cwd: "/work/alpha", herdr_session_id: "hs_local", server_id: "local" },
  { pane_id: "lab:w1:p1", tab_id: "lab:w1:t1", workspace_id: "lab:w1", label: "Bench", cwd: "/work/bench", herdr_session_id: "lab!hs_work", server_id: "lab" },
];
const created = [];
const typed = [];
let sessionsDown = false;
let labWorkDown = false;
const herdr = {
  async snapshot() {
    return {
      servers: [
        { id: "local", name: "workstation", available: true, status: "Connected" },
        { id: "laptop", name: "laptop", available: false, status: "Offline" },
        { id: "lab", name: "lab", available: true, status: "Connected" },
      ],
      // As the multi-server client scopes them: only this machine's session is
      // the page's default, each machine keeps its own as machine_default.
      herdr_sessions: [
        { session_id: "hs_local", name: "default", default: true, machine_default: true, running: !sessionsDown, available: true, server_id: "local", server_name: "workstation" },
        { session_id: "lab!hs_work", name: "work", default: false, machine_default: false, running: !sessionsDown && !labWorkDown, available: true, server_id: "lab", server_name: "lab" },
        { session_id: "lab!hs_main", name: "main", default: false, machine_default: true, running: !sessionsDown, available: true, server_id: "lab", server_name: "lab" },
      ],
      workspaces: [...workspaces], tabs: [...tabs], panes: [...panes], agents: [],
    };
  },
  async createWorkspace(label, herdrSessionId, { cwd } = {}) {
    created.push({ label, herdrSessionId, ...(cwd === undefined ? {} : { cwd }) });
    const n = workspaces.length + 1;
    const server_id = herdrSessionId.startsWith("lab!") ? "lab" : "local";
    workspaces.push({ workspace_id: `w${n}`, label, herdr_session_id: herdrSessionId, server_id });
    tabs.push({ tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: "shell", herdr_session_id: herdrSessionId });
    panes.push({ pane_id: `w${n}:p1`, tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: "shell", cwd: "/work", herdr_session_id: herdrSessionId, server_id });
    // As Herdr's answer does, the create call names what it made.
    return { workspace_id: `w${n}`, tab_id: `w${n}:t1`, pane_id: `w${n}:p1` };
  },
  async readPane() { return "$ "; },
  async sendText(paneId, text) { typed.push([paneId, text]); },
  agentsClient(serverId) {
    return serverId === "lab"
      ? { async installedAgents() { return ["opencode"]; }, async namesNewProjects() { return true; }, async opensFolders() { return true; } }
      : null;
  },
  async sendKeys() {},
};
const { server } = createHerdrHttpServer({
  herdr, installedAgents: { async list() { return ["codex", "claude"]; } }, logger: { info() {}, error() {} }, homeDirectory: home,
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.NEW_PROJECT_SHOTS;

const centreOffset = (page, selector) => page.locator(selector).evaluate((button) => {
  const outer = button.getBoundingClientRect();
  const icon = button.querySelector("svg").getBoundingClientRect();
  return {
    x: Math.abs(outer.left + outer.width / 2 - (icon.left + icon.width / 2)),
    y: Math.abs(outer.top + outer.height / 2 - (icon.top + icon.height / 2)),
    background: getComputedStyle(button).backgroundColor,
    border: getComputedStyle(button).borderColor,
    radius: getComputedStyle(button).borderRadius,
    // How much of the button the drawing fills, not just the box it sits in.
    glyph: button.querySelector("svg").getBBox().width,
    // And where in its 24-unit box the drawing's middle is.
    glyphOff: (() => {
      const box = button.querySelector("svg").getBBox();
      return Math.max(Math.abs(box.x + box.width / 2 - 12), Math.abs(box.y + box.height / 2 - 12));
    })(),
    width: outer.width,
    height: outer.height,
  };
});

try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
    if (mobile) await page.locator("#mobile-sidebar-open").click();
    await page.locator(".settings-button").waitFor({ state: "visible" });
    await page.waitForTimeout(400); // the phone sidebar slides in

    // Footer: two alike squares, icons in the middle.
    const uploads = await centreOffset(page, "#file-uploads");
    const settings = await centreOffset(page, ".settings-button");
    for (const [name, look] of [["uploads", uploads], ["settings", settings]]) {
      assert.ok(look.x <= 0.5 && look.y <= 0.5, `${name} icon is off centre: ${JSON.stringify(look)}`);
    }
    for (const key of ["background", "border", "radius", "width", "height"]) {
      assert.equal(settings[key], uploads[key], `footer buttons differ in ${key}`);
    }
    assert.ok(Math.abs(settings.glyph - uploads.glyph) <= 2, `footer icons differ in size: ${uploads.glyph} vs ${settings.glyph}`);
    // A folder is wider than tall, so only the width is matched; both sit in the middle.
    for (const [name, look] of [["uploads", uploads], ["settings", settings]]) {
      assert.ok(look.glyphOff <= 1, `${name} drawing is off centre: ${look.glyphOff}`);
    }
    if (shots) await page.locator(".navigator-footer").screenshot({ path: join(shots, `footer-${mobile ? "phone" : "desktop"}.png`) });

    const where = mobile ? "phone" : "desktop";
    assert.equal(await page.locator("#add-menu, #create-session, #create-project").count(), 0, "the + menu is still there");
    const openSidebar = async () => {
      if (!mobile) return;
      await page.waitForTimeout(400);
      if (await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForTimeout(400);
      }
    };
    const machineMenu = async (serverId) => {
      await openSidebar();
      const heading = page.locator(`.server-heading[data-server-id="${serverId}"]`);
      await heading.locator(".sidebar-action-menu > summary").click();
      await heading.locator(".sidebar-action-item", { hasText: "Details" }).waitFor({ state: "visible" });
      return heading;
    };

    // This machine's ⋯ menu makes projects, first, as a popover beside its button.
    const local = await machineMenu("local");
    const item = local.locator(".sidebar-action-item", { hasText: "New workspace…" });
    assert.deepEqual((await local.locator(".sidebar-action-item").allTextContents()).map((text) => text.trim()).slice(0, 3),
      ["New workspace…", "Details", "AI accounts"], "this machine's menu does not lead with New workspace");
    const button = await local.locator(".sidebar-action-menu > summary").boundingBox();
    const menu = await local.locator(".sidebar-action-popover").boundingBox();
    assert.ok(Math.abs(menu.y - (button.y + button.height)) < 40 || Math.abs(menu.y + menu.height - button.y) < 40,
      `the machine menu is not beside its button: ${JSON.stringify({ button, menu })}`);
    if (mobile) assert.ok((await item.boundingBox()).height >= 44, "New workspace is under 44px");
    if (shots) await page.screenshot({ path: join(shots, `machine-menu-${where}.png`) });
    await page.keyboard.press("Escape");
    // An offline machine has no session to make one in.
    const laptop = await machineMenu("laptop");
    assert.equal(await laptop.locator(".sidebar-action-item", { hasText: "New workspace" }).count(), 0,
      "an offline machine offers New workspace");
    await page.keyboard.press("Escape");

    // New workspace from a machine's menu: made there, the agent chosen started.
    const makeOn = async (serverId, label, { pick = null, agent = "", sessions = [], first, agents, folder = null, cwd }) => {
      const heading = await machineMenu(serverId);
      await heading.locator(".sidebar-action-item", { hasText: "New workspace…" }).click();
      const dialog = page.locator("#project-dialog");
      await dialog.waitFor({ state: "visible" });
      const picker = page.locator("#project-server-session");
      if (sessions.length < 2) {
        assert.equal(await picker.isVisible(), false, `${label}: a single session is offered as a choice`);
      } else {
        assert.deepEqual(await picker.locator("option").evaluateAll((options) => options.map((option) => option.value)),
          sessions, `${label}: the picker is not this machine's running sessions`);
      }
      assert.equal(await picker.inputValue(), first, `${label}: the wrong session is picked first`);
      if (pick) await picker.selectOption(pick);
      // The Agent choices are the machine's agents, each with its mark.
      await page.waitForFunction((wanted) => {
        const field = document.querySelector("#project-agent");
        const seen = [...field.querySelectorAll(".agent-choice")].map((choice) =>
          [choice.querySelector("input").value, choice.querySelector("span").textContent, Boolean(choice.querySelector("svg.agent-icon"))]);
        return !field.disabled && JSON.stringify(seen) === wanted;
      }, JSON.stringify(agents.map(([value, name]) => [value, name, true])));
      if (mobile) {
        for (const height of await dialog.locator(".agent-choice").evaluateAll((items) => items.map((choice) => choice.getBoundingClientRect().height))) {
          assert.ok(height >= 44, `an Agent choice is under 44px on a phone (${height})`);
        }
      }
      if (shots) await page.screenshot({ path: join(shots, `project-dialog-${serverId}-${where}.png`) });
      if (agent) await dialog.locator(`.agent-choice[data-agent="${agent}"]`).click();
      assert.equal(await page.locator("#project-folder").inputValue(), "~", `${label}: the folder does not open as the home folder`);
      if (folder) await folder(dialog);
      await page.locator("#project-name").fill(label);
      const before = typed.length;
      await dialog.locator('button[type="submit"]').click();
      await dialog.waitFor({ state: "hidden" });
      // The folder shown is the one sent: left at ~, this PC's home, or a
      // connected PC's "~" for that PC to expand.
      const wanted = cwd ?? (serverId === "local" ? home : "~");
      assert.deepEqual(created.at(-1), { label, herdrSessionId: pick ?? first, cwd: wanted },
        `${label}: the workspace was not made there`);
      const pane = panes.at(-1).pane_id;
      assert.deepEqual(typed.slice(before), agent ? [[pane, agent]] : [],
        `${label}: the agent was not started in the new workspace's pane`);
      await page.waitForFunction((id) => document.querySelector(`.pane-button[data-pane-id="${id}"]`)?.getAttribute("aria-pressed") === "true", pane);
    };
    const localAgents = [["", "Shell"], ["claude", "Claude Code"], ["codex", "Codex"]];
    const labAgents = [["", "Shell"], ["opencode", "OpenCode"]];
    // The page opened on w1:p1, this machine's pane.
    await makeOn("local", `Local ${where}`, { first: "hs_local", agents: localAgents });
    await makeOn("local", `Codex ${where}`, { first: "hs_local", agent: "codex", agents: localAgents });
    // Browse… from ~ into projects/shop: the workspace opens there.
    const pathIs = (text) => page.waitForFunction((wanted) =>
      document.querySelector("#project-folder-picker .file-path")?.value === wanted, text);
    await makeOn("local", `Shop ${where}`, { first: "hs_local", agents: localAgents, cwd: join(home, "projects", "shop"), async folder(dialog) {
      const picker = dialog.locator("#project-folder-picker");
      await dialog.locator("#project-folder-field .folder-browse").click();
      await pathIs("~");
      assert.deepEqual(await picker.locator(".browse-row .transfer-name").allTextContents(), ["projects"], `${where}: the home folder's folders are not listed`);
      await picker.locator(".browse-row", { hasText: "projects" }).click();
      await pathIs("~/projects");
      await picker.locator(".browse-row", { hasText: "shop" }).click();
      await pathIs("~/projects/shop");
      if (mobile) {
        const height = await dialog.locator("#project-folder-field .folder-browse").evaluate((element) =>
          Math.max(element.getBoundingClientRect().height, parseFloat(getComputedStyle(element, "::before").height) || 0));
        assert.ok(height >= 44, `${where}: Browse… is under 44px tall (${height})`);
      }
      if (shots) await page.screenshot({ path: join(shots, `project-folder-${where}.png`) });
      await picker.locator(".folder-choose").click();
      await picker.waitFor({ state: "hidden" });
      assert.equal(await dialog.locator("#project-folder").inputValue(), "~/projects/shop");
    } });
    // lab runs two sessions: its default first, the other one pickable.
    await makeOn("lab", `Lab ${where}`, { first: "lab!hs_main", pick: "lab!hs_work", agent: "opencode",
      sessions: ["lab!hs_work", "lab!hs_main"], agents: labAgents });
    // A folder typed for a connected PC is that PC's to expand and check; the
    // session picked first is the selected pane's, the one just made there.
    await makeOn("lab", `Lab src ${where}`, { first: "lab!hs_work", sessions: ["lab!hs_work", "lab!hs_main"], agents: labAgents, cwd: "~/src",
      async folder(dialog) { await dialog.locator("#project-folder").fill("~/src"); } });

    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    await context.close();
  }
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  const pickedFor = async (paneId) => {
    await page.goto(`${url}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".pane-button").first().waitFor({ state: "visible" });
    const lab = page.locator('.server-heading[data-server-id="lab"]');
    await lab.locator(".sidebar-action-menu > summary").click();
    await lab.locator(".sidebar-action-item", { hasText: "New workspace…" }).click();
    await page.locator("#project-dialog").waitFor({ state: "visible" });
    const picked = await page.locator("#project-server-session").inputValue();
    await page.keyboard.press("Escape");
    return picked;
  };
  // A pane on that machine: its own session, and while that one is stopped,
  // the machine's default.
  assert.equal(await pickedFor("lab:w1:p1"), "lab!hs_work", "a remote pane's session is not picked first");
  labWorkDown = true;
  assert.equal(await pickedFor("lab:w1:p1"), "lab!hs_main", "a remote pane's stopped session does not fall to its machine's default");
  labWorkDown = false;

  // With no Herdr session running there is nowhere to make one.
  sessionsDown = true;
  await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
  await page.locator(".pane-button").first().waitFor({ state: "visible" });
  const local = page.locator('.server-heading[data-server-id="local"]');
  await local.locator(".sidebar-action-menu > summary").click();
  await local.locator(".sidebar-action-item", { hasText: "Details" }).waitFor({ state: "visible" });
  assert.equal(await local.locator(".sidebar-action-item", { hasText: "New workspace" }).count(), 0,
    "New workspace is offered with no running session");
  await context.close();
  console.log("new workspace from a machine's menu and the footer look: ok");
} finally {
  await browser.close();
  server.close();
  await rm(home, { recursive: true, force: true });
}
