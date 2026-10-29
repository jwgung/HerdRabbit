// Browser check of dropping a session on a pane, against an in-process fake
// herdr that keeps its own layout. A session of one pane of the same project
// dragged from the sidebar onto a grid cell's edge shows the half it would
// take and joins that pane's tab on that side (each of the four), then is
// selected in the grid; the middle of a cell is no drop; the pane shown alone
// is a target too; a gap in the list still reorders; a split session or one of
// another machine shows no zones, nor does a connected PC's session over that
// PC's own pane, nor another project's session over a Herdr grid; a refusal is
// said; a pane moved that could not then be swapped to the left is followed
// all the same and the miss is said; and a narrow screen has no zones at all.
// Another project's session dropped on the pane alone makes this window's own
// view split instead (each of the four sides): no move is asked, Herdr is
// left as it was, the tiles sit where they were dropped, the selected tile
// takes the typing, a sidebar row of a tile focuses it and another pane opens
// alone with Back to split view, ⤢ opens a tile alone, a reload brings the
// view split back, a vanished pane's tile goes, and ✕ takes tiles out until
// the last one shows alone. A tile carried by its header swaps with another
// (its middle) or goes beside it (an edge), nothing sent, kept on reload.
// PANE_DROP_SHOTS=<folder> keeps pictures taken mid-drag and of the view
// split (two and three tiles) in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HerdrCommandError } from "../src/herdr-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const local = { server_id: "local", herdr_session_id: "hs_x" };
const laptop = { server_id: "laptop", herdr_session_id: "laptop!hs_x" };

// Platform's "Split work" is p1 | p2. Seven sessions of one pane of Platform
// wait to be dropped, Docs has four of its own, "Pair" has two panes, and the
// laptop has two of its own.
let herdrState;
let rects;
let nextNumber;
function reset() {
  const tab = (tab_id, workspace_id, label, scope = local) => ({ tab_id, workspace_id, label, ...scope });
  const pane = (pane_id, tab_id, cwd, scope = local) => ({ pane_id, tab_id, workspace_id: tab_id.split(":")[0], cwd, agent_status: "idle", ...scope });
  herdrState = {
    workspaces: [
      { workspace_id: "w1", label: "Platform", ...local },
      { workspace_id: "w2", label: "Docs", ...local },
      { workspace_id: "laptop!w1", label: "Laptop work", ...laptop },
    ],
    tabs: [
      tab("w1:t1", "w1", "Split work"), tab("w1:t2", "w1", "Alpha"), tab("w1:t3", "w1", "Beta"),
      tab("w1:t4", "w1", "Pair"), tab("w1:t5", "w1", "Eta"), tab("w1:t6", "w1", "Theta"),
      tab("w1:t7", "w1", "Iota"), tab("w1:t8", "w1", "Kappa"), tab("w1:t9", "w1", "Lambda"),
      tab("w2:t1", "w2", "Gamma"), tab("w2:t2", "w2", "Delta"),
      tab("w2:t3", "w2", "Epsilon"), tab("w2:t4", "w2", "Zeta"),
      tab("laptop!w1:t1", "laptop!w1", "Notes", laptop), tab("laptop!w1:t2", "laptop!w1", "Todo", laptop),
    ],
    panes: [
      pane("w1:p1", "w1:t1", "/work/left"), pane("w1:p2", "w1:t1", "/work/right"),
      pane("w1:p3", "w1:t2", "/work/alpha"), pane("w1:p4", "w1:t3", "/work/beta"),
      pane("w1:p5", "w1:t4", "/work/pair-a"), pane("w1:p6", "w1:t4", "/work/pair-b"),
      pane("w1:p7", "w1:t5", "/work/eta"), pane("w1:p8", "w1:t6", "/work/theta"),
      pane("w1:p9", "w1:t7", "/work/iota"), pane("w1:p10", "w1:t8", "/work/kappa"),
      pane("w1:p11", "w1:t9", "/work/lambda"),
      pane("w2:p1", "w2:t1", "/work/gamma"), pane("w2:p2", "w2:t2", "/work/delta"),
      pane("w2:p3", "w2:t3", "/work/epsilon"), pane("w2:p4", "w2:t4", "/work/zeta"),
      pane("laptop!w1:p1", "laptop!w1:t1", "/home/notes", laptop),
      pane("laptop!w1:p2", "laptop!w1:t2", "/home/todo", laptop),
    ],
  };
  rects = new Map([
    ["w1:p1", { x: 0, y: 0, width: 60, height: 40 }],
    ["w1:p2", { x: 60, y: 0, width: 60, height: 40 }],
  ]);
  nextNumber = 20;
}
reset();

