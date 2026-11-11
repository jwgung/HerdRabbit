// Browser check of a pane waiting on its agent inside a split. Claude has a
// plan to approve in one tile of this window's view split while another tile
// is selected. Wherever the tile shows its terminal (chosen, or too small for
// the chat), a banner under its header says Claude is asking, focused or not;
// the cell's "too small" hint gives way to it. The banner's Open plan, and the
// card's, open the plan's Markdown in the viewer from the pane's machine. The
// banner's Answer shows the card in the tile's chat when the tile has room,
// else opens the pane alone with its card and Back to split view. Runs
// against an in-process fake herdr, a real prompt service reading a plan
// approval as Claude Code 2.1 draws it, and a real conversation service over a
// transcript in a temporary folder; nothing reaches a real herdr.
//
// SPLIT_WAITING_SHOTS=<folder> keeps pictures of the banner and the card.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const CWD = "/work/calc";
const SESSION = "5b2e9c1a-1d3f-4a55-8b6c-7d8e9f0a1b2c";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-split-waiting-"));
// The machine's home: the plan's file is under it, as Claude writes it.
const home = join(root, "home");
await mkdir(join(home, ".claude", "plans"), { recursive: true });
await writeFile(join(home, ".claude", "plans", "tidy-plan.md"), "# Tidy plan\n\n- Add `subtract(a, b)` to calc.py\n- Check it with a one-line assert\n");
const configDir = join(root, "claude");
const project = join(configDir, "projects", claudeProjectDir(CWD));
await mkdir(project, { recursive: true });
await writeFile(join(project, `${SESSION}.jsonl`), `${[
  { type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-11-11T06:00:00.000Z", message: { role: "user", content: "Plan a subtract function." } },
  { type: "assistant", timestamp: "2026-11-11T06:00:09.000Z", message: { role: "assistant", content: [
    { type: "tool_use", id: "w1", name: "Write", input: { file_path: "~/.claude/plans/tidy-plan.md", content: "# Tidy plan" } },
  ] } },
].map((entry) => JSON.stringify(entry)).join("\n")}\n`);

// The approval as Claude Code 2.1.322 draws it, its plan's path in the hint.
const PLAN_SCREEN = `
● Updated plan
  ⎿  /plan to preview
────────────────────────────────────────────────────────────────
 Ready to code?
 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 - Add subtract(a, b) to calc.py
 - Check it with a one-line assert
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
────────────────────────────────────────────────────────────────
 Claude has written up a plan and is ready to execute. Would you like to proceed?
 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. Tell Claude what to change
      shift+tab to approve with this feedback
 ctrl+g to edit in Vim · ~/.claude/plans/tidy-plan.md
`;

const herdr = fakePromptHerdr({
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "planner", agent: "claude", cwd: CWD,
      agent_session: { agent: "claude", kind: "id", value: SESSION }, agent_status: "blocked" },
    { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", label: "notes", cwd: "/work/notes", agent_status: "idle" },
  ],
  outputs: { "w1:p1": PLAN_SCREEN, "w2:p1": "$ " },
});
const snapshot = herdr.snapshot;
herdr.snapshot = async () => ({
  ...(await snapshot()),
  workspaces: [{ workspace_id: "w1", label: "Calc" }, { workspace_id: "w2", label: "Docs" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Subtract" }, { tab_id: "w2:t1", workspace_id: "w2", label: "Notes" }],
});
herdr.paneLayout = async (paneId) => ({ layout: {
  area: { x: 0, y: 0, width: 120, height: 40 }, focused_pane_id: paneId, zoomed: false, tab_id: paneId.startsWith("w1:") ? "w1:t1" : "w2:t1",
  panes: [{ pane_id: paneId, rect: { x: 0, y: 0, width: 120, height: 40 } }],
} });

const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    let exit;
    const paneId = options.args?.at(-1)?.replace(/^term_/u, "") ?? "";
    setTimeout(() => options.onData(`\x1b[?1049h${(paneId === "w1:p1" ? PLAN_SCREEN : "$ ").replaceAll("\n", "\r\n")}`), 10);
    return { options, exited: new Promise((resolve) => { exit = resolve; }), write() {}, resize() {}, pause() {}, resume() {}, kill() { exit(); } };
  },
});
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  prompts: new PromptService({ herdr, pollMs: 1_000, stepDelayMs: 5, lookMs: 20 }),
  conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }),
  homeDirectory: home,
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.SPLIT_WAITING_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const PLAN = "w1:p1";
const NOTES = "w2:p1";
const cell = (page, paneId) => page.locator(`.pane-grid.is-view .pane-grid-cell[data-pane-id="${paneId}"]`);
const banner = (page) => cell(page, PLAN).locator(".pane-grid-banner .prompt-banner");
const cellCard = (page) => cell(page, PLAN).locator(".pane-grid-dock .prompt-card");

