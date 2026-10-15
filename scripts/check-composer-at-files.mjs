// Browser check of `@` file references in the composer, on a desktop and on a
// phone: typing `@` lists the pane's folder (folders first, hidden names only
// after a dot), typing narrows it, the arrows and Enter put a name in, a folder
// is entered and its contents offered, a name with a space goes in quoted,
// Escape closes the list without sending or closing anything else, Enter with
// the list open never sends, a tap picks a name, and a pane with no folder
// gets no list at all. The pane's folder is a temporary one made here; runs
// against an in-process fake herdr.
// ATFILES_SCREENSHOTS=<folder> keeps pictures of the list in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { defaultDataPaths, localProtectedPaths } from "../src/protected-paths.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = await mkdtemp(join(tmpdir(), "atfiles-"));
const project = join(root, "project");
await mkdir(join(project, "src", "lib"), { recursive: true });
await writeFile(join(project, "src", "app.js"), "x");
await writeFile(join(project, "src", "api.js"), "x");
await writeFile(join(project, "src", "lib", "util.js"), "x");
await mkdir(join(project, "my folder"));
await writeFile(join(project, "my folder", "inner note.md"), "x");
await writeFile(join(project, "README.md"), "x");
await writeFile(join(project, "package.json"), "x");
await writeFile(join(project, ".hidden-note"), "x");
const home = join(root, "home");
await mkdir(home);
const protectedPaths = localProtectedPaths({ env: { HOME: home }, home, data: defaultDataPaths(home) });

const herdr = {
  sent: [],
  // where the project pane's shell is now; a `cd` moves it
  foreground: null,
  async snapshot() {
    return {
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Shells" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Project", cwd: root, foreground_cwd: herdr.foreground ?? project },
        { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "Nowhere" },
        // a pane on another PC, at the same folder path as this one's
        { pane_id: "link_lab!w1:p1", tab_id: "link_lab!w1:t1", workspace_id: "link_lab!w1", label: "Lab", cwd: root, foreground_cwd: project, server_id: "link_lab" },
      ],
      agents: [],
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
    setTimeout(() => options.onData("\x1b[?1049hready\r\n$ "), 10);
    return { write() {}, resize() {}, pause() {}, resume() {}, exited: new Promise(() => {}), kill() {} };
  },
});
const { server } = createHerdrHttpServer({ herdr, attachments, protectedPaths, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.ATFILES_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });

try {
  for (const mobile of [false, true]) {
    herdr.sent.length = 0;
    const context = await browser.newContext({
      serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const input = page.locator("#terminal-input");
    const popup = page.locator("#composer-files");
    const names = () => popup.locator('[role="option"]').allTextContents();
    const shown = async (expected) => {
      await page.waitForFunction((want) => {
        const list = document.querySelector("#composer-files");
        const got = [...list.querySelectorAll('[role="option"]')].map((item) => item.textContent);
        return !list.hidden && JSON.stringify(got) === JSON.stringify(want);
      }, expected, { timeout: 5_000 }).catch(async () => {
        assert.deepEqual(await names(), expected, "the list shows");
      });
    };
    const closed = async () => {
      await page.waitForFunction(() => document.querySelector("#composer-files").hidden, null, { timeout: 5_000 });
      assert.equal(await input.getAttribute("aria-expanded"), "false");
    };
    const reset = async () => {
      await input.fill("");
      await closed();
    };

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("ready"));
    await input.click();

    // `@` lists the pane's folder: folders first, no hidden names
    await page.keyboard.type("@");
    await shown(["my folder/", "src/", "README.md", "package.json"]);
    assert.equal(await input.getAttribute("aria-expanded"), "true");
    assert.equal(await popup.getAttribute("role"), "listbox");
    const active = await input.getAttribute("aria-activedescendant");
    assert.equal(await page.locator(`#${active}`).getAttribute("aria-selected"), "true");
    if (shots) {
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots, `at-files-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    }

    // typing narrows it; arrows move; Enter puts the name in and does not send
    await page.keyboard.type("src/a");
    await shown(["api.js", "app.js"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "@src/app.js ");
    await closed();
    assert.deepEqual(herdr.sent, [], "picking a name sent nothing");

    // Tab accepts too, in the middle of other text
    await reset();
    await page.keyboard.type("look at @R");
    await shown(["README.md"]);
    await page.keyboard.press("Tab");
    assert.equal(await input.inputValue(), "look at @README.md ");
    await closed();

    // typed on before the list caught up: Enter puts nothing in and sends nothing
    await reset();
    await page.keyboard.type("@p");
    await shown(["package.json"]);
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "@px", "a stale list completed a reference typed on since");
    assert.deepEqual(herdr.sent, [], "Enter on a stale list sent the draft");

    // the pane's shell moved to another folder while the list was open: Enter
    // puts in nothing from the folder it left
    if (!mobile) {
      await reset();
      await page.keyboard.type("@R");
      await shown(["README.md"]);
      herdr.foreground = join(project, "src");
      await page.waitForTimeout(2_600);
      await page.keyboard.press("Enter");
      assert.equal(await input.inputValue(), "@R", "a name from the folder the pane left went in");
      herdr.foreground = null;
      await page.waitForTimeout(2_600);
    }

    // a name that would take the draft past the composer's limit is not put in
    if (!mobile) {
      const limit = Number(await input.getAttribute("maxlength"));
      const filler = "x".repeat(limit - 4);
      await input.fill(`${filler} @R`);
      await shown(["README.md"]);
      await page.keyboard.press("Enter");
      assert.equal(await input.inputValue(), `${filler} @R`, "a completion went past maxlength");
      await reset();
    }

    // a folder is entered and its contents offered at once; ArrowUp wraps to the last
    await reset();
    await page.keyboard.type("@s");
    await shown(["src/"]);
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "@src/");
    await shown(["lib/", "api.js", "app.js"]);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "@src/app.js ");

    // a name with a space goes in quoted, the folder too
    await reset();
    await page.keyboard.type("@my");
    await shown(["my folder/"]);
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), '@"my folder/"');
    await shown(["inner note.md"]);
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), '@"my folder/inner note.md" ');

    // hidden names only after a dot
    await reset();
    await page.keyboard.type("@.");
    await shown([".hidden-note"]);

    // an absolute folder is listed as it is
    await reset();
    await page.keyboard.type(`@${project}/src/l`);
    await shown(["lib/"]);

    // Escape closes the list and only that: nothing sent, the text stays, the
    // page's own Escape (menus, the phone's sidebar) never sees it, and the
    // list stays away for this reference
    await reset();
    await page.evaluate(() => {
      window.escapesSeen = 0;
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.escapesSeen += 1; });
    });
    await page.keyboard.type("@pa");
    await shown(["package.json"]);
    await page.keyboard.press("Escape");
    await closed();
    assert.equal(await page.evaluate(() => window.escapesSeen), 0, "the page's Escape did not run");
    assert.equal(await input.inputValue(), "@pa");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-input");
    await page.keyboard.type("c");
    await page.waitForTimeout(400);
    assert.equal(await popup.isHidden(), true, "a dismissed reference stays without a list");
    assert.deepEqual(herdr.sent, [], "Escape sent nothing");

    // the arrows recall sent messages again once the list is closed
    await reset();
    await page.keyboard.type("hello");
    await page.keyboard.press(mobile ? "Control+Enter" : "Enter");
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    assert.deepEqual(herdr.sent.map((item) => item.text), ["hello"]);
    await page.keyboard.press("ArrowUp");
    assert.equal(await input.inputValue(), "hello", "history comes back with the list closed");

    // a tap (or a click) picks a name
    await reset();
    await page.keyboard.type("@REA");
    await shown(["README.md"]);
    const item = popup.locator('[role="option"]').first();
    if (mobile) await item.tap(); else await item.click();
    assert.equal(await input.inputValue(), "@README.md ");
    await closed();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-input", "the composer keeps the focus");
    assert.deepEqual(herdr.sent.map((item) => item.text), ["hello"], "a tap sent nothing");

    // no match: no list, and Enter sends as always
    await reset();
    await page.keyboard.type("@zzz");
    await page.waitForTimeout(400);
    assert.equal(await popup.isHidden(), true);

    // a pane with no folder: no list, no error
    await reset();
    if (mobile) await page.locator("#mobile-sidebar-open").click();
    await page.locator('.pane-button[data-pane-id="w1:p2"]').click();
    await page.waitForFunction(() => document.querySelector('.pane-button[data-pane-id="w1:p2"]')?.getAttribute("aria-pressed") === "true");
    if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
    await input.click();
    await page.keyboard.type("@");
    await page.waitForTimeout(400);
    assert.equal(await popup.isHidden(), true, "no folder, no list");
    assert.equal(await page.locator("#app-alert").isHidden(), true, "no alert");
    assert.equal(await page.locator("#action-feedback").textContent(), "");

    // A pane on another PC asks that PC for its folder (the browse request
    // names its server), and gets that PC's names, not this one's cached ones.
    const asked = [];
    await page.route(/\/api\/browse\?/u, async (route) => {
      const requested = new URL(route.request().url());
      asked.push(requested.searchParams.get("server"));
      if (requested.searchParams.get("server") !== "link_lab") return route.continue();
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ path: project, parent: root, entries: [{ name: "lab-only.txt", path: `${project}/lab-only.txt`, kind: "file", hidden: false }], truncated: false, total: 1, server: "link_lab" }) });
    });
    await page.goto(`${url}/?pane=${encodeURIComponent("link_lab!w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#terminal-input"));
    await input.click();
    await page.keyboard.type("@");
    await shown(["lab-only.txt"]);
    assert.ok(asked.includes("link_lab"), `the other PC was not asked: ${JSON.stringify(asked)}`);
    await page.unroute(/\/api\/browse\?/u);

    // A Korean IME composing after @ neither picks from the list nor sends;
    // once the composition ends, the list follows what was typed.
    if (!mobile) {
      await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
      await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("ready"));
      await input.click();
      await reset();
      await page.keyboard.type("@");
      await shown(["my folder/", "src/", "README.md", "package.json"]);
      const sentBefore = herdr.sent.length;
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.imeSetComposition", { text: "ㅁ", selectionStart: 1, selectionEnd: 1 });
      // The Enter an IME uses to settle a syllable arrives as a composing keydown.
      await input.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
      await page.waitForTimeout(200);
      assert.equal(herdr.sent.length, sentBefore, `Enter while composing sent the draft: ${JSON.stringify(herdr.sent)}`);
      assert.doesNotMatch(await input.inputValue(), /README|package|src|my folder/u, "Enter while composing picked from the list");
      // The composition settles on a name nothing starts with: the list goes.
      await cdp.send("Input.insertText", { text: "ㅁ" });
      await closed();
      await page.keyboard.press("Backspace");
      await page.keyboard.type("my");
      await shown(["my folder/"]);
    }

    assert.deepEqual(errors, []);
    console.log({ mobile, remote: true, ime: !mobile, listed: true, narrowed: true, arrowsEnter: true, stale: true, folderDrill: true, quoted: true, hidden: true, escape: true, history: true, tap: true, noCwd: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
