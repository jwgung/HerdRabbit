// Browser check of dropping a session on a pane, against an in-process fake
// herdr that keeps its own layout. A session of one pane dragged from the
// sidebar onto a grid cell's edge shows the half it would take and joins that
// pane's tab on that side (each of the four), then is selected in the grid; the
// middle of a cell is no drop; the pane shown alone is a target too; a gap in
// the list still reorders; a split session or one of another machine shows no
// zones; a refusal is said; and a narrow screen has no zones at all.
// PANE_DROP_SHOTS=<folder> keeps pictures taken mid-drag in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HerdrCommandError } from "../src/herdr-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const local = { server_id: "local", herdr_session_id: "hs_x" };
const laptop = { server_id: "laptop", herdr_session_id: "laptop!hs_x" };

// Platform's "Split work" is p1 | p2. Four sessions of one pane wait to be
// dropped (two in Docs), "Pair" has two panes, and the laptop has one of its own.
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
      tab("w1:t4", "w1", "Pair"), tab("w2:t1", "w2", "Gamma"), tab("w2:t2", "w2", "Delta"),
      tab("w2:t3", "w2", "Epsilon"),
      tab("laptop!w1:t1", "laptop!w1", "Notes", laptop),
    ],
    panes: [
      pane("w1:p1", "w1:t1", "/work/left"), pane("w1:p2", "w1:t1", "/work/right"),
      pane("w1:p3", "w1:t2", "/work/alpha"), pane("w1:p4", "w1:t3", "/work/beta"),
      pane("w1:p5", "w1:t4", "/work/pair-a"), pane("w1:p6", "w1:t4", "/work/pair-b"),
      pane("w2:p1", "w2:t1", "/work/gamma"), pane("w2:p2", "w2:t2", "/work/delta"),
      pane("w2:p3", "w2:t3", "/work/epsilon"),
      pane("laptop!w1:p1", "laptop!w1:t1", "/home/notes", laptop),
    ],
  };
  rects = new Map([
    ["w1:p1", { x: 0, y: 0, width: 60, height: 40 }],
    ["w1:p2", { x: 60, y: 0, width: 60, height: 40 }],
  ]);
  nextNumber = 20;
}
reset();

let refuseNext = false;
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
  async sendText() {},
  async sendKeys() {},
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
    return { pane_id: id };
  },
};
const gap = (from, insertIndex) => (from >= 0 && insertIndex > from ? insertIndex - 1 : insertIndex);

const { server } = createHerdrHttpServer({ herdr, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.PANE_DROP_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const tabRow = (paneId) => `.tab-group:has(.pane-button[data-pane-id="${paneId}"])`;
const cell = (paneId) => `.pane-grid-cell[data-pane-id="${paneId}"]`;
const box = async (page, selector) => {
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
    await page.locator('.tab-grid-open[data-tab-id="w1:t1"]').click();
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
    const sources = { left: "w1:p3", right: "w1:p4", up: "w2:p1", down: "w2:p2" };
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
      const moved = herdrState.panes.find((pane) => pane.cwd === `/work/${{ left: "alpha", right: "beta", up: "gamma", down: "delta" }[side]}`);
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
    let source = await box(page, tabRow("w2:p3"));
    let target = await box(page, cell("w1:p1"));
    let during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, 0.5, 0.5));
    assert.ok(during.ghost);
    assert.equal(during.preview, null, "no zone in the middle");
    await page.waitForTimeout(300);
    assert.equal(calls.length, before, "nothing was asked of the server");
    assert.equal(await page.locator(tabRow("w2:p3")).count(), 1);

    // 3. A gap in the list still reorders: Pair goes above Split work.
    source = await box(page, `${tabRow("w1:p5")} .tab-heading`);
    target = await box(page, tabRow("w1:p1"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), { x: target.x + 60, y: target.y + 3 });
    assert.ok(during.line, "a line shows where it lands");
    assert.equal(during.preview, null);
    await page.waitForTimeout(400);
    assert.deepEqual(calls.slice(before), [["moveTab", "w1:t4", 0]], "reordering still works");

    // 4. A split session shows no zones over a cell.
    before = calls.length;
    source = await box(page, `${tabRow("w1:p5")} .tab-heading`);
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

    // 6. A refusal is said, and the session stays where it was.
    refuseNext = true;
    source = await box(page, tabRow("w2:p3"));
    target = await box(page, cell("w1:p1"));
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.down));
    assert.equal(during.preview?.side, "down");
    await page.locator("#action-feedback").filter({ hasText: "There is no room to split this pane." }).waitFor();
    assert.deepEqual(calls.at(-1), ["movePaneSplit", "w2:p3", "w1:p1", "down"]);
    assert.equal(await page.locator(tabRow("w2:p3")).count(), 1);

    // 7. The pane shown alone is a target too: Epsilon joins p1 on its right,
    // and p1's tab opens as a grid on it.
    await page.locator('.pane-button[data-pane-id="w1:p1"]').click();
    await page.locator(".pane-grid").waitFor({ state: "hidden" });
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    source = await box(page, tabRow("w2:p3"));
    target = await box(page, ".terminal-stage");
    during = await mouseDrag(page, at(source, 0.3, 0.5), at(target, ...zone.right), { shot: () => theme("drop-solo") });
    assert.equal(during.preview?.side, "right");
    near(during.preview, half(target, "right"), "solo preview");
    await page.locator(".pane-grid").waitFor({ state: "visible" });
    assert.deepEqual(bodies.at(-1), { pane: "w2:p3", body: { targetPaneId: "w1:p1", side: "right" } });
    const epsilon = herdrState.panes.find((pane) => pane.cwd === "/work/epsilon");
    await page.waitForFunction((id) => document.querySelector(`.pane-grid-cell[data-pane-id="${id}"]`)?.classList.contains("is-focused"), epsilon.pane_id);

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
  console.log("Pane drop (four sides, middle no-op, pane alone, reorder kept, split/other machine/self no zones, refusal said, narrow screen none): passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
