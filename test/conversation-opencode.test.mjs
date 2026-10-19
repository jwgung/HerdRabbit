// OpenCode's conversations, read from a synthetic opencode.db (fixtures/opencode-db.mjs):
// where a pane's session is, how its rows read as turns, pages by message keys,
// tool output, the change identity, and that only the fixed statements run.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, utimes } from "node:fs/promises";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PAGE_PROMPTS, TOOL_OUTPUT_MAX_CHARS, TOOL_OUTPUT_PREVIEW_CHARS } from "../src/conversation/pages.mjs";
import {
  IDENTITY_RECHECK_MS,
  LARGE_ROW_BYTES,
  LARGE_TEXT_CHARS,
  PENDING_QUESTION_BYTES,
  STATEMENTS,
  defaultOpencodeDb,
  localOpencodeStore,
  parseOpencodeTurns,
} from "../src/conversation/opencode.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { OPENCODE_SCHEMA, opencodeDb } from "./fixtures/opencode-db.mjs";
import { fakeOpencodeHerdr } from "./fixtures/opencode-prompt.mjs";

const SESSION = "ses_0001AAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "ses_0002AAAAAAAAAAAAAAAAAAAAAA";
const CHILD = "ses_0003AAAAAAAAAAAAAAAAAAAAAA";
const texts = (turns) => turns.map((turn) => turn.parts.map((part) => part.text ?? `[${part.kind}]`).join(" "));

async function temp(context) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-opencode-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function world(context, { schema } = {}) {
  const directory = await temp(context);
  const path = join(directory, "opencode.db");
  const fixture = opencodeDb(path, { schema });
  context.after(() => fixture.close());
  return { path, fixture, store: localOpencodeStore({ path }) };
}

function service(path, panes) {
  return new ConversationService({
    herdr: { async snapshot() { return { panes }; } },
    localStore: localTranscriptStore({ configDir: "/nonexistent/claude", codexHome: "/nonexistent/codex", opencodeDb: path }),
  });
}

test("the database is under $XDG_DATA_HOME, else ~/.local/share", () => {
  assert.equal(defaultOpencodeDb({ XDG_DATA_HOME: "/data" }, "/home/u"), "/data/opencode/opencode.db");
  assert.equal(defaultOpencodeDb({ XDG_DATA_HOME: "relative" }, "/home/u"), "/home/u/.local/share/opencode/opencode.db");
  assert.equal(defaultOpencodeDb({}, "/home/u"), "/home/u/.local/share/opencode/opencode.db");
});

test("finds a pane's session by the id herdr reports, else the newest top-level session of its folder", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  fixture.session(OTHER, { directory: "/work/app" });
  fixture.exchange(OTHER, 2);
  // a subagent's session is newer, in the same folder, and never the pane's
  fixture.session(CHILD, { directory: "/work/app", parent: OTHER });
  fixture.exchange(CHILD, 3);
  const reported = (value) => ({ agent: "opencode", kind: "id", source: "herdr:opencode", value });
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: reported(SESSION) },
    { pane_id: "w1:p2", agent: "opencode", cwd: "/elsewhere", foreground_cwd: "/work/app" },
    { pane_id: "w1:p3", agent: "opencode", cwd: "/work/empty" },
    { pane_id: "w1:p4", agent: "opencode", cwd: "/work/app", agent_session: reported("ses_9999AAAAAAAAAAAAAAAAAAAAAA") },
  ]);
  const first = await conversations.page("w1:p1");
  assert.equal(first.source, "opencode-session");
  assert.deepEqual(texts(first.turns), ["prompt 1", "answer 1"]);
  assert.deepEqual(texts((await conversations.page("w1:p2")).turns), ["prompt 2", "answer 2"]);
  await assert.rejects(conversations.page("w1:p3"), (error) => error.reason === "no_session_id");
  // a reported session OpenCode has not written yet reads as no turns
  const empty = await conversations.page("w1:p4");
  assert.deepEqual([empty.turns, empty.cursor], [[], null]);
});

