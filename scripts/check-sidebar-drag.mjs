// Browser check of dragging in the sidebar, against an in-process fake herdr
// that keeps its own order: a session reordered within its project, a session
// with one pane carried to another project (and one with two panes that is not), a project reordered, no drop on
// another machine, a refused move put back, and on a phone a long press that
// drags while a swipe still scrolls and a short tap still selects.
// DRAG_SCREENSHOTS=<folder> keeps pictures taken mid-drag.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HerdrCommandError } from "../src/herdr-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const local = { server_id: "local", herdr_session_id: "hs_x" };
const laptop = { server_id: "laptop", herdr_session_id: "laptop!hs_x" };

function freshState() {
  const tab = (tab_id, workspace_id, label, scope = local) => ({ tab_id, workspace_id, label, ...scope });
  const pane = (pane_id, tab_id, cwd, scope = local) => ({ pane_id, tab_id, workspace_id: tab_id.split(":")[0], cwd, ...scope });
  return {
    workspaces: [
      { workspace_id: "w1", label: "Platform", ...local },
      { workspace_id: "w2", label: "Docs", ...local },
      { workspace_id: "w3", label: "Tools", ...local },
      { workspace_id: "laptop!w1", label: "Laptop work", ...laptop },
    ],
    tabs: [
      tab("w1:t1", "w1", "Release"), tab("w1:t2", "w1", "Infra"), tab("w1:t3", "w1", "Web"),
      tab("w2:t1", "w2", "Guide"), tab("w3:t1", "w3", "Scripts"),
      tab("laptop!w1:t1", "laptop!w1", "Notes", laptop),
    ],
    panes: [
      pane("w1:p1", "w1:t1", "/work/release"), pane("w1:p2", "w1:t2", "/work/infra"), pane("w1:p5", "w1:t2", "/work/infra/ops"),
      pane("w1:p3", "w1:t3", "/work/web"), pane("w2:p1", "w2:t1", "/work/docs"), pane("w3:p1", "w3:t1", "/work/tools"),
      pane("laptop!w1:p1", "laptop!w1:t1", "/home/notes", laptop),
    ],
  };
}

let herdrState = freshState();
let refuseNext = false;
const calls = [];
// Herdr's own ordering: a gap counts the moving one too.
function place(list, item, peers, gap) {
  const from = peers.indexOf(item);
  const others = peers.filter((peer) => peer !== item);
  const at = from >= 0 && gap > from ? gap - 1 : gap;
  const rest = list.filter((entry) => entry !== item);
  const anchor = others[at];
  rest.splice(anchor ? rest.indexOf(anchor) : rest.indexOf(others.at(-1)) + 1, 0, item);
  return rest;
}
let nextNumber = 10;
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
    herdrState.tabs = place(herdrState.tabs, tab, herdrState.tabs.filter((item) => item.workspace_id === tab.workspace_id), insertIndex);
  },
  async moveWorkspace(workspaceId, insertIndex) {
    calls.push(["moveWorkspace", workspaceId, insertIndex]);
    const workspace = herdrState.workspaces.find((item) => item.workspace_id === workspaceId);
    herdrState.workspaces = place(herdrState.workspaces, workspace,
      herdrState.workspaces.filter((item) => item.server_id === workspace.server_id), insertIndex);
  },
  async moveTabToWorkspace(tabId, workspaceId, insertIndex) {
    calls.push(["moveTabToWorkspace", tabId, workspaceId, insertIndex]);
    if (refuseNext) {
      refuseNext = false;
      throw new HerdrCommandError("Herdr could not move that session", { code: "pane_move_failed" });
    }
    const tab = herdrState.tabs.find((item) => item.tab_id === tabId);
    const newTab = { ...tab, tab_id: `${workspaceId}:t${nextNumber++}`, workspace_id: workspaceId };
    const moves = [];
    herdrState.panes = herdrState.panes.map((pane) => {
      if (pane.tab_id !== tabId) return pane;
      const to = `${workspaceId}:p${nextNumber++}`;
      moves.push({ from: pane.pane_id, to });
      return { ...pane, pane_id: to, tab_id: newTab.tab_id, workspace_id: workspaceId };
    });
    const tabs = herdrState.tabs.filter((item) => item !== tab);
    const peers = tabs.filter((item) => item.workspace_id === workspaceId);
    herdrState.tabs = place([...tabs, newTab], newTab, [...peers, newTab], peers.length);
    herdrState.tabs = place(herdrState.tabs, newTab, [...peers, newTab], insertIndex);
    return { tab_id: newTab.tab_id, panes: moves, reordered: true };
  },
};

