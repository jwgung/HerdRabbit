// Browser check of a split tab. On a wide screen the tab's heading opens the
// grid: every pane in a cell placed as Herdr lays it out, a cell too small to
// read shows its name only, a press focuses a cell and makes it the selected
// pane (typing in it reaches that pane alone, the composer follows), cells
// never resize a pane's pty, the ⋯ menu splits, zooms and closes, a refused
// split is said, and ⤢ opens the pane alone with Back to grid. A pane row in
// the sidebar opens its pane alone. Leaving the grid closes the cells'
// sockets. No cell attaches before Herdr's layout is read, a close always
// says the user meant it, and the cells follow the terminal font size. On a
// phone there is no grid: the selected pane shows with a map of the tab above
// it, a pane the layout does not have yet is still counted and tappable, and
// a tap on the map switches pane. A connected PC's split tab is its pane rows
// only: no grid, no map. Behind a password, a grid is not redrawn while
// nothing changed, has no terminal find, completes a notification for its
// pane once that pane's cell is on screen (not zoomed out), and its cells
// reconnect after a hidden page or a sign-out and sign-in.
// Runs on a desktop and a phone against an in-process fake herdr.
//
// PANE_GRID_SHOTS=<folder> keeps pictures of the grid, the zoomed grid and the
// phone's map in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { createPasswordConfiguration, PasswordAuth } from "../src/password-auth.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

