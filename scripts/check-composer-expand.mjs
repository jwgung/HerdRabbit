// Browser check of the composer growing into a card, on a phone and on a
// desktop, in the Terminal and the Chat lens: a short text keeps the one row
// (Files, the text, the mic and Send side by side); a text that needs a second
// line, or holds a newline, turns the composer into a card with the text
// across its whole width and the buttons in a row below it (Files at the left,
// Send at the right edge). Deleting some of the text keeps the card; only an
// empty box (cleared or sent) folds it back. Once expanded nothing flips or
// moves for 500 ms without input. Dictated words (the speech module's own
// path, driven by a fake recognizer) expand it too. The `/` and `@` lists
// still open above the card. A very long text stops growing at about eight
// lines and scrolls. Runs against an in-process fake herdr, a transcript and a
// project in temporary folders.
// COMPOSER_EXPAND_SHOTS=<folder> keeps pictures, collapsed and expanded, in
// both themes.
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
import { SlashCommandCatalog } from "../src/slash-commands.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const SESSION = "6b8e7d2f-9b4c-4d66-8e3f-7a8b9c0d1e2f";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-composer-expand-"));
const project = join(root, "project");
await mkdir(join(project, "src"), { recursive: true });
await writeFile(join(project, "README.md"), "x");
await writeFile(join(project, "src", "app.js"), "x");
const configDir = join(root, "claude");
const transcripts = join(configDir, "projects", claudeProjectDir(project));
await mkdir(transcripts, { recursive: true });
const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 9, 0, seconds)).toISOString();
await writeFile(join(transcripts, `${SESSION}.jsonl`), [
  { type: "user", uuid: "u1", parentUuid: null, timestamp: at(0), message: { role: "user", content: "tidy the parser" } },
  { type: "assistant", timestamp: at(4), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
const home = join(root, "home");
await mkdir(home);
const protectedPaths = localProtectedPaths({ env: { HOME: home }, home, data: defaultDataPaths(home) });
const slashCommands = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }) });

const herdr = {
  sent: [],
  async snapshot() {
    return {
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Release" }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Claude", agent: "claude", cwd: project,
        foreground_cwd: project, agent_session: { agent: "claude", kind: "id", value: SESSION } }],
      agents: [{ pane_id: "w1:p1", agent: "claude", state: "idle" }],
    };
  },
  async readPane() { return "$ "; },
  async sendText(paneId, text) { herdr.sent.push({ paneId, text }); },
  async sendKeys(paneId, keys) { herdr.sent.push({ paneId, keys: [...keys] }); },
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
  slashCommands,
  conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.COMPOSER_EXPAND_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });

const SENTENCE = "The quick brown fox jumps over the lazy dog and keeps on running. ";
const LONG = SENTENCE.repeat(4).trim();

// The composer's parts, where they are on the screen.
function measure(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node || node.hidden || getComputedStyle(node).display === "none") return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const composer = document.querySelector(".input-composer");
    const input = document.querySelector("#terminal-input");
    return {
      expanded: composer.classList.contains("is-expanded"),
      composer: box(".input-composer"),
      text: box("#terminal-input"),
      attach: box("#attach-button"),
      dictate: box("#dictate-button"),
      send: box("#input-form .send-button"),
      scrolls: input.scrollHeight > input.clientHeight + 1,
      lineHeight: Number.parseFloat(getComputedStyle(input).lineHeight),
      viewport: innerHeight,
    };
  });
}

const near = (a, b, slack = 2) => Math.abs(a - b) <= slack;

function assertOneRow(layout, where) {
  assert.equal(layout.expanded, false, `${where}: collapsed`);
  const { text, attach, send, dictate } = layout;
  // the buttons sit beside the text, on its row
  assert.ok(attach.right <= text.left + 1, `${where}: Files left of the text ${JSON.stringify(layout)}`);
  assert.ok(send.left >= text.right - 1, `${where}: Send right of the text ${JSON.stringify(layout)}`);
  assert.ok(near(send.bottom, text.bottom) && near(attach.bottom, text.bottom), `${where}: same row ${JSON.stringify(layout)}`);
  assert.ok(near(send.top, text.top), `${where}: one row high ${JSON.stringify(layout)}`);
  if (dictate) assert.ok(dictate.left >= text.right - 1 && dictate.right <= send.left + 1, `${where}: the mic between the text and Send`);
}

