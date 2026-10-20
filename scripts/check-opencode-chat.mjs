// Browser check of the Chat lens for an OpenCode pane (desktop and phone): the
// session herdr's OpenCode plugin reports is read from a temporary
// opencode.db with made-up rows. Prompts read as bubbles, the answer as
// Markdown, OpenCode's tool calls fold under "Worked for" with their verbs, a
// todowrite call reads as a to-do list, a command's whole output loads on
// request, the working row names OpenCode (and the composer offers Stop:
// check-opencode-cards.mjs presses it), and rows written meanwhile land in
// the open chat. Runs against an
// in-process fake herdr; nothing reaches a real herdr or a real OpenCode.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { fakePromptHerdr } from "../test/fixtures/claude-prompt.mjs";
import { opencodeDb } from "../test/fixtures/opencode-db.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "ses_0001AAAAAAAAAAAAAAAAAAAAAA";
const CWD = "/work/opencode-chat";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-opencode-chat-"));
const dbPath = join(root, "opencode.db");

// A conversation as OpenCode stores it: 30 prompts, each answered after a
// step with reasoning, a command and (in the last) a to-do list and an edit.
function fill(fixture) {
  fixture.session(SESSION, { directory: CWD });
  for (let n = 0; n < 30; n++) {
    const last = n === 29;
    fixture.message(SESSION, { role: "user", agent: "build" }, [{ type: "text", text: `prompt ${n}` }]);
    fixture.message(SESSION, { role: "assistant", modelID: "model-test", providerID: "test", mode: "build" }, [
      { type: "step-start" },
      { type: "reasoning", text: `Thinking about step ${n}` },
      { type: "tool", tool: "bash", callID: `call_${n}`, state: {
        status: "completed", input: { command: `git status --short step-${n}`, description: "Show status" },
        output: last ? `${"M file\n".repeat(900)}end of output` : `M step-${n}.txt`, title: "git status",
      } },
      ...(last ? [
        { type: "tool", tool: "todowrite", callID: "call_todo", state: { status: "completed", input: { todos: [
          { content: "Read the parser", status: "completed", priority: "high", id: "1" },
          { content: "Fix the off-by-one", status: "in_progress", priority: "high", id: "2" },
          { content: "Add a test", status: "pending", priority: "medium", id: "3" },
        ] }, output: "[]" } },
        { type: "tool", tool: "edit", callID: "call_edit", state: { status: "completed",
          input: { filePath: `${CWD}/src/parse.js`, oldString: "i <= n", newString: "i < n" }, output: "Edit applied successfully." } },
      ] : []),
      { type: "step-finish", reason: "tool-calls" },
    ]);
    fixture.message(SESSION, { role: "assistant", modelID: "model-test", providerID: "test", mode: "build" }, [
      { type: "step-start" },
      { type: "text", text: `Answer ${n} with **bold** and \`code\`.` },
      { type: "step-finish", reason: "stop" },
    ]);
  }
}

const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    let exit;
    const pty = { options, exited: new Promise((resolve) => { exit = resolve; }), write() {}, resize() {}, pause() {}, resume() {}, kill() { exit(); } };
    setTimeout(() => options.onData("\x1b[?1049hready terminal\r\n$ "), 10);
    return pty;
  },
});

function world() {
  const template = { workspaces: [{ workspace_id: "w1", label: "Platform" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Release" }] };
  const herdr = fakePromptHerdr({
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "OpenCode", agent: "opencode", cwd: CWD,
        agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: SESSION }, agent_status: "working" },
    ],
  });
  const snapshot = herdr.snapshot;
  herdr.snapshot = async () => ({ ...(await snapshot()), ...structuredClone(template) });
  return herdr;
}