const { server } = createHerdrHttpServer({ herdr, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.DRAG_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });

// The sidebar as it reads now: each project's sessions, by their first pane.
const sidebar = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".workspace-group")].map((group) => [
  group.querySelector(".workspace-heading h3")?.textContent,
  [...group.querySelectorAll(".tab-group")].map((tab) => tab.querySelector(".tab-label")?.textContent ?? tab.querySelector(".pane-title")?.textContent),
])));
const projects = (page) => page.evaluate(() => [...document.querySelectorAll('.server-group:has([data-server-id="local"]) .workspace-group h3')].map((h) => h.textContent));
const box = async (page, selector) => {
  const found = await page.locator(selector).first().boundingBox();
  assert.ok(found, `${selector} is on screen`);
  return found;
};
const tabRow = (paneId) => `.tab-group:has(.pane-button[data-pane-id="${paneId}"])`;
const group = (label) => `.workspace-group:has(> .workspace-heading h3:text-is("${label}"))`;

async function mouseDrag(page, from, to, { shot } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
  }
  await page.waitForTimeout(80);
  const during = await page.evaluate(() => ({
    line: (() => { const line = document.querySelector(".sidebar-drop-line"); return line && !line.hidden ? line.getBoundingClientRect().top : null; })(),
    highlighted: [...document.querySelectorAll(".workspace-group.is-drop-target h3")].map((h) => h.textContent),
    ghost: Boolean(document.querySelector(".sidebar-drag-ghost")),
  }));
  if (shot) await page.screenshot({ path: shot });
  await page.mouse.up();
  return during;
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  // Desktop, dark.
  {
    herdrState = freshState();
    calls.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p5")}`);
    await page.locator(".pane-button").first().waitFor({ state: "visible" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p5"]')?.getAttribute("aria-pressed") === "true");
    const callsNow = () => structuredClone(calls);

    // 1. Release below Web, within Platform.
    // The move is answered without a snapshot here: the page reads one itself
    // once the move is over.
    let snapshotsAfterMove = 0;
    let moveAnswered = false;
    await page.route("**/api/tabs/*/move", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      moveAnswered = true;
      await route.fulfill({ response, json: { ...body, snapshot: null } });
    });
    page.on("request", (request) => { if (moveAnswered && new URL(request.url()).pathname === "/api/snapshot") snapshotsAfterMove += 1; });
    let source = await box(page, tabRow("w1:p1"));
    let target = await box(page, tabRow("w1:p3"));
    let during = await mouseDrag(page, { x: source.x + 60, y: source.y + 12 }, { x: target.x + 60, y: target.y + target.height - 4 },
      { shot: shots && join(shots, "desktop-dark-dragging.png") });
    assert.ok(during.ghost, "the row follows the pointer");
    assert.ok(during.line !== null, "a line shows where it lands");
    assert.deepEqual(during.highlighted, [], "its own project is not highlighted");
    await page.waitForFunction(() => document.querySelector('.workspace-group h3')?.textContent && !document.querySelector(".is-drag-source"));
    await page.waitForTimeout(300);
    assert.deepEqual(callsNow(), [["moveTab", "w1:t1", 3]]);
    assert.ok(snapshotsAfterMove > 0, "a move answered without a snapshot is followed by one read");
    await page.unroute("**/api/tabs/*/move");
    assert.deepEqual((await sidebar(page)).Platform, ["Infra", "Web", "Release"]);
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p5"]').getAttribute("aria-pressed"), "true",
      "the drag's trailing click did not select the dragged row");

    // 2. Infra has two panes: over Docs it is no drop target, nothing is asked
    // and it stays where it was. Within its own project it still reorders.
    const callsBeforeSplit = calls.length;
    source = await box(page, tabRow("w1:p2"));
    target = await box(page, tabRow("w2:p1"));
    during = await mouseDrag(page, { x: source.x + 60, y: source.y + 20 }, { x: target.x + 60, y: target.y + 4 });
    assert.deepEqual(during.highlighted, [], "a split session does not light up another project");
    assert.equal(during.line, null, "no line over another project");
    await page.waitForTimeout(300);
    assert.equal(calls.length, callsBeforeSplit, "nothing was asked of the server");
    assert.deepEqual((await sidebar(page)).Platform, ["Infra", "Web", "Release"]);
    assert.equal(await page.locator('.pane-button[data-pane-id="w1:p5"]').getAttribute("aria-pressed"), "true", "the view stays put");

    // 2b. Release (one pane, the one on screen) onto Docs, above Guide.
    await page.locator('.pane-button[data-pane-id="w1:p1"]').click();
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p1"]')?.getAttribute("aria-pressed") === "true");
    const unsentDraft = "half-written message before the move";
    await page.locator("#terminal-input").fill(unsentDraft);
    source = await box(page, tabRow("w1:p1"));
    target = await box(page, tabRow("w2:p1"));
    during = await mouseDrag(page, { x: source.x + 60, y: source.y + 12 }, { x: target.x + 60, y: target.y + 4 });
    assert.deepEqual(during.highlighted, ["Docs"], "the project it would move to is highlighted");
    await page.waitForFunction(() => document.querySelector('.pane-button[aria-pressed="true"]')?.dataset.paneId?.startsWith("w2:"));
    assert.deepEqual(callsNow().at(-1), ["moveTabToWorkspace", "w1:t1", "w2", 0]);
    const afterCross = await sidebar(page);
    assert.deepEqual(afterCross.Platform, ["Infra", "Web"]);
    assert.deepEqual(afterCross.Docs, ["Release", "Guide"]);
    const followed = await page.locator('.pane-button[aria-pressed="true"]').getAttribute("data-pane-id");
    const moved = herdrState.panes.find((pane) => pane.cwd === "/work/release");
    assert.equal(followed, moved.pane_id, "the pane on screen is followed to its new id");
    assert.equal(await page.locator("#terminal-input").inputValue(), unsentDraft, "the unsent text stays in the box");
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#terminal-input").inputValue(), unsentDraft, "and stays after the view settles");
    const storedDrafts = await page.evaluate(() => localStorage.getItem("herdrbridge-composer-drafts") || "");
    assert.ok(!storedDrafts.includes('"w1:p1"'), "no draft is left under the old id");

    // 3. Tools above Platform.
    source = await box(page, `${group("Tools")} > .workspace-heading h3`);
    target = await box(page, group("Platform"));
    await mouseDrag(page, { x: source.x + 20, y: source.y + source.height / 2 }, { x: source.x + 20, y: target.y + 3 });
    await page.waitForTimeout(400);
    assert.deepEqual(callsNow().at(-1), ["moveWorkspace", "w3", 0]);
    assert.deepEqual(await projects(page), ["Tools", "Platform", "Docs"]);

    // 4. Another machine's project is no place to drop.
    const before = calls.length;
    source = await box(page, tabRow("w1:p3"));
    target = await box(page, tabRow("laptop!w1:p1"));
    during = await mouseDrag(page, { x: source.x + 60, y: source.y + 12 }, { x: target.x + 60, y: target.y + 4 });
    assert.deepEqual(during.highlighted, []);
    assert.equal(during.line, null, "no line over another machine");
    await page.waitForTimeout(300);
    assert.equal(calls.length, before, "nothing was asked of the server");

    // 5. A refused move goes back where it was and says why.
    refuseNext = true;
    source = await box(page, tabRow("w1:p3"));
    target = await box(page, `${group("Tools")} ${tabRow("w3:p1")}`);
    await mouseDrag(page, { x: source.x + 60, y: source.y + 12 }, { x: target.x + 60, y: target.y + target.height - 4 });
    await page.waitForFunction(() => document.querySelector("#action-feedback, [data-error='true']")?.textContent.includes("could not move"));
    assert.deepEqual(callsNow().at(-1), ["moveTabToWorkspace", "w1:t3", "w3", 1]);
    assert.deepEqual((await sidebar(page)).Platform, ["Infra", "Web"]);
    assert.deepEqual((await sidebar(page)).Tools, ["Scripts"]);

    // 6. A plain click still selects.
    await page.locator('.pane-button[data-pane-id="w1:p3"]').click();
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p3"]')?.getAttribute("aria-pressed") === "true");
    // The ⋯ menu still opens from a row without starting a drag.
    await page.locator(`${tabRow("w1:p3")} .session-action-menu > summary`).click();
    assert.ok(await page.locator(`${tabRow("w1:p3")} .sidebar-action-item`).first().isVisible());
    assert.equal(await page.locator(".sidebar-drag-ghost").count(), 0);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Phone, light: a long press drags, a swipe scrolls, a tap selects.
  {
    herdrState = freshState();
    calls.length = 0;
    const context = await browser.newContext({
      serviceWorkers: "block", hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, colorScheme: "light",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w3:p1")}`);
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    const openSidebar = async () => {
      await page.locator("#mobile-sidebar-open").click();
      await page.locator(".pane-button").first().waitFor({ state: "visible" });
      await page.waitForTimeout(600);
    };
    await openSidebar();
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });

    // A swipe that starts on a row is a scroll, not a drag.
    let source = await box(page, tabRow("w1:p1"));
    await touch("touchStart", source.x + 60, source.y + 12);
    for (let step = 1; step <= 8; step += 1) await touch("touchMove", source.x + 60, source.y + 12 - step * 10);
    await touch("touchEnd");
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".sidebar-drag-ghost").count(), 0);
    assert.deepEqual(calls, [], "a swipe moves nothing");

    // A long press picks Release up; it goes below Web.
    source = await box(page, tabRow("w1:p1"));
    const target = await box(page, tabRow("w1:p3"));
    await touch("touchStart", source.x + 60, source.y + 12);
    await page.waitForTimeout(550);
    assert.equal(await page.locator(".sidebar-drag-ghost").count(), 1, "held long enough, the row is picked up");
    const steps = 10;
    const toY = target.y + target.height - 4;
    for (let step = 1; step <= steps; step += 1) {
      await touch("touchMove", source.x + 60, source.y + 12 + ((toY - source.y - 12) * step) / steps);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(80);
    if (shots) await page.screenshot({ path: join(shots, "phone-light-long-press-dragging.png") });
    assert.ok(await page.evaluate(() => !document.querySelector(".sidebar-drop-line")?.hidden), "a line shows where it lands");
    await touch("touchEnd");
    await page.waitForTimeout(500);
    assert.deepEqual(calls, [["moveTab", "w1:t1", 3]]);
    assert.deepEqual((await sidebar(page)).Platform, ["Infra", "Web", "Release"]);
    assert.equal(await page.locator('.pane-button[data-pane-id="w3:p1"]').getAttribute("aria-pressed"), "true",
      "lifting the finger after a drag selects nothing");

    // A short tap still selects, and closes the phone's sidebar as before.
    await page.locator('.pane-button[data-pane-id="w1:p3"]').tap();
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p3"]')?.getAttribute("aria-pressed") === "true");
    assert.equal(calls.length, 1);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Sidebar drag (reorder, move to another project, project order, no other machine, refusal put back; phone long press, swipe, tap): passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
