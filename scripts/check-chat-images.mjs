// Browser check of an agent's local images in the chat and the viewer they
// open in. An answer that writes `![](chart.png)`, `![](./sub/second.png)` and
// an absolute SVG shows all three inline, each read through the file route's
// view ticket (/api/browse/download/<ticket>) and resolved against the pane's
// folder; a missing file and one under ~/.ssh keep their plain fallback and
// say "Image unavailable"; a remote image stays a link and nothing is fetched
// from its host. Pressing a picture opens the full-screen viewer on the
// chat's pictures: zoom (buttons, wheel, keys), pan, next and previous
// (buttons, arrows, wrapping), copy, download, and Esc to close. On a phone
// the controls are 44px, a swipe steps, a pinch zooms and a double tap
// toggles. Runs against a fake herdr and a transcript in a temporary Claude
// folder. SHOTS=<dir> saves screenshots (desktop dark, phone light).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PaneAttachments } from "../src/pane-attachments.mjs";
import { claudeProjectDir } from "../src/conversation/claude.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { defaultDataPaths, localProtectedPaths } from "../src/protected-paths.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

// A plain one-colour PNG of the given size.
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

const SESSION = "6c2e3d4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const root = await mkdtemp(join(tmpdir(), "herdrabbit-chat-images-"));
const cwd = join(root, "work");
const home = join(root, "home");
await mkdir(join(cwd, "sub"), { recursive: true });
await mkdir(join(home, ".ssh"), { recursive: true });
await mkdir(join(root, "abs"));
await writeFile(join(cwd, "chart.png"), png(640, 360, [200, 40, 40]));
await writeFile(join(cwd, "sub", "second.png"), png(200, 200, [40, 160, 60]));
await writeFile(join(root, "abs", "third.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="#3355cc"/></svg>');
await writeFile(join(home, ".ssh", "key.png"), png(10, 10, [0, 0, 0]));
const protectedPaths = localProtectedPaths({ env: { HOME: home }, home, data: defaultDataPaths(home) });

const configDir = join(root, "claude");
const project = join(configDir, "projects", claudeProjectDir(cwd));
await mkdir(project, { recursive: true });
const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 9, 0, seconds)).toISOString();
const answer = [
  "Here is the chart:",
  "",
  "![The chart](chart.png)",
  "",
  `The second ![](./sub/second.png) and ![diagram](${join(root, "abs", "third.svg")}).`,
  "",
  "Missing: ![](missing.png)",
  "",
  `Protected: ![key](${join(home, ".ssh", "key.png")})`,
  "",
  "Remote: ![logo](https://example.com/logo.png)",
].join("\n");
await writeFile(join(project, `${SESSION}.jsonl`), [
  { type: "user", uuid: "u1", parentUuid: null, timestamp: at(0), message: { role: "user", content: "draw the chart" } },
  { type: "assistant", timestamp: at(5), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: answer }] } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

const snapshot = JSON.parse(await readFile(new URL("../test/fixtures/fake-state.template.json", import.meta.url), "utf8")).snapshot;
const claudePane = snapshot.panes.find((pane) => pane.pane_id === "w1:p1");
Object.assign(claudePane, { agent: "claude", cwd, agent_session: { agent: "claude", kind: "id", value: SESSION } });
snapshot.agents.find((agent) => agent.pane_id === "w1:p1").state = "done";

