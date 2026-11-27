// Browser check of several view splits kept by one browser, against an
// in-process fake herdr. A session of another project dropped on a pane alone
// makes a new view split and the splits kept so far stay; each split's panes
// wear its number in the sidebar, filled while it is on screen; a row of a
// pane in a kept split opens that split; a pane dropped into a new split
// leaves its old one, which goes when one tile is left; the lowest free
// number is reused; a reload keeps them; another window of the browser
// follows a split closed here without reloading; and a ninth is refused.
// Herdr is asked nothing throughout.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const scope = { server_id: "local", herdr_session_id: "hs_x" };
// Two projects of nine one-pane sessions each: wN:pI in tab wN:tI.
const herdrState = { workspaces: [], tabs: [], panes: [] };
for (const [workspaceId, label] of [["w1", "Platform"], ["w2", "Docs"]]) {
  herdrState.workspaces.push({ workspace_id: workspaceId, label, ...scope });
  for (let index = 1; index <= 9; index += 1) {
    herdrState.tabs.push({ tab_id: `${workspaceId}:t${index}`, workspace_id: workspaceId, label: `${label} ${index}`, ...scope });
    herdrState.panes.push({ pane_id: `${workspaceId}:p${index}`, tab_id: `${workspaceId}:t${index}`, workspace_id: workspaceId,
      cwd: `/work/${workspaceId}/${index}`, agent_status: "idle", ...scope });
  }
}
const calls = [];
const herdr = {
  async snapshot() {
    return structuredClone({
      servers: [{ id: "local", name: "workstation", available: true, status: "Connected" }],
      herdr_sessions: [{ session_id: "hs_x", name: "default", running: true, available: true, server_id: "local" }],
      ...herdrState, agents: [],
    });
  },
  async readPane() { return "$ "; },
  async sendText(paneId) { calls.push(["sendText", paneId]); },
  async sendKeys() {},
  async paneLayout(paneId) {
    const tabId = herdrState.panes.find((pane) => pane.pane_id === paneId)?.tab_id;
    return { layout: { area: { x: 0, y: 0, width: 120, height: 40 }, focused_pane_id: paneId, zoomed: false, tab_id: tabId,
      panes: [{ pane_id: paneId, rect: { x: 0, y: 0, width: 120, height: 40 } }] } };
  },
  async movePaneSplit(...args) { calls.push(["movePaneSplit", ...args]); throw new Error("not asked here"); },
  async moveTab(...args) { calls.push(["moveTab", ...args]); },
};
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {},
    terminalId: `term_${paneId}`, cols: 80, rows: 24 }),
  spawnPty: (options) => {
    const paneId = options.args[2].replace(/^term_/u, "");
    setTimeout(() => options.onData(`pane ${paneId}\r\n$ `), 10);
    return { write() {}, resize() {}, pause() {}, resume() {}, kill() {} };
  },
});
const { server } = createHerdrHttpServer({ herdr, attachments, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;

const tabRow = (paneId) => `.tab-group:has(.pane-button[data-pane-id="${paneId}"])`;
const row = (paneId) => `.pane-button[data-pane-id="${paneId}"]`;
const at = (rect, fx, fy) => ({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy });

// A sidebar row may be redrawn under the pointer's aim: measured again until it holds.
async function box(page, selector) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = await page.locator(selector).first().evaluate((node) => {
      node.scrollIntoView({ block: "nearest" });
      const rect = node.getBoundingClientRect();
      return rect.width > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    }).catch(() => null);
    if (found) return found;
    await page.waitForTimeout(100);
  }
  assert.fail(`${selector} is on screen`);
}

async function mouseDrag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 14; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / 14, from.y + ((to.y - from.y) * step) / 14);
  }
  await page.waitForTimeout(80);
  await page.mouse.up();
}

// Every split mark in the sidebar, as { paneId: "number" or "number*" when filled }.
const marks = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".pane-button[data-pane-id]")]
  .flatMap((button) => {
    const mark = button.querySelector(".view-split-mark");
    return mark ? [[button.dataset.paneId, `${mark.dataset.split}${mark.classList.contains("is-open") ? "*" : ""}`]] : [];
  })));
