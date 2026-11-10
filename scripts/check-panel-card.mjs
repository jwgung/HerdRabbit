// Browser check of the panel card: a Claude pane herdr calls idle shows
// Claude Code's /usage panel (a real screen, test/fixtures/panel-screens.mjs).
// In the Chat lens the card sits over the composer with the panel's tabs, its
// text and its keys; → sends the key and the card shows the next tab; the
// composer says typing goes to the panel and a number is no answer; Esc
// closes the panel and the card goes. Over the Terminal lens a banner says
// the panel is open. Runs against an in-process fake herdr; nothing reaches a
// real herdr. PANEL_CARD_SCREENSHOTS=<folder> keeps pictures in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { fakePromptHerdr } from "../test/fixtures/claude-prompt.mjs";
import { claudeStatus, claudeUsage } from "../test/fixtures/panel-screens.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: [], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    let exit;
    const pty = { options, exited: new Promise((resolve) => { exit = resolve; }), write() {}, resize() {}, pause() {}, resume() {}, kill() { exit(); } };
    setTimeout(() => options.onData("\x1b[?1049hready terminal\r\n$ "), 10);
    return pty;
  },
});

function world() {
  const herdr = fakePromptHerdr({
    panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Claude", agent: "claude", agent_status: "idle" }],
    outputs: { "w1:p1": claudeUsage },
  });
  const snapshot = herdr.snapshot;
  herdr.snapshot = async () => ({ ...(await snapshot()), workspaces: [{ workspace_id: "w1", label: "Platform" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Release" }] });
  // the panel follows its keys: → shows the next tab, Esc closes it
  const sendKeys = herdr.sendKeys;
  herdr.sendKeys = async (paneId, keys) => {
    await sendKeys(paneId, keys);
    if (keys.includes("right") || keys.includes("left")) herdr.outputs[paneId] = herdr.outputs[paneId] === claudeUsage ? claudeStatus : claudeUsage;
    if (keys.includes("esc")) herdr.outputs[paneId] = "❯ /usage\n  ⎿  Usage dialog dismissed\n────────\n❯ \n────────\n";
  };
  return herdr;
}

let herdr = world();
// Every call goes to the current world, so each round starts afresh.
const outer = {
  snapshot: () => herdr.snapshot(),
  readPane: (...args) => herdr.readPane(...args),
  sendKeys: (...args) => herdr.sendKeys(...args),
  sendText: (...args) => herdr.sendText(...args),
};
const prompts = new PromptService({ herdr: outer, pollMs: 100, stepDelayMs: 5, lookMs: 20 });
const { server } = createHerdrHttpServer({ herdr: outer, attachments, prompts, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    herdr = world();
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile, viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const dockMode = () => page.locator("#prompt-dock").getAttribute("data-mode");
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    if (!mobile) {
      await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "banner");
      assert.equal(await page.locator(".prompt-banner-text").textContent(), "Claude has a panel open: Usage");
      assert.equal(await page.locator(".prompt-banner-action").textContent(), "Open");
      await page.locator(".prompt-banner-open").click();
    }
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "card");
    const card = page.locator(".prompt-card.is-panel");
    assert.equal(await card.locator("h2").textContent(), "Usage");
    assert.equal(await card.locator(".prompt-card-status").textContent(), "Claude · Settings · panel open");
    assert.deepEqual(await card.locator(".prompt-panel-tabs li").allTextContents(), ["Status", "Config", "Usage", "Stats"]);
    assert.equal(await card.locator(".prompt-panel-tabs li.is-selected").textContent(), "Usage");
    assert.match(await card.locator(".prompt-panel-screen").textContent(), /Current week \(all models\)/u);
    assert.deepEqual(await card.locator(".prompt-panel-key kbd").allTextContents(), ["←", "→", "Esc"]);
    // every key is on screen, over the composer, inside the card
    const keysBox = await card.locator(".prompt-panel-keys").boundingBox();
    const cardBox = await card.boundingBox();
    const composerBox = await page.locator("#input-form").boundingBox();
    assert.ok(keysBox.y + keysBox.height <= cardBox.y + cardBox.height + 1, "the keys are not cut off");
    assert.ok(cardBox.y + cardBox.height <= composerBox.y + 1, "the card sits above the composer");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways page scroll");
    const composer = page.locator("#terminal-input");
    assert.equal(await composer.getAttribute("placeholder"), "Typing goes to the open panel");
    await composer.fill("2");
    assert.equal(await card.locator(".is-previewed").count(), 0, "a number is no answer to a panel");
    await composer.fill("");
    if (process.env.PANEL_CARD_SCREENSHOTS) {
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.screenshot({ path: join(process.env.PANEL_CARD_SCREENSHOTS, `panel-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    }
    // → goes, and the card shows the next tab
    await card.locator(".prompt-panel-key", { hasText: "→" }).click();
    await page.waitForFunction(() => document.querySelector(".prompt-card.is-panel h2")?.textContent === "Status");
    assert.equal(await page.locator(".prompt-card-error").count(), 0);
    // twice in a row: a panel's key may go again at once
    await page.locator(".prompt-card.is-panel .prompt-panel-key", { hasText: "→" }).click();
    await page.waitForFunction(() => document.querySelector(".prompt-card.is-panel h2")?.textContent === "Usage");
    // Esc closes the panel, and the card goes
    await page.locator(".prompt-card.is-panel .prompt-panel-key", { hasText: "Esc" }).click();
    await page.waitForFunction(() => document.querySelector("#prompt-dock")?.dataset.mode === "hidden");
    assert.equal(await composer.getAttribute("placeholder"), "");
    assert.deepEqual(herdr.sent.map((item) => item.keys.join("+")), ["right", "right", "esc"]);
    assert.equal(await dockMode(), "hidden");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`panel card ok (${mobile ? "phone" : "desktop"})`);
  }
} finally {
  await browser.close();
  prompts.stop?.();
  server.close();
}
process.exit(0);
