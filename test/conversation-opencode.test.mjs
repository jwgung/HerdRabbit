// OpenCode's conversations, read from a synthetic opencode.db (fixtures/opencode-db.mjs):
// where a pane's session is, how its rows read as turns, pages by message keys,
// tool output, the change identity, and that only the fixed statements run.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, utimes } from "node:fs/promises";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { MAX_PAGE_PROMPTS, TOOL_OUTPUT_MAX_CHARS, TOOL_OUTPUT_PREVIEW_CHARS } from "../src/conversation/pages.mjs";
import {
  IDENTITY_RECHECK_MS,
  LARGE_ROW_BYTES,
  LARGE_TEXT_CHARS,
  PENDING_QUESTION_BYTES,
  STATEMENTS,
  answerRequest,
  defaultOpencodeDb,
  WORKER_QUEUE_MAX,
  localOpencodeStore,
  parseOpencodeTurns,
  statementsOf,
} from "../src/conversation/opencode.mjs";
import { opencodeRunningVersion } from "../src/conversation/opencode-process.mjs";
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

// A store whose reading worker is let go when the test ends.
function open(context, options) {
  const store = localOpencodeStore(options);
  context.after(() => store.close());
  return store;
}

async function world(context, { schema } = {}) {
  const directory = await temp(context);
  const path = join(directory, "opencode.db");
  const fixture = opencodeDb(path, { schema });
  context.after(() => fixture.close());
  return { path, fixture, store: open(context, { path }) };
}

function service(path, panes, context) {
  const localStore = localTranscriptStore({ configDir: "/nonexistent/claude", codexHome: "/nonexistent/codex", opencodeDb: path });
  context?.after(() => localStore.opencode.close());
  return new ConversationService({
    herdr: { async snapshot() { return { panes }; } },
    localStore,
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
  ], context);
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

  const page = await open(context, { path }).page(SESSION);
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

  const store = open(context, { path });
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
  const store = open(context, { path });
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
  const store = open(context, { path });
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
  assert.equal(await open(context, { path: join(path, "..", "none.db") }).stat(SESSION), null);
});

test("a database without the V1 columns and without the V2 tables is an unsupported OpenCode version", async (context) => {
  const schema = OPENCODE_SCHEMA.replace(" revert text,", "").split(";\n").filter((statement) => {
    const trimmed = statement.trim();
    // drop the V2 tables and the indexes on them
    if (/^CREATE TABLE session_v2 /u.test(trimmed) || /^CREATE TABLE session_message /u.test(trimmed) || /^CREATE INDEX session_message_/u.test(trimmed) || /^CREATE INDEX session_v2_/u.test(trimmed)) return false;
    return true;
  }).join(";\n");
  assert.notEqual(schema, OPENCODE_SCHEMA);
  const directory = await temp(context);
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(schema);
  db.close();
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: { agent: "opencode", kind: "id", value: SESSION } },
  ], context);
  await assert.rejects(conversations.page("w1:p1"), (error) => error.reason === "unsupported_opencode_version");
  assert.match(await conversations.signature("w1:p1"), /^[A-Za-z0-9_-]{22}$/u);
});

// Every read a store answers, on a session with tool calls.
async function readAll(store, conversations) {
  assert.deepEqual(await store.locate({ session: SESSION }), { session: SESSION, found: true });
  assert.deepEqual(await store.locate({ cwd: "/work/app" }), { session: SESSION, found: true });
  const page = await store.page(SESSION);
  assert.equal((await store.toolOutput(SESSION, page.turns[1].parts[0].id)).output, "a");
  assert.equal(typeof (await store.stat(SESSION)).identity, "string");
  // the prompt card's question, and the version that wrote the session
  await store.pendingQuestion(SESSION);
  assert.equal(await store.sessionVersion(SESSION), "1.0.0");
  if (conversations) {
    await conversations.page("w1:p1");
    await conversations.page("w1:p2");
    await conversations.toolOutput("w1:p1", page.turns[1].parts[0].id);
    await conversations.signature("w1:p1");
    await conversations.pendingAsk("w1:p1");
    assert.equal(await conversations.agentVersion("w1:p1"), "1.0.0");
  }
  return page;
}

test("only the fixed statements run, and none reads the tables that hold secrets", async (context) => {
  for (const file of ["opencode.mjs", "opencode-worker.mjs"]) {
    const source = await readFile(new URL(`../src/conversation/${file}`, import.meta.url), "utf8");
    for (const table of ["account", "control_account", "account_state", "credential", "session_share", "workspace", "permission", "project"]) {
      assert.equal(new RegExp(`\\b${table}\\b`, "u").test(source), false, `${table} is never named in ${file}`);
    }
  }
  const allowed = new Set(Object.values(STATEMENTS));
  for (const sql of allowed) {
    assert.doesNotMatch(sql, /SELECT\s+\*/iu, "no statement selects everything");
    const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/giu)].map((match) => match[1]);
    for (const table of tables) assert.ok(["session", "message", "part", "event_sequence", "pragma_table_info", "json_each", "session_v2", "session_message"].includes(table), `${table} in ${sql}`);
  }
  const prepared = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    prepared.push(sql);
    return prepare.call(this, sql);
  };
  context.after(() => { DatabaseSync.prototype.prepare = prepare; });
  const { path, fixture } = await world(context);
  fixture.session(SESSION, { directory: "/work/app" });
  for (let n = 0; n < 3; n++) fixture.exchange(SESSION, n, [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a" } }]);
  const panes = [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/other", agent_session: { agent: "opencode", kind: "id", value: SESSION } },
    { pane_id: "w1:p2", agent: "opencode", cwd: "/work/app" },
  ];

  // read in this thread: what DatabaseSync itself prepares
  prepared.length = 0;
  const page = await readAll(open(context, { path, createWorker: null }));
  assert.ok(prepared.length > 0);
  for (const sql of prepared) assert.ok(allowed.has(sql), sql);
  for (const name of ["pendingQuestion", "sessionVersion"]) assert.ok(prepared.includes(STATEMENTS[name]), name);
  assert.equal(JSON.stringify(page).includes("SECRET"), false);

  // read in the worker: what the worker's connection prepared, sent back with each answer
  prepared.length = 0;
  const inWorker = [];
  const conversations = service(path, panes, context);
  await readAll(open(context, { path, onPrepare: (sql) => inWorker.push(sql) }), conversations);
  assert.deepEqual(prepared, [], "nothing is prepared in this thread");
  assert.ok(inWorker.length > 0);
  for (const sql of inWorker) assert.ok(allowed.has(sql), sql);
  for (const name of ["pendingQuestion", "sessionVersion"]) assert.ok(inWorker.includes(STATEMENTS[name]), name);
});

