// Browser check of file paths in terminal output: a file the viewer cannot show
// (an .aab) is a link too, and pressing it opens the Files tab in its folder
// with that file's row selected and in view -- on a desktop and on a phone. A
// name with no extension (`feat/settings-menu`) stays plain text, and a file
// that is not in its folder leaves a short note. Runs against a fake herdr.
// PATHLINK_SCREENSHOTS=<folder> keeps pictures of the phone.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = await mkdtemp(join(tmpdir(), "pathlinks-"));
const release = join(root, "docviewer-release");
await mkdir(release);
// enough files that the target sits below the first screenful
for (let index = 0; index < 60; index += 1) await writeFile(join(release, `a-${String(index).padStart(2, "0")}.txt`), "x");
const target = join(release, "docviewer-0.1.0-v10-testads.aab");
await writeFile(target, "bundle");
const missing = join(release, "gone-for-good.aab");
const notes = join(release, "notes.md");
await writeFile(notes, "# notes");

const snapshot = {
  focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1",
  servers: [{ id: "local", name: "workstation", available: true, status: "Connected" }],
  workspaces: [{ workspace_id: "w1", label: "Platform", server_id: "local" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Release" }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Release", cwd: root }],
  agents: [],
};
const output = `\x1b[?1049hbuilt ${target}\r\nmissing ${missing}\r\nviewer ${notes}\r\nbranch feat/settings-menu 1/2\r\n$ `;
const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    setTimeout(() => options.onData(output), 10);
    return { write() {}, resize() {}, pause() {}, resume() {}, exited: new Promise(() => {}), kill() {} };
  },
});
const { server } = createHerdrHttpServer({
  herdr: { async snapshot() { return snapshot; }, async readPane() { return "$ "; }, async sendText() {}, async sendKeys() {} },
  attachments,
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.PATHLINK_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      serviceWorkers: "block", hasTouch: mobile, isMobile: mobile, colorScheme: "dark",
      viewport: { width: mobile ? 390 : 1280, height: 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("settings-menu"));
    await page.waitForFunction(() => document.querySelectorAll(".terminal-link-marks span").length >= 3);
    // a path the phone's width wraps is two underlines, the second from the left edge
    const starts = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".terminal-link-marks span")].map((span) => span.getBoundingClientRect());
      const edge = document.querySelector("#terminal-xterm .xterm-screen").getBoundingClientRect().left;
      return boxes.filter((box) => box.left > edge + 1).map((box) => ({ x: box.left, y: box.top, width: box.width }));
    });
    const marks = starts.length;
    assert.equal(marks, 3, "the .aab, the missing .aab and the .md are links; the branch and the fraction are not");
    if (shots && mobile) await page.screenshot({ path: join(shots, "phone-dark-terminal-links.png") });

    // the underline marks sit under each link: press just above one
    const press = async (index) => {
      const box = starts[index];
      await page.mouse.click(box.x + Math.min(box.width / 2, 20), box.y - 4);
    };

    // the .aab: Files opens in its folder with the row selected and in view
    await press(0);
    const row = page.locator('.browse-row[data-selected="true"]');
    await row.waitFor({ state: "visible" });
    assert.equal(await page.locator("#tab-files").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#file-panel").isVisible(), true);
    assert.equal(await page.locator("#file-path").inputValue(), release);
    assert.equal(await row.getAttribute("data-path"), target);
    await page.waitForTimeout(500);
    const inView = await row.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const tree = node.closest("#file-tree").getBoundingClientRect();
      return rect.top >= tree.top - 1 && rect.bottom <= tree.bottom + 1 && rect.bottom <= innerHeight;
    });
    assert.equal(inView, true, "the row was scrolled into view");
    assert.equal(await page.locator("#file-feedback").textContent(), "");
    if (mobile) assert.equal(await page.evaluate(() => document.body.classList.contains("sidebar-open")), true, "the phone's sidebar is open");
    if (shots && mobile) await page.screenshot({ path: join(shots, "phone-dark-files-tab.png") });

    // a file that is not there: the folder opens and a note says so
    await page.evaluate(() => { document.querySelector("#tab-sessions").click(); });
    if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
    await press(1);
    await page.waitForFunction(() => document.querySelector("#file-feedback").textContent.includes("is not in this folder"));
    assert.equal(await page.locator("#file-path").inputValue(), release);

    // a file the viewer can show still opens in it
    if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
    await press(2);
    await page.locator("dialog[open]").first().waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    console.log({ mobile, links: marks, filesTab: true, rowInView: true, missingNote: true, previewKept: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
