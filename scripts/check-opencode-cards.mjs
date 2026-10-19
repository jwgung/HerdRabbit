// Browser check of OpenCode's prompt cards and Stop (desktop and phone): an
// OpenCode pane herdr reports blocked on a permission request shows its card
// in the Chat lens (on a desktop first as a banner over the terminal); Allow
// once sends Enter, Allow always from Reject sends ← then Enter and brings
// OpenCode's "Always allow" check as a card of its own; a question card takes
// its words from the running question call in OpenCode's database and is
// answered by its digit; and Stop on a working OpenCode pane sends Esc twice,
// apart. The screens are drawn from OpenCode 1.18.34's source
// (test/fixtures/opencode-prompt.mjs), the database is a temporary one with
// made-up rows, and herdr is an in-process fake: nothing reaches a real herdr
// or a real OpenCode.
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
import { opencodeDb } from "../test/fixtures/opencode-db.mjs";
import { fakeOpencodeHerdr } from "../test/fixtures/opencode-prompt.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "ses_0001AAAAAAAAAAAAAAAAAAAAAA";
const CWD = "/work/opencode-cards";
const PANE = "w1:p1";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-opencode-cards-"));
const dbPath = join(root, "opencode.db");

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
  const herdr = fakeOpencodeHerdr({
    panes: [{ pane_id: PANE, tab_id: "w1:t1", workspace_id: "w1", label: "OpenCode", agent: "opencode", cwd: CWD,
      agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: SESSION }, agent_status: "blocked" }],
    prompts: { [PANE]: { kind: "permission", selected: 0 } },
  });
  const snapshot = herdr.snapshot;
  herdr.snapshot = async () => ({ ...(await snapshot()), ...structuredClone(template) });
  return herdr;
}

let herdr = world();
const proxy = new Proxy({}, { get: (_target, name) => (...args) => herdr[name](...args) });
// when each key went, for the pause between Stop's two Escs
const stamps = [];
const outer = {
  snapshot: () => proxy.snapshot(),
  readPane: (...args) => proxy.readPane(...args),
  sendKeys: (paneId, keys, ...rest) => { stamps.push({ keys: [...keys], at: Date.now() }); return proxy.sendKeys(paneId, keys, ...rest); },
  sendText: (...args) => proxy.sendText(...args),
};
const conversations = new ConversationService({ herdr: outer, localStore: localTranscriptStore({
  configDir: join(root, "claude"), codexHome: join(root, "codex"), opencodeDb: dbPath,
}) });
const prompts = new PromptService({ herdr: outer, pollMs: 200, stepDelayMs: 5, lookMs: 20,
  details: (paneId, snapshot) => conversations.pendingAsk(paneId, snapshot) });
