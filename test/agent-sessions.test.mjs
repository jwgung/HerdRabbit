// A folder's earlier agent sessions, listed from each agent's own store
// (synthetic fixtures only), and the command that resumes one: a fixed table
// plus an id that must look like that agent's ids.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSessions,
  MAX_LISTED_SESSIONS,
  canResume,
  cleanSessionList,
  resumeCommand,
  sessionTitle,
} from "../src/agent-sessions.mjs";
import { claudeProjectDir } from "../src/conversation/claude.mjs";
import { kiroWorkspaceHash } from "../src/conversation/kiro.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { opencodeDb } from "./fixtures/opencode-db.mjs";

const CLAUDE_A = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const CLAUDE_B = "1d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const CLAUDE_C = "2d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const THREAD_A = "019da5c2-66fd-7021-b565-5e94406b028e";
const THREAD_B = "019da5c2-0000-7000-8000-000000000001";
const KIRO_A = "3d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const KIRO_B = "4d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const OC_A = "ses_0001AAAAAAAAAAAAAAAAAAAAAA";
const OC_B = "ses_0002AAAAAAAAAAAAAAAAAAAAAA";
const OC_CHILD = "ses_0003AAAAAAAAAAAAAAAAAAAAAA";
const OC_ARCHIVED = "ses_0004AAAAAAAAAAAAAAAAAAAAAA";
const OC_ELSEWHERE = "ses_0005AAAAAAAAAAAAAAAAAAAAAA";
const FOLDER = "/work/My App";
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const at = (iso) => new Date(iso);

async function temp(context) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-agent-sessions-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A lister over a store whose roots are all under `root` (nothing real is read).
function lister(context, root, { opencodeDbPath = join(root, "none.db"), limit } = {}) {
  const store = localTranscriptStore({
    configDir: join(root, "claude"), codexHome: join(root, "codex"), kiroConfigDir: join(root, "kiro"),
    agyDataDir: join(root, "agy"), opencodeDb: opencodeDbPath,
  });
  context.after(() => store.opencode.close());
  return new AgentSessions({ store, ...(limit ? { limit } : {}) });
}

// ---------------------------------------------------------------------------
// The command.

test("each resumable agent is resumed by its own verified flag", () => {
  assert.equal(resumeCommand("claude", CLAUDE_A), `claude --resume ${CLAUDE_A}`);
  assert.equal(resumeCommand("codex", THREAD_A), `codex resume ${THREAD_A}`);
  assert.equal(resumeCommand("opencode", OC_A), `opencode --session ${OC_A}`);
  assert.equal(resumeCommand("kiro", `sess_${KIRO_A}`), `kiro-cli chat --resume-id sess_${KIRO_A}`);
  assert.deepEqual(["claude", "codex", "opencode", "kiro", "agy", "cursor", "toString", 7].map(canResume),
    [true, true, true, true, false, false, false, false]);
});

test("an id that is not exactly that agent's kind of id builds no command", () => {
  const refused = [
    ["claude", `${CLAUDE_A}; rm -rf /`],
    ["claude", `${CLAUDE_A}\n`],
    ["claude", ` ${CLAUDE_A}`],
    ["claude", "$(id)"],
    ["claude", OC_A],
    ["codex", `sess_${KIRO_A}`],
    ["opencode", CLAUDE_A],
    ["opencode", "ses_abc def"],
    ["opencode", `ses_${"A".repeat(65)}`],
    ["kiro", KIRO_A],
    ["kiro", `sess_${KIRO_A}x`],
    ["claude", 7],
    ["claude", null],
    ["agy", CLAUDE_A],
    ["cursor", CLAUDE_A],
    ["toString", CLAUDE_A],
    ["__proto__", CLAUDE_A],
  ];
  for (const [agent, id] of refused) assert.equal(resumeCommand(agent, id), null, `${agent} ${JSON.stringify(id)}`);
});

test("a title is one line of plain text, cut short", () => {
  assert.equal(sessionTitle("  Fix the\n\tlogin   bug \u0007 "), "Fix the login bug");
  assert.equal(sessionTitle("<b>bold</b>"), "<b>bold</b>", "markup is kept as text; the page never renders it");
  assert.equal(sessionTitle("x".repeat(200)), `${"x".repeat(119)}…`);
  assert.equal(sessionTitle(null), "");
  assert.equal(sessionTitle(42), "");
});

test("a list from another machine keeps only well-formed sessions of that agent", () => {
  const list = cleanSessionList("claude", [
    { id: CLAUDE_A, title: "First\nline", updatedAt: 1000 },
    { id: CLAUDE_A, title: "again", updatedAt: 999 },
    { id: "rm -rf /", title: "bad", updatedAt: 1 },
    { id: OC_A, title: "another agent's", updatedAt: 1 },
    { id: CLAUDE_B, title: { html: "<img>" }, updatedAt: "soon" },
    "nonsense",
    null,
  ]);
  assert.deepEqual(list, [
    { id: CLAUDE_A, title: "First line", updatedAt: 1000 },
    { id: CLAUDE_B, title: "", updatedAt: null },
  ]);
  assert.deepEqual(cleanSessionList("claude", "nope"), []);
  assert.deepEqual(cleanSessionList("agy", [{ id: CLAUDE_A }]), []);
  const many = Array.from({ length: MAX_LISTED_SESSIONS + 5 }, (_, n) =>
    ({ id: `${String(n).padStart(8, "0")}-8a3b-4c55-9d2e-6f7a8b9c0d1e`, title: "t", updatedAt: n }));
  assert.equal(cleanSessionList("claude", many).length, MAX_LISTED_SESSIONS);
});

