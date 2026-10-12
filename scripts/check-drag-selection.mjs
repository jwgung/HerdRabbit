// Browser check of drag-to-select in the real xterm, under a program that
// tracks the mouse as Claude Code does: a plain left drag selects, the
// selection stays while the mouse moves on (its motion reports still reach
// the program), and typing clears it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = fileURLToPath(new URL("../public/", import.meta.url));
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
const page = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/vendor/xterm.css">
<div id="host" style="width:640px;height:320px"></div>
<script type="module">
import { createAttachedTerminal } from "/xterm-terminal.js";
import * as xterm from "/vendor/xterm.mjs";
let term;
const listeners = [];
window.sent = [];
const view = createAttachedTerminal({
  host: document.getElementById("host"), fontSize: 14, onFallback() {},
  xterm: { ...xterm, Terminal: class extends xterm.Terminal { constructor(options) { super(options); term = this; } } },
  connection: { onAttach: (listener) => listeners.push(listener), onReconnect() {}, attach() {}, detach() {}, resize() {}, acknowledge() {},
    ptyInput: (paneId, data) => { window.sent.push(data); return true; } },
});
view.show("a");
for (const listener of listeners) listener({ type: "input-ready", pane_id: "a" });
window.check = {
  // Any-motion mouse tracking with SGR reports, then some text to select.
  draw: () => new Promise((resolve) => term.write("\\x1b[?1003h\\x1b[?1006hhello selectable world\\r\\nsecond line", resolve)),
  box: () => term.element.querySelector(".xterm-screen").getBoundingClientRect().toJSON(),
  selection: () => term.getSelection(),
  focus: () => term.focus(),
};
window.ready = true;
</script>`;

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://x").pathname;
  if (path === "/") { response.writeHead(200, { "Content-Type": "text/html" }); response.end(page); return; }
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) { response.writeHead(404); response.end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch();
try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  await tab.waitForFunction(() => window.ready);
  await tab.evaluate(() => window.check.draw());
  const box = await tab.evaluate(() => window.check.box());
  const y = box.y + 8;
  await tab.mouse.move(box.x + 2, y);
  await tab.mouse.down();
  await tab.mouse.move(box.x + 120, y, { steps: 8 });
  await tab.mouse.up();
  const selected = await tab.evaluate(() => window.check.selection());
  assert.match(selected, /^hello/u, `a plain drag selects (${JSON.stringify(selected)})`);

  const before = await tab.evaluate(() => window.sent.length);
  await tab.mouse.move(box.x + 300, box.y + 200, { steps: 10 });
  await tab.waitForTimeout(100);
  assert.ok(await tab.evaluate((count) => window.sent.length > count, before), "motion reports still reach the program");
  assert.equal(await tab.evaluate(() => window.check.selection()), selected, "the selection stays while the mouse moves on");

  await tab.evaluate(() => window.check.focus());
  await tab.keyboard.type("x");
  await tab.waitForTimeout(50);
  assert.equal(await tab.evaluate(() => window.check.selection()), "", "typing clears the selection");
  assert.deepEqual(errors, []);
  console.log("drag selection check passed");
} finally {
  await browser.close();
  server.close();
}
