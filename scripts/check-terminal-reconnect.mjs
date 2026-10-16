// Browser check of the strip that says why the terminal is not live. A normal
// connect shows nothing; a socket the server drops says so and offers
// Reconnect, which connects at once and takes the strip away; a pane that is
// gone, a Herdr that does not answer (with Reconnect), and a pane that can only
// be mirrored (quietly, without a button) each say their reason. Desktop and
// phone, against an in-process fake herdr; nothing reaches a real herdr.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ptys = [];
// Herdr not answering for w1:p4 until this is false.
let herdrSilent = true;
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => {
    if (paneId === "w1:p2") throw Object.assign(new Error("Pane not found"), { code: "pane_not_found" });
    if (paneId === "w1:p3") throw Object.assign(new Error("Terminals cannot attach on this PC (node-pty is unavailable)."), { code: "attach_unsupported" });
    if (paneId === "w1:p4" && herdrSilent) throw Object.assign(new Error("Herdr socket is unavailable"), { code: "server_unavailable" });
    return { command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` };
  },
  spawnPty: (options) => {
    let exit;
    const pty = { options, exited: new Promise((resolve) => { exit = resolve; }), write() {}, resize() {}, pause() {}, resume() {}, kill() { exit(); } };
    ptys.push(pty);
    setTimeout(() => options.onData("\x1b[?1049hattached screen\r\n$ "), 10);
    return pty;
  },
});
const pane = (id, label) => ({ pane_id: id, tab_id: "w1:t1", workspace_id: "w1", label, cwd: "/work" });
const { server } = createHerdrHttpServer({
  herdr: {
    async snapshot() {
      return {
        workspaces: [{ workspace_id: "w1", label: "Platform" }],
        tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Shells" }],
        panes: [pane("w1:p1", "Alpha"), pane("w1:p2", "Gone"), pane("w1:p3", "Mirror"), pane("w1:p4", "Silent")],
        agents: [],
      };
    },
    async readPane() { return "mirrored screen\n$ "; },
    async sendText() {},
    async sendKeys() {},
  },
  attachments,
  logger: { info() {}, error() {} },
});
// The terminal socket can be dropped, and refused while "down", as a server
// that restarts or a network that went away would.
const upgrades = new Set();
let socketDown = false;
server.prependListener("upgrade", (request, socket) => {
  if (socketDown) { socket.destroy(); return; }
  upgrades.add(socket);
  socket.once("close", () => upgrades.delete(socket));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    socketDown = false;
    herdrSilent = true;
    const page = await browser.newPage({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const strip = page.locator("#terminal-status");
    const reconnect = page.locator("#terminal-reconnect");
    const shows = (text) => page.waitForFunction((wanted) => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.replace(/ /gu, " ").includes(wanted), text);
    const says = (pattern) => page.waitForFunction((source) => {
      const element = document.querySelector("#terminal-status");
      return !element.hidden && new RegExp(source, "u").test(element.querySelector(".terminal-status-reason").textContent);
    }, pattern.source);
    const open = async (paneId) => {
      await page.goto(`${url}/?pane=${encodeURIComponent(paneId)}`);
      // The terminal lens, whatever the page would pick for this pane.
      await page.evaluate(() => document.querySelector("#lens-terminal")?.click());
    };

    // (d) A normal connect says nothing, not even after the quiet seconds.
    await open("w1:p1");
    await shows("attached screen");
    await page.waitForTimeout(3_500);
    assert.equal(await strip.isHidden(), true, "a live terminal shows no strip");

    // (a) The server drops the socket and refuses new ones: the strip says so
    // and counts down; Reconnect connects at once and the strip goes.
    socketDown = true;
    for (const socket of upgrades) socket.destroy();
    await says(/Disconnected from HerdRabbit/u);
    assert.equal(await reconnect.isVisible(), true, "a lost socket offers Reconnect");
    assert.equal(await strip.getAttribute("role"), "status");
    assert.equal(await strip.getAttribute("aria-live"), "polite");
    // The backoff has grown to seconds: a Reconnect that worked beats the wait.
    await says(/retrying in [3-5]s/u);
    socketDown = false;
    await reconnect.click();
    await strip.waitFor({ state: "hidden", timeout: 1_500 });
    await shows("attached screen");

    // (b) A pane that is gone says so, with nothing to retry.
    await open("w1:p2");
    await says(/^This pane is gone\.$/u);
    assert.equal(await reconnect.isHidden(), true, "a gone pane offers no Reconnect");

    // (c) A pane that can only be mirrored says so quietly, without a button.
    await open("w1:p3");
    await shows("mirrored screen");
    await says(/^Shown read-only: this PC can't attach terminals\.$/u);
    assert.equal(await reconnect.isHidden(), true, "a mirror offers no Reconnect");
    assert.equal(await strip.evaluate((element) => element.classList.contains("is-quiet")), true);

    // Herdr not answering: Reconnect tries the pane again at once.
    await open("w1:p4");
    await says(/Herdr is not answering — retrying in \ds/u);
    assert.equal(await reconnect.isVisible(), true);
    herdrSilent = false;
    await reconnect.click();
    await strip.waitFor({ state: "hidden", timeout: 2_000 });
    await shows("attached screen");

    // The Chat lens never shows the strip.
    herdrSilent = true;
    await open("w1:p4");
    await says(/Herdr is not answering/u);
    const chatShown = await page.evaluate(() => {
      document.querySelector(".terminal-stage").dataset.lens = "chat";
      return getComputedStyle(document.querySelector("#terminal-status")).display;
    });
    assert.equal(chatShown, "none", "the strip belongs to the Terminal lens");

    assert.deepEqual(errors, []);
    console.log({ mobile, quietConnect: true, droppedSocket: true, reconnect: true, paneGone: true, mirrorQuiet: true, herdrRetry: true, chatLens: true });
    await page.close();
  }
} finally {
  await browser.close();
  attachments.close();
  for (const socket of upgrades) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
