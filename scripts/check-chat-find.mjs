// Browser check of find in the conversation: Ctrl+F over the Chat lens (the
// header button on a phone) opens the bar, typing marks the matches in the
// drawn turns and counts them, Enter / Shift+Enter and the arrows step up and
// down with the current match marked apart and scrolled into view (a folded
// code block unfolds for it), the bar offers the earlier page that is not
// loaded, and Esc takes every mark out, leaving the turns as they were.
// Ctrl+F from the composer stays the browser's; over the Terminal lens the
// same button is the terminal's find; switching lens closes the chat's bar.
// Runs against a fake herdr and a transcript in a temporary Claude folder.
// SHOTS=<dir> saves screenshots of the open bar (desktop dark, phone light).
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

const SESSION = "5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const CWD = "/work/chat-find";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-chat-find-"));
const configDir = join(root, "claude");
const project = join(configDir, "projects", claudeProjectDir(CWD));
await mkdir(project, { recursive: true });

const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const at = (n, seconds = 0) => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + n * 60_000 + seconds * 1000).toISOString();
const longCode = Array.from({ length: 40 }, (_, line) => (line === 34 ? "print('needle here')" : `print(${line})`)).join("\n");
// Where "needle" is: the page read first holds exchanges 20-69 (50 prompts),
// the earlier page 0-19.
const answers = {
  5: "Answer 5 mentions the needle early on.",
  40: "A needle in answer 40.",
  55: "Answer 55 has `needle` in code.",
  65: "Answer 65 with **nee**dle split across bold.",
  69: `Answer 69 with a long block:\n\n\`\`\`python\n${longCode}\n\`\`\``,
};
const exchange = (n) => [
  { type: "user", uuid: `u${n}`, parentUuid: null, timestamp: at(n), message: { role: "user", content: n === 50 ? "find the needle please" : `prompt ${n}` } },
  { type: "assistant", timestamp: at(n, 2), message: { role: "assistant", stop_reason: "tool_use", content: [
    { type: "text", text: `Looking at step ${n}.` },
    { type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: `ls step-${n}`, description: "List the step" } },
  ] } },
  { type: "user", timestamp: at(n, 3), message: { role: "user", content: [
    { type: "tool_result", tool_use_id: `toolu_${n}`, content: `step-${n}.txt` },
  ] } },
  { type: "assistant", timestamp: at(n, 9), message: { role: "assistant", stop_reason: "end_turn", content: [
    { type: "text", text: answers[n] ?? `Answer ${n} with **bold** and \`code\`.` },
  ] } },
];
await writeFile(join(project, `${SESSION}.jsonl`), jsonl(Array.from({ length: 70 }, (_, n) => exchange(n)).flat()));

const snapshot = JSON.parse(await readFile(new URL("../test/fixtures/fake-state.template.json", import.meta.url), "utf8")).snapshot;
const claudePane = snapshot.panes.find((pane) => pane.pane_id === "w1:p1");
Object.assign(claudePane, { agent: "claude", cwd: CWD, agent_session: { agent: "claude", kind: "id", value: SESSION } });
snapshot.agents.find((agent) => agent.pane_id === "w1:p1").state = "done";

