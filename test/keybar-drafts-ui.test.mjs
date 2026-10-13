import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [app, page, worker, server, notices, css] = await Promise.all([
  read("../public/app.js"), read("../public/index.html"), read("../public/sw.js"),
  read("../src/http-server.mjs"), read("../THIRD_PARTY_NOTICES.md"), read("../public/key-bar.css"),
]);

test("the new files are served and cached for offline use", () => {
  for (const name of ["composer-draft-preference.js", "key-bar-preference.js", "key-bar.css", "secret-prompt.js"]) {
    assert.match(server, new RegExp(`"/${name.replace(".", "\\.")}"`, "u"), `${name} is served`);
    assert.match(worker, new RegExp(`"/${name.replace(".", "\\.")}\\?v=`, "u"), `${name} is cached`);
  }
  assert.match(page, /href="\/key-bar\.css\?v=/u);
});

test("the key bar is drawn from the saved layout; its Edit keys control sits at the foot of the sidebar", () => {
  assert.match(page, /<div class="quick-keys" id="quick-keys"[^>]*><\/div>/u, "the bar starts empty and is filled by the script");
  assert.match(page, /<dialog id="key-bar-dialog"/u);
  assert.match(app, /readKeyBarItems\(panePreferenceStorage\)/u);
  assert.match(page, /<button\s+id="key-bar-settings"[^>]*aria-label="Edit keys"/u);
  assert.match(app, /elements\.keyBarSettings\.addEventListener\("click", \(\) => \{[^}]*closeMobileSidebar\(\);\s*openKeyBarDialog\(\);/u);
  assert.doesNotMatch(app, /key-bar-edit|EDIT_KEYS_ICON/u, "nothing of the editor is left in the bar itself");
  assert.match(app, /draggable = true/u, "rows drag on a desktop");
  assert.match(app, /"Move up"/u);
  assert.match(app, /"Move down"/u);
  assert.match(page, /Reset to default/u);
  assert.match(css, /\.key-bar-item\[data-drop=/u);
});

test("a saved combination sends its own chord, a plain key the held modifiers", () => {
  assert.match(app, /button\.dataset\.chord !== undefined \? button\.dataset\.chord\.split\("\+"\) : \[\.\.\.selectedKeyModifiers\]/u);
});

test("drafts: saved on pane switch, cleared before a send, never kept for a password", () => {
  assert.match(app, /function syncComposerDraft\(\)/u);
  assert.equal([...app.matchAll(/syncComposerDraft\(\);/gu)].length >= 3, true, "every place that selects a pane syncs the draft");
  assert.match(app, /holdComposerDraft\(paneId\);\s*chatLens\.sent\(paneId, null\)/u, "the stored draft goes before the message does");
  assert.match(app, /releaseComposerDraft\(paneId, \{ sent: delivered, text, secret \}\)/u, "a password answer is released as secret");
  assert.match(app, /if \(secret && draftPaneId === paneId && elements\.terminalInput\.value !== ""\) draftBlocked\.add\(paneId\)/u);
  assert.match(app, /state\.inputHistoryCursor !== null \? state\.inputHistoryDraft : elements\.terminalInput\.value/u, "a recalled history entry is not the draft");
  assert.match(app, /scheduleComposerDraftSave\(\);\n\}\);/u);
});

test("sign-out drops the drafts, and an unverifiable screen keeps a draft out of storage", () => {
  // every way out of a sign-in (sign-out, expired session) goes through showLogin
  assert.match(app, /function forgetComposerDrafts\(\) \{[^}]*composerDrafts\.clearAll\(\)/u);
  assert.match(app, /function showLogin\(\) \{\s*forgetComposerDrafts\(\);/u);
  assert.match(app, /draftScreenIsSecret\(paneId, draftPaneId, attachedTerminal\.screenText\(8\)\)/u);
  assert.match(app, /composerDrafts\.set\(paneId, text, \{ memoryOnly: true \}\)/u, "a send that failed after leaving the pane is not written");
  assert.doesNotMatch(page, /key-bar-feedback/u);
  assert.match(app, /KEY_BAR_MODIFIERS\.filter/u);
});

test("the ported files carry their attribution, and the notices list them", () => {
  for (const file of ["key-bar-preference.js", "composer-draft-preference.js", "key-bar.css"]) {
    assert.match(notices, new RegExp(`public/${file.replace(".", "\\.")}`, "u"), `${file} is in THIRD_PARTY_NOTICES.md`);
  }
});
