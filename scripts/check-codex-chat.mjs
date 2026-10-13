// Browser check of the Chat lens and the prompt card for a Codex pane (6): the
// pane's rollout, found by the thread herdr reports in a temporary CODEX_HOME,
// reads as turns (the prompt, the agent's commands folded under "Worked for",
// reasoning summaries, the final answer; none of Codex's injected context),
// a command's whole output loads on request, and Codex's command approval is
// a card that answers with the keys Codex takes (↓ Enter, or Esc for its
// refusal). Runs against an in-process fake herdr; nothing reaches a real
// herdr or a real ~/.codex.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { fakePromptHerdr } from "../test/fixtures/claude-prompt.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const THREAD = "019da5c2-66fd-7021-b565-5e94406b028e";
const CWD = "/work/codex-chat";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-codex-chat-"));
const codexHome = join(root, "codex");
const folder = join(codexHome, "sessions", "2026", "10", "01");
await mkdir(folder, { recursive: true });
const rollout = join(folder, `rollout-2026-10-01T09-00-00-${THREAD}.jsonl`);

const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const at = (n, seconds = 0) => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + n * 60_000 + seconds * 1000).toISOString();
const item = (timestamp, payload) => ({ type: "response_item", timestamp, payload });
const event = (timestamp, payload) => ({ type: "event_msg", timestamp, payload });
// One task as Codex writes it: the prompt twice (event + model copy), reasoning,
// a command and its output, then the answer twice.
const task = (n) => [
  event(at(n), { type: "task_started", turn_id: `turn-${n}`, started_at: at(n) }),
  { type: "turn_context", timestamp: at(n), payload: { cwd: CWD, model: "gpt-test", effort: "high" } },
  item(at(n), { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>" }] }),
  item(at(n), { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] }),
  event(at(n), { type: "user_message", message: `prompt ${n}`, kind: "plain" }),
  item(at(n, 1), { type: "reasoning", summary: [{ type: "summary_text", text: `Thinking about step ${n}` }], encrypted_content: "opaque" }),
  item(at(n, 2), { type: "function_call", call_id: `call_${n}`, name: "exec_command", arguments: JSON.stringify({ cmd: `git status --short step-${n}` }) }),
  item(at(n, 3), { type: "function_call_output", call_id: `call_${n}`, output: n === 28 ? `${"M file\n".repeat(900)}end of output` : `M step-${n}.txt` }),
  event(at(n, 9), { type: "agent_message", message: `Answer ${n} with **bold** and \`code\`.`, phase: "final_answer" }),
  item(at(n, 9), { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Answer ${n} with **bold** and \`code\`.` }] }),
  event(at(n, 9), { type: "task_complete", turn_id: `turn-${n}` }),
];
const initialRollout = jsonl([
  { type: "session_meta", timestamp: at(0), payload: { id: THREAD, cwd: CWD, source: "cli", base_instructions: { text: "internal instructions" } } },
  item(at(0), { type: "message", role: "developer", content: [{ type: "input_text", text: "Hidden developer prompt" }] }),
  ...Array.from({ length: 30 }, (_, n) => task(n)).flat(),
]);

const ptys = [];
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    let exit;
    const pty = { options, exited: new Promise((resolve) => { exit = resolve; }), write() {}, resize() {}, pause() {}, resume() {}, kill() { exit(); } };
    ptys.push(pty);
    setTimeout(() => options.onData("\x1b[?1049hready terminal\r\n$ "), 10);
    return pty;
  },
});