test("reads text, reasoning, tools, todos, questions, images and compactions as turns", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.message(SESSION, { role: "user" }, [
    { type: "text", text: "fix the parser" },
    { type: "text", text: "<file contents>", synthetic: true },
    { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
  ]);
  const long = "x".repeat(TOOL_OUTPUT_PREVIEW_CHARS + 50);
  fixture.message(SESSION, { role: "assistant", modelID: "model-a", providerID: "p", tokens: { input: 10, output: 1, cache: { read: 5, write: 0 } } }, [
    { type: "step-start" },
    { type: "reasoning", text: "Looking at the parser" },
    { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "npm test", description: "Run tests" }, output: long, title: "npm test" } },
    { type: "tool", tool: "read", callID: "call_2", state: { status: "completed", input: { filePath: "/work/app/src/a.js" }, output: "contents" } },
    { type: "tool", tool: "edit", callID: "call_3", state: { status: "completed", input: { filePath: "/work/app/src/a.js", oldString: "a", newString: "b" }, output: "Edit applied" } },
    { type: "tool", tool: "grep", callID: "call_4", state: { status: "error", input: { pattern: "TODO", path: "/work/app" }, error: "no such dir" } },
    { type: "step-finish", reason: "tool-calls" },
  ]);
  fixture.message(SESSION, { role: "assistant", modelID: "model-b", providerID: "p" }, [
    { type: "tool", tool: "todowrite", callID: "call_5", state: { status: "completed", input: { todos: [
      { content: "Read", status: "completed", priority: "high", id: "1" },
      { content: "Fix", status: "in_progress", priority: "high", id: "2" },
    ] }, output: "[]" } },
    { type: "tool", tool: "question", callID: "call_6", state: { status: "running", input: { questions: [{ question: "Which parser?", header: "Parser", options: [{ label: "A" }] }] } } },
    { type: "tool", tool: "apply_patch", callID: "call_7", state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: src/b.js\n@@\n-a\n+b\n*** End Patch" }, output: "ok" } },
    { type: "text", text: "Fixed it." },
  ]);
  fixture.message(SESSION, { role: "user" }, [{ type: "compaction", auto: true }]);
  fixture.message(SESSION, { role: "assistant", summary: true, modelID: "model-b" }, [{ type: "text", text: "Summary of the work" }]);
  fixture.message(SESSION, { role: "assistant", modelID: "model-b", error: { name: "MessageAbortedError", data: { message: "aborted" } } }, []);

  const page = await localOpencodeStore({ path }).page(SESSION);
  assert.deepEqual(page.turns.map((turn) => turn.role), ["user", "assistant", "user"]);
  assert.deepEqual(page.turns[0].parts, [{ kind: "image", media_type: "image/png" }, { kind: "text", text: "fix the parser" }]);
  const [thinking, bash, read, edit, grep, todo, question, patch, answer] = page.turns[1].parts;
  assert.deepEqual(thinking, { kind: "thinking", text: "Looking at the parser" });
  assert.equal(bash.name, "bash");
  assert.equal(bash.summary, "npm test");
  assert.equal(bash.output.length, TOOL_OUTPUT_PREVIEW_CHARS);
  assert.equal(bash.output_truncated, true);
  assert.equal(bash.output_size, long.length);
  assert.match(bash.id, /^prt_/u);
  assert.equal(read.summary, "/work/app/src/a.js");
  assert.deepEqual(JSON.parse(read.input), { file_path: "/work/app/src/a.js" });
  assert.deepEqual(JSON.parse(edit.input), { file_path: "/work/app/src/a.js", old_string: "a", new_string: "b" });
  assert.deepEqual([grep.summary, grep.error, grep.output], ["TODO", true, "no such dir"]);
  assert.equal(todo.name, "todowrite");
  assert.deepEqual(JSON.parse(todo.input).todos.map((item) => item.status), ["completed", "in_progress"]);
  assert.deepEqual([question.summary, question.output], ["Which parser?", ""]);
  assert.equal(patch.summary, "src/b.js");
  assert.ok(patch.input.startsWith("*** Begin Patch"));
  assert.deepEqual(answer, { kind: "text", text: "Fixed it." });
  assert.equal(page.turns[1].parts.length, 9, "an aborted step adds nothing");
  assert.deepEqual(page.turns[2].parts, [{ kind: "compact", text: "Summary of the work" }]);
  assert.equal(page.turns[1].ts, new Date(Date.parse(page.turns[1].ts)).toISOString());
  assert.ok(page.turns[1].end_ts > page.turns[1].ts);
  assert.equal(page.metadata.model, "model-b");

  const store = localOpencodeStore({ path });
  assert.deepEqual(await store.toolOutput(SESSION, bash.id), { output: long, size: long.length });
  assert.equal(await store.toolOutput(SESSION, "prt_missing"), null);
  assert.equal(await store.toolOutput(OTHER, bash.id), null, "another session's part is not this one's");
});

