// Browser check of a split tab. On a wide screen the tab's one sidebar row
// opens the grid: every pane in a cell placed as Herdr lays it out, a cell too small to
// read shows its name only, a press focuses a cell and makes it the selected
// pane (typing in it reaches that pane alone, the composer follows), cells
// that keep their panes' sizes never resize a pane's pty, the ⋯ menu splits, zooms and closes, a refused
// split is said, and ⤢ opens the pane alone with Back to grid. A pane row in
// the row's dropdown opens its pane alone. Leaving the grid closes the cells'
// sockets. No cell attaches before Herdr's layout is read, a close always
// says the user meant it, and the cells take the font their board fits, not
// the terminal font size chosen for one pane (the user adjusts the grid's own
// text size with Ctrl+wheel, and Ctrl+0 resets it). On a
// phone there is no grid: the selected pane shows with a map of the tab above
// it, a pane the layout does not have yet is still counted and tappable, and
// a tap on the map switches pane. A connected PC's split tab is one row too,
// but opens a pane alone: no grid, no map. Behind a password, a grid is not redrawn while
// nothing changed, has no terminal find, completes a notification for its
// pane once that pane's cell is on screen (not zoomed out), and its cells
// reconnect after a hidden page or a sign-out and sign-in. A cell carried by
// its header onto another's middle swaps the two, onto an edge goes beside it
// (same cells and terminals, the carried pane still selected); its own cell,
// Escape and a zoomed tab do nothing, refusals are said, and the header's
// buttons and the terminal's selection and typing are as before. A split
// session's pane rows in the sidebar carry the cell's ⋯ (not a connected PC's), a pane
// moves out of its split into a session of its own from there or from a cell,
// and the split row's ⋯ separates all its panes. Even out layout, from the
// split row's ⋯ or a cell's, gives the panes equal shares and the cells slide
// there; a layout that cannot be evened out is said. By default (Settings >
// Fit panes to this window) a grid's cells fill the stage and size their
// panes to themselves at the terminal font, one resize per changed cell; with
// the setting off (the sections above that say so) they keep their panes'
// sizes on a letterboxed board, as described above.
// Runs on a desktop and a phone against an in-process fake herdr.
//
// PANE_GRID_SHOTS=<folder> keeps pictures of the grid, the zoomed grid, the
// phone's map and a cell carried over a swap and over an edge, in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { evenLayoutStep } from "../src/even-layout.mjs";
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
// What the grid asked Herdr to rearrange.
const rearranged = [];
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
  // Two panes trade places: their rects, and their order in the snapshot.
  async swapPanes(paneId, targetPaneId) {
    rearranged.push(["swap", paneId, targetPaneId]);
    const [a, b] = [rects.get(paneId), rects.get(targetPaneId)];
    rects.set(paneId, b);
    rects.set(targetPaneId, a);
    const [i, j] = [panes.findIndex((pane) => pane.pane_id === paneId), panes.findIndex((pane) => pane.pane_id === targetPaneId)];
    [panes[i], panes[j]] = [panes[j], panes[i]];
    return { pane_id: paneId };
  },
  // A pane leaves its place (the pane sharing that whole edge takes it) and
  // takes the half of the target on `side`, keeping its id.
  async relocatePane(paneId, targetPaneId, side) {
    rearranged.push(["relocate", paneId, targetPaneId, side]);
    const old = rects.get(paneId);
    const heir = [...rects.entries()].find(([id, rect]) => id !== paneId && panes.some((pane) => pane.pane_id === id && pane.tab_id === "w1:t1") && (
      (rect.x === old.x && rect.width === old.width && (rect.y + rect.height === old.y || old.y + old.height === rect.y)) ||
      (rect.y === old.y && rect.height === old.height && (rect.x + rect.width === old.x || old.x + old.width === rect.x))));
    if (!heir) throw new Error(`no pane takes ${paneId}'s place`);
    const [heirId, rect] = heir;
    rects.set(heirId, { x: Math.min(rect.x, old.x), y: Math.min(rect.y, old.y),
      width: rect.x === old.x ? rect.width : rect.width + old.width, height: rect.y === old.y ? rect.height : rect.height + old.height });
    const target = rects.get(targetPaneId);
    const across = side === "left" || side === "right";
    const cut = across ? Math.floor(target.width / 2) : Math.floor(target.height / 2);
    const first = across ? { ...target, width: cut } : { ...target, height: cut };
    const second = across ? { ...target, x: target.x + cut, width: target.width - cut } : { ...target, y: target.y + cut, height: target.height - cut };
    const before = side === "left" || side === "up";
    rects.set(targetPaneId, before ? second : first);
    rects.set(paneId, before ? first : second);
    return { pane_id: paneId };
  },
  // Herdr's `pane resize`, simply: the pane's border on that side moves, and
  // every pane of the tab on that line with it. Planned as the real client does.
  async evenLayout(paneId) {
    rearranged.push(["even-layout", paneId]);
    let steps = 0;
    for (let step = evenLayoutStep((await this.paneLayout(paneId)).layout); step && steps < 60;
      step = evenLayoutStep((await this.paneLayout(paneId)).layout)) {
      const across = step.direction === "left" || step.direction === "right";
      const [pos, size] = across ? ["x", "width"] : ["y", "height"];
      const moved = rects.get(step.paneId);
      const line = step.direction === "right" || step.direction === "down" ? moved[pos] + moved[size] : moved[pos];
      const by = Math.round(step.amount * (across ? 120 : 40)) * (step.direction === "right" || step.direction === "down" ? 1 : -1);
      const tabId = panes.find((pane) => pane.pane_id === paneId)?.tab_id;
      for (const pane of panes.filter((item) => item.tab_id === tabId)) {
        const rect = rects.get(pane.pane_id);
        if (rect[pos] + rect[size] === line) rect[size] += by;
        else if (rect[pos] === line) { rect[pos] += by; rect[size] -= by; }
      }
      steps += 1;
    }
    return { pane_id: paneId, changed: steps > 0, steps, even: true };
  },
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
// A context whose Herdr grids keep their panes' sizes and scale their text
// (Settings > Fit panes to this window, off); the grid fits its panes to the
// window by default.
const keepingSizes = async (options) => {
  const context = await browser.newContext(options);
  await context.addInitScript(() => { try { localStorage.setItem("herdrbridge-grid-fit", "off"); } catch {} });
  return context;
};

