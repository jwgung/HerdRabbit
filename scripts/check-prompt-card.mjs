// Browser check of the prompt card (5a) and the Chat lens around it: a Claude
// pane blocked on a tool approval shows its card at the bottom of the chat,
// a banner over the terminal that switches to the chat, an option that sends
// the expected keys, a card that changed on screen (409) read again, the
// fallback card over a pane with no chat, the key bar hidden in the chat, the
// working row and a sent message on its way, the chat's own text size, and
// the copy icons, and a multiple choice with an option already ticked in the
// terminal that the card starts from. Runs against an in-process fake herdr and a transcript in a
// temporary Claude folder; nothing reaches a real herdr.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const SESSION = "1e4f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const CWD = "/work/prompt-card";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-prompt-card-"));
const configDir = join(root, "claude");
const project = join(configDir, "projects", claudeProjectDir(CWD));
await mkdir(project, { recursive: true });
const transcript = join(project, `${SESSION}.jsonl`);
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const at = (n, seconds = 0) => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + n * 60_000 + seconds * 1000).toISOString();
const exchange = (n) => [
  { type: "user", uuid: `u${n}`, parentUuid: null, timestamp: at(n), message: { role: "user", content: `prompt ${n}` } },
  { type: "assistant", timestamp: at(n, 9), message: { role: "assistant", stop_reason: "end_turn", content: [
    { type: "text", text: `Answer ${n}.\n\n${"A line of the answer.\n\n".repeat(4)}\`\`\`sh\necho ${n}\n\`\`\`` },
  ] } },
];
const initialTranscript = jsonl(Array.from({ length: 40 }, (_, n) => exchange(n)).flat());

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
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Claude", agent: "claude", cwd: CWD,
        agent_session: { agent: "claude", kind: "id", value: SESSION }, agent_status: "blocked" },
      { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "Shell", agent: "codex", agent_status: "blocked" },
      { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", label: "Datasets", agent: "claude", agent_status: "blocked" },
      // herdr says working while Claude waits on a menu
      { pane_id: "w1:p4", tab_id: "w1:t1", workspace_id: "w1", label: "Quiet", agent: "claude", agent_status: "working" },
    ],
    menus: { "w1:p1": { cursor: 0 }, "w1:p4": { cursor: 0 } },
    // LM-O is ticked in the terminal already
    questions: { "w1:p3": { checked: [0], cursor: 0 } },
    outputs: { "w1:p2": "Overwrite the build folder?\nContinue? (y/n)" },
  });
  const snapshot = herdr.snapshot;
  herdr.snapshot = async () => ({ ...(await snapshot()), ...structuredClone(template) });
  return herdr;
}

