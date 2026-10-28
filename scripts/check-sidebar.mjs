// Browser check of the sidebar's session rows: a program mark on the left, the
// status glyph at the far right, a folder line under the name, and a machine row with
// a monitor, "Host" and a connection dot. A split session (a tab of several
// panes) is one row: its name (the tab's, else its focus pane's title, else
// "Split session"), a grid badge with the pane count and the most urgent status
// of its panes. Its arrow shows its panes under it (kept after a reload); a
// pane there opens alone; the row opens the grid on a desktop and the pane with
// the map on a phone, stays highlighted while one of its panes is selected,
// and its ⋯ menu renames and closes the whole session.
// Runs against a fake herdr on a desktop and a phone layout.
// SIDEBAR_SCREENSHOTS=<folder> keeps pictures in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROWS = [
  { id: "w1:p1", tab: "Release", agent: "claude", status: "working", cwd: "/work/release-api", kind: "claude", glyph: "◐", sub: "release-api" },
  { id: "w1:p2", tab: "Infra", agent: "claude", status: "blocked", cwd: "/work/infra", kind: "claude", glyph: "×", sub: null },
  { id: "w1:p3", tab: "Web dashboard", agent: "codex", status: "done", cwd: "/work/web", kind: "codex", glyph: "✓", sub: "web" },
  { id: "w1:p4", tab: "tests", agent: null, status: "idle", cwd: "/work/checkout-api", kind: "shell", glyph: "○", sub: "checkout-api" },
  { id: "w1:p5", tab: "Research", agent: "gemini", status: "unknown", cwd: null, kind: "other", glyph: "·", sub: null },
  { id: "w1:p6", tab: "Docs", agent: "agy", status: "idle", cwd: "/work/docs-site", kind: "agy", glyph: "○", sub: "docs-site" },
  { id: "w1:p7", tab: "Parser", agent: "opencode", status: "working", cwd: "/work/parser-lib", kind: "opencode", glyph: "◐", sub: "parser-lib" },
];
// Three split sessions: a named one whose panes are done, working and
// blocked; an unnamed one named by its first pane's folder, working and done;
// and an unnamed one of two shells with nothing to name it, idle and done.
const SPLITS = [
  { tab: "w1:t8", label: "Pair review", panes: [
    { id: "w1:p8", agent: "claude", status: "done", cwd: "/work/pair-a" },
    { id: "w1:p9", agent: "codex", status: "working", cwd: "/work/pair-b" },
    { id: "w1:p10", agent: "claude", status: "blocked", cwd: "/work/pair-c" },
  ] },
  { tab: "w1:t9", label: "", panes: [
    { id: "w1:p11", agent: "claude", status: "working", cwd: "/work/lint" },
    { id: "w1:p12", agent: null, status: "done", cwd: "/work/lint-watch" },
  ] },
  { tab: "w1:t10", label: "", panes: [
    { id: "w1:p13", agent: null, status: "idle", cwd: null },
    { id: "w1:p14", agent: null, status: "done", cwd: null },
  ] },
];
const freshSnapshot = () => ({
  focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p4",
  servers: [
    { id: "local", name: "workstation", available: true, status: "Connected" },
    { id: "laptop", name: "laptop", available: false, status: "Connecting" },
  ],
  workspaces: [{ workspace_id: "w1", label: "Platform", server_id: "local" }],
  tabs: [
    ...ROWS.map((row, index) => ({ tab_id: `w1:t${index + 1}`, workspace_id: "w1", label: row.tab })),
    ...SPLITS.map((split) => ({ tab_id: split.tab, workspace_id: "w1", label: split.label })),
  ],
  panes: [
    ...ROWS.map((row, index) => ({
      pane_id: row.id, tab_id: `w1:t${index + 1}`, workspace_id: "w1", label: row.tab,
      ...(row.agent ? { agent: row.agent } : {}), ...(row.cwd ? { cwd: row.cwd } : {}),
    })),
    ...SPLITS.flatMap((split) => split.panes.map((pane) => ({
      pane_id: pane.id, tab_id: split.tab, workspace_id: "w1",
      ...(pane.agent ? { agent: pane.agent } : {}), ...(pane.cwd ? { cwd: pane.cwd } : {}),
    }))),
  ],
  agents: [...ROWS, ...SPLITS.flatMap((split) => split.panes)]
    .map((row) => ({ pane_id: row.id, ...(row.agent ? { agent: row.agent } : {}), state: row.status })),
});
let snapshot = freshSnapshot();
const tabCalls = [];
const { server } = createHerdrHttpServer({
  herdr: {
    async snapshot() { return structuredClone(snapshot); },
    async readPane() { return "$ "; }, async sendText() {}, async sendKeys() {},
    async paneLayout(paneId) {
      const tabId = snapshot.panes.find((pane) => pane.pane_id === paneId)?.tab_id;
      const inTab = snapshot.panes.filter((pane) => pane.tab_id === tabId);
      const width = Math.floor(120 / inTab.length);
      return { layout: { area: { x: 0, y: 0, width: 120, height: 40 }, focused_pane_id: paneId, zoomed: false, tab_id: tabId,
        panes: inTab.map((pane, index) => ({ pane_id: pane.pane_id, rect: { x: index * width, y: 0, width, height: 40 } })) } };
    },
    async renameTab(tabId, label) {
      tabCalls.push(["rename", tabId, label]);
      snapshot.tabs.find((tab) => tab.tab_id === tabId).label = label;
    },
    async closeTab(tabId) {
      tabCalls.push(["close", tabId]);
      snapshot.tabs = snapshot.tabs.filter((tab) => tab.tab_id !== tabId);
      snapshot.panes = snapshot.panes.filter((pane) => pane.tab_id !== tabId);
    },
  },
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
    snapshot = freshSnapshot();
    tabCalls.length = 0;
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
          glyph: button.querySelector(".pane-status").textContent,
          glyphColour: getComputedStyle(button.querySelector(".pane-status")).color,
          sub: button.querySelector(".pane-cwd")?.textContent ?? null,
          label: button.getAttribute("aria-label"),
          pressed: button.getAttribute("aria-pressed"),
          border: style.borderTopColor,
          background: style.backgroundColor,
          height: box.height,
          menuAfterStatus: status.right <= menu.left + 1 && menu.right <= box.right + 1,
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
      assert.equal(got.glyph, row.glyph, `${row.id} status glyph`);
      assert.equal(got.sub, row.sub, `${row.id} folder line`);
      if (row.status === "blocked") assert.match(got.label, /Needs your answer/u);
      if (row.status === "working") assert.match(got.label, /Working/u);
      if (row.agent) assert.match(got.label, new RegExp(row.agent, "u"));
      assert.equal(got.border, "rgba(0, 0, 0, 0)", `${row.id} has no status border`);
      assert.ok(got.height >= 40, `${row.id} is a 40px touch target`);
      assert.ok(got.menuAfterStatus, `${row.id} menu at the far right, after the status`);
      assert.equal(got.pressed, String(row.id === "w1:p4"));
      assert.equal(got.background !== "rgba(0, 0, 0, 0)", row.id === "w1:p4", `${row.id} highlight only when selected`);
    }
    // Every "…" in the sidebar -- machine, project, tab and session rows --
    // ends on the same vertical line.
    const menuRights = await page.evaluate(() => [...document.querySelectorAll("#workspace-list .sidebar-action-menu > summary")]
      .filter((summary) => summary.getClientRects().length > 0)
      .map((summary) => ({ kind: summary.parentElement.className, right: Math.round(summary.getBoundingClientRect().right) })));
    assert.ok(menuRights.length >= 4, "menus to compare");
    const rights = new Set(menuRights.map((menu) => menu.right));
    assert.equal(rights.size, 1, `every menu ends on one line: ${JSON.stringify(menuRights)}`);
    // each state has its own colour, from the shared status rules
    const colours = new Set(["w1:p1", "w1:p2", "w1:p3", "w1:p4"].map((id) => seen.rows[id].glyphColour));
    assert.equal(colours.size, 4, "working, blocked, done and idle differ in colour");

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

    const device = mobile ? "phone" : "desktop";
    const shoot = async (name) => {
      if (!shots) return;
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(500);
        await page.locator(".navigator").screenshot({ path: join(shots, `${name}-${device}-${theme}.png`) });
      }
      await page.evaluate(() => { delete document.documentElement.dataset.theme; });
    };
    await shoot("sidebar");
    const openSidebar = async () => {
      if (!mobile) return;
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(600);
    };

    // A split session is one row with a badge and the most urgent status.
    const splitState = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.tab-group[data-split="true"]')].map((group) => {
      const row = group.querySelector(".split-session-button");
      const arrow = group.querySelector(".split-disclosure");
      const list = group.querySelector(".split-panes");
      const shown = list.getClientRects().length > 0;
      return [group.dataset.tabId, {
        rows: group.querySelectorAll(".session-row").length,
        name: row.querySelector(".pane-title").textContent,
        badge: row.querySelector(".split-badge").textContent,
        status: row.dataset.status,
        glyph: row.querySelector(".pane-status").textContent,
        pressed: row.getAttribute("aria-pressed"),
        expanded: arrow.getAttribute("aria-expanded"),
        controls: arrow.getAttribute("aria-controls") === list.id && arrow.tagName === "BUTTON",
        shown,
        children: Object.fromEntries([...list.querySelectorAll(".pane-button")].map((button) => [button.dataset.paneId, button.getAttribute("aria-pressed")])),
        indented: shown ? list.querySelector(".pane-button").getBoundingClientRect().left > row.getBoundingClientRect().left : null,
        height: row.getBoundingClientRect().height,
        arrowLeft: arrow.getBoundingClientRect().right <= row.getBoundingClientRect().left + 1,
      }];
    })));
    let split = await splitState();
    assert.deepEqual(Object.keys(split), ["w1:t8", "w1:t9", "w1:t10"]);
    assert.deepEqual(["w1:t8", "w1:t9", "w1:t10"].map((id) => [split[id].name, split[id].badge, split[id].status, split[id].glyph]), [
      ["Pair review", "3", "blocked", "×"], // blocked beats working and done
      ["lint", "2", "working", "◐"], // working beats done; named by its first pane's folder
      ["Split session", "2", "done", "✓"], // done beats idle; nothing else to name it
    ]);
    for (const [id, tab] of Object.entries(split)) {
      assert.equal(tab.rows, 1, `${id} is one row`);
      assert.deepEqual([tab.expanded, tab.shown, tab.controls, tab.arrowLeft], ["false", false, true, true], `${id} folded, arrow on the left`);
      assert.ok(tab.height >= 40, `${id} is a 40px touch target`);
      assert.equal(tab.pressed, "false");
    }
    assert.equal(await page.locator(".tab-grid-open").count(), 0, "no separate grid heading");

    // The arrow is a button: Enter opens the pane list, Space folds it, and it
    // is still open after a reload.
    const arrow = (tabId) => page.locator(`.tab-group[data-tab-id="${tabId}"] .split-disclosure`);
    // The sidebar is redrawn every few seconds, which takes the focus off a
    // button: each key is pressed on the arrow as it is now.
    const pressOnArrow = async (key) => { await arrow("w1:t8").focus(); await page.keyboard.press(key); };
    await pressOnArrow("Enter");
    split = await splitState();
    assert.deepEqual([split["w1:t8"].expanded, split["w1:t8"].shown, split["w1:t8"].indented], ["true", true, true]);
    assert.deepEqual(Object.keys(split["w1:t8"].children), ["w1:p8", "w1:p9", "w1:p10"]);
    await pressOnArrow("Space");
    assert.equal((await splitState())["w1:t8"].shown, false);
    await pressOnArrow("Enter");
    assert.equal((await splitState())["w1:t8"].shown, true);
    await page.reload();
    await openSidebar();
    await page.locator(".split-session-button").first().waitFor({ state: "visible" });
    split = await splitState();
    assert.deepEqual([split["w1:t8"].expanded, split["w1:t8"].shown], ["true", true], "kept open after a reload");
    assert.equal(split["w1:t9"].expanded, "false", "the others stay folded");

    // A pane in the list opens alone; the row stays highlighted and the pane is
    // highlighted in the list.
    await page.locator('.pane-button[data-pane-id="w1:p9"]').click();
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p9"]')?.getAttribute("aria-pressed") === "true");
    assert.equal(await page.locator(".terminal-panel.is-grid").count(), 0, "a pane of the list opens alone");
    if (mobile) await page.locator("#pane-map").waitFor({ state: "visible" });
    await openSidebar();
    split = await splitState();
    assert.equal(split["w1:t8"].pressed, "true", "the row is highlighted for its selected pane");
    assert.deepEqual(split["w1:t8"].children, { "w1:p8": "false", "w1:p9": "true", "w1:p10": "false" });
    await shoot("split-open");

    // Folded, it stays folded with its pane selected (a redraw does not open it).
    await arrow("w1:t8").click();
    await page.waitForTimeout(2300);
    split = await splitState();
    assert.deepEqual([split["w1:t8"].expanded, split["w1:t8"].shown, split["w1:t8"].pressed], ["false", false, "true"]);
    await shoot("split-closed");

    // The row: the grid on a desktop, the pane last selected there with the map on a phone.
    await page.locator('.split-session-button[data-tab-id="w1:t8"]').click();
    if (mobile) {
      await page.locator("#pane-map").waitFor({ state: "visible" });
      assert.equal(await page.locator(".terminal-panel.is-grid").count(), 0, "no grid on a phone");
      assert.equal(await page.locator('.pane-map-cell[data-pane-id="w1:p9"]').getAttribute("aria-pressed"), "true");
    } else {
      await page.locator(".terminal-panel.is-grid").waitFor();
      await page.locator('.pane-grid-cell[data-pane-id="w1:p9"].is-focused').waitFor();
      // Enter on a row is a press too: the unnamed session opens on its first pane.
      await page.locator('.split-session-button[data-tab-id="w1:t9"]').focus();
      await page.keyboard.press("Enter");
      await page.locator('.pane-grid-cell[data-pane-id="w1:p11"].is-focused').waitFor();
    }
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p9"]').getAttribute("aria-pressed"), String(mobile));
    await openSidebar();

    // The row's ⋯ menu renames the whole session in place...
    const menuOf = (tabId) => `.tab-group[data-tab-id="${tabId}"] .session-row > .session-action-menu`;
    await page.locator(`${menuOf("w1:t9")} > summary`).click();
    await page.locator(`${menuOf("w1:t9")} .sidebar-action-item`, { hasText: "Rename" }).click();
    if (mobile && !(await page.locator('.tab-group[data-tab-id="w1:t9"] .split-session-row input').isVisible())) await openSidebar();
    const input = page.locator('.tab-group[data-tab-id="w1:t9"] .split-session-row input');
    await input.fill("Lint pair");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector('.split-session-button[data-tab-id="w1:t9"] .pane-title')?.textContent === "Lint pair");
    assert.deepEqual(tabCalls.at(-1), ["rename", "w1:t9", "Lint pair"]);
    // ...and closes it, once the user says so.
    let asked = null;
    page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.accept(); });
    await page.locator(`${menuOf("w1:t10")} > summary`).click();
    await page.locator(`${menuOf("w1:t10")} .sidebar-action-item`, { hasText: "Close session" }).click();
    await page.locator('.tab-group[data-tab-id="w1:t10"]').waitFor({ state: "detached" });
    assert.match(asked ?? "", /Close session “Split session”/u);
    assert.deepEqual(tabCalls.at(-1), ["close", "w1:t10"]);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Sidebar rows (program mark, status glyph at the right, folder line, machine row; a split session as one row with its pane list) on desktop and phone: passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
