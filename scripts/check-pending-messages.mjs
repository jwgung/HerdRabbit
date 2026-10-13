// Browser check of messages queued for the next turn (5b): while a Claude
// pane works, Send queues instead of typing into the busy terminal; the list
// over the composer shows the queued messages in both lenses, each can be
// edited, moved and cancelled, and the Chat lens shows them as queued
// bubbles. When the agent is ready the head goes as one bracketed paste and
// Enter, one per turn; Send now (the composer's button, or a row's) goes at
// once. Runs on a phone and a desktop against an in-process fake herdr whose
// agent status the check flips, and a transcript in a temporary Claude
// folder; nothing reaches a real herdr.
//
// PENDING_SCREENSHOTS=<folder> keeps pictures of the list in both themes.
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
import { PendingInputs, bracketedPaste } from "../src/pending-input.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "2a4f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const CWD = "/work/pending-messages";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-pending-"));
const configDir = join(root, "claude");
const project = join(configDir, "projects", claudeProjectDir(CWD));
await mkdir(project, { recursive: true });
const transcript = join(project, `${SESSION}.jsonl`);
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
let minute = 0;
const at = () => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + (minute += 1) * 60_000).toISOString();
const userTurn = (text) => ({ type: "user", uuid: `u${minute}`, parentUuid: null, timestamp: at(), message: { role: "user", content: text } });
const answerTurn = (text) => ({ type: "assistant", timestamp: at(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
const initialTranscript = () => jsonl([userTurn("hello"), answerTurn("Hello. What next?")]);

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

// The fake herdr: one Claude pane whose status the check sets. A paste and
// Enter put the pasted text in the transcript, as Claude would.
const herdr = {
  status: "working",
  sent: [],
  lastPaste: null,
  async snapshot() {
    return {
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Queue" }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Claude", agent: "claude", cwd: CWD,
        agent_session: { agent: "claude", kind: "id", value: SESSION }, agent_status: herdr.status }],
      agents: [],
    };
  },
  async readPane() { return "> "; },
  async sendText(paneId, text, options = {}) {
    herdr.sent.push({ paneId, text, submit: options.submit === true });
    if (text.startsWith("\x1b[200~")) herdr.lastPaste = text.slice(6, -6);
    else if (options.submit) await appendFile(transcript, jsonl([userTurn(text)]));
  },
  async sendKeys(paneId, keys) {
    herdr.sent.push({ paneId, keys: [...keys] });
    if (keys.includes("enter") && herdr.lastPaste !== null) {
      await appendFile(transcript, jsonl([userTurn(herdr.lastPaste)]));
      herdr.lastPaste = null;
    }
  },
};
const pastes = () => herdr.sent.filter((item) => item.text?.startsWith("\x1b[200~")).map((item) => item.text);

const pending = new PendingInputs({ herdr, pollMs: 150, turnTimeoutMs: 1_500, enterDelayMs: 0 });
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  pending,
  conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    herdr.status = "working";
    herdr.sent.length = 0;
    await writeFile(transcript, initialTranscript());
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const input = page.locator("#terminal-input");
    const sendButton = page.locator(".send-button");
    const list = page.locator("#pending-messages");
    const rows = list.locator(".pending-message");
    const rowTexts = () => rows.locator(".pending-message-text").allTextContents();
    const waitRows = (texts) => page.waitForFunction((wanted) => JSON.stringify([...document.querySelectorAll("#pending-messages .pending-message-text")]
      .map((node) => node.textContent)) === JSON.stringify(wanted), texts, { timeout: 8_000 });
    const lens = () => page.locator(".terminal-stage").getAttribute("data-lens");
    // A touch keyboard's Enter is a new line: the phone taps the button.
    const submit = async (text) => {
      await input.fill(text);
      if (mobile) await sendButton.click(); else await input.press("Enter");
    };
    const shoot = async (name) => {
      if (!process.env.PENDING_SCREENSHOTS) return;
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(300); // let the theme's colour transitions finish
        await page.screenshot({ path: join(process.env.PENDING_SCREENSHOTS, `${name}-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    };

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#lens-chat")?.getAttribute("aria-disabled") === "false");
    if (await lens() !== "terminal") await page.locator("#lens-terminal").click();

    // The agent works: Send becomes Queue, with Send now beside it.
    await page.waitForFunction(() => document.querySelector(".send-button")?.dataset.mode === "queue");
    assert.equal(await sendButton.getAttribute("aria-label"), "Queue");
    assert.equal(await page.locator("#send-now-button").isVisible(), true);
    assert.equal(await list.isVisible(), false, "no list while nothing waits");

    // Two messages queued while it works: listed in order, nothing typed into the pane.
    await submit("first queued");
    await waitRows(["first queued"]);
    assert.equal(await input.inputValue(), "", "the composer is cleared");
    await submit("second queued");
    await waitRows(["first queued", "second queued"]);
    assert.deepEqual(await rows.locator(".pending-message-badge").allTextContents(), ["Queued", "Queued"]);
    assert.deepEqual(herdr.sent, [], "nothing reached the busy pane");
    await shoot("queued");

    // Edit the second, then add a third, move it up and back, and cancel it.
    await rows.nth(1).locator('[data-pending-action="edit"]').click();
    const editor = list.locator("[data-pending-editor]");
    await editor.fill("second, edited");
    await editor.press("Enter");
    await waitRows(["first queued", "second, edited"]);
    await submit("third queued");
    await waitRows(["first queued", "second, edited", "third queued"]);
    await rows.nth(2).locator('[data-pending-action="up"]').click();
    await waitRows(["first queued", "third queued", "second, edited"]);
    await rows.nth(1).locator('[data-pending-action="down"]').click();
    await waitRows(["first queued", "second, edited", "third queued"]);
    assert.equal(await rows.nth(0).locator('[data-pending-action="up"]').isDisabled(), true);
    await rows.nth(2).locator('[data-pending-action="cancel"]').click();
    await waitRows(["first queued", "second, edited"]);

    // The Chat lens: the list still over the composer, and the messages as queued bubbles.
    await page.locator("#lens-chat").click();
    assert.equal(await lens(), "chat");
    assert.equal(await list.isVisible(), true, "the list shows in the Chat lens too");
    const chat = page.locator('.chat-pane[data-pane-id="w1:p1"]');
    await page.waitForFunction(() => document.querySelectorAll('.chat-pane[data-pane-id="w1:p1"] .chat-turn.is-queued').length === 2);
    assert.deepEqual(await chat.locator(".chat-turn.is-queued .chat-turn-meta").allTextContents(), ["Queued", "Queued"]);
    assert.deepEqual(await chat.locator(".chat-turn.is-queued .chat-pending-text").allTextContents(), ["first queued", "second, edited"]);
    const listBox = await list.boundingBox();
    const composerBox = await page.locator(".input-composer").boundingBox();
    assert.ok(listBox.y + listBox.height <= composerBox.y + 1, "the list sits over the composer");
    await shoot("chat");

    // Ready: the first goes as a paste and Enter, the list and the chat follow.
    herdr.status = "idle";
    await page.waitForFunction(() => document.querySelectorAll("#pending-messages .pending-message").length === 1, null, { timeout: 8_000 });
    assert.deepEqual(pastes(), [bracketedPaste("first queued")]);
    assert.deepEqual(herdr.sent.slice(0, 2), [{ paneId: "w1:p1", text: bracketedPaste("first queued"), submit: false }, { paneId: "w1:p1", keys: ["enter"] }]);
    await waitRows(["second, edited"]);
    // the delivered one leaves the queued bubbles and reaches the transcript
    await page.waitForFunction(() => document.querySelectorAll('.chat-pane[data-pane-id="w1:p1"] .chat-turn.is-queued').length === 1, null, { timeout: 8_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-pane[data-pane-id="w1:p1"] .chat-turns .chat-turn-user')]
      .some((node) => node.textContent.includes("first queued")), null, { timeout: 8_000 });
    // still idle, the agent never took it: the turn gate holds the second
    await page.waitForTimeout(600);
    assert.equal(pastes().length, 1, "one per turn");
    // a turn: working, then idle again, and the second goes
    herdr.status = "working";
    await page.waitForTimeout(500);
    herdr.status = "idle";
    await page.waitForFunction(() => document.querySelector("#pending-messages")?.hidden === true, null, { timeout: 8_000 });
    assert.deepEqual(pastes(), [bracketedPaste("first queued"), bracketedPaste("second, edited")]);
    await page.waitForFunction(() => document.querySelectorAll('.chat-pane[data-pane-id="w1:p1"] .chat-turn.is-queued').length === 0);

    // Ready and nothing waiting: Send sends at once, as before.
    await page.waitForFunction(() => document.querySelector(".send-button")?.dataset.mode === "send", null, { timeout: 8_000 });
    assert.equal(await page.locator("#send-now-button").isVisible(), false);
    await submit("straight in");
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    assert.deepEqual(herdr.sent.at(-1), { paneId: "w1:p1", text: "straight in", submit: true });

    // Busy again: Send now in the composer bypasses the queue.
    herdr.status = "working";
    await page.waitForFunction(() => document.querySelector(".send-button")?.dataset.mode === "queue", null, { timeout: 8_000 });
    await input.fill("urgent, now");
    await page.locator("#send-now-button").click();
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    assert.deepEqual(herdr.sent.at(-1), { paneId: "w1:p1", text: "urgent, now", submit: true });
    assert.equal(await list.isVisible(), false, "nothing was queued");
    if (!mobile) {
      // Alt+Enter is the keyboard's Send now.
      await input.fill("alt enter");
      await input.press("Alt+Enter");
      await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
      assert.deepEqual(herdr.sent.at(-1), { paneId: "w1:p1", text: "alt enter", submit: true });
    }

    // A queued row's Send now goes at once, while the agent still works.
    await submit("row send now");
    await waitRows(["row send now"]);
    await rows.nth(0).locator('[data-pending-action="send-now"]').click();
    await page.waitForFunction(() => document.querySelector("#pending-messages")?.hidden === true, null, { timeout: 8_000 });
    assert.equal(pastes().at(-1), bracketedPaste("row send now"));

    // The list can fold away to its one-line summary.
    await submit("folded");
    await waitRows(["folded"]);
    await list.locator(".pending-messages-toggle").click();
    assert.equal(await rows.count(), 0);
    assert.match(await list.locator(".pending-messages-toggle").textContent(), /1 message for the next turn/u);
    await list.locator(".pending-messages-toggle").click();
    await rows.nth(0).locator('[data-pending-action="cancel"]').click();
    await page.waitForFunction(() => document.querySelector("#pending-messages")?.hidden === true);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, "no sideways scroll");
    assert.deepEqual(errors, []);
    console.log({ mobile, queued: true, edited: true, reordered: true, cancelled: true, chatBubbles: true,
      deliveredInOrder: true, turnGate: true, sendNow: true, rowSendNow: true, folded: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  pending.stop();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