// Tab w1:t1 is split: p1 on the left, p2 over p3 on the right, and p4 a sliver
// at the far right too thin to show a terminal. Tab w1:t2 has one pane. The
// laptop (a connected PC) has a split tab of its own.
const laptop = { server_id: "laptop", herdr_session_id: "laptop!hs_x" };
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
    { pane_id: "laptop!w1:p1", tab_id: "laptop!w1:t1", workspace_id: "laptop!w1", cwd: "/home/one", agent_status: "idle", ...laptop },
    { pane_id: "laptop!w1:p2", tab_id: "laptop!w1:t1", workspace_id: "laptop!w1", cwd: "/home/two", agent_status: "idle", ...laptop },
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
      workspaces: [{ workspace_id: "w1", label: "Platform" }, { workspace_id: "laptop!w1", label: "Laptop work", ...laptop }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Split work" }, ...(panes.some((pane) => pane.tab_id === "w1:t3") ? [{ tab_id: "w1:t3", workspace_id: "w1", label: "Second split" }] : []), { tab_id: "w1:t2", workspace_id: "w1", label: "Alone" },
        { tab_id: "laptop!w1:t1", workspace_id: "laptop!w1", label: "Laptop split", ...laptop }],
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
    // herdr asks the attaching terminal what it supports (mode 1016, device
    // attributes); xterm answers on its own, and that answer is not typing.
    setTimeout(() => options.onData(`\x1b[?1049hpane ${paneId}\r\n$ \x1b[?1016$p\x1b[c`), 10);
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
    // On a phone, p8 has just been split off: Herdr's layout does not have it yet.
    if (mobile) panes.splice(4, 0, { pane_id: "w1:p8", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/epsilon", agent_status: "idle" });
    ptys.length = 0;
    sent.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Every frame each terminal socket sends, and whether it is closed.
    const sockets = [];
    // What the page asks of the server for each pane's layout and close.
    const layoutReads = [];
    const closeBodies = [];
    page.on("request", (request) => {
      const path = decodeURIComponent(new URL(request.url()).pathname);
      if (path.endsWith("/layout")) layoutReads.push(path.split("/")[3]);
      if (/^\/api\/panes\/[^/]+\/close$/u.test(path)) closeBodies.push(request.postDataJSON());
    });
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
      // A pane shown alone needs no layout.
      await page.waitForTimeout(400);
      assert.deepEqual(layoutReads, [], "no layout is read for a pane shown alone");
      // The single terminal lets p1 go first: every pty from here on is a cell's.
      const ptysBefore = ptys.length;
      // Until Herdr's layout is read, the cells wait unattached: none attaches
      // at a guessed size only to let go again.
      let releaseLayout;
      const layoutHeld = new Promise((resolve) => { releaseLayout = resolve; });
      await page.route("**/api/panes/*/layout", async (route) => { await layoutHeld; await route.continue(); });
      await heading.click();
      await grid.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelectorAll(".pane-grid-cell").length === 4);
      await page.waitForTimeout(400);
      assert.equal(await page.locator(".pane-grid-cell .xterm").count(), 0, "no cell attaches before the layout");
      assert.equal(sockets.filter((socket) => socket.frames.some((frame) => frame.type === "attach" && frame.keepSize === true)).length, 0);
      const layoutRead = page.waitForResponse((response) => response.url().endsWith("/layout"));
      releaseLayout();
      await layoutRead;
      await page.unroute("**/api/panes/*/layout");
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
      // A cell's terminal never answers herdr's capability queries into the pane
      // (the shell would print the answer as typed text).
      await page.waitForTimeout(500);
      for (const paneId of ["w1:p1", "w1:p2", "w1:p3"]) {
        assert.equal(ptyOf(paneId).written, "", `${paneId} is typed nothing by its cell`);
      }
      // The key bar under the grid is the grid it always is, not a row of
      // buttons shrunk to their text.
      assert.equal(await page.locator("#quick-keys").evaluate((node) => getComputedStyle(node).display), "grid");
      const keyWidths = await page.locator("#quick-keys button").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
      assert.ok(Math.max(...keyWidths) - Math.min(...keyWidths) <= 2, `the keys are as wide as each other: ${keyWidths}`);
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

      // Close: an idle pane closes at once; a blocked one asks first. Either
      // way the server is told the user meant it.
      await menu("w1:p5", "close");
      await cell("w1:p5").waitFor({ state: "detached" });
      assert.deepEqual(closeBodies, [{ confirmed: true }]);
      // The selection stays in the tab, on the closed pane's neighbour.
      await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p3"]')?.classList.contains("is-focused"));
      assert.equal(await pressed("w1:p3"), "true");
      let asked = null;
      page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.dismiss(); });
      await menu("w1:p3", "close");
      await page.waitForTimeout(300);
      assert.match(asked ?? "", /waiting for your answer/u);
      assert.equal(await cell("w1:p3").count(), 1, "a dismissed close keeps the pane");
      assert.equal(closeBodies.length, 1, "a dismissed close asks nothing");
      // The cells follow the terminal font size: a smaller one shrinks them.
      const screenWidth = (paneId) => cell(paneId).locator(".xterm-screen").evaluate((node) => node.offsetWidth);
      const setting = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size")));
      const [widthBefore, sizeBefore] = [await screenWidth("w1:p1"), await setting()];
      const p1Box = await cell("w1:p1").boundingBox();
      await page.mouse.move(p1Box.x + p1Box.width / 2, p1Box.y + p1Box.height / 2);
      await page.keyboard.down("Control");
      for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 120);
      await page.keyboard.up("Control");
      assert.ok(await setting() < sizeBefore, "the setting got smaller");
      await page.waitForFunction(([width]) =>
        document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"] .xterm-screen').offsetWidth < width, [widthBefore]);

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
      // A layout read still in flight for one tab does not leave the next tab's
      // grid blank: tab A's answer is held, tab B is chosen, B's cells attach.
      panes.push({ pane_id: "w1:p20", tab_id: "w1:t3", workspace_id: "w1", cwd: "/work/zeta", agent_status: "idle" },
        { pane_id: "w1:p21", tab_id: "w1:t3", workspace_id: "w1", cwd: "/work/eta", agent_status: "idle" });
      rects.set("w1:p20", { x: 0, y: 0, width: 60, height: 40 });
      rects.set("w1:p21", { x: 60, y: 0, width: 60, height: 40 });
      // Tab A's first read is held and then answers with A as it was (p3
      // zoomed); the reads after it answer at once.
      let releaseA;
      const heldA = new Promise((resolve) => { releaseA = resolve; });
      let readsOfA = 0;
      let staleAnswered;
      const staleA = { layout: { area: { x: 0, y: 0, width: 120, height: 40 }, focused_pane_id: "w1:p3", zoomed: true, tab_id: "w1:t1",
        panes: ["w1:p1", "w1:p2", "w1:p3", "w1:p4"].map((pane_id) => ({ pane_id, rect: rects.get(pane_id) })) } };
      await page.route("**/api/panes/*/layout", async (route) => {
        if (decodeURIComponent(route.request().url()).includes("/w1:p1/") && ++readsOfA === 1) {
          await heldA;
          staleAnswered = route.fulfill({ json: staleA }).catch(() => {});
          return;
        }
        await route.continue().catch(() => {});
      });
      await page.locator('.tab-grid-open[data-tab-id="w1:t3"]').waitFor({ timeout: 8000 });
      // Past the layout's age, so opening tab A reads it again, and that read is held.
      await page.waitForTimeout(3300);
      const heldRead = page.waitForRequest((request) => decodeURIComponent(request.url()).includes("/w1:p1/layout"));
      await page.locator('.tab-grid-open[data-tab-id="w1:t1"]').click();
      await heldRead;
      await page.locator('.tab-grid-open[data-tab-id="w1:t3"]').click();
      await page.waitForFunction(() => document.querySelectorAll('.pane-grid-cell[data-pane-id^="w1:p2"]').length === 2);
      await cell("w1:p20").locator(".xterm").waitFor({ timeout: 4000 });
      // Back to tab A: a second read of it answers while the first is still
      // held, and the first, answering last, does not undo it.
      await page.locator('.tab-grid-open[data-tab-id="w1:t1"]').click();
      await cell("w1:p1").locator(".xterm").waitFor({ timeout: 4000 });
      assert.ok(readsOfA >= 2, "tab A is read again");
      releaseA();
      while (!staleAnswered) await page.waitForTimeout(20);
      await staleAnswered;
      await page.waitForTimeout(400);
      assert.equal(await page.locator(".pane-grid-zoom").isVisible(), false, "an older read of the tab answering late is dropped");
      assert.equal(await page.locator(".pane-grid-cell:not([hidden])").count(), 4);
      await page.unroute("**/api/panes/*/layout");
      await page.locator('.tab-grid-open[data-tab-id="w1:t3"]').click();
      // Tab into a cell selects it: keyboard focus is a press too.
      await cell("w1:p21").locator(".xterm").waitFor();
      assert.equal(await cell("w1:p21").getAttribute("role"), "group");
      await cell("w1:p20").locator(".pane-grid-expand").focus();
      await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p20"]').classList.contains("is-focused"));
      assert.equal(await cell("w1:p21").evaluate((node) => node.classList.contains("is-focused")), false);
      // Focus reaching a cell (what Tab does; its terminal keeps Tab for itself) selects it.
      await cell("w1:p21").focus();
      await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p21"]').classList.contains("is-focused"));
      assert.equal(await page.locator('.pane-button[data-pane-id="w1:p21"]').getAttribute("aria-pressed"), "true", "Tab into a cell selects its pane");
      await page.locator('.pane-button[data-pane-id="w1:p3"]').click();
      await grid.waitFor({ state: "hidden" });
      // A tab with one pane has no grid heading.
      assert.equal(await page.locator('.tab-grid-open[data-tab-id="w1:t2"]').count(), 0);
      // Nor has a connected PC's split tab: its panes open alone, no way to a grid.
      assert.equal(await page.locator('.tab-grid-open[data-tab-id="laptop!w1:t1"]').count(), 0);
      const readsBefore = layoutReads.length;
      await page.locator('.pane-button[data-pane-id="laptop!w1:p1"]').click();
      await page.locator("#pane-title").filter({ hasText: /one/u }).waitFor();
      await page.waitForTimeout(400);
      assert.equal(await grid.isVisible(), false);
      assert.equal(await page.locator("#grid-back").isVisible(), false, "no Back to grid for a connected PC's tab");
      assert.ok(layoutReads.slice(readsBefore).every((id) => !id.startsWith("laptop!")), "no layout is asked of a connected PC");
    } else {
      // A phone shows the pane alone with the map of its tab above it.
      const map = page.locator("#pane-map");
      await map.waitFor({ state: "visible" });
      assert.equal(await grid.isVisible(), false, "no grid on a phone");
      await page.waitForFunction(() => document.querySelectorAll(".pane-map-cell").length === 5);
      // p8 is not in Herdr's layout yet: it has a box beside the map and is counted.
      assert.equal(await page.locator('.pane-map-extra .pane-map-cell[data-pane-id="w1:p8"]').count(), 1);
      assert.equal(await page.locator('.pane-map-cell[data-pane-id="w1:p1"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('.pane-map-cell[data-pane-id="w1:p3"]').getAttribute("data-status"), "blocked");
      assert.match(await page.locator(".pane-map-count").textContent(), /^1 \/ 5$/u);
      const mapBox = await page.locator(".pane-map-board").boundingBox();
      const left = await page.locator('.pane-map-cell[data-pane-id="w1:p1"]').boundingBox();
      assert.ok(Math.abs(left.width - mapBox.width / 2) <= 2, "the map keeps Herdr's proportions");
      await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
      await shoot("map");
      // A tap on the box of the pane the layout lacks selects it.
      await page.locator('.pane-map-cell[data-pane-id="w1:p8"]').tap();
      await page.locator("#pane-title").filter({ hasText: /epsilon/u }).waitFor();
      await page.waitForFunction(() => document.querySelector(".pane-map-count")?.textContent === "5 / 5");
      // A tap on the map switches pane.
      await page.locator('.pane-map-cell[data-pane-id="w1:p3"]').tap();
      await page.locator("#pane-title").filter({ hasText: /gamma/u }).waitFor();
      await page.waitForFunction(() => document.querySelector('.pane-map-cell[data-pane-id="w1:p3"]')?.getAttribute("aria-pressed") === "true");
      assert.match(await page.locator(".pane-map-count").textContent(), /^3 \/ 5$/u);
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
      // Nor has a connected PC's split tab.
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(400);
      await page.locator('.pane-button[data-pane-id="laptop!w1:p2"]').click();
      await page.locator("#pane-title").filter({ hasText: /two/u }).waitFor();
      await page.waitForTimeout(400);
      assert.equal(await map.isVisible(), false, "no map for a connected PC's tab");
    }
    assert.deepEqual(errors, [], "no script errors");
    await context.close();
    console.log(`ok: ${mobile ? "phone" : "desktop"}`);
  }

  // A grid over its life on a desktop behind a password: it is redrawn only
  // when something it shows changed, it has no terminal find, a notification
  // for one of its panes is done once the grid shows that pane (not while
  // another pane's zoom hides it), a hidden page lets the cells' sockets go
  // and takes them up again, and so does a sign-out followed by a sign-in.
  {
    reset();
    ptys.length = 0;
    const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
    const { server: signedServer } = createHerdrHttpServer({ herdr, attachments, auth, logger: { info() {}, error() {} } });
    signedServer.listen(0, "127.0.0.1");
    await once(signedServer, "listening");
    const signedUrl = `http://127.0.0.1:${signedServer.address().port}`;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 } });
    const page = await context.newPage();
    // No offer to add a passkey after signing in.
    await page.addInitScript(() => Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true }));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sockets = [];
    page.on("websocket", (ws) => {
      const socket = { ws, frames: [], closed: false };
      ws.on("framesent", ({ payload }) => { try { socket.frames.push(JSON.parse(payload)); } catch {} });
      ws.on("close", () => { socket.closed = true; });
      sockets.push(socket);
    });
    const cell = (paneId) => page.locator(`.pane-grid-cell[data-pane-id="${paneId}"]`);
    const cellShows = (paneId, text) => page.waitForFunction(([id, wanted]) =>
      document.querySelector(`.pane-grid-cell[data-pane-id="${id}"] .xterm-rows`)?.textContent.replace(/ /gu, " ").includes(wanted), [paneId, text]);
    // The open sockets of grid cells, and the panes they attach.
    const cellSockets = (from = 0) => sockets.slice(from)
      .filter((socket) => !socket.closed && socket.frames.some((frame) => frame.type === "attach" && frame.keepSize === true));
    const attachedPanes = (from) => cellSockets(from).map((socket) => socket.frames.find((frame) => frame.type === "attach").paneId).sort();
    const signIn = async () => {
      await page.locator("#login-password").waitFor({ state: "visible" });
      await page.locator("#login-password").fill("secret");
      await page.locator("#login-password").press("Enter");
      await page.locator("#login-screen").waitFor({ state: "hidden" });
    };
    await page.goto(`${signedUrl}/?pane=${encodeURIComponent("w1:p1")}`);
    await signIn();
    await page.locator("#pane-title").filter({ hasText: /alpha/u }).waitFor();
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });

    // The find bar open over p1 alone closes as the grid opens.
    await page.locator("#terminal-xterm .xterm").click();
    await page.keyboard.press("Control+f");
    await page.locator("#terminal-find").waitFor({ state: "visible" });
    await page.locator('.tab-grid-open[data-tab-id="w1:t1"]').click();
    await page.locator(".pane-grid").waitFor({ state: "visible" });
    for (const paneId of ["w1:p1", "w1:p2", "w1:p3"]) await cellShows(paneId, `pane ${paneId}`);
    const findHidden = () => page.locator("#terminal-find").evaluate((node) => node.hidden);
    await page.waitForTimeout(300);
    assert.equal(await findHidden(), true, "the grid closes the terminal find");
    assert.equal(await page.locator("#terminal-find-open").evaluate((node) => node.hidden), true, "no find button over the grid");
    await page.locator("#pane-title").click();
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(200);
    assert.equal(await findHidden(), true, "Ctrl+F opens no terminal find over the grid");

    // Polls with nothing changed leave the cells as they are.
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      window.gridMutations = 0;
      const inTerminal = (node) => Boolean((node.nodeType === 1 ? node : node.parentElement)?.closest(".pane-grid-terminal"));
      new MutationObserver((records) => {
        window.gridMutations += records.filter((record) => !inTerminal(record.target)).length;
      }).observe(document.querySelector(".pane-grid"), { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => window.gridMutations), 0, "an unchanged grid is not redrawn");
    // A change is still drawn.
    panes.find((pane) => pane.pane_id === "w1:p2").agent_status = "blocked";
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p2"]').dataset.status === "blocked", null, { timeout: 5000 });

    // A notification for a pane of the grid is done once the grid shows it.
    await page.evaluate(() => {
      window.relay = new BroadcastChannel("herdr-notification-navigation");
      window.relay.onmessage = ({ data }) => { if (data.type === "notification-target-applied") window.relayApplied = data.id; };
      window.relay.postMessage({ type: "notification-target", id: "relay-grid", url: `${location.origin}/?pane=w1%3Ap2`, expiresAt: Date.now() + 60000 });
    });
    await page.waitForFunction(() => window.relayApplied === "relay-grid", null, { timeout: 5000 });
    assert.equal(await page.locator(".pane-grid").isVisible(), true, "the grid stays");
    assert.equal(await cell("w1:p2").evaluate((node) => node.classList.contains("is-focused")), true);
    // Another pane zoomed in Herdr hides p2's cell: a notification for p2 waits
    // until the zoom is undone and the cell is on screen again.
    zoomed = "w1:p1";
    await page.locator(".pane-grid-zoom").waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await cell("w1:p2").isVisible(), false);
    await page.evaluate(() => window.relay.postMessage({ type: "notification-target", id: "relay-hidden",
      url: `${location.origin}/?pane=w1%3Ap2`, expiresAt: Date.now() + 60000 }));
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => window.relayApplied), "relay-grid", "a notification for a zoomed-out pane is not done");
    await page.locator(".pane-grid-unzoom").click();
    await page.locator(".pane-grid-zoom").waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.relayApplied === "relay-hidden", null, { timeout: 5000 });
    assert.equal(await cell("w1:p2").isVisible(), true);
    await page.evaluate(() => window.relay.close());

    // Hidden, the page lets the cells' sockets go; shown again, they attach anew.
    const setHidden = (hidden) => page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
    // A cell the zoom let go attaches again a moment after the unzoom.
    const attachedBy = Date.now() + 5000;
    while (attachedPanes(0).filter((id, at, all) => all.indexOf(id) === at).length < 3 && Date.now() < attachedBy) await page.waitForTimeout(100);
    assert.deepEqual(attachedPanes(0).filter((id, at, all) => all.indexOf(id) === at), ["w1:p1", "w1:p2", "w1:p3"]);
    await setHidden(true);
    await page.waitForTimeout(500);
    assert.equal(cellSockets().length, 0, "a hidden page closes the cells' sockets");
    const beforeShown = sockets.length;
    await setHidden(false);
    await page.waitForTimeout(1000);
    assert.deepEqual(attachedPanes(beforeShown), ["w1:p1", "w1:p2", "w1:p3"], "the cells attach again once the page is shown");

    // Signed out from elsewhere: the login screen; signed in again, the cells are live.
    await auth.endAllSessions();
    await page.locator("#login-password").waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    assert.equal(cellSockets().length, 0, "signed out, no cell keeps a socket");
    const beforeSignIn = sockets.length;
    await signIn();
    await page.waitForTimeout(1000);
    assert.deepEqual(attachedPanes(beforeSignIn), ["w1:p1", "w1:p2", "w1:p3"], "signed in again, every cell attaches again");
    // Typing reaches the focused cell's pane again.
    await cell("w1:p1").locator(".xterm").click();
    await page.keyboard.type("back again");
    await page.waitForTimeout(300);
    assert.match(ptyOf("w1:p1")?.written ?? "", /back again/u);

    // Leaving the grid shows the pane alone with no stale find bar.
    await cell("w1:p1").locator(".pane-grid-expand").click();
    await page.locator(".pane-grid").waitFor({ state: "hidden" });
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    assert.equal(await findHidden(), true, "no find bar left over from before the grid");
    assert.deepEqual(errors, [], "no script errors");
    await context.close();
    signedServer.close();
    console.log("ok: desktop grid lifecycle");
  }
} finally {
  await browser.close();
  server.close();
}