// ---------------------------------------------------------------------------
// Listing, per agent.

test("lists a folder's Claude sessions newest first, titled by their own title or first prompt", async (context) => {
  const root = await temp(context);
  const project = join(root, "claude", "projects", claudeProjectDir(FOLDER));
  await mkdir(project, { recursive: true });
  const write = async (id, entries, mtime) => {
    const path = join(project, `${id}.jsonl`);
    await writeFile(path, jsonl(entries));
    await utimes(path, mtime, mtime);
  };
  const user = (content) => ({ type: "user", message: { role: "user", content }, sessionId: "x" });
  const answer = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  // titled by Claude, then renamed by the user: the name wins
  await write(CLAUDE_A, [user("first prompt A"), answer("ok"), { type: "ai-title", aiTitle: "Claude's title" },
    { type: "custom-title", customTitle: "My  name" }], at("2026-10-01T10:00:00Z"));
  // no title yet: its first real prompt, not a command or a meta line
  await write(CLAUDE_B, [{ type: "user", isMeta: true, message: { role: "user", content: "hidden" } },
    user("<command-name>/model</command-name>"), user("first prompt\nB"), answer("ok")], at("2026-10-02T10:00:00Z"));
  // nothing said in it: nothing to resume
  await write(CLAUDE_C, [{ type: "permission-mode", permissionMode: "default" }], at("2026-10-03T10:00:00Z"));
  await writeFile(join(project, "notes.jsonl"), jsonl([user("not a session file")]));
  // another folder's session is not this folder's
  const other = join(root, "claude", "projects", claudeProjectDir("/work/other"));
  await mkdir(other, { recursive: true });
  await writeFile(join(other, `${CLAUDE_C}.jsonl`), jsonl([user("elsewhere")]));

  const sessions = await lister(context, root).list("claude", FOLDER);
  assert.deepEqual(sessions, [
    { id: CLAUDE_B, title: "first prompt B", updatedAt: Date.parse("2026-10-02T10:00:00Z") },
    { id: CLAUDE_A, title: "My name", updatedAt: Date.parse("2026-10-01T10:00:00Z") },
  ]);
  assert.deepEqual(await lister(context, root).list("claude", "/work/none"), []);
});

