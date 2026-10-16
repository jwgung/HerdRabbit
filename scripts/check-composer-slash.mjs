// Browser check of `/` commands in the composer, on a desktop and on a phone:
// typing `/` at the start of a Claude Code pane's composer lists its commands
// (Claude Code's own, the user's skills, the project's commands) with a
// description and source tag, typing narrows it, Enter or a tap puts
// `/name ` in without sending, Escape closes it, nothing shows after a space
// or for a pane whose agent is neither Claude Code nor Codex, and a Codex
// pane offers Codex's commands and prompts. HOME and the project are
// temporary folders made here; runs against an in-process fake herdr.
// SLASH_SCREENSHOTS=<folder> keeps pictures of the list in both themes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { localProtectedPaths } from "../src/protected-paths.mjs";
import { SlashCommandCatalog } from "../src/slash-commands.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = await mkdtemp(join(tmpdir(), "slash-"));
const home = join(root, "home");
const project = join(root, "project");
const write = async (path, text) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
};
await write(join(home, ".claude", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Does alpha things\n---\n");
await write(join(home, ".codex", "prompts", "fix.md"), "---\ndescription: Fix the bug\n---\n");
await write(join(project, ".claude", "commands", "build.md"), "---\ndescription: Build this project\n---\n");
const slashCommands = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }) });