const ptys = [];
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    const pty = { options, written: "", write(data) { this.written += data; }, resize() {}, pause() {}, resume() {}, kill() {} };
    ptys.push(pty);
    setTimeout(() => options.onData("\x1b[?1049hready terminal\r\n$ "), 10);
    return pty;
  },
});
const herdr = {
  async snapshot() { return snapshot; },
  async readPane() { return "screen\n$ "; },
  async sendText() {},
  async sendKeys() {},
  async paneFind() { return { total: 0, current: null, match: null, matches: [], content_revision: 1, scroll: null }; },
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
const shots = process.env.SHOTS || null;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      colorScheme: mobile ? "light" : "dark", viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const bar = page.locator("#chat-find");
    const input = page.locator("#chat-find-input");
    const count = page.locator("#chat-find-count");
    const button = page.locator("#terminal-find-open");
    const hasCount = (text) => { const where = new Error().stack.split("\n")[2]; return page.waitForFunction((wanted) => document.querySelector("#chat-find-count").textContent === wanted, text, { timeout: 5000 }).catch(async (error) => { throw new Error(`count ${JSON.stringify(await count.textContent())}, wanted ${text} ${where}: ${error.message}`); }); };
    // The current match: its text, whether it shows inside the chat's view,
    // and the turn it is in.
    const current = () => page.evaluate(() => {
      const marks = [...document.querySelectorAll(".chat-find-mark.is-current")];
      if (marks.length === 0) return null;
      const view = marks[0].closest(".chat-scroll").getBoundingClientRect();
      const box = marks[0].getBoundingClientRect();
      const bar = document.querySelector("#chat-find").getBoundingClientRect();
      return {
        text: marks.map((mark) => mark.textContent).join(""),
        pieces: marks.length,
        visible: box.height > 0 && box.top >= view.top && box.bottom <= view.bottom,
        clearOfBar: box.top >= bar.bottom || box.bottom <= bar.top,
        turn: marks[0].closest(".chat-turn")?.textContent.match(/Answer \d+|find the needle|A needle/u)?.[0] ?? null,
        unfolded: marks[0].closest(".md-code")?.classList.contains("is-expanded") ?? null,
      };
    });
    const turnHtml = () => page.evaluate(() => [...document.querySelectorAll(".chat-turns > .chat-turn")]
      .filter((turn) => /Answer 65|Answer 55|find the needle|A needle/u.test(turn.textContent)).map((turn) => turn.outerHTML));

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    if (!mobile) await page.locator("#lens-chat").click();
    await page.locator(".chat-turn-agent").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector(".chat-turns")?.textContent.includes("Answer 69"));
    const untouched = await turnHtml();
    assert.equal(untouched.length, 4);
    await button.waitFor({ state: "visible" });
    assert.match(await button.getAttribute("title"), /Find in conversation/u);

    if (!mobile) {
      // Ctrl+F over the chat opens the bar, not the browser's find.
      await page.locator(".chat-scroll").first().click({ position: { x: 20, y: 20 } });
      await page.keyboard.press("Control+f");
      await bar.waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "chat-find-input");
    } else {
      await button.click();
      await bar.waitFor({ state: "visible" });
    }
    assert.equal(await button.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#terminal-find").isHidden(), true);
    assert.equal(await page.locator(".chat-find-mark").count(), 0);
    // The earlier page is not loaded, and the bar says so.
    await page.locator("#chat-find-more").waitFor({ state: "visible" });

    await input.fill("needle");
    // starts from the bottom: the last match, in a folded code block, unfolded for it
    await hasCount("5/5");
    let now = await current();
    assert.deepEqual([now.text, now.turn, now.unfolded], ["needle", "Answer 69", true]);
    assert.ok(now.visible, "the current match shows in the view");
    assert.equal(await page.locator(".chat-find-mark").count(), 6, "one match across the bold edge is two marks");

    await input.press("Enter");
    await hasCount("4/5");
    now = await current();
    assert.deepEqual([now.text, now.pieces, now.turn], ["needle", 2, "Answer 65"]);
    assert.ok(now.visible && now.clearOfBar, "scrolled into view, clear of the bar");
    if (shots) await page.screenshot({ path: join(shots, mobile ? "chat-find-phone-light.png" : "chat-find-desktop-dark.png") });

    await page.locator("#chat-find-older").click();
    await hasCount("3/5");
    assert.equal((await current()).turn, "Answer 55");
    await input.press("Shift+Enter");
    await hasCount("4/5");
    await page.locator("#chat-find-newer").click();
    await hasCount("5/5");
    await page.locator("#chat-find-newer").click();
    await hasCount("1/5");
    now = await current();
    assert.equal(now.turn, "A needle");
    assert.ok(now.visible);
    // smart case: a capital matches only itself
    await input.fill("Needle");
    await hasCount("No matches");
    // a new search starts from the view, now up at the first match
    await input.fill("needle");
    await hasCount("1/5");
    for (const step of ["2/5", "3/5", "4/5"]) {
      await input.press("Shift+Enter");
      await hasCount(step);
    }

    // The earlier page, loaded from the bar: its match is counted, and the
    // current match stays where it was.
    await page.locator("#chat-find-load").click();
    await hasCount("5/6");
    assert.equal((await current()).turn, "Answer 65");
    await page.locator("#chat-find-more").waitFor({ state: "hidden" });
    await page.locator("#chat-find-older").click();
    await hasCount("4/6");

    // Esc: no marks, and the turns are as they were drawn.
    await input.press("Escape");
    await bar.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".chat-find-mark").count(), 0);
    assert.deepEqual(await turnHtml(), untouched);
    assert.equal(await button.getAttribute("aria-expanded"), "false");

    if (!mobile) {
      // Ctrl+F from the composer is the browser's own, not the bar's.
      await page.evaluate(() => {
        window.findPrevented = null;
        document.addEventListener("keydown", (event) => {
          if (event.key.toLowerCase() === "f" && event.ctrlKey) window.findPrevented = event.defaultPrevented;
        });
      });
      await page.locator("#terminal-input").focus();
      await page.keyboard.press("Control+f");
      await page.waitForFunction(() => window.findPrevented !== null);
      assert.equal(await page.evaluate(() => window.findPrevented), false);
      assert.equal(await bar.isHidden(), true);
    }

    // Switching to the Terminal lens closes the chat's bar; there the button is the terminal's find.
    await button.click();
    await bar.waitFor({ state: "visible" });
    await input.fill("needle");
    await page.waitForFunction(() => /^\d\/6$/u.test(document.querySelector("#chat-find-count").textContent));
    await page.locator("#lens-terminal").click();
    await bar.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".chat-find-mark").count(), 0);
    await page.waitForFunction(() => document.querySelector("#terminal-find-open").title.startsWith("Find in terminal"));
    await button.click();
    await page.locator("#terminal-find").waitFor({ state: "visible" });
    assert.equal(await bar.isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-find-input");
    await page.locator("#terminal-find-input").press("Escape");
    await page.locator("#terminal-find").waitFor({ state: "hidden" });

    assert.deepEqual(errors, []);
    console.log({ mobile, opened: true, counted: true, stepped: true, unfolded: true, olderLoaded: true,
      closedClean: true, composerKeptCtrlF: !mobile, terminalFindKept: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
