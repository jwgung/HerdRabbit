// Browser check of the Chat / Terminal lens per cell of a split. In a Herdr
// grid (2x2) a cell's own switch shows its pane's conversation in that cell:
// the cell's terminal stays attached under it and no pty is resized, attached
// or detached for it, and the choice is the one kept per pane (a pane read as
// Chat alone opens as Chat in the grid, and the other way round). A shell's
// cell has a dimmed Chat button that says why. The composer, Stop and the key
// bar follow the pressed cell and its lens, and Mod+J and Mod+F work on it. A
// blocked pane's prompt card shows in its own Chat cell, focused or not. A
// cell under 320x220 px shows its terminal and says the chat needs more room.
// In this window's view split two Chat tiles each follow their own
// conversation. Runs against an in-process fake herdr, a real conversation
// service over Claude transcripts in a temporary folder, and a real prompt
// service; nothing reaches a real herdr.
//
// CELL_LENS_SHOTS=<folder> keeps pictures of the grid and of a two-tile view
// split, desktop, in both themes.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { claudeProjectDir } from "../src/conversation/claude.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { fakePromptHerdr } from "../test/fixtures/claude-prompt.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const CWD = "/work/cell-lens";
const SESSIONS = {
  alpha: "3c1d6c1e-8a3b-4c55-9d2e-6f7a8b9c0d11",
  beta: "3c1d6c1e-8a3b-4c55-9d2e-6f7a8b9c0d12",
  delta: "3c1d6c1e-8a3b-4c55-9d2e-6f7a8b9c0d14",
  solo: "3c1d6c1e-8a3b-4c55-9d2e-6f7a8b9c0d19",
  docs: "3c1d6c1e-8a3b-4c55-9d2e-6f7a8b9c0d21",
};
const root = await mkdtemp(join(tmpdir(), "herdrabbit-cell-lens-"));
const configDir = join(root, "claude");
const project = join(configDir, "projects", claudeProjectDir(CWD));
await mkdir(project, { recursive: true });
const transcriptOf = (name) => join(project, `${SESSIONS[name]}.jsonl`);
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const at = (n, seconds = 0) => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + n * 60_000 + seconds * 1000).toISOString();
const exchange = (name, n) => [
  { type: "user", uuid: `${name}-u${n}`, parentUuid: null, timestamp: at(n), message: { role: "user", content: `${name} prompt ${n}` } },
  { type: "assistant", timestamp: at(n, 9), message: { role: "assistant", stop_reason: "end_turn", content: [
    { type: "text", text: `${name} answer ${n}.\n\n\`\`\`js\nconsole.log(${n});\n\`\`\`` },
  ] } },
];
async function writeTranscripts() {
  for (const name of Object.keys(SESSIONS)) await writeFile(transcriptOf(name), jsonl(Array.from({ length: 12 }, (_, n) => exchange(name, n)).flat()));
}
const answerArrives = (name, text) => appendFile(transcriptOf(name), jsonl([
  { type: "user", uuid: `${name}-u99`, parentUuid: null, timestamp: at(99), message: { role: "user", content: `${name} asks again` } },
  { type: "assistant", timestamp: at(99, 4), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } },
]));