let herdr = world();
const proxy = new Proxy({}, { get: (_target, name) => (...args) => herdr[name](...args) });
const outer = {
  snapshot: () => proxy.snapshot(),
  readPane: (...args) => proxy.readPane(...args),
  sendKeys: (...args) => proxy.sendKeys(...args),
  sendText: (...args) => proxy.sendText(...args),
};
const prompts = new PromptService({ herdr: outer, pollMs: 300, stepDelayMs: 5, lookMs: 20 });
const { server } = createHerdrHttpServer({
  herdr: outer,
  attachments,
  prompts,
  conversations: new ConversationService({ herdr: outer, localStore: localTranscriptStore({
    configDir: join(root, "claude"), codexHome: join(root, "codex"), opencodeDb: dbPath,
  }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];
let fixture = null;
try {
  for (const mobile of [false, true]) {
    herdr = world();
    fixture?.close();
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    fixture = opencodeDb(dbPath);
    fill(fixture);
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lens = () => page.locator(".terminal-stage").getAttribute("data-lens");
    const chat = page.locator('.chat-pane[data-pane-id="w1:p1"]');

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    // An OpenCode pane has a chat.
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    if (!mobile) await page.locator("#lens-chat").click();
    await page.waitForFunction(() => document.querySelector(".terminal-stage")?.dataset.lens === "chat");
    assert.equal(await lens(), "chat");
    await chat.locator(".chat-turn-agent").first().waitFor({ state: "visible" });

    // The turns: prompts as bubbles, the answer as Markdown.
    const bubbles = await chat.locator(".chat-turn-user .chat-bubble").allTextContents();
    assert.equal(bubbles.filter((bubble) => bubble.trim() === "prompt 29").length, 1);
    const agents = chat.locator(".chat-turn-agent");
    const last = agents.last();
    assert.match(await last.locator(".markdown strong").first().textContent(), /bold/u);
    assert.match(await last.textContent(), /Answer 29 with/u);
    // The work folds under one header, counted as Claude's is; the last turn runs, so it is open.
    const block = last.locator(".work-block");
    assert.match(await block.locator(".work-block-head").textContent(), /Working….*1 edit.*1 command/u);
    if ((await block.locator(".work-block-head").getAttribute("aria-expanded")) !== "true") await block.locator(".work-block-head").click();
    const rows = await block.locator(".work-row-head").allTextContents();
    assert.ok(rows.some((row) => /Ran\s*git status --short step-29/u.test(row)), `a command row reads "Ran …": ${rows.join(" | ")}`);
    assert.ok(rows.some((row) => /Edited\s*\/work\/opencode-chat\/src\/parse\.js/u.test(row)), `an edit row reads "Edited …": ${rows.join(" | ")}`);
    assert.ok(rows.some((row) => /todowrite\s*1\/3 done/u.test(row)), `the todo row counts: ${rows.join(" | ")}`);
    assert.ok(rows.some((row) => /Thinking/u.test(row)), "reasoning is a thinking row");
    // The to-do list, the edit's diff, and the command's whole output.
    await block.locator(".work-row-head", { hasText: "1/3 done" }).click();
    assert.deepEqual(await block.locator(".chat-todo").evaluateAll((items) => items.map((item) => item.className)),
      ["chat-todo is-completed", "chat-todo is-in_progress", "chat-todo is-pending"]);
    await block.locator(".work-row-head", { hasText: "parse.js" }).click();
    assert.match(await block.locator(".chat-diff-del").first().textContent(), /i <= n/u);
    assert.match(await block.locator(".chat-diff-add").first().textContent(), /i < n/u);
    await block.locator(".work-row-head", { hasText: "git status" }).click();
    await block.locator(".chat-tool-more").click();
    await page.waitForFunction(() => [...document.querySelectorAll(".chat-tool-output pre")].some((pre) => pre.textContent.endsWith("end of output")));

    // OpenCode works: the row names it, and the composer's button is Stop.
    await page.waitForFunction(() => document.querySelector('.chat-pane[data-pane-id="w1:p1"] .chat-working')?.textContent.startsWith("OpenCode is working"), null, { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector("#input-form .send-button")?.dataset.mode === "stop", null, { timeout: 5_000 });

    // Rows written meanwhile land in the open chat.
    fixture.exchange(SESSION, 30);
    await page.waitForFunction(() => document.querySelector('.chat-pane[data-pane-id="w1:p1"]')?.textContent.includes("answer 30"), null, { timeout: 5_000 });
    herdr.setStatus("w1:p1", "idle");
    await page.waitForFunction(() => !document.querySelector('.chat-pane[data-pane-id="w1:p1"] .chat-working'), null, { timeout: 5_000 });

    assert.deepEqual(errors, []);
    results.push({ mobile, chatEnabled: true, turns: true, toolBlock: true, todos: true, wholeOutput: true, working: "OpenCode is working", live: true });
    await context.close();
  }
} finally {
  await browser.close();
  fixture?.close();
  attachments.close();
  prompts.stop();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
for (const result of results) console.log(result);