function assertCard(layout, where) {
  assert.equal(layout.expanded, true, `${where}: expanded`);
  const { composer, text, attach, send, dictate } = layout;
  // the text across the whole card
  assert.ok(text.width >= composer.width - 20, `${where}: text spans the card ${JSON.stringify(layout)}`);
  assert.ok(near(text.left, composer.left, 10) && near(text.right, composer.right, 10), `${where}: text edge to edge`);
  // the buttons in a row below it: Files at the left, Send at the right
  for (const [name, button] of [["Files", attach], ["Send", send], ["mic", dictate]]) {
    if (!button) continue;
    assert.ok(button.top >= text.bottom - 1, `${where}: ${name} below the text ${JSON.stringify(layout)}`);
    assert.ok(button.width === 44, `${where}: ${name} keeps its size`);
  }
  assert.ok(near(attach.left, composer.left, 10), `${where}: Files at the left ${JSON.stringify(layout)}`);
  assert.ok(near(send.right, composer.right, 10), `${where}: Send at the right edge ${JSON.stringify(layout)}`);
  assert.ok(near(attach.top, send.top), `${where}: one button row`);
  if (dictate) assert.ok(dictate.right <= send.left + 1 && near(dictate.top, send.top), `${where}: the mic left of Send`);
}

// Nothing flips or moves for `ms` without input.
function stableFor(page, ms) {
  return page.evaluate((duration) => new Promise((resolve) => {
    const composer = document.querySelector(".input-composer");
    const parts = ["#terminal-input", "#attach-button", "#input-form .send-button", ".input-composer"];
    const snap = () => JSON.stringify(parts.map((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map(Math.round);
    }));
    const first = snap();
    const firstClass = composer.className;
    let flips = 0;
    let moved = null;
    const observer = new MutationObserver(() => { flips += 1; });
    observer.observe(composer, { attributes: true, attributeFilter: ["class"] });
    const started = performance.now();
    const tick = () => {
      const now = snap();
      if (now !== first && !moved) moved = now;
      if (performance.now() - started < duration) requestAnimationFrame(tick);
      else {
        observer.disconnect();
        resolve({ flips, moved, first, firstClass, lastClass: composer.className });
      }
    };
    requestAnimationFrame(tick);
  }), ms);
}

const expandedIs = (page, want) => page.waitForFunction(
  (value) => document.querySelector(".input-composer").classList.contains("is-expanded") === value, want, { timeout: 5_000 });