const sent = [];
let refuseNext = false;
let unplaceNext = false;
const calls = [];
const herdr = {
  async snapshot() {
    return structuredClone({
      servers: [
        { id: "local", name: "workstation", available: true, status: "Connected" },
        { id: "laptop", name: "laptop", available: true, status: "Connected", transport: "link" },
      ],
      herdr_sessions: [
        { session_id: "hs_x", name: "default", running: true, available: true, server_id: "local" },
        { session_id: "laptop!hs_x", name: "default", running: true, available: true, server_id: "laptop" },
      ],
      ...herdrState, agents: [],
    });
  },
  async readPane() { return "$ "; },
  async sendText(paneId, text) { sent.push({ paneId, text }); },
  async sendKeys() {},
  // Nothing here may close a pane or a session; were it asked, it is recorded.
  async closePane(paneId) { calls.push(["closePane", paneId]); },
  async closeTab(tabId) { calls.push(["closeTab", tabId]); },
  async closeWorkspace(workspaceId) { calls.push(["closeWorkspace", workspaceId]); },
  async moveTab(tabId, insertIndex) {
    calls.push(["moveTab", tabId, insertIndex]);
    const tab = herdrState.tabs.find((item) => item.tab_id === tabId);
    const peers = herdrState.tabs.filter((item) => item.workspace_id === tab.workspace_id);
    const from = peers.indexOf(tab);
    const others = peers.filter((item) => item !== tab);
    const at = gap(from, insertIndex);
    const rest = herdrState.tabs.filter((item) => item !== tab);
    const anchor = others[at];
    rest.splice(anchor ? rest.indexOf(anchor) : rest.indexOf(others.at(-1)) + 1, 0, tab);
    herdrState.tabs = rest;
  },
  async paneLayout(paneId) {
    const tabId = herdrState.panes.find((pane) => pane.pane_id === paneId)?.tab_id;
    return {
      layout: {
        area: { x: 0, y: 0, width: 120, height: 40 },
        focused_pane_id: paneId,
        zoomed: false,
        tab_id: tabId,
        panes: herdrState.panes.filter((pane) => pane.tab_id === tabId)
          .map((pane) => ({ pane_id: pane.pane_id, rect: rects.get(pane.pane_id) ?? { x: 0, y: 0, width: 120, height: 40 } })),
      },
    };
  },
  // Herdr's own move: the pane leaves its tab (which closes) and takes the
  // half of the target on `side`, under a new id.
  async movePaneSplit(paneId, targetPaneId, side) {
    calls.push(["movePaneSplit", paneId, targetPaneId, side]);
    if (refuseNext) {
      refuseNext = false;
      throw new HerdrCommandError("There is no room to split this pane.", { code: "pane_split_failed" });
    }
    const source = herdrState.panes.find((pane) => pane.pane_id === paneId);
    const target = herdrState.panes.find((pane) => pane.pane_id === targetPaneId);
    const rect = rects.get(targetPaneId) ?? { x: 0, y: 0, width: 120, height: 40 };
    const across = side === "left" || side === "right";
    const half = across ? Math.floor(rect.width / 2) : Math.floor(rect.height / 2);
    const first = across ? { ...rect, width: half } : { ...rect, height: half };
    const second = across ? { ...rect, x: rect.x + half, width: rect.width - half } : { ...rect, y: rect.y + half, height: rect.height - half };
    const id = `${target.workspace_id}:p${nextNumber++}`;
    const before = side === "left" || side === "up";
    rects.set(targetPaneId, before ? second : first);
    rects.set(id, before ? first : second);
    herdrState.tabs = herdrState.tabs.filter((tab) => tab.tab_id !== source.tab_id);
    herdrState.panes = herdrState.panes.filter((pane) => pane !== source);
    const at = herdrState.panes.indexOf(target);
    herdrState.panes.splice(before ? at : at + 1, 0,
      { ...source, pane_id: id, tab_id: target.tab_id, workspace_id: target.workspace_id });
    if (unplaceNext) {
      unplaceNext = false;
      return { pane_id: id, placed: false, message: "no pane there to swap with" };
    }
    return { pane_id: id };
  },
};
const gap = (from, insertIndex) => (from >= 0 && insertIndex > from ? insertIndex - 1 : insertIndex);

// Each pty records what was typed into it.
const ptys = [];
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {},
    terminalId: `term_${paneId}`, cols: 80, rows: 24 }),
  spawnPty: (options) => {
    const paneId = options.args[2].replace(/^term_/u, "");
    const pty = {
      paneId, options, written: "", killed: false, sizes: [],
      write(data) { this.written += data; },
      resize(cols, rows) { this.sizes.push([cols, rows]); }, pause() {}, resume() {},
      kill() { this.killed = true; },
    };
    ptys.push(pty);
    setTimeout(() => options.onData(`pane ${paneId}\r\n$ `), 10);
    return pty;
  },
});
const ptyOf = (paneId) => ptys.filter((pty) => pty.paneId === paneId && !pty.killed).at(-1);