const { server } = createHerdrHttpServer({ herdr: outer, attachments, prompts, conversations, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];
let fixture = null;
try {
  for (const mobile of [false, true]) {
    herdr = world();
    stamps.length = 0;
    fixture?.close();
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
    fixture = opencodeDb(dbPath);
    fixture.session(SESSION, { directory: CWD });
    for (let n = 0; n < 3; n++) fixture.exchange(SESSION, n);

    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const card = page.locator(".prompt-card");
    const dockMode = () => page.locator("#prompt-dock").getAttribute("data-mode");
    const keysSent = () => herdr.sent.filter((item) => item.paneId === PANE).map((item) => item.keys?.join("+") ?? `text:${item.text}`);
    const waitDock = (mode) => page.waitForFunction((want) => document.querySelector("#prompt-dock")?.dataset.mode === want, mode, { timeout: 5_000 });

    await page.goto(`${url}/?pane=${encodeURIComponent(PANE)}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    if (!mobile) {
      // Desktop opens in Terminal: the banner says OpenCode is asking, and opens the chat.
      await waitDock("banner");
      assert.match(await page.locator(".prompt-banner").textContent(), /OpenCode is asking: Permission required/u);
      await page.locator(".prompt-banner-open").click();
    }
    await page.waitForFunction(() => document.querySelector(".terminal-stage")?.dataset.lens === "chat");

    // The permission card: what it is for, the command, the three buttons.
    await waitDock("card");
    assert.equal(await card.locator("h2").textContent(), "Permission required");
    assert.equal(await card.locator(".prompt-card-question").textContent(), "Shell command");
    assert.match(await card.locator(".prompt-card-body").textContent(), /\$ npm test/u);
    assert.deepEqual(await card.locator(".prompt-card-option-label").allTextContents(), ["Allow once", "Allow always", "Reject"]);
    // Allow once: the selection is on it already, so Enter alone.
    await card.locator('[data-prompt-option="0"]').click();
    await waitDock("hidden");
    assert.deepEqual(keysSent(), ["enter"]);
    assert.deepEqual(herdr.answered, [{ paneId: PANE, answer: "once" }]);

    // Another request, its selection left on Reject in the terminal: Allow
    // always moves left once, then Enter; OpenCode's check is the next card.
    herdr.sent.length = 0;
    herdr.prompts[PANE] = { kind: "permission", selected: 2, screen: { icon: "→", title: "Edit src/parse.js", body: ["1 - i <= n", "1 + i < n"], diff: true } };
    herdr.setStatus(PANE, "blocked");
    await page.waitForFunction(() => document.querySelector(".prompt-card-question")?.textContent === "Edit src/parse.js", null, { timeout: 5_000 });
    assert.match(await card.locator(".prompt-card-body").textContent(), /i <= n/u);
    await card.locator('[data-prompt-option="1"]').click();
    await page.waitForFunction(() => document.querySelector(".prompt-card h2")?.textContent === "Always allow", null, { timeout: 5_000 });
    assert.deepEqual(keysSent(), ["left", "enter"]);
    assert.equal(await card.locator(".prompt-card-question").textContent(), "This will allow bash until OpenCode is restarted.");
    await card.locator('[data-prompt-option="0"]').click();
    await waitDock("hidden");
    assert.deepEqual(keysSent(), ["left", "enter", "enter"]);
    assert.deepEqual(herdr.answered.at(-1), { paneId: PANE, answer: "always" });

    // A question: its words from the question call OpenCode's database has
    // running, answered by the row's digit.
    herdr.sent.length = 0;
    const message = fixture.exchange(SESSION, 3);
    fixture.part(SESSION, message, { type: "tool", tool: "question", callID: "call_q", state: { status: "running", input: { questions: [{
      question: "Which export format should we use?", header: "Format",
      options: [{ label: "ONNX", description: "Export a portable ONNX model with opset 18." }, { label: "TensorRT", description: "Build an NVIDIA TensorRT engine." }],
    }] } } });
    herdr.prompts[PANE] = { kind: "question" };
    herdr.setStatus(PANE, "blocked");
    await page.waitForFunction(() => document.querySelector(".prompt-card h2")?.textContent === "Question", null, { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector(".prompt-card-option-description")?.textContent === "Export a portable ONNX model with opset 18.", null, { timeout: 5_000 });
    assert.equal(await card.locator(".prompt-card-question").textContent(), "Which export format should we use?");
    assert.equal(await card.locator(".prompt-card-custom-input").count(), 1, "a typed answer can go through its row");
    await card.locator('[data-prompt-option="1"]').click();
    await waitDock("hidden");
    assert.deepEqual(keysSent(), ["2"]);
    assert.deepEqual(herdr.answered.at(-1), { paneId: PANE, answer: "TensorRT" });

    // OpenCode works on: Stop shows, and sends Esc twice, apart (OpenCode
    // interrupts on the second within 5 seconds).
    herdr.sent.length = 0;
    stamps.length = 0;
    herdr.setStatus(PANE, "working");
    await page.waitForFunction(() => document.querySelector('.chat-pane[data-pane-id="w1:p1"] .chat-working')?.textContent.startsWith("OpenCode is working"), null, { timeout: 5_000 });
    const button = page.locator("#input-form .send-button");
    await page.waitForFunction(() => document.querySelector("#input-form .send-button")?.dataset.mode === "stop", null, { timeout: 5_000 });
    await button.click();
    const until = Date.now() + 3_000;
    while (keysSent().length < 2 && Date.now() < until) await page.waitForTimeout(50);
    assert.deepEqual(keysSent(), ["esc", "esc"]);
    const gap = stamps[1].at - stamps[0].at;
    assert.ok(gap >= 300 && gap < 5_000, `the two Escs went ${gap} ms apart`);
    // still working by a fresh snapshot a moment later: the hint to press again
    await page.waitForFunction(() => /OpenCode is still working/u.test(document.querySelector("#action-feedback")?.textContent ?? ""), null, { timeout: 6_000 });

    // a Stop whose follow-up snapshot fails says nothing: the old status is no evidence
    await page.evaluate(() => { document.querySelector("#action-feedback").textContent = ""; });
    await page.waitForTimeout(1_200);
    await page.waitForFunction(() => document.querySelector("#input-form .send-button")?.dataset.mode === "stop", null, { timeout: 5_000 });
    const realSnapshot = herdr.snapshot;
    herdr.snapshot = async () => { throw new Error("herdr went away for a moment"); };
    await button.click();
    await page.waitForTimeout(3_500);
    herdr.snapshot = realSnapshot;
    assert.doesNotMatch(await page.locator("#action-feedback").textContent(), /OpenCode is still working/u, "a hint from a snapshot that failed");

    assert.deepEqual(errors, []);
    results.push({ mobile, banner: !mobile, permissionCard: true, allowOnce: "enter", allowAlways: "left, enter, enter", question: "2 (words from the database)", stop: `esc, esc (${gap} ms apart)` });
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
