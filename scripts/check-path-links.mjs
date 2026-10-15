// Browser check of file paths in terminal output: a file the viewer cannot show
// (an .aab) is a link too, and pressing it opens the Files tab in its folder
// with that file's row selected and in view -- on a desktop and on a phone. A
// name with no extension (`feat/settings-menu`) stays plain text, and a file
// that is not in its folder leaves a short note. A folder written out in full
// (absolute, or starting with ./) is a link too and opens the Files tab inside
// it; an extensionless file path is selected in its parent instead. A folder
// with a space, named in quotes, is one link (wrapped onto the next row on the
// phone) and opens that folder. A link to an SSH key, and one to the key
// folder, are listed locked: no arrow, no view or download, nothing opens.
// Runs against a fake herdr.
// PATHLINK_SCREENSHOTS=<folder> keeps pictures of the phone.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { defaultDataPaths, localProtectedPaths } from "../src/protected-paths.mjs";
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
const inner = join(release, "inner-folder");
await mkdir(inner);
await writeFile(join(inner, "inner-file.txt"), "y");
const plain = join(release, "plainfile");
await writeFile(plain, "z");
// a folder whose name reads like a file the viewer could show
const dottedFolder = join(release, "bundle.md");
await mkdir(dottedFolder);
await writeFile(join(dottedFolder, "inside-bundle.txt"), "w");
// a folder with a space in its name, named in quotes: the whole quoted path is one link
const spaced = join(release, "my folder");
await mkdir(spaced);
await writeFile(join(spaced, "spaced-file.txt"), "v");
// a made-up home whose SSH keys are reached through links in the folder
const home = join(root, "home");
await mkdir(join(home, ".ssh"), { recursive: true });
await writeFile(join(home, ".ssh", "id_ed25519"), "secret");
await symlink(join(home, ".ssh", "id_ed25519"), join(release, "zz-deploy-key"));
await symlink(join(home, ".ssh"), join(release, "zz-keys"));
const protectedPaths = localProtectedPaths({ env: { HOME: home }, home, data: defaultDataPaths(home) });

