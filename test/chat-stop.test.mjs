import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { OPENCODE_STOP_CHECK_MS, OPENCODE_STOP_GAP_MS, composerEscapeStops, sendButtonMode, showsStop, stopFollowUp, stopPresses } from "../public/chat/chat-activity.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Stop shows only in the Chat lens of a working Claude, Codex or OpenCode pane", () => {
  for (const agent of ["claude", "codex", "Claude", "opencode", "OpenCode"]) {
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

test("Stop sends one Esc to Claude and Codex, and two apart to OpenCode, which interrupts on the second", () => {
  assert.deepEqual(stopPresses("claude"), { presses: 1, gapMs: 0 });
  assert.deepEqual(stopPresses("codex"), { presses: 1, gapMs: 0 });
  assert.deepEqual(stopPresses("opencode"), { presses: 2, gapMs: OPENCODE_STOP_GAP_MS });
  assert.deepEqual(stopPresses("OpenCode"), { presses: 2, gapMs: OPENCODE_STOP_GAP_MS });
  // apart enough not to read as one Alt+Esc, well inside OpenCode's 5 seconds
  assert.ok(OPENCODE_STOP_GAP_MS >= 100 && OPENCODE_STOP_GAP_MS <= 2_000);
});

test("an OpenCode Stop looks again a moment later and hints, if it still works, that its Escs may have gone elsewhere", async () => {
  // OpenCode's Esc can close its autocomplete or shell mode instead of interrupting
  const followUp = stopFollowUp("OpenCode");
  assert.equal(followUp.afterMs, OPENCODE_STOP_CHECK_MS);
  assert.ok(OPENCODE_STOP_CHECK_MS >= 1_500 && OPENCODE_STOP_CHECK_MS <= 5_000);
  assert.match(followUp.message, /OpenCode is still working.*Stop again/u);
  for (const agent of ["claude", "codex", null]) assert.equal(stopFollowUp(agent), null, String(agent));
  // the page asks for a fresh snapshot and hints only for the pane still selected and still working
  const app = await read("../public/app.js");
  assert.match(app, /const followUp = stopFollowUp\(agent\);\s*if \(followUp\) void hintIfStillWorking\(paneId, followUp\);/u);
  assert.match(app, /async function hintIfStillWorking\(paneId, \{ afterMs, message \}\) \{[\s\S]{0,200}const asked = Date\.now\(\);\s*for \(let tries = 0; tries < 3 && !\(state\.snapshotAt >= asked\); tries \+= 1\) \{\s*if \(state\.snapshotBusy\) await snapshotSettled;\s*else await refreshSnapshot\(\);\s*\}\s*if \(!\(state\.snapshotAt >= asked\)\) return;\s*if \(state\.selectedPaneId === paneId && stopTarget\.paneId === paneId && stopTarget\.status === "working"\) setFeedback\(message\);/u);
  // a fresh snapshot is what the hint stands on: refreshSnapshot marks when the
  // one that arrived was asked for, so one asked for before the Stop never counts
  assert.match(app, /const requestedAt = Date\.now\(\);\s*const payload = await api\("\/api\/snapshot"\);/u);
  assert.match(app, /state\.snapshot = payload\.snapshot \|\| \{\};\s*\/\/[^\n]*\n\s*state\.snapshotAt = requestedAt;/u);
  assert.match(app, /finally \{\s*state\.snapshotBusy = false;\s*settle\(\);\s*\}/u);
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
  assert.match(app, /sendButton\.addEventListener\("pointerdown", \(\) => \{[\s\S]{0,300}const mode = sendButtonMode\(\);[\s\S]{0,200}pressedSendMode = mode;/u);
  assert.match(app, /const mode = pressedSendMode \?\? sendButtonMode\(\);[\s\S]{0,160}event\.preventDefault\(\);\s*void stopAgent\(\);/u);
  // the key bar's Esc, sent at once to the pane Stop was pressed for: never
  // queued behind (and dropped for) another key on its way
  assert.match(app, /const paneId = state\.selectedPaneId;[\s\S]{0,900}await sendKeys\(\["esc"\], paneId, \{ stop: claude \}\);/u);
  // OpenCode's second Esc goes after the pause, without the Claude mark
  assert.match(app, /const \{ presses, gapMs \} = stopPresses\(agent\);\s*for \(let press = 1; press < presses; press \+= 1\) \{\s*await new Promise\(\(resolve\) => window\.setTimeout\(resolve, gapMs\)\);\s*await sendKeys\(\["esc"\], paneId\);/u);
  // the composer's @ and / list answers Esc before the Stop shortcut
  assert.match(app, /if \(composerPopup\.handleKeydown\(event\)\) return;\s*\/\/ Esc in the composer stops the agent/u);
});