test("a failed step's error reads as the agent's words", () => {
  const turns = parseOpencodeTurns([
    { id: "m1", time: 1, info: { role: "user", time: { created: 1 } }, parts: [{ id: "p1", data: { type: "text", text: "go" } }] },
    { id: "m2", time: 2, info: { role: "assistant", time: { created: 2 }, error: { name: "APIError", data: { message: "rate limited" } } }, parts: [] },
  ]);
  assert.deepEqual(texts(turns), ["go", "Error: rate limited"]);
});

test("pages by message keys: before and since cursors, 409 for another history, ETag", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  for (let n = 0; n < 60; n++) fixture.exchange(SESSION, n);
  const store = localOpencodeStore({ path });
  const newest = await store.page(SESSION);
  assert.equal(newest.turns.length, MAX_PAGE_PROMPTS * 2);
  assert.equal(newest.turns[0].parts[0].text, "prompt 10");
  assert.equal(newest.history_id, SESSION);
  assert.match(newest.cursor, new RegExp(`^${SESSION}:\\d+:msg_`, "u"));
  const older = await store.page(SESSION, { before: newest.cursor });
  assert.deepEqual([older.turns.length, older.turns[0].parts[0].text, older.cursor], [20, "prompt 0", null]);
  assert.deepEqual(await store.page(SESSION, { ifNoneMatch: newest.version }), { notModified: true, version: newest.version });
  // the newest page read from a held start inside it keeps that start
  const held = await store.page(SESSION, { since: newest.cursor });
  assert.deepEqual([held.turns[0].parts[0].text, held.cursor], ["prompt 10", newest.cursor]);

  fixture.exchange(SESSION, 60);
  const grown = await store.page(SESSION, { ifNoneMatch: newest.version });
  assert.notEqual(grown.version, newest.version);
  assert.equal(grown.turns.at(-1).parts[0].text, "answer 60");
  assert.equal(grown.turns[0].parts[0].text, "prompt 11");
  // a held start the newest page moved past: the newest page, from its own start
  const moved = await store.page(SESSION, { since: newest.cursor });
  assert.deepEqual([moved.turns[0].parts[0].text, moved.cursor], ["prompt 11", grown.cursor]);
  // the gap between: the page ending at the new start, never past the held one
  const gap = await store.page(SESSION, { before: grown.cursor, since: newest.cursor });
  assert.deepEqual([texts(gap.turns), gap.cursor], [["prompt 10", "answer 10"], newest.cursor]);

  for (const cursor of ["elsewhere:1:msg_1", `${SESSION}:1:msg_00000001AAAAAAAAAAAAAAAAAA`, `${SESSION}:x:y`, `${OTHER}:1:msg_1`]) {
    await assert.rejects(store.page(SESSION, { before: cursor }), (error) => error.status === 409, cursor);
  }

  // an undo hides the reverted messages and starts the history over
  const reverted = fixture.db.prepare("SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1 OFFSET 1").get(SESSION).id;
  fixture.revert(SESSION, reverted);
  const undone = await store.page(SESSION);
  assert.notEqual(undone.history_id, SESSION);
  assert.equal(undone.turns.at(-1).parts[0].text, "answer 59");
  await assert.rejects(store.page(SESSION, { before: newest.cursor }), (error) => error.status === 409);
});

test("the identity changes with each write to the session, and only then", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.session(OTHER);
  const message = fixture.exchange(SESSION, 1);
  const store = localOpencodeStore({ path });
  const first = await store.stat(SESSION);
  assert.equal(typeof first.identity, "string");
  assert.deepEqual(await store.stat(SESSION), first);
  const part = fixture.part(SESSION, message, { type: "tool", tool: "bash", state: { status: "running", input: { command: "sleep 1" } } });
  const second = await store.stat(SESSION);
  assert.notEqual(second.identity, first.identity);
  fixture.updatePart(SESSION, part, { type: "tool", tool: "bash", state: { status: "completed", input: { command: "sleep 1" }, output: "" } });
  const third = await store.stat(SESSION);
  assert.notEqual(third.identity, second.identity);
  fixture.exchange(OTHER, 2);
  assert.equal((await store.stat(SESSION)).identity, third.identity, "another session's write is not this one's");
  assert.equal(await store.stat("ses_9999AAAAAAAAAAAAAAAAAAAAAA"), null);
  assert.equal(await localOpencodeStore({ path: join(path, "..", "none.db") }).stat(SESSION), null);
});