const { server } = createHerdrHttpServer({ herdr, attachments, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.PANE_DROP_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const tabRow = (paneId) => `.tab-group:has(.pane-button[data-pane-id="${paneId}"])`;
const cell = (paneId) => `.pane-grid-cell[data-pane-id="${paneId}"]`;
const tile = (paneId) => `.pane-grid.is-view .pane-grid-cell[data-pane-id="${paneId}"]`;
// A row under the sidebar's footer cannot be pressed: each is scrolled into view first.
const box = async (page, selector) => {
  await page.locator(selector).first().evaluate((node) => {
    if (node.closest("#navigator")) node.scrollIntoView({ block: "nearest" });
  });
  const found = await page.locator(selector).first().boundingBox();
  assert.ok(found, `${selector} is on screen`);
  return found;
};
// A point in `rect` at fractions (fx, fy) of its width and height.
const at = (rect, fx, fy) => ({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy });
// Where each side's zone is: the outer tenth of that edge, midway along it.
const zone = { left: [0.1, 0.5], right: [0.9, 0.5], up: [0.5, 0.1], down: [0.5, 0.9] };
// The half of `rect` a drop on `side` takes.
const half = (rect, side) => ({
  left: { x: rect.x, y: rect.y, width: rect.width / 2, height: rect.height },
  right: { x: rect.x + rect.width / 2, y: rect.y, width: rect.width / 2, height: rect.height },
  up: { x: rect.x, y: rect.y, width: rect.width, height: rect.height / 2 },
  down: { x: rect.x, y: rect.y + rect.height / 2, width: rect.width, height: rect.height / 2 },
})[side];

async function mouseDrag(page, from, to, { shot } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 14;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
  }
  await page.waitForTimeout(80);
  const during = await page.evaluate(() => {
    const preview = document.querySelector(".pane-drop-preview");
    const line = document.querySelector(".sidebar-drop-line");
    const rect = preview && !preview.hidden ? preview.getBoundingClientRect() : null;
    return {
      preview: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, side: preview.dataset.side } : null,
      line: Boolean(line && !line.hidden),
      ghost: Boolean(document.querySelector(".sidebar-drag-ghost")),
    };
  });
  if (shot) await shot();
  await page.mouse.up();
  return during;
}

const focusedTile = (page, paneId) => page.waitForFunction((id) =>
  document.querySelector(`.pane-grid.is-view .pane-grid-cell[data-pane-id="${id}"]`)?.classList.contains("is-focused"), paneId);