// Platform's "Split work" is alpha | beta over gamma | delta (2x2): alpha,
// beta and delta are Claude panes, gamma a shell. Beta is blocked on an
// approval. "Solo" and Docs' "Notes" are a pane each, for the pane alone and
// the view split.
const claude = (name, extra = {}) => ({ agent: "claude", cwd: CWD, agent_session: { agent: "claude", kind: "id", value: SESSIONS[name] }, agent_status: "idle", ...extra });
function world() {
  const herdr = fakePromptHerdr({
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "alpha", ...claude("alpha") },
      { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "beta", ...claude("beta", { agent_status: "blocked" }) },
      { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", label: "gamma", cwd: "/work/gamma", agent_status: "idle" },
      { pane_id: "w1:p4", tab_id: "w1:t1", workspace_id: "w1", label: "delta", ...claude("delta") },
      { pane_id: "w1:p9", tab_id: "w1:t2", workspace_id: "w1", label: "solo", ...claude("solo") },
      { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", label: "notes", ...claude("docs") },
    ],
    menus: { "w1:p2": { cursor: 0 } },
  });
  const snapshot = herdr.snapshot;
  herdr.snapshot = async () => ({
    ...(await snapshot()),
    workspaces: [{ workspace_id: "w1", label: "Platform" }, { workspace_id: "w2", label: "Docs" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Split work" }, { tab_id: "w1:t2", workspace_id: "w1", label: "Solo" },
      { tab_id: "w2:t1", workspace_id: "w2", label: "Notes" }],
  });
  const rects = { "w1:p1": [0, 0], "w1:p2": [60, 0], "w1:p3": [0, 20], "w1:p4": [60, 20] };
  herdr.paneLayout = async (paneId) => {
    const tabId = paneId.startsWith("w1:p9") ? "w1:t2" : paneId.startsWith("w2:") ? "w2:t1" : "w1:t1";
    const ids = tabId === "w1:t1" ? Object.keys(rects) : [paneId];
    return { layout: {
      area: { x: 0, y: 0, width: 120, height: 40 }, focused_pane_id: ids[0], zoomed: false, tab_id: tabId,
      panes: ids.map((id) => ({ pane_id: id, rect: tabId === "w1:t1" ? { x: rects[id][0], y: rects[id][1], width: 60, height: 20 } : { x: 0, y: 0, width: 120, height: 40 } })),
    } };
  };
  return herdr;
}

let herdr = world();
const proxy = new Proxy({}, { get: (_target, name) => (...args) => herdr[name](...args) });
const sentTexts = [];
const outer = {
  snapshot: () => proxy.snapshot(),
  readPane: (...args) => proxy.readPane(...args),
  sendKeys: (...args) => proxy.sendKeys(...args),
  paneLayout: (...args) => proxy.paneLayout(...args),
  async sendText(paneId, text, options) { sentTexts.push({ paneId, text }); return proxy.sendText(paneId, text, options); },
};

// Every pty the page attaches: its pane, the size it opened at, and each resize.
const ptys = [];
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    let exit;
    const pty = {
      options, paneId: options.args?.at(-1)?.replace(/^term_/u, "") ?? null, resizes: [], killed: false,
      exited: new Promise((resolve) => { exit = resolve; }),
      write() {}, resize(cols, rows) { this.resizes.push([cols, rows]); }, pause() {}, resume() {},
      kill() { this.killed = true; exit(); },
    };
    ptys.push(pty);
    setTimeout(() => options.onData(`\x1b[?1049hready ${pty.paneId}\r\n$ `), 10);
    return pty;
  },
});
const prompts = new PromptService({ herdr: outer, pollMs: 60_000, stepDelayMs: 5, lookMs: 20 });
const { server } = createHerdrHttpServer({
  herdr: outer,
  attachments,
  prompts,
  conversations: new ConversationService({ herdr: outer, localStore: localTranscriptStore({ configDir }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.CELL_LENS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

// The grid has taken its shape: nothing sliding, every cell where it was for a few frames.
const gridSettled = (page) => page.waitForFunction(() => {
  const nodes = [...document.querySelectorAll(".pane-grid:not([hidden]) :is(.pane-grid-board, .pane-grid-cell:not([hidden]))")];
  if (nodes.some((node) => node.getAnimations().length > 0)) return false;
  const shape = JSON.stringify(nodes.map((node) => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  const last = window.__gridShape;
  window.__gridShape = shape;
  window.__gridStill = shape === last ? (window.__gridStill ?? 0) + 1 : 0;
  return window.__gridStill >= 6;
}, null, { polling: "raf" });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  // --- a Herdr grid --------------------------------------------------------
  {
    herdr = world();
    await writeTranscripts();
    ptys.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 }, colorScheme: "dark" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const frames = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      try { frames.push(JSON.parse(payload)); } catch {}
    }));
    const cell = (paneId) => page.locator(`.pane-grid-cell[data-pane-id="${paneId}"]`);
    const lensOf = (paneId) => cell(paneId).getAttribute("data-lens");
    const panelLens = () => page.locator(".terminal-panel").getAttribute("data-lens");
    const keyBarShown = () => page.locator("#quick-keys").isVisible();
    const storedLens = () => page.evaluate(() => JSON.parse(localStorage.getItem("herdrbridge-pane-lens") ?? "{}"));

    // Solo first: alpha alone, read as Chat; then the grid.
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator('.split-session-button[data-tab-id="w1:t1"]').waitFor();
    await page.locator('.split-session-button[data-tab-id="w1:t1"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".pane-grid:not([hidden]) .pane-grid-cell .xterm").length === 4);
    await gridSettled(page);

    // The cell's look: a 36px header in the app's font with a 28px ⤢, the
    // switch before it, and cards 6px apart.
    const look = await page.evaluate(() => {
      const one = document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"]');
      const two = document.querySelector('.pane-grid-cell[data-pane-id="w1:p2"]');
      const header = one.querySelector(".pane-grid-cell-header");
      const expand = one.querySelector(".pane-grid-expand");
      const lens = one.querySelector(".pane-grid-lens");
      const a = one.getBoundingClientRect();
      const b = two.getBoundingClientRect();
      const cardGap = (b.left + parseFloat(getComputedStyle(two).borderLeftWidth)) - (a.right - parseFloat(getComputedStyle(one).borderRightWidth));
      return {
        header: header.getBoundingClientRect().height,
        font: getComputedStyle(header).fontFamily === getComputedStyle(document.body).fontFamily,
        expand: expand.getBoundingClientRect().width,
        lensBeforeExpand: lens.nextElementSibling === expand,
        cardGap,
        ring: getComputedStyle(one, "::after").borderTopWidth,
      };
    });
    assert.equal(look.header, 36, "the cell header is --control-h-md");
    assert.ok(look.font, "the cell header uses the app's font, not the terminal's");
    assert.equal(look.expand, 28);
    assert.ok(look.lensBeforeExpand, "the switch sits before ⤢");
    assert.ok(Math.abs(look.cardGap - 6) <= 1, `cards are 6px apart: ${look.cardGap}`);

    // Desktop default: every cell in Terminal, the panel's lens is the focused cell's.
    for (const id of ["w1:p1", "w1:p2", "w1:p3", "w1:p4"]) assert.equal(await lensOf(id), "terminal");
    assert.equal(await panelLens(), "terminal");
    assert.equal(await keyBarShown(), true);

    // gamma is a shell: no chat, and its button says why.
    const gammaChat = cell("w1:p3").locator(".pane-grid-lens-chat");
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"] .pane-grid-lens-chat')?.getAttribute("aria-disabled") === "false");
    assert.equal(await gammaChat.getAttribute("aria-disabled"), "true");
    assert.match(await gammaChat.getAttribute("title"), /^Chat is only for /u);
    await gammaChat.click({ force: true });
    assert.equal(await lensOf("w1:p3"), "terminal", "a dimmed Chat does nothing");

    // alpha to Chat: its conversation in its cell, its terminal kept and its pty untouched.
    await page.waitForTimeout(800); // the cells have sized their panes
    const resizesBefore = ptys.map((pty) => pty.resizes.length).join();
    const spawned = ptys.length;
    const framesBefore = frames.length;
    await cell("w1:p1").locator(".pane-grid-lens-chat").click();
    await cell("w1:p1").locator('.chat-pane[data-pane-id="w1:p1"] .chat-turn-agent').first().waitFor({ state: "visible" });
    assert.equal(await lensOf("w1:p1"), "chat");
    assert.ok(await page.locator('.pane-grid-cell[data-pane-id="w1:p1"] .chat-pane').evaluate((node) => node.textContent.includes("alpha answer 11")));
    assert.equal(await cell("w1:p1").locator(".xterm").count(), 1, "the cell's terminal stays");
    assert.equal(await cell("w1:p1").locator(".pane-grid-terminal").evaluate((node) => getComputedStyle(node).visibility), "hidden");
    assert.deepEqual(await storedLens(), { "w1:p1": "chat" });
    await page.waitForTimeout(800);
    assert.equal(ptys.map((pty) => pty.resizes.length).join(), resizesBefore, "no pty was resized");
    assert.equal(ptys.length, spawned, "no pane attached again");
    assert.deepEqual(frames.slice(framesBefore).filter((frame) => ["attach", "detach", "resize"].includes(frame.type)), [],
      "no attach, detach or resize went out");
    // The pressed cell is focused: the panel takes its lens (Stop or Send for the chat).
    // The key bar stays in a grid, so selecting a cell resizes nothing; its keys go to the cell's pane.
    assert.equal(await cell("w1:p1").evaluate((node) => node.classList.contains("is-focused")), true);
    assert.equal(await panelLens(), "chat");
    assert.equal(await keyBarShown(), true, "a Chat cell keeps the key bar in a grid");
    for (const id of ["w1:p2", "w1:p3", "w1:p4"]) assert.equal(await cell(id).locator(".chat-pane").count(), 0, `${id} shows no chat`);

    // The composer follows the pressed cell: alpha (chat) then gamma (terminal).
    await page.locator("#terminal-input").fill("to alpha");
    await page.locator(".send-button").click();
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    assert.deepEqual(sentTexts.at(-1), { paneId: "w1:p1", text: "to alpha" });
    await cell("w1:p3").locator(".pane-grid-label").click();
    await page.waitForFunction(() => document.querySelector(".terminal-panel").dataset.lens === "terminal");
    assert.equal(await keyBarShown(), true, "a Terminal cell shows the key bar too");
    await page.locator("#terminal-input").fill("to gamma");
    await page.locator(".send-button").click();
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    assert.deepEqual(sentTexts.at(-1), { paneId: "w1:p3", text: "to gamma" });

    // Mod+F over a Terminal cell finds in its terminal, over a Chat cell in its conversation.
    await cell("w1:p3").locator(".pane-grid-terminal").click();
    await page.keyboard.press("Control+f");
    await page.locator("#terminal-find").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#terminal-find").waitFor({ state: "hidden" });
    await cell("w1:p1").locator(".pane-grid-label").click();
    await page.waitForFunction(() => document.querySelector(".terminal-panel").dataset.lens === "chat");
    await page.locator("body").press("Control+f");
    await page.locator("#chat-find").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    // Mod+J switches the focused cell: delta to Chat. (Inside a cell's
    // terminal Ctrl+J stays the program's, as in the pane alone.)
    await cell("w1:p4").locator(".pane-grid-label").click();
    await page.waitForFunction(() => document.querySelector(".terminal-panel").dataset.lens === "terminal");
    await page.locator("#terminal-input").focus();
    await page.keyboard.press("Control+j");
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p4"]').dataset.lens === "chat");
    assert.equal(await panelLens(), "chat");
    await cell("w1:p4").locator(".chat-turn-agent").first().waitFor({ state: "visible" });

    // Two Chat cells each follow their own conversation.
    await answerArrives("alpha", "Alpha heard the news.");
    await answerArrives("delta", "Delta heard the news.");
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"] .chat-pane')?.textContent.includes("Alpha heard the news."));
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p4"] .chat-pane')?.textContent.includes("Delta heard the news."));

    // beta is blocked: its card shows in its own Chat cell, focused or not.
    assert.equal(await cell("w1:p2").locator(".prompt-card").count(), 0, "a Terminal cell shows no card");
    await cell("w1:p2").locator(".pane-grid-lens-chat").click();
    await cell("w1:p2").locator(".prompt-card").waitFor({ state: "visible" });
    assert.equal(await page.locator('.pane-grid-cell[data-pane-id="w1:p2"] #prompt-dock').count(), 1, "the focused cell has the composer's card");
    await cell("w1:p1").locator(".pane-grid-label").click();
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"] #prompt-dock'));
    await cell("w1:p2").locator(".prompt-card").waitFor({ state: "visible" });
    assert.equal(await page.locator(".prompt-card").count(), 1, "one card, in beta's cell");
    const card = await cell("w1:p2").locator(".prompt-card").boundingBox();
    const betaBox = await cell("w1:p2").boundingBox();
    assert.ok(card.y + card.height <= betaBox.y + betaBox.height && card.y > betaBox.y + betaBox.height / 3, "the card sits at the bottom of the cell");

    if (shots) {
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots, `grid-desktop-${theme}.png`) });
      }
      await page.evaluate(() => { delete document.documentElement.dataset.theme; });
    }

    // A cell under 320x220 px cannot show its chat: the terminal shows and the cell says why.
    await page.setViewportSize({ width: 1000, height: 520 });
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"]').dataset.lens === "terminal");
    assert.equal(await cell("w1:p1").locator(".pane-grid-hint").isVisible(), true);
    assert.equal(await cell("w1:p1").locator(".pane-grid-hint").textContent(), "Too small for the chat. Open alone");
    assert.equal(await cell("w1:p1").locator(".pane-grid-lens-chat").getAttribute("aria-disabled"), "true");
    assert.equal(await cell("w1:p1").locator(".pane-grid-lens-chat").getAttribute("title"), "Too small for the chat. Open alone");
    assert.equal(await panelLens(), "terminal", "the focused cell shows its terminal, so the panel does");
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p1"]').dataset.lens === "chat");
    assert.equal(await cell("w1:p1").locator(".pane-grid-hint").isVisible(), false);

    // The pane alone keeps the lens it has in the grid, and the other way round.
    await cell("w1:p1").locator(".pane-grid-expand").click();
    await page.waitForFunction(() => document.querySelector(".pane-grid:not([hidden])") === null && document.querySelector(".terminal-stage").dataset.lens === "chat");
    await page.locator('#chat-host .chat-pane[data-pane-id="w1:p1"]').waitFor({ state: "visible" });
    assert.equal(await page.locator("#lens-switch").isVisible(), true, "the pane alone has the header's switch again");
    await page.locator("#lens-terminal").click();
    await page.locator("#grid-back").click();
    await page.waitForFunction(() => document.querySelectorAll(".pane-grid:not([hidden]) .pane-grid-cell").length === 4);
    assert.equal(await lensOf("w1:p1"), "terminal");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // --- this window's view split ---------------------------------------------
  {
    herdr = world();
    await writeTranscripts();
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 }, colorScheme: "dark" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (sessionStorage.getItem("herdrbridge-view-split")) return;
      sessionStorage.setItem("herdrbridge-view-split", JSON.stringify({ tree: { dir: "right", first: "w1:p9", second: "w2:p1", ratio: 0.5 }, shown: true, focus: "w1:p9" }));
      localStorage.setItem("herdrbridge-pane-lens", JSON.stringify({ "w1:p9": "chat" }));
    });
    const tile = (paneId) => page.locator(`.pane-grid.is-view .pane-grid-cell[data-pane-id="${paneId}"]`);
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p9")}`);
    await tile("w1:p9").locator(".chat-turn-agent").first().waitFor({ state: "visible" });
    await tile("w2:p1").locator(".pane-grid-lens-chat[aria-disabled='false']").click();
    await tile("w2:p1").locator(".chat-turn-agent").first().waitFor({ state: "visible" });
    assert.equal(await page.locator(".pane-grid.is-view .chat-pane").count(), 2);
    await answerArrives("solo", "Solo heard the news.");
    await answerArrives("docs", "Docs heard the news.");
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w1:p9"] .chat-pane')?.textContent.includes("Solo heard the news."));
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w2:p1"] .chat-pane')?.textContent.includes("Docs heard the news."));
    // the left tile to Terminal, as the mockup shows
    await tile("w2:p1").locator(".pane-grid-lens-terminal").click();
    await page.waitForFunction(() => document.querySelector('.pane-grid-cell[data-pane-id="w2:p1"]').dataset.lens === "terminal");
    await tile("w1:p9").locator(".pane-grid-label").click();
    await page.waitForFunction(() => document.querySelector(".terminal-panel").dataset.lens === "chat");
    if (shots) {
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots, `view-split-2-${theme}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("cell lens check passed");
} finally {
  await browser.close();
  server.close();
  await rm(root, { recursive: true, force: true });
}