test("a statement is prepared only by its name in STATEMENTS, and the worker answers only its operations", async (context) => {
  const db = new DatabaseSync(":memory:");
  context.after(() => db.close());
  const seen = [];
  const handle = statementsOf({ prepare: (sql) => { seen.push(sql); return db.prepare("SELECT 1"); } }, (sql) => seen.push(sql));
  for (const name of ["account", "credential", "toString", "__proto__", "constructor", "SELECT * FROM account", "", null]) {
    assert.throws(() => handle.statement(name), /unknown statement/u, String(name));
  }
  assert.deepEqual(seen, []);
  handle.statement("session");
  assert.deepEqual(seen, [STATEMENTS.session, STATEMENTS.session]);
  // the request handler the worker runs refuses any other operation before touching the database
  const read = () => assert.fail("never read");
  for (const op of ["account", "statement", "toString", "__proto__", undefined]) {
    const answer = answerRequest(read, { id: 1, op, args: [], file: "x" });
    assert.deepEqual([answer.ok, answer.error.type], [false, "error"], String(op));
  }

  // and the worker itself, sent a request by hand
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  let worker;
  const store = open(context, { path, createWorker: (url, options) => (worker = new Worker(url, options)) });
  assert.equal(typeof (await store.stat(SESSION)).identity, "string");
  const answers = [];
  const listen = (message) => { if (message?.id >= 1_000_000) answers.push(message); };
  worker.on("message", listen);
  worker.ref();
  for (const [n, op] of ["account", "statement", "__proto__"].entries()) worker.postMessage({ id: 1_000_000 + n, op, args: ["SELECT * FROM account"], file: "x" });
  while (answers.length < 3) await new Promise((resolve) => setTimeout(resolve, 10));
  worker.off("message", listen);
  worker.unref();
  for (const answer of answers) assert.match(answer.error.message, /unknown operation/u);
  assert.equal(answers.some((answer) => answer.ok), false);
});

test("a slow read in the worker never holds this thread's event loop", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  for (let n = 0; n < 40; n++) fixture.exchange(SESSION, n, [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "o".repeat(LARGE_ROW_BYTES / 2) } }]);
  // the worker is held 500 ms (synchronously, as a long SQLite read holds it) before it reads the page
  const store = open(context, { path, requestDelayMs: () => 500 });
  let ticks = 0;
  let longest = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const at = performance.now();
    longest = Math.max(longest, at - last);
    last = at;
    ticks += 1;
  }, 10);
  context.after(() => clearInterval(timer));
  const started = performance.now();
  const page = await store.page(SESSION);
  const elapsed = performance.now() - started;
  clearInterval(timer);
  assert.equal(page.turns.at(-1).parts.at(-1).text, "answer 39");
  assert.ok(elapsed >= 500, `read in ${elapsed} ms`);
  assert.ok(ticks >= 10, `the timer fired ${ticks} times while the page was read`);
  assert.ok(longest < 400, `the longest gap between ticks was ${longest} ms`);
});

const busy = (error) => error.reason === "opencode_busy";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a read past the timeout reads as a busy database, never a missing session, and a later read starts a new worker", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  let delay = 5000;
  let workers = 0;
  const store = open(context, {
    path, timeoutMs: 1000, requestDelayMs: () => delay,
    createWorker: (url, options) => { workers += 1; return new Worker(url, options); },
  });
  const started = performance.now();
  await assert.rejects(store.page(SESSION), busy);
  assert.ok(performance.now() - started < 4000, "answered at the timeout, not when the read ended");
  // busy, not "missing": nothing answers null, so nothing remembers the session as gone
  await assert.rejects(store.stat(SESSION), busy);
  await assert.rejects(store.locate({ cwd: "/work/app" }), busy);
  await assert.rejects(store.toolOutput(SESSION, "prt_00000001AAAAAAAAAAAAAAAAAA"), busy);
  delay = 0;
  // the dropped worker's wait is interruptible: it is gone by now
  await pause(300);
  assert.deepEqual(texts((await store.page(SESSION)).turns), ["prompt 1", "answer 1"]);
  assert.equal(typeof (await store.stat(SESSION)).identity, "string");
  assert.ok(workers >= 2, `${workers} workers`);
});

