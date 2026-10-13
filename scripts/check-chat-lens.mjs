// Browser check of the Chat / Terminal lens: a Claude pane's conversation and
// its terminal in the same place, switched by the header buttons and Mod+J.
// Switching only shows one and hides the other: no attach, detach or screen
// watch goes out, the composer's draft stays, and each lens keeps its scroll.
// Runs against a fake herdr and a transcript in a temporary Claude folder.
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
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const CWD = "/work/chat-lens";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-chat-lens-"));
const configDir = join(root, "claude");
const project = join(configDir, "projects", claudeProjectDir(CWD));
await mkdir(project, { recursive: true });
const transcript = join(project, `${SESSION}.jsonl`);

const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const at = (n, seconds = 0) => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + n * 60_000 + seconds * 1000).toISOString();
// One exchange: a prompt, a command the agent ran, its output, and an answer.
const exchange = (n) => [
  { type: "user", uuid: `u${n}`, parentUuid: null, timestamp: at(n), message: { role: "user", content: `prompt ${n}` } },
  { type: "assistant", timestamp: at(n, 2), message: { role: "assistant", stop_reason: "tool_use", content: [
    { type: "text", text: `Looking at step ${n}.` },
    { type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: `ls step-${n}`, description: "List the step" } },
  ] } },
  { type: "user", timestamp: at(n, 3), message: { role: "user", content: [
    { type: "tool_result", tool_use_id: `toolu_${n}`, content: n === 69 ? `${"line\n".repeat(900)}end of output` : `step-${n}.txt` },
  ] } },
  { type: "assistant", timestamp: at(n, 9), message: { role: "assistant", stop_reason: "end_turn", content: [
    { type: "text", text: `Answer ${n} with **bold**, \`code\`, <script>alert(1)</script> and notes in /tmp/notes.md.\n\n- one\n- two\n\n\`\`\`js\nconsole.log(${n});\n\`\`\`` },
  ] } },
];
await writeFile(transcript, jsonl(Array.from({ length: 70 }, (_, n) => exchange(n)).flat()));

const snapshot = JSON.parse(await readFile(new URL("../test/fixtures/fake-state.template.json", import.meta.url), "utf8")).snapshot;
const claudePane = snapshot.panes.find((pane) => pane.pane_id === "w1:p1");
Object.assign(claudePane, { agent: "claude", cwd: CWD, agent_session: { agent: "claude", kind: "id", value: SESSION } });
// The agent is done: its last turn reads as finished work, not "Working…".
snapshot.agents.find((agent) => agent.pane_id === "w1:p1").state = "done";