const attachments = new PaneAttachments({
  log: () => {},
  options: { holdMs: 5, heldRetryMs: 60_000, relookupForMs: 200 },
  resolveTerminal: async (paneId) => ({ command: "herdr", args: ["terminal", "attach", `term_${paneId}`], env: {}, terminalId: `term_${paneId}` }),
  spawnPty: (options) => {
    setTimeout(() => options.onData("\x1b[?1049hready terminal\r\n$ "), 10);
    return { write() {}, resize() {}, pause() {}, resume() {}, kill() {} };
  },
});
const herdr = {
  async snapshot() { return snapshot; },
  async readPane() { return "screen\n$ "; },
  async sendText() {},
  async sendKeys() {},
};
const { server } = createHerdrHttpServer({
  herdr,
  attachments,
  protectedPaths,
  conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }),
  logger: { info() {}, error() {} },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.SHOTS || null;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: "block", hasTouch: mobile, isMobile: mobile,
      colorScheme: mobile ? "light" : "dark", viewport: { width: mobile ? 390 : 1280, height: 844 } });
    if (!mobile) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const remote = [];
    page.on("request", (request) => { if (!request.url().startsWith(url)) remote.push(request.url()); });

    await page.goto(`${url}/?pane=${encodeURIComponent("w1:p1")}`);
    await page.locator("#lens-switch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#lens-chat").getAttribute("aria-disabled") === "false");
    if (!mobile) await page.locator("#lens-chat").click();
    await page.waitForFunction(() => document.querySelectorAll('.md-image[data-state="shown"]').length === 3, null, { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelectorAll('.md-image[data-state="unavailable"]').length === 2, null, { timeout: 10_000 });

    // --- C10: inline, from the file route only -----------------------------
    const inline = await page.evaluate(() => [...document.querySelectorAll(".md-image")].map((holder) => ({
      path: holder.dataset.image,
      state: holder.dataset.state,
      src: holder.querySelector("img")?.getAttribute("src") ?? null,
      width: holder.querySelector("img")?.naturalWidth ?? 0,
      label: holder.querySelector("button")?.getAttribute("aria-label") ?? null,
      text: holder.textContent,
    })));
    assert.deepEqual(inline.map((item) => [item.path.split("/").pop(), item.state]), [
      ["chart.png", "shown"], ["second.png", "shown"], ["third.svg", "shown"], ["missing.png", "unavailable"], ["key.png", "unavailable"],
    ]);
    for (const item of inline.filter((entry) => entry.state === "shown")) {
      assert.match(item.src, /^\/api\/browse\/download\/[A-Za-z0-9_-]{16,86}$/u, item.path);
      assert.ok(item.width > 0, `${item.path} decoded`);
    }
    assert.equal(inline[0].label, "View image: The chart");
    assert.equal(inline[1].label, "View image: second.png");
    for (const item of inline.filter((entry) => entry.state === "unavailable")) {
      assert.equal(item.src, null);
      assert.match(item.text, /Image unavailable$/u);
    }
    // the fallback is the file link a path gets, and a note; the Files viewer refuses a protected one too
    assert.equal(inline[3].text, "missing.png Image unavailable");
    assert.equal(inline[4].text, "key Image unavailable");
    assert.equal(await page.locator('.md-image[data-state="unavailable"] > button.md-file').count(), 2);
    // every picture in the page comes from this origin's file route or the app's own files
    const sources = await page.evaluate(() => [...document.querySelectorAll(".chat-pane img")].map((img) => img.getAttribute("src")));
    assert.ok(sources.every((src) => src.startsWith("/api/browse/download/")), JSON.stringify(sources));
    const logo = page.locator('.chat-pane a[href="https://example.com/logo.png"]');
    assert.equal(await logo.textContent(), "logo");
    assert.deepEqual(remote, [], "nothing was fetched from another host");

    // --- C9: the viewer -------------------------------------------------------
    const viewer = page.locator("dialog.image-viewer");
    const name = viewer.locator(".image-viewer-name");
    const count = viewer.locator(".image-viewer-count");
    const zoom = viewer.locator(".image-viewer-zoom");
    const transform = () => viewer.locator(".image-viewer-picture").evaluate((img) => img.style.transform);
    await page.locator(".md-image-open").first().click();
    await viewer.waitFor({ state: "visible" });
    assert.equal(await name.textContent(), "The chart");
    assert.equal(await count.textContent(), "1 of 3");
    assert.equal(await zoom.textContent(), "100%");
    // full screen
    const box = await viewer.boundingBox();
    assert.deepEqual([Math.round(box.width), Math.round(box.height)], [mobile ? 390 : 1280, 844]);
    // 44px controls everywhere
    for (const control of await viewer.locator("button:visible").all()) {
      const size = await control.boundingBox();
      assert.ok(size.width >= 44 && size.height >= 44, `${await control.getAttribute("aria-label")} is ${size.width}x${size.height}`);
    }
    // a long file name is cut short: the controls and the picture stay on screen
    const shownName = await name.textContent();
    await name.evaluate((node) => { node.textContent = "a-long-screenshot-file-name-compare-s1-light-1440.png"; });
    const width = mobile ? 390 : 1280;
    for (const control of await viewer.locator(".image-viewer-tools button").all()) {
      const size = await control.boundingBox();
      assert.ok(size.x >= 0 && size.x + size.width <= width, `${await control.getAttribute("aria-label")} is on screen at ${size.x}+${size.width}`);
    }
    const wide = await viewer.locator(".image-viewer-stage").boundingBox();
    assert.equal(Math.round(wide.width), width, "the stage is the screen's width");
    await name.evaluate((node, text) => { node.textContent = text; }, shownName);
    const stage = await viewer.locator(".image-viewer-stage").boundingBox();
    const centre = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };

    if (!mobile) {
      await viewer.getByRole("button", { name: "Zoom in" }).click();
      assert.equal(await zoom.textContent(), "150%");
      await viewer.getByRole("button", { name: "Zoom out" }).click();
      assert.equal(await zoom.textContent(), "100%");
      // the wheel zooms at the pointer, and a drag pans the zoomed picture
      await page.mouse.move(centre.x + 100, centre.y);
      await page.mouse.wheel(0, -1200);
      assert.notEqual(await zoom.textContent(), "100%");
      const before = await transform();
      await page.mouse.down();
      await page.mouse.move(centre.x + 40, centre.y + 20, { steps: 4 });
      await page.mouse.up();
      assert.notEqual(await transform(), before, "dragged");
      // zoomed, the arrows pan rather than step
      await page.keyboard.press("ArrowRight");
      assert.equal(await count.textContent(), "1 of 3");
      await page.keyboard.press("0");
      assert.equal(await zoom.textContent(), "100%");
      await page.keyboard.press("+");
      assert.equal(await zoom.textContent(), "150%");
      await page.keyboard.press("0");
      // at fit the arrows and the side buttons step, wrapping at both ends
      await page.keyboard.press("ArrowRight");
      assert.equal(await count.textContent(), "2 of 3");
      assert.equal(await name.textContent(), "second.png");
      await viewer.getByRole("button", { name: "Next image" }).click();
      assert.equal(await name.textContent(), "diagram");
      await viewer.getByRole("button", { name: "Next image" }).click();
      assert.equal(await count.textContent(), "1 of 3");
      await page.keyboard.press("ArrowLeft");
      assert.equal(await count.textContent(), "3 of 3");
      await viewer.getByRole("button", { name: "Previous image" }).click();
      assert.equal(await count.textContent(), "2 of 3");
      // a double click toggles fit and 2.5x
      await page.mouse.dblclick(centre.x, centre.y);
      assert.equal(await zoom.textContent(), "250%");
      await page.mouse.dblclick(centre.x, centre.y);
      assert.equal(await zoom.textContent(), "100%");
      // copy puts a PNG on the clipboard
      await viewer.getByRole("button", { name: "Copy image" }).click();
      await page.waitForFunction(() => document.querySelector(".image-viewer-status").textContent !== "");
      assert.equal(await viewer.locator(".image-viewer-status").textContent(), "Copied.");
      const copiedType = await page.evaluate(async () => (await navigator.clipboard.read())[0].types.join(","));
      assert.equal(copiedType, "image/png");
      // download saves the file under its own name
      const [saved] = await Promise.all([page.waitForEvent("download"), viewer.getByRole("button", { name: "Download image" }).click()]);
      assert.equal(saved.suggestedFilename(), "second.png");
      if (shots) await page.screenshot({ path: join(shots, "viewer-desktop.png") });
    } else {
      // touch: CDP touch points, as a finger sends them
      const cdp = await context.newCDPSession(page);
      const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
      const swipe = async (from, to) => {
        await touch("touchStart", [from]);
        for (let step = 1; step <= 5; step += 1) await touch("touchMove", [[from[0] + (to[0] - from[0]) * step / 5, from[1] + (to[1] - from[1]) * step / 5]]);
        await touch("touchEnd", []);
      };
      await swipe([centre.x + 120, centre.y], [centre.x - 120, centre.y]);
      assert.equal(await count.textContent(), "2 of 3", "a swipe left is the next picture");
      await swipe([centre.x - 120, centre.y], [centre.x + 120, centre.y]);
      assert.equal(await count.textContent(), "1 of 3", "a swipe right is the previous one");
      await swipe([centre.x - 120, centre.y], [centre.x + 120, centre.y]);
      assert.equal(await count.textContent(), "3 of 3", "and it wraps");
      // a pinch zooms
      await touch("touchStart", [[centre.x - 40, centre.y], [centre.x + 40, centre.y]]);
      for (let step = 1; step <= 5; step += 1) await touch("touchMove", [[centre.x - 40 - step * 20, centre.y], [centre.x + 40 + step * 20, centre.y]]);
      await touch("touchEnd", []);
      assert.equal(await zoom.textContent(), "350%");
      // zoomed, a swipe pans and does not step
      const before = await transform();
      await swipe([centre.x, centre.y], [centre.x - 100, centre.y]);
      assert.equal(await count.textContent(), "3 of 3");
      assert.notEqual(await transform(), before);
      // a double tap goes back to fit
      for (let tap = 0; tap < 2; tap += 1) {
        await touch("touchStart", [[centre.x, centre.y]]);
        await touch("touchEnd", []);
      }
      assert.equal(await zoom.textContent(), "100%");
      // the page itself never zoomed
      assert.equal(await page.evaluate(() => window.visualViewport.scale), 1);
      if (shots) await page.screenshot({ path: join(shots, "viewer-phone.png") });
    }

    // Esc closes it, and the chat is as it was
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
    assert.equal(await page.locator('.md-image[data-state="shown"]').count(), 3);
    assert.deepEqual(remote, []);
    assert.deepEqual(errors, []);
    console.log({ mobile, inline: 3, fallbacks: 2, remoteLinkOnly: true, viewer: true });
    await context.close();
  }
} finally {
  await browser.close();
  attachments.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