try {
  for (const mobile of [true, false]) {
    herdr.sent.length = 0;
    const where = mobile ? "phone" : "desktop";
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 } });
    // A recognizer under our control: the speech module's real path writes its words.
    await context.addInitScript(() => {
      window.SpeechRecognition = class {
        start() { window.fakeRecognizer = this; }
        stop() { this.onend?.(); }
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const input = page.locator("#terminal-input");
    const typeLong = async (text = LONG) => {
      await input.click();
      if (mobile) await page.keyboard.insertText(text);
      else await page.keyboard.type(text, { delay: 0 });
    };
    const clear = async () => { await input.fill(""); await expandedIs(page, false); };

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("ready terminal"));
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    if ((await page.locator(".terminal-stage").getAttribute("data-lens")) !== "terminal") await page.locator("#lens-terminal").click();

    for (const lens of ["terminal", "chat"]) {
      if (lens === "chat") {
        await page.locator("#lens-chat").click();
        await page.waitForFunction(() => document.querySelector(".terminal-stage").dataset.lens === "chat");
      }
      const at = `${where} ${lens}`;

      // A short text keeps the one row.
      await clear();
      await input.click();
      await page.keyboard.type("hello there");
      await page.waitForTimeout(100);
      assertOneRow(await measure(page), `${at} short`);
      if (shots && lens === "terminal") {
        for (const theme of ["dark", "light"]) {
          await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(shots, `${where}-${theme}-collapsed.png`) });
        }
      }

      // A long text expands, and stays put.
      await clear();
      await typeLong();
      await expandedIs(page, true);
      const stable = await stableFor(page, 500);
      assert.equal(stable.flips, 0, `${at}: the class flipped ${JSON.stringify(stable)}`);
      assert.equal(stable.moved, null, `${at}: the layout shifted ${JSON.stringify(stable)}`);
      const card = await measure(page);
      assertCard(card, `${at} long`);
      assert.equal(card.scrolls, false, `${at}: a four-sentence text needs no scrolling`);
      if (shots && lens === "terminal") {
        for (const theme of ["dark", "light"]) {
          await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(shots, `${where}-${theme}-expanded.png`) });
        }
      }

      // Deleting some of it keeps the card.
      for (let i = 0; i < 5; i += 1) await page.keyboard.press("Backspace");
      await input.evaluate((node) => {
        node.value = node.value.slice(0, 4);
        node.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(100);
      assert.equal((await measure(page)).expanded, true, `${at}: a shorter text folded the card`);
      const short = await stableFor(page, 500);
      assert.equal(short.flips, 0, `${at}: a short text in the card flipped ${JSON.stringify(short)}`);

      // Clearing folds it back to the same one row as before.
      await clear();
      await page.keyboard.type("hi");
      assertOneRow(await measure(page), `${at} after clearing`);

      // A newline expands.
      await clear();
      await page.keyboard.type("one");
      if (mobile) await page.keyboard.insertText("\ntwo");
      else { await page.keyboard.press("Control+Enter"); await page.keyboard.type("two"); }
      await expandedIs(page, true);
      assertCard(await measure(page), `${at} newline`);
      assert.equal(await input.inputValue(), "one\ntwo");

      // Sending folds it back.
      const before = herdr.sent.length;
      if (mobile) await page.locator("#input-form .send-button").click();
      else await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
      await expandedIs(page, false);
      assert.deepEqual(herdr.sent.slice(before).map((item) => item.text), ["one\ntwo"], `${at}: the text went`);
      await page.keyboard.type("hi");
      assertOneRow(await measure(page), `${at} after sending`);
      if (!mobile) assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-input", `${at}: focus back in the composer`);

      // A very long text grows to about eight lines (or 40% of the screen) and scrolls.
      await clear();
      await input.click();
      await page.keyboard.insertText(SENTENCE.repeat(30));
      await expandedIs(page, true);
      const tall = await measure(page);
      const limit = Math.min(tall.lineHeight * 8 + 24, tall.viewport * 0.4) + 3;
      assert.ok(tall.text.height <= limit, `${at}: the box stopped growing ${tall.text.height} <= ${limit}`);
      assert.ok(tall.text.height > tall.lineHeight * 4, `${at}: the box grew past one row ${tall.text.height}`);
      assert.equal(tall.scrolls, true, `${at}: the rest scrolls`);
      assertCard(tall, `${at} very long`);
    }

    // Dictation: the speech module's interim words expand the card, the final ones keep it.
    await clear();
    if (await page.locator("#dictate-button").isVisible()) {
      await page.locator("#dictate-button").click();
      await page.waitForFunction(() => Boolean(window.fakeRecognizer));
      await page.evaluate((text) => {
        const result = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
        window.fakeRecognizer.onresult({ resultIndex: 0, results: [result(text, false)] });
      }, LONG);
      await expandedIs(page, true);
      assertCard(await measure(page), `${where} dictated (interim)`);
      await page.evaluate((text) => {
        const result = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
        window.fakeRecognizer.onresult({ resultIndex: 0, results: [result(text, true)] });
      }, LONG);
      assert.equal((await measure(page)).expanded, true, `${where}: dictated (final)`);
      assert.equal(await input.inputValue(), LONG);
      await page.locator("#dictate-button").click();
    } else {
      throw new Error(`${where}: the mic is not shown with a recognizer`);
    }

    // The phone keyboard comes up (the visible height drops) over a tall card:
    // the card stays above it, no taller than 40% of what is left.
    if (mobile) {
      await page.locator("#lens-terminal").click();
      await page.waitForFunction(() => document.querySelector(".terminal-stage").dataset.lens === "terminal");
      await clear();
      await input.click();
      await page.keyboard.insertText(SENTENCE.repeat(30));
      await expandedIs(page, true);
      await page.setViewportSize({ width: 390, height: 480 });
      await page.waitForTimeout(500);
      const up = await measure(page);
      assert.equal(await page.locator("#terminal-xterm").evaluate((host) => host.classList.contains("is-keyboard-open")), true, "the keyboard was noticed");
      assert.ok(up.composer.bottom <= up.viewport + 1, `the card is under the keyboard ${JSON.stringify(up)}`);
      assert.ok(up.text.height <= up.viewport * 0.4 + 3, `the card takes over 40% of the screen left ${JSON.stringify(up)}`);
      assert.ok((await page.locator("#quick-keys").boundingBox()).y + 10 < up.composer.top, "the key bar stays above the card");
      assertCard(up, "phone keyboard up");
      if (shots) await page.screenshot({ path: join(shots, "phone-light-expanded-keyboard-up.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);
    }

    // The `@` list and the `/` list open above the card.
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await clear();
    await typeLong();
    await expandedIs(page, true);
    await page.keyboard.type(" @");
    await page.waitForFunction(() => !document.querySelector("#composer-files").hidden && document.querySelector(".composer-file"), null, { timeout: 5_000 });
    let popup = await page.evaluate(() => ({
      list: document.querySelector("#composer-files").getBoundingClientRect().toJSON(),
      card: document.querySelector(".input-composer").getBoundingClientRect().toJSON(),
    }));
    assert.ok(popup.list.bottom <= popup.card.top + 1 && popup.list.height > 20, `${where}: the @ list sits above the card ${JSON.stringify(popup)}`);
    assert.ok(near(popup.list.left, popup.card.left, 2) && near(popup.list.right, popup.card.right, 2), `${where}: the @ list as wide as the card`);
    if (shots) await page.screenshot({ path: join(shots, `${where}-dark-expanded-at-files.png`) });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#composer-files").hidden);

    await input.evaluate((node, text) => {
      node.value = ` ${text}`;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.focus();
      node.setSelectionRange(0, 0);
    }, LONG);
    await page.keyboard.type("/");
    await page.waitForFunction(() => !document.querySelector("#composer-files").hidden && document.querySelector(".composer-command"), null, { timeout: 5_000 });
    popup = await page.evaluate(() => ({
      expanded: document.querySelector(".input-composer").classList.contains("is-expanded"),
      list: document.querySelector("#composer-files").getBoundingClientRect().toJSON(),
      card: document.querySelector(".input-composer").getBoundingClientRect().toJSON(),
    }));
    assert.equal(popup.expanded, true);
    assert.ok(popup.list.bottom <= popup.card.top + 1 && popup.list.height > 20, `${where}: the / list sits above the card ${JSON.stringify(popup)}`);
    if (shots) await page.screenshot({ path: join(shots, `${where}-dark-expanded-slash.png`) });
    await page.keyboard.press("Escape");
    await clear();

    // A draft comes back with its pane: a long one as a card, after a reload.
    await typeLong();
    await expandedIs(page, true);
    await page.waitForTimeout(500); // the draft is stored
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#terminal-input").value.length > 0, null, { timeout: 8_000 });
    await expandedIs(page, true);
    await clear();

    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    await context.close();
    console.log(`ok: ${where}`);
  }
} finally {
  await browser.close();
  server.close();
  await rm(root, { recursive: true, force: true });
}