const waitMarks = async (page, expected, what) => {
  await page.waitForFunction((wanted) => {
    const seen = Object.fromEntries([...document.querySelectorAll(".pane-button[data-pane-id]")].flatMap((button) => {
      const mark = button.querySelector(".view-split-mark");
      return mark ? [[button.dataset.paneId, `${mark.dataset.split}${mark.classList.contains("is-open") ? "*" : ""}`]] : [];
    }));
    return JSON.stringify(seen, Object.keys(seen).sort()) === JSON.stringify(wanted, Object.keys(wanted).sort());
  }, expected, { timeout: 5000 }).catch(() => {});
  assert.deepEqual(await marks(page), expected, what);
};
const tileIds = (page) => page.evaluate(() => [...document.querySelectorAll(".pane-grid.is-view:not([hidden]) .pane-grid-cell")]
  .map((node) => node.dataset.paneId).sort());
const tilesAre = async (page, expected, what) => {
  await page.waitForFunction((wanted) => JSON.stringify([...document.querySelectorAll(".pane-grid.is-view:not([hidden]) .pane-grid-cell")]
    .map((node) => node.dataset.paneId).sort()) === JSON.stringify(wanted), [...expected].sort(), { timeout: 5000 }).catch(() => {});
  assert.deepEqual(await tileIds(page), [...expected].sort(), what);
};
const kept = (page) => page.evaluate(() => (JSON.parse(localStorage.getItem("herdrbridge-view-splits") ?? "null")?.splits ?? [])
  .map((split) => [split.id, JSON.stringify(split.tree).match(/w\d:p\d/gu).sort()]));