const ptys = [];
const sentTexts = [];
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    let exit;
    const pty = {
      options, written: "", exited: new Promise((resolve) => { exit = resolve; }),
      write(data) { this.written += data; options.onData(data); },
      resize() {}, pause() {}, resume() {},
      kill() { exit(); },
    };
    ptys.push(pty);
    setTimeout(() => options.onData("\x1b[?1049hready terminal\r\n$ "), 10);
    return pty;
  },
});
const herdr = {
  async snapshot() { return snapshot; },
  async readPane() { return "screen\n$ "; },
  async sendText(paneId, text) { sentTexts.push({ paneId, text }); },
  async sendKeys() {},
};
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    ptys.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // What the page sends on its terminal socket, and which conversation pages it reads.
    const frames = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      try { frames.push(JSON.parse(payload)); } catch {}
    }));
    const reads = [];
    page.on("request", (request) => {
      if (request.url().includes("/conversation?") || request.url().endsWith("/conversation")) {
        reads.push({ url: request.url(), ifNoneMatch: request.headers()["if-none-match"] ?? null });
      }
    });
    const typesSince = (count, types) => frames.slice(count).filter((frame) => types.includes(frame.type)).map((frame) => frame.type);
    const shows = (text) => page.waitForFunction((wanted) => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.replace(/ /gu, " ").includes(wanted), text);
    const lens = () => page.locator(".terminal-stage").getAttribute("data-lens");
    const chat = page.locator('.chat-pane[data-pane-id="w1:p1"]');
    const scroller = chat.locator(".chat-scroll");

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await shows("ready terminal");
    // A pane never chosen for: Chat on a phone, Terminal on a desktop.
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    assert.equal(await lens(), mobile ? "chat" : "terminal", "the default lens follows the device");
    if (!mobile) await page.locator("#lens-chat").click();
    await chat.locator(".chat-turn-agent").first().waitFor({ state: "visible" });
    assert.equal(await lens(), "chat");
    assert.equal(await page.locator("#terminal-xterm").isVisible(), false, "the terminal is hidden under the chat");

    // CHAT_LENS_SCREENSHOTS=<folder> keeps a picture of the chat in both themes.
    if (process.env.CHAT_LENS_SCREENSHOTS) {
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.screenshot({ path: join(process.env.CHAT_LENS_SCREENSHOTS, `chat-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    }

    // The answer's markdown is drawn, its script tag is only text, and the file path opens.
    const answer = chat.locator(".chat-turn-agent").last();
    assert.match(await answer.locator(".markdown strong").first().textContent(), /bold/u);
    assert.equal(await chat.locator("script").count(), 0, "no markup from the transcript reaches the page");
    assert.match(await answer.textContent(), /<script>alert\(1\)<\/script>/u);
    assert.equal(await answer.locator(".md-code pre").first().textContent(), "console.log(69);");
    assert.equal(await answer.locator('.md-file[data-path="/tmp/notes.md"]').count(), 1, "a path the viewer opens is a link");
    // Work is folded under one header, and a row opens to the call and its output.
    const block = answer.locator(".work-block");
    assert.match(await block.locator(".work-block-head").textContent(), /Worked for 7s.*1 command/u);
    await block.locator(".work-block-head").click();
    await block.locator(".work-row-head").click();
    await block.locator(".chat-tool-more").click();
    await page.waitForFunction(() => [...document.querySelectorAll(".chat-tool-output pre")].some((pre) => pre.textContent.endsWith("end of output")));

    // The draft typed in the chat stays in the shared composer.
    await page.locator("#terminal-input").fill("draft kept across lenses");
    await page.waitForTimeout(200);
    // Up the conversation, the earlier page goes on top.
    await scroller.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-pane[data-pane-id="w1:p1"] .chat-bubble')].some((bubble) => bubble.textContent.trim() === "prompt 0"));
    assert.equal(await chat.locator(".chat-endcap").isVisible(), true, "the beginning is marked once it is reached");
    assert.equal(await chat.locator(".chat-turn-user").count(), 70, "each prompt once");
    await scroller.evaluate((node) => { node.scrollTop = 700; node.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(100);
    const chatScroll = await scroller.evaluate((node) => node.scrollTop);

    // Switching both ways: nothing attaches, detaches or watches the screen again.
    const framesBefore = frames.length;
    const ptysBefore = ptys.length;
    const readsBefore = reads.length;
    await page.locator("#lens-terminal").click();
    assert.equal(await lens(), "terminal");
    assert.equal(await page.locator("#terminal-xterm").isVisible(), true);
    assert.equal(await chat.isVisible(), false);
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#terminal-input").inputValue(), "draft kept across lenses");
    await page.locator("#lens-chat").click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#terminal-input").inputValue(), "draft kept across lenses");
    assert.equal(await scroller.evaluate((node) => node.scrollTop), chatScroll, "the chat keeps its place");
    // Mod+J from the composer switches too.
    await page.locator("#terminal-input").focus();
    await page.keyboard.press("Control+j");
    assert.equal(await lens(), "terminal");
    await page.keyboard.press("Control+j");
    assert.equal(await lens(), "chat");
    await page.waitForTimeout(300);
    assert.deepEqual(typesSince(framesBefore, ["attach", "detach", "watch", "unwatch", "take-over"]), [], "no terminal traffic on a switch");
    assert.equal(ptys.length, ptysBefore, "the terminal stayed attached");
    // Only the chat's own watch follows it on and off screen; a read on its
    // return asks only from where the chat holds (`since`), with If-None-Match
    // once it has an answer for that, so an unchanged conversation costs a 304.
    assert.ok(typesSince(framesBefore, ["watch-conversation", "unwatch-conversation"]).length >= 2);
    const returnReads = reads.slice(readsBefore);
    assert.ok(returnReads.every((read) => /since=/u.test(read.url)), "the chat is not read again from scratch");
    assert.ok(returnReads.slice(1).every((read) => read.ifNoneMatch), "a read again asks If-None-Match");

    // A send from the chat goes the usual way; an append shows without a reload.
    await page.locator("#terminal-input").fill("hello from chat");
    await page.locator(".send-button").click();
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    assert.deepEqual(sentTexts.at(-1), { paneId: "w1:p1", text: "hello from chat" });
    await appendFile(transcript, jsonl([
      { type: "user", uuid: "u70", parentUuid: null, timestamp: at(70), message: { role: "user", content: "hello from chat" } },
      { type: "assistant", timestamp: at(70, 4), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "New answer arrived." }] } },
    ]));
    await page.waitForFunction(() => document.querySelector('.chat-pane[data-pane-id="w1:p1"]')?.textContent.includes("New answer arrived."));

    // "View in terminal" on a command row switches lens.
    await chat.locator('[data-action="view-terminal"]').first().click();
    assert.equal(await lens(), "terminal");

    // A pane with no Claude: only the terminal, and the switch says why.
    if (mobile) await page.locator("[aria-label='Open sidebar']").first().click();
    await page.locator('[data-pane-id="w1:p2"]').first().click();
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "true");
    assert.equal(await lens(), "terminal");
    assert.equal(await page.locator("#lens-chat").getAttribute("title"), "Chat is only for Claude Code panes.");
    await page.locator("#lens-chat").click({ force: true });
    assert.equal(await lens(), "terminal");

    // The last lens is remembered per pane.
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await shows("ready terminal");
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    assert.equal(await lens(), "terminal", "the lens chosen last for the pane comes back");
    assert.deepEqual(errors, []);
    console.log({ mobile, defaultLens: true, noReattachOnSwitch: true, draftKept: true, scrollKept: true, shortcut: true,
      olderPages: true, liveUpdate: true, send: true, unavailable: true, remembered: true });
    await context.close();
    // the next round reads the transcript as written by the first
    await writeFile(transcript, jsonl(Array.from({ length: 70 }, (_, n) => exchange(n)).flat()));
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
