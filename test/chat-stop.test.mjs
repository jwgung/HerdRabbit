import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { composerEscapeStops, showsStop } from "../public/chat/chat-activity.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Stop shows only in the Chat lens of a working Claude or Codex pane", () => {
  for (const agent of ["claude", "codex", "Claude"]) {
    assert.equal(showsStop({ lens: "chat", agent, status: "working" }), true, agent);
  }
  for (const status of ["idle", "done", "blocked", "unknown", null]) {
    assert.equal(showsStop({ lens: "chat", agent: "claude", status }), false, String(status));
  }
  assert.equal(showsStop({ lens: "terminal", agent: "claude", status: "working" }), false, "the terminal has its key bar");
  for (const agent of [null, "", "gemini"]) {
    assert.equal(showsStop({ lens: "chat", agent, status: "working" }), false, String(agent));
  }
});

test("Esc in the composer stops only when Stop shows and nothing else answers Esc", () => {
  const esc = { key: "Escape", stopShown: true };
  assert.equal(composerEscapeStops(esc), true);
  assert.equal(composerEscapeStops({ ...esc, stopShown: false }), false, "nothing to stop");
  assert.equal(composerEscapeStops({ ...esc, ownedElsewhere: true }), false, "the @ list, find bar or a dialog has it");
  assert.equal(composerEscapeStops({ ...esc, isComposing: true }), false, "the IME has it");
  assert.equal(composerEscapeStops({ ...esc, keyCode: 229 }), false, "the IME has it");
  for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) {
    assert.equal(composerEscapeStops({ ...esc, [modifier]: true }), false, modifier);
  }
  assert.equal(composerEscapeStops({ ...esc, key: "Enter" }), false);
});

test("the composer has a hidden Stop button that sends the key bar's Esc", async () => {
  const page = await read("../public/index.html");
  const app = await read("../public/app.js");
  const composer = page.match(/<div class="input-composer">[\s\S]*?<\/form>/u)?.[0] ?? "";
  // beside Send, before it, and hidden until the agent works
  assert.match(composer, /<button\s+id="stop-button"\s+class="secondary-button stop-button"\s+type="button"\s+aria-label="Stop"\s+title="Stop \(Esc\)"\s+hidden\s*>[\s\S]*?<\/button>\s*<button class="primary-button send-button"/u);
  // the key bar's Esc, sent at once to the pane Stop was pressed for: never
  // queued behind (and dropped for) another key on its way
  assert.match(app, /const paneId = state\.selectedPaneId;[\s\S]{0,900}await sendKeys\(\["esc"\], paneId\);/u);
  // the @ list answers Esc before the Stop shortcut
  assert.match(app, /if \(atFiles\.handleKeydown\(event\)\) return;\s*\/\/ Esc in the composer stops the agent/u);
});