test("a worker that times out before it is ready is replaced, not given up for this thread", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.exchange(SESSION, 1);
  let workers = 0;
  const store = open(context, {
    path, timeoutMs: 300,
    // the first worker never says it is ready (its module hangs while loading)
    createWorker: (url, options) => {
      workers += 1;
      return workers === 1 ? new Worker("setInterval(() => {}, 1000);", { eval: true }) : new Worker(url, options);
    },
  });
  await assert.rejects(store.page(SESSION), busy);
  // the dropped worker has ended by now
  await pause(300);
  assert.deepEqual(texts((await store.page(SESSION)).turns), ["prompt 1", "answer 1"]);
  assert.equal(workers, 2, "the next read was not given a new worker");
});

test("reads waiting behind a slow one do not time out for the wait: each read's time starts when the worker takes it", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.exchange(SESSION, 1);
  let workers = 0;
  // each read takes 250 ms, well under the timeout; four at once take 1 s in all
  // (the last waits 750 ms, still under the timeout that bounds the wait too)
  const store = open(context, {
    path, timeoutMs: 1000, requestDelayMs: () => 250,
    createWorker: (url, options) => { workers += 1; return new Worker(url, options); },
  });
  const answers = await Promise.allSettled([0, 1, 2, 3].map(() => store.page(SESSION)));
  assert.deepEqual(answers.map((answer) => answer.status === "fulfilled" ? "ok" : answer.reason.reason), ["ok", "ok", "ok", "ok"]);
  assert.equal(workers, 1);
});

test("a read waits in the queue no longer than the timeout: later ones answer busy once they have waited that long", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  const timeoutMs = 400;
  // each read takes 0.9 x timeout: under it, but five in a row would queue for ~4 x timeout
  const worker = [];
  const store2 = open(context, {
    path, timeoutMs,
    createWorker: () => {
      const fake = new FakeWorker();
      fake.postMessage = function postMessage(message) {
        this.sent.push(message);
        setTimeout(() => this.emit("message", { id: message.id, ok: true, value: { read: this.sent.length } }), timeoutMs * 0.9);
      };
      worker.push(fake);
      return fake;
    },
  });
  const started = performance.now();
  const answers = await Promise.all([0, 1, 2, 3, 4].map(() => store2.page(SESSION).then(
    () => ({ ok: true, at: performance.now() - started }),
    (error) => ({ ok: false, reason: error.reason, at: performance.now() - started }),
  )));
  // (which calls are queued first is not the order they were made in)
  assert.equal(answers.filter((a) => a.ok).length, 2);
  for (const a of answers.filter((a) => !a.ok)) {
    assert.equal(a.reason, "opencode_busy");
    assert.ok(a.at >= timeoutMs - 20 && a.at < timeoutMs * 1.9, `busy after ${a.at} ms, not unbounded`);
  }
  assert.equal(worker[0].sent.length, 2, "the busy ones were never sent to the worker");
  assert.equal(worker.length, 1);
});

test("a queue over its cap answers busy at once", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  const store = open(context, { path, timeoutMs: 300, createWorker: () => new FakeWorker() });
  // one read runs (never answered), WORKER_QUEUE_MAX wait behind it
  const waiting = Array.from({ length: WORKER_QUEUE_MAX + 1 }, () => store.page(SESSION).then(() => "ok", (error) => error.reason));
  const started = performance.now();
  const over = await store.page(SESSION).then(() => "ok", (error) => error.reason);
  assert.equal(over, "opencode_busy");
  assert.ok(performance.now() - started < 100, "answered at once, not after a timeout");
  assert.deepEqual(new Set(await Promise.all(waiting)), new Set(["opencode_busy"]));
});

// A worker as the client sees one: it says it is ready, answers what `answer`
// says (nothing: a read that never ends), and exits only when the test says so
// -- as a worker stuck in a SQLite query terminate() cannot interrupt.
class FakeWorker extends EventEmitter {
  constructor(answer = () => undefined) {
    super();
    this.answer = answer;
    this.sent = [];
    this.refs = [];
    this.terminated = false;
    setImmediate(() => this.emit("message", { ready: true }));
  }
  ref() { this.refs.push("ref"); }
  unref() { this.refs.push("unref"); }
  postMessage(message) {
    this.sent.push(structuredClone(message));
    const value = this.answer(message);
    if (value !== undefined) setImmediate(() => this.emit("message", { id: message.id, ok: true, value }));
  }
  terminate() {
    this.terminated = true;
    return new Promise(() => {});
  }
  exit() { this.emit("exit", 1); }
}

test("while a worker let go has not exited no second one starts, and reads answer busy at once", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.exchange(SESSION, 1);
  const created = [];
  const store = open(context, {
    path, timeoutMs: 200,
    // the first never answers and outlives terminate(); the next answers each read
    createWorker: () => {
      const worker = created.length === 0 ? new FakeWorker() : new FakeWorker(() => ({ read: created.length }));
      created.push(worker);
      return worker;
    },
  });
  // three reads at once: the first times out, the two queued behind it are answered busy with it
  const first = await Promise.allSettled([store.page(SESSION), store.page(SESSION), store.page(SESSION)]);
  assert.deepEqual(first.map((answer) => answer.reason?.reason), ["opencode_busy", "opencode_busy", "opencode_busy"]);
  assert.equal(created.length, 1);
  assert.equal(created[0].terminated, true);
  assert.equal(created[0].sent.length, 1, "nothing queued was sent to the worker let go");
  assert.equal(created[0].refs.at(-1), "unref", "the worker let go does not hold the process");
  // still running: busy at once, and no new worker beside it
  const started = performance.now();
  await assert.rejects(store.page(SESSION), busy);
  await assert.rejects(store.stat(SESSION), busy);
  await assert.rejects(store.locate({ session: SESSION }), busy);
  assert.ok(performance.now() - started < 150, "answered at once, not after a timeout");
  assert.equal(created.length, 1);
  // once it has exited, the next read starts a new worker
  created[0].exit();
  assert.deepEqual(await store.page(SESSION), { read: 2 });
  assert.equal(created.length, 2);
});

