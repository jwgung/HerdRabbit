// Browser check of the sidebar's session rows: a program mark on the left, the
// status at the far right, a folder line under the name, and a machine row with
// a monitor, "Host" and a connection dot. Runs against a fake herdr on a desktop
// and a phone layout. SIDEBAR_SCREENSHOTS=<folder> keeps pictures in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROWS = [
  { id: "w1:p1", tab: "Release", agent: "claude", status: "working", cwd: "/work/release-api", kind: "claude", indicator: "spinner", sub: "release-api" },
  { id: "w1:p2", tab: "Infra", agent: "claude", status: "blocked", cwd: "/work/infra", kind: "claude", indicator: "attention", sub: null },
  { id: "w1:p3", tab: "Web dashboard", agent: "codex", status: "done", cwd: "/work/web", kind: "codex", indicator: "done", sub: "web" },
  { id: "w1:p4", tab: "tests", agent: null, status: "idle", cwd: "/work/checkout-api", kind: "shell", indicator: null, sub: "checkout-api" },
  { id: "w1:p5", tab: "Research", agent: "gemini", status: "unknown", cwd: null, kind: "other", indicator: null, sub: null },
];
const snapshot = {
  focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p4",
  servers: [
    { id: "local", name: "workstation", available: true, status: "Connected" },
    { id: "laptop", name: "laptop", available: false, status: "Connecting" },
  ],
  workspaces: [{ workspace_id: "w1", label: "Platform", server_id: "local" }],
  tabs: ROWS.map((row, index) => ({ tab_id: `w1:t${index + 1}`, workspace_id: "w1", label: row.tab })),
  panes: ROWS.map((row, index) => ({
    pane_id: row.id, tab_id: `w1:t${index + 1}`, workspace_id: "w1", label: row.tab,
    ...(row.agent ? { agent: row.agent } : {}), ...(row.cwd ? { cwd: row.cwd } : {}),
  })),
  agents: ROWS.map((row) => ({ pane_id: row.id, ...(row.agent ? { agent: row.agent } : {}), state: row.status })),
};
const { server } = createHerdrHttpServer({
  herdr: { async snapshot() { return snapshot; }, async readPane() { return "$ "; }, async sendText() {}, async sendKeys() {} },
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.SIDEBAR_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p4")}`);
    if (mobile) await page.locator("#mobile-sidebar-open").click();
    await page.locator(".pane-button").first().waitFor({ state: "visible" });
    await page.waitForTimeout(600); // the sidebar finishes sliding in

    // One synchronous read of the whole sidebar: the page redraws it every two
    // seconds, and a locator held across that redraw points at a removed node.
    const read = () => page.evaluate((ids) => {
      const colour = (name, parent) => {
        const probe = document.createElement("i");
        probe.style.background = `var(${name})`;
        parent.append(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
      };
      const rows = Object.fromEntries(ids.map((id) => {
        const button = document.querySelector(`.pane-button[data-pane-id="${id}"]`);
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        const status = button.querySelector(".pane-status").getBoundingClientRect();
        const menu = button.closest(".session-row").querySelector(".session-action-menu").getBoundingClientRect();
        return [id, {
          icon: button.querySelector(".agent-icon").getAttribute("class"),
          iconHidden: button.querySelector(".agent-icon").getAttribute("aria-hidden"),
          indicator: button.querySelector(".pane-status").dataset.kind ?? null,
          sub: button.querySelector(".pane-cwd")?.textContent ?? null,
          label: button.getAttribute("aria-label"),
          pressed: button.getAttribute("aria-pressed"),
          border: style.borderTopColor,
          background: style.backgroundColor,
          height: box.height,
          statusAfterMenu: menu.right <= status.left + 1 && status.right <= box.right,
          spin: getComputedStyle(button.querySelector(".pane-status"), "::before").animationName,
        }];
      }));
      const machine = (id) => {
        const heading = document.querySelector(`.server-heading[data-server-id="${id}"]`);
        const dot = heading.querySelector(".server-dot");
        return {
          icons: heading.querySelectorAll(".server-icon").length,
          role: heading.querySelector(".server-role")?.textContent ?? null,
          dot: getComputedStyle(dot).backgroundColor,
          ok: colour("--status-ok", dot),
          offline: colour("--offline", dot),
        };
      };
      return { rows, local: machine("local"), remote: machine("laptop") };
    }, ROWS.map((row) => row.id));

    let seen = await read();
    for (const row of ROWS) {
      const got = seen.rows[row.id];
      assert.equal(got.icon, `agent-icon agent-icon-${row.kind}`, `${row.id} mark`);
      assert.equal(got.iconHidden, "true");
      assert.equal(got.indicator, row.indicator, `${row.id} status`);
      assert.equal(got.sub, row.sub, `${row.id} folder line`);
      if (row.status === "blocked") assert.match(got.label, /Needs your answer/u);
      if (row.agent) assert.match(got.label, new RegExp(row.agent, "u"));
      assert.equal(got.border, "rgba(0, 0, 0, 0)", `${row.id} has no status border`);
      assert.ok(got.height >= 40, `${row.id} is a 40px touch target`);
      assert.ok(got.statusAfterMenu, `${row.id} status after the menu`);
      assert.equal(got.pressed, String(row.id === "w1:p4"));
      assert.equal(got.background !== "rgba(0, 0, 0, 0)", row.id === "w1:p4", `${row.id} highlight only when selected`);
    }
    assert.equal(seen.rows["w1:p1"].spin, "pane-spin", "the spinner turns");
    // Held still when motion is reduced.
    await page.emulateMedia({ reducedMotion: "reduce" });
    seen = await read();
    assert.equal(seen.rows["w1:p1"].spin, "none");
    assert.equal(seen.rows["w1:p2"].spin, "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // This PC: a monitor, "Host" and a green dot. Another machine: the monitor
    // and a grey dot while it is not reached, without the "Host" label.
    assert.deepEqual([seen.local.icons, seen.local.role, seen.local.dot], [1, "Host", seen.local.ok]);
    assert.deepEqual([seen.remote.icons, seen.remote.role, seen.remote.dot], [1, null, seen.remote.offline]);

    // The menu still opens from a row and the row still selects.
    await page.locator('.session-row:has([data-pane-id="w1:p2"]) .session-action-menu > summary').click();
    assert.ok(await page.locator('.session-row:has([data-pane-id="w1:p2"]) .sidebar-action-item').first().isVisible());
    await page.keyboard.press("Escape"); // closes the menu, and a phone's sidebar with it
    if (mobile) {
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(600);
    }
    await page.locator('.pane-button[data-pane-id="w1:p3"]').click();
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p3"]')?.getAttribute("aria-pressed") === "true");
    if (mobile) {
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(600);
    }

    if (shots) {
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(500);
        await page.locator(".navigator").screenshot({ path: join(shots, `sidebar-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Sidebar rows (program mark, status at the right, folder line, machine row) on desktop and phone: passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