function world() {
  const template = { workspaces: [{ workspace_id: "w1", label: "Platform" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Release" }] };
  const herdr = fakePromptHerdr({
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Codex", agent: "codex", cwd: CWD,
        agent_session: { agent: "codex", kind: "id", value: THREAD }, agent_status: "blocked" },
    ],
    menus: { "w1:p1": { agent: "codex", cursor: 0 } },
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
  conversations: new ConversationService({ herdr: outer, localStore: localTranscriptStore({ configDir: join(root, "claude"), codexHome }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];
try {
  for (const mobile of [false, true]) {
    herdr = world();
    await writeFile(rollout, initialRollout);
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lens = () => page.locator(".terminal-stage").getAttribute("data-lens");
    const chat = page.locator('.chat-pane[data-pane-id="w1:p1"]');
    const keysSent = () => herdr.sent.filter((item) => item.paneId === "w1:p1").map((item) => item.keys?.join("+") ?? `text:${item.text}`);

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    // A Codex pane has a chat.
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    assert.equal(await page.locator("#lens-chat").getAttribute("title"), `Show the conversation (Ctrl+J)`);
    if (!mobile) {
      // Over the terminal, the banner names Codex.
      await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "banner");
      assert.match(await page.locator(".prompt-banner").textContent(), /Codex is asking: Would you like to run the following command\?/u);
      await page.locator("#lens-chat").click();
    }
    assert.equal(await lens(), "chat");
    await chat.locator(".chat-turn-agent").first().waitFor({ state: "visible" });

    // The turns: prompts as bubbles, the answer as Markdown, Codex's own context nowhere.
    const text = await chat.textContent();
    assert.match(text, /prompt 29/u);
    for (const hidden of ["environment_context", "Hidden developer prompt", "internal instructions", "opaque"]) {
      assert.equal(text.includes(hidden), false, `${hidden} is not shown`);
    }
    const bubbles = await chat.locator(".chat-turn-user .chat-bubble").allTextContents();
    assert.equal(bubbles.filter((bubble) => bubble.trim() === "prompt 29").length, 1, "the prompt's two records read as one");
    const agents = chat.locator(".chat-turn-agent");
    // the last turn waits on the card ("Needs you"); the one before it is settled
    assert.match(await agents.last().locator(".work-block-head").textContent(), /Needs you.*1 command/u);
    const answer = agents.nth((await agents.count()) - 2);
    assert.match(await answer.locator(".markdown strong").first().textContent(), /bold/u);
    // The work folds under one header; its row says what ran, and the whole output loads.
    const block = answer.locator(".work-block");
    assert.match(await block.locator(".work-block-head").textContent(), /Worked for 9s.*1 command/u);
    await block.locator(".work-block-head").click();
    const rows = await block.locator(".work-row-head").allTextContents();
    assert.ok(rows.some((row) => /Ran\s*git status --short step-28/u.test(row)), `a command row reads "Ran …": ${rows.join(" | ")}`);
    assert.ok(rows.some((row) => /Thinking/u.test(row)), "the reasoning summary is a thinking row");
    await block.locator(".work-row-head", { hasText: "git status" }).click();
    assert.match(await block.locator(".chat-tool-io pre").first().textContent(), /git status --short step-28/u);
    await block.locator(".chat-tool-more").click();
    await page.waitForFunction(() => [...document.querySelectorAll(".chat-tool-output pre")].some((pre) => pre.textContent.endsWith("end of output")));

    // The approval card: Codex's title and command, the refusal answered by Esc.
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "card");
    const card = page.locator(".prompt-card");
    assert.equal(await card.locator("h2").textContent(), "Would you like to run the following command?");
    assert.match(await card.locator(".prompt-card-body").textContent(), /\$ npm test/u);
    assert.deepEqual(await card.locator(".prompt-card-option-label").allTextContents(),
      ["Yes, proceed (y)", "Yes, and don't ask again for commands that start with npm", "No, and tell Codex what to do differently (esc)"]);
    if (mobile) {
      await card.locator('[data-prompt-option="2"]').click();
      await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "hidden");
      assert.deepEqual(keysSent(), ["esc"]);
      assert.deepEqual(herdr.answered, [{ paneId: "w1:p1", answer: "esc" }]);
    } else {
      await card.locator('[data-prompt-option="1"]').click();
      await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "hidden");
      assert.deepEqual(keysSent(), ["down", "enter"]);
      assert.deepEqual(herdr.answered, [{ paneId: "w1:p1", answer: "Yes, and don't ask again for commands that start with npm" }]);
    }

    // Codex works on: the working row names it, and a new task lands in the chat.
    await page.waitForFunction(() => document.querySelector('.chat-pane[data-pane-id="w1:p1"] .chat-working')?.textContent.startsWith("Codex is working"), null, { timeout: 5_000 });
    const n = 30;
    await appendFile(rollout, jsonl(task(n)));
    await page.waitForFunction((wanted) => document.querySelector('.chat-pane[data-pane-id="w1:p1"]')?.textContent.includes(wanted), `Answer ${n} with`, { timeout: 5_000 });
    herdr.setStatus("w1:p1", "idle");
    await page.waitForFunction(() => !document.querySelector('.chat-pane[data-pane-id="w1:p1"] .chat-working'), null, { timeout: 5_000 });

    assert.deepEqual(errors, []);
    results.push({ mobile, chatEnabled: true, turns: true, hiddenContext: true, wholeOutput: true, card: true, keys: mobile ? "esc" : "down enter", working: "Codex is working" });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  prompts.stop();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
for (const result of results) console.log(result);