test("a worker that dies by itself answers its read busy and its queued reads go to the next worker", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.exchange(SESSION, 1);
  const created = [];
  const store = open(context, {
    path, timeoutMs: 5000,
    createWorker: () => {
      const worker = created.length === 0 ? new FakeWorker() : new FakeWorker((message) => ({ op: message.op }));
      created.push(worker);
      return worker;
    },
  });
  const reads = [store.page(SESSION), store.toolOutput(SESSION, "prt_00000001AAAAAAAAAAAAAAAAAA")];
  await pause(50);
  created[0].emit("error", new Error("out of memory"));
  created[0].exit();
  // which of the two reached the worker first is not fixed (the page looks
  // at the files first): the one in flight answers busy, the queued one goes
  // to the next worker and is answered there
  const settled = await Promise.allSettled(reads);
  const busy = settled.filter((result) => result.reason?.reason === "opencode_busy");
  const answered = settled.filter((result) => result.status === "fulfilled");
  assert.equal(busy.length, 1, JSON.stringify(settled.map((result) => result.status)));
  assert.equal(answered.length, 1);
  const answeredOp = settled[0].status === "fulfilled" ? "page" : "toolOutput";
  assert.deepEqual(answered[0].value, { op: answeredOp });
  assert.equal(created.length, 2);
});

test("a request that cannot be sent fails alone: no timer or reference is left, and the next read is answered", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.exchange(SESSION, 1);
  const created = [];
  const store = open(context, {
    path, timeoutMs: 300,
    createWorker: () => {
      const worker = new FakeWorker((message) => ({ op: message.op }));
      created.push(worker);
      return worker;
    },
  });
  await assert.rejects(store.page(SESSION, { ifNoneMatch: Symbol("not cloneable") }), (error) => error.name === "DataCloneError");
  assert.equal(created[0].refs.at(-1), "unref", "the worker idles again");
  // past the timeout a stale timer would have let the worker go
  await pause(400);
  assert.equal(created[0].terminated, false);
  assert.deepEqual(await store.page(SESSION), { op: "page" });
  assert.equal(created.length, 1);
});

test("a read that times out does not show a reported session as an empty chat, nor remember it as missing", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  let delay = 5000;
  const opencode = open(context, { path, timeoutMs: 300, requestDelayMs: () => delay });
  const conversations = new ConversationService({
    herdr: { async snapshot() { return { panes: [{ pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: { agent: "opencode", kind: "id", value: SESSION } }] }; } },
    localStore: { opencode },
  });
  // locate itself times out: busy, not "no turns yet"
  await assert.rejects(conversations.page("w1:p1"), busy);
  await assert.rejects(conversations.signature("w1:p1"), busy);
  delay = 0;
  await pause(300);
  // read at once afterwards: nothing was remembered as missing
  assert.deepEqual(texts((await conversations.page("w1:p1")).turns), ["prompt 1", "answer 1"]);
  // a page read that times out once located: busy again, and then the conversation is back
  delay = 5000;
  await assert.rejects(conversations.page("w1:p1"), busy);
  delay = 0;
  await pause(300);
  assert.deepEqual(texts((await conversations.page("w1:p1")).turns), ["prompt 1", "answer 1"]);
  assert.equal(typeof (await opencode.stat(SESSION)).identity, "string");
});

test("without a worker the store reads in this thread", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.exchange(SESSION, 1);
  const refused = open(context, { path, createWorker: () => { throw new Error("no threads here"); } });
  assert.deepEqual(texts((await refused.page(SESSION)).turns), ["prompt 1", "answer 1"]);
  // a worker whose module does not load: read here from then on
  let workers = 0;
  const broken = open(context, { path, createWorker: (url, options) => { workers += 1; return new Worker(new URL("./no-such-module.mjs", url), options); } });
  assert.deepEqual(texts((await broken.page(SESSION)).turns), ["prompt 1", "answer 1"]);
  assert.equal(typeof (await broken.stat(SESSION)).identity, "string");
  assert.equal(workers, 1);
});

test("an idle worker does not keep the process running", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  fixture.exchange(SESSION, 1);
  const module = new URL("../src/conversation/opencode.mjs", import.meta.url).href;
  const script = `const { localOpencodeStore } = await import(${JSON.stringify(module)});
const store = localOpencodeStore({ path: ${JSON.stringify(path)} });
const page = await store.page(${JSON.stringify(SESSION)});
console.log(page.turns.length);`;
  const started = performance.now();
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 20_000 });
  assert.equal(stdout.trim(), "2");
  assert.ok(performance.now() - started < 15_000);
});

const reportedId = (value) => ({ agent: "opencode", kind: "id", source: "herdr:opencode", value });

test("a reported session id that is not an OpenCode id shows no conversation, not the folder's newest", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: reportedId("not-a-session") },
    { pane_id: "w1:p2", agent: "opencode", cwd: "/work/app", agent_session: { agent: "opencode", kind: "path", value: "/x/y" } },
  ], context);
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
  ], context);
  await assert.rejects(conversations.page("w1:p1"), (error) => error.reason === "no_session_id");
  await assert.rejects(conversations.page("w1:p2"), (error) => error.reason === "no_session_id");
  assert.deepEqual(texts((await conversations.page("w1:p3")).turns), ["prompt 2", "answer 2"]);
  // a peer that reported the newest session leaves the idle pane without it; a peer on another session does not
  const claimed = service(path, [
    pane("w1:p1", "/work/app"),
    pane("w1:p2", "/work/app", { agent_session: reportedId(SESSION) }),
  ], context);
  await assert.rejects(claimed.page("w1:p1"), (error) => error.reason === "no_session_id");
  const apart = service(path, [
    pane("w1:p1", "/work/app"),
    pane("w1:p2", "/work/app", { agent_session: reportedId(OTHER) }),
  ], context);
  assert.deepEqual(texts((await apart.page("w1:p1")).turns), ["prompt 1", "answer 1"]);
});

