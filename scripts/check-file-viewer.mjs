// Browser check of the file viewer showing what the browser can:
// - an HTML page draws with its own folder's stylesheet and picture, and runs
//   no script until Settings > Files > "Run scripts in HTML previews" is on;
// - with scripts on, its script runs and reaches neither this app's API, nor
//   its cookie, nor the internet; with "Internet in HTML previews" on too, the
//   internet is let in;
// - Markdown shows the pictures beside it;
// - a video the browser cannot play says so in the player's place;
// - in a chat, a bare name written after an absolute path ("the same folder's
//   notes.md") opens from that path's folder, not the shell's; one found
//   nowhere says where it was looked for.
// Runs on a desktop and a phone, light and dark, against a fake herdr and a
// temporary folder. VIEWER_SHOTS=<dir> keeps pictures of the dialog.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { claudeProjectDir } from "../src/conversation/claude.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const site = await mkdtemp(join(tmpdir(), "herdrabbit-viewer-"));
await mkdir(join(site, "assets"));
// a 2x2 red PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAeBgEB5jBl4QAAAABJRU5ErkJggg==", "base64");
await writeFile(join(site, "assets", "dot.png"), PNG);
await writeFile(join(site, "assets", "site.css"), "body { background: rgb(1, 2, 3); color: white; } #pic { width: 40px; height: 40px; }");
await writeFile(join(site, "assets", "app.js"), `
  document.querySelector("#ran").textContent = "script ran";
  const report = (id, text) => { document.querySelector(id).textContent = text; };
  fetch("/api/snapshot").then(() => report("#api", "api reached"), () => report("#api", "api blocked"));
  fetch("https://example.com/").then(() => report("#net", "internet reached"), () => report("#net", "internet blocked"));
  report("#cookie", (() => { try { return document.cookie === "" ? "no cookie" : "cookie"; } catch { return "no cookie"; } })());
`);
await writeFile(join(site, "report.html"), `<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head>
<body><h1>Report</h1><img id="pic" src="assets/dot.png" alt="dot"><p id="ran">script did not run</p><p id="api">?</p><p id="net">?</p><p id="cookie">?</p>
<script src="assets/app.js"></script></body></html>`);
await writeFile(join(site, "notes.md"), "# Notes\n\n![dot](assets/dot.png)\n");
await writeFile(join(site, "clip.avi"), Buffer.from("RIFF0000AVI LIST not a real video"));

// A Claude transcript in a temporary config folder, its pane's shell elsewhere.
const SESSION_ID = "6c1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const shell = await mkdtemp(join(tmpdir(), "herdrabbit-shell-"));
const configDir = await mkdtemp(join(tmpdir(), "herdrabbit-claude-"));
const project = join(configDir, "projects", claudeProjectDir(shell));
await mkdir(project, { recursive: true });
const at = (s) => new Date(Date.UTC(2026, 9, 1, 9, 0, s)).toISOString();
await writeFile(join(project, `${SESSION_ID}.jsonl`), [
  { type: "user", uuid: "u1", parentUuid: null, cwd: shell, timestamp: at(0), message: { role: "user", content: "make the mockups" } },
  { type: "assistant", cwd: shell, timestamp: at(5), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text",
    text: `Made the report: \`${site}/report.html\`\n\nThe same folder also has \`notes.md\` and \`missing-thing.md\`.` }] } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

