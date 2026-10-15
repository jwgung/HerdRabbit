// Browser check of the composer's Send button doubling as Stop, on a desktop
// and on a phone: while the Claude pane works in the Chat lens, the button is
// Send as long as the composer is focused (a press sends the draft, never Esc)
// and Stop once it is not (a press sends the key bar's Esc, "esc", and nothing
// else, the draft stays and Stop is busy for a moment, never Send). In the
// Terminal lens and once the agent is idle it stays Send. Esc in the composer
// stops as well, but not while the `@` file list is open (that Esc only closes
// the list). Runs against an in-process fake herdr and a transcript in a
// temporary Claude folder.
// CHAT_STOP_SCREENSHOTS=<folder> keeps pictures of the composer in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { claudeProjectDir } from "../src/conversation/claude.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { defaultDataPaths, localProtectedPaths } from "../src/protected-paths.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "5a7f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-chat-stop-"));
const project = join(root, "project");
await mkdir(project, { recursive: true });
await writeFile(join(project, "README.md"), "x");
const configDir = join(root, "claude");
const transcripts = join(configDir, "projects", claudeProjectDir(project));
await mkdir(transcripts, { recursive: true });
const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 9, 0, seconds)).toISOString();
await writeFile(join(transcripts, `${SESSION}.jsonl`), [
  { type: "user", uuid: "u1", parentUuid: null, timestamp: at(0), message: { role: "user", content: "refactor the parser" } },
  { type: "assistant", timestamp: at(4), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "On it." }] } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
const home = join(root, "home");
await mkdir(home);
const protectedPaths = localProtectedPaths({ env: { HOME: home }, home, data: defaultDataPaths(home) });

const herdr = {
  status: "working",
  sent: [],
  async snapshot() {
    return {
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Release" }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Claude", agent: "claude", cwd: project,
        foreground_cwd: project, agent_session: { agent: "claude", kind: "id", value: SESSION } }],
      agents: [{ pane_id: "w1:p1", agent: "claude", state: herdr.status }],
    };
  },
  async readPane() { return "$ "; },
  async sendText(paneId, text) { herdr.sent.push({ paneId, text }); },
  // a slow link: a key takes this long to reach the pane
  slowMs: 0,
  async sendKeys(paneId, keys) {
    if (herdr.slowMs) await new Promise((resolve) => setTimeout(resolve, herdr.slowMs));
    if (herdr.failKeys) throw new Error("herdr refused the key");
    herdr.sent.push({ paneId, keys: [...keys] });
  },
};
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    setTimeout(() => options.onData("\x1b[?1049hready terminal\r\n$ "), 10);
    return { write() {}, resize() {}, pause() {}, resume() {}, exited: new Promise(() => {}), kill() {} };
  },
});
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  protectedPaths,
  conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.CHAT_STOP_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];