const near = (actual, expected, what) => {
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= 2, `${what} ${key}: ${actual[key]} vs ${expected[key]}`);
  }
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  // Desktop.
  {
    reset();
    calls.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const bodies = [];
    page.on("request", (request) => {
      if (/\/api\/panes\/[^/]+\/move$/u.test(new URL(request.url()).pathname)) {
        bodies.push({ pane: decodeURIComponent(new URL(request.url()).pathname.split("/")[3]), body: request.postDataJSON() });
      }
    });
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button").first().waitFor({ state: "visible" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.locator('.split-session-button[data-tab-id="w1:t1"]').click();
    await page.locator(".pane-grid").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll(".pane-grid-cell").length === 2);
    const theme = async (name) => {
      if (!shots) return;
      for (const value of ["dark", "light"]) {
        await page.evaluate((next) => { document.documentElement.dataset.theme = next; }, value);
        await page.waitForTimeout(120);
        await page.screenshot({ path: join(shots, `${name}-${value}.png`) });
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    };

    // 1. Each side of a cell: the half it would take lights up, and the drop
    // asks for that side. The moved pane is selected in the grid of the tab it joined.
    const sources = { left: "w1:p3", right: "w1:p4", up: "w1:p7", down: "w1:p8" };
    let cellCount = 2;
    for (const [side, sourcePane] of Object.entries(sources)) {
      const source = await box(page, tabRow(sourcePane));
      const target = await box(page, cell("w1:p2"));
      const during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone[side]),
        { shot: side === "right" ? () => theme("drop-right") : null });
      assert.ok(during.ghost, `${side}: the row follows the pointer`);
      assert.equal(during.line, false, `${side}: no gap line over a pane`);
      assert.ok(during.preview, `${side}: the half it would take shows`);
      assert.equal(during.preview.side, side);
      near(during.preview, half(target, side), `${side} preview`);
      cellCount += 1;
      await page.waitForFunction((count) => document.querySelectorAll(".pane-grid-cell").length === count, cellCount);
      assert.deepEqual(bodies.at(-1), { pane: sourcePane, body: { targetPaneId: "w1:p2", side } });
      assert.deepEqual(calls.at(-1), ["movePaneSplit", sourcePane, "w1:p2", side]);
      const moved = herdrState.panes.find((pane) => pane.cwd === `/work/${{ left: "alpha", right: "beta", up: "eta", down: "theta" }[side]}`);
      await page.waitForFunction((id) => document.querySelector(`.pane-button[data-pane-id="${id}"]`)?.getAttribute("aria-pressed") === "true", moved.pane_id);
      await page.waitForFunction((id) => document.querySelector(`.pane-grid-cell[data-pane-id="${id}"]`)?.classList.contains("is-focused"), moved.pane_id);
      assert.equal(await page.locator(tabRow(sourcePane)).count(), 0, `${side}: the session it came from is gone`);
      assert.equal(await page.locator(".pane-drop-preview").count(), 0, "the preview leaves with the drag");
    }
    // The cells sit where Herdr put the moved panes: left of p2, then right of
    // what is left of it, and so on.
    assert.equal(herdrState.panes.filter((pane) => pane.tab_id === "w1:t1").length, 6);

    // 2. The middle of a cell is no drop.
    let before = calls.length;
    let source = await box(page, tabRow("w1:p9"));
    let target = await box(page, cell("w1:p1"));
    let during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, 0.5, 0.5));
    assert.ok(during.ghost);
    assert.equal(during.preview, null, "no zone in the middle");
    await page.waitForTimeout(300);
    assert.equal(calls.length, before, "nothing was asked of the server");
    assert.equal(await page.locator(tabRow("w1:p9")).count(), 1);

    // 3. A gap in the list still reorders: Pair goes above Split work.
    source = await box(page, `${tabRow("w1:p5")} .split-session-button`);
    target = await box(page, tabRow("w1:p1"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), { x: target.x + 60, y: target.y + 3 });
    assert.ok(during.line, "a line shows where it lands");
    assert.equal(during.preview, null);
    await page.waitForTimeout(400);
    assert.deepEqual(calls.slice(before), [["moveTab", "w1:t4", 0]], "reordering still works");

    // 4. A split session shows no zones over a cell.
    before = calls.length;
    source = await box(page, `${tabRow("w1:p5")} .split-session-button`);
    target = await box(page, cell("w1:p1"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.left));
    assert.ok(during.ghost);
    assert.equal(during.preview, null, "a split session cannot join another");
    await page.waitForTimeout(300);
    assert.equal(calls.length, before);

    // 5. Nor does another machine's session.
    source = await box(page, tabRow("laptop!w1:p1"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.left));
    assert.equal(during.preview, null, "another machine's session cannot join");
    await page.waitForTimeout(300);
    assert.equal(calls.length, before);

    // 5b. Nor does another project's session over a Herdr grid: a grid is
    // Herdr's own tab, and another project would be emptied into it.
    source = await box(page, tabRow("w2:p1"));
    target = await box(page, cell("w1:p1"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.left));
    assert.ok(during.ghost);
    assert.equal(during.preview, null, "another project's session cannot join a grid");
    await page.waitForTimeout(300);
    assert.equal(calls.length, before);
    assert.equal(await page.locator(".pane-grid.is-view:not([hidden])").count(), 0, "no view split over a grid");

    // 6. A refusal is said, and the session stays where it was.
    refuseNext = true;
    source = await box(page, tabRow("w1:p9"));
    target = await box(page, cell("w1:p1"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.down));
    assert.equal(during.preview?.side, "down");
    await page.locator("#action-feedback").filter({ hasText: "There is no room to split this pane." }).waitFor();
    assert.deepEqual(calls.at(-1), ["movePaneSplit", "w1:p9", "w1:p1", "down"]);
    assert.equal(await page.locator(tabRow("w1:p9")).count(), 1);

    // 6b. Moved, but Herdr could not then swap it to the left: the page still
    // follows the pane under its new id, and says what it could not do.
    unplaceNext = true;
    source = await box(page, tabRow("w1:p10"));
    target = await box(page, cell("w1:p1"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.left));
    assert.equal(during.preview?.side, "left");
    await page.locator("#action-feedback").filter({ hasText: "Moved, but could not put it on the left." }).waitFor();
    const kappa = herdrState.panes.find((pane) => pane.cwd === "/work/kappa");
    assert.notEqual(kappa.pane_id, "w1:p10");
    await page.waitForFunction((id) => document.querySelector(`.pane-grid-cell[data-pane-id="${id}"]`)?.classList.contains("is-focused"), kappa.pane_id);
    assert.equal(await page.locator(tabRow("w1:p10")).count(), 0);

    // 7. The pane shown alone is a target too: Lambda, of the same project,
    // joins p1 on its right, and p1's tab opens as a grid on it. p1 is in
    // Split work's pane list.
    await page.locator('.tab-group[data-tab-id="w1:t1"] .split-disclosure').click();
    await page.locator('.pane-button[data-pane-id="w1:p1"]').click();
    await page.locator(".pane-grid").waitFor({ state: "hidden" });
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    source = await box(page, tabRow("w1:p11"));
    target = await box(page, ".terminal-stage");
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.right), { shot: () => theme("drop-solo") });
    assert.equal(during.preview?.side, "right");
    near(during.preview, half(target, "right"), "solo preview");
    await page.locator(".pane-grid:not(.is-view)").waitFor({ state: "visible" });
    assert.deepEqual(bodies.at(-1), { pane: "w1:p11", body: { targetPaneId: "w1:p1", side: "right" } });
    const lambda = herdrState.panes.find((pane) => pane.cwd === "/work/lambda");
    await page.waitForFunction((id) => document.querySelector(`.pane-grid-cell[data-pane-id="${id}"]`)?.classList.contains("is-focused"), lambda.pane_id);

    // 8. Dropped on itself: the pane alone is the dragged session's own.
    await page.locator('.pane-button[data-pane-id="laptop!w1:p1"]').click();
    await page.locator(".pane-grid").waitFor({ state: "hidden" });
    before = calls.length;
    source = await box(page, tabRow("laptop!w1:p1"));
    target = await box(page, ".terminal-stage");
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.left));
    assert.equal(during.preview, null, "a pane is not split by itself");
    await page.waitForTimeout(300);
    assert.equal(calls.length, before);

    // 9. Nor is a connected PC's pane split from here, even by its own sessions.
    await page.locator(tabRow("laptop!w1:p2")).scrollIntoViewIfNeeded();
    source = await box(page, tabRow("laptop!w1:p2"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.left));
    assert.ok(during.ghost);
    assert.equal(during.preview, null, "a connected PC's pane is no target");
    await page.waitForTimeout(300);
    assert.equal(calls.length, before);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Another project's session on the pane alone: this window's own view split.
  {
    reset();
    calls.length = 0;
    ptys.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const moveRequests = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && /^\/api\/(panes|tabs|workspaces)\//u.test(path)) moveRequests.push(path);
    });
    const herdrBefore = JSON.stringify(herdrState);
    // Herdr is as it was: nothing asked, nothing moved, nothing closed.
    const herdrUntouched = (what) => {
      assert.deepEqual(calls, [], `${what}: Herdr was asked nothing`);
      assert.deepEqual(moveRequests, [], `${what}: no move or close was sent`);
      assert.equal(JSON.stringify(herdrState), herdrBefore, `${what}: Herdr's sessions are as they were`);
    };
    const shot = async (name) => {
      if (!shots) return;
      for (const value of ["dark", "light"]) {
        await page.evaluate((next) => { document.documentElement.dataset.theme = next; }, value);
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(shots, `${name}-${value}.png`) });
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    };
    const tileIds = () => page.evaluate(() => [...document.querySelectorAll(".pane-grid.is-view:not([hidden]) .pane-grid-cell")]
      .map((node) => node.dataset.paneId).sort());
    const tileCount = (count) => page.waitForFunction((wanted) =>
      document.querySelectorAll(".pane-grid.is-view:not([hidden]) .pane-grid-cell").length === wanted, count);
    const focusedTile = (paneId) => page.waitForFunction((id) =>
      document.querySelector(`.pane-grid.is-view .pane-grid-cell[data-pane-id="${id}"]`)?.classList.contains("is-focused"), paneId);
    const openAlone = async (paneId) => {
      await page.locator(`.pane-button[data-pane-id="${paneId}"]`).scrollIntoViewIfNeeded();
      await page.locator(`.pane-button[data-pane-id="${paneId}"]`).click();
      await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    };
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p3")}`);
    await page.locator(".pane-button").first().waitFor({ state: "visible" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });

    // 1. Each side of the pane alone: the half lights up, the drop asks Herdr
    // for nothing, and the two tiles sit on that side of each other.
    for (const side of ["right", "left", "up", "down"]) {
      const source = await box(page, tabRow("w2:p1"));
      const stage = await box(page, ".terminal-stage");
      const during = await mouseDrag(page, at(source, 0.3, 0.5), at(stage, ...zone[side]));
      assert.equal(during.preview?.side, side, `${side}: the half it would take shows`);
      near(during.preview, half(stage, side), `${side} view preview`);
      await tileCount(2);
      herdrUntouched(side);
      await focusedTile("w2:p1");
      assert.equal(await page.locator('.pane-button[data-pane-id="w2:p1"]').getAttribute("aria-pressed"), "true", "the dropped pane is selected");
      const own = await box(page, tile("w1:p3"));
      const dropped = await box(page, tile("w2:p1"));
      const across = side === "left" || side === "right";
      const first = side === "left" || side === "up" ? dropped : own;
      const second = first === own ? dropped : own;
      if (across) {
        assert.ok(Math.abs(first.width - second.width) <= 3 && first.x < second.x && Math.abs(first.y - second.y) <= 1, `${side}: side by side`);
      } else {
        assert.ok(Math.abs(first.height - second.height) <= 3 && first.y < second.y && Math.abs(first.x - second.x) <= 1, `${side}: one over the other`);
      }
      assert.equal(await page.locator(`${tile("w2:p1")} .pane-grid-context`).textContent(), "Docs", "a tile names its project");
      assert.equal(await page.locator(`${tile("w1:p3")} .pane-grid-context`).textContent(), "Platform");
      assert.equal(await page.locator(`${tile("w2:p1")} .pane-grid-label`).textContent(), "Gamma", "and its session");
      assert.equal(await page.locator(".pane-grid.is-view .pane-grid-menu").count(), 0, "no Herdr actions on a tile");
      assert.equal(await page.locator("#lens-switch").isVisible(), false, "no Chat lens in the tiles");
      // Close split view: the pane on screen shows alone, nothing else changes.
      await page.locator("#view-close").click();
      await page.locator(".pane-grid.is-view").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => sessionStorage.getItem("herdrbridge-view-split")), null);
      assert.equal(await page.locator("#view-back").isVisible(), false);
      await openAlone("w1:p3");
    }

    // 2. Another machine's session, the pane's own, or a split session: no zones.
    for (const row of [tabRow("laptop!w1:p1"), tabRow("w1:p3"), `${tabRow("w1:p5")} .split-session-button`]) {
      const source = await box(page, row);
      const stage = await box(page, ".terminal-stage");
      const during = await mouseDrag(page, at(source, 0.3, 0.5), at(stage, ...zone.left));
      assert.ok(during.ghost);
      assert.equal(during.preview, null, `${row}: no zone`);
    }
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".pane-grid.is-view:not([hidden])").count(), 0);
    herdrUntouched("no zones");

    // 3. Two tiles, typing goes to the focused one only; a third on a tile's
    // bottom half; a session of the tile's own project is a tile too.
    let source = await box(page, tabRow("w2:p1"));
    let stage = await box(page, ".terminal-stage");
    await mouseDrag(page, at(source, 0.3, 0.5), at(stage, ...zone.right));
    await tileCount(2);
    await page.waitForFunction(() => document.querySelectorAll(".pane-grid.is-view .pane-grid-cell .xterm").length === 2);
    await shot("view-split-2");
    // A view split tile sizes its pane to the tile and reads at the usual font:
    // it does not keep the pane's own size and shrink the text to fit it in.
    const fontOf = (paneId) => page.locator(`${tile(paneId)} .xterm-rows`).evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    for (const paneId of ["w1:p3", "w2:p1"]) {
      assert.ok(await fontOf(paneId) >= 9, `${paneId}: the tile's text is not shrunk to a sliver (${await fontOf(paneId)}px)`);
      // The pane's own size is 80x24 (the fake's answer); an observing cell would
      // attach at that size, a tile that sizes its pane asks for its own.
      const { cols, rows } = ptyOf(paneId).options;
      assert.ok(cols !== 80 || rows !== 24, `${paneId}: the tile sizes its pane (${cols}x${rows})`);
    }
    await page.locator(`${tile("w2:p1")} .xterm`).click();
    await page.keyboard.type("hello gamma");
    const typedBy = Date.now() + 3000;
    while (!/hello gamma/u.test(ptyOf("w2:p1")?.written ?? "") && Date.now() < typedBy) await page.waitForTimeout(100);
    assert.match(ptyOf("w2:p1").written, /hello gamma/u, "the focused tile takes the typing");
    assert.doesNotMatch(ptyOf("w1:p3")?.written ?? "", /hello/u, "the other tile hears nothing");
    // A press on the other tile makes it the selected pane.
    await page.locator(`${tile("w1:p3")} .xterm`).click();
    await focusedTile("w1:p3");
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p3"]').getAttribute("aria-pressed"), "true");
    await page.keyboard.type("hi alpha");
    const typedAlpha = Date.now() + 3000;
    while (!/hi alpha/u.test(ptyOf("w1:p3")?.written ?? "") && Date.now() < typedAlpha) await page.waitForTimeout(100);
    assert.match(ptyOf("w1:p3").written, /hi alpha/u);
    assert.doesNotMatch(ptyOf("w2:p1").written, /hi alpha/u);

    source = await box(page, tabRow("w2:p2"));
    let target = await box(page, tile("w2:p1"));
    let during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.down));
    assert.equal(during.preview?.side, "down");
    near(during.preview, half(target, "down"), "tile preview");
    await tileCount(3);
    await focusedTile("w2:p2");
    const gamma = await box(page, tile("w2:p1"));
    const delta = await box(page, tile("w2:p2"));
    assert.ok(delta.y > gamma.y && Math.abs(delta.x - gamma.x) <= 1, "the third sits under the tile it was dropped on");
    await page.waitForFunction(() => document.querySelectorAll(".pane-grid.is-view .pane-grid-cell .xterm").length === 3);
    await shot("view-split-3");
    source = await box(page, tabRow("w1:p4"));
    target = await box(page, tile("w1:p3"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.up));
    assert.equal(during.preview?.side, "up");
    await tileCount(4);
    // A pane already a tile is no drop on another tile.
    source = await box(page, tabRow("w2:p1"));
    target = await box(page, tile("w1:p3"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.left));
    assert.equal(during.preview, null, "a tile already");
    herdrUntouched("tiles added");
    assert.deepEqual(await tileIds(), ["w1:p3", "w1:p4", "w2:p1", "w2:p2"]);
    const beta = await box(page, tile("w1:p4"));
    const alpha = await box(page, tile("w1:p3"));
    assert.ok(beta.y < alpha.y && Math.abs(beta.x - alpha.x) <= 1, "Beta sits over Alpha, where it was dropped");

    // 4. A sidebar row of a tile focuses it; another pane opens alone, with
    // Back to split view; ⤢ opens a tile alone the same way.
    await page.locator('.pane-button[data-pane-id="w2:p1"]').scrollIntoViewIfNeeded();
    await page.locator('.pane-button[data-pane-id="w2:p1"]').click();
    await focusedTile("w2:p1");
    assert.equal(await page.locator(".pane-grid.is-view").isVisible(), true, "still the view split");
    await openAlone("w2:p3");
    assert.equal(await page.locator(".pane-grid.is-view").isVisible(), false);
    await page.locator("#view-back").waitFor({ state: "visible" });
    await page.locator("#view-back").click();
    await tileCount(4);
    await focusedTile("w2:p1");
    await page.locator(`${tile("w2:p2")} .pane-grid-expand`).click();
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    assert.equal(await page.locator(".pane-grid.is-view").isVisible(), false, "⤢ opens the tile alone");
    assert.equal(await page.locator('.pane-button[data-pane-id="w2:p2"]').getAttribute("aria-pressed"), "true");
    await page.locator("#view-back").click();
    await tileCount(4);
    herdrUntouched("sidebar and back");

    // 5. A reload brings the view split back, from this window's session storage.
    await page.reload();
    await tileCount(4);
    assert.deepEqual(await tileIds(), ["w1:p3", "w1:p4", "w2:p1", "w2:p2"]);
    await focusedTile("w2:p2");
    // The composer sends to the focused tile's pane.
    await page.locator("#terminal-input").fill("from the composer");
    await page.locator("#terminal-input").press("Enter");
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    await page.waitForTimeout(200);
    assert.deepEqual(sent.at(-1), { paneId: "w2:p2", text: "from the composer" });
    // A notification for a tile's pane focuses that tile and is done once it shows.
    await page.evaluate(() => {
      window.relay = new BroadcastChannel("herdr-notification-navigation");
      window.relay.onmessage = ({ data }) => { if (data.type === "notification-target-applied") window.relayApplied = data.id; };
      window.relay.postMessage({ type: "notification-target", id: "relay-tile", url: `${location.origin}/?pane=w2%3Ap1`, expiresAt: Date.now() + 60000 });
    });
    await page.waitForFunction(() => window.relayApplied === "relay-tile", null, { timeout: 5000 });
    await focusedTile("w2:p1");
    assert.equal(await page.locator(".pane-grid.is-view").isVisible(), true, "the view split stays");
    await page.evaluate(() => window.relay.close());

    // 6. A pane closed elsewhere leaves the view on the next snapshot.
    herdrState.tabs = herdrState.tabs.filter((tab) => tab.tab_id !== "w2:t2");
    herdrState.panes = herdrState.panes.filter((pane) => pane.pane_id !== "w2:p2");
    await tileCount(3);
    assert.deepEqual(await tileIds(), ["w1:p3", "w1:p4", "w2:p1"]);
    await page.waitForFunction(() => document.querySelector(".pane-grid.is-view .pane-grid-cell.is-focused"));
    assert.deepEqual(calls, []);

    // 7. ✕ takes a tile out; the pane stays. With one left, it shows alone.
    await page.locator(`${tile("w1:p4")} .pane-grid-remove`).click();
    await tileCount(2);
    await page.locator(`${tile("w2:p1")} .pane-grid-remove`).click();
    await page.locator(".pane-grid.is-view").waitFor({ state: "hidden" });
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p3"]').getAttribute("aria-pressed"), "true", "the last tile shows alone");
    assert.equal(await page.locator("#view-back").isVisible(), false, "no view split is kept");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("herdrbridge-view-split")), null);
    assert.equal(await page.locator(tabRow("w2:p1")).count(), 1, "the removed pane is still a session");
    assert.deepEqual(calls, [], "Herdr was asked nothing");
    assert.deepEqual(moveRequests, []);
    assert.deepEqual(errors, []);
    await context.close();
  }


  // The view split's tiles rearranged by their headers: the middle of another
  // tile swaps the two, an edge puts the tile beside it there. All in this
  // window: no request, Herdr untouched, and a reload keeps it.
  {
    reset();
    calls.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const posts = [];
    page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/")) posts.push(new URL(request.url()).pathname); });
    // Alpha | (Gamma over Delta), Alpha focused: set once, so a reload reads what the page kept.
    await page.addInitScript(() => {
      if (sessionStorage.getItem("herdrbridge-view-split")) return;
      sessionStorage.setItem("herdrbridge-view-split", JSON.stringify({
        tree: { dir: "right", first: "w1:p3", second: { dir: "down", first: "w2:p1", second: "w2:p2", ratio: 0.5 }, ratio: 0.5 },
        shown: true, focus: "w1:p3",
      }));
    });
    const herdrBefore = JSON.stringify(herdrState);
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p3")}`);
    const tileBox = async (paneId) => page.locator(tile(paneId)).boundingBox();
    await page.waitForFunction(() => document.querySelectorAll(".pane-grid.is-view .pane-grid-cell .xterm").length === 3);
    assert.equal(await page.locator(".pane-grid.is-view.can-rearrange").count(), 1);
    const carry = async (paneId, to, { release = true } = {}) => {
      const header = await page.locator(`${tile(paneId)} .pane-grid-cell-header`).boundingBox();
      const from = { x: header.x + 30, y: header.y + header.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let step = 1; step <= 12; step += 1) await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
      await page.waitForTimeout(60);
      const seen = await page.evaluate(() => {
        const mark = document.querySelector(".pane-grid-drop-preview");
        return { ghost: Boolean(document.querySelector(".pane-grid-drag-ghost")),
          kind: mark && !mark.hidden ? mark.dataset.kind : null, side: mark && !mark.hidden ? mark.dataset.side ?? null : null };
      });
      if (release) await page.mouse.up();
      return seen;
    };
    const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("herdrbridge-view-split")));
    const close = (a, b, what) => near(a, b, what);

    // 1. Its own tile is no drop; Escape cancels.
    let seen = await carry("w1:p3", at(await tileBox("w1:p3"), 0.5, 0.6));
    assert.ok(seen.ghost);
    assert.equal(seen.kind, null);
    seen = await carry("w1:p3", at(await tileBox("w2:p2"), 0.5, 0.5), { release: false });
    assert.equal(seen.kind, "swap");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(200);
    assert.equal((await stored()).tree.first, "w1:p3", "nothing moved");

    // 2. Alpha onto Delta's middle: the two trade places.
    const alphaBefore = await tileBox("w1:p3");
    const deltaBefore = await tileBox("w2:p2");
    seen = await carry("w1:p3", at(deltaBefore, 0.5, 0.5));
    assert.equal(seen.kind, "swap");
    await page.waitForFunction(() => document.querySelector('.pane-grid.is-view .pane-grid-cell[data-pane-id="w1:p3"]').style.top === "50%");
    close(await tileBox("w1:p3"), deltaBefore, "Alpha sits where Delta was");
    close(await tileBox("w2:p2"), alphaBefore, "Delta sits where Alpha was");
    assert.deepEqual((await stored()).tree, { dir: "right", first: "w2:p2", second: { dir: "down", first: "w2:p1", second: "w1:p3", ratio: 0.5 }, ratio: 0.5 });
    await focusedTile(page, "w1:p3");
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p3"]').getAttribute("aria-pressed"), "true", "the carried pane stays selected");

    // 3. Gamma onto Delta's left edge: Gamma goes to Delta's left half, Alpha takes the right column.
    const deltaNow = await tileBox("w2:p2");
    seen = await carry("w2:p1", at(deltaNow, 0.06, 0.5));
    assert.equal(seen.kind, "side");
    assert.equal(seen.side, "left");
    await page.waitForFunction(() => document.querySelector('.pane-grid.is-view .pane-grid-cell[data-pane-id="w1:p3"]').style.top === "0%");
    const gamma = await tileBox("w2:p1");
    const delta = await tileBox("w2:p2");
    assert.ok(gamma.x < delta.x && Math.abs(gamma.y - delta.y) <= 1 && Math.abs(gamma.height - delta.height) <= 1, "Gamma sits left of Delta");
    assert.deepEqual((await stored()).tree,
      { dir: "right", first: { dir: "right", first: "w2:p1", second: "w2:p2", ratio: 0.5 }, second: "w1:p3", ratio: 0.5 });
    await focusedTile(page, "w2:p1");
    // Typing goes to the carried tile.
    await page.keyboard.type("moved gamma");
    const typedBy = Date.now() + 3000;
    while (!/moved gamma/u.test(ptyOf("w2:p1")?.written ?? "") && Date.now() < typedBy) await page.waitForTimeout(100);
    assert.match(ptyOf("w2:p1").written, /moved gamma/u);

    // 4. A reload keeps the rearranged view split.
    const before = await Promise.all(["w1:p3", "w2:p1", "w2:p2"].map(tileBox));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".pane-grid.is-view .pane-grid-cell .xterm").length === 3);
    const after = await Promise.all(["w1:p3", "w2:p1", "w2:p2"].map(tileBox));
    before.forEach((box, index) => close(after[index], box, `tile ${index} after reload`));
    await focusedTile(page, "w2:p1");
    assert.deepEqual(posts, [], "nothing was sent to the server");
    assert.deepEqual(calls, [], "Herdr was asked nothing");
    assert.equal(JSON.stringify(herdrState), herdrBefore, "Herdr's sessions are as they were");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // A narrow screen: the sidebar is a drawer over the terminal and nothing splits.
  {
    reset();
    calls.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 700, height: 860 }, colorScheme: "light" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#mobile-sidebar-open").click();
    await page.locator(".pane-button").first().waitFor({ state: "visible" });
    await page.waitForTimeout(600);
    const source = await box(page, tabRow("w1:p3"));
    const during = await mouseDrag(page, at(source, 0.3, 0.5), { x: 690, y: 430 });
    assert.equal(during.preview, null, "no zones on a narrow screen");
    await page.waitForTimeout(300);
    assert.deepEqual(calls.filter((call) => call[0] === "movePaneSplit"), []);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Pane drop (tiles swapped and moved by their headers, kept on reload, nothing sent; four sides, middle no-op, pane alone, reorder kept, split/other machine/self/connected PC/other project over a grid no zones, refusal said, unplaced swap said; another project on the pane alone a view split: four sides, Herdr untouched, typing, sidebar, back, reload, pruned, removed; narrow screen none): passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
