// Browser check of typing on a phone. With the keyboard put away, a key-bar
// tap lets go of the focused input, so the keyboard does not come back; with
// it up, the input keeps focus. A shorter screen with nothing focused (a split
// screen) is no keyboard, and the terminal fits it. While the keyboard is up (the visible height shrinks) the page
// fits what is left, so the composer and key bar sit above the keyboard. The
// terminal keeps its rows and shows its foot, and the pane is not resized
// when the keyboard comes or goes. A desktop window made shorter still resizes
// the pane.
//
// The composer's Enter: on the phone an on-screen keyboard's Enter is a new
// line, and once a physical keyboard types a letter Enter sends; Shift+Enter
// is a new line; the Enter setting (new line / send) overrides; an input
// method's Enter never sends. On the desktop Enter and Shift+Enter send,
// Ctrl+Enter is a new line, as before. Runs against an in-process fake herdr; nothing
// reaches a real herdr.
//
// PHONE_KEYBOARD_SHOTS=<folder> keeps pictures with the keyboard up and down.
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ptys = [];
const sent = [];
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    let exit;
    const pty = { options, sizes: [], exited: new Promise((resolve) => { exit = resolve; }), write() {}, resize(cols, rows) { this.sizes.push([cols, rows]); }, pause() {}, resume() {}, kill() { exit(); } };
    ptys.push(pty);
    // A full screen, its prompt on the last row.
    setTimeout(() => options.onData(`\x1b[?1049h${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\r\n")}\r\n$ prompt-at-the-foot`), 10);
    return pty;
  },
});
const { server } = createHerdrHttpServer({
  herdr: {
    async snapshot() {
      return {
        workspaces: [{ workspace_id: "w1", label: "Platform" }],
        tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Shells" }],
        panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Alpha", cwd: "/work/alpha" }],
        agents: [],
      };
    },
    async readPane() { return "$ "; },
    async sendText(paneId, text) { sent.push(text); },
    async sendKeys() {},
  },
  attachments,
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.PHONE_KEYBOARD_SHOTS;

const lastSize = () => {
  const pty = ptys.at(-1);
  return pty.sizes.at(-1) ?? [pty.options.cols, pty.options.rows];
};

// What Enter in the composer did: "sent" what was typed, or left it with a
// new line at the end.
async function enterDoes(page, press) {
  const input = page.locator("#terminal-input");
  await input.focus();
  const before = sent.length;
  await press();
  await page.waitForTimeout(300);
  if (sent.length > before) {
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    return { sent: sent.slice(before) };
  }
  return { value: await input.inputValue() };
}

async function clearComposer(page) {
  await page.locator("#terminal-input").evaluate((node) => {
    node.value = "";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function checkEnter(page, mobile) {
  const typeSoft = (text) => page.keyboard.insertText(text); // no keydown, as an on-screen keyboard
  if (!mobile) {
    await clearComposer(page);
    assert.deepEqual(await enterDoes(page, async () => { await page.keyboard.type("one"); await page.keyboard.press("Control+Enter"); }), { value: "one\n" }, "desktop Ctrl+Enter");
    assert.deepEqual(await enterDoes(page, async () => { await page.keyboard.type("two"); await page.keyboard.press("Enter"); }), { sent: ["one\ntwo"] }, "desktop Enter");
    assert.deepEqual(await enterDoes(page, async () => { await page.keyboard.type("three"); await page.keyboard.press("Shift+Enter"); }), { sent: ["three"] }, "desktop Shift+Enter still sends");
    return;
  }
  const reload = async (mode) => {
    await page.evaluate((value) => value ? localStorage.setItem("herdrBridge.enterKey.v1", value) : localStorage.removeItem("herdrBridge.enterKey.v1"), mode);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("prompt-at-the-foot"));
    await clearComposer(page);
  };

  // Auto (the default): an on-screen keyboard's Enter is a new line.
  await reload(null);
  assert.deepEqual(await enterDoes(page, async () => { await typeSoft("soft"); await page.keyboard.press("Enter"); }), { value: "soft\n" }, "on-screen Enter");
  // A soft-keyboard-style keydown (keyCode 229, key Unidentified) does not count as a physical keyboard.
  const cdp = await page.context().newCDPSession(page);
  await page.locator("#terminal-input").focus();
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Unidentified", code: "", windowsVirtualKeyCode: 229 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Unidentified", code: "", windowsVirtualKeyCode: 229 });
  assert.deepEqual(await enterDoes(page, async () => { await typeSoft("x"); await page.keyboard.press("Enter"); }), { value: "soft\nx\n" }, "Enter after a 229 keydown");
  // A physical key (a letter with its code) turns Enter into send; Shift+Enter stays a new line.
  assert.deepEqual(await enterDoes(page, async () => { await page.keyboard.type("k"); await page.keyboard.press("Shift+Enter"); }), { value: "soft\nx\nk\n" }, "physical Shift+Enter");
  assert.deepEqual(await enterDoes(page, async () => { await page.keyboard.type("m"); await page.keyboard.press("Enter"); }), { sent: ["soft\nx\nk\nm"] }, "physical Enter");
  // An input method's Enter never sends: keyCode 229 (trusted), or isComposing.
  await typeSoft("한");
  assert.deepEqual(await enterDoes(page, async () => {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229 });
  }), { value: "한" }, "Enter with keyCode 229");
  const composingEnter = (isComposing) => page.locator("#terminal-input").evaluate((node, composing) => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: composing, bubbles: true, cancelable: true }));
  }, isComposing);
  assert.deepEqual(await enterDoes(page, () => composingEnter(true)), { value: "한" }, "Enter while composing");
  // The same event without composition reaches the handler and sends.
  assert.deepEqual(await enterDoes(page, () => composingEnter(false)), { sent: ["한"] }, "control: Enter not composing");
  await cdp.detach();

  // New line: Enter stays a new line even from a physical keyboard; Ctrl+Enter sends.
  await reload("newline");
  assert.deepEqual(await enterDoes(page, async () => { await page.keyboard.type("hw"); await page.keyboard.press("Enter"); }), { value: "hw\n" }, "new line setting");
  assert.deepEqual(await enterDoes(page, () => page.keyboard.press("Control+Enter")), { sent: ["hw\n"] }, "Ctrl+Enter on touch (the new line typed before goes too)");

  // Send: Enter sends without any physical key seen; Shift+Enter is a new line.
  await reload("send");
  assert.deepEqual(await enterDoes(page, async () => { await typeSoft("s"); await page.keyboard.press("Shift+Enter"); }), { value: "s\n" }, "send setting Shift+Enter");
  assert.deepEqual(await enterDoes(page, async () => { await typeSoft("t"); await page.keyboard.press("Enter"); }), { sent: ["s\nt"] }, "send setting Enter");
  await reload(null);
}

