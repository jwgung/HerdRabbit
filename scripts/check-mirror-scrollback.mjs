// Browser check of the mirror in the real xterm: a pane that cannot attach is
// drawn from polled text, the lines above the screen stay in xterm's own
// scrollback, a reader scrolled up keeps their place while new frames come,
// and each frame replaces the last instead of piling onto the scrollback.
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
const listeners = [];
let term;
const view = createAttachedTerminal({
  host: document.getElementById("host"), fontSize: 14, onFallback() {},
  xterm: { ...xterm, Terminal: class extends xterm.Terminal { constructor(options) { super(options); term = this; } } },
  connection: { onAttach: (listener) => listeners.push(listener), onReconnect() {}, attach() {}, detach() {}, resize() {}, acknowledge() {}, ptyInput: () => false },
});
const lines = (prefix) => Array.from({ length: 300 }, (_, index) => prefix + " " + index).join("\\n");
const settle = () => new Promise((resolve) => term.write("", resolve));
const row = (y) => term.buffer.active.getLine(y)?.translateToString(true) ?? "";
window.check = {
  async start() {
    view.show("a");
    for (const listener of listeners) listener({ type: "attach-unavailable", pane_id: "a", code: "attach_unsupported" });
    view.mirror("a", lines("first"));
    await settle();
  },
  state: () => ({ length: term.buffer.active.length, baseY: term.buffer.active.baseY, viewportY: term.buffer.active.viewportY, top: row(0), viewTop: row(term.buffer.active.viewportY) }),
  scrollToTop: () => term.scrollToTop(),
  scrollToBottom: () => term.scrollToBottom(),
  async frame(prefix) { view.mirror("a", lines(prefix)); await settle(); await settle(); },
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
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  await tab.waitForFunction(() => window.ready);
  await tab.evaluate(() => window.check.start());

  let state = await tab.evaluate(() => window.check.state());
  assert.ok(state.length >= 300, `all polled lines are kept (${state.length})`);
  assert.ok(state.baseY > 0, "lines above the screen are in the scrollback");
  assert.equal(state.top, "first 0");

  await tab.evaluate(() => window.check.scrollToTop());
  await tab.evaluate(() => window.check.frame("second"));
  state = await tab.evaluate(() => window.check.state());
  assert.equal(state.viewportY, 0, "a reader scrolled up stays where they are");
  assert.equal(state.viewTop, "first 0", "and keeps reading the frame they scrolled through");

  await tab.evaluate(() => window.check.scrollToBottom());
  await tab.evaluate(() => window.check.frame("third"));
  state = await tab.evaluate(() => window.check.state());
  assert.equal(state.top, "third 0", "back at the bottom, the newest frame is drawn");
  assert.ok(state.length < 600, `a frame replaces the scrollback rather than adding to it (${state.length})`);
  assert.equal(state.viewportY, state.baseY);
  assert.deepEqual(errors, []);
  console.log("mirror scrollback check passed");
} finally {
  await browser.close();
  server.close();
}
