import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { composerEscapeStops, sendButtonMode, showsStop } from "../public/chat/chat-activity.js";

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

test("Send turns into Stop only out of the composer, in the Chat lens of a working agent", () => {
  const working = { lens: "chat", agent: "claude", status: "working" };
  assert.equal(sendButtonMode(working), "stop", "composer not focused");
  assert.equal(sendButtonMode({ ...working, agent: "codex" }), "stop");
  assert.equal(sendButtonMode({ ...working, composerFocused: true }), "send", "typing gets Send");
  assert.equal(sendButtonMode({ ...working, lens: "terminal" }), "send", "the terminal has its key bar");
  for (const status of ["idle", "done", "blocked", null]) {
    assert.equal(sendButtonMode({ ...working, status }), "send", String(status));
  }
  assert.equal(sendButtonMode({ ...working, agent: null }), "send", "no agent");
});

test("the Send button doubles as Stop and the press decides which", async () => {
  const page = await read("../public/index.html");
  const app = await read("../public/app.js");
  const composer = page.match(/<div class="input-composer">[\s\S]*?<\/form>/u)?.[0] ?? "";
  // one button, no separate Stop
  assert.doesNotMatch(page, /id="stop-button"/u);
  assert.match(composer, /<button class="primary-button send-button" type="submit" data-mode="send" aria-label="Send" title="Send">[\s\S]*?class="send-icon-now"[\s\S]*?class="stop-icon"[\s\S]*?<\/button>/u);
  // the label and title follow the mode
  assert.match(app, /button\.setAttribute\("aria-label", stop \? "Stop" : "Send"\);\s*button\.title = stop \? "Stop \(Esc\)" : "Send";/u);
  // a Stop in flight disables only Stop, never Send
  assert.match(app, /button\.disabled = stop \? busy : composerSending;/u);
  // the mode is taken at pointerdown, before focus leaves the composer, and a
  // Stop press never submits the form
  assert.match(app, /sendButton\.addEventListener\("pointerdown", \(\) => \{[\s\S]{0,120}pressedSendMode = sendButtonMode\(\);/u);
  assert.match(app, /const mode = pressedSendMode \?\? sendButtonMode\(\);[\s\S]{0,160}event\.preventDefault\(\);\s*void stopAgent\(\);/u);
  // the key bar's Esc, sent at once to the pane Stop was pressed for: never
  // queued behind (and dropped for) another key on its way
  assert.match(app, /const paneId = state\.selectedPaneId;[\s\S]{0,900}await sendKeys\(\["esc"\], paneId\);/u);
  // the @ list answers Esc before the Stop shortcut
  assert.match(app, /if \(atFiles\.handleKeydown\(event\)\) return;\s*\/\/ Esc in the composer stops the agent/u);
});
