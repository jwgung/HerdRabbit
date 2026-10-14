// Browser check of find in the terminal: Ctrl+F opens the bar over an
// attached terminal, typing searches the pane's history on the server, Enter
// and Shift+Enter step older and newer from the last match, the matches on
// screen are marked, Esc closes it; a phone opens it from the header button;
// Ctrl+F from the composer is the browser's; a mirrored pane has no find.
// Runs against a fake herdr whose find answers as herdr 0.9.3's copy search
// does and whose "scroll" redraws the attached screen.
// SHOTS=<dir> saves screenshots of the open bar (desktop dark, phone light).
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const snapshot = JSON.parse(await readFile(new URL("../test/fixtures/fake-state.template.json", import.meta.url), "utf8")).snapshot;
const ptys = [];
// The screen herdr draws for the view: "needle" on rows 1 and 3.
const SCREEN = "\x1b[?1049h\x1b[H\x1b[2Jready\r\nalpha needle one\r\nbeta\r\nneedle two\r\n$ ";
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => {
    if (paneId === "w2:p1") throw Object.assign(new Error("Terminal attach is not available"), { code: "attach_unsupported" });
    return { command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` };
  },
  spawnPty: (options) => {
    const pty = {
      options, written: "",
      write(data) { this.written += data; },
      resize() {}, pause() {}, resume() {}, kill() {},
    };
    ptys.push(pty);
    setTimeout(() => options.onData(SCREEN), 10);
    return pty;
  },
});

// Herdr's find, as the page sees it through the route: 17 matches, the
// current one alternating between the two rows on screen.
const finds = [];
let ordinal = 0;
const herdr = {
  async snapshot() { return snapshot; },
  async readPane() { return "mirrored screen\n$ "; },
  async sendText() {},
  async sendKeys() {},
  async paneFind(paneId, request) {
    finds.push([paneId, request]);
    if (request.query === "zzz") return { total: 0, current: null, match: null, matches: [], content_revision: 7, scroll: null };
    ordinal = request.previous ? (request.direction === "backward" ? ordinal - 1 : ordinal + 1) : 3;
    const onRowOne = ordinal % 2 === 1;
    const match = onRowOne ? { start: { row: 101, col: 6 }, end: { row: 101, col: 11 } } : { start: { row: 103, col: 0 }, end: { row: 103, col: 5 } };
    // herdr scrolled its view; the attach redraws the screen.
    ptys.at(-1)?.options.onData(SCREEN);
    return {
      total: 17, current: ordinal, match, matches: [match], content_revision: 7,
      scroll: { offset_from_bottom: 20, max_offset_from_bottom: 120, viewport_rows: 30 },
    };
  },
};
const { server } = createHerdrHttpServer({ herdr, attachments, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.SHOTS || null;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    ptys.length = 0;
    finds.length = 0;
    const page = await browser.newPage({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      colorScheme: mobile ? "light" : "dark", viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("needle"));
    const bar = page.locator("#terminal-find");
    const count = page.locator("#terminal-find-count");
    const button = page.locator("#terminal-find-open");
    await button.waitFor({ state: "visible" });
    assert.equal(await button.getAttribute("aria-disabled"), "false");

    if (!mobile) {
      // Ctrl+F from the terminal opens the bar, and does not reach the program as ^F.
      await page.locator("#terminal-xterm .xterm").click();
      await page.keyboard.press("Control+f");
      await bar.waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-find-input");
      assert.equal(ptys.at(-1).written.includes("\x06"), false, "^F stayed out of the terminal");
    } else {
      await button.click();
      await bar.waitFor({ state: "visible" });
      assert.equal(await button.getAttribute("aria-expanded"), "true");
    }

    await page.locator("#terminal-find-input").fill("needle");
    await page.waitForFunction(() => document.querySelector("#terminal-find-count").textContent === "3/17");
    assert.deepEqual(finds[0], ["w1:p1", { query: "needle", direction: "backward", previous: null, contentRevision: null }]);
    // Both on-screen matches are marked, the current one apart.
    await page.waitForFunction(() => document.querySelectorAll(".terminal-find-marks span").length === 2 &&
      document.querySelectorAll(".terminal-find-marks span.is-current").length === 1);
    const current = await page.evaluate(() => {
      const mark = document.querySelector(".terminal-find-marks span.is-current");
      const screen = mark.closest(".xterm-screen");
      const term = screen.getBoundingClientRect();
      const box = mark.getBoundingClientRect();
      return { row: Math.round((box.top - term.top) / (screen.offsetHeight / document.querySelectorAll(".xterm-rows > div").length)) };
    });
    assert.equal(current.row, 1, "the current match is the one herdr named: row 101 - (120 - 20) = 1");

    if (shots) await page.screenshot({ path: join(shots, mobile ? "find-phone-light.png" : "find-desktop-dark.png") });

    // Enter steps older from the last match, Shift+Enter newer.
    await page.locator("#terminal-find-input").press("Enter");
    await page.waitForFunction(() => document.querySelector("#terminal-find-count").textContent === "2/17");
    assert.deepEqual(finds[1][1], {
      query: "needle", direction: "backward",
      previous: { start: { row: 101, col: 6 }, end: { row: 101, col: 11 } }, contentRevision: 7,
    });
    await page.waitForFunction(() => {
      const mark = document.querySelector(".terminal-find-marks span.is-current");
      return mark && mark.style.left === "0px";
    });
    await page.locator("#terminal-find-input").press("Shift+Enter");
    await page.waitForFunction(() => document.querySelector("#terminal-find-count").textContent === "3/17");
    assert.equal(finds[2][1].direction, "forward");
    await page.locator("#terminal-find-newer").click();
    await page.waitForFunction(() => document.querySelector("#terminal-find-count").textContent === "4/17");
    assert.equal(finds[3][1].direction, "forward");
    await page.locator("#terminal-find-older").click();
    await page.waitForFunction(() => document.querySelector("#terminal-find-count").textContent === "3/17");
    assert.equal(finds[4][1].direction, "backward");

    await page.locator("#terminal-find-input").fill("zzz");
    await page.waitForFunction(() => document.querySelector("#terminal-find-count").textContent === "No matches");
    assert.deepEqual(finds.at(-1)[1], { query: "zzz", direction: "backward", previous: null, contentRevision: null });

    // Esc closes it and the marks go.
    await page.locator("#terminal-find-input").press("Escape");
    await bar.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".terminal-find-marks span").count(), 0);
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

    // A mirrored pane has no find: the button says why and opens nothing.
    await page.evaluate(() => { history.replaceState(null, "", "?pane=w2%3Ap1"); });
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("mirrored screen"));
    await page.waitForFunction(() => document.querySelector("#terminal-find-open")?.getAttribute("aria-disabled") === "true");
    assert.match(await button.getAttribute("title"), /copy of its screen/u);
    const before = finds.length;
    // aria-disabled keeps it focusable and its tooltip; Playwright would wait for it to enable.
    await button.click({ force: true });
    if (!mobile) {
      await page.locator("#terminal-xterm .xterm").click();
      await page.keyboard.press("Control+f");
    }
    await page.waitForTimeout(150);
    assert.equal(await bar.isHidden(), true);
    assert.equal(finds.length, before);

    assert.deepEqual(errors, []);
    console.log({ mobile, opened: true, counted: true, stepped: true, marked: true, closed: true, composerKeptCtrlF: !mobile, mirrorDisabled: true });
    await page.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
}
