// Browser check of the attached terminal: xterm shows herdr's stream, typing
// reaches the pty, a held pane offers "Open here", and a pane that cannot
// attach is mirrored from its polled screen. Runs against a fake herdr.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const snapshot = JSON.parse(await readFile(new URL("../test/fixtures/fake-state.template.json", import.meta.url), "utf8")).snapshot;
const ptys = [];
let held = false;
let screenText = "screen text view\n$ ";
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  // w2:p1 stands for a pane that cannot attach (another server's, for now).
  resolveTerminal: async (paneId) => {
    if (paneId === "w2:p1") throw Object.assign(new Error("Terminal attach is not available for this server yet"), { code: "attach_unsupported" });
    return { command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` };
  },
  spawnPty: (options) => {
    let exit;
    const pty = {
      options, written: "", sizes: [], exited: new Promise((resolve) => { exit = resolve; }),
      // Typing `exit` ends the attach, as a pane whose program quit does.
      write(data) {
        this.written += data;
        if (this.written.endsWith("exit\r")) { exit(); options.onExit(0); return; }
        options.onData(data === "\r" ? "\r\n$ " : data);
      },
      resize(cols, rows) { this.sizes.push([cols, rows]); },
      pause() {}, resume() {},
      // herdr frees the pane's attach slot once this attach has exited.
      kill() { exit(); },
    };
    ptys.push(pty);
    setTimeout(() => {
      if (held && !options.args.includes("--takeover")) {
        options.onData("\x1b[?1049l\x1b[?25h\x1b[0 qherdr: terminal attach failed: terminal already has an attached client; retry with --takeover\r\n");
        options.onExit(1);
      } else {
        options.onData("\x1b[?1049hready 한글 /tmp/notes.md\r\n$ ");
      }
    }, 10);
    return pty;
  },
});
const { server } = createHerdrHttpServer({
  herdr: {
    async snapshot() { return snapshot; },
    async readPane() { return screenText; },
    async sendText() {},
    async sendKeys() {},
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
    held = false;
    const page = await browser.newPage({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    // xterm separates cells with no-break spaces: match the text, not the words.
    const shows = (text) => page.waitForFunction((wanted) => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.replace(/\u00a0/gu, " ").includes(wanted), text);
    await shows("ready 한글");
    assert.equal(await page.locator("#terminal-message").isHidden(), true, "the message gives way to xterm");
    await page.locator("#terminal-xterm .xterm").click();
    await page.keyboard.type("echo hi");
    await page.keyboard.press("Enter");
    await shows("echo hi");
    assert.equal(ptys[0].written, "echo hi\r");
    // Ctrl+Enter is a line feed, as in a native terminal, not a second Enter
    await page.keyboard.press("Control+Enter");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ptys[0].written, "echo hi\r\n");
    ptys[0].written = "echo hi\r";
    assert.ok(ptys[0].sizes.length > 0 || ptys[0].options.cols > 0, "the pty follows the browser's size");

    // Hidden, the page lets its socket go; shown again, it attaches the same pane anew.
    const setHidden = (hidden) => page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
    await setHidden(true);
    await page.waitForTimeout(300);
    await setHidden(false);
    await page.waitForTimeout(500);
    assert.equal(ptys.length, 2, "attached again after coming back");
    await shows("ready 한글");

    // An answer to a password prompt is not kept in the composer's history.
    screenText = "$ sudo true\n[sudo] password for alice: ";
    await page.locator("#terminal-input").fill("hunter2");
    await page.locator(".send-button").click();
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    screenText = "$ ";
    await page.locator("#terminal-input").fill("plain message");
    await page.locator(".send-button").click();
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    const history = await page.evaluate(() => localStorage.getItem("herdrbridge-input-history") || "");
    assert.ok(!history.includes("hunter2"), "the password is not in the input history");
    assert.ok(history.includes("plain message"));
    screenText = "screen text view\n$ ";

    // Another pane from the sidebar: the first is left, the second attached.
    if (mobile) await page.locator("#mobile-sidebar-toggle, .mobile-sidebar-toggle, [aria-label='Open sidebar']").first().click().catch(() => {});
    // p2 shares a split session with p1: its row is in the session's pane list.
    {
      const paneList = page.locator('.tab-group:has(.pane-button[data-pane-id="w1:p2"]) .split-disclosure');
      if (await paneList.getAttribute("aria-expanded") === "false") await paneList.click();
    }
    await page.locator('.pane-button[data-pane-id="w1:p2"]').click();
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("ready"));
    await page.waitForTimeout(100);
    assert.equal(ptys.at(-1).options.args.at(-1), "term_w1:p2");

    // The attach ends: the pane is mirrored from its polled screen meanwhile.
    await page.locator("#terminal-xterm .xterm").click();
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await shows("screen text view");

    // A pane another client holds: the banner offers to take it.
    held = true;
    await page.evaluate(() => { history.replaceState(null, "", "?pane=w1%3Ap2"); });
    await page.reload();
    await page.locator("#terminal-held").waitFor({ state: "visible" });
    await page.locator("#terminal-take-over").click();
    await page.waitForFunction(() => document.querySelector("#terminal-held").hidden);
    assert.ok(ptys.some((pty) => pty.options.args.includes("--takeover")));

    // A pane that cannot attach is mirrored read-only in xterm.
    held = false;
    await page.evaluate(() => { history.replaceState(null, "", "?pane=w2%3Ap1"); });
    await page.reload();
    await shows("screen text view");
    assert.equal(await page.locator("#terminal-message").isHidden(), true);
    const before = ptys.length;
    await page.locator("#terminal-xterm .xterm").click();
    await page.keyboard.type("ignored");
    await page.waitForTimeout(200);
    assert.equal(ptys.length, before, "typing in a mirror attaches nothing");
    assert.deepEqual(errors, []);
    console.log({ mobile, attached: true, typing: true, backgroundReturn: true, secretNotKept: true, paneSwitch: true, endedFallback: true, heldTakeOver: true, fallback: true });
    await page.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
}