test("a database without the expected columns is an unsupported OpenCode version", async (context) => {
  const schema = OPENCODE_SCHEMA.replace(" revert text,", "");
  assert.notEqual(schema, OPENCODE_SCHEMA);
  const directory = await temp(context);
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(schema);
  db.close();
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: { agent: "opencode", kind: "id", value: SESSION } },
  ]);
  await assert.rejects(conversations.page("w1:p1"), (error) => error.reason === "unsupported_opencode_version");
  assert.match(await conversations.signature("w1:p1"), /^[A-Za-z0-9_-]{22}$/u);
});

test("only the fixed statements run, and none reads the tables that hold secrets", async (context) => {
  const source = await readFile(new URL("../src/conversation/opencode.mjs", import.meta.url), "utf8");
  for (const table of ["account", "control_account", "account_state", "credential", "session_share", "workspace", "permission", "project"]) {
    assert.equal(new RegExp(`\\b${table}\\b`, "u").test(source), false, `${table} is never named`);
  }
  const allowed = new Set(Object.values(STATEMENTS));
  for (const sql of allowed) {
    assert.doesNotMatch(sql, /SELECT\s+\*/iu, "no statement selects everything");
    const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/giu)].map((match) => match[1]);
    for (const table of tables) assert.ok(["session", "message", "part", "event_sequence", "pragma_table_info"].includes(table), `${table} in ${sql}`);
  }
  const prepared = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    prepared.push(sql);
    return prepare.call(this, sql);
  };
  context.after(() => { DatabaseSync.prototype.prepare = prepare; });
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  for (let n = 0; n < 3; n++) fixture.exchange(SESSION, n, [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a" } }]);
  prepared.length = 0;
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/other", agent_session: { agent: "opencode", kind: "id", value: SESSION } },
    { pane_id: "w1:p2", agent: "opencode", cwd: "/work/app" },
  ]);
  const page = await conversations.page("w1:p1");
  await conversations.page("w1:p2");
  await conversations.toolOutput("w1:p1", page.turns[1].parts[0].id);
  await conversations.signature("w1:p1");
  await conversations.pendingAsk("w1:p1");
  assert.ok(prepared.some((sql) => sql === STATEMENTS.pendingQuestion), "the prompt card's question is read too");
  assert.equal(await conversations.agentVersion("w1:p1"), "1.0.0");
  assert.ok(prepared.some((sql) => sql === STATEMENTS.sessionVersion), "and the version that wrote the session");
  assert.ok(prepared.length > 0);
  for (const sql of prepared) assert.ok(allowed.has(sql), sql);
  const answer = JSON.stringify(page);
  assert.equal(answer.includes("SECRET"), false);
});

const reportedId = (value) => ({ agent: "opencode", kind: "id", source: "herdr:opencode", value });

test("a reported session id that is not an OpenCode id shows no conversation, not the folder's newest", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: reportedId("not-a-session") },
    { pane_id: "w1:p2", agent: "opencode", cwd: "/work/app", agent_session: { agent: "opencode", kind: "path", value: "/x/y" } },
  ]);
  await assert.rejects(conversations.page("w1:p1"), (error) => error.reason === "no_session_id");
  await assert.rejects(conversations.page("w1:p2"), (error) => error.reason === "no_session_id");
});

test("the folder's newest session is nobody's when another OpenCode pane of that folder could claim it", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  fixture.session(OTHER, { directory: "/work/solo" });
  fixture.exchange(OTHER, 2);
  const pane = (id, cwd, extra = {}) => ({ pane_id: id, agent: "opencode", cwd, ...extra });
  const conversations = service(path, [
    pane("w1:p1", "/work/app"),
    pane("w1:p2", "/work/app"),
    pane("w1:p3", "/work/solo"),
  ]);
  await assert.rejects(conversations.page("w1:p1"), (error) => error.reason === "no_session_id");
  await assert.rejects(conversations.page("w1:p2"), (error) => error.reason === "no_session_id");
  assert.deepEqual(texts((await conversations.page("w1:p3")).turns), ["prompt 2", "answer 2"]);
  // a peer that reported the newest session leaves the idle pane without it; a peer on another session does not
  const claimed = service(path, [
    pane("w1:p1", "/work/app"),
    pane("w1:p2", "/work/app", { agent_session: reportedId(SESSION) }),
  ]);
  await assert.rejects(claimed.page("w1:p1"), (error) => error.reason === "no_session_id");
  const apart = service(path, [
    pane("w1:p1", "/work/app"),
    pane("w1:p2", "/work/app", { agent_session: reportedId(OTHER) }),
  ]);
  assert.deepEqual(texts((await apart.page("w1:p1")).turns), ["prompt 1", "answer 1"]);
});

