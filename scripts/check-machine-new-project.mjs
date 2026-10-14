// Browser check of where a project is made and of the sidebar footer. New
// project sits in the top + menu, opened on the selected pane's Herdr session,
// and its picker lists every machine's running sessions, so a project can be
// made on another machine too; a machine's ⋯ menu does not offer it. Add SSH
// machine shows in the + menu only where SSH machines are available. The
// footer's uploads and settings buttons look alike, their icons centred. Runs
// on a desktop and a phone against an in-process fake herdr.
//
// NEW_PROJECT_SHOTS=<folder> keeps pictures of the footer and the open menu.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const workspaces = [{ workspace_id: "w1", label: "Platform", herdr_session_id: "hs_local", server_id: "local" }];
const tabs = [{ tab_id: "w1:t1", workspace_id: "w1", label: "Shells", herdr_session_id: "hs_local" }];
const panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Alpha", cwd: "/work/alpha", herdr_session_id: "hs_local", server_id: "local" }];
const created = [];
let sessionsDown = false;
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
        { session_id: "lab!hs_work", name: "work", default: false, machine_default: false, running: !sessionsDown, available: true, server_id: "lab", server_name: "lab" },
        { session_id: "lab!hs_main", name: "main", default: false, machine_default: true, running: !sessionsDown, available: true, server_id: "lab", server_name: "lab" },
      ],
      workspaces: [...workspaces], tabs: [...tabs], panes: [...panes], agents: [],
    };
  },
  async createWorkspace(label, herdrSessionId) {
    created.push({ label, herdrSessionId });
    const n = workspaces.length + 1;
    const server_id = herdrSessionId.startsWith("lab!") ? "lab" : "local";
    workspaces.push({ workspace_id: `w${n}`, label, herdr_session_id: herdrSessionId, server_id });
    tabs.push({ tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: "shell", herdr_session_id: herdrSessionId });
    panes.push({ pane_id: `w${n}:p1`, tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: "shell", cwd: "/work", herdr_session_id: herdrSessionId, server_id });
  },
  async readPane() { return "$ "; },
  async sendText() {},
  async sendKeys() {},
};
const { server } = createHerdrHttpServer({ herdr, logger: { info() {}, error() {} } });
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
    if (shots) await page.locator(".navigator-footer").screenshot({ path: join(shots, `footer-${mobile ? "phone" : "desktop"}.png`) });

    // Without SSH machines the + menu still offers New project, and not Add SSH machine.
    assert.equal(await page.locator("#add-menu").isVisible(), true, "+ menu is hidden");
    await page.locator("#add-menu > summary").click();
    await page.locator("#create-project").waitFor({ state: "visible" });
    assert.equal(await page.locator("#add-machine").isVisible(), false, "Add SSH machine shows without SSH machines");
    if (shots) await page.screenshot({ path: join(shots, `plus-menu-${mobile ? "phone" : "desktop"}.png`) });
    await page.keyboard.press("Escape");
    if (mobile) await page.waitForTimeout(400);

    // A machine's ⋯ menu does not make projects.
    if (mobile && await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(400);
    }
    const local = page.locator('.server-heading[data-server-id="local"]');
    await local.locator(".sidebar-action-menu > summary").click();
    await local.locator(".sidebar-action-item", { hasText: "Details" }).waitFor({ state: "visible" });
    assert.equal(await local.locator(".sidebar-action-item", { hasText: "New project" }).count(), 0,
      "a machine's menu offers New project");
    await page.keyboard.press("Escape");

    // New project from the + menu: the selected pane's session first, every
    // machine's running sessions to pick from.
    const makeFromPlus = async (label, pick) => {
      if (mobile) {
        await page.waitForTimeout(400);
        if (await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
          await page.locator("#mobile-sidebar-open").click();
          await page.waitForTimeout(400);
        }
      }
      await page.locator("#add-menu > summary").click();
      await page.locator("#create-project").click();
      const dialog = page.locator("#project-dialog");
      await dialog.waitFor({ state: "visible" });
      const picker = page.locator("#project-server-session");
      assert.deepEqual(await picker.locator("option").evaluateAll((options) => options.map((option) => option.value)),
        ["hs_local", "lab!hs_work", "lab!hs_main"], "the session picker misses a machine's sessions");
      assert.equal(await picker.inputValue(), "hs_local", "the selected pane's session is not picked first");
      if (pick) await picker.selectOption(pick);
      await page.locator("#project-name").fill(label);
      await dialog.locator('button[type="submit"]').click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(created.at(-1), { label, herdrSessionId: pick ?? "hs_local" }, `${label}: the project was not made there`);
    };
    const where = mobile ? "phone" : "desktop";
    await makeFromPlus(`Local ${where}`, null);
    await makeFromPlus(`Lab ${where}`, "lab!hs_main");

    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    await context.close();
  }
  // With no Herdr session running anywhere there is nowhere to make one.
  sessionsDown = true;
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
  await page.locator(".pane-button").first().waitFor({ state: "visible" });
  await page.locator("#add-menu > summary").click();
  await page.locator("#create-project").waitFor({ state: "visible" });
  assert.equal(await page.locator("#create-project").isDisabled(), true, "New project is offered with no running session");
  await context.close();
  console.log("new project from the + menu and the footer look: ok");
} finally {
  await browser.close();
  server.close();
}
