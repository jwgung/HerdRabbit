import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { queueSummary, shouldQueue, stateLabel } from "../public/chat/pending-messages.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the composer queues while the agent works or asks, and behind messages that still wait", () => {
  assert.equal(shouldQueue({ status: "working" }), true);
  assert.equal(shouldQueue({ status: "blocked" }), true);
  for (const status of ["idle", "done", "unknown", null]) assert.equal(shouldQueue({ status }), false);
  assert.equal(shouldQueue({ status: "idle", items: [{ id: "a", state: "failed" }] }), true, "order is kept behind a held queue");
  assert.equal(shouldQueue(), false);
});

test("each queued row says what it is waiting for", () => {
  assert.equal(stateLabel({ state: "queued" }), "Queued");
  assert.equal(stateLabel({ state: "sending" }), "Sending…");
  assert.equal(stateLabel({ state: "failed" }), "Not sent");
  assert.equal(queueSummary([{ state: "queued" }]), "1 message for the next turn");
  assert.equal(queueSummary([{ state: "queued" }, { state: "failed" }]),
    "2 messages for the next turn · held until the failed one is retried or removed");
});

test("the list sits over the composer in both lenses, and one send button that offers Queue or Send now", async () => {
  const page = await read("../public/index.html");
  const form = page.slice(page.indexOf('<form id="input-form"'), page.indexOf("</form>", page.indexOf('<form id="input-form"')));
  assert.match(form, /id="pending-messages"[^>]*hidden/u);
  assert.ok(form.indexOf('id="pending-messages"') < form.indexOf('class="input-composer"'), "the list comes before the composer row");
  assert.doesNotMatch(page, /send-now-button/u, "there is one send button, not two");
  assert.equal((form.match(/type="submit"/gu) ?? []).length, 1);
  assert.match(form, /id="send-menu"[^>]*role="menu"[^>]*hidden/u);
  assert.match(form, /id="send-menu-queue"[^>]*role="menuitem"[\s\S]*Queue for next turn/u);
  assert.match(form, /id="send-menu-now"[^>]*role="menuitem"[\s\S]*Send now/u);
  assert.match(page, /\/chat\/pending-messages\.css\?v=/u);
  const app = await read("../public/app.js");
  // Alt+Enter is the keyboard's send now; Enter and Ctrl+Enter keep their jobs
  assert.match(app, /event\.key === "Enter" && event\.altKey/u);
  assert.doesNotMatch(app, /sendNowButton/u);
  // in queue mode the button opens the menu (aria-haspopup/expanded); Enter queues without it
  assert.match(app, /setAttribute\("aria-haspopup", "menu"\)/u);
  assert.match(app, /setAttribute\("aria-expanded", "true"\)/u);
  assert.match(app, /if \(!composerQueues\(\) \|\| !elements\.terminalInput\.value\) return;\s*event\.preventDefault\(\);/u);
  assert.match(app, /submitComposer\(\{ now: true \}\)/u);
  assert.match(app, /event\.key === "Escape"[\s\S]{0,120}closeSendMenu\(\)/u);
  assert.match(app, /"ArrowDown" \|\| event\.key === "ArrowUp"/u);
  const worker = await read("../public/sw.js");
  assert.match(worker, /"\/chat\/pending-messages\.js\?v=/u);
  assert.match(worker, /"\/chat\/pending-messages\.css\?v=/u);
  const server = await read("../src/http-server.mjs");
  assert.match(server, /\["\/chat\/pending-messages\.js"/u);
  assert.match(server, /\["\/chat\/pending-messages\.css"/u);
});

test("the list keeps the newest revision it heard, whether it came as an answer or a push", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../public/chat/pending-messages.js", import.meta.url), "utf8");
  assert.match(source, /if \(Number\.isInteger\(at\)\) \{\s*if \(at < revision\) return;\s*revision = at;/u);
  assert.match(source, /setItems\(payload\.items, \[\], payload\.revision\)/u);
  assert.match(source, /setItems\(message\.items, message\.removed \?\? \[\], message\.revision\)/u);
  assert.match(source, /paneId = next;\s*items = \[\];\s*revision = -1;/u);
});

test("a send-now answer updates the list by itself, and a queued draft clears only if it is still the one on screen", async () => {
  const { readFile } = await import("node:fs/promises");
  const list = await readFile(new URL("../public/chat/pending-messages.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(list, /action !== "send-now"\) setItems/u);
  assert.match(list, /setItems\(payload\.items, \[\], payload\.revision\);/u);
  assert.match(app, /if \(state\.selectedPaneId === paneId && elements\.terminalInput\.value === text\) clearComposer\(\);/u);
});