test("without node:sqlite the store says the Node is too old, not that the session is missing", async (context) => {
  const directory = await temp(context);
  const store = open(context, { path: join(directory, "opencode.db"), importSqlite: async () => { throw new Error("no such module"); } });
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
  const store = open(context, { path });
  assert.deepEqual(await store.locate({ session: SESSION }), { session: SESSION, found: true });
  db.exec("ALTER TABLE session DROP COLUMN revert");
  db.exec("DROP TABLE session_v2");
  db.exec("DROP TABLE session_message");
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
  const store = open(context, { path });
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
  // read in this thread, where its calls are seen
  const store = open(context, { path, createWorker: null });
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
  const store = open(context, { path });
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
  ], context);
  assert.deepEqual(texts((await conversations.page("w1:p1")).turns), ["prompt 1", "answer 1"]);
  assert.deepEqual(texts((await conversations.page("w1:p2")).turns), ["prompt 1", "answer 1"]);
  await assert.rejects(conversations.page("w1:p3"), (error) => error.reason === "no_session_id");
  assert.deepEqual(await open(context, { path }).locate({ session: ORPHAN }), { session: ORPHAN, child: true });
});

test("a range with more messages than a page holds is paged back whole: the cursor is the oldest message returned", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION);
  for (let n = 0; n < 12; n++) fixture.exchange(SESSION, n);
  const total = fixture.db.prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ?").get(SESSION).n;
  const store = open(context, { path, maxMessages: 5 });
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
  const store = open(context, { path });
  const conversations = service(path, [{ pane_id: "w1:p1", agent: "opencode", cwd: "/work/other", agent_session: { agent: "opencode", kind: "id", value: SESSION } }], context);
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
  const store = open(context, { path, statFile, now: () => clock });
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

test("the OpenCode version a pane's session was written by decides its prompt card: 1.18.x and 1.19.x have one, any other version or none has none", async (context) => {
  const { path, fixture } = await world(context);
  const versions = { [SESSION]: "1.18.34", [OTHER]: "1.20.0", [CHILD]: "" };
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
  assert.deepEqual(shown, { "1.18.34": "Permission required", "1.20.0": null, none: null });
  assert.deepEqual(sent, [], "nothing sent to a pane of a version the reader does not know");
  assert.equal(await conversations.agentVersion("w1:" + SESSION), "1.18.34");
  assert.equal(await conversations.agentVersion("w1:" + OTHER), "1.20.0");
  // the database cannot be read: no version, no card
  const missing = await cards(join(await temp(context), "none.db"));
  assert.deepEqual(missing.shown, { "1.18.34": null, "1.20.0": null, none: null });
  assert.deepEqual(missing.sent, []);
  assert.equal(await missing.conversations.agentVersion("w1:" + SESSION), null);
});

test("the version of the OpenCode program running in the pane decides over the session's record; the record where the program cannot tell", async (context) => {
  const { path, fixture } = await world(context);
  fixture.session(SESSION, { version: "1.19.3", directory: "/work/app" });
  const panes = [{ pane_id: "w1:p1", agent: "opencode", agent_session: { agent: "opencode", kind: "id", value: SESSION } }];
  let foreground = [{ pid: 4100, argv: ["opencode"] }];
  const asked = [];
  const conversations = new ConversationService({
    herdr: { async snapshot() { return { panes }; }, async paneProcessInfo(paneId) { asked.push(paneId); return { process_info: { foreground_processes: foreground } }; } },
    localStore: localTranscriptStore({ configDir: "/nonexistent/claude", codexHome: "/nonexistent/codex", opencodeDb: path }),
    runningVersion: async (pids) => (pids.includes(4100) ? "1.20.1" : null),
  });
  // the session was created by 1.19.3 and is carried on by 1.20.1: 1.20.1
  assert.equal(await conversations.agentVersion("w1:p1"), "1.20.1");
  assert.deepEqual(asked, ["w1:p1"]);
  // no OpenCode program among the pane's processes (or no /proc): the record
  foreground = [{ pid: 4200, argv: ["bash"] }];
  assert.equal(await conversations.agentVersion("w1:p1"), "1.19.3");
  // a session that cannot be read has no version, whatever runs
  const unknown = new ConversationService({
    herdr: { async snapshot() { return { panes: [{ ...panes[0], agent_session: { agent: "opencode", kind: "id", value: "ses_missing0000000000000000" } }] }; },
      async paneProcessInfo() { return { process_info: { foreground_processes: [{ pid: 4100 }] } }; } },
    localStore: localTranscriptStore({ configDir: "/nonexistent/claude", codexHome: "/nonexistent/codex", opencodeDb: path }),
    runningVersion: async () => "1.19.3",
  });
  assert.equal(await unknown.agentVersion("w1:p1"), null);
});

