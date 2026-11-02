import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AI_LOGIN_LABEL_PREFIX,
  aiAccountNotice,
  aiAccountsToSave,
  aiLoginSessionId,
  aiRestartHint,
  isAiLoginWorkspace,
  paneKeepsInputHistory,
  sortAiAccounts,
} from "../public/ui-model.js";
import { readAppSource } from "./app-source.mjs";

const NOW = Date.parse("2026-09-13T00:00:00Z");

test("the sign-in project prefix matches the one the server uses", async () => {
  const server = await readFile(new URL("../src/http-server.mjs", import.meta.url), "utf8");
  assert.match(server, new RegExp(`AI_LOGIN_LABEL_PREFIX = "${AI_LOGIN_LABEL_PREFIX}"`, "u"));
});

test("nothing typed into a sign-in terminal is kept as prompt history", () => {
  const records = {
    workspaces: [
      { workspace_id: "w1", label: "api" },
      { workspace_id: "w2", label: "AI login: Claude Code (1234abcd)" },
    ],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1" }, { pane_id: "w2:p1", workspace_id: "w2" }],
  };
  assert.equal(paneKeepsInputHistory("w1:p1", records), true);
  assert.equal(paneKeepsInputHistory("w2:p1", records), false);
  assert.equal(paneKeepsInputHistory("unknown", records), true);
  assert.equal(isAiLoginWorkspace({ label: "AI login" }), false);
});

test("an account says nothing more until a new sign-in is close", () => {
  assert.equal(aiAccountNotice({ plan: "max", refreshExpiresAt: NOW + 27 * 86_400_000 }, { now: NOW }), null);
  assert.equal(aiAccountNotice({ plan: "max", refreshExpiresAt: NOW + 86_400_000 }, { now: NOW }), "Sign in again soon");
  assert.equal(aiAccountNotice({ refreshExpiresAt: NOW - 1 }, { now: NOW }), "Sign-in expired");
  assert.equal(aiAccountNotice({ plan: "plus", refreshExpiresAt: null }, { now: NOW }), null);
});

test("opening the list saves the accounts signed in now", async () => {
  assert.deepEqual(aiAccountsToSave([
    { id: "claude", supported: true, current: { id: null, email: "a@example.com" } },
    { id: "codex", supported: true, current: { id: "acct_x", email: "a@example.com" } },
    { id: "other", supported: false, current: { id: null } },
    { id: "none", supported: true, current: null },
  ]), ["claude"]);
  const app = await readAppSource();
  assert.match(app, /aiAccountsToSave\(array\(payload\.clis\)\)[\s\S]*?"\/api\/ai-accounts\/current"/);
  assert.doesNotMatch(app, /aiButton\("Save"/);
});

test("an idle sign-in panel stays hidden, and buttons stay small", async () => {
  // The panel sets its own display, which would otherwise show it empty.
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.ai-accounts-panel \{[^}]*display: grid/u);
  assert.match(styles, /\.ai-accounts-panel\[hidden\] \{ display: none; \}/u);
  assert.match(styles, /\.ai-accounts-dialog :is\(\.primary-button, \.secondary-button\) \{[^}]*min-height: 30px/u);
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(page, /id="ai-accounts-login" class="ai-accounts-panel" hidden/u);
});

