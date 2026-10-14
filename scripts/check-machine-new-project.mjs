// Browser check of where a project is made and of the sidebar footer. New
// project sits in a machine's ⋯ menu and creates the project on that machine
// (in the selected pane's Herdr session when it is there, else the machine's
// default; the session picker lists that machine's sessions only);
// the top + menu holds only Add SSH machine, so without SSH machines it is not
// shown. The footer's uploads and settings buttons look alike, their icons
// centred. Runs on a desktop and a phone against an in-process fake herdr.
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
        { session_id: "hs_local", name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "workstation" },
        { session_id: "lab!hs_work", name: "work", default: false, machine_default: false, running: true, available: true, server_id: "lab", server_name: "lab" },
        { session_id: "lab!hs_main", name: "main", default: false, machine_default: true, running: true, available: true, server_id: "lab", server_name: "lab" },
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

    // Without SSH machines the + menu has nothing to offer.
    assert.equal(await page.locator("#add-menu").isVisible(), false, "+ menu shows with nothing in it");
    assert.equal(await page.locator("#create-project").count(), 0, "New project is still in the + menu");

    // A machine with no running Herdr session has nowhere to make one.
    const offline = page.locator('.server-heading[data-server-id="laptop"]');
    await offline.locator(".sidebar-action-menu > summary").click();
    await offline.locator(".sidebar-action-item", { hasText: "Details" }).waitFor({ state: "visible" });
    assert.equal(await offline.locator(".sidebar-action-item", { hasText: "New project" }).count(), 0,
      "an offline machine offers New project");
    // Escape also closes the phone sidebar, which slides away.
    await page.keyboard.press("Escape");
    if (mobile) {
      await page.waitForTimeout(400);
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(400);
    }

    // New project from a machine's ⋯ menu, made in that machine's session.
    const makeOn = async (serverId, label, expectedSessions, expectedSession) => {
      // Making a project closes the phone sidebar; it slides away first.
      if (mobile) {
        await page.waitForTimeout(400);
        if (await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
          await page.locator("#mobile-sidebar-open").click();
          await page.waitForTimeout(400);
        }
      }
      const heading = page.locator(`.server-heading[data-server-id="${serverId}"]`);
      await heading.locator(".sidebar-action-menu > summary").click();
      const item = heading.locator(".sidebar-action-item", { hasText: "New project" });
      await item.waitFor({ state: "visible" });
      if (shots) await page.screenshot({ path: join(shots, `machine-menu-${serverId}-${mobile ? "phone" : "desktop"}.png`) });
      await item.click();
      const dialog = page.locator("#project-dialog");
      await dialog.waitFor({ state: "visible" });
      const picker = page.locator("#project-server-session");
      assert.deepEqual(await picker.locator("option").evaluateAll((options) => options.map((option) => option.value)),
        expectedSessions, `${serverId}: the session picker lists other machines' sessions`);
      assert.equal(await picker.inputValue(), expectedSession, `${serverId}: the wrong session is picked`);
      await page.locator("#project-name").fill(label);
      await dialog.locator('button[type="submit"]').click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(created.at(-1), { label, herdrSessionId: expectedSession }, `${serverId}: the project was not made there`);
    };
    const where = mobile ? "phone" : "desktop";
    // The selected pane is on this machine, so its session is used here...
    await makeOn("local", `Local ${where}`, ["hs_local"], "hs_local");
    // ...and on another machine, that machine's own default, not its first.
    await makeOn("lab", `Lab ${where}`, ["lab!hs_work", "lab!hs_main"], "lab!hs_main");

    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    await context.close();
  }
  console.log("new project from the machine menu and the footer look: ok");
} finally {
  await browser.close();
  server.close();
}