test("the running OpenCode program is asked its version once per program file, through /proc/<pid>/exe", async () => {
  const links = { 10: "/usr/bin/bash", 11: "/home/u/.opencode/bin/opencode (deleted)", 12: "/home/u/.opencode/bin/opencode" };
  const files = { 11: { dev: 1, ino: 7, size: 100, ctimeMs: 5 }, 12: { dev: 1, ino: 9, size: 120, ctimeMs: 6 }, 10: { dev: 1, ino: 3, size: 1, ctimeMs: 1 } };
  const pid = (file) => Number(/^\/proc\/(\d+)\/exe$/u.exec(file)[1]);
  const fs = {
    async readlink(file) { const target = links[pid(file)]; if (!target) throw new Error("ENOENT"); return target; },
    async stat(file) { return files[pid(file)]; },
  };
  const ran = [];
  const outputs = { 11: "1.18.34", 12: "1.19.3" };
  const runningVersion = opencodeRunningVersion({ fs, run: async (file) => { ran.push(file); return outputs[pid(file)] ?? null; } });
  // bash is not OpenCode; a program replaced on disk still answers for itself
  assert.equal(await runningVersion([10, 11]), "1.18.34");
  assert.equal(await runningVersion([11]), "1.18.34");
  assert.equal(await runningVersion([12]), "1.19.3");
  assert.deepEqual(ran, ["/proc/11/exe", "/proc/12/exe"], "once per program file");
  // no such process, no OpenCode among them, nonsense pids: no answer
  assert.equal(await runningVersion([99]), null);
  assert.equal(await runningVersion([10]), null);
  assert.equal(await runningVersion([0, -1, 1.5, "11", null]), null);
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

// ---------------------------------------------------------------------------
// OpenCode 2: the same reads, from session_v2 and session_message (the tables
// OpenCode 2 writes instead; a session the old tables do not hold is read
// from there alone).

async function worldV2(context, { schema } = {}) {
  const directory = await temp(context);
  const path = join(directory, "opencode.db");
  const fixture = opencodeDb(path, { schema, v2: true });
  context.after(() => fixture.close());
  return { path, fixture, store: open(context, { path }) };
}

test("V2: a pane's session is found by id, else the newest top-level of its folder, from the V2 tables", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  fixture.session(OTHER, { directory: "/work/app" });
  fixture.exchange(OTHER, 2);
  fixture.session(CHILD, { directory: "/work/app", parent: OTHER });
  fixture.exchange(CHILD, 3);
  const reported = (value) => ({ agent: "opencode", kind: "id", source: "herdr:opencode", value });
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: reported(SESSION) },
    { pane_id: "w1:p2", agent: "opencode", cwd: "/elsewhere", foreground_cwd: "/work/app" },
    { pane_id: "w1:p3", agent: "opencode", cwd: "/work/empty" },
    { pane_id: "w1:p4", agent: "opencode", cwd: "/work/app", agent_session: reported("ses_9999AAAAAAAAAAAAAAAAAAAAAA") },
  ], context);
  const first = await conversations.page("w1:p1");
  assert.equal(first.source, "opencode-session");
  assert.deepEqual(texts(first.turns), ["prompt 1", "answer 1"]);
  assert.deepEqual(texts((await conversations.page("w1:p2")).turns), ["prompt 2", "answer 2"]);
  await assert.rejects(conversations.page("w1:p3"), (error) => error.reason === "no_session_id");
  const empty = await conversations.page("w1:p4");
  assert.deepEqual([empty.turns, empty.cursor], [[], null]);
});

test("V2: a forked session is an independent conversation, not a subagent", async (context) => {
  const { path, fixture } = await worldV2(context);
  const FORK = "ses_0006AAAAAAAAAAAAAAAAAAAAAA";
  fixture.session(SESSION, { directory: "/work/app" });
  fixture.exchange(SESSION, 1);
  // a fork of SESSION: parent_id = SESSION, fork_session_id = SESSION
  fixture.session(FORK, { directory: "/work/app", forkFrom: SESSION });
  fixture.exchange(FORK, 2);
  // a plain subagent (no fork_session_id) is still a child
  fixture.session(CHILD, { directory: "/work/app", parent: SESSION });
  fixture.exchange(CHILD, 3);
  const store = open(context, { path });
  // the fork is found and is independent (not a child)
  assert.deepEqual(await store.locate({ session: FORK }), { session: FORK, found: true });
  // the fork's own messages are shown, not the parent's
  const page = await store.page(FORK);
  assert.deepEqual(texts(page.turns), ["prompt 2", "answer 2"]);
  // a subagent without fork_session_id is still a child
  assert.deepEqual(await store.locate({ session: CHILD }), { session: SESSION, found: true });
  // through the service: a pane showing the fork gets its own conversation
  const conversations = service(path, [
    { pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: reportedId(FORK) },
  ], context);
  assert.deepEqual(texts((await conversations.page("w1:p1")).turns), ["prompt 2", "answer 2"]);
});