test("switching over running agents is confirmed in its own window", async () => {
  const app = await readAppSource();
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /ai-accounts-confirm/u, "no panel inside the account list");
  const switching = app.match(/^( *)async function switchAiAccount\(cli, account, confirmRunning = false\) \{[\s\S]*?\n\1\}/mu)?.[0];
  assert.ok(switching, "switchAiAccount must exist");
  assert.match(switching, /error\.code !== "agents_running" \|\| confirmRunning/u, "asked once, never in a loop");
  assert.match(switching, /window\.confirm\(\[[\s\S]*?"Switch anyway\?"/u);
  assert.match(switching, /await switchAiAccount\(cli, account, true\);/u);
});

test("machine details name the machine and show no address", async () => {
  const app = await readAppSource();
  const details = app.match(/^( *)function showServerDetails\(server\) \{[\s\S]*?\n\1\}/mu)?.[0];
  assert.ok(details, "showServerDetails must exist");
  assert.match(details, /\["Machine", server\.machine\]/u);
  assert.doesNotMatch(details, /"Address"/u);
});

test("a sign-in is saved on its own once the CLI is signed in", async () => {
  const app = await readAppSource();
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /ai-accounts-login-finish/u, "there is no Finish button to press");
  const watch = app.match(/^( *)function watchAiLogin\(server, login\) \{[\s\S]*?\n\1\}/mu)?.[0];
  assert.ok(watch, "watchAiLogin must exist");
  assert.match(watch, /window\.setInterval\([\s\S]*?\/finish`/u);
  assert.match(watch, /error\.code === "login_incomplete"\) return;/u, "not signed in yet keeps waiting");
  assert.match(watch, /AI_LOGIN_GIVE_UP_MS/u);
  assert.match(app, /pendingAiLogins\.set\(server\.id, login\);\s*watchAiLogin\(server, login\);/u);
});

test("a saved sign-in brings the account list back with the new account marked", async () => {
  const app = await readAppSource();
  const watch = app.match(/^( *)function watchAiLogin\(server, login\) \{[\s\S]*?\n\1\}/mu)?.[0];
  assert.ok(watch, "watchAiLogin must exist");
  // Not over another dialog, nor over this one showing another machine.
  assert.match(watch, /dialog\[open\][\s\S]*?dialog !== aiAccountsDialog\)[\s\S]*?aiAccounts\.server\?\.id !== server\.id\);\s*if \(elsewhere\) return;/u);
  assert.match(watch, /aiAccounts\.highlight = payload\.account\.id;[\s\S]*?else await showAiAccounts\(/u);
  assert.match(app, /function showAiAccounts\(server\) \{[\s\S]*?return aiAccountsAction\(loadAiAccounts\);\s*\}/u, "the list is loaded before the saved message is shown");
  const row = app.match(/^( *)function aiAccountRow\(cli, account\) \{[\s\S]*?\n\1\}/mu)?.[0];
  assert.match(row, /account\.id === aiAccounts\.highlight/u);
  assert.match(row, /text: "Just added"/u);
  assert.match(app, /aiAccountsDialog\.addEventListener\("close", \(\) => \{ aiAccounts\.highlight = null; \}\);/u);
});

test("a reload picks up a sign-in that was still waiting", async () => {
  const app = await readAppSource();
  const server = await readFile(new URL("../src/http-server.mjs", import.meta.url), "utf8");
  // The sign-in project is found again by the id fragment the server puts in its label.
  assert.match(server, /\$\{AI_LOGIN_LABEL_PREFIX\}\$\{login\.label\} \(\$\{login\.loginId\.slice\(6, 14\)\}\)/u);
  assert.match(app, /const tag = `\(\$\{loginId\.slice\(6, 14\)\}\)`;/u);
  assert.match(app, /settleAiLogins\(server, array\(payload\.clis\)\);\s*renderAiLogin\(\);/u);
  assert.match(app, /resumeAiLogins\(\)/u);
});

test("a saved sign-in does not come back as a wait", async () => {
  const app = await readAppSource();
  // Saved: remembered, and never taken up again from a list fetched just before.
  assert.match(app, /\.then\(async \(payload\) => \{\s*finishedAiLogins\.add\(login\.loginId\);/u);
  assert.match(app, /array\(cli\.logins\)\.find\(\(id\) => !finishedAiLogins\.has\(id\)\)/u);
  // A wait the server no longer lists ends when the list is loaded.
  const settle = app.match(/^( *)function settleAiLogins\(server, clis\) \{[\s\S]*?\n\1\}/mu)?.[0];
  assert.ok(settle, "settleAiLogins must exist");
  assert.match(settle, /if \(pending && !open\.has\(pending\.loginId\)\) \{[\s\S]*?pendingAiLogins\.delete\(server\.id\);/u);
});

test("every action on another account sits in one menu", async () => {
  const app = await readAppSource();
  const row = app.match(/^( *)function aiAccountRow\(cli, account\) \{[\s\S]*?\n\1\}/mu)?.[0];
  assert.ok(row, "aiAccountRow must exist");
  assert.doesNotMatch(row, /aiButton\(/u, "no separate Switch button");
  assert.match(row, /sidebarActionMenu\([\s\S]*?label: "Switch"[\s\S]*?label: "Remove"/u);
});

test("a sign-in opens in a running session of the chosen server", () => {
  const sessions = [
    { session_id: "hs_a", server_id: "local", running: false },
    { session_id: "hs_b", server_id: "local", running: true, available: true },
    { session_id: "link_x!hs_c", server_id: "link_x", running: true, available: false },
  ];
  assert.equal(aiLoginSessionId("local", sessions), "hs_b");
  assert.equal(aiLoginSessionId("link_x", sessions), null);
  assert.equal(aiRestartHint("codex"), "codex resume");
  assert.equal(aiRestartHint("claude"), "claude --continue");
});

test("accounts are listed A to Z by email, the one in use included", () => {
  const accounts = [
    { email: "zoe@example.com", active: true },
    { email: null },
    { email: "Bob@example.com" },
    { email: "alice@example.com" },
  ];
  assert.deepEqual(sortAiAccounts(accounts).map((account) => account.email), [
    "alice@example.com",
    "Bob@example.com",
    "zoe@example.com",
    null,
  ]);
  assert.equal(accounts[0].email, "zoe@example.com");
});

test("a row showing In use is as tall as one holding a menu", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.ai-account-actions \{[^}]*min-height: 28px;/u);
  assert.match(styles, /\.workspace-action \{[^}]*height: 28px;/u);
});