test("lists a folder's interactive Codex threads from Codex's index, newest first", async (context) => {
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { context.skip("node:sqlite is not available"); return; }
  const root = await temp(context);
  const home = join(root, "codex");
  const day = join(home, "sessions", "2026", "10", "01");
  await mkdir(day, { recursive: true });
  const rollout = async (id) => {
    const path = join(day, `rollout-2026-10-01T01-00-00-${id}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: FOLDER, source: "cli" } })}\n`);
    return path;
  };
  const db = new sqlite.DatabaseSync(join(home, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT,
    source TEXT, updated_at INTEGER, updated_at_ms INTEGER, title TEXT, first_user_message TEXT)`);
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(THREAD_A, await rollout(THREAD_A), FOLDER, 0, null, "cli", 100, 100_000, "Codex title", "first A");
  insert.run(THREAD_B, await rollout(THREAD_B), FOLDER, 0, null, "vscode", 200, 200_000, "", "first prompt B");
  // not a conversation of this folder's own to resume
  insert.run("019da5c2-0000-7000-8000-000000000002", await rollout("019da5c2-0000-7000-8000-000000000002"), FOLDER, 0, null, "exec", 300, 300_000, "exec run", "");
  insert.run("019da5c2-0000-7000-8000-000000000003", await rollout("019da5c2-0000-7000-8000-000000000003"), FOLDER, 1, null, "cli", 400, 400_000, "archived", "");
  insert.run("019da5c2-0000-7000-8000-000000000004", await rollout("019da5c2-0000-7000-8000-000000000004"), FOLDER, 0, "worker", "cli", 500, 500_000, "subagent", "");
  insert.run("019da5c2-0000-7000-8000-000000000005", await rollout("019da5c2-0000-7000-8000-000000000005"), "/work/other", 0, null, "cli", 600, 600_000, "other folder", "");
  insert.run("019da5c2-0000-7000-8000-000000000006", join(day, "gone.jsonl"), FOLDER, 0, null, "cli", 700, 700_000, "file gone", "");
  insert.run("not-a-thread-id", await rollout("not-a-thread-id"), FOLDER, 0, null, "cli", 800, 800_000, "bad id", "");
  db.close();

  assert.deepEqual(await lister(context, root).list("codex", FOLDER), [
    { id: THREAD_B, title: "first prompt B", updatedAt: 200_000 },
    { id: THREAD_A, title: "Codex title", updatedAt: 100_000 },
  ]);
});

test("Codex without its index lists nothing rather than scanning every rollout", async (context) => {
  const root = await temp(context);
  await mkdir(join(root, "codex", "sessions"), { recursive: true });
  assert.deepEqual(await lister(context, root).list("codex", FOLDER), []);
});

test("lists a folder's Kiro sessions by Kiro's own session ids, titled by session.json or the first prompt", async (context) => {
  const root = await temp(context);
  const workspace = join(root, "kiro", "sessions", kiroWorkspaceHash(FOLDER));
  const write = async (uuid, lines, { meta, mtime }) => {
    const dir = join(workspace, `sess_${uuid}`);
    await mkdir(dir, { recursive: true });
    if (lines) {
      await writeFile(join(dir, "messages.jsonl"), jsonl(lines));
      await utimes(join(dir, "messages.jsonl"), mtime, mtime);
    }
    if (meta) await writeFile(join(dir, "session.json"), JSON.stringify(meta));
  };
  const rec = (payload) => ({ id: "evt", timestamp: "2026-10-01T00:00:00.000Z", payload });
  await write(KIRO_A, [rec({ type: "user", content: "first prompt A" }), rec({ type: "turn_start", executionId: "e", turnId: "t" })],
    { meta: { id: `sess_${KIRO_A}`, title: "Kiro title" }, mtime: at("2026-10-01T10:00:00Z") });
  await write(KIRO_B, [rec({ type: "user", content: "first\nprompt B" }), rec({ type: "turn_start", executionId: "e", turnId: "t" })],
    { mtime: at("2026-10-02T10:00:00Z") });
  // a session directory with no transcript yet is skipped
  await write("5d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e", null, { meta: { title: "empty" } });
  await mkdir(join(workspace, ".index"), { recursive: true });

  assert.deepEqual(await lister(context, root).list("kiro", FOLDER), [
    { id: `sess_${KIRO_B}`, title: "first prompt B", updatedAt: Date.parse("2026-10-02T10:00:00Z") },
    { id: `sess_${KIRO_A}`, title: "Kiro title", updatedAt: Date.parse("2026-10-01T10:00:00Z") },
  ]);
});

for (const v2 of [false, true]) {
  test(`lists a folder's top-level OpenCode sessions newest first (${v2 ? "OpenCode 2 tables" : "first tables"})`, async (context) => {
    const root = await temp(context);
    const path = join(root, "opencode.db");
    const fixture = opencodeDb(path, { v2 });
    context.after(() => fixture.close());
    const table = v2 ? "session_v2" : "session";
    fixture.session(OC_A, { directory: FOLDER });
    fixture.session(OC_B, { directory: FOLDER });
    fixture.session(OC_CHILD, { directory: FOLDER, parent: OC_A });
    fixture.session(OC_ARCHIVED, { directory: FOLDER, archived: 1 });
    fixture.session(OC_ELSEWHERE, { directory: "/work/other" });
    fixture.db.prepare(`UPDATE ${table} SET title = ?, time_updated = ? WHERE id = ?`).run("Title A", 1000, OC_A);
    fixture.db.prepare(`UPDATE ${table} SET title = ?, time_updated = ? WHERE id = ?`).run("Title\nB", 2000, OC_B);

    assert.deepEqual(await lister(context, root, { opencodeDbPath: path }).list("opencode", FOLDER), [
      { id: OC_B, title: "Title B", updatedAt: 2000 },
      { id: OC_A, title: "Title A", updatedAt: 1000 },
    ]);
  });
}

test("OpenCode with no database yet lists nothing", async (context) => {
  const root = await temp(context);
  assert.deepEqual(await lister(context, root).list("opencode", FOLDER), []);
});

test("a list is at most the lister's limit, the newest kept", async (context) => {
  const root = await temp(context);
  const project = join(root, "claude", "projects", claudeProjectDir(FOLDER));
  await mkdir(project, { recursive: true });
  for (const [n, id] of [CLAUDE_A, CLAUDE_B, CLAUDE_C].entries()) {
    const path = join(project, `${id}.jsonl`);
    await writeFile(path, jsonl([{ type: "user", message: { role: "user", content: `prompt ${n}` } }]));
    await utimes(path, 1000 + n, 1000 + n);
  }
  assert.deepEqual((await lister(context, root, { limit: 2 }).list("claude", FOLDER)).map((session) => session.id), [CLAUDE_C, CLAUDE_B]);
});

test("agents without a verified resume flag or a folder listing, and folders that are not absolute, list nothing", async (context) => {
  const root = await temp(context);
  const sessions = lister(context, root);
  assert.equal(await sessions.list("agy", FOLDER), null);
  assert.equal(await sessions.list("cursor", FOLDER), null);
  assert.equal(await sessions.list("toString", FOLDER), null);
  assert.deepEqual(await sessions.list("claude", "relative/folder"), []);
  assert.deepEqual(await sessions.list("claude", `/work/${"x".repeat(5000)}`), []);
  assert.deepEqual(await sessions.list("claude", "/work/a\u0000b"), []);
  assert.deepEqual(await sessions.list("claude", 7), []);
});