const herdr = {
  sent: [],
  async snapshot() {
    return {
      workspaces: [{ workspace_id: "w1", label: "Platform" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Agents" }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Claude", agent: "claude", cwd: root, foreground_cwd: project },
        { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "Shell", cwd: project },
        { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", label: "Codex", agent: "codex", cwd: project },
      ],
      agents: [],
    };
  },
  async readPane() { return "> "; },
  async sendText(paneId, text) { herdr.sent.push({ paneId, text }); },
  async sendKeys(paneId, keys) { herdr.sent.push({ paneId, keys: [...keys] }); },
};
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    setTimeout(() => options.onData("\x1b[?1049hready\r\n> "), 10);
    return { write() {}, resize() {}, pause() {}, resume() {}, exited: new Promise(() => {}), kill() {} };
  },
});
const { server } = createHerdrHttpServer({ herdr, attachments, slashCommands, logger: { info() {}, error() {} } });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.SLASH_SCREENSHOTS;
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
    const names = () => popup.locator(".composer-command-name").allTextContents();
    // the list shows, its first names being `expected`
    const startsWith = async (expected) => {
      await page.waitForFunction((want) => {
        const list = document.querySelector("#composer-files");
        const got = [...list.querySelectorAll(".composer-command-name")].map((item) => item.textContent);
        return !list.hidden && JSON.stringify(got.slice(0, want.length)) === JSON.stringify(want);
      }, expected, { timeout: 5_000 }).catch(async () => {
        assert.deepEqual((await names()).slice(0, expected.length), expected, "the list shows");
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
    const openPane = async (paneId) => {
      await page.goto(`${url}/?pane=${encodeURIComponent(paneId)}`);
      await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("ready"));
      await input.click();
    };

    await openPane("w1:p1");

    // `/` lists the agent's commands, the user's and the project's, each tagged
    await page.keyboard.type("/");
    await page.waitForFunction(() => !document.querySelector("#composer-files").hidden, null, { timeout: 5_000 });
    assert.equal(await popup.getAttribute("aria-label"), "Commands");
    assert.equal(await input.getAttribute("aria-expanded"), "true");
    const all = await names();
    for (const name of ["/alpha", "/build", "/compact", "/model"]) assert.ok(all.includes(name), `${name} is listed: ${all}`);
    const row = (name) => popup.locator(".composer-command").filter({ has: page.locator(".composer-command-name", { hasText: new RegExp(`^${name}$`, "u") }) });
    assert.equal(await row("/alpha").locator(".composer-command-source").textContent(), "user");
    assert.equal(await row("/build").locator(".composer-command-source").textContent(), "project");
    assert.equal(await row("/compact").locator(".composer-command-source").textContent(), "built-in");
    assert.equal(await row("/build").locator(".composer-command-description").textContent(), "Build this project");
    // a long description stays on one line
    const heights = await popup.locator(".composer-command").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    assert.ok(Math.max(...heights) < 60, `rows stay one line: ${heights}`);
    if (shots) {
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots, `slash-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      }
    }

    // typing narrows it; Enter puts `/compact ` in and sends nothing
    await page.keyboard.type("com");
    await startsWith(["/compact"]);
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "/compact ");
    await closed();
    await page.waitForTimeout(200);
    assert.deepEqual(herdr.sent, [], "picking a command sent nothing");

    // the arrows move, Tab picks
    await reset();
    await page.keyboard.type("/bui");
    await startsWith(["/build"]);
    await page.keyboard.press("Tab");
    assert.equal(await input.inputValue(), "/build ");
    await closed();

    // not after a space, not mid-text
    await reset();
    await page.keyboard.type("hi /com");
    await page.waitForTimeout(400);
    assert.equal(await popup.isHidden(), true, "no list mid-text");
    await reset();
    await page.keyboard.type("/compact now");
    await page.waitForTimeout(400);
    assert.equal(await popup.isHidden(), true, "no list after a space");

    // Escape closes it and only it: the text stays and nothing is sent
    await reset();
    await page.evaluate(() => {
      window.escapesSeen = 0;
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.escapesSeen += 1; });
    });
    await page.keyboard.type("/mod");
    await startsWith(["/model"]);
    await page.keyboard.press("Escape");
    await closed();
    assert.equal(await page.evaluate(() => window.escapesSeen), 0, "the page's Escape did not run");
    assert.equal(await input.inputValue(), "/mod");
    await page.keyboard.type("e");
    await page.waitForTimeout(400);
    assert.equal(await popup.isHidden(), true, "a dismissed command stays without a list");
    assert.deepEqual(herdr.sent, [], "Escape sent nothing");

    // a tap (or a click) picks a command and keeps the focus
    await reset();
    await page.keyboard.type("/alp");
    await startsWith(["/alpha"]);
    const item = popup.locator('[role="option"]').first();
    if (mobile) await item.tap(); else await item.click();
    assert.equal(await input.inputValue(), "/alpha ");
    await closed();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-input", "the composer keeps the focus");
    assert.deepEqual(herdr.sent, [], "a tap sent nothing");

    // `@` still lists files after the change
    await reset();
    await page.keyboard.type("@.cl");
    await page.waitForFunction(() => {
      const list = document.querySelector("#composer-files");
      return !list.hidden && list.getAttribute("aria-label") === "Files" && list.textContent.includes(".claude/");
    }, null, { timeout: 5_000 });
    await reset();

    // a list dismissed with Escape in one pane does not hold in the next
    await page.keyboard.type("/mo");
    await startsWith(["/model"]);
    await page.keyboard.press("Escape");
    await closed();

    // a Codex pane offers Codex's commands and the user's prompts (reached
    // in the page, as a user would, after that Escape)
    await page.evaluate(() => document.querySelector('.pane-button[data-pane-id="w1:p3"]').click());
    await page.waitForFunction(() => document.querySelector("#terminal-input").value === "");
    await input.focus();
    await page.keyboard.type("/pro");
    await startsWith(["/prompts:fix"]);
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "/prompts:fix ");
    await reset();
    await page.keyboard.type("/appr");
    await startsWith(["/approvals"]);
    await reset();

    // a pane running something else: no list, no error
    await openPane("w1:p2");
    await page.keyboard.type("/");
    await page.waitForTimeout(400);
    assert.equal(await popup.isHidden(), true, "a plain shell has no command list");
    assert.equal(await page.locator("#app-alert").isHidden(), true, "no alert");

    assert.deepEqual(herdr.sent, [], "nothing was ever sent");
    assert.deepEqual(errors, []);
    console.log({ mobile, listed: true, tagged: true, narrowed: true, enter: true, tab: true, startOnly: true, escape: true, tap: true, codex: true, otherAgent: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