try {
  for (const mobile of [false, true]) {
    herdr.status = "working";
    herdr.sent.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const input = page.locator("#terminal-input");
    const button = page.locator("#input-form .send-button");
    const keys = () => herdr.sent.filter((item) => item.keys).map((item) => item.keys);
    const texts = () => herdr.sent.filter((item) => item.text !== undefined).map((item) => item.text);
    const blur = () => page.evaluate(() => document.activeElement?.blur());
    const mode = (want) => page.waitForFunction((value) => document.querySelector("#input-form .send-button").dataset.mode === value,
      want, { timeout: 8_000 });
    const looksLike = async (want) => {
      await mode(want);
      assert.equal(await button.getAttribute("aria-label"), want === "stop" ? "Stop" : "Send");
      assert.equal(await button.getAttribute("title"), want === "stop" ? "Stop (Esc)" : "Send");
    };
    const ready = () => page.waitForFunction(() => !document.querySelector("#input-form .send-button").disabled, null, { timeout: 5_000 });
    const sentKeys = async (count) => {
      const deadline = Date.now() + 5_000;
      while (keys().length < count && Date.now() < deadline) await page.waitForTimeout(50);
      await page.waitForTimeout(300); // nothing more follows
      assert.deepEqual(keys(), Array.from({ length: count }, () => ["esc"]), "only the key bar's Esc went to the pane");
    };

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    if (!mobile) {
      // Desktop opens in Terminal: the key bar has Esc there, and the button stays Send.
      assert.equal(await page.locator(".terminal-stage").getAttribute("data-lens"), "terminal");
      await blur();
      await page.waitForTimeout(500);
      await looksLike("send");
      await page.locator("#lens-chat").click();
    }
    await page.locator('.chat-pane[data-pane-id="w1:p1"] .chat-working').waitFor({ state: "visible" });
    await blur();
    await looksLike("stop");
    assert.equal(await page.locator("#stop-button").count(), 0, "no separate Stop button");
    const box = await button.boundingBox();
    assert.ok(box.width >= 44, "Stop is a full-size button for a thumb");
    assert.equal(await page.evaluate(() => {
      const shown = (selector) => getComputedStyle(document.querySelector(`#input-form .send-button ${selector}`)).display !== "none";
      return shown(".stop-icon") && !shown(".send-icon-now");
    }), true, "Stop shows the square, not the arrow");
    if (shots) {
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(300);
        await page.locator(".input-composer").screenshot({ path: join(shots, `stop-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    }

    // In the composer the button is Send, and a press sends the draft, not Esc.
    await input.fill("hello there");
    await looksLike("send");
    await button.click();
    const deadline = Date.now() + 5_000;
    while (!texts().length && Date.now() < deadline) await page.waitForTimeout(50);
    assert.deepEqual(texts(), ["hello there"], "Send sent the draft");
    await sentKeys(0);
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "", null, { timeout: 5_000 });
    if (!mobile) {
      // A click on Send hands focus back to the composer: the button stays
      // Send, so a quick second click cannot stop what was just sent.
      await page.waitForFunction(() => document.activeElement?.id === "terminal-input", null, { timeout: 3_000 });
      await looksLike("send");
    }

    // Out of the composer a press sends one Esc, keeps the draft, and is busy for a moment.
    await input.fill("a draft that stays");
    await blur();
    await looksLike("stop");
    await button.click();
    await sentKeys(1);
    assert.equal(await input.inputValue(), "a draft that stays", "the draft is untouched");
    assert.equal(await button.isDisabled(), true, "busy right after a press");
    assert.equal(await button.getAttribute("aria-busy"), "true");
    // Back in the composer the button is Send at once, and never held by Stop.
    await input.focus();
    await looksLike("send");
    assert.equal(await button.isDisabled(), false, "a Stop in flight held Send");
    assert.equal(await button.getAttribute("aria-busy"), null);
    await blur();
    await ready();
    await looksLike("stop");
    // A second press sends Esc again (Claude may need it).
    await button.click();
    await sentKeys(2);
    await ready();

    // On a slow link Stop stays busy until its Esc has gone, so a second
    // press is never silently dropped.
    herdr.slowMs = 1_600;
    await button.click();
    await page.waitForTimeout(1_250);
    assert.equal(await button.isDisabled(), true, "Stop was ready again while its Esc was still on its way");
    await sentKeys(3);
    await ready();
    await button.click();
    await sentKeys(4);
    await ready();
    herdr.slowMs = 0;

    // A refused Esc says so, and Stop is ready again for another try.
    herdr.failKeys = true;
    await button.click();
    await ready();
    assert.equal(await button.getAttribute("aria-busy"), null, "Stop stayed busy after a refused Esc");
    assert.notEqual((await page.locator("#action-feedback").textContent()).trim(), "", "a refused Esc said nothing");
    herdr.failKeys = false;
    assert.deepEqual(texts(), ["hello there"], "Stop never sent the draft");

    // Esc in the composer stops too.
    await input.focus();
    await page.keyboard.press("Escape");
    await sentKeys(5);
    assert.equal(await input.inputValue(), "a draft that stays");
    await ready();

    // With the @ list open, Esc only closes the list.
    await input.fill("");
    await page.keyboard.type("@");
    await page.waitForFunction(() => !document.querySelector("#composer-files").hidden, null, { timeout: 5_000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#composer-files").hidden, null, { timeout: 5_000 });
    await sentKeys(5);
    await input.fill("");

    // In the Terminal lens the button stays Send out of the composer; the key bar has Esc there.
    await page.locator("#lens-terminal").click();
    await blur();
    await looksLike("send");
    await input.focus();
    await page.keyboard.press("Escape");
    await sentKeys(5);
    await page.locator("#lens-chat").click();
    await blur();
    await looksLike("stop");

    // Once the agent is idle the button is Send, and Esc in the composer sends nothing.
    herdr.status = "idle";
    await looksLike("send");
    await input.focus();
    await page.keyboard.press("Escape");
    await sentKeys(5);
    // And Stop comes back when it works again.
    herdr.status = "working";
    await blur();
    await looksLike("stop");

    assert.deepEqual(errors, [], "no page errors");
    results.push({ mobile, send: true, stop: true, again: true, slow: true, refused: true, escape: true, atList: true, terminal: true, idle: true });
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