test("without node:sqlite the store says the Node is too old, not that the session is missing", async (context) => {
  const directory = await temp(context);
  const store = localOpencodeStore({ path: join(directory, "opencode.db"), importSqlite: async () => { throw new Error("no such module"); } });
  await assert.rejects(store.locate({ session: SESSION }), (error) => error.reason === "opencode_needs_newer_node");
  await assert.rejects(store.stat(SESSION), (error) => error.reason === "opencode_needs_newer_node");
});

test("a database migrated in place is checked again, though its inode is the same", async (context) => {
  const directory = await temp(context);
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  context.after(() => { try { db.close(); } catch { /* closed */ } });
  db.exec(OPENCODE_SCHEMA);
  db.exec("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('" + SESSION + "', 'p', 's', '/work/app', 't', '1', 1, 1)");
  const store = localOpencodeStore({ path });
  assert.deepEqual(await store.locate({ session: SESSION }), { session: SESSION, found: true });
  db.exec("ALTER TABLE session DROP COLUMN revert");
  const later = new Date(Date.now() + 5000);
  await utimes(path, later, later);
  await assert.rejects(store.locate({ session: SESSION }), (error) => error.reason === "unsupported_opencode_version");
});

test("a 50 MB tool output is never read whole: the page holds its preview, the whole output is fetched capped", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  const huge = "y".repeat(50 * 1024 * 1024);
  const words = "w".repeat(LARGE_TEXT_CHARS * 4);
  fixture.message(SESSION, { role: "user" }, [
    { type: "text", text: "dump it" },
    { type: "file", mime: "image/png", url: `data:image/png;base64,${"A".repeat(LARGE_ROW_BYTES * 2)}` },
  ]);
  fixture.message(SESSION, { role: "assistant", modelID: "model-a" }, [
    { type: "tool", tool: "bash", state: { status: "completed", input: { command: "cat big.log" }, output: huge, title: "cat big.log", metadata: { output: huge } } },
    { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/work/app/big.txt", content: "z".repeat(LARGE_ROW_BYTES * 2) }, output: "Wrote file" } },
    { type: "reasoning", text: words },
    { type: "text", text: "done" },
  ]);
  const store = localOpencodeStore({ path });
  const started = performance.now();
  const page = await store.page(SESSION);
  const elapsed = performance.now() - started;
  assert.ok(JSON.stringify(page).length < 2 * LARGE_TEXT_CHARS + 64 * 1024, "the answer stays small");
  assert.ok(elapsed < 5000, `read in ${elapsed} ms`);
  assert.deepEqual(page.turns[0].parts, [{ kind: "image", media_type: "image/png" }, { kind: "text", text: "dump it" }]);
  const [bash, write, thinking, answer] = page.turns[1].parts;
  assert.equal(bash.summary, "cat big.log");
  assert.deepEqual([bash.output, bash.output_size, bash.output_truncated, bash.output_large], [huge.slice(0, TOOL_OUTPUT_PREVIEW_CHARS), huge.length, true, true]);
  assert.match(bash.id, /^prt_/u);
  assert.deepEqual([write.output, write.output_large, write.input_truncated], ["Wrote file", true, true]);
  assert.equal(thinking.text_truncated, true);
  assert.equal(thinking.text, `${words.slice(0, LARGE_TEXT_CHARS)}\n…`);
  assert.deepEqual(answer, { kind: "text", text: "done" });

  const whole = await store.toolOutput(SESSION, bash.id);
  assert.equal(whole.size, huge.length);
  assert.equal(whole.output.length, TOOL_OUTPUT_MAX_CHARS);
  assert.equal(whole.output, huge.slice(0, TOOL_OUTPUT_MAX_CHARS));
});

test("one page reads its parts in one query and stops at the page's byte budget, newest kept", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  for (let n = 0; n < 20; n++) fixture.exchange(SESSION, n);
  const large = "o".repeat(LARGE_ROW_BYTES + 1024);
  const calls = [];
  const all = StatementSync.prototype.all;
  StatementSync.prototype.all = function (...args) {
    calls.push(this.sourceSQL);
    return all.apply(this, args);
  };
  context.after(() => { StatementSync.prototype.all = all; });
  const store = localOpencodeStore({ path });
  await store.page(SESSION);
  assert.equal(calls.filter((sql) => sql === STATEMENTS.parts).length, 1, "the parts of 40 messages in one read");
  StatementSync.prototype.all = all;

  // one prompt whose parts cost more than a page reads: the newest parts within the budget
  const tools = Array.from({ length: 80 }, (_, n) => ({ type: "tool", tool: "bash", state: { status: "completed", input: { command: `step ${n}` }, output: large } }));
  fixture.exchange(SESSION, 20, tools);
  const page = await store.page(SESSION);
  const shown = page.turns.at(-1).parts.filter((part) => part.kind === "tool");
  assert.ok(shown.length > 0 && shown.length <= (16 * 1024 * 1024) / LARGE_ROW_BYTES, `${shown.length} tools`);
  assert.equal(shown.at(-1).summary, "step 79");
  assert.equal(page.turns.at(-1).parts.at(-1).text, "answer 20");
});