test("V2: reads text, reasoning, tools, errors and questions as turns", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION);
  fixture.message(SESSION, { role: "user" }, [
    { type: "text", text: "fix the parser" },
  ]);
  const long = "x".repeat(TOOL_OUTPUT_PREVIEW_CHARS + 50);
  fixture.message(SESSION, { role: "assistant", modelID: "model-a", providerID: "p", variant: "high", tokens: { input: 10, output: 1, cache: { read: 5, write: 0 } } }, [
    { type: "reasoning", text: "Looking at the parser" },
    { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "npm test" }, output: long } },
    { type: "tool", tool: "read", callID: "call_2", state: { status: "completed", input: { path: "/work/app/src/a.js" }, output: "contents" } },
    { type: "tool", tool: "edit", callID: "call_3", state: { status: "completed", input: { path: "/work/app/src/a.js", oldString: "a", newString: "b" }, output: "Edit applied" } },
    { type: "tool", tool: "grep", callID: "call_4", state: { status: "error", input: { pattern: "TODO" }, error: "no such dir" } },
  ]);
  fixture.message(SESSION, { role: "assistant", modelID: "model-b", providerID: "p", tokens: { input: 20, output: 2, cache: { read: 0, write: 0 } } }, [
    { type: "tool", tool: "question", callID: "call_6", state: { status: "completed", input: { questions: [{ question: "Which parser?", header: "Parser", options: [{ label: "A" }] }] }, output: "A" } },
    { type: "text", text: "Fixed it." },
  ]);

  const page = await open(context, { path }).page(SESSION);
  assert.deepEqual(page.turns.map((turn) => turn.role), ["user", "assistant"]);
  assert.deepEqual(page.turns[0].parts, [{ kind: "text", text: "fix the parser" }]);
  const [thinking, bash, read, edit, grep, question, answer] = page.turns[1].parts;
  assert.deepEqual(thinking, { kind: "thinking", text: "Looking at the parser" });
  assert.equal(bash.name, "bash");
  assert.equal(bash.summary, "npm test");
  assert.equal(bash.output.length, TOOL_OUTPUT_PREVIEW_CHARS);
  assert.equal(bash.output_truncated, true);
  assert.equal(bash.output_size, long.length);
  assert.match(bash.id, /^msg_.* call_1$/u);
  assert.equal(read.summary, "/work/app/src/a.js");
  assert.deepEqual(JSON.parse(read.input), { path: "/work/app/src/a.js" });
  assert.deepEqual(JSON.parse(edit.input), { path: "/work/app/src/a.js", old_string: "a", new_string: "b" });
  assert.deepEqual([grep.summary, grep.error], ["TODO", true]);
  assert.equal(question.name, "question");
  assert.equal(question.summary, "Which parser?");
  assert.deepEqual(answer, { kind: "text", text: "Fixed it." });
  // the model the newest answer ran at, and the effort its variant named
  assert.equal(page.metadata.model, "model-b");
  // the whole output of a large tool, fetched capped by its id
  const store = open(context, { path });
  assert.deepEqual(await store.toolOutput(SESSION, bash.id), { output: long, size: long.length });
});

test("V2: pages by message keys, with ETags and a 409 for another history", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION);
  for (let n = 0; n < 60; n++) fixture.exchange(SESSION, n);
  const store = open(context, { path });
  const newest = await store.page(SESSION);
  assert.equal(newest.turns.length, MAX_PAGE_PROMPTS * 2);
  assert.equal(newest.turns[0].parts[0].text, "prompt 10");
  assert.equal(newest.history_id, SESSION);
  assert.match(newest.cursor, new RegExp(`^${SESSION}:\\d+$`, "u"));
  const older = await store.page(SESSION, { before: newest.cursor });
  assert.deepEqual([older.turns.length, older.turns[0].parts[0].text, older.cursor], [20, "prompt 0", null]);
  assert.deepEqual(await store.page(SESSION, { ifNoneMatch: newest.version }), { notModified: true, version: newest.version });
  fixture.exchange(SESSION, 60);
  const grown = await store.page(SESSION, { ifNoneMatch: newest.version });
  assert.notEqual(grown.version, newest.version);
  assert.equal(grown.turns.at(-1).parts[0].text, "answer 60");
  for (const cursor of ["elsewhere:1", `${SESSION}:x`, `${OTHER}:1`]) {
    await assert.rejects(store.page(SESSION, { before: cursor }), (error) => error.status === 409, cursor);
  }
});

test("V2: an undo hides the reverted messages and starts the history over", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION);
  // more prompts than a page holds, so the first page does not reach the start
  for (let n = 0; n < 60; n++) fixture.exchange(SESSION, n);
  const store = open(context, { path });
  const before = await store.page(SESSION);
  assert.ok(before.cursor, "the first page does not reach the beginning");
  const target = fixture.db.prepare("SELECT id FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1 OFFSET 1").get(SESSION).id;
  fixture.revert(SESSION, target);
  const undone = await store.page(SESSION);
  assert.notEqual(undone.history_id, SESSION);
  // the last shown answer is the one before the undone exchange
  assert.equal(undone.turns.at(-1).parts.at(-1).text, "answer 58");
  // the cursor of the history before the undo no longer names a page
  await assert.rejects(store.page(SESSION, { before: before.cursor }), (error) => error.status === 409);
});

test("V2: the identity changes with each write to the session, and only then", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION);
  fixture.session(OTHER);
  fixture.exchange(SESSION, 1);
  const store = open(context, { path });
  const first = await store.stat(SESSION);
  assert.equal(typeof first.identity, "string");
  fixture.exchange(SESSION, 2);
  const second = await store.stat(SESSION);
  assert.notEqual(second.identity, first.identity);
  fixture.exchange(OTHER, 3);
  assert.equal((await store.stat(SESSION)).identity, second.identity, "another session's write is not this one's");
  assert.equal(await store.stat("ses_9999AAAAAAAAAAAAAAAAAAAAAA"), null);
});

