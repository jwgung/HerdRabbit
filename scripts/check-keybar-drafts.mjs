// Browser check of the editable extra-keys bar and the per-pane drafts (7a).
// Keys: the bar is edited in the "Edit keys" window (a custom Ctrl+R added, PgUp
// removed, Enter moved first -- dragged on a desktop, arrow buttons on a
// phone), draws again at once, survives a reload, a saved combination sends its
// own chord to the pane while the Shift/Ctrl/Alt latches keep working, PgDn
// pages the history unless Shift is held, a held Ctrl also takes a letter from
// a phone keyboard (composed or plain) without leaving it in the draft,
// removing a latched modifier's button drops it, and
// "Reset to default" brings the old bar back. Drafts: text typed in one pane
// is kept when another is opened and when the page is reloaded, goes when the
// message is sent, and a password answer leaves no copy. Runs on a phone and a
// desktop against an in-process fake herdr; nothing reaches a real herdr.
//
// KEYBAR_SCREENSHOTS=<folder> keeps pictures of the window in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    let exit;
    herdr.screen = (text) => options.onData(text);
    const pty = { options, exited: new Promise((resolve) => { exit = resolve; }), write() {}, resize() {}, pause() {}, resume() {}, kill() { exit(); } };
    setTimeout(() => options.onData(herdr.asking ? "\x1b[?1049h$ sudo true\r\n[sudo] password for me: " : "\x1b[?1049hready terminal\r\n$ "), 10);
    return pty;
  },
});

const herdr = {
  sent: [],
  asking: false,
  async snapshot() {
    return {
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Shells" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Alpha", cwd: "/work/alpha" },
        { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "Beta", cwd: "/work/beta" },
      ],
      agents: [],
    };
  },
  async readPane() { return herdr.asking ? "[sudo] password for me:" : "$ "; },
  async sendText(paneId, text, options = {}) { herdr.sent.push({ paneId, text, submit: options.submit === true }); },
  async sendKeys(paneId, keys) { herdr.sent.push({ paneId, keys: [...keys] }); },
};
const keysSent = () => herdr.sent.filter((item) => item.keys).map((item) => item.keys.join(" "));

const { server } = createHerdrHttpServer({ herdr, attachments, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });

const DEFAULT_LABELS = ["Esc", "/", "−", "Home", "↑", "End", "PgUp", "Shift", "Tab", "Ctrl", "Alt", "←", "↓", "→", "PgDn", "Enter"];
try {
  for (const mobile of [false, true]) {
    herdr.sent.length = 0;
    herdr.asking = false;
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const input = page.locator("#terminal-input");
    const bar = page.locator("#quick-keys");
    // On a phone the sidebar is closed: open it to reach its foot.
    const openKeyEditor = async () => {
      const settings = page.locator(".settings-button");
      const onScreen = () => settings.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth;
      });
      await page.waitForTimeout(400); // a sidebar that was closing has settled
      if (!(await onScreen())) {
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForFunction(() => {
          const box = document.querySelector(".settings-button").getBoundingClientRect();
          return box.left >= 0 && box.right <= window.innerWidth;
        });
      }
      await page.waitForTimeout(400); // and one that was opening
      await settings.click();
      await page.locator('.settings-menu [data-action="keys"]').click();
    };
    const barLabels = () => bar.locator("button").allTextContents();
    const dialog = page.locator("#key-bar-dialog");
    const stored = (key) => page.evaluate((name) => localStorage.getItem(name), key);
    const shoot = async (name) => {
      if (!process.env.KEYBAR_SCREENSHOTS) return;
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(300); // let the theme's colour transitions finish
        await page.screenshot({ path: join(process.env.KEYBAR_SCREENSHOTS, `${name}-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    };
    const openPane = async (id) => {
      if (mobile) await page.locator("#mobile-sidebar-open").click();
      await page.locator(`.pane-button[data-pane-id="${id}"]`).click();
      await page.waitForFunction((paneId) => document.querySelector(`.pane-button[data-pane-id="${paneId}"]`)?.getAttribute("aria-pressed") === "true", id);
    };
    const waitDraft = (paneId, text) => page.waitForFunction(({ paneId, text }) => {
      const stored = JSON.parse(localStorage.getItem("herdrbridge-composer-drafts") || "{}");
      return (stored[paneId]?.text ?? "") === text;
    }, { paneId, text }, { timeout: 5_000 });

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#quick-keys button"));

    // The default bar is the old one, with an Edit keys control after it.
    assert.deepEqual(await barLabels(), DEFAULT_LABELS);
    // the editor opens from the foot of the sidebar; the bar holds only keys
    assert.equal(await bar.locator("[data-key-bar-edit], .key-bar-edit").count(), 0);
    assert.equal(await page.locator(".settings-button").getAttribute("aria-label"), "Settings");
    const barBox = await bar.boundingBox();
    assert.ok(barBox.x + barBox.width <= (mobile ? 390 : 1280) + 1, "the bar fits the width");
    await page.locator('.pane-button[data-pane-id="w1:p1"], #mobile-sidebar-open').first().waitFor();

    // Open the window, add Ctrl+R, remove PgUp, move Enter first.
    await openKeyEditor();
    await dialog.waitFor({ state: "visible" });
    assert.equal(await dialog.locator(".key-bar-item").count(), 16);
    await shoot("window");
    await page.locator("#key-bar-combo-key").selectOption("character");
    assert.equal(await page.locator("#key-bar-combo-add").isDisabled(), true, "no character yet");
    await page.locator("#key-bar-combo-char").fill("ab");
    assert.equal(await page.locator("#key-bar-combo-preview").textContent(), "Enter one character.");
    await page.locator("#key-bar-combo-char").fill("r");
    await page.locator('[data-combo-modifier="ctrl"]').click();
    assert.equal(await page.locator("#key-bar-combo-preview").textContent(), "Ctrl+R");
    await page.locator("#key-bar-combo-add").click();
    assert.equal(await page.locator("#key-bar-combo-add").isDisabled(), true, "the same combination cannot be added twice");
    await page.locator('[data-combo-modifier="ctrl"]').click();
    await page.locator('[data-combo-modifier="shift"]').click();
    await page.locator('[data-combo-modifier="ctrl"]').click();
    await page.locator("#key-bar-combo-char").fill("z");
    await page.locator("#key-bar-combo-add").click();
    await page.locator("#key-bar-combo-key").selectOption("f5");
    await page.locator("#key-bar-combo-add").click(); // Ctrl+Shift+F5
    await dialog.locator('button[aria-label="Remove PgUp"]').click();
    if (mobile) {
      const up = dialog.locator('button[aria-label="Move up Enter"]');
      while (await up.isEnabled()) await up.click();
    } else {
      // Real mouse events, with the rows in view first: the window scrolls.
      const rowOf = (name) => dialog.locator(".key-bar-item", { has: page.locator(".key-bar-cap", { hasText: new RegExp(`^${name}$`, "u") }) });
      await rowOf("Enter").scrollIntoViewIfNeeded();
      const from = await rowOf("Enter").locator(".key-bar-cap").boundingBox();
      await page.mouse.move(from.x + 4, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 6, from.y - 4, { steps: 3 });
      await dialog.locator(".key-bar-item").first().scrollIntoViewIfNeeded();
      const to = await dialog.locator(".key-bar-item").first().boundingBox();
      await page.mouse.move(to.x + 30, to.y + 3, { steps: 8 });
      await page.mouse.up();
    }
    const expected = ["Enter", "Esc", "/", "−", "Home", "↑", "End", "Shift", "Tab", "Ctrl", "Alt", "←", "↓", "→", "PgDn", "Ctrl+R", "Ctrl+Shift+Z", "Ctrl+Shift+F5"];
    assert.deepEqual(await barLabels(), expected, "the bar draws the new layout at once");
    assert.deepEqual(await dialog.locator(".key-bar-item .key-bar-cap").allTextContents(), expected);
    assert.equal(await dialog.locator('button[aria-label="Move up Enter"]').isDisabled(), true);
    await shoot("window-edited");
    await page.locator("#key-bar-close").click();
    await dialog.waitFor({ state: "hidden" });

    // Saved, and back after a reload.
    assert.match(await stored("herdrbridge-key-bar"), /ctrl/u);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#quick-keys button"));
    assert.deepEqual(await barLabels(), expected, "the layout survives a reload");

    // Keys: a saved combination sends its own chord; latches and plain keys still work.
    herdr.sent.length = 0;
    await bar.locator("button", { hasText: /^Ctrl\+R$/u }).click();
    await page.waitForFunction(() => document.querySelector("#action-feedback")?.textContent === "");
    await bar.locator("button", { hasText: /^Ctrl\+Shift\+Z$/u }).click();
    await bar.locator("button", { hasText: /^Alt$/u }).click();
    assert.equal(await bar.locator('[data-modifier="alt"]').getAttribute("aria-pressed"), "true");
    await bar.locator("button", { hasText: /^Ctrl\+R$/u }).click(); // exact chord: the held Alt is not added
    await bar.locator("button", { hasText: /^Esc$/u }).click();
    await bar.locator('[data-modifier="shift"]').click();
    await bar.locator("button", { hasText: /^Tab$/u }).click();
    await bar.locator("button", { hasText: /^Enter$/u }).click();
    await page.waitForFunction(() => document.querySelector('#quick-keys [aria-pressed="true"]') === null);
    await page.waitForTimeout(200);
    assert.deepEqual(keysSent(), ["ctrl+r", "ctrl+shift+z", "ctrl+r", "esc", "shift+tab", "enter"]);
    assert.equal(await bar.locator('[aria-pressed="true"]').count(), 0, "latches are spent");

    // PgDn pages the history as the wheel does, sending no key; with Shift held
    // the plain key goes to the program.
    herdr.sent.length = 0;
    await page.evaluate(() => {
      window.wheelNotches = 0;
      document.addEventListener("wheel", () => { window.wheelNotches += 1; }, { capture: true });
    });
    await bar.locator("button", { hasText: /^PgDn$/u }).click();
    await page.waitForTimeout(200);
    assert.deepEqual(keysSent(), [], "PgDn sent a key instead of paging");
    assert.ok(await page.evaluate(() => window.wheelNotches) >= 1, "PgDn did not page the history");
    await bar.locator('[data-modifier="shift"]').click();
    await bar.locator("button", { hasText: /^PgDn$/u }).click();
    await page.waitForFunction(() => document.querySelector('#quick-keys [aria-pressed="true"]') === null);
    await page.waitForTimeout(100);
    assert.deepEqual(keysSent(), ["pagedown"], "Shift+PgDn is the plain key");

    // A held Ctrl takes the next letter from a phone keyboard too, which composes
    // it (Gboard) or types it plainly; the letter does not stay in the draft.
    const cdp = await context.newCDPSession(page);
    for (const composed of [true, false]) {
      herdr.sent.length = 0;
      await input.fill("half a draft");
      await bar.locator('[data-modifier="ctrl"]').click();
      await input.focus();
      if (composed) await cdp.send("Input.imeSetComposition", { text: "c", selectionStart: 1, selectionEnd: 1 });
      await cdp.send("Input.insertText", { text: "c" });
      await page.waitForFunction(() => document.querySelector('#quick-keys [data-modifier="ctrl"]').getAttribute("aria-pressed") === "false");
      await page.waitForTimeout(100);
      assert.deepEqual(keysSent(), ["ctrl+c"], `${composed ? "composed" : "plain"} letter with Ctrl`);
      assert.equal(await input.inputValue(), "half a draft", `${composed ? "composed" : "plain"} letter stayed in the draft`);
    }
    // Ctrl takes one composed letter; the keyboard then starts afresh, and the
    // next letter is ordinary typing again.
    herdr.sent.length = 0;
    await input.fill("half a draft");
    await bar.locator('[data-modifier="ctrl"]').click();
    await input.focus();
    await cdp.send("Input.imeSetComposition", { text: "c", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "a", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "a" });
    await page.waitForTimeout(200);
    assert.deepEqual(keysSent(), ["ctrl+c"], "a composed letter with Ctrl, then another");
    assert.equal(await input.inputValue(), "half a drafta", "the letter after the key was lost, or the key's stayed");

    // A Korean syllable composed with Ctrl held is text, not a key.
    herdr.sent.length = 0;
    await input.fill("");
    await bar.locator('[data-modifier="ctrl"]').click();
    await input.focus();
    await cdp.send("Input.imeSetComposition", { text: "ㄱ", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "가", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "가" });
    await page.waitForTimeout(200);
    assert.deepEqual(keysSent(), [], "a Korean syllable with Ctrl was sent as a key");
    assert.equal(await input.inputValue(), "가");
    assert.equal(await bar.locator('[data-modifier="ctrl"]').getAttribute("aria-pressed"), "true", "Ctrl is still held for the next key");
    await bar.locator('[data-modifier="ctrl"]').click();
    await input.fill("");

    // A pasted letter with Ctrl held is text, not a key.
    herdr.sent.length = 0;
    await input.fill("");
    await bar.locator('[data-modifier="ctrl"]').click();
    await input.evaluate((field) => {
      field.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", data: "c", bubbles: true, cancelable: true }));
      field.value = "c";
      field.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: "c", bubbles: true }));
    });
    await page.waitForTimeout(200);
    assert.deepEqual(keysSent(), [], "a pasted letter with Ctrl was sent as a key");
    assert.equal(await input.inputValue(), "c");
    await bar.locator('[data-modifier="ctrl"]').click();
    await input.fill("");

    // Without a held modifier a composed letter is ordinary typing.
    herdr.sent.length = 0;
    await input.fill("half a draft");
    await input.focus();
    await cdp.send("Input.imeSetComposition", { text: "c", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "c" });
    await page.waitForTimeout(200);
    assert.deepEqual(keysSent(), [], "a composed letter without a modifier was sent as a key");
    assert.equal(await input.inputValue(), "half a draftc", "a composed letter without a modifier was lost");
    // Alt takes a composed letter the same way.
    herdr.sent.length = 0;
    await input.fill("");
    await bar.locator('[data-modifier="alt"]').click();
    await input.focus();
    await cdp.send("Input.imeSetComposition", { text: "b", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "b" });
    await page.waitForFunction(() => document.querySelector('#quick-keys [data-modifier="alt"]').getAttribute("aria-pressed") === "false");
    await page.waitForTimeout(100);
    assert.deepEqual(keysSent(), ["alt+b"], "composed letter with Alt");
    assert.equal(await input.inputValue(), "", "composed letter with Alt stayed in the draft");
    await input.fill("");

    // Removing a latched modifier's button drops the latch.
    await bar.locator('[data-modifier="alt"]').click();
    await openKeyEditor();
    await dialog.locator('button[aria-label="Remove Alt"]').click();
    await page.locator("#key-bar-close").click();
    assert.equal(await bar.locator('[data-modifier="alt"]').count(), 0);
    assert.equal(await bar.locator('[aria-pressed="true"]').count(), 0);

    // Reset to default.
    await openKeyEditor();
    await page.locator("#key-bar-reset").click();
    assert.deepEqual(await barLabels(), DEFAULT_LABELS);
    assert.equal(await stored("herdrbridge-key-bar"), null);
    await page.locator("#key-bar-close").click();

    // Drafts: per pane, kept over a switch and a reload, gone once sent.
    if (mobile) await page.locator("#mobile-sidebar-open").isVisible();
    await input.fill("draft for alpha");
    await openPane("w1:p2");
    assert.equal(await input.inputValue(), "", "the other pane starts empty");
    await input.fill("draft for beta");
    await openPane("w1:p1");
    assert.equal(await input.inputValue(), "draft for alpha");
    await openPane("w1:p2");
    assert.equal(await input.inputValue(), "draft for beta");
    await openPane("w1:p1");
    await waitDraft("w1:p1", "draft for alpha");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#terminal-input"));
    await page.waitForFunction(() => document.querySelector("#terminal-input").value !== "");
    assert.equal(await input.inputValue(), "draft for alpha", "the draft survives a reload");
    await openPane("w1:p2");
    assert.equal(await input.inputValue(), "draft for beta");

    // Sending clears that pane's draft only, in the box and in storage.
    herdr.sent.length = 0;
    await input.press(mobile ? "Control+Enter" : "Enter");
    if (mobile) await page.locator(".send-button").click().catch(() => {});
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "", null, { timeout: 5_000 });
    assert.ok(herdr.sent.some((item) => item.paneId === "w1:p2" && item.text === "draft for beta"), "the text went to the pane");
    const draftsAfter = JSON.parse(await stored("herdrbridge-composer-drafts"));
    assert.equal(draftsAfter["w1:p2"], undefined, "the sent pane's draft is gone");
    assert.equal(draftsAfter["w1:p1"].text, "draft for alpha", "the other pane's draft stays");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#terminal-input"));
    await page.waitForTimeout(400);
    assert.equal(await input.inputValue(), "", "a sent draft does not come back");
    await openPane("w1:p1");
    assert.equal(await input.inputValue(), "draft for alpha");

    // A password answer leaves no copy anywhere.
    await openPane("w1:p2");
    herdr.asking = true;
    await input.fill("hunter2-secret");
    await input.press(mobile ? "Control+Enter" : "Enter");
    if (mobile) await page.locator(".send-button").click().catch(() => {});
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "", null, { timeout: 5_000 });
    herdr.asking = false;
    await page.waitForTimeout(500);
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify({ ...localStorage })), /hunter2/u, "no password in storage");
    await openPane("w1:p1");
    await openPane("w1:p2");
    assert.equal(await input.inputValue(), "");

    // The pane's screen asks for a password: what is typed is never written as
    // a draft, not after the typing pause, nor on a pane switch, nor on pagehide.
    await openPane("w1:p1");
    herdr.asking = true;
    await openPane("w1:p2");
    await page.waitForFunction(() => document.querySelector("#terminal-xterm")?.textContent.includes("password for me"), null, { timeout: 8_000 });
    await input.fill("typed-at-prompt-xyz");
    await page.waitForTimeout(700); // longer than the typing pause
    const noCopy = async (why) => assert.doesNotMatch(await page.evaluate(() => JSON.stringify({ ...localStorage })), /typed-at-prompt-xyz/u, why);
    await noCopy("not after the typing pause");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await noCopy("not on pagehide");
    // The prompt leaves the screen but the text is unchanged: it stays unwritten.
    herdr.screen("\x1b[2J\x1b[H$ ");
    await page.waitForFunction(() => !document.querySelector("#terminal-xterm")?.textContent.includes("password for me"), null, { timeout: 8_000 });
    await page.waitForTimeout(700);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await noCopy("not once the prompt is gone, for the same text");
    await openPane("w1:p1");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await noCopy("not on a pane switch");
    await openPane("w1:p2");
    assert.equal(await input.inputValue(), "typed-at-prompt-xyz", "kept in memory for the visit");
    herdr.asking = false;
    await input.fill("");

    assert.deepEqual(errors, [], "no script errors");
    await context.close();
    console.log(`ok: ${mobile ? "phone" : "desktop"}`);
  }
} finally {
  await browser.close();
  server.close();
  attachments.close?.();
}
process.exit(0);