test("undoing to either of two messages of one millisecond starts two different histories", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  for (let n = 0; n < 3; n++) fixture.exchange(SESSION, n);
  const [first, second] = fixture.db.prepare("SELECT id, time_created FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 2 OFFSET 2").all(SESSION);
  fixture.db.prepare("UPDATE message SET time_created = ? WHERE id = ?").run(first.time_created, second.id);
  const store = localOpencodeStore({ path });
  fixture.revert(SESSION, first.id);
  const one = await store.page(SESSION);
  fixture.revert(SESSION, second.id);
  const other = await store.page(SESSION);
  assert.notEqual(one.history_id, other.history_id);
  assert.match(one.history_id, /^[^:]+$/u, "a history id holds no cursor separator");
  // the part undone to names the history too
  fixture.db.prepare("UPDATE session SET revert = ? WHERE id = ?").run(JSON.stringify({ messageID: second.id, partID: "prt_00000099AAAAAAAAAAAAAAAAAA" }), SESSION);
  const part = await store.page(SESSION);
  assert.notEqual(part.history_id, other.history_id);
});

test("a reported subagent's session shows its top-level session's conversation, else no session", async (context) => {
  const { path, fixture } = await world(context);
  const ORPHAN = "ses_0004AAAAAAAAAAAAAAAAAAAAAA";
  const GRANDCHILD = "ses_0005AAAAAAAAAAAAAAAAAAAAAA";
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  fixture.session(CHILD, { directory: "/work/app", parent: SESSION });
  fixture.exchange(CHILD, 2);
  fixture.session(GRANDCHILD, { directory: "/work/app", parent: CHILD });
  fixture.exchange(GRANDCHILD, 3);
  fixture.session(ORPHAN, { directory: "/work/app", parent: "ses_0404AAAAAAAAAAAAAAAAAAAAAA" });
  fixture.exchange(ORPHAN, 4);
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: reportedId(CHILD) },
    { pane_id: "w1:p2", agent: "opencode", cwd: "/work/app", agent_session: reportedId(GRANDCHILD) },
    { pane_id: "w1:p3", agent: "opencode", cwd: "/work/app", agent_session: reportedId(ORPHAN) },
  ]);
  assert.deepEqual(texts((await conversations.page("w1:p1")).turns), ["prompt 1", "answer 1"]);
  assert.deepEqual(texts((await conversations.page("w1:p2")).turns), ["prompt 1", "answer 1"]);
  await assert.rejects(conversations.page("w1:p3"), (error) => error.reason === "no_session_id");
  assert.deepEqual(await localOpencodeStore({ path }).locate({ session: ORPHAN }), { session: ORPHAN, child: true });
});

test("a range with more messages than a page holds is paged back whole: the cursor is the oldest message returned", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  for (let n = 0; n < 12; n++) fixture.exchange(SESSION, n);
  const total = fixture.db.prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ?").get(SESSION).n;
  const store = localOpencodeStore({ path, maxMessages: 5 });
  const seen = [];
  let page = await store.page(SESSION);
  for (let guard = 0; guard < 50; guard++) {
    assert.ok(page.turns.length > 0);
    seen.unshift(...texts(page.turns));
    if (page.cursor === null) break;
    page = await store.page(SESSION, { before: page.cursor });
  }
  assert.equal(page.cursor, null);
  const expected = [];
  for (let n = 0; n < 12; n++) expected.push(`prompt ${n}`, `answer ${n}`);
  assert.equal(total, expected.length);
  assert.deepEqual(seen, expected, "every message exactly once, in order");
});