try {
  for (const mobile of [true, false]) {
    ptys.length = 0;
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("prompt-at-the-foot"));
    await page.waitForTimeout(400);
    const before = lastSize();
    const where = mobile ? "phone" : "desktop";

    const focusedId = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
    if (mobile) {
      // The keyboard was put away but the composer kept focus: a key-bar tap
      // lets go of it, so the keyboard is not brought back.
      await page.locator("#terminal-input").focus();
      await page.locator("#quick-keys button", { hasText: /^Esc$/u }).tap();
      assert.notEqual(await focusedId(), "terminal-input", "a key-bar tap kept the put-away keyboard's input");
      if (shots) await page.screenshot({ path: join(shots, "keyboard-down.png") });
    }

    // The keyboard comes up: the visible height drops.
    await page.locator("#terminal-input").focus();
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 480 });
    await page.waitForTimeout(500);
    const layout = await page.evaluate(() => {
      const host = document.querySelector("#terminal-xterm").getBoundingClientRect();
      const xterm = document.querySelector("#terminal-xterm .xterm").getBoundingClientRect();
      const composer = document.querySelector("#terminal-input").getBoundingClientRect();
      const keys = document.querySelector("#quick-keys").getBoundingClientRect();
      return { hostBottom: host.bottom, xtermBottom: xterm.bottom, composerBottom: composer.bottom, keysBottom: keys.bottom,
        open: document.querySelector("#terminal-xterm").classList.contains("is-keyboard-open"), height: innerHeight, scrollY };
    });
    if (mobile) {
      assert.equal(layout.open, true, "the terminal did not notice the keyboard");
      assert.deepEqual(lastSize(), before, "the pane was resized for the keyboard");
      assert.ok(Math.abs(layout.xtermBottom - layout.hostBottom) <= 2, `the terminal's foot is hidden: ${JSON.stringify(layout)}`);
      assert.ok(layout.composerBottom <= layout.height && layout.keysBottom <= layout.height, `the composer is under the keyboard: ${JSON.stringify(layout)}`);
      assert.equal(layout.scrollY, 0, "the page is scrolled");
      // With the keyboard up, a key-bar tap leaves the typing where it was.
      await page.locator("#quick-keys button", { hasText: /^Esc$/u }).tap();
      assert.equal(await focusedId(), "terminal-input", "a key-bar tap dropped the open keyboard");
      if (shots) await page.screenshot({ path: join(shots, "keyboard-up.png") });
    } else {
      assert.equal(layout.open, false, "a shorter desktop window is no keyboard");
      assert.ok(lastSize()[1] < before[1], "a shorter desktop window did not resize the pane");
    }

    // The keyboard goes: the full height and the old size again.
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 844 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#terminal-xterm").evaluate((host) => host.classList.contains("is-keyboard-open")), false);
    assert.deepEqual(lastSize(), before, `${where}: the size after the keyboard went`);

    if (mobile) {
      // A shorter screen with nothing being typed (a split screen) is no
      // keyboard: the terminal fits it.
      await page.evaluate(() => document.activeElement?.blur());
      await page.setViewportSize({ width: 390, height: 480 });
      await page.waitForTimeout(500);
      assert.equal(await page.locator("#terminal-xterm").evaluate((host) => host.classList.contains("is-keyboard-open")), false, "a split screen taken for a keyboard");
      assert.ok(lastSize()[1] < before[1], "a split screen did not resize the pane");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);
    }

    await checkEnter(page, mobile);

    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    await context.close();
    console.log(`ok: ${where}`);
  }
} finally {
  await browser.close();
  server.close();
}