const openAlone = async (page, paneId) => {
  await page.locator(row(paneId)).scrollIntoViewIfNeeded();
  await page.locator(row(paneId)).click();
  await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
  await page.waitForTimeout(150);
};
// A session dragged from the sidebar to the right half of the pane shown alone.
const dropBeside = async (page, paneId) => {
  const source = await box(page, tabRow(paneId));
  const stage = await box(page, ".terminal-stage");
  await mouseDrag(page, at(source, 0.3, 0.5), at(stage, 0.9, 0.5));
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 1100 }, colorScheme: "dark" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    await page.waitForTimeout(300);

    // 1. Docs 1 beside Platform 1: split 1, on screen.
    await dropBeside(page, "w2:p1");
    await tilesAre(page, ["w1:p1", "w2:p1"], "split 1 on screen");
    await waitMarks(page, { "w1:p1": "1*", "w2:p1": "1*" }, "split 1's panes wear its mark, filled");
    const title = await page.locator(row("w1:p1")).getAttribute("title");
    assert.match(title, /Split view 1: Platform 1 \+ Docs 1/u, "the row says which panes open with it");

    // 2. Another pane alone: split 1 is kept, its marks no longer filled.
    await openAlone(page, "w1:p2");
    await waitMarks(page, { "w1:p1": "1", "w2:p1": "1" }, "split 1 kept while a pane shows alone");
    assert.equal(await page.locator("#view-back").isVisible(), true);

    // 3. Docs 2 beside it: split 2, and split 1 stays.
    await dropBeside(page, "w2:p2");
    await tilesAre(page, ["w1:p2", "w2:p2"], "split 2 on screen");
    await waitMarks(page, { "w1:p1": "1", "w2:p1": "1", "w1:p2": "2*", "w2:p2": "2*" }, "two splits");
    assert.deepEqual(await kept(page), [[1, ["w1:p1", "w2:p1"]], [2, ["w1:p2", "w2:p2"]]], "both kept by the browser");
    assert.equal(await page.locator(`${row("w1:p2")} .view-split-mark.split-hue-1`).count(), 1, "split 2 has the second colour");

    // 4. A row of split 1 opens split 1.
    await page.locator(row("w2:p1")).click();
    await tilesAre(page, ["w1:p1", "w2:p1"], "split 1 opened from its row");
    await page.waitForFunction(() => document.querySelector('.pane-grid.is-view .pane-grid-cell[data-pane-id="w2:p1"]')?.classList.contains("is-focused"));
    await waitMarks(page, { "w1:p1": "1*", "w2:p1": "1*", "w1:p2": "2", "w2:p2": "2" }, "split 1 filled, split 2 not");

    // 5. Docs 2 (of split 2) beside Platform 3 alone: a new split takes it,
    // and split 2, down to one tile, is gone. The new split is number 3: the
    // lowest free when it was made.
    await openAlone(page, "w1:p3");
    await dropBeside(page, "w2:p2");
    await tilesAre(page, ["w1:p3", "w2:p2"], "the new split on screen");
    await waitMarks(page, { "w1:p1": "1", "w2:p1": "1", "w1:p3": "3*", "w2:p2": "3*" }, "split 2 gone, Docs 2 in split 3");
    assert.deepEqual(await kept(page), [[1, ["w1:p1", "w2:p1"]], [3, ["w1:p3", "w2:p2"]]]);

    // 6. Another window of this browser sees the same splits, and follows a
    // split closed here without a reload.
    const other = await context.newPage();
    other.on("pageerror", (error) => errors.push(error.message));
    await other.goto(`${url}/?pane=${encodeURIComponent("w1:p5")}`);
    await other.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    await waitMarks(other, { "w1:p1": "1", "w2:p1": "1", "w1:p3": "3", "w2:p2": "3" }, "the other window has the splits");
    await page.bringToFront();
    await page.locator("#view-close").click();
    await waitMarks(page, { "w1:p1": "1", "w2:p1": "1" }, "Close split view ends split 3 alone");
    await waitMarks(other, { "w1:p1": "1", "w2:p1": "1" }, "and the other window follows");
    // A split made there shows here.
    await other.bringToFront();
    await dropBeside(other, "w2:p5");
    await tilesAre(other, ["w1:p5", "w2:p5"], "a split made in the other window");
    await waitMarks(page, { "w1:p1": "1", "w2:p1": "1", "w1:p5": "2", "w2:p5": "2" }, "shows here, under the lowest free number");
    await other.close();

    // 7. A new split reuses the lowest number free, and a reload keeps them all.
    await page.bringToFront();
    await openAlone(page, "w1:p4");
    await dropBeside(page, "w2:p4");
    await waitMarks(page, { "w1:p1": "1", "w2:p1": "1", "w1:p5": "2", "w2:p5": "2", "w1:p4": "3*", "w2:p4": "3*" }, "number 3 again");
    await page.reload();
    await tilesAre(page, ["w1:p4", "w2:p4"], "a reload shows this window's split again");
    await waitMarks(page, { "w1:p1": "1", "w2:p1": "1", "w1:p5": "2", "w2:p5": "2", "w1:p4": "3*", "w2:p4": "3*" }, "and keeps the others");

    assert.deepEqual(calls, [], "Herdr was asked nothing");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Eight splits kept: a ninth is refused and said; nothing else changes.
  {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 1100 }, colorScheme: "dark" });
    await context.addInitScript(() => {
      if (localStorage.getItem("herdrbridge-view-splits")) return;
      const splits = Array.from({ length: 8 }, (_, index) => ({
        id: index + 1, tree: { dir: "right", first: `w1:p${index + 1}`, second: `w2:p${index + 1}`, ratio: 0.5 }, focus: `w1:p${index + 1}`,
      }));
      localStorage.setItem("herdrbridge-view-splits", JSON.stringify({ splits }));
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p9")}`);
    await page.locator("#terminal-xterm .xterm").waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const eight = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [[`w1:p${index + 1}`, `${index + 1}`], [`w2:p${index + 1}`, `${index + 1}`]]).flat());
    await waitMarks(page, eight, "eight splits marked");
    assert.equal(await page.locator(`${row("w1:p5")} .view-split-mark.split-hue-0`).count(), 1, "split 5 has the first colour again");
    await dropBeside(page, "w2:p9");
    await page.waitForFunction(() => /at most 8 split views/u.test(document.querySelector("#action-feedback")?.textContent ?? ""), null, { timeout: 5000 });
    assert.deepEqual(await tileIds(page), [], "no split made");
    await waitMarks(page, eight, "the eight as they were");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("View splits (several kept: new split keeps the others, marks numbered and filled on screen, a row opens its split, a pane leaves its old split, lowest number reused, reload, another window follows, ninth refused; Herdr untouched): passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