test("changing the undo target to an id of the same length changes the identity, the ETag and the signature", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  for (let n = 0; n < 3; n++) fixture.exchange(SESSION, n);
  const [first, second] = fixture.db.prepare("SELECT id FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 2 OFFSET 2").all(SESSION);
  const store = localOpencodeStore({ path });
  const conversations = service(path, [{ pane_id: "w1:p1", agent: "opencode", cwd: "/work/other", agent_session: { agent: "opencode", kind: "id", value: SESSION } }]);
  const revertTo = (id) => fixture.db.prepare("UPDATE session SET revert = ? WHERE id = ?").run(JSON.stringify({ messageID: id }), SESSION);
  revertTo(first.id);
  const one = await store.stat(SESSION);
  const page = await store.page(SESSION);
  const signature = await conversations.signature("w1:p1");
  // only the revert column changes: same length, same time_updated, same counts
  revertTo(second.id);
  assert.equal(first.id.length, second.id.length);
  const two = await store.stat(SESSION);
  assert.notEqual(two.identity, one.identity);
  assert.notEqual((await store.page(SESSION)).version, page.version);
  assert.notEqual(await conversations.signature("w1:p1"), signature);
});

test("a write the file stats do not show is still seen within a couple of seconds", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  const message = fixture.exchange(SESSION, 1);
  let clock = 1_000_000;
  // the files' size and time look the same before and after the write
  const statFile = async () => ({ dev: 1, ino: 2, size: 4096, mtimeMs: 5 });
  const store = localOpencodeStore({ path, statFile, now: () => clock });
  const first = await store.stat(SESSION);
  fixture.part(SESSION, message, { type: "text", text: "more" });
  assert.equal((await store.stat(SESSION)).identity, first.identity, "read again at once (the stats alone keep it)");
  clock += IDENTITY_RECHECK_MS;
  assert.notEqual((await store.stat(SESSION)).identity, first.identity, "the write was never seen");
});


test("the question a pane's OpenCode waits on: the newest question call still running, for its prompt card", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  const question = (status, text) => ({ type: "tool", tool: "question", callID: `call_${text}`, state: { status, input: { questions: [{
    question: text, header: "Format", options: [{ label: "ONNX", description: "Portable." }, { label: "TensorRT", description: "NVIDIA." }],
  }] }, ...(status === "completed" ? { output: "ONNX" } : {}) } });
  fixture.exchange(SESSION, 0, [question("completed", "Answered before?")]);
  const conversations = service(path, [{ pane_id: "w1:p1", agent: "opencode", agent_session: { agent: "opencode", kind: "id", value: SESSION } }]);
  assert.equal(await conversations.pendingAsk("w1:p1"), null, "an answered question waits on nothing");
  const message = fixture.exchange(SESSION, 1);
  const part = fixture.part(SESSION, message, question("running", "Which export format should we use?"));
  const ask = await conversations.pendingAsk("w1:p1");
  assert.equal(ask.name, "question");
  assert.equal(ask.input.questions[0].question, "Which export format should we use?");
  assert.equal(ask.input.questions[0].options[0].description, "Portable.");
  fixture.updatePart(SESSION, part, question("completed", "Which export format should we use?"));
  // the session changed: read again (its identity is rechecked within IDENTITY_RECHECK_MS)
  const later = service(path, [{ pane_id: "w1:p1", agent: "opencode", agent_session: { agent: "opencode", kind: "id", value: SESSION } }]);
  assert.equal(await later.pendingAsk("w1:p1"), null);
  // another agent's pane, or none: nothing
  assert.equal(await service(path, [{ pane_id: "w1:p1", agent: "codex" }]).pendingAsk("w1:p1"), null);
});