// The grid has taken its shape: its board fitted to the cells' font, nothing
// sliding, and every cell where it was for a few frames running.
const gridSettled = (page) => page.waitForFunction(() => {
  const nodes = [...document.querySelectorAll(".pane-grid:not([hidden]) :is(.pane-grid-board, .pane-grid-cell:not([hidden]))")];
  if (nodes.some((node) => node.getAnimations().length > 0)) return false;
  const shape = JSON.stringify(nodes.map((node) => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  const last = window.__gridShape;
  window.__gridShape = shape;
  window.__gridStill = shape === last ? (window.__gridStill ?? 0) + 1 : 0;
  return window.__gridStill >= 6;
}, null, { polling: "raf" });

const ptyOf = (paneId) => ptys.filter((pty) => pty.paneId === paneId && !pty.killed).at(-1);

try {
  for (const mobile of [false, true]) {
    reset();
    // On a phone, p8 has just been split off: Herdr's layout does not have it yet.
    if (mobile) panes.splice(4, 0, { pane_id: "w1:p8", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/epsilon", agent_status: "idle" });
    ptys.length = 0;
    sent.length = 0;
    const context = await keepingSizes({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
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
      await gridSettled(page);
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
      await gridSettled(page);
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
      // Ctrl+wheel on the grid sizes the grid's text, not the terminal font
      // size chosen for a pane shown alone: that setting stays as it is.
      const screenWidth = (paneId) => cell(paneId).locator(".xterm-screen").evaluate((node) => node.offsetWidth);
      const setting = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size")));
      await gridSettled(page);
      const [widthBefore, sizeBefore] = [await screenWidth("w1:p1"), await setting()];
      const p1Box = await cell("w1:p1").boundingBox();
      await page.mouse.move(p1Box.x + p1Box.width / 2, p1Box.y + p1Box.height / 2);
      await page.keyboard.down("Control");
      for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 120);
      await page.keyboard.up("Control");
      assert.equal(await setting(), sizeBefore, "the global setting does not follow a grid adjustment");
      await page.waitForTimeout(300);
      await gridSettled(page);
      assert.ok(await screenWidth("w1:p1") < widthBefore, "the grid's own adjustment resizes the cells");
      await page.keyboard.press("Control+0");
      await page.waitForTimeout(300);
      await gridSettled(page);
      assert.equal(await screenWidth("w1:p1"), widthBefore, "Ctrl+0 puts the cells back to the font their board fits");

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
    const context = await keepingSizes({ serviceWorkers: "block", viewport: { width: 1280, height: 844 } });
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

  // Rearranging a grid on a desktop: a cell carried by its header onto
  // another's middle swaps the two; onto its edge it goes beside it on that
  // side. The carried pane stays selected and its cell (and terminal) is the
  // same one. Its own cell, Escape, a zoomed tab and a refusal ask nothing or
  // say why; the header's buttons and the terminal work as before.
  {
    reset();
    ptys.length = 0;
    rearranged.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    page.on("request", (request) => {
      const path = decodeURIComponent(new URL(request.url()).pathname);
      const match = path.match(/^\/api\/panes\/([^/]+)\/(swap|relocate)$/u);
      if (match) requests.push([match[2], match[1], request.postDataJSON()]);
    });
    const cell = (paneId) => page.locator(`.pane-grid-cell[data-pane-id="${paneId}"]`);
    // Where a cell is once the cells have slid into place.
    const boxOf = async (paneId) => { await gridSettled(page); return cell(paneId).boundingBox(); };
    // A cell's place as shares of the board: the board takes the tab's shape
    // in its cells' font, so a layout whose panes changed size may resize it.
    const shareOf = async (paneId) => {
      const [box, board] = [await boxOf(paneId), await page.locator(".pane-grid-board").boundingBox()];
      return { x: (box.x - board.x) / board.width, y: (box.y - board.y) / board.height, width: box.width / board.width, height: box.height / board.height };
    };
    const nearShare = (actual, expected, what) => {
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(actual[key] - expected[key]) <= 0.01, `${what} ${key}: ${actual[key]} vs ${expected[key]}`);
    };
    const headerPoint = async (paneId) => {
      const box = await cell(paneId).locator(".pane-grid-cell-header").boundingBox();
      return { x: box.x + Math.min(40, box.width / 2), y: box.y + Math.min(12, box.height / 2) };
    };
    const at = (box, fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
    const shots = process.env.PANE_GRID_SHOTS;
    // Carries `paneId`'s cell from its header to `to`; `during` runs mid-drag.
    const carry = async (paneId, to, { during, release = true } = {}) => {
      const from = await headerPoint(paneId);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let step = 1; step <= 12; step += 1) {
        await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
      }
      await page.waitForTimeout(60);
      // The dashed preview eases to where it points now.
      await page.waitForFunction(() => (document.querySelector(".pane-grid-drop-preview")?.getAnimations().length ?? 0) === 0);
      const seen = await page.evaluate(() => {
        const mark = document.querySelector(".pane-grid-drop-preview");
        const rect = mark && !mark.hidden ? mark.getBoundingClientRect() : null;
        return {
          ghost: document.querySelector(".pane-grid-drag-ghost")?.textContent ?? null,
          kind: rect ? mark.dataset.kind : null,
          side: rect ? mark.dataset.side ?? null : null,
          preview: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          swapTarget: document.querySelector(".pane-grid-cell.is-swap-target")?.dataset.paneId ?? null,
          source: document.querySelector(".pane-grid-cell.is-drag-source")?.dataset.paneId ?? null,
        };
      });
      if (during) await during();
      if (release) await page.mouse.up();
      return seen;
    };
    const shootDrag = async (name) => {
      if (!shots) return;
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => window.herdrTheme.set(value), theme);
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(shots, `${name}-desktop-${theme}.png`) });
      }
      await page.evaluate(() => window.herdrTheme.set("dark"));
    };
    const near = (actual, expected, what) => {
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(actual[key] - expected[key]) <= 3, `${what} ${key}: ${actual[key]} vs ${expected[key]}`);
    };
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.evaluate(() => window.herdrTheme.set("dark"));
    await page.locator('.split-session-button[data-tab-id="w1:t1"]').click();
    for (const paneId of ["w1:p1", "w1:p2", "w1:p3"]) await cell(paneId).locator(".xterm").waitFor();
    assert.equal(await page.locator(".pane-grid.can-rearrange").count(), 1, "the headers can be picked up");

    // The cells as drawn now: a swap or a move must keep them, terminals and all.
    await page.evaluate(() => {
      window.cellNodes = new Map([...document.querySelectorAll(".pane-grid-cell")].map((node) => [node.dataset.paneId, node]));
      window.cellTerminals = new Map([...document.querySelectorAll(".pane-grid-cell")].map((node) => [node.dataset.paneId, node.querySelector(".xterm")]));
    });
    const ptyCount = (paneId) => ptys.filter((pty) => pty.paneId === paneId).length;
    const p1Ptys = ptyCount("w1:p1");

    // 1. Dropped on its own cell, nothing happens.
    let seen = await carry("w1:p1", at(await boxOf("w1:p1"), 0.5, 0.5));
    assert.match(seen.ghost ?? "", /alpha/u, "the cell's name follows the pointer");
    assert.equal(seen.source, "w1:p1");
    assert.equal(seen.preview, null, "its own cell is no drop");
    await page.waitForTimeout(250);
    assert.deepEqual(requests, []);
    assert.equal(await page.locator(".pane-grid-drag-ghost").count(), 0, "the label leaves with the drag");

    // 2. Escape puts it back mid-drag, and reaches no terminal.
    const typedBefore = ["w1:p1", "w1:p2", "w1:p3"].map((id) => ptyOf(id).written).join("|");
    seen = await carry("w1:p1", at(await boxOf("w1:p3"), 0.5, 0.5), { release: false });
    assert.equal(seen.kind, "swap");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".pane-grid-drag-ghost").count(), 0, "Escape ends the drag");
    assert.equal(await page.locator(".pane-grid-drop-preview").count(), 0);
    await page.mouse.up();
    await page.waitForTimeout(250);
    assert.deepEqual(requests, [], "Escape cancels the drop");
    assert.equal(["w1:p1", "w1:p2", "w1:p3"].map((id) => ptyOf(id).written).join("|"), typedBefore, "the Escape reached no pane");

    // 3. The middle of another cell swaps the two: the whole cell lights up.
    const p1Before = await boxOf("w1:p1");
    const p3Before = await boxOf("w1:p3");
    const [p1Share, p3Share] = [await shareOf("w1:p1"), await shareOf("w1:p3")];
    seen = await carry("w1:p1", at(p3Before, 0.5, 0.5), { during: () => shootDrag("rearrange-swap") });
    assert.equal(seen.kind, "swap");
    assert.equal(seen.swapTarget, "w1:p3");
    near(seen.preview, p3Before, "the swap lights the whole cell");
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"]').style.top === "50%");
    assert.deepEqual(requests.at(-1), ["swap", "w1:p1", { targetPaneId: "w1:p3" }]);
    assert.deepEqual(rearranged.at(-1), ["swap", "w1:p1", "w1:p3"]);
    nearShare(await shareOf("w1:p1"), p3Share, "p1 sits where p3 was");
    nearShare(await shareOf("w1:p3"), p1Share, "p3 sits where p1 was");
    // The carried pane stays selected, in the same cell with the same terminal.
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"]').classList.contains("is-focused"));
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p1"]').getAttribute("aria-pressed"), "true");
    assert.deepEqual(await page.evaluate(() => ["w1:p1", "w1:p3"].map((id) => {
      const node = document.querySelector(`.pane-grid-cell[data-pane-id="${id}"]`);
      return window.cellNodes.get(id) === node && window.cellTerminals.get(id) === node.querySelector(".xterm");
    })), [true, true], "the cells and their terminals are kept");
    assert.equal(ptyCount("w1:p1"), p1Ptys, "p1 did not attach again");
    // Typing still reaches the carried pane.
    await page.keyboard.type("after swap");
    await page.waitForTimeout(300);
    assert.match(ptyOf("w1:p1").written, /after swap/u, "the carried pane keeps the typing");

    // 4. An edge moves it beside that cell: the dashed half shows where.
    // p2 sits over p1 now; dropped on p1's bottom edge it goes under p1.
    const p1Now = await boxOf("w1:p1");
    seen = await carry("w1:p2", at(p1Now, 0.5, 0.92), { during: () => shootDrag("rearrange-edge") });
    assert.equal(seen.kind, "side");
    assert.equal(seen.side, "down");
    assert.equal(seen.swapTarget, null);
    near(seen.preview, { x: p1Now.x, y: p1Now.y + p1Now.height / 2, width: p1Now.width, height: p1Now.height / 2 }, "the half it would take");
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p2"]').style.top === "50%");
    assert.deepEqual(requests.at(-1), ["relocate", "w1:p2", { targetPaneId: "w1:p1", side: "down" }]);
    const p2After = await boxOf("w1:p2");
    const p1After = await boxOf("w1:p1");
    assert.ok(p2After.y > p1After.y && Math.abs(p2After.x - p1After.x) <= 1, "p2 sits under p1");
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p2"]').classList.contains("is-focused"));
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p2"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => window.cellNodes.get("w1:p2") === document.querySelector('.pane-grid-cell[data-pane-id="w1:p2"]')), true);

    // 5. A cell too small to read is carried by its header (all it shows): onto p3's middle.
    assert.equal(await cell("w1:p4").evaluate((node) => node.classList.contains("is-tiny")), true);
    seen = await carry("w1:p4", at(await boxOf("w1:p3"), 0.5, 0.5));
    assert.equal(seen.kind, "swap");
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p4"]').style.left === "0%");
    assert.deepEqual(rearranged.at(-1), ["swap", "w1:p4", "w1:p3"]);
    await cell("w1:p4").locator(".xterm").waitFor();

    // 6. A move that could not finish is said, and the pane is followed.
    await page.route("**/api/panes/*/relocate", (route) => route.fulfill({ json: {
      pane_id: "w1:p1", placed: false, restored: true, message: "There is no room to split this pane. The pane was put back in its session." } }));
    const before = rearranged.length;
    seen = await carry("w1:p1", at(await boxOf("w1:p4"), 0.08, 0.5));
    assert.equal(seen.side, "left");
    await page.locator("#action-feedback").filter({ hasText: "The pane was put back in its session." }).waitFor();
    assert.equal(rearranged.length, before);
    await page.unroute("**/api/panes/*/relocate");
    // A refusal is said too.
    await page.route("**/api/panes/*/swap", (route) => route.fulfill({ status: 400,
      json: { error: { code: "invalid_input", message: "Those panes are not in the same session" } } }));
    await carry("w1:p1", at(await boxOf("w1:p4"), 0.5, 0.5));
    await page.locator("#action-feedback").filter({ hasText: "Those panes are not in the same session" }).waitFor();
    await page.unroute("**/api/panes/*/swap");

    // 7. The header's buttons still work: ⋯ opens its menu, ⤢ opens the pane alone.
    const asked = requests.length;
    // (A press that selects another pane clears the feedback line, which moves the grid: select first.)
    await cell("w1:p2").locator(".xterm").click();
    await page.waitForFunction(() => !document.querySelector("#action-feedback")?.textContent);
    await cell("w1:p2").locator(".pane-grid-menu > summary").click();
    await page.locator('.pane-grid-cell[data-pane-id="w1:p2"] [data-action="split-right"]').waitFor({ state: "visible" });
    await cell("w1:p2").locator(".pane-grid-menu > summary").click();
    await page.locator('.pane-grid-cell[data-pane-id="w1:p2"] [data-action="split-right"]').waitFor({ state: "hidden" });
    // The terminal keeps its selection and typing: a drag inside it selects text, carries nothing.
    const term = await cell("w1:p1").locator(".xterm-screen").boundingBox();
    await page.mouse.move(term.x + 6, term.y + 8);
    await page.mouse.down();
    await page.mouse.move(term.x + 120, term.y + 30, { steps: 8 });
    assert.equal(await page.locator(".pane-grid-drag-ghost").count(), 0, "a drag in the terminal carries no cell");
    await page.mouse.up();
    assert.ok(await page.locator(".pane-grid-cell[data-pane-id='w1:p1'] .xterm-selection div").count() > 0, "the terminal selected text");
    await page.keyboard.type("still typing");
    await page.waitForTimeout(300);
    assert.match(ptyOf("w1:p1").written, /still typing/u);
    assert.equal(requests.length, asked, "neither asked to move anything");
    await cell("w1:p2").locator(".pane-grid-expand").click();
    await page.locator(".pane-grid").waitFor({ state: "hidden" });
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p2"]').getAttribute("aria-pressed"), "true");
    await page.locator("#grid-back").click();
    await page.locator(".pane-grid").waitFor({ state: "visible" });
    await cell("w1:p2").locator(".xterm").waitFor();

    // 8. A zoomed tab is not rearranged: its header carries nothing.
    zoomed = "w1:p2";
    await page.locator(".pane-grid-zoom").waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await page.locator(".pane-grid.can-rearrange").count(), 0);
    const zoomedBox = await boxOf("w1:p2");
    seen = await carry("w1:p2", at(zoomedBox, 0.9, 0.9));
    assert.equal(seen.ghost, null, "no drag while zoomed");
    await page.waitForTimeout(250);
    assert.equal(requests.length, asked);
    zoomed = null;
    await page.locator(".pane-grid-zoom").waitFor({ state: "hidden", timeout: 8000 });

    // 9. A connected PC's split tab has no grid, so nothing to carry.
    await page.locator('.split-session-button[data-tab-id="laptop!w1:t1"]').click();
    await page.locator("#pane-title").filter({ hasText: /one/u }).waitFor();
    assert.equal(await page.locator(".pane-grid:not([hidden]) .pane-grid-cell").count(), 0);
    assert.deepEqual(errors, [], "no script errors");
    await context.close();
    console.log("ok: desktop grid rearranged");
  }
  // A Herdr grid's board takes the tab's shape in the cells' shared font, so
  // every cell's terminal fills its cell: on two, three and four cells, and
  // again once the stage is resized or the sidebar folded. A layout change
  // slides the cells into place (a closed pane's cell fades); with reduced
  // motion they move at once.
  {
    const layouts = {
      2: { "w1:p1": [0, 0, 60, 40], "w1:p2": [60, 0, 60, 40] },
      3: { "w1:p1": [0, 0, 60, 40], "w1:p2": [60, 0, 60, 20], "w1:p3": [60, 20, 60, 20] },
      4: { "w1:p1": [0, 0, 60, 20], "w1:p2": [60, 0, 60, 20], "w1:p3": [0, 20, 60, 20], "w1:p4": [60, 20, 60, 20] },
    };
    const lay = (count, shape = layouts[count]) => {
      reset();
      panes = panes.filter((pane) => pane.tab_id !== "w1:t1" || pane.pane_id in shape);
      for (const [id, [x, y, width, height]] of Object.entries(shape)) rects.set(id, { x, y, width, height });
    };
    // What each cell's terminal leaves unfilled (px past its padding), the
    // fonts, and where the board sits in the stage.
    const fill = (page) => page.evaluate(() => {
      const board = document.querySelector(".pane-grid-board").getBoundingClientRect();
      const stage = document.querySelector(".pane-grid").getBoundingClientRect();
      const cells = [...document.querySelectorAll(".pane-grid-cell:not([hidden])")].map((node) => {
        const body = node.querySelector(".pane-grid-terminal");
        const screen = node.querySelector(".xterm-screen").getBoundingClientRect();
        const pad = getComputedStyle(node.querySelector(".xterm"));
        return {
          pane: node.dataset.paneId,
          font: getComputedStyle(node.querySelector(".xterm-rows")).fontSize,
          header: node.querySelector(".pane-grid-cell-header").getBoundingClientRect().height,
          slackX: body.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) - screen.width,
          slackY: body.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom) - screen.height,
        };
      });
      // How much of the room inside the stage the board takes, the way it is most filled.
      const boardNode = document.querySelector(".pane-grid-board");
      const borderX = boardNode.offsetWidth - boardNode.clientWidth;
      const borderY = boardNode.offsetHeight - boardNode.clientHeight;
      const room = Math.max(boardNode.clientWidth / (stage.width - borderX), boardNode.clientHeight / (stage.height - borderY));
      return { cells, gapLeft: board.left - stage.left, gapRight: stage.right - board.right, boardTop: board.top - stage.top,
        aspect: board.width / board.height, stageAspect: stage.width / stage.height, room,
        board: [Math.round(board.width), Math.round(board.height)], stage: [Math.round(stage.width), Math.round(stage.height)] };
    });
    // The board the grid needs at `font`, computed as pane-grid.js's letterbox
    // computes it (a W's width, the font's ascent and descent) from the cells'
    // real chrome (frame minus the terminal's box, in fractional px), the room
    // it has, and the board the app set.
    const boardAtFont = (page, font) => page.evaluate((font) => {
      const root = document.querySelector(".pane-grid:not([hidden])");
      const boardNode = root.querySelector(".pane-grid-board");
      const style = getComputedStyle(boardNode);
      const borderX = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const zoom = root.querySelector(".pane-grid-zoom");
      const above = !zoom || zoom.hidden ? 0 : zoom.offsetHeight + (parseFloat(getComputedStyle(root).rowGap) || 0);
      const family = style.getPropertyValue("--mono").trim() || "monospace";
      const context = document.createElement("canvas").getContext("2d");
      const measure = (size) => {
        context.font = `${size}px ${family}`;
        const text = context.measureText("W");
        return { charWidth: text.width, charHeight: text.fontBoundingBoxAscent + text.fontBoundingBoxDescent };
      };
      const dpr = window.devicePixelRatio || 1;
      const now = measure(parseFloat(getComputedStyle(root.querySelector(".pane-grid-cell:not([hidden]) .xterm-rows")).fontSize));
      const next = measure(font);
      let width = 0;
      let height = 0;
      for (const node of root.querySelectorAll(".pane-grid-cell:not([hidden])")) {
        const body = node.querySelector(".pane-grid-terminal");
        const screen = node.querySelector(".xterm-screen");
        const pad = getComputedStyle(node.querySelector(".xterm"));
        const frame = node.getBoundingClientRect();
        const rows = node.querySelector(".xterm-rows").childElementCount;
        const cols = Math.round(screen.offsetWidth / now.charWidth);
        const inner = body.getBoundingClientRect();
        const extraX = frame.width - (inner.width - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight));
        const extraY = frame.height - (inner.height - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom));
        const screenWidth = Math.round((next.charWidth * dpr * cols) / dpr);
        const screenHeight = Math.round((Math.ceil(next.charHeight * dpr) * rows) / dpr);
        width = Math.max(width, (screenWidth + extraX) / (parseFloat(node.style.width) / 100));
        height = Math.max(height, (screenHeight + extraY) / (parseFloat(node.style.height) / 100));
      }
      return {
        board: [Math.ceil(width) + 1, Math.ceil(height) + 1],
        room: [root.clientWidth - borderX, root.clientHeight - above - borderY],
        set: [parseFloat(boardNode.style.width), parseFloat(boardNode.style.height)],
      };
    }, font);
    const filled = async (page, what) => {
      await gridSettled(page);
      const seen = await fill(page);
      assert.equal(new Set(seen.cells.map((cell) => cell.font)).size, 1, `${what}: the cells share one font: ${seen.cells.map((cell) => cell.font)}`);
      // The board grows until one way runs out of room: some cell is filled
      // to the pixel that way.
      assert.ok(seen.cells.some((cell) => cell.slackY <= 3) || seen.cells.every((cell) => cell.slackX <= 3),
        `${what}: the cells are filled to the pixel one way at least: ${JSON.stringify(seen.cells)}`);
      for (const cell of seen.cells) {
        assert.ok(cell.slackX >= -0.5 && cell.slackX <= 3, `${what}: ${cell.pane} fills its width (${cell.slackX}px spare)`);
        // A cell as tall as the two stacked beside it has a header fewer than
        // they have: it may keep up to that spare, the rest fill to the pixel.
        assert.ok(cell.slackY >= -0.5 && cell.slackY <= Math.max(3, cell.header), `${what}: ${cell.pane} fills its height (${cell.slackY}px spare)`);
      }
      // The board is the tab's shape, not the stage's: centred across it, at its top.
      assert.ok(Math.abs(seen.gapLeft - seen.gapRight) <= 1, `${what}: the board is centred (${seen.gapLeft} / ${seen.gapRight})`);
      assert.ok(Math.abs(seen.boardTop) <= 1, `${what}: the board starts at the stage's top`);
      // As large as the stage allows: the next font step up would not fit
      // (or the font is at the grid's cap), whatever the font chosen for one pane.
      const font = parseFloat(seen.cells[0].font);
      assert.ok(seen.room <= 1.001, `${what}: the board fits the stage (${seen.board} in ${seen.stage})`);
      // The board is the one its cells need at this font, to the pixel: the app
      // read each cell's chrome right. A chrome off by a fraction of a pixel
      // (as when it mixed fractional and whole px) shows here whatever the font,
      // and made the fit flip between two fonts where it crossed a pixel.
      const now = await boardAtFont(page, font);
      assert.deepEqual(now.set, now.board, `${what}: the board is what its cells need at ${font}px`);
      // As large as a step allows: the next step up would not fit. Asked always,
      // not by the board's share of the stage: the chrome does not grow with the
      // font, and a line height that rounds (11px at 10px, 12px at 10.5px) grows
      // by more than the step.
      if (font < 32) {
        const next = await boardAtFont(page, font + 0.5);
        assert.ok(next.board[0] > next.room[0] || next.board[1] > next.room[1],
          `${what}: the board is as large as a font step allows (${seen.board} in ${seen.stage} at ${font}px; ${font + 0.5}px would need ${next.board} in ${next.room})`);
      }
      return seen;
    };
    const cellOf = (page, paneId) => page.locator(`.pane-grid-cell[data-pane-id="${paneId}"]`);
    const shares = (page) => page.evaluate(() => {
      const board = document.querySelector(".pane-grid-board").getBoundingClientRect();
      return Object.fromEntries([...document.querySelectorAll(".pane-grid-cell:not([hidden])")].map((node) => {
        const box = node.getBoundingClientRect();
        return [node.dataset.paneId, [(box.x - board.x) / board.width, (box.y - board.y) / board.height].map((share) => Math.round(share * 100) / 100)];
      }));
    });
    // p1 carried by its header onto p4's middle.
    const swapOnto = async (page, paneId, targetId) => {
      await gridSettled(page);
      const header = await cellOf(page, paneId).locator(".pane-grid-cell-header").boundingBox();
      const target = await cellOf(page, targetId).boundingBox();
      const from = { x: header.x + 30, y: header.y + header.height / 2 };
      const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let step = 1; step <= 10; step += 1) await page.mouse.move(from.x + ((to.x - from.x) * step) / 10, from.y + ((to.y - from.y) * step) / 10);
      await page.mouse.up();
    };
    const open = async (count, { reducedMotion = "no-preference", viewport = { width: 1280, height: 844 }, shape } = {}) => {
      lay(count, shape);
      const context = await keepingSizes({ serviceWorkers: "block", viewport });
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
      await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
      await page.locator('.split-session-button[data-tab-id="w1:t1"]').click();
      // Every cell attached and drawn at its pane's size.
      await page.waitForFunction((ids) => ids.every((id) => document.querySelector(`.pane-grid-cell[data-pane-id="${id}"] .xterm-rows`)
        ?.textContent.replace(/ /gu, " ").includes(`pane ${id}`)), Object.keys(layouts[count]));
      return { context, page, errors };
    };

    for (const count of [2, 3, 4]) {
      const { context, page, errors } = await open(count);
      const seen = await filled(page, `${count} cells`);
      console.log(`  ${count} cells at 1280x844: board ${seen.board} in stage ${seen.stage}, font ${seen.cells[0].font}`);
      assert.ok(seen.gapLeft > 1 || seen.boardTop > 1 || Math.abs(seen.aspect - seen.stageAspect) < 0.02, `${count} cells: the board is letterboxed`);
      await page.setViewportSize({ width: 1100, height: 700 });
      await filled(page, `${count} cells, a smaller window`);
      await page.locator("#sidebar-toggle").click();
      await filled(page, `${count} cells, the sidebar folded`);
      await page.locator("#sidebar-toggle").click();
      await filled(page, `${count} cells, the sidebar back`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // A larger window grows the cells' font past the one chosen for a single
    // pane: the board keeps filling the stage.
    for (const count of [2, 3, 4]) {
      const { context, page, errors } = await open(count, { viewport: { width: 1700, height: 1100 } });
      const seen = await filled(page, `${count} cells, a large window`);
      const chosen = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size")));
      assert.ok(parseFloat(seen.cells[0].font) > chosen, `${count} cells, a large window: the font grows past ${chosen}px (${seen.cells[0].font})`);
      console.log(`  ${count} cells at 1700x1100: board ${seen.board} in stage ${seen.stage}, font ${seen.cells[0].font}`);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // The grid's text size is the user's to adjust: Ctrl+wheel steps it from
    // the font the cells have, every cell alike, the board shrinking with it
    // and the cells still filled; larger returns up to the fit; Ctrl+0 (or
    // Settings) goes back to auto. The global setting stays as it is, and a
    // pane alone still follows it.
    for (const count of [2, 4]) {
      const { context, page, errors } = await open(count);
      const setting = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size")));
      const stored = () => page.evaluate(() => localStorage.getItem("herdrbridge-grid-font"));
      const global = await setting();
      const auto = await filled(page, `${count} cells, auto`);
      const autoFont = parseFloat(auto.cells[0].font);
      const stage = await page.locator(".pane-grid").boundingBox();
      await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
      const wheel = async (deltaY, times = 1) => {
        await page.keyboard.down("Control");
        for (let step = 0; step < times; step += 1) await page.mouse.wheel(0, deltaY);
        await page.keyboard.up("Control");
        await gridSettled(page);
      };
      await wheel(120, 3);
      const small = await fill(page);
      const smallFont = parseFloat(small.cells[0].font);
      assert.ok(smallFont < autoFont, `${count} cells: smaller shrinks the font (${autoFont} -> ${smallFont})`);
      assert.equal(new Set(small.cells.map((cell) => cell.font)).size, 1, `${count} cells: every cell shrinks equally`);
      assert.ok(small.board[0] < auto.board[0] || small.board[1] < auto.board[1], `${count} cells: the board shrinks (${auto.board} -> ${small.board})`);
      for (const cell of small.cells) {
        assert.ok(cell.slackX >= -0.5 && cell.slackX <= 3, `${count} cells, smaller: ${cell.pane} fills its width (${cell.slackX}px spare)`);
        assert.ok(cell.slackY >= -0.5 && cell.slackY <= Math.max(3, cell.header), `${count} cells, smaller: ${cell.pane} fills its height (${cell.slackY}px spare)`);
      }
      assert.ok(Math.abs(small.gapLeft - small.gapRight) <= 1, `${count} cells, smaller: the board stays centred`);
      assert.equal(await stored(), String(smallFont), "the choice is remembered");
      assert.equal(await setting(), global, `${count} cells: the global setting is unchanged`);
      // Larger comes back up to the fit and no further.
      await wheel(-120, 10);
      assert.equal(parseFloat((await fill(page)).cells[0].font), autoFont, `${count} cells: larger returns up to the fit`);
      assert.equal(await stored(), null, `${count} cells: back at the fit it is automatic again`);
      // Reset: from a smaller size, Ctrl+0 and the Settings item both go back to auto.
      await wheel(120, 3);
      assert.ok(parseFloat((await fill(page)).cells[0].font) < autoFont);
      await page.keyboard.press("Control+0");
      await gridSettled(page);
      assert.equal(parseFloat((await fill(page)).cells[0].font), autoFont, `${count} cells: Ctrl+0 goes back to auto`);
      await wheel(120, 3);
      await page.locator(".settings-button").click();
      await page.locator('[data-action="grid-font"]').click();
      await gridSettled(page);
      assert.equal(parseFloat((await fill(page)).cells[0].font), autoFont, `${count} cells: Reset text size goes back to auto`);
      assert.equal(await setting(), global, `${count} cells: the global setting is still unchanged`);
      // A pane alone follows the global setting.
      await cellOf(page, "w1:p1").locator(".pane-grid-expand").click();
      await page.locator("#grid-back").waitFor({ state: "visible" });
      await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, 120);
      await page.keyboard.up("Control");
      await page.waitForTimeout(200);
      assert.equal(await setting(), global - 1, `${count} cells: a pane alone still takes the global setting`);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`  ${count} cells: grid text size ${autoFont} -> ${smallFont}px, reset to auto`);
    }

    // A swap slides: the two cells carry an animation, then sit at each other's place.
    {
      const { context, page, errors } = await open(4);
      const before = await shares(page);
      const preview = await page.evaluate(() => {
        const mark = document.createElement("div");
        mark.className = "pane-drop-preview pane-grid-drop-preview";
        document.body.append(mark);
        const { transitionDuration } = getComputedStyle(mark);
        mark.remove();
        return transitionDuration;
      });
      assert.ok(parseFloat(preview) >= 0.1, `the drop preview eases between places (${preview})`);
      const sliding = page.waitForFunction(() => ["w1:p1", "w1:p4"].every((id) =>
        document.querySelector(`.pane-grid-cell[data-pane-id="${id}"]`)?.getAnimations()
          .some((animation) => !(animation instanceof CSSTransition) && animation.effect?.getTiming().duration >= 150)), null, { polling: "raf" });
      await swapOnto(page, "w1:p1", "w1:p4");
      await sliding;
      await filled(page, "after a swap");
      const after = await shares(page);
      assert.deepEqual([after["w1:p1"], after["w1:p4"]], [before["w1:p4"], before["w1:p1"]], "the swapped cells settle at each other's place");
      // A closed pane's cell fades where it was; the others slide into its room.
      await page.evaluate(() => {
        window.leavingCells = [];
        new MutationObserver((changes) => {
          for (const change of changes) for (const node of change.addedNodes) {
            if (node.classList?.contains("is-leaving")) window.leavingCells.push([node.dataset.leavingPaneId, node.dataset.paneId ?? null, node.getAnimations().length]);
          }
        }).observe(document.querySelector(".pane-grid-board"), { childList: true });
      });
      await cellOf(page, "w1:p1").locator(".pane-grid-menu > summary").click();
      await page.locator('.pane-grid-cell[data-pane-id="w1:p1"] [data-action="close"]').click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-grid-cell:not(.is-leaving)").length === 3);
      await page.waitForFunction(() => !document.querySelector(".pane-grid-cell.is-leaving"));
      assert.deepEqual(await page.evaluate(() => window.leavingCells), [["w1:p1", null, 1]], "the closed pane's cell fades out");
      await filled(page, "after a close");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Even out layout, from a cell's ⋯: Herdr's borders move, the grid reads
    // the layout again and its cells slide to equal shares; the feedback says
    // so. A layout the server cannot even out says why.
    {
      const { context, page, errors } = await open(3, { shape: { "w1:p1": [0, 0, 84, 40], "w1:p2": [84, 0, 36, 16], "w1:p3": [84, 16, 36, 24] } });
      await gridSettled(page);
      assert.deepEqual(await shares(page), { "w1:p1": [0, 0], "w1:p2": [0.7, 0], "w1:p3": [0.7, 0.4] });
      const sliding = page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p2"]')?.getAnimations()
        .some((animation) => !(animation instanceof CSSTransition) && animation.effect?.getTiming().duration >= 150), null, { polling: "raf" });
      const asked = page.waitForRequest((request) => request.method() === "POST" && decodeURIComponent(request.url()).endsWith("/w1:p2/even-layout"));
      await cellOf(page, "w1:p2").locator(".pane-grid-menu > summary").click();
      await page.locator('.pane-grid-cell[data-pane-id="w1:p2"] [data-action="even-layout"]').click();
      assert.deepEqual((await asked).postDataJSON(), {});
      await sliding;
      await page.locator("#action-feedback").filter({ hasText: "Layout evened out." }).waitFor();
      // The fake's terminals keep their size (Herdr would resize them), so only
      // the cells' places are checked.
      await gridSettled(page);
      assert.deepEqual(await shares(page), { "w1:p1": [0, 0], "w1:p2": [0.5, 0], "w1:p3": [0.5, 0.5] }, "the cells take equal shares");
      assert.deepEqual(rearranged.at(-1), ["even-layout", "w1:p2"]);
      await page.route("**/api/panes/*/even-layout", (route) => route.fulfill({ status: 200,
        json: { pane_id: "w1:p2", changed: false, steps: 0, even: false, message: "This layout is not made of splits that can be evened out." } }));
      await cellOf(page, "w1:p3").locator(".pane-grid-menu > summary").click();
      await page.locator('.pane-grid-cell[data-pane-id="w1:p3"] [data-action="even-layout"]').click();
      await page.locator('#action-feedback[data-error="true"]').filter({ hasText: "not made of splits" }).waitFor();
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Reduced motion: the cells jump, and the preview does not ease.
    {
      const { context, page, errors } = await open(4, { reducedMotion: "reduce" });
      const preview = await page.evaluate(() => {
        const mark = document.createElement("div");
        mark.className = "pane-drop-preview pane-grid-drop-preview";
        document.body.append(mark);
        const { transitionDuration } = getComputedStyle(mark);
        mark.remove();
        return transitionDuration;
      });
      assert.ok(parseFloat(preview) < 0.001, `reduced motion: the preview jumps (${preview})`);
      const moved = page.waitForFunction(() => {
        const node = document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"]');
        if (node?.style.left !== "50%") return null;
        // The slides are the page's own animations (not a style's transition).
        return { sliding: [...document.querySelectorAll(".pane-grid-cell")].flatMap((cell) => cell.getAnimations())
          .filter((animation) => !(animation instanceof CSSTransition) && !(animation instanceof CSSAnimation)).length };
      }, null, { polling: "raf" });
      await swapOnto(page, "w1:p1", "w1:p4");
      assert.deepEqual(await (await moved).jsonValue(), { sliding: 0 }, "reduced motion: nothing slides");
      await filled(page, "after a swap, reduced motion");
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("ok: the board fits its cells, and layout changes slide");
  }
  // Fit panes to this window (the default): a Herdr grid adapts to the window
  // as Herdr adapts to its own. The cells, placed by Herdr's proportions, fill
  // the stage; each sizes its pane to itself at the terminal font (resize
  // frames carry the cell's columns and rows), the font being the one chosen
  // for a pane alone, which Ctrl+wheel changes again. A slide or a sidebar
  // dragged wider sends each pane one size at the end, polls send none, a
  // sliver waits as a name until focused and then never sizes its pane below
  // 10x3, and the setting switches modes live.
  {
    const lay = (shape) => {
      reset();
      panes = panes.filter((pane) => pane.tab_id !== "w1:t1" || pane.pane_id in shape);
      for (const [id, [x, y, width, height]] of Object.entries(shape)) rects.set(id, { x, y, width, height });
    };
    const shapes = {
      2: { "w1:p1": [0, 0, 60, 40], "w1:p2": [60, 0, 60, 40] },
      3: { "w1:p1": [0, 0, 60, 40], "w1:p2": [60, 0, 60, 20], "w1:p3": [60, 20, 60, 20] },
      4: { "w1:p1": [0, 0, 60, 20], "w1:p2": [60, 0, 60, 20], "w1:p3": [0, 20, 60, 20], "w1:p4": [60, 20, 60, 20] },
    };
    const shots = process.env.PANE_GRID_SHOTS;
    // Opens the tab's grid with `shape` (null: the fake's own four panes, p4 a
    // sliver); every frame of the cells' sockets is kept.
    const open = async (shape, viewport = { width: 1280, height: 844 }) => {
      if (shape) lay(shape); else reset();
      ptys.length = 0;
      const context = await browser.newContext({ serviceWorkers: "block", viewport });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const sockets = [];
      page.on("websocket", (ws) => {
        const socket = { frames: [] };
        ws.on("framesent", ({ payload }) => { try { socket.frames.push(JSON.parse(payload)); } catch {} });
        sockets.push(socket);
      });
      await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
      await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
      // Every socket from here on is a cell's.
      const from = sockets.length;
      await page.locator('.split-session-button[data-tab-id="w1:t1"]').click();
      const shown = Object.keys(shape ?? { "w1:p1": 0, "w1:p2": 0, "w1:p3": 0 });
      await page.waitForFunction((ids) => ids.every((id) => document.querySelector(`.pane-grid-cell[data-pane-id="${id}"] .xterm-rows`)
        ?.textContent.replace(/ /gu, " ").includes(`pane ${id}`)), shown);
      // The frames the cells sent for `paneId`, of `type`.
      const framesOf = (paneId, type) => sockets.slice(from).flatMap((socket) => socket.frames)
        .filter((frame) => frame.paneId === paneId && frame.type === type);
      const resizes = (paneId) => framesOf(paneId, "resize").length;
      return { context, page, errors, framesOf, resizes };
    };
    // The size herdr's pty of `paneId` has now.
    const ptySize = (paneId) => {
      const pty = ptyOf(paneId);
      return pty ? pty.sizes.at(-1) ?? [pty.options.cols, pty.options.rows] : null;
    };
    const setting = (page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size")));
    // The stage, the board, and each cell: its box, font, columns and rows
    // (rows as drawn, columns from the screen's width) and what its terminal
    // leaves unfilled.
    const look = (page) => page.evaluate(() => {
      const box = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const boardNode = document.querySelector(".pane-grid:not([hidden]) .pane-grid-board");
      const inner = boardNode.getBoundingClientRect();
      return {
        stage: box(document.querySelector(".pane-grid:not([hidden])")),
        board: box(boardNode),
        boardInner: { x: inner.x + boardNode.clientLeft, y: inner.y + boardNode.clientTop, width: boardNode.clientWidth, height: boardNode.clientHeight },
        fitted: boardNode.classList.contains("is-fitted"),
        cells: [...boardNode.querySelectorAll(".pane-grid-cell:not([hidden])")].map((node) => {
          const rows = node.querySelector(".xterm-rows");
          const cell = { pane: node.dataset.paneId, tiny: node.classList.contains("is-tiny"), box: box(node) };
          if (!rows) return cell;
          const style = getComputedStyle(rows);
          const font = parseFloat(style.fontSize);
          const context = document.createElement("canvas").getContext("2d");
          context.font = `${font}px ${style.fontFamily}`;
          const charWidth = context.measureText("W").width;
          const screen = node.querySelector(".xterm-screen").getBoundingClientRect();
          const body = node.querySelector(".pane-grid-terminal");
          const pad = getComputedStyle(node.querySelector(".xterm"));
          return {
            ...cell, font, charWidth, rowHeight: screen.height / rows.children.length,
            cols: Math.round(screen.width / charWidth), rows: rows.children.length,
            slackX: body.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) - screen.width,
            slackY: body.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom) - screen.height,
          };
        }),
      };
    });
    // The cells fill the stage at Herdr's proportions, each terminal filling
    // its cell at the terminal font, its pane sized to it.
    const fitted = async (page, shape, what) => {
      await gridSettled(page);
      // A size is told once the cell keeps still a while.
      await page.waitForTimeout(500);
      const seen = await look(page);
      const near = (actual, expected, slack, label) => assert.ok(Math.abs(actual - expected) <= slack, `${what}: ${label} (${actual} vs ${expected})`);
      assert.equal(seen.fitted, false, `${what}: no letterboxed board`);
      for (const key of ["x", "y", "width", "height"]) near(seen.board[key], seen.stage[key], 3, `the cells fill the stage ${key}`);
      const font = await setting(page);
      const area = { width: 120, height: 40 };
      for (const cell of seen.cells) {
        const [x, y, width, height] = shape[cell.pane];
        near(cell.box.x - seen.boardInner.x, seen.boardInner.width * x / area.width, 2, `${cell.pane} left`);
        near(cell.box.y - seen.boardInner.y, seen.boardInner.height * y / area.height, 2, `${cell.pane} top`);
        near(cell.box.width, seen.boardInner.width * width / area.width, 2, `${cell.pane} width`);
        near(cell.box.height, seen.boardInner.height * height / area.height, 2, `${cell.pane} height`);
        assert.equal(cell.font, font, `${what}: ${cell.pane} reads at the terminal font`);
        assert.ok(cell.slackX >= -0.5 && cell.slackX < cell.charWidth + 1, `${what}: ${cell.pane} fills its width (${cell.slackX}px spare)`);
        assert.ok(cell.slackY >= -0.5 && cell.slackY < cell.rowHeight + 1, `${what}: ${cell.pane} fills its height (${cell.slackY}px spare)`);
        const [cols, rows] = ptySize(cell.pane);
        assert.equal(rows, cell.rows, `${what}: ${cell.pane}'s pty has the cell's rows`);
        assert.ok(Math.abs(cols - cell.cols) <= 1, `${what}: ${cell.pane}'s pty has the cell's columns (${cols} vs ${cell.cols})`);
      }
      return seen;
    };
    // The last size the cells asked for `paneId` (attach or resize) is its pty's.
    const askedLast = (framesOf, paneId) => {
      const asked = [...framesOf(paneId, "attach"), ...framesOf(paneId, "resize")];
      const last = framesOf(paneId, "resize").at(-1) ?? framesOf(paneId, "attach").at(-1);
      assert.ok(asked.length > 0);
      assert.deepEqual([last.cols, last.rows], ptySize(paneId), `${paneId}: the frames carry the size its pty has`);
    };
    const toggleFit = async (page, on) => {
      await page.locator(".settings-button").click();
      const item = page.locator('[data-action="grid-fit"]');
      assert.equal(await item.getAttribute("aria-checked"), String(!on));
      await item.click();
      await page.locator(".settings-button").click();
      assert.equal(await page.locator('[data-action="grid-fit"]').getAttribute("aria-checked"), String(on));
      // The label stays; on or off is the item's data-toggle (its colour) and its accessible name.
      assert.equal(await page.locator('[data-action="grid-fit"] span').textContent(), "Fit panes to this window");
      assert.equal(await page.locator('[data-action="grid-fit"]').getAttribute("data-toggle"), on ? "on" : "off");
      assert.equal(await page.locator('[data-action="grid-fit"]').getAttribute("aria-label"), `Fit panes to this window, ${on ? "on" : "off"}`);
      await page.locator(".settings-button").click();
      assert.equal(await page.evaluate(() => localStorage.getItem("herdrbridge-grid-fit")), on ? "on" : "off", "the choice is remembered");
    };

    for (const [count, viewport] of [[2, { width: 1280, height: 844 }], [4, { width: 1280, height: 844 }], [2, { width: 1700, height: 1100 }], [4, { width: 1700, height: 1100 }]]) {
      const what = `fit, ${count} cells at ${viewport.width}x${viewport.height}`;
      const { context, page, errors, framesOf, resizes } = await open(shapes[count], viewport);
      const ids = Object.keys(shapes[count]);
      const seen = await fitted(page, shapes[count], what);
      for (const paneId of ids) {
        assert.ok(framesOf(paneId, "attach").every((frame) => frame.keepSize !== true), `${what}: ${paneId} attaches to size its pane`);
        askedLast(framesOf, paneId);
        // Its terminal answers none of herdr's queries as typing.
        assert.equal(ptyOf(paneId).written, "", `${what}: ${paneId} is typed nothing by its cell`);
      }
      // Polls with nothing changed send no size.
      const before = ids.map(resizes);
      await page.waitForTimeout(2500);
      assert.deepEqual(ids.map(resizes), before, `${what}: polls send no resize`);
      console.log(`  ${what}: cells ${seen.cells.map((cell) => `${cell.cols}x${cell.rows}`).join(", ")} at ${seen.cells[0].font}px; resize frames ${before.join("/")}`);
      if (shots && viewport.width === 1700) await page.screenshot({ path: join(shots, `fit-on-${count}-1700.png`) });
      // The grid's own text size has no say here: no Reset text size.
      await page.locator(".settings-button").click();
      assert.equal(await page.locator('[data-action="grid-font"]').isVisible(), false, `${what}: no Reset text size`);
      await page.locator(".settings-button").click();
      if (viewport.width === 1280) {
        // Ctrl+wheel changes the terminal font, and the cells (and their panes) follow it.
        const global = await setting(page);
        const stage = await page.locator(".pane-grid").boundingBox();
        await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, 120);
        await page.keyboard.up("Control");
        await page.waitForFunction((was) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size")) === was - 1, global);
        const smaller = await fitted(page, shapes[count], `${what}, a smaller font`);
        assert.equal(smaller.cells[0].font, global - 1);
        assert.ok(smaller.cells[0].cols > seen.cells[0].cols, `${what}: a smaller font fits more columns (${seen.cells[0].cols} -> ${smaller.cells[0].cols})`);
        for (const paneId of ids) askedLast(framesOf, paneId);
        assert.equal(await page.evaluate(() => localStorage.getItem("herdrbridge-grid-font")), null, "the grid's own size is untouched");
      } else {
        // The setting switches modes live: off, the cells attach again keeping
        // their panes' sizes on a letterboxed board; on again, they size them.
        const attachesBefore = ids.map((id) => framesOf(id, "attach").length);
        await toggleFit(page, false);
        await page.waitForFunction(() => document.querySelector(".pane-grid-board")?.classList.contains("is-fitted"));
        await gridSettled(page);
        for (const [index, paneId] of ids.entries()) {
          const attaches = framesOf(paneId, "attach");
          assert.ok(attaches.length > attachesBefore[index], `${paneId} attaches again`);
          assert.equal(attaches.at(-1).keepSize, true, `off: ${paneId} keeps its pane's size`);
        }
        if (shots) await page.screenshot({ path: join(shots, `fit-off-${count}-1700.png`) });
        const sizesOff = ids.map(resizes);
        await page.waitForTimeout(600);
        assert.deepEqual(ids.map(resizes), sizesOff, "off: a cell sends no resize");
        await toggleFit(page, true);
        await page.waitForFunction(() => !document.querySelector(".pane-grid-board")?.classList.contains("is-fitted"));
        await fitted(page, shapes[count], `${what}, on again`);
        for (const paneId of ids) assert.notEqual(framesOf(paneId, "attach").at(-1).keepSize, true, `on again: ${paneId} sizes its pane`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }

    // A swap slides the cells by a transform: each pane whose cell changed
    // size hears it once, the others nothing. A sidebar dragged wider sends
    // each pane one size, at the end.
    {
      const shape = shapes[3];
      const { context, page, errors, resizes } = await open(shape);
      const ids = Object.keys(shape);
      await fitted(page, shape, "fit, 3 cells");
      const before = ids.map(resizes);
      const sliding = page.waitForFunction(() => ["w1:p1", "w1:p3"].every((id) =>
        document.querySelector(`.pane-grid-cell[data-pane-id="${id}"]`)?.getAnimations()
          .some((animation) => !(animation instanceof CSSTransition) && animation.effect?.getTiming().duration >= 150)), null, { polling: "raf" });
      const header = await page.locator('.pane-grid-cell[data-pane-id="w1:p1"] .pane-grid-cell-header').boundingBox();
      const target = await page.locator('.pane-grid-cell[data-pane-id="w1:p3"]').boundingBox();
      const from = { x: header.x + 30, y: header.y + header.height / 2 };
      const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let step = 1; step <= 10; step += 1) await page.mouse.move(from.x + ((to.x - from.x) * step) / 10, from.y + ((to.y - from.y) * step) / 10);
      await page.mouse.up();
      await sliding;
      const swapped = { "w1:p1": shape["w1:p3"], "w1:p2": shape["w1:p2"], "w1:p3": shape["w1:p1"] };
      await fitted(page, swapped, "fit, after a swap");
      const afterSwap = ids.map(resizes);
      assert.deepEqual(afterSwap.map((count, index) => count - before[index]), [1, 0, 1], "a swap: one resize per pane whose cell changed size, none per frame");
      // The sidebar dragged 160px wider, a frame at a time.
      const handle = await page.locator("#navigator-resizer").boundingBox();
      const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let step = 1; step <= 32; step += 1) {
        await page.mouse.move(start.x + step * 5, start.y);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
      }
      await page.mouse.up();
      await fitted(page, swapped, "fit, the sidebar wider");
      const afterDrag = ids.map(resizes);
      assert.deepEqual(afterDrag.map((count, index) => count - afterSwap[index]), [1, 1, 1], "a sidebar drag: one resize per pane, at the end");
      console.log(`  fit: resize frames per pane (p1/p2/p3): ${before.join("/")} at first, +${afterSwap.map((count, index) => count - before[index]).join("/")} for a swap, +${afterDrag.map((count, index) => count - afterSwap[index]).join("/")} for a 32-frame sidebar drag`);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // A sliver waits as a name; focused, it attaches, never sizing its pane
    // below 10x3. Typing reaches the focused cell's pane alone.
    {
      const { context, page, errors, framesOf } = await open(null);
      await gridSettled(page);
      const sliver = page.locator('.pane-grid-cell[data-pane-id="w1:p4"]');
      assert.equal(await sliver.evaluate((node) => node.classList.contains("is-tiny")), true, "the sliver is a name");
      assert.equal(framesOf("w1:p4", "attach").length, 0, "the sliver does not attach");
      await sliver.click();
      await sliver.locator(".xterm").waitFor();
      await page.waitForTimeout(600);
      const [cols, rows] = ptySize("w1:p4");
      assert.ok(cols >= 10 && rows >= 3, `a focused sliver sizes its pane no smaller than 10x3 (${cols}x${rows})`);
      await page.locator('.pane-grid-cell[data-pane-id="w1:p2"] .xterm').click();
      await page.keyboard.type("only p2");
      await page.waitForTimeout(300);
      assert.match(ptyOf("w1:p2").written, /only p2/u);
      for (const other of ["w1:p1", "w1:p3", "w1:p4"]) assert.doesNotMatch(ptyOf(other)?.written ?? "", /only/u, `${other} hears nothing`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("ok: a grid fits its panes to the window");
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
  // said. The split row's ⋯ evens out the panes (a one-pane session's has no
  // such item) and separates every pane but the first, one after another,
  // once the user says so, and the grid gives way to one pane alone.
  for (const mobile of [false, true]) {
    reset();
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    page.on("request", (request) => {
      const match = decodeURIComponent(new URL(request.url()).pathname).match(/^\/api\/panes\/([^/]+)\/(split|zoom|close|move-out|even-layout)$/u);
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
    for (const items of menus.local) assert.deepEqual(items, ["split-right", "split-down", "zoom", "even-layout", "move-out", "close"]);
    assert.equal(menus.remote, 0, "a connected PC's pane rows have no ⋯");
    assert.deepEqual(menus.localRow, ["Rename", "even-layout", "separate-all", "Close session"]);
    assert.deepEqual(menus.remoteRow, ["Rename", "Close session"], "no Even out or Separate all for a connected PC");
    // A session of one pane has nothing to even out or separate.
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.tab-group[data-tab-id="w1:t2"] .session-row > .session-action-menu .sidebar-action-item')]
      .map((item) => item.dataset.action ?? item.textContent)), ["Rename", "Close session"]);

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

    // The split row's ⋯ evens out the session's panes, without asking: the
    // feedback says it is done.
    await rowMenu("w1:t1", "even-layout");
    await feedbackSays("Layout evened out.");
    assert.deepEqual(requests.at(-1), ["even-layout", "w1:p1", {}]);
    assert.deepEqual(["w1:p1", "w1:p2", "w1:p4"].map((id) => rects.get(id).width), [40, 40, 40], "three equal columns");

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
