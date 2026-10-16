// Browser check of quoting the terminal selection into the composer, on a
// desktop and on a phone: select text in the terminal, press Quote, and the
// composer holds it as a "> " block with a blank line after it and the caret
// at the end, the selection is gone, nothing went to the pane, the quote lands
// in the pane's own draft, and it goes in at the caret when there is one.
// Runs against an in-process fake herdr and a fake pty.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const snapshot = JSON.parse(await readFile(new URL("../test/fixtures/fake-state.template.json", import.meta.url), "utf8")).snapshot;
const ptys = [];
const sent = [];
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    const pty = {
      options, written: "", exited: new Promise(() => {}),
      write(data) { this.written += data; },
      resize() {}, pause() {}, resume() {}, kill() {},
    };
    ptys.push(pty);
    setTimeout(() => options.onData(`\x1b[?1049herror: build failed   \r\n  at main.js:3   \r\n$ `), 10);
    return pty;
  },
});
const { server } = createHerdrHttpServer({
  herdr: {
    async snapshot() { return snapshot; },
    async readPane() { return "$ "; },
    async sendText(paneId, text) { sent.push({ paneId, text }); },
    async sendKeys(paneId, keys) { sent.push({ paneId, keys: [...keys] }); },
  },
  attachments,
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    ptys.length = 0;
    sent.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const input = page.locator("#terminal-input");
    const quote = page.locator('.terminal-copy-bar button[aria-label="Quote in message"]');
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.replace(/\u00a0/gu, " ").includes("error: build failed"));
    const written = () => ptys.map((pty) => pty.written).join("");
    const before = written();

    // Drag over the first two rows (a phone's long press is the same drag to the page's mouse path here).
    const select = async () => {
      const rows = await page.evaluate(() => [...document.querySelectorAll("#terminal-xterm .xterm-rows > div")].slice(0, 2).map((row) => row.getBoundingClientRect().toJSON()));
      const screen = await page.evaluate(() => document.querySelector("#terminal-xterm .xterm-screen").getBoundingClientRect().toJSON());
      await page.mouse.move(screen.x + 2, rows[0].y + rows[0].height / 2);
      await page.mouse.down();
      await page.mouse.move(screen.x + 300, rows[1].y + rows[1].height / 2, { steps: 8 });
      await page.mouse.up();
      await quote.waitFor({ state: "visible" });
    };

    await select();
    assert.equal(await quote.getAttribute("aria-label"), "Quote in message");
    await quote.click();
    const expected = "> error: build failed\n>   at main.js:3\n\n";
    await page.waitForFunction((want) => document.querySelector("#terminal-input").value === want, expected);
    assert.deepEqual(await input.evaluate((el) => [el.selectionStart, el.selectionEnd]), [expected.length, expected.length], "caret after the quote");
    assert.equal(await page.locator(".terminal-copy-bar").isHidden(), true, "the selection bar went");
    assert.equal(await page.evaluate(() => getSelection().toString()), "");
    if (!mobile) assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-input", "the composer has focus on a desktop");
    else assert.notEqual(await page.evaluate(() => document.activeElement?.id), "terminal-input", "a phone's keyboard is not forced up");
    assert.equal(written(), before, "nothing was typed into the pane");
    assert.deepEqual(sent, [], "nothing was sent to the pane");

    // The draft is the pane's own and survives a reload.
    await page.waitForTimeout(100);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.replace(/\u00a0/gu, " ").includes("error: build failed"));
    assert.equal(await input.inputValue(), expected, "the quote stays in the pane's draft");

    // A quote that does not fit says so and keeps the selection, to copy or
    // quote again after making room.
    // (a small limit here stands in for a full 8,000-character draft)
    await input.evaluate((el) => { el.maxLength = 30; });
    const full = "almost full draft";
    await input.fill(full);
    await select();
    await quote.click();
    await page.waitForFunction(() => /does not fit/u.test(document.querySelector("#action-feedback")?.textContent ?? ""));
    assert.equal(await input.inputValue(), full, "a quote that does not fit went in anyway");
    assert.equal(await page.locator(".terminal-copy-bar").isVisible(), true, "the selection was dropped though nothing was quoted");
    await input.evaluate((el) => { el.maxLength = 8000; });
    await page.evaluate(() => getSelection().removeAllRanges());

    // A second quote goes in at the caret, set apart from the text before it.
    await input.fill("why?");
    await input.evaluate((el) => el.setSelectionRange(4, 4));
    await select();
    await quote.click();
    const second = "why?\n\n> error: build failed\n>   at main.js:3\n\n";
    await page.waitForFunction((want) => document.querySelector("#terminal-input").value === want, second);
    assert.deepEqual(await input.evaluate((el) => el.selectionStart), second.length);
    assert.deepEqual(sent, []);
    assert.deepEqual(errors, []);
    console.log({ mobile, quoted: true, caretAtEnd: true, selectionCleared: true, draftKept: true, nothingSent: true, keptOnFailure: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
}