const SESSION = "hs_local";
const herdr = {
  async snapshot() {
    return {
      servers: [{ id: "local", name: "workstation", available: true, status: "Connected" }],
      herdr_sessions: [{ session_id: SESSION, name: "default", default: true, machine_default: true, running: true, available: true, server_id: "local", server_name: "workstation" }],
      workspaces: [{ workspace_id: "w1", label: "Platform", herdr_session_id: SESSION, server_id: "local" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", herdr_session_id: SESSION }, { tab_id: "w1:t2", workspace_id: "w1", label: "2", herdr_session_id: SESSION }],
      panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "shell", cwd: site, herdr_session_id: SESSION, server_id: "local" },
        { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "claude", cwd: shell, agent: "claude", herdr_session_id: SESSION, server_id: "local",
          agent_session: { agent: "claude", kind: "id", value: SESSION_ID } },
      ],
      agents: [{ pane_id: "w1:p2", agent: "claude", state: "done", workspace_id: "w1" }],
    };
  },
  async sendText() {}, async sendKeys() {}, async readPane() { return "$ "; },
};
const { server } = createHerdrHttpServer({ herdr, logger: { info() {}, error() {} },
  conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }) });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const shots = process.env.VIEWER_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

try {
  for (const theme of ["light", "dark"]) for (const mobile of [false, true]) {
    const where = `${mobile ? "phone" : "desktop"}-${theme}`;
    // Service workers stay allowed: Playwright's "block" reads
    // navigator.serviceWorker in every frame, which a sandboxed page refuses.
    const context = await browser.newContext({ hasTouch: mobile, isMobile: mobile, colorScheme: theme,
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 } });
    await context.addInitScript((value) => { try { localStorage.setItem("herdrbridge-theme", value); } catch {} }, theme);
    // The page never gets out: count what tries.
    const outbound = [];
    await context.route("https://example.com/**", (route) => { outbound.push(route.request().url()); return route.fulfill({ status: 200, body: "ok" }); });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator(".pane-button:visible, #mobile-sidebar-open:visible").first().waitFor({ state: "visible" });
    const openSidebar = async () => {
      if (!mobile) return;
      await page.waitForTimeout(300);
      if (await page.locator("#mobile-sidebar-open").getAttribute("aria-expanded") !== "true") {
        await page.locator("#mobile-sidebar-open").click();
        await page.waitForTimeout(400);
      }
    };
    const view = async (name) => {
      await openSidebar();
      await page.locator("#tab-files").click();
      if (!(await page.locator("#file-tree").textContent()).includes(name)) {
        await page.locator("#file-path").fill(site);
        await page.waitForTimeout(600);
        await page.locator("#file-path").press("Enter");
        await page.waitForFunction((file) => document.querySelector("#file-tree")?.textContent.includes(file), name);
      }
      await page.locator(`#file-tree [aria-label="View ${name}"]`).click();
      await page.locator("#viewer-dialog").waitFor({ state: "visible" });
    };
    const close = async () => { await page.locator("#viewer-close").click(); await page.locator("#viewer-dialog").waitFor({ state: "hidden" }); };

    const frame = page.frameLocator("#viewer-dialog iframe");
    const drawnWithFolder = async () => {
      const drawn = await frame.locator("body").evaluate(() => ({
        background: getComputedStyle(document.body).backgroundColor,
        picture: document.querySelector("#pic").naturalWidth,
      }));
      assert.deepEqual(drawn, { background: "rgb(1, 2, 3)", picture: 2 }, `${where}: the page's own stylesheet or picture is missing`);
    };
    const settingsFiles = async () => {
      await openSidebar();
      await page.locator(".settings-button:visible").first().click();
      await page.locator('#settings-page-list [data-page="files"]').click();
    };
    const closeSettings = async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    };

    // An HTML page with its folder: styles and pictures, no script.
    await view("report.html");
    await frame.locator("h1", { hasText: "Report" }).waitFor({ timeout: 8000 });
    await drawnWithFolder();
    await page.waitForTimeout(500);
    assert.equal(await frame.locator("#ran").textContent(), "script did not run", `${where}: a script ran with scripts off`);
    assert.deepEqual(outbound, [], `${where}: the page reached the internet`);
    if (shots) await page.screenshot({ path: join(shots, `html-${where}.png`) });
    // Source shows the page as written, Rendered brings it back.
    await page.locator("#viewer-source").click();
    await page.locator(".viewer-text").filter({ hasText: "<script src=\"assets/app.js\">" }).waitFor();
    await page.locator("#viewer-source").click();
    await frame.locator("h1", { hasText: "Report" }).waitFor();
    await close();

    // Settings > Files: both switches start off; scripts on runs the page's script,
    // which still reaches neither this app nor the internet.
    await settingsFiles();
    for (const name of ["scripts", "internet"]) {
      assert.deepEqual(await page.locator(`[data-html-${name}]`).evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-pressed"))),
        ["true", "false"], `${where}: ${name} is not off until chosen`);
    }
    await page.locator('[data-html-scripts="on"]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem("herdrbridge-html-scripts")), "on");
    if (shots) await page.screenshot({ path: join(shots, `settings-files-${where}.png`) });
    await closeSettings();
    await view("report.html");
    await frame.locator("#ran").filter({ hasText: "script ran" }).waitFor({ timeout: 8000 });
    await frame.locator("#api").filter({ hasText: /blocked/u }).waitFor();
    await frame.locator("#net").filter({ hasText: /blocked/u }).waitFor();
    assert.equal(await frame.locator("#cookie").textContent(), "no cookie", `${where}: the page sees this app's cookie`);
    await drawnWithFolder();
    assert.deepEqual(outbound, [], `${where}: the page reached the internet with it off`);
    await close();

    // Internet on as well: from the next page opened, it is let in.
    await settingsFiles();
    await page.locator('[data-html-internet="on"]').click();
    await closeSettings();
    await view("report.html");
    await frame.locator("#net").filter({ hasText: "internet reached" }).waitFor({ timeout: 8000 });
    await frame.locator("#api").filter({ hasText: /blocked/u }).waitFor();
    assert.equal(outbound.length, 1, `${where}: with it on, the page reached the internet`);
    await close();
    await page.evaluate(() => { localStorage.removeItem("herdrbridge-html-internet"); localStorage.removeItem("herdrbridge-html-scripts"); });

    // Markdown shows the picture beside it.
    await view("notes.md");
    await page.frameLocator("#viewer-dialog iframe").locator("img").first().waitFor();
    assert.equal(await page.frameLocator("#viewer-dialog iframe").locator("img").first().evaluate((img) => img.complete && img.naturalWidth), 2,
      `${where}: Markdown's picture did not load`);
    await close();

    // A video this browser cannot play says so where the player was.
    await view("clip.avi");
    await page.locator(".viewer-unsupported").waitFor({ timeout: 8000 });
    assert.match(await page.locator(".viewer-unsupported").textContent(), /This browser can't play clip\.avi/u);
    assert.equal(await page.locator("#viewer-download").isVisible(), true);
    if (shots) await page.screenshot({ path: join(shots, `unsupported-${where}.png`) });
    await close();

    // In the chat: "the same folder also has notes.md" opens from the report's
    // folder, though the shell is elsewhere.
    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p2")}`);
    await page.waitForFunction(() => document.querySelector("#lens-chat")?.getAttribute("aria-disabled") === "false");
    if (!mobile) await page.locator("#lens-chat").click();
    const link = page.locator('.chat-turns [data-path="notes.md"]').first();
    await link.waitFor();
    await link.click();
    await page.locator("#viewer-dialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#viewer-title").textContent(), "notes.md");
    await page.frameLocator("#viewer-dialog iframe").locator("h1", { hasText: "Notes" }).waitFor();
    await close();
    await page.locator('.chat-turns [data-path="missing-thing.md"]').first().click();
    await page.waitForFunction(() => /Couldn't find missing-thing\.md/u.test(document.querySelector("#action-feedback")?.textContent ?? ""));
    assert.match(await page.locator("#action-feedback").textContent(), new RegExp(site.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")), "it says where it looked");

    assert.deepEqual(errors, [], `${where}: page errors`);
    await context.close();
  }
  console.log("File viewer: pages with their folder, Settings > Files, Markdown pictures, unplayable media: ok");
} finally {
  await browser.close();
  server.close();
}
