import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sessionAgentChoices, sessionChoiceLabel } from "../public/agents.js";
import { sessionProjectChoices } from "../public/ui-model.js";

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
// The "+" menu: New session… picks its project; New project… may start an agent.

test("New session from + offers every project, the selected pane's first", () => {
  const servers = [{ id: "local", name: "This PC" }, { id: "lab", name: "Lab" }];
  const workspaces = [
    { workspace_id: "w1", label: "Platform", server_id: "local" },
    { workspace_id: "lab!w1", label: "Bench", server_id: "lab" },
    { workspace_id: "w2", server_id: "local" },
  ];
  const panes = [{ pane_id: "lab!w1:p1", workspace_id: "lab!w1" }];
  assert.deepEqual(sessionProjectChoices({ servers, workspaces, panes, selectedPaneId: "lab!w1:p1" }), {
    selected: "lab!w1",
    choices: [
      { value: "w1", label: "This PC / Platform", workspaceLabel: "Platform", serverId: "local" },
      { value: "w2", label: "This PC / Project", workspaceLabel: "Project", serverId: "local" },
      { value: "lab!w1", label: "Lab / Bench", workspaceLabel: "Bench", serverId: "lab" },
    ],
  });
  // no pane chosen, or one that is gone: the first project
  assert.equal(sessionProjectChoices({ servers, workspaces, panes, selectedPaneId: null }).selected, "w1");
  assert.equal(sessionProjectChoices({ servers, workspaces, panes, selectedPaneId: "gone" }).selected, "w1");
});

test("with one machine, a project is offered by its own name; with none, nothing is offered", () => {
  const { choices } = sessionProjectChoices({
    servers: [{ id: "local", name: "This PC" }],
    workspaces: [{ workspace_id: "w1", label: "Platform" }],
    panes: [],
    selectedPaneId: null,
  });
  assert.deepEqual(choices, [{ value: "w1", label: "Platform", workspaceLabel: "Platform", serverId: "local" }]);
  assert.deepEqual(sessionProjectChoices({ servers: [], workspaces: [], panes: [] }), { selected: "", choices: [] });
});

test("+ holds New session and New project, and Connect PC moved to this machine's row", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const menu = html.match(/<details id="add-menu"[\s\S]*?<\/details>/u)[0];
  assert.match(menu, /aria-label="New session or project"\s*title="New session or project"/u);
  assert.deepEqual([...menu.matchAll(/role="menuitem">([^<]+)</gu)].map((match) => match[1]), ["New session…", "New project…"]);
  assert.doesNotMatch(menu, /Connect PC|manage-servers/u);
  assert.match(html, /<label id="session-project-label" for="session-project" hidden>Project<\/label>\s*<select id="session-project" hidden>/u);
  assert.match(html, /<label for="project-agent">Agent<\/label>\s*<select id="project-agent">/u);
  const navigation = await readFile(new URL("../public/app/navigation.js", import.meta.url), "utf8");
  assert.match(navigation, /label: "Connect PC…"/u);
});