test("V2: a running question is the pane's pending ask, an answered one is not", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION);
  fixture.message(SESSION, { role: "user" }, [{ type: "text", text: "start" }]);
  fixture.message(SESSION, { role: "assistant" }, [
    { type: "tool", tool: "question", callID: "call_done", state: { status: "completed", input: { questions: [{ question: "Answered?", options: [] }] }, output: "ok" } },
    { type: "text", text: "onward" },
  ]);
  const store = open(context, { path });
  assert.equal(await store.pendingQuestion(SESSION), null, "an answered question waits on nothing");
  const message = fixture.message(SESSION, { role: "assistant" }, [
    { type: "tool", tool: "question", callID: "call_open", state: { status: "running", input: { questions: [{ question: "Which export format?", header: "Format", options: [{ label: "ONNX", description: "Portable." }] }] } } },
  ]);
  const pending = await store.pendingQuestion(SESSION);
  assert.equal(pending.name, "question");
  assert.equal(pending.input.questions[0].question, "Which export format?");
  // a newer assistant message without a running question: the open one still waits
  fixture.message(SESSION, { role: "assistant" }, [{ type: "text", text: "working" }]);
  assert.equal((await store.pendingQuestion(SESSION)).input.questions[0].question, "Which export format?");
  assert.equal(message, "msg_00000003AAAAAAAAAAAAAAAAAA");
});

test("V2: the version that wrote the session is read from the V2 table", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION, { version: "2.1.4" });
  fixture.exchange(SESSION, 1);
  const store = open(context, { path });
  assert.equal(await store.sessionVersion(SESSION), "2.1.4");
  const conversations = service(path, [{ pane_id: "w1:p1", agent: "opencode", cwd: "/work/app", agent_session: { agent: "opencode", kind: "id", value: SESSION } }], context);
  assert.equal(await conversations.agentVersion("w1:p1"), "2.1.4");
});

test("V2: a tool error reads as its error words, a running one shows its output so far", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION);
  fixture.message(SESSION, { role: "user" }, [{ type: "text", text: "go" }]);
  fixture.message(SESSION, { role: "assistant" }, [
    { type: "tool", tool: "read", callID: "call_missing", state: { status: "error", input: { path: "/nope" }, error: "File not found: /nope" } },
    { type: "tool", tool: "bash", callID: "call_running", state: { status: "running", input: { command: "sleep 5" }, metadata: { output: "so far" } } },
  ]);
  const page = await open(context, { path }).page(SESSION);
  const [read, bash] = page.turns[1].parts;
  assert.equal(read.error, true);
  assert.match(read.output, /File not found/u);
  assert.equal(bash.output, "so far");
});

test("V2: a message over the row limit is read reduced, its words and outputs cut", async (context) => {
  const { path, fixture } = await worldV2(context);
  fixture.session(SESSION);
  fixture.message(SESSION, { role: "user" }, [{ type: "text", text: "dump it" }]);
  const huge = "y".repeat(50 * 1024 * 1024);
  fixture.message(SESSION, { role: "assistant", modelID: "model-a" }, [
    { type: "tool", tool: "bash", callID: "call_big", state: { status: "completed", input: { command: "cat big.log" }, output: huge } },
    { type: "text", text: "done" },
  ]);
  const store = open(context, { path });
  const page = await store.page(SESSION);
  const [bash, answer] = page.turns[1].parts;
  assert.equal(bash.output_large, true);
  assert.equal(answer.text, "done");
  // the whole output, fetched capped by the part's key (row id, call id)
  const whole = await store.toolOutput(SESSION, bash.id);
  assert.equal(whole.size, huge.length);
  assert.equal(whole.output.length, TOOL_OUTPUT_MAX_CHARS);
});

test("V2: a session in the old tables reads as V1, one in the V2 tables alone reads as V2", async (context) => {
  const directory = await temp(context);
  const path = join(directory, "opencode.db");
  // a V1 database (no V2 tables) still reads, alone
  const v1 = opencodeDb(path, {});
  context.after(() => { try { v1.close(); } catch { /* closed */ } });
  v1.session(SESSION, { directory: "/work/app" });
  v1.exchange(SESSION, 1);
  const store = open(context, { path });
  assert.deepEqual(await store.locate({ session: SESSION }), { session: SESSION, found: true });
  assert.deepEqual(texts((await store.page(SESSION)).turns), ["prompt 1", "answer 1"]);
});

test("V2: a database migrated past V1 (the V2 tables alone) still reads its sessions", async (context) => {
  // OpenCode 2.2.5's opencode.db holds no V1 tables: a pane's session is read
  // from session_v2 and session_message alone, and every read works.
  const directory = await temp(context);
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  context.after(() => { try { db.close(); } catch { /* closed */ } });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
      fork_session_id text, slug text, directory text NOT NULL, version text NOT NULL, revert text,
      time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
    CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
      seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  const time = Date.UTC(2026, 10, 1, 9, 0, 0);
  db.prepare("INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated) VALUES (?, 'prj_1', 'slug', '/work/app', '2.2.5', ?, ?)").run(SESSION, time, time);
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run("msg_00000001AAAAAAAAAAAAAAAAAA", SESSION, "user", 1, time, time,
    JSON.stringify({ time: { created: time }, text: "hello", files: [] }));
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run("msg_00000002AAAAAAAAAAAAAAAAAA", SESSION, "assistant", 2, time + 1000, time + 1000,
    JSON.stringify({ time: { created: time + 1000, completed: time + 1500 }, agent: "build", model: { id: "m", providerID: "p", variant: null },
      content: [{ type: "text", text: "hi there" }], finish: "stop", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }, cost: 0 }));
  const store = open(context, { path });
  assert.deepEqual(await store.locate({ cwd: "/work/app" }), { session: SESSION, found: true });
  assert.deepEqual(await store.locate({ session: SESSION }), { session: SESSION, found: true });
  const page = await store.page(SESSION);
  assert.equal(page.source, "opencode-session");
  assert.deepEqual(texts(page.turns), ["hello", "hi there"]);
  assert.equal(typeof (await store.stat(SESSION)).identity, "string");
  assert.equal(await store.sessionVersion(SESSION), "2.2.5");
  assert.equal(await store.pendingQuestion(SESSION), null);
});
