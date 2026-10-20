// Browser check of files Claude Code hands over with SendUserFile, in the Chat
// lens (desktop and phone): a call that delivered its files reads as a card
// beside the answer, out of the folded work -- its caption as Markdown, each
// file by its name with its folder under it. Pressing a file opens it as a
// path in the text does: an .apk in the Files tab with its row selected, a
// note in the viewer. A call whose input the card cannot read stays an
// ordinary tool row in the work. Runs against a fake herdr and a transcript in
// a temporary Claude folder.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { claudeProjectDir } from "../src/conversation/claude.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "5a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-send-file-"));
const work = join(root, "lifelog");
const release = join(work, "app", "build", "outputs", "apk", "release");
await mkdir(release, { recursive: true });
const apk = join(release, "LoreLog-0.3.14.apk");
await writeFile(apk, "apk bytes");
const notes = join(work, "release-notes.md");
await writeFile(notes, "# 0.3.14\n\nnotes");
const configDir = join(root, "claude");
const project = join(configDir, "projects", claudeProjectDir(work));
await mkdir(project, { recursive: true });

const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 9, 0, seconds)).toISOString();
const assistant = (seconds, stop, content) => ({ type: "assistant", timestamp: at(seconds), message: { role: "assistant", stop_reason: stop, content } });
const result = (seconds, id, content) => ({ type: "user", timestamp: at(seconds), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
await writeFile(join(project, `${SESSION}.jsonl`), jsonl([
  { type: "user", uuid: "u1", parentUuid: null, timestamp: at(0), message: { role: "user", content: "build the release" } },
  assistant(2, "tool_use", [{ type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "./gradlew assembleRelease" } }]),
  result(20, "toolu_build", "BUILD SUCCESSFUL"),
  assistant(21, "tool_use", [
    { type: "text", text: "Built it; here it is." },
    { type: "tool_use", id: "toolu_send", name: "SendUserFile", input: {
      files: [apk, notes], caption: "0.3.14 — keeps capturing **while playing**", status: "normal", display: "attach" } },
  ]),
  result(22, "toolu_send", `2 files delivered to user.\n  ${apk} → file_uuid: 366a\n  ${notes} → file_uuid: 9b1c`),
  assistant(23, "end_turn", [{ type: "text", text: "Install it over the old one." }]),
  { type: "user", uuid: "u2", parentUuid: null, timestamp: at(30), message: { role: "user", content: "send it again" } },
  assistant(31, "tool_use", [{ type: "tool_use", id: "toolu_odd", name: "SendUserFile", input: { files: apk } }]),
  result(32, "toolu_odd", "files must be an array"),
  assistant(33, "end_turn", [{ type: "text", text: "That did not go." }]),
]));

const snapshot = JSON.parse(await readFile(new URL("../test/fixtures/fake-state.template.json", import.meta.url), "utf8")).snapshot;
const claudePane = snapshot.panes.find((pane) => pane.pane_id === "w1:p1");
Object.assign(claudePane, { agent: "claude", cwd: work, agent_session: { agent: "claude", kind: "id", value: SESSION } });
snapshot.agents.find((agent) => agent.pane_id === "w1:p1").state = "done";

const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    setTimeout(() => options.onData("\x1b[?1049hready terminal\r\n$ "), 10);
    return { write() {}, resize() {}, pause() {}, resume() {}, exited: new Promise(() => {}), kill() {} };
  },
});
const herdr = { async snapshot() { return snapshot; }, async readPane() { return "$ "; }, async sendText() {}, async sendKeys() {} };
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.SEND_FILE_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      // Playwright's own service-worker block in the viewer's sandboxed frame
      if (/serviceWorker.*sandboxed/u.test(error.message)) return;
      errors.push(error.message);
    });
    const chat = page.locator('.chat-pane[data-pane-id="w1:p1"]');
    const openChat = async () => {
      if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
      await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
      if (await page.locator(".terminal-stage").getAttribute("data-lens") !== "chat") await page.locator("#lens-chat").click();
      await chat.locator(".chat-files").first().waitFor({ state: "visible" });
    };
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await openChat();

    // One card, beside the answer and not in the folded work.
    const turn = chat.locator(".chat-turn-agent").first();
    const card = turn.locator(".chat-files");
    assert.equal(await chat.locator(".chat-files").count(), 1, "only the call that delivered reads as a card");
    assert.equal(await turn.locator(".work-block .chat-files").count(), 0, "the card is not inside the work");
    assert.match(await turn.locator(".work-block-head").textContent(), /^Worked for \d+s\s*· 1 command$/u, "the delivery is not counted as work");
    assert.equal(await turn.locator(".work-block-head").getAttribute("aria-expanded"), "false");
    assert.equal(await card.locator(".chat-files-head").textContent(), "Sent you 2 files");
    assert.match(await card.locator(".chat-files-caption strong").textContent(), /while playing/u);
    const order = await turn.evaluate((node) => [...node.children].map((child) => child.className));
    assert.deepEqual(order.slice(0, 4), ["work-block", "markdown", "chat-files", "markdown"], "the card sits in its place among the answer");
    assert.deepEqual(await card.locator(".chat-file-name").allTextContents(), ["LoreLog-0.3.14.apk", "release-notes.md"]);
    assert.deepEqual(await card.locator(".chat-file-folder").allTextContents(), [`${release}/`, `${work}/`]);
    assert.deepEqual(await card.locator("button.chat-file").evaluateAll((nodes) => nodes.map((node) => node.dataset.path)), [apk, notes]);
    // the phone's narrow card wraps a long folder rather than scrolling sideways
    const overflow = await card.evaluate((node) => node.scrollWidth - node.clientWidth);
    assert.ok(overflow <= 1, `the card fits its width (${overflow}px over)`);
    if (shots) await card.screenshot({ path: join(shots, `send-file-${mobile ? "phone" : "desktop"}.png`) });

    // An input the card cannot read stays an ordinary tool row in the work.
    const odd = chat.locator(".chat-turn-agent").nth(1);
    await odd.locator(".work-block-head").click();
    assert.match(await odd.locator(".work-row-name").textContent(), /^SendUserFile$/u);

    // The .apk opens in the Files tab, in its folder with its row selected.
    await card.locator("button.chat-file").first().click();
    const row = page.locator('.browse-row[data-selected="true"]');
    await page.waitForFunction((path) => document.querySelector('.browse-row[data-selected="true"]')?.dataset.path === path, apk, { timeout: 15_000 });
    assert.equal(await page.locator("#tab-files").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#file-path").inputValue(), release);
    assert.equal(await row.isVisible(), true);
    if (mobile) assert.equal(await page.evaluate(() => document.body.classList.contains("sidebar-open")), true, "the phone's sidebar is open");

    // The note opens in the viewer.
    await page.evaluate(() => { document.querySelector("#tab-sessions").click(); });
    await openChat();
    await card.locator("button.chat-file").nth(1).click();
    await page.locator("dialog[open]").first().waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    console.log({ mobile, card: true, outOfWork: true, caption: true, filesTab: true, viewer: true, oddInputRow: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