test("the OpenCode version a pane's session was written by decides its prompt card: 1.18.x has one, any other version or none has none", async (context) => {
  const { path, fixture } = await world(context);
  const versions = { [SESSION]: "1.18.34", [OTHER]: "1.19.0", [CHILD]: "" };
  for (const [id, version] of Object.entries(versions)) fixture.session(id, { version, directory: `/work/${id}` });
  const pane = (id) => ({ pane_id: `w1:${id}`, agent: "opencode", agent_status: "blocked", agent_session: { agent: "opencode", kind: "id", value: id } });
  const cards = async (dbPath) => {
    const panes = Object.keys(versions).map(pane);
    const herdr = fakeOpencodeHerdr({ panes, prompts: Object.fromEntries(panes.map((item) => [item.pane_id, { kind: "permission" }])) });
    const conversations = new ConversationService({
      herdr,
      localStore: localTranscriptStore({ configDir: "/nonexistent/claude", codexHome: "/nonexistent/codex", opencodeDb: dbPath }),
    });
    const prompts = new PromptService({ herdr, stepDelayMs: 1, lookMs: 2, settleMs: 50,
      agentVersion: (paneId, snapshot) => conversations.agentVersion(paneId, snapshot) });
    const shown = {};
    for (const item of panes) shown[versions[item.agent_session.value] || "none"] = (await prompts.card(item.pane_id))?.title ?? null;
    // an answer to the card a 1.18 pane would show goes nowhere on the others
    for (const item of panes.slice(1)) {
      await assert.rejects(prompts.answer(item.pane_id, { cardId: "opencode:permission", option: 0 }), { status: 409 });
    }
    return { shown, sent: herdr.sent, conversations };
  };
  const { shown, sent, conversations } = await cards(path);
  assert.deepEqual(shown, { "1.18.34": "Permission required", "1.19.0": null, none: null });
  assert.deepEqual(sent, [], "nothing sent to a pane of a version the reader does not know");
  assert.equal(await conversations.agentVersion("w1:" + SESSION), "1.18.34");
  assert.equal(await conversations.agentVersion("w1:" + OTHER), "1.19.0");
  // the database cannot be read: no version, no card
  const missing = await cards(join(await temp(context), "none.db"));
  assert.deepEqual(missing.shown, { "1.18.34": null, "1.19.0": null, none: null });
  assert.deepEqual(missing.sent, []);
  assert.equal(await missing.conversations.agentVersion("w1:" + SESSION), null);
});

test("a database whose session table has no version column tells no version, and is still read", async (context) => {
  const schema = OPENCODE_SCHEMA.replace(" version text NOT NULL,", "");
  const { path, fixture } = await world(context, { schema });
  fixture.db.prepare("INSERT INTO session (id, project_id, slug, directory, title, time_created, time_updated) VALUES (?, 'prj_1', 'slug', '/work/app', 'title', 1, 1)").run(SESSION);
  fixture.exchange(SESSION, 0);
  const conversations = service(path, [{ pane_id: "w1:p1", agent: "opencode", agent_session: { agent: "opencode", kind: "id", value: SESSION } }]);
  assert.equal(await conversations.agentVersion("w1:p1"), null);
  assert.equal((await conversations.page("w1:p1")).turns.length > 0, true, "the chat still reads");
});

test("the pending question: the newest running question call decides; a too large one is none, never an older one", async (context) => {
  const { fixture, store } = await world(context);
  fixture.session(SESSION);
  fixture.session(OTHER);
  const question = (status, text, extra = "") => ({ type: "tool", tool: "question", callID: `call_${text.length}`, state: { status, input: { questions: [{
    question: text, header: "Format", options: [{ label: "ONNX", description: `Portable.${extra}` }],
  }] }, ...(status === "completed" ? { output: "ONNX" } : {}) } });
  const asked = async () => (await store.pendingQuestion(SESSION))?.input.questions[0].question ?? null;
  const message = fixture.exchange(SESSION, 0);
  assert.equal(await asked(), null, "no question call");
  fixture.part(SESSION, message, question("completed", "Answered?"));
  assert.equal(await asked(), null, "a completed one is not pending");
  // another session's running question is not this one's
  fixture.part(OTHER, fixture.exchange(OTHER, 0), question("running", "Elsewhere?"));
  assert.equal(await asked(), null);
  fixture.part(SESSION, message, question("running", "First?"));
  fixture.part(SESSION, message, question("running", "Second?"));
  assert.equal(await asked(), "Second?", "several running: the newest");
  // a newer completed call does not hide the newest running one
  fixture.part(SESSION, message, question("completed", "Done?"));
  assert.equal(await asked(), "Second?");
  // the newest running one too large: none at all, not "Second?"
  const big = fixture.part(SESSION, message, question("running", "Huge?", "x".repeat(PENDING_QUESTION_BYTES)));
  assert.equal(await store.pendingQuestion(SESSION), null);
  // just within the limit it is read
  const input = JSON.stringify(question("running", "Huge?").state.input);
  const fits = question("running", "Huge?", "x".repeat(PENDING_QUESTION_BYTES - Buffer.byteLength(input)));
  assert.equal(Buffer.byteLength(JSON.stringify(fits.state.input)), PENDING_QUESTION_BYTES);
  fixture.updatePart(SESSION, big, fits);
  assert.equal(await asked(), "Huge?");
  // a running call without questions decides too: none
  fixture.part(SESSION, message, { type: "tool", tool: "question", callID: "call_x", state: { status: "running", input: {} } });
  assert.equal(await store.pendingQuestion(SESSION), null);
});