// The viewer opens on the plan's Markdown, drawn as Markdown, and closes.
async function viewerShowsPlan(page) {
  await page.locator("#viewer-dialog[open]").waitFor();
  assert.equal(await page.locator("#viewer-title").textContent(), "tidy-plan.md");
  // a Markdown file opens as a page of its own, in the viewer's frame
  await page.frameLocator("#viewer-dialog iframe").locator("h1", { hasText: "Tidy plan" }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#viewer-dialog[open]").waitFor({ state: "detached" });
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  // Service workers stay allowed: Playwright's "block" reads
  // navigator.serviceWorker in every frame, which the viewer's sandboxed page refuses.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: "light" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The planner beside the notes, the notes selected.
  await page.addInitScript(([plan, notes]) => {
    // the page only: not the viewer's sandboxed frame, which has no storage
    if (window !== window.top || sessionStorage.getItem("herdrbridge-view-split")) return;
    sessionStorage.setItem("herdrbridge-view-split", JSON.stringify({
      tree: { dir: "right", first: plan, second: notes, ratio: 0.5 }, shown: true, focus: notes }));
  }, [PLAN, NOTES]);
  await page.goto(`${url}/?pane=${encodeURIComponent(NOTES)}`);
  await cell(page, PLAN).waitFor();
  assert.equal(await cell(page, PLAN).getAttribute("data-lens"), "terminal");

  // 1. A roomy tile showing its terminal, not selected: the banner, with Open plan.
  await banner(page).waitFor();
  assert.match(await banner(page).textContent(), /Claude is asking: Ready to code\?/u);
  if (shots) await page.screenshot({ path: join(shots, "banner-roomy.png") });
  await banner(page).locator(".prompt-banner-plan").click();
  await viewerShowsPlan(page);

  // 2. Answer: the tile has room, so its chat shows, the card under it, with Open plan.
  await banner(page).locator(".prompt-banner-open").click();
  await page.waitForFunction((id) => document.querySelector(`.pane-grid.is-view .pane-grid-cell[data-pane-id="${id}"]`)?.dataset.lens === "chat", PLAN);
  await cellCard(page).waitFor();
  assert.equal(await banner(page).count(), 0, "no banner over a chat");
  if (shots) await page.screenshot({ path: join(shots, "card-in-tile.png") });
  await cellCard(page).locator(".prompt-card-plan").click();
  await viewerShowsPlan(page);
  assert.equal(await page.locator(".pane-grid.is-view").isVisible(), true, "still the view split");

  // 3. Back to its terminal, the notes selected again, and the window too
  // small for a chat in the tile: the banner, over the cell's hint.
  await cell(page, PLAN).locator(".pane-grid-lens-terminal").click();
  await cell(page, NOTES).locator(".pane-grid-cell-header").click();
  await page.setViewportSize({ width: 860, height: 560 });
  await banner(page).waitFor();
  assert.equal(await cell(page, PLAN).locator(".pane-grid-hint").isVisible(), false, "the banner stands in for the hint");
  if (shots) await page.screenshot({ path: join(shots, "banner-small.png") });

  // 4. Selected, the small tile still shows it (the selected pane's own dock).
  await cell(page, PLAN).locator(".pane-grid-cell-header").click();
  await page.waitForFunction((id) => document.querySelector(`.pane-grid.is-view .pane-grid-cell[data-pane-id="${id}"]`)?.classList.contains("is-focused"), PLAN);
  await cell(page, PLAN).locator(".pane-grid-banner > #prompt-dock .prompt-banner").waitFor();

  // 5. Answer with no room: the pane alone, its card in the chat, Back to split view.
  await cell(page, PLAN).locator(".prompt-banner-open").click();
  await page.locator("#view-back").waitFor();
  assert.equal(await page.locator(".pane-grid.is-view").isVisible(), false, "the pane alone");
  await page.locator("#prompt-dock .prompt-card .prompt-card-plan").waitFor();
  await page.locator("#view-back").click();
  await cell(page, PLAN).waitFor();

  assert.deepEqual(errors, []);
  await context.close();
  console.log("split waiting check passed");
} finally {
  await browser.close();
  server.close();
  await rm(root, { recursive: true, force: true });
}