let herdr = world();
// Every call goes to the current world, so each round starts afresh.
const proxy = new Proxy({}, { get: (_target, name) => (...args) => herdr[name](...args) });
const sentTexts = [];
const outer = {
  snapshot: () => proxy.snapshot(),
  readPane: (...args) => proxy.readPane(...args),
  sendKeys: (...args) => proxy.sendKeys(...args),
  async sendText(paneId, text, options) { sentTexts.push({ paneId, text, options }); return proxy.sendText(paneId, text); },
};
// A long poll: a card that changes on screen is only seen when an answer reads it again (409).
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
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];
try {
  for (const mobile of [false, true]) {
    herdr = world();
    sentTexts.length = 0;
    await writeFile(transcript, initialTranscript);
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url }).catch(() => {});
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lens = () => page.locator(".terminal-stage").getAttribute("data-lens");
    const dockMode = () => page.locator("#prompt-dock").getAttribute("data-mode");
    const chat = page.locator('.chat-pane[data-pane-id="w1:p1"]');
    const scroller = chat.locator(".chat-scroll");
    const atBottom = () => scroller.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 4);
    const keysSent = () => herdr.sent.filter((item) => item.paneId === "w1:p1").map((item) => item.keys?.join("+") ?? `text:${item.text}`);

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    if (!mobile) {
      // Desktop opens in Terminal: the key bar shows, and the banner floats over the terminal.
      assert.equal(await lens(), "terminal");
      assert.equal(await page.locator(".quick-keys").isVisible(), true, "the key bar shows in the Terminal lens");
      await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "banner");
      assert.match(await page.locator(".prompt-banner").textContent(), /Claude is asking: Bash command/u);
      const xtermBefore = await page.locator("#terminal-xterm").boundingBox();
      assert.ok(xtermBefore.height > 200, "the banner takes no room from the terminal");
      await page.locator(".prompt-banner-open").click();
      assert.equal(await lens(), "chat", "the banner switches to the chat");
    }
    // In the Chat lens: the card at the bottom, over the composer, and no key bar.
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "card");
    assert.equal(await lens(), "chat");
    assert.equal(await page.locator(".quick-keys").isVisible(), false, "the key bar is hidden in the Chat lens");
    assert.equal(await page.locator("#terminal-input").isVisible(), true, "the composer stays");
    assert.equal(await page.locator("#attach-button").isVisible(), true);
    assert.equal(await page.locator(".send-button").isVisible(), true);
    const card = page.locator(".prompt-card");
    assert.equal(await card.locator("h2").textContent(), "Bash command");
    assert.equal(await card.locator(".prompt-card-question").textContent(), "Do you want to proceed?");
    assert.match(await card.locator(".prompt-card-body").textContent(), /npm test/u);
    assert.deepEqual(await card.locator(".prompt-card-option-label").allTextContents(),
      ["Yes", "Yes, and don't ask again for: npm test", "No"]);
    const cardBox = await card.boundingBox();
    const composerBox = await page.locator("#input-form").boundingBox();
    const chatBox = await chat.boundingBox();
    assert.ok(cardBox.y + cardBox.height <= composerBox.y + 1, "the card sits above the composer");
    assert.ok(chatBox.y + chatBox.height <= cardBox.y + 1, "and under the conversation");
    await page.waitForTimeout(200);
    assert.equal(await atBottom(), true, "the card does not push the end of the chat out of view");
    assert.equal(await chat.locator(".chat-jump").isVisible(), false);
    if (!mobile) assert.equal(await page.evaluate(() => document.activeElement?.dataset.promptOption), "0", "the banner put the focus on the card");
    // PROMPT_CARD_SCREENSHOTS=<folder> keeps pictures of the card and the banner in both themes.
    const shoot = async (name) => {
      if (!process.env.PROMPT_CARD_SCREENSHOTS) return;
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.screenshot({ path: join(process.env.PROMPT_CARD_SCREENSHOTS, `${name}-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    };
    await shoot("card");

    // The terminal lens again: the key bar comes back and xterm fits the room it has.
    await page.locator("#lens-terminal").click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".quick-keys").isVisible(), true);
    assert.equal(await dockMode(), "banner");
    await shoot("banner");
    const fits = await page.evaluate(() => {
      const host = document.querySelector("#terminal-xterm");
      const screen = host.querySelector(".xterm-screen");
      return screen ? screen.getBoundingClientRect().height <= host.getBoundingClientRect().height + 1 : true;
    });
    assert.equal(fits, true, "xterm fits under the key bar");
    // Dismissed, the banner stays away for this card.
    await page.locator(".prompt-banner-close").click();
    assert.equal(await dockMode(), "hidden");
    await page.locator("#lens-chat").click();
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "card");

    // A card that changed on screen meanwhile: refused (409), and the new one is read.
    herdr.menus["w1:p1"].command = "npm run build";
    await card.locator('[data-prompt-option="2"]').click();
    await page.waitForFunction(() => document.querySelector(".prompt-card-error")?.textContent.includes("The prompt changed"));
    await page.waitForFunction(() => document.querySelector(".prompt-card-body")?.textContent.includes("npm run build"));
    assert.deepEqual(keysSent(), [], "nothing was sent for the old card");

    // Keyboard: Tab to the last option and Enter answers it with ↓ ↓ Enter.
    await card.locator('[data-prompt-option="1"]').focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.promptOption), "2");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "hidden");
    assert.deepEqual(keysSent(), ["down", "down", "enter"]);
    assert.deepEqual(herdr.answered, [{ paneId: "w1:p1", answer: "No" }]);

    // Claude works on: the working row shows at the end of the chat, and goes when it is idle.
    await page.waitForFunction(() => document.querySelector('.chat-pane[data-pane-id="w1:p1"] .chat-working')?.textContent.startsWith("Claude is working"), null, { timeout: 5_000 });
    const motion = await page.locator(".chat-working-dots").evaluate((node) => getComputedStyle(node).animationName);
    assert.equal(motion, "chat-working-pulse");
    herdr.setStatus("w1:p1", "idle");
    await page.waitForFunction(() => !document.querySelector('.chat-pane[data-pane-id="w1:p1"] .chat-working'), null, { timeout: 5_000 });

    // A send from far up: the chat goes to the end at once, shows the message
    // on its way and the working row, and follows the turn when it lands.
    await scroller.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(300);
    assert.equal(await chat.locator(".chat-jump").isVisible(), true, "far up, the jump button shows");
    await page.locator("#terminal-input").fill("run the release checks");
    await page.locator(".send-button").click();
    await page.waitForFunction(() => document.querySelector(".chat-turn-user.is-pending")?.textContent.includes("run the release checks"));
    assert.equal(await atBottom(), true, "at the end right after sending");
    assert.equal(await chat.locator(".chat-jump").isVisible(), false);
    assert.equal(await chat.locator(".chat-working").isVisible(), true, "the working row shows at once");
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    assert.deepEqual(sentTexts.at(-1), { paneId: "w1:p1", text: "run the release checks", options: { submit: true } });
    herdr.setStatus("w1:p1", "working");
    await appendFile(transcript, jsonl([
      { type: "user", uuid: "u90", parentUuid: null, timestamp: at(90), message: { role: "user", content: "run the release checks" } },
      { type: "assistant", timestamp: at(90, 4), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `Release checks passed.\n\n${"More detail.\n\n".repeat(12)}` }] } },
    ]));
    await page.waitForFunction(() => document.querySelector('.chat-pane[data-pane-id="w1:p1"]')?.textContent.includes("Release checks passed."), null, { timeout: 5_000 });
    await page.waitForFunction(() => !document.querySelector(".chat-turn-user.is-pending"));
    await page.waitForTimeout(200);
    assert.equal(await atBottom(), true, "still at the end once the turn lands");
    herdr.setStatus("w1:p1", "idle");

    // Copy: an icon with a name, a check for a moment once it worked.
    const copy = chat.locator(".chat-turn-agent .chat-copy").last();
    assert.equal(await copy.getAttribute("aria-label"), "Copy answer");
    assert.equal((await copy.textContent()).trim(), "", "an icon, not the word");
    assert.equal(await copy.locator("svg.copy-icon").count(), 1);
    assert.equal(await chat.locator(".md-code-copy svg.copy-icon").count() > 0, true);
    await copy.click();
    await page.waitForFunction(() => document.querySelector('.chat-pane[data-pane-id="w1:p1"] .chat-turn-agent:last-of-type .chat-copy')?.classList.contains("is-copied")
      || [...document.querySelectorAll(".chat-copy")].some((button) => button.classList.contains("is-copied")));
    await page.waitForFunction(() => ![...document.querySelectorAll(".chat-copy")].some((button) => button.classList.contains("is-copied")), null, { timeout: 3_000 });

    // The chat's text size: Ctrl+wheel over the chat, kept across a reload; the terminal's stays.
    const terminalSize = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size"));
    const before = Number(await page.locator(".terminal-stage").getAttribute("data-chat-font-size"));
    const box = await scroller.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await page.waitForTimeout(200);
    const after = Number(await page.locator(".terminal-stage").getAttribute("data-chat-font-size"));
    assert.ok(after > before, `the chat grew (${before} -> ${after})`);
    const transcriptSize = await chat.locator(".chat-transcript").evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    assert.equal(transcriptSize, after);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size")), terminalSize, "the terminal's size is untouched");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    assert.equal(Number(await page.locator(".terminal-stage").getAttribute("data-chat-font-size")), after, "the size is kept");
    if (!mobile) await page.locator("#lens-chat").click();

    // A pane with no chat: the banner opens the card over the terminal, and its Esc goes to the pane.
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p2")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "banner");
    assert.equal(await lens(), "terminal");
    assert.match(await page.locator(".prompt-banner").textContent(), /This pane is waiting for input/u);
    await page.locator(".prompt-banner-open").click();
    assert.equal(await dockMode(), "overlay");
    assert.equal(await lens(), "terminal");
    assert.deepEqual(await page.locator(".prompt-card-option-label").allTextContents(), ["Yes (y)", "No (n)", "Enter", "Esc"]);
    await page.locator(".prompt-card-close").click();
    assert.equal(await dockMode(), "banner");
    await page.locator(".prompt-banner-open").click();
    await page.locator('.prompt-card [data-prompt-option="3"]').click();
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "hidden" || document.querySelector(".prompt-card-error"));
    assert.deepEqual(herdr.sent.filter((item) => item.paneId === "w1:p2"), [{ paneId: "w1:p2", keys: ["esc"] }]);

    // A multiple choice: the card starts from the terminal's tick, and adding one more sends only that tick and →.
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p3")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "banner");
    await page.locator(".prompt-banner-open").click();
    await page.waitForFunction(() => document.querySelectorAll(".prompt-card [data-prompt-toggle]").length === 3);
    const ticks = () => page.locator(".prompt-card [data-prompt-toggle]").evaluateAll((boxes) => boxes.map((box) => box.checked));
    assert.deepEqual(await ticks(), [true, false, false], "the card starts from the terminal's tick");
    assert.equal(await page.locator('.prompt-card [data-prompt-action="submit"]').isDisabled(), false, "the tick as it is can be sent");
    await page.locator('.prompt-card [data-prompt-toggle="2"]').check();
    assert.deepEqual(await ticks(), [true, false, true]);
    await page.locator('.prompt-card [data-prompt-action="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "hidden" || document.querySelector(".prompt-card-error"));
    assert.deepEqual(herdr.sent.filter((item) => item.paneId === "w1:p3").map((item) => item.keys.join("+")), ["down", "down", "enter", "right"]);
    assert.deepEqual(herdr.answered.filter((item) => item.paneId === "w1:p3"), [{ paneId: "w1:p3", answer: ["LM-O", "T-LESS"] }]);

    // herdr still says "working" while the approval is on screen: the card appears all the same, and answers.
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p4")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "banner");
    await page.locator(".prompt-banner-open").click();
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "card" || document.querySelector("#prompt-dock")?.dataset.mode === "overlay");
    assert.equal((await herdr.snapshot()).panes.find((pane) => pane.pane_id === "w1:p4").agent_status, "working");
    await page.locator('.prompt-card [data-prompt-option="0"]').click();
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "hidden" || document.querySelector(".prompt-card-error"));
    assert.deepEqual(herdr.answered.filter((item) => item.paneId === "w1:p4"), [{ paneId: "w1:p4", answer: "Yes" }]);

    assert.deepEqual(errors, []);
    results.push({ mobile, banner: !mobile, card: true, keyBar: true, conflict: true, keyboard: true, working: true,
      pendingAndFollow: true, copyIcon: true, chatFontSize: `${before}->${after}`, fallbackOverlay: true, multipleChoice: true, workingPaneCard: true });
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
