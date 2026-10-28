// Browser check of a split tab. On a wide screen the tab's heading opens the
// grid: every pane in a cell placed as Herdr lays it out, a cell too small to
// read shows its name only, a press focuses a cell and makes it the selected
// pane (typing in it reaches that pane alone, the composer follows), cells
// never resize a pane's pty, the ⋯ menu splits, zooms and closes, a refused
// split is said, and ⤢ opens the pane alone with Back to grid. A pane row in
// the sidebar opens its pane alone. Leaving the grid closes the cells'
// sockets. On a phone there is no grid: the selected pane shows with a map of
// the tab above it, and a tap on the map switches pane. Runs on a desktop and
// a phone against an in-process fake herdr.
//
// PANE_GRID_SHOTS=<folder> keeps pictures of the grid, the zoomed grid and the
// phone's map in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

// Tab w1:t1 is split: p1 on the left, p2 over p3 on the right, and p4 a sliver
// at the far right too thin to show a terminal. Tab w1:t2 has one pane.
let panes;
let rects;
let zoomed;
let nextPane;
function reset() {
  panes = [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/alpha", agent_status: "idle" },
    { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/beta", agent_status: "working" },
    { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/gamma", agent_status: "blocked" },
    { pane_id: "w1:p4", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/delta", agent_status: "done" },
    { pane_id: "w1:p9", tab_id: "w1:t2", workspace_id: "w1", cwd: "/work/solo", agent_status: "idle" },
  ];
  rects = new Map([
    ["w1:p1", { x: 0, y: 0, width: 60, height: 40 }],
    ["w1:p2", { x: 60, y: 0, width: 56, height: 20 }],
    ["w1:p3", { x: 60, y: 20, width: 56, height: 20 }],
    ["w1:p4", { x: 116, y: 0, width: 4, height: 40 }],
    ["w1:p9", { x: 0, y: 0, width: 120, height: 40 }],
  ]);
  zoomed = null;
  nextPane = 5;
}
reset();
const sent = [];
const herdr = {
  async snapshot() {
    return {
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Split work" }, { tab_id: "w1:t2", workspace_id: "w1", label: "Alone" }],
      panes: panes.map((pane) => ({ ...pane })),
      agents: [],
    };
  },
  async readPane() { return "$ "; },
  async sendText(paneId, text) { sent.push({ paneId, text }); },
  async sendKeys() {},
  async paneLayout(paneId) {
    const tabId = panes.find((pane) => pane.pane_id === paneId)?.tab_id;
    return {
      layout: {
        area: { x: 0, y: 0, width: 120, height: 40 },
        focused_pane_id: zoomed ?? paneId,
        zoomed: zoomed !== null,
        tab_id: tabId,
        panes: panes.filter((pane) => pane.tab_id === tabId).map((pane) => ({ pane_id: pane.pane_id, rect: rects.get(pane.pane_id) })),
      },
    };
  },
  async splitPane(paneId, direction) {
    const rect = rects.get(paneId);
    const id = `w1:p${nextPane++}`;
    const half = direction === "right" ? { ...rect, width: Math.floor(rect.width / 2) } : { ...rect, height: Math.floor(rect.height / 2) };
    const added = direction === "right"
      ? { ...rect, x: rect.x + half.width, width: rect.width - half.width }
      : { ...rect, y: rect.y + half.height, height: rect.height - half.height };
    rects.set(paneId, half);
    rects.set(id, added);
    const at = panes.findIndex((pane) => pane.pane_id === paneId);
    panes.splice(at + 1, 0, { pane_id: id, tab_id: panes[at].tab_id, workspace_id: "w1", cwd: panes[at].cwd, agent_status: "idle" });
    return { pane_id: id };
  },
  async zoomPane(paneId) { zoomed = zoomed === paneId ? null : paneId; },
  async closePane(paneId) { panes = panes.filter((pane) => pane.pane_id !== paneId); rects.delete(paneId); },
};

// Each pty records what was typed into it and every resize herdr would see.
const ptys = [];
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => {
    const rect = rects.get(paneId) ?? { width: 80, height: 24 };
    return { command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}`,
      cols: Math.max(1, rect.width - 2), rows: Math.max(1, rect.height - 2) };
  },
  spawnPty: (options) => {
    const paneId = options.args[2].replace(/^term_/u, "");
    const pty = {
      paneId, options, written: "", sizes: [], killed: false,
      write(data) { this.written += data; options.onData(data); },
      resize(cols, rows) { this.sizes.push([cols, rows]); },
      pause() {}, resume() {},
      kill() { this.killed = true; },
    };
    ptys.push(pty);
    setTimeout(() => options.onData(`\x1b[?1049hpane ${paneId}\r\n$ `), 10);
    return pty;
  },
});
const { server } = createHerdrHttpServer({ herdr, attachments, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });

const ptyOf = (paneId) => ptys.filter((pty) => pty.paneId === paneId && !pty.killed).at(-1);

try {
  for (const mobile of [false, true]) {
    reset();
    ptys.length = 0;
    sent.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Every frame each terminal socket sends, and whether it is closed.
    const sockets = [];
    page.on("websocket", (ws) => {
      const socket = { ws, frames: [], closed: false };
      ws.on("framesent", ({ payload }) => { try { socket.frames.push(JSON.parse(payload)); } catch {} });
      ws.on("close", () => { socket.closed = true; });
      sockets.push(socket);
    });
    const shoot = async (name) => {
      if (!process.env.PANE_GRID_SHOTS) return;
      const startTheme = await page.evaluate(() => window.herdrTheme.current());
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => window.herdrTheme.set(value), theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(process.env.PANE_GRID_SHOTS, `${name}-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
      await page.evaluate((value) => window.herdrTheme.set(value), startTheme);
    };
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#pane-title").filter({ hasText: /alpha/u }).waitFor();
    const grid = page.locator(".pane-grid");
    const cell = (paneId) => page.locator(`.pane-grid-cell[data-pane-id="${paneId}"]`);
    const cellShows = (paneId, text) => page.waitForFunction(([id, wanted]) =>
      document.querySelector(`.pane-grid-cell[data-pane-id="${id}"] .xterm-rows`)?.textContent.replace(/ /gu, " ").includes(wanted), [paneId, text]);
    const pressed = (paneId) => page.locator(`.pane-button[data-pane-id="${paneId}"]`).getAttribute("aria-pressed");

    if (!mobile) {
      // A pane row opens its pane alone, with a way to the tab's grid.
      await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
      assert.equal(await grid.isVisible(), false, "a pane of a split tab opens alone");
      await page.locator("#grid-back").waitFor({ state: "visible" });
      assert.equal(await page.locator("#pane-map").isVisible(), false, "no map on a wide screen");

      // The tab's heading opens the grid, cells placed as Herdr has them.
      const heading = page.locator('.tab-grid-open[data-tab-id="w1:t1"]');
      assert.match(await heading.textContent(), /Split work\s*4/u);
      // The single terminal lets p1 go first: every pty from here on is a cell's.
      const ptysBefore = ptys.length;
      await heading.click();
      await grid.waitFor({ state: "visible" });
      assert.equal(await heading.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("#terminal-xterm").isVisible(), false, "the single terminal steps aside");
      assert.equal(await page.locator("#grid-back").isVisible(), false);
      assert.equal(await page.locator(".pane-grid-cell").count(), 4);
      const board = await page.locator(".pane-grid-board").boundingBox();
      const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 3, `${what}: ${actual} vs ${expected}`);
      const p1 = await cell("w1:p1").boundingBox();
      const p3 = await cell("w1:p3").boundingBox();
      near(p1.width, board.width * 60 / 120, "p1 takes half the width");
      near(p1.height, board.height, "p1 takes the full height");
      near(p3.x - board.x, board.width * 60 / 120, "p3 starts halfway");
      near(p3.y - board.y, board.height / 2, "p3 sits under p2");
      for (const paneId of ["w1:p1", "w1:p2", "w1:p3"]) await cellShows(paneId, `pane ${paneId}`);
      // The sliver is a name, not a terminal.
      assert.equal(await cell("w1:p4").evaluate((node) => node.classList.contains("is-tiny")), true);
      assert.equal(await cell("w1:p4").locator(".xterm").count(), 0, "a tiny cell does not attach");
      assert.equal(ptyOf("w1:p4"), undefined);
      // Status dots per cell.
      assert.equal(await cell("w1:p2").locator(".pane-grid-status").getAttribute("class"), "pane-grid-status ui-status state-working");
      assert.equal(await cell("w1:p3").locator(".pane-grid-status").getAttribute("class"), "pane-grid-status ui-status state-blocked");
      // The selected pane is the focused cell.
      assert.equal(await cell("w1:p1").evaluate((node) => node.classList.contains("is-focused")), true);
      await shoot("grid");

      // A press focuses a cell: it is the selected pane, and typing reaches it alone.
      await cell("w1:p2").locator(".xterm").click();
      await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p2"]').classList.contains("is-focused"));
      assert.equal(await cell("w1:p1").evaluate((node) => node.classList.contains("is-focused")), false);
      assert.equal(await pressed("w1:p2"), "true", "the sidebar follows the focused cell");
      await page.keyboard.type("hello p2");
      await page.waitForTimeout(300);
      assert.match(ptyOf("w1:p2").written, /hello p2/u);
      for (const other of ["w1:p1", "w1:p3"]) assert.doesNotMatch(ptyOf(other)?.written ?? "", /hello/u, `${other} hears nothing`);
      // The composer sends to the focused cell's pane.
      await page.locator("#terminal-input").fill("from the composer");
      await page.locator("#terminal-input").press("Enter");
      await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
      await page.waitForTimeout(200);
      assert.deepEqual(sent.at(-1), { paneId: "w1:p2", text: "from the composer" });
      // A tiny cell attaches once it is focused.
      await cell("w1:p4").click();
      await cell("w1:p4").locator(".xterm").waitFor();
      await cell("w1:p1").locator(".xterm").click();

      // The ⋯ menu: split right selects the new pane in its own cell.
      const menu = async (paneId, action) => {
        await cell(paneId).locator(".pane-grid-menu > summary").click();
        await page.locator(`.pane-grid-cell[data-pane-id="${paneId}"] [data-action="${action}"]`).click();
      };
      await menu("w1:p2", "split-right");
      await cell("w1:p5").waitFor();
      await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p5"]')?.classList.contains("is-focused"));
      assert.equal(await page.locator(".pane-grid-cell").count(), 5);
      await cellShows("w1:p5", "pane w1:p5");

      // A split Herdr refuses is said.
      await page.route("**/api/panes/*/split", (route) => route.fulfill({ status: 409,
        json: { error: { code: "pane_split_failed", message: "There is no room to split this pane." } } }));
      await menu("w1:p5", "split-down");
      await page.locator("#action-feedback").filter({ hasText: "There is no room to split this pane." }).waitFor();
      await page.unroute("**/api/panes/*/split");

      // Zoom shows that pane alone, full size, until Unzoom.
      await menu("w1:p1", "zoom");
      await page.locator(".pane-grid-zoom").waitFor({ state: "visible" });
      assert.equal(await page.locator(".pane-grid-cell:visible").count(), 1);
      const zoomedBox = await cell("w1:p1").boundingBox();
      const boardNow = await page.locator(".pane-grid-board").boundingBox();
      near(zoomedBox.width, boardNow.width, "the zoomed pane fills the grid");
      await shoot("grid-zoomed");
      await page.locator(".pane-grid-unzoom").click();
      await page.locator(".pane-grid-zoom").waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.querySelectorAll(".pane-grid-cell:not([hidden])").length === 5);

      // Close: an idle pane closes at once; a blocked one asks first.
      await menu("w1:p5", "close");
      await cell("w1:p5").waitFor({ state: "detached" });
      // The selection stays in the tab, on the closed pane's neighbour.
      await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p3"]')?.classList.contains("is-focused"));
      assert.equal(await pressed("w1:p3"), "true");
      let asked = null;
      page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.dismiss(); });
      await menu("w1:p3", "close");
      await page.waitForTimeout(300);
      assert.match(asked ?? "", /waiting for your answer/u);
      assert.equal(await cell("w1:p3").count(), 1, "a dismissed close keeps the pane");

      // No grid cell ever resized a pane: no resize frame, every attach keeps the size.
      const gridSockets = sockets.filter((socket) => socket.frames.some((frame) => frame.type === "attach" && frame.keepSize === true));
      assert.ok(gridSockets.length >= 4, "each cell has its socket");
      for (const socket of gridSockets) {
        assert.deepEqual(socket.frames.filter((frame) => frame.type === "resize"), [], "a cell sends no resize");
        assert.ok(socket.frames.filter((frame) => frame.type === "attach").every((frame) => frame.keepSize === true));
      }
      for (const pty of ptys.slice(ptysBefore)) assert.deepEqual(pty.sizes, [], `${pty.paneId}'s pty keeps its size`);

      // ⤢ opens a pane alone; Back to grid returns.
      await cell("w1:p2").locator(".pane-grid-expand").click();
      await grid.waitFor({ state: "hidden" });
      await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
      assert.equal(await pressed("w1:p2"), "true");
      await page.locator("#grid-back").click();
      await grid.waitFor({ state: "visible" });
      assert.equal(await cell("w1:p2").evaluate((node) => node.classList.contains("is-focused")), true);

      // A pane row opens its pane alone, and the cells' sockets close.
      await page.locator('.pane-button[data-pane-id="w1:p3"]').click();
      await grid.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.querySelectorAll(".pane-grid-cell").length === 0);
      await page.waitForTimeout(500);
      assert.deepEqual(gridSockets.filter((socket) => !socket.closed).length, 0, "leaving the grid closes the cells' sockets");
      // A tab with one pane has no grid heading.
      assert.equal(await page.locator('.tab-grid-open[data-tab-id="w1:t2"]').count(), 0);
    } else {
      // A phone shows the pane alone with the map of its tab above it.
      const map = page.locator("#pane-map");
      await map.waitFor({ state: "visible" });
      assert.equal(await grid.isVisible(), false, "no grid on a phone");
      assert.equal(await page.locator(".pane-map-cell").count(), 4);
      assert.equal(await page.locator('.pane-map-cell[data-pane-id="w1:p1"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('.pane-map-cell[data-pane-id="w1:p3"]').getAttribute("data-status"), "blocked");
      assert.match(await page.locator(".pane-map-count").textContent(), /^1 \/ 4$/u);
      const mapBox = await page.locator(".pane-map-board").boundingBox();
      const left = await page.locator('.pane-map-cell[data-pane-id="w1:p1"]').boundingBox();
      assert.ok(Math.abs(left.width - mapBox.width / 2) <= 2, "the map keeps Herdr's proportions");
      await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
      await shoot("map");
      // A tap on the map switches pane.
      await page.locator('.pane-map-cell[data-pane-id="w1:p3"]').tap();
      await page.locator("#pane-title").filter({ hasText: /gamma/u }).waitFor();
      await page.waitForFunction(() => document.querySelector('.pane-map-cell[data-pane-id="w1:p3"]')?.getAttribute("aria-pressed") === "true");
      assert.match(await page.locator(".pane-map-count").textContent(), /^3 \/ 4$/u);
      // The tab's heading in the sidebar keeps a phone on one pane and the map.
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(400);
      await page.locator('.tab-grid-open[data-tab-id="w1:t1"]').click();
      await page.waitForTimeout(400);
      assert.equal(await grid.isVisible(), false);
      assert.equal(await map.isVisible(), true);
      // A one-pane tab has no map.
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(400);
      await page.locator('.pane-button[data-pane-id="w1:p9"]').click();
      await map.waitFor({ state: "hidden" });
    }
    assert.deepEqual(errors, [], "no script errors");
    await context.close();
    console.log(`ok: ${mobile ? "phone" : "desktop"}`);
  }
} finally {
  await browser.close();
  server.close();
}