const snapshot = {
  focused_workspace_id: "w1", focused_tab_id: "w1:t1", focused_pane_id: "w1:p1",
  servers: [
    { id: "local", name: "workstation", available: true, status: "Connected" },
    { id: "lab", name: "lab", available: true, status: "Connected" },
  ],
  workspaces: [
    { workspace_id: "w1", label: "Platform", server_id: "local" },
    { workspace_id: "lab!w2", label: "Lab", server_id: "lab" },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "Release" },
    { tab_id: "lab!w2:t1", workspace_id: "lab!w2", label: "Remote" },
  ],
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "Release", cwd: root },
    { pane_id: "lab!w2:p1", tab_id: "lab!w2:t1", workspace_id: "lab!w2", label: "Remote", cwd: root },
  ],
  agents: [],
};
const output = `\x1b[?1049hbuilt ${target}\r\nmissing ${missing}\r\nviewer ${notes}\r\nbranch feat/settings-menu 1/2\r\nfolder ${release}\r\nrel ./docviewer-release/inner-folder\r\nplain ${plain}\r\ndotted ${dottedFolder}\r\nquoted cd "${spaced}"\r\ncmd /compact src/foo\r\n$ `;
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
  protectedPaths,
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
    page.on("pageerror", (error) => {
      // Playwright's own service-worker block, injected into the viewer's
      // sandboxed frame, cannot read navigator.serviceWorker there: that is
      // the harness, not the page.
      if (/serviceWorker.*sandboxed/u.test(error.message)) return;
      errors.push(error.message);
    });
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelector("#terminal-xterm .xterm-rows")?.textContent.includes("settings-menu"));
    await page.waitForFunction(() => document.querySelectorAll(".terminal-link-marks span").length >= 6);
    // a path the phone's width wraps is two underlines, the second from the left edge
    const starts = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".terminal-link-marks span")].map((span) => span.getBoundingClientRect());
      const edge = document.querySelector("#terminal-xterm .xterm-screen").getBoundingClientRect().left;
      return boxes.filter((box) => box.left > edge + 1).map((box) => ({ x: box.left, y: box.top, width: box.width }));
    });
    const marks = starts.length;
    assert.equal(marks, 8, "the .aab, the missing .aab, the .md, the two folders, the extensionless file, the folder named like a file and the quoted folder with a space are links; the branch, the fraction and the slash command are not");
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

    // the links to a key and to the key folder: listed by name, locked, and inert
    for (const name of ["zz-deploy-key", "zz-keys"]) {
      const lockedRow = page.locator(".browse-row", { hasText: name });
      assert.equal(await lockedRow.count(), 1, `${name} is listed`);
      assert.equal(await lockedRow.evaluate((node) => node.classList.contains("is-locked")), true, `${name} is locked`);
      assert.match(await lockedRow.locator(".transfer-meta").textContent(), /locked/u);
      assert.equal(await lockedRow.locator(".browse-twisty").count(), 0, `${name} has no arrow`);
      assert.equal(await lockedRow.locator(".transfer-row-actions button").count(), 0, `${name} has no view, download or open button`);
      await lockedRow.scrollIntoViewIfNeeded();
      await lockedRow.click();
      await page.waitForTimeout(200);
      assert.equal(await page.locator("#file-path").inputValue(), release, `${name} opened nothing`);
      assert.equal(await page.locator("dialog[open]").count(), 0);
      assert.equal(await page.locator(".browse-row", { hasText: "id_ed25519" }).count(), 0, "nothing inside the key folder is shown");
    }

    // a file that is not there: the folder opens and a note says so
    await page.evaluate(() => { document.querySelector("#tab-sessions").click(); });
    if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
    await press(1);
    await page.waitForFunction(() => document.querySelector("#file-feedback").textContent.includes("is not in this folder"));
    assert.equal(await page.locator("#file-path").inputValue(), release);

    // a folder: the absolute one opens, and the ./ one too -- Files shows what is inside it
    for (const [index, folder, child] of [[3, release, "notes.md"], [4, inner, "inner-file.txt"], [6, dottedFolder, "inside-bundle.txt"], [7, spaced, "spaced-file.txt"]]) {
      await page.evaluate(() => { document.querySelector("#tab-sessions").click(); });
      if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
      await press(index);
      await page.waitForFunction((path) => document.querySelector("#file-path").value === path
        && document.querySelector("#file-feedback").textContent === ""
        && document.querySelector(".browse-row"), folder, { timeout: 15_000 });
      assert.equal(await page.locator("#tab-files").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#file-path").inputValue(), folder);
      assert.equal(await page.locator(".browse-row", { hasText: child }).count(), 1, `${child} is listed in ${folder}`);
      assert.equal(await page.locator('.browse-row[data-selected="true"]').count(), 0, "a folder link selects no row");
      assert.equal(await page.locator("dialog[open]").count(), 0, "no viewer opened on a folder");
    }

    // a file without an extension: its parent opens with its row selected
    await page.evaluate(() => { document.querySelector("#tab-sessions").click(); });
    if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
    await press(5);
    await page.waitForFunction((path) => document.querySelector('.browse-row[data-selected="true"]')?.dataset.path === path, plain, { timeout: 15_000 });
    assert.equal(await page.locator("#file-path").inputValue(), release);

    // a slow listing already loading does not turn the link away: hold every
    // listing past the old 3 second wait, start one, then press the link
    await page.evaluate(() => { document.querySelector("#tab-sessions").click(); });
    if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
    await page.route("**/api/browse?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      await route.continue();
    });
    await page.evaluate(() => { document.querySelector("#tab-files").click(); document.querySelector("#file-refresh").click(); });
    await page.evaluate(() => { document.querySelector("#tab-sessions").click(); });
    if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
    await press(0);
    await page.waitForFunction((path) => document.querySelector('.browse-row[data-selected="true"]')?.dataset.path === path, target, { timeout: 15_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // a folder listed only in part: the file past the cut is still found. A
    // fresh page, so no row is still selected and no held request lingers.
    {
      const cutContext = await browser.newContext({
        serviceWorkers: "block", hasTouch: mobile, isMobile: mobile, colorScheme: "dark",
        viewport: { width: mobile ? 390 : 1280, height: 844 },
      });
      const cutPage = await cutContext.newPage();
      let askedByName = false;
      await cutPage.route("**/api/browse?*", async (route) => {
        try {
          const requested = new URL(route.request().url());
          const response = await route.fetch();
          const listing = await response.json();
          if (requested.searchParams.get("prefix") === "docviewer-0.1.0-v10-testads.aab") {
            askedByName = true;
            return await route.fulfill({ response, json: listing });
          }
          const cut = listing.entries.filter((item) => !item.name.endsWith(".aab"));
          await route.fulfill({ response, json: { ...listing, entries: cut, truncated: true, total: listing.entries.length } });
        } catch { /* a request still in flight when the page closes */ }
      });
      await cutPage.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
      await cutPage.waitForFunction(() => document.querySelectorAll(".terminal-link-marks span").length >= 6);
      assert.equal(await cutPage.locator('.browse-row[data-selected="true"]').count(), 0, "nothing is selected before the press");
      const box = await cutPage.evaluate(() => {
        const edge = document.querySelector("#terminal-xterm .xterm-screen").getBoundingClientRect().left;
        const rect = [...document.querySelectorAll(".terminal-link-marks span")]
          .map((span) => span.getBoundingClientRect()).find((item) => item.left > edge + 1);
        return { x: rect.left, y: rect.top, width: rect.width };
      });
      await cutPage.mouse.click(box.x + Math.min(box.width / 2, 20), box.y - 4);
      await cutPage.waitForFunction((path) => document.querySelector('.browse-row[data-selected="true"]')?.dataset.path === path, target, { timeout: 30_000 });
      assert.equal(askedByName, true, "the file past the cut was asked for by name");
      await cutPage.unrouteAll({ behavior: "ignoreErrors" });
      await cutContext.close();
    }

    // a file the viewer can show still opens in it
    if (mobile) await page.evaluate(() => document.querySelector("#sidebar-scrim")?.click());
    await press(2);
    await page.locator("dialog[open]").first().waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    console.log({ mobile, links: marks, filesTab: true, folders: true, quotedSpaced: true, extensionless: true, rowInView: true, missingNote: true, slowListing: true, pastTheCut: true, previewKept: true });
    await context.close();
  }
  // A remote pane's link opens that machine's files, not this one's. The lab's
  // listings are this machine's folder, answered under the lab's name.
  {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 } });
    const page = await context.newPage();
    const asked = [];
    await page.route("**/api/browse?*", async (route) => {
      const requested = new URL(route.request().url());
      asked.push(requested.searchParams.get("server"));
      if (requested.searchParams.get("server") !== "lab") return route.continue();
      requested.searchParams.set("server", "local");
      const response = await route.fetch({ url: requested.href });
      await route.fulfill({ response });
    });
    await page.goto(`${url}/?pane=${encodeURIComponent("lab!w2:p1")}`);
    await page.waitForFunction(() => document.querySelectorAll(".terminal-link-marks span").length >= 3);
    const box = await page.evaluate(() => {
      const rect = document.querySelector(".terminal-link-marks span").getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width };
    });
    await page.mouse.click(box.x + Math.min(box.width / 2, 20), box.y - 4);
    await page.waitForFunction((path) => document.querySelector('.browse-row[data-selected="true"]')?.dataset.path === path, target, { timeout: 15_000 });
    assert.equal(await page.locator("#file-server").inputValue(), "lab", "the lab's files are open");
    assert.ok(asked.includes("lab"), "the listing was asked of the lab");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    console.log({ remotePane: true });
    await context.close();
  }

  // A machine picked by hand while a file link still waits on a slow listing
  // wins: the link gives way, and the picked machine's folder is what loads.
  {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 844 } });
    const page = await context.newPage();
    await page.route("**/api/browse?*", async (route) => {
      try {
        const requested = new URL(route.request().url());
        if (requested.searchParams.get("server") === "lab") {
          requested.searchParams.set("server", "local");
          return await route.fulfill({ response: await route.fetch({ url: requested.href }) });
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await route.continue();
      } catch { /* a request still in flight when the page closes */ }
    });
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.waitForFunction(() => document.querySelectorAll(".terminal-link-marks span").length >= 3);
    const box = await page.evaluate(() => {
      const rect = document.querySelector(".terminal-link-marks span").getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width };
    });
    await page.mouse.click(box.x + Math.min(box.width / 2, 20), box.y - 4);
    await page.locator("#file-server").waitFor({ state: "visible" });
    await page.selectOption("#file-server", "lab");
    await page.waitForFunction(() => document.querySelector("#file-feedback").textContent !== "Loading…"
      && document.querySelectorAll(".browse-row").length > 0, null, { timeout: 15_000 });
    await page.waitForTimeout(4_000); // past the slow listing the link was waiting on
    assert.equal(await page.locator("#file-server").inputValue(), "lab", "the machine picked by hand stays");
    assert.ok(await page.locator(".browse-row").count() > 0, "its folder is listed");
    assert.equal(await page.locator('.browse-row[data-selected="true"]').count(), 0, "the link gave way");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    console.log({ pickedByHand: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
