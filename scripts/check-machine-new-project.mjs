// Browser check of where a project is made and of the sidebar footer. New
// project sits in a machine's ⋯ menu and creates the project on that machine;
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

const workspaces = [{ workspace_id: "w1", label: "Platform" }];
const tabs = [{ tab_id: "w1:t1", workspace_id: "w1", label: "Shells" }];
const panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Alpha", cwd: "/work/alpha" }];
const created = [];
const herdr = {
  async snapshot() {
    return {
      servers: [
        { id: "local", name: "workstation", available: true, status: "Connected" },
        { id: "laptop", name: "laptop", available: false, status: "Offline" },
      ],
      workspaces: [...workspaces], tabs: [...tabs], panes: [...panes], agents: [],
    };
  },
  async createWorkspace(label) {
    created.push(label);
    const n = workspaces.length + 1;
    workspaces.push({ workspace_id: `w${n}`, label });
    tabs.push({ tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: "shell" });
    panes.push({ pane_id: `w${n}:p1`, tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: "shell", cwd: "/work" });
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

    // New project from this machine's ⋯ menu.
    const heading = page.locator('.server-heading[data-server-id="local"]');
    await heading.locator(".sidebar-action-menu > summary").click();
    const item = heading.locator(".sidebar-action-item", { hasText: "New project" });
    await item.waitFor({ state: "visible" });
    if (shots) await page.screenshot({ path: join(shots, `machine-menu-${mobile ? "phone" : "desktop"}.png`) });
    await item.click();
    const dialog = page.locator("#project-dialog");
    await dialog.waitFor({ state: "visible" });
    const label = `Made ${mobile ? "phone" : "desktop"}`;
    await page.locator("#project-name").fill(label);
    await dialog.locator('button[type="submit"]').click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(created.at(-1), label, "the project was not created");
    if (mobile) await page.locator("#mobile-sidebar-open").click().catch(() => {});
    await page.locator(".workspace-group", { hasText: label }).first().waitFor({ state: "attached" });

    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    await context.close();
  }
  console.log("new project from the machine menu and the footer look: ok");
} finally {
  await browser.close();
  server.close();
}
