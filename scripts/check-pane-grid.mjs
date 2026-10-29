// Browser check of a split tab. On a wide screen the tab's one sidebar row
// opens the grid: every pane in a cell placed as Herdr lays it out, a cell too small to
// read shows its name only, a press focuses a cell and makes it the selected
// pane (typing in it reaches that pane alone, the composer follows), cells
// never resize a pane's pty, the ⋯ menu splits, zooms and closes, a refused
// split is said, and ⤢ opens the pane alone with Back to grid. A pane row in
// the row's dropdown opens its pane alone. Leaving the grid closes the cells'
// sockets. No cell attaches before Herdr's layout is read, a close always
// says the user meant it, and the cells follow the terminal font size. On a
// phone there is no grid: the selected pane shows with a map of the tab above
// it, a pane the layout does not have yet is still counted and tappable, and
// a tap on the map switches pane. A connected PC's split tab is one row too,
// but opens a pane alone: no grid, no map. Behind a password, a grid is not redrawn while
// nothing changed, has no terminal find, completes a notification for its
// pane once that pane's cell is on screen (not zoomed out), and its cells
// reconnect after a hidden page or a sign-out and sign-in. A split session's
// pane rows in the sidebar carry the cell's ⋯ (not a connected PC's), a pane
// moves out of its split into a session of its own from there or from a cell,
// and the split row's ⋯ separates all its panes.
// Runs on a desktop and a phone against an in-process fake herdr.
//
// PANE_GRID_SHOTS=<folder> keeps pictures of the grid, the zoomed grid and the
// phone's map in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { HerdrCommandError } from "../src/herdr-client.mjs";
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
// Sessions made by moving a pane out of a split, the panes moved out (in
// order), and the id Herdr gives the next pane moved out, should it rename it.
let movedTabs;
let movedOut;
let renameOnMove;
function reset() {
  movedTabs = [];
  movedOut = [];
  renameOnMove = null;
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
        ...movedTabs.map((tab_id) => ({ tab_id, workspace_id: "w1", label: "" })),
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
  // Herdr's `pane move --new-tab`: the pane leaves its tab for a new one.
  async movePaneOut(paneId) {
    const pane = panes.find((item) => item.pane_id === paneId);
    if (!pane) throw new HerdrCommandError("That pane is no longer open", { code: "pane_not_found" });
    if (panes.filter((item) => item.tab_id === pane.tab_id).length < 2) {
      throw new HerdrCommandError("That pane is already a session of its own.", { code: "split_session" });
    }
    movedOut.push(paneId);
    const tabId = `w1:t${40 + movedTabs.length}`;
    movedTabs.push(tabId);
    pane.tab_id = tabId;
    if (renameOnMove) {
      rects.delete(pane.pane_id);
      pane.pane_id = renameOnMove;
      renameOnMove = null;
    }
    rects.set(pane.pane_id, { x: 0, y: 0, width: 120, height: 40 });
    return { pane_id: pane.pane_id, tab_id: tabId };
  },
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
    // A split session's one row, and the arrow that shows its panes under it.
    const splitRow = (tabId) => page.locator(`.split-session-button[data-tab-id="${tabId}"]`);
    const showPanes = async (tabId) => {
      const arrow = page.locator(`.tab-group[data-tab-id="${tabId}"] .split-disclosure`);
      if (await arrow.getAttribute("aria-expanded") !== "true") await arrow.click();
      await page.locator(`.tab-group[data-tab-id="${tabId}"] .split-panes`).waitFor({ state: "visible" });
    };

    if (!mobile) {
      // A pane row opens its pane alone, with a way to the tab's grid.
      await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
      assert.equal(await grid.isVisible(), false, "a pane of a split tab opens alone");
      await page.locator("#grid-back").waitFor({ state: "visible" });
      assert.equal(await page.locator("#pane-map").isVisible(), false, "no map on a wide screen");

      // The tab's one row opens the grid, cells placed as Herdr has them.
      const heading = splitRow("w1:t1");
      assert.equal(await heading.locator(".pane-title").textContent(), "Split work");
      assert.equal(await heading.locator(".split-badge").textContent(), "4");
      assert.equal(await heading.locator(".pane-status").getAttribute("class"), "pane-status ui-status state-blocked", "the most urgent status of its panes");
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
      await showPanes("w1:t1");
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
      await splitRow("w1:t3").waitFor({ timeout: 8000 });
      // Past the layout's age, so opening tab A reads it again, and that read is held.
      await page.waitForTimeout(3300);
      const heldRead = page.waitForRequest((request) => decodeURIComponent(request.url()).includes("/w1:p1/layout"));
      await splitRow("w1:t1").click();
      await heldRead;
      await splitRow("w1:t3").click();
      await page.waitForFunction(() => document.querySelectorAll('.pane-grid-cell[data-pane-id^="w1:p2"]').length === 2);
      await cell("w1:p20").locator(".xterm").waitFor({ timeout: 4000 });
      // Back to tab A: a second read of it answers while the first is still
      // held, and the first, answering last, does not undo it.
      await splitRow("w1:t1").click();
      await cell("w1:p1").locator(".xterm").waitFor({ timeout: 4000 });
      assert.ok(readsOfA >= 2, "tab A is read again");
      releaseA();
      while (!staleAnswered) await page.waitForTimeout(20);
      await staleAnswered;
      await page.waitForTimeout(400);
      assert.equal(await page.locator(".pane-grid-zoom").isVisible(), false, "an older read of the tab answering late is dropped");
      assert.equal(await page.locator(".pane-grid-cell:not([hidden])").count(), 4);
      await page.unroute("**/api/panes/*/layout");
      await splitRow("w1:t3").click();
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
      // A tab with one pane is not a split row.
      assert.equal(await splitRow("w1:t2").count(), 0);
      // A connected PC's split tab is one row, but it opens its pane alone: no way to a grid.
      const readsBefore = layoutReads.length;
      await splitRow("laptop!w1:t1").click();
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
      // The tab's row in the sidebar keeps a phone on its pane and the map.
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(400);
      await splitRow("w1:t1").click();
      await page.waitForTimeout(400);
      assert.equal(await grid.isVisible(), false);
      assert.equal(await map.isVisible(), true);
      await page.locator("#pane-title").filter({ hasText: /gamma/u }).waitFor();
      // A one-pane tab has no map.
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(400);
      await page.locator('.pane-button[data-pane-id="w1:p9"]').click();
      await map.waitFor({ state: "hidden" });
      // Nor has a connected PC's split tab.
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(400);
      await showPanes("laptop!w1:t1");
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
    await page.locator('.split-session-button[data-tab-id="w1:t1"]').click();
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
  // Two split sessions' grids switched at once, many times, on a server whose
  // panes cannot attach (each cell falls back at once, as where node-pty is
  // missing). Each grid is let go as soon as its cells' terminals open, or a
  // task later once xterm cleared their screens and before it drew the next
  // frame: xterm still has work of its own queued for those terminals, and
  // none of it may fail once a terminal is gone.
  {
    reset();
    panes.push({ pane_id: "w1:p20", tab_id: "w1:t3", workspace_id: "w1", cwd: "/work/zeta", agent_status: "idle" },
      { pane_id: "w1:p21", tab_id: "w1:t3", workspace_id: "w1", cwd: "/work/eta", agent_status: "idle" });
    rects.set("w1:p20", { x: 0, y: 0, width: 60, height: 40 });
    rects.set("w1:p21", { x: 60, y: 0, width: 60, height: 40 });
    const { server: bareServer } = createHerdrHttpServer({ herdr, logger: { info() {}, error() {} } });
    bareServer.listen(0, "127.0.0.1");
    await once(bareServer, "listening");
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await page.goto(`http://127.0.0.1:${bareServer.address().port}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator('.split-session-button[data-tab-id="w1:t3"]').waitFor();
    const switches = await page.evaluate(async (rounds) => {
      const rowOf = (tabId) => document.querySelector(`.split-session-button[data-tab-id="${tabId}"]`);
      // Resolves once a cell of the grid has a terminal: at once, or a task later.
      const opened = (paneIds, later) => new Promise((resolve, reject) => {
        const has = () => paneIds.some((id) => document.querySelector(`.pane-grid-cell[data-pane-id="${id}"] .xterm`));
        const done = () => { observer.disconnect(); clearTimeout(limit); if (later) setTimeout(resolve, 0); else resolve(); };
        const observer = new MutationObserver(() => { if (has()) done(); });
        const limit = setTimeout(() => { observer.disconnect(); reject(new Error(`no terminal opened for ${paneIds}`)); }, 5000);
        observer.observe(document.body, { childList: true, subtree: true });
        if (has()) done();
      });
      const tabs = [["w1:t1", ["w1:p1", "w1:p2", "w1:p3"]], ["w1:t3", ["w1:p20", "w1:p21"]]];
      let count = 0;
      for (let round = 0; round < rounds; round += 1) {
        const [tabId, paneIds] = tabs[round % 2];
        const ready = opened(paneIds, round % 4 >= 2);
        rowOf(tabId).click();
        await ready;
        count += 1;
      }
      rowOf(tabs[rounds % 2][0]).click();
      return count;
    }, 12);
    assert.equal(switches, 12);
    await page.waitForTimeout(600);
    assert.deepEqual(errors, [], "switching grids at once throws and logs nothing");
    // The same terminals the grid's cells use, let go in the very task they
    // opened in: a cell (which keeps its pane's size) that was just told that
    // size, and a terminal that sizes its pane. xterm has measuring of its
    // own queued for each, and it may not fail on a terminal let go.
    await page.evaluate(async () => {
      const version = new URL(document.querySelector('script[type="module"][src*="app.js"]')?.src ?? location.href).search;
      const xterm = await import(`/vendor/xterm.mjs${version}`);
      const { createAttachedTerminal } = await import(`/xterm-terminal.js${version}`);
      for (let round = 0; round < 6; round += 1) {
        const listeners = [];
        const connection = { onAttach: (listener) => listeners.push(listener), onReconnect() {}, attach() {}, detach() {},
          resize() {}, resume() {}, pause() {}, ptyInput() { return true; }, acknowledge() {}, takeOver() {} };
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;left:0;top:0;width:480px;height:240px";
        document.body.append(host);
        const keepSize = round % 2 === 0;
        const terminal = createAttachedTerminal({ host, connection, xterm, fontSize: 13, keepSize, onFallback() {} });
        terminal.show(`w1:p${round}`);
        for (const listener of listeners) {
          listener({ type: "pane-geometry", pane_id: `w1:p${round}`, cols: 40, rows: 10, owner: false });
          listener({ type: "pty-data", pane_id: `w1:p${round}`, data: "hello\r\n" });
        }
        terminal.dispose();
        host.remove();
      }
    });
    await page.waitForTimeout(600);
    assert.deepEqual(errors, [], "a terminal let go as it opens throws nothing later");
    await context.close();
    bareServer.close();
    console.log("ok: grids switched at once");
  }
  // A split session's panes in the sidebar have the grid cell's ⋯ (this
  // machine's only: a connected PC's pane rows have none), closing with the
  // cell's confirmation rules. A pane moves out of its split from there or
  // from a cell's ⋯, and is followed should Herdr rename it; a refusal is
  // said. The split row's ⋯ separates every pane but the first, one after
  // another, once the user says so, and the grid gives way to one pane alone.
  for (const mobile of [false, true]) {
    reset();
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    page.on("request", (request) => {
      const match = decodeURIComponent(new URL(request.url()).pathname).match(/^\/api\/panes\/([^/]+)\/(split|zoom|close|move-out)$/u);
      if (match && request.method() === "POST") requests.push([match[2], match[1], request.postDataJSON()]);
    });
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p2")}`);
    await page.locator("#pane-title").filter({ hasText: /beta/u }).waitFor();
    const openSidebar = async () => {
      if (!mobile || !(await page.locator(".navigator").evaluate((node) => node.inert))) return;
      await page.locator("#mobile-sidebar-open").click();
      await page.waitForTimeout(500);
    };
    const showPanes = async (tabId) => {
      await openSidebar();
      const arrow = page.locator(`.tab-group[data-tab-id="${tabId}"] .split-disclosure`);
      if (await arrow.getAttribute("aria-expanded") !== "true") await arrow.click();
      await page.locator(`.tab-group[data-tab-id="${tabId}"] .split-panes`).waitFor({ state: "visible" });
    };
    const row = (paneId) => `.split-pane-row:has(> .pane-button[data-pane-id="${paneId}"])`;
    const paneMenu = async (paneId, action) => {
      await showPanes("w1:t1");
      await page.locator(`${row(paneId)} > .split-pane-menu > summary`).click();
      await page.locator(`${row(paneId)} [data-action="${action}"]`).click();
    };
    const rowMenu = async (tabId, action) => {
      await openSidebar();
      const menu = `.tab-group[data-tab-id="${tabId}"] .session-row > .session-action-menu`;
      await page.locator(`${menu} > summary`).click();
      await page.locator(`${menu} [data-action="${action}"]`).click();
    };
    const feedbackSays = (text) => page.waitForFunction((wanted) => document.querySelector("#action-feedback")?.textContent.includes(wanted), text);
    const isSplit = (tabId) => page.locator(`.tab-group[data-tab-id="${tabId}"][data-split="true"]`).count();

    await showPanes("w1:t1");
    await showPanes("laptop!w1:t1");
    const menus = await page.evaluate(() => {
      const actions = (root) => [...root.querySelectorAll(".sidebar-action-item")].map((item) => item.dataset.action ?? item.textContent);
      const group = (tabId) => document.querySelector(`.tab-group[data-tab-id="${tabId}"]`);
      return {
        local: [...group("w1:t1").querySelectorAll(".split-pane-menu")].map(actions),
        remote: group("laptop!w1:t1").querySelectorAll(".split-pane-menu").length,
        localRow: actions(group("w1:t1").querySelector(".session-row > .session-action-menu")),
        remoteRow: actions(group("laptop!w1:t1").querySelector(".session-row > .session-action-menu")),
      };
    });
    assert.equal(menus.local.length, 4, "each of this machine's pane rows has a ⋯");
    for (const items of menus.local) assert.deepEqual(items, ["split-right", "split-down", "zoom", "move-out", "close"]);
    assert.equal(menus.remote, 0, "a connected PC's pane rows have no ⋯");
    assert.deepEqual(menus.localRow, ["Rename", "separate-all", "Close session"]);
    assert.deepEqual(menus.remoteRow, ["Rename", "Close session"], "no Separate all for a connected PC");

    // Close from a pane row asks first when its agent is waiting for an
    // answer or working; a dismissed close asks the server nothing.
    for (const [paneId, reason] of [["w1:p3", /waiting for your answer/u], ["w1:p2", /still working/u]]) {
      let asked = null;
      page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.dismiss(); });
      await paneMenu(paneId, "close");
      await page.waitForTimeout(200);
      assert.match(asked ?? "", reason);
    }
    assert.deepEqual(requests, [], "a dismissed close asks nothing");

    // The selected pane moved out, renamed by Herdr: it stays selected under
    // its new id, a session of its own in the same project.
    renameOnMove = "w1:p60";
    await paneMenu("w1:p2", "move-out");
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p60"]')?.getAttribute("aria-pressed") === "true");
    assert.deepEqual(requests.at(-1), ["move-out", "w1:p2", {}]);
    assert.deepEqual(movedOut, ["w1:p2"]);
    assert.equal(await page.locator('.tab-group[data-tab-id="w1:t40"]:not([data-split]) .pane-button[data-pane-id="w1:p60"]').count(), 1, "its own session row");
    assert.equal(await page.locator('.workspace-group[data-workspace-id="w1"] .tab-group[data-tab-id="w1:t40"]').count(), 1, "in the same project");
    await page.locator("#pane-title").filter({ hasText: /beta/u }).waitFor();
    assert.equal(await isSplit("w1:t1"), 1, "three panes are still a split");

    // A done pane that is not the session's last closes at once, said meant.
    await paneMenu("w1:p4", "close");
    await page.locator(row("w1:p4")).waitFor({ state: "detached" });
    assert.deepEqual(requests.at(-1), ["close", "w1:p4", { confirmed: true }]);
    // Split and zoom ask what the grid's ⋯ asks.
    await paneMenu("w1:p1", "split-right");
    await page.locator(row("w1:p5")).waitFor();
    assert.deepEqual(requests.at(-1), ["split", "w1:p1", { direction: "right" }]);
    await paneMenu("w1:p1", "zoom");
    await page.waitForTimeout(300);
    assert.deepEqual(requests.at(-1), ["zoom", "w1:p1", { mode: "toggle" }]);
    zoomed = null;

    // A move-out Herdr refuses is said, and nothing moves.
    await page.route("**/api/panes/*/move-out", (route) => route.fulfill({ status: 409,
      json: { error: { code: "split_session", message: "That pane is already a session of its own." } } }));
    await paneMenu("w1:p5", "move-out");
    await feedbackSays("That pane is already a session of its own.");
    await page.unroute("**/api/panes/*/move-out");
    assert.deepEqual(movedOut, ["w1:p2"]);

    if (!mobile) {
      // The grid cell's ⋯ moves a pane out too. Opening a cell's ⋯ selects
      // its pane, so the pane moved out stays selected, alone in its session.
      await page.locator('.split-session-button[data-tab-id="w1:t1"]').click();
      await page.locator('.pane-grid-cell[data-pane-id="w1:p5"]').waitFor();
      await page.locator('.pane-grid-cell[data-pane-id="w1:p5"] .pane-grid-menu > summary').click();
      await page.locator('.pane-grid-cell[data-pane-id="w1:p5"] [data-action="move-out"]').click();
      await page.locator('.pane-grid-cell[data-pane-id="w1:p5"]').waitFor({ state: "detached" });
      assert.deepEqual(movedOut, ["w1:p2", "w1:p5"]);
      await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p5"]')?.getAttribute("aria-pressed") === "true");
      assert.equal(await page.locator('.tab-group[data-tab-id="w1:t41"] .pane-button[data-pane-id="w1:p5"]').count(), 1);
      assert.equal(await page.locator(".terminal-panel.is-grid").count(), 0, "the moved pane shows alone");
      // The two left are still a split, and its grid opens for Separate all.
      await page.locator('.split-session-button[data-tab-id="w1:t1"]').click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-grid:not([hidden]) .pane-grid-cell").length === 2);
    }

    // Separate all: nothing without the user's say-so...
    const before = requests.length;
    let asked = null;
    page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.dismiss(); });
    await rowMenu("w1:t1", "separate-all");
    await page.waitForTimeout(200);
    const count = mobile ? 3 : 2;
    assert.match(asked ?? "", new RegExp(`Separate the ${count} panes of “Split work” into ${count} sessions`, "u"));
    assert.equal(requests.length, before, "a dismissed separate asks nothing");
    // ...then every pane but the first, one after another.
    page.once("dialog", (dialog) => void dialog.accept());
    await rowMenu("w1:t1", "separate-all");
    await page.waitForFunction(() => !document.querySelector('.tab-group[data-tab-id="w1:t1"][data-split="true"]'));
    const separated = mobile ? ["w1:p5", "w1:p3"] : ["w1:p3"];
    assert.deepEqual(movedOut.slice(-separated.length), separated);
    assert.deepEqual(requests.slice(before).map(([action, paneId]) => [action, paneId]), separated.map((id) => ["move-out", id]));
    assert.equal(await page.locator('.tab-group[data-tab-id="w1:t1"] .pane-button[data-pane-id="w1:p1"]').count(), 1, "the first pane stays in the session");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".terminal-panel.is-grid").count(), 0, "a session of one pane shows it alone");
    assert.deepEqual(errors, [], "no script errors");
    await context.close();
    console.log(`ok: ${mobile ? "phone" : "desktop"} pane actions in the sidebar and moving out`);
  }
} finally {
  await browser.close();
  server.close();
}
