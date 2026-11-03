import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sessionAgentChoices, sessionChoiceLabel } from "../public/agents.js";

test("a new session offers a shell first, then the installed agents in the table's order", () => {
  assert.deepEqual(sessionAgentChoices(["cursor", "codex", "claude", "kiro", "agy", "opencode"]), [
    { value: "", label: "Shell" },
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "opencode", label: "OpenCode" },
    { value: "kiro", label: "Kiro" },
    { value: "agy", label: "Antigravity" },
    { value: "cursor", label: "Cursor Agent" },
  ]);
});

test("nothing installed, or names the page does not know, leave only the shell", () => {
  assert.deepEqual(sessionAgentChoices([]), [{ value: "", label: "Shell" }]);
  assert.deepEqual(sessionAgentChoices(["mystery", "toString", 3]), [{ value: "", label: "Shell" }]);
  assert.deepEqual(sessionAgentChoices(null), [{ value: "", label: "Shell" }]);
});

test("the project menu opens the New session dialog, and the dialog has an agent and a name", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<dialog id="session-dialog" class="app-dialog"/u);
  assert.match(html, /<fieldset id="session-agent" class="agent-picker">\s*<legend>Agent<\/legend>\s*<div class="agent-choices"><\/div>/u);
  assert.match(html, /<label for="session-name">Session name<\/label>\s*<input id="session-name"[^>]*maxlength="120"/u);
  const rows = await readFile(new URL("../public/app/sidebar-rows.js", import.meta.url), "utf8");
  assert.match(rows, /label: "New session…"/u);
});

test("an earlier session is offered by its title and how long ago it was used", () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const label = (session) => sessionChoiceLabel(session, now);
  assert.equal(label({ title: "Fix login", updatedAt: now - 20_000 }), "Fix login · just now");
  assert.equal(label({ title: "Fix login", updatedAt: now - 5 * 60_000 }), "Fix login · 5 min ago");
  assert.equal(label({ title: "Fix login", updatedAt: now - 3 * 3_600_000 }), "Fix login · 3 h ago");
  assert.equal(label({ title: "Fix login", updatedAt: now - 2 * 86_400_000 }), "Fix login · 2 d ago");
  assert.equal(label({ title: "Fix login", updatedAt: Date.UTC(2026, 6, 4, 12) }), "Fix login · Jul 4");
  assert.equal(label({ title: "Fix login", updatedAt: Date.UTC(2025, 6, 4, 12) }), "Fix login · Jul 4, 2025");
  assert.equal(label({ title: "", updatedAt: now - 5 * 60_000 }), "Untitled session · 5 min ago");
  assert.equal(label({ title: "Fix login", updatedAt: null }), "Fix login");
});

test("the New session dialog can resume an earlier session", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<label id="session-resume-label" for="session-resume" hidden>Session<\/label>\s*<select id="session-resume" hidden>/u);
});

// ---------------------------------------------------------------------------
// No + at the top: New session… is a project's, New project… a machine's.

test("there is no + menu; New project is on a machine's menu and Connect PC on this machine's", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="add-menu"|id="create-session"|id="create-project"|id="session-project"/u);
  assert.match(html, /<fieldset id="project-agent" class="agent-picker">\s*<legend>Agent<\/legend>/u);
  const navigation = await readFile(new URL("../public/app/navigation.js", import.meta.url), "utf8");
  assert.match(navigation, /label: "New project…",[\s\S]*?onSelect: \(\) => openNewProject\(server\.id\)/u);
  assert.match(navigation, /label: "Connect PC…"/u);
});
