import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sessionAgentChoices } from "../public/agents.js";

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
  assert.match(html, /<label for="session-agent">Agent<\/label>\s*<select id="session-agent"/u);
  assert.match(html, /<label for="session-name">Session name<\/label>\s*<input id="session-name"[^>]*maxlength="120"/u);
  const rows = await readFile(new URL("../public/app/sidebar-rows.js", import.meta.url), "utf8");
  assert.match(rows, /label: "New session…"/u);
});
