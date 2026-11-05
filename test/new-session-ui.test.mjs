import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sessionAgentChoices, sessionChoiceLabel, sessionChoiceParts } from "../public/agents.js";
import { newTabMachines, newTabPlace, newTabWorkspaces, NEW_WORKSPACE } from "../public/app/session-dialog.js";

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

test("the workspace menu opens the New tab dialog, and the dialog has an agent and a name", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<dialog id="session-dialog" class="app-dialog"/u);
  assert.match(html, /<fieldset id="session-agent" class="agent-picker">\s*<legend>Agent<\/legend>\s*<div class="agent-choices"><\/div>/u);
  assert.match(html, /<label for="session-name">Tab name<\/label>\s*<input id="session-name"[^>]*maxlength="120"/u);
  const rows = await readFile(new URL("../public/app/sidebar-rows.js", import.meta.url), "utf8");
  assert.match(rows, /label: "New tab…"/u);
});

test("an earlier conversation is offered by its title and how long ago it was used", () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const label = (session) => sessionChoiceLabel(session, now);
  assert.equal(label({ title: "Fix login", updatedAt: now - 20_000 }), "Fix login · just now");
  assert.equal(label({ title: "Fix login", updatedAt: now - 5 * 60_000 }), "Fix login · 5 min ago");
  assert.equal(label({ title: "Fix login", updatedAt: now - 3 * 3_600_000 }), "Fix login · 3 h ago");
  assert.equal(label({ title: "Fix login", updatedAt: now - 2 * 86_400_000 }), "Fix login · 2 d ago");
  assert.equal(label({ title: "Fix login", updatedAt: Date.UTC(2026, 6, 4, 12) }), "Fix login · Jul 4");
  assert.equal(label({ title: "Fix login", updatedAt: Date.UTC(2025, 6, 4, 12) }), "Fix login · Jul 4, 2025");
  assert.equal(label({ title: "", updatedAt: now - 5 * 60_000 }), "Untitled conversation · 5 min ago");
  assert.equal(label({ title: "Fix login", updatedAt: null }), "Fix login");
});

test("an earlier conversation's row shows its title and, apart, how long ago", () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  assert.deepEqual(sessionChoiceParts({ title: "Fix login", updatedAt: now - 5 * 60_000 }, now), { title: "Fix login", ago: "5 min ago" });
  assert.deepEqual(sessionChoiceParts({ title: "", updatedAt: null }, now), { title: "Untitled conversation", ago: "" });
});

test("the New tab dialog lists earlier conversations as radio rows, not a select", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<select id="session-resume"/u);
  assert.match(html, /<div id="session-conversations" class="conversation-panel" role="tabpanel"/u);
});

test("the New tab dialog asks, in order, Machine and Workspace, Folder, Agent, conversations, Tab name", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const dialog = html.slice(html.indexOf('<dialog id="session-dialog"'), html.indexOf("</dialog>", html.indexOf('<dialog id="session-dialog"')));
  const order = ['id="session-machine"', 'id="session-workspace"', 'id="session-folder-field"', 'id="session-agent"', 'id="session-conversations"', 'id="session-name"', 'id="session-dialog-cancel"']
    .map((needle) => dialog.indexOf(needle));
  assert.ok(order.every((at) => at > 0), `missing: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(dialog, /<input id="session-workspace-name"[^>]*maxlength="120"/u);
});

// ---------------------------------------------------------------------------
// Where a new tab goes: a machine, then one of its workspaces or a new one.

const records = {
  servers: [
    { id: "local", name: "workstation", available: true },
    { id: "lab", name: "lab", available: false, status: "Offline" },
    { id: "pi", name: "pi", available: true },
  ],
  workspaces: [
    { workspace_id: "w1", label: "Platform", server_id: "local" },
    { workspace_id: "w2", label: "Docs" },
    { workspace_id: "pi:w1", label: "Sensors", server_id: "pi" },
  ],
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", server_id: "local" },
    { pane_id: "pi:w1:p1", workspace_id: "pi:w1", server_id: "pi" },
  ],
};

test("the Machine choice lists every machine with its status for the dot", () => {
  assert.deepEqual(newTabMachines(records.servers), [
    { value: "local", label: "workstation", status: "online" },
    { value: "lab", label: "lab", status: "offline" },
    { value: "pi", label: "pi", status: "online" },
  ]);
  // a snapshot with no machines listed is this one
  assert.deepEqual(newTabMachines([]), [{ value: "local", label: "This machine", status: "online" }]);
});

test("the Workspace choice lists that machine's workspaces (no server_id is this machine's)", () => {
  assert.deepEqual(newTabWorkspaces(records.workspaces, "local"), [{ value: "w1", label: "Platform" }, { value: "w2", label: "Docs" }]);
  assert.deepEqual(newTabWorkspaces(records.workspaces, "lab"), []);
});

test("the dialog opens on the workspace asked for, else the one on show, else the first", () => {
  assert.deepEqual(newTabPlace(records, { workspaceId: "w2" }), { serverId: "local", workspaceId: "w2" });
  assert.deepEqual(newTabPlace(records, { selectedPaneId: "pi:w1:p1" }), { serverId: "pi", workspaceId: "pi:w1" });
  assert.deepEqual(newTabPlace(records, {}), { serverId: "local", workspaceId: "w1" });
  // a machine with no workspace yet opens on New workspace
  assert.deepEqual(newTabPlace({ ...records, workspaces: [] }, {}), { serverId: "local", workspaceId: NEW_WORKSPACE });
  // the first online machine, when the first listed is offline
  assert.deepEqual(newTabPlace({ ...records, servers: records.servers.slice(1) }, {}), { serverId: "pi", workspaceId: "pi:w1" });
});

// ---------------------------------------------------------------------------
// The + at the top opens New tab; New workspace… stays on a machine's menu.

test("the + at the top of the sidebar opens New tab; New workspace is on a machine's menu and Connect PC on this machine's", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="add-menu"|id="create-session"|id="create-project"|id="session-project"/u);
  assert.match(html, /<div class="navigator-heading">[\s\S]*?id="new-tab-open"[^>]*aria-label="New tab"[\s\S]*?<\/div>\s*<div class="navigator-tabs"/u);
  assert.match(html, /<fieldset id="project-agent" class="agent-picker">\s*<legend>Agent<\/legend>/u);
  const navigation = await readFile(new URL("../public/app/navigation.js", import.meta.url), "utf8");
  assert.match(navigation, /label: "New workspace…",[\s\S]*?onSelect: \(\) => openNewProject\(server\.id\)/u);
  assert.match(navigation, /label: "Connect PC…"/u);
});
