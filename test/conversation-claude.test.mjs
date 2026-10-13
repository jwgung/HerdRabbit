// Fixtures are hand-made; several cases follow herdr-web-ui's
// server/conversation.test.ts and server/claude-store.test.ts (MIT,
// Copyright (c) 2026 devswha).
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_TRANSCRIPT,
  claudeProjectDir,
  locateClaudeTranscript,
  parseClaudeMetadata,
  parseClaudeTranscript,
} from "../src/conversation/claude.mjs";
import {
  HistoryChanged,
  MAX_PAGE_PROMPTS,
  TOOL_OUTPUT_PREVIEW_CHARS,
  forgetConversationState,
  transcriptPage as pageOf,
  transcriptToolOutput as toolOutputOf,
} from "../src/conversation/pages.mjs";
import { defaultClaudeConfigDir, localTranscriptStore } from "../src/conversation/stores.mjs";

const transcriptPage = (store, path, options) => pageOf(CLAUDE_TRANSCRIPT, store, path, options);
const transcriptToolOutput = (store, path, toolId) => toolOutputOf(CLAUDE_TRANSCRIPT, store, path, toolId);

const SESSION = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const user = (text, extra = {}) => ({ type: "user", message: { role: "user", content: text }, ...extra });
const answer = (text, extra = {}) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
const turn = (n) => [user(`prompt ${n}`), answer(`answer ${n}`)];
const texts = (turns) => turns.map((item) => item.parts.map((part) => part.text ?? `[${part.kind}]`).join(" "));

async function temp(context) {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-conversation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("parses user, merged assistant and tool turns, with tool results folded in", () => {
  const turns = parseClaudeTranscript(jsonl([
    user("리팩터링 시작해줘", { timestamp: "2026-09-19T08:00:00.000Z" }),
    { type: "assistant", timestamp: "2026-09-19T08:00:02.000Z", message: { role: "assistant", stop_reason: "tool_use", content: [
      { type: "text", text: "먼저 상태를 확인하겠습니다." },
      { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "git status --short" } },
    ] } },
    { type: "user", timestamp: "2026-09-19T08:00:03.000Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "M src/app.ts" }] },
    ] } },
    { type: "assistant", timestamp: "2026-09-19T08:00:05.000Z", message: { role: "assistant", content: [
      { type: "thinking", thinking: "one file" },
      { type: "text", text: "변경된 파일이 하나입니다." },
    ] } },
    user("<command-name>/help</command-name>"),
    { type: "user", isMeta: true, message: { role: "user", content: "hidden" } },
  ]));
  assert.deepEqual(turns, [
    { role: "user", ts: "2026-09-19T08:00:00.000Z", parts: [{ kind: "text", text: "리팩터링 시작해줘" }] },
    { role: "assistant", ts: "2026-09-19T08:00:02.000Z", end_ts: "2026-09-19T08:00:05.000Z", parts: [
      { kind: "text", text: "먼저 상태를 확인하겠습니다." },
      { kind: "tool", id: "toolu_01", name: "Bash", summary: "git status --short",
        input: JSON.stringify({ command: "git status --short" }, null, 2), output: "M src/app.ts", output_size: 12 },
      { kind: "thinking", text: "one file" },
      { kind: "text", text: "변경된 파일이 하나입니다." },
    ] },
  ]);
});

test("skips malformed and torn lines, sidechains and bookkeeping", () => {
  const turns = parseClaudeTranscript([
    "not json", "[1,2]", "null",
    JSON.stringify(user("kept")),
    JSON.stringify(answer("subagent", { isSidechain: true })),
    JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "x" }),
    JSON.stringify(answer("reply")),
    '{"type":"assistant","message":{"role":"assis',
  ].join("\n"));
  assert.deepEqual(texts(turns), ["kept", "reply"]);
});

test("cuts long tool output and input in the page, marks errors", () => {
  const turns = parseClaudeTranscript(jsonl([
    { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "big", name: "Write", input: { file_path: "/tmp/x", content: "y".repeat(10_000) } },
    ] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "big", is_error: true, content: "x".repeat(10_000) }] } },
  ]));
  const tool = turns[0].parts[0];
  assert.equal(tool.summary, "/tmp/x");
  assert.equal(tool.output.length, TOOL_OUTPUT_PREVIEW_CHARS);
  assert.equal(tool.output_truncated, true);
  assert.equal(tool.output_size, 10_000);
  assert.equal(tool.error, true);
  assert.equal(tool.input_truncated, true);
  assert.ok(tool.input.length <= 4000);
});

test("shows queued prompts, notices and compaction; drops a cancelled re-send; clears on /clear", () => {
  const turns = parseClaudeTranscript(jsonl([
    user("before clear"),
    user("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
    user("apple", { uuid: "a", parentUuid: "p" }),
    user("cherry", { uuid: "b", parentUuid: "p" }),
    answer("Cherry."),
    { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt: "also tests" } },
    { type: "system", subtype: "local_command", content: "<local-command-stdout>\u001b[1mdone\u001b[0m</local-command-stdout>" },
    { type: "user", isCompactSummary: true, message: { role: "user", content: "summary text" } },
  ]));
  assert.deepEqual(turns.map((item) => [item.role, item.parts[0].kind, item.parts[0].text]), [
    ["user", "text", "cherry"],
    ["assistant", "text", "Cherry."],
    ["user", "text", "also tests"],
    ["user", "notice", "done"],
    ["user", "compact", "summary text"],
  ]);
});

test("a subagent's /clear leaves the conversation, its metadata and its history alone", async (context) => {
  const clear = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>";
  const entries = [
    user("main question"),
    answer("main answer", { message: { role: "assistant", model: "claude-opus-4", content: [{ type: "text", text: "main answer" }] } }),
    user(clear, { isSidechain: true }),
    user("follow-up"),
  ];
  assert.deepEqual(texts(parseClaudeTranscript(jsonl(entries))), ["main question", "main answer", "follow-up"]);
  assert.equal(parseClaudeMetadata(jsonl(entries)).model, "claude-opus-4");

  forgetConversationState();
  const directory = await temp(context);
  const path = join(directory, `${SESSION}.jsonl`);
  await writeFile(path, jsonl([...Array.from({ length: 60 }, (_, n) => turn(n)).flat(), user(clear, { isSidechain: true })]));
  const page = await transcriptPage(localTranscriptStore({ configDir: "/nonexistent" }), path);
  assert.notEqual(page.cursor, null, "older history is still offered");
});

test("two stores keep their own revisions, even for the same path", async (context) => {
  forgetConversationState();
  const directory = await temp(context);
  const path = join(directory, `${SESSION}.jsonl`);
  const first = localTranscriptStore({ configDir: "/nonexistent" });
  const second = localTranscriptStore({ configDir: "/nonexistent" });
  await writeFile(path, jsonl(Array.from({ length: 60 }, (_, n) => turn(n)).flat()));
  const page = await transcriptPage(first, path);
  await writeFile(path, jsonl(Array.from({ length: 55 }, (_, n) => turn(n)).flat()));
  await assert.rejects(transcriptPage(first, path, { before: page.cursor }), HistoryChanged);
  // the second store never saw the longer file, so the first one's rewrite is not its history
  const fresh = await transcriptPage(second, path);
  assert.equal(fresh.history_id, page.history_id);
  assert.notEqual((await transcriptPage(first, path)).history_id, page.history_id);
});

test("a subagent's model and effort do not stand for the conversation's", () => {
  const main = { type: "assistant", effort: "high", message: { role: "assistant", model: "claude-opus-4", content: [{ type: "text", text: "main" }] } };
  const side = { type: "assistant", isSidechain: true, effort: "low", message: { role: "assistant", model: "claude-haiku-4", content: [{ type: "text", text: "side" }] } };
  const metadata = parseClaudeMetadata(jsonl([user("q"), main, side]));
  assert.equal(metadata.model, "claude-opus-4");
  assert.equal(metadata.reasoning_effort, "high");
});

test("overlapping requests after a rewrite agree on one history id", async (context) => {
  forgetConversationState();
  const directory = await temp(context);
  const path = join(directory, `${SESSION}.jsonl`);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  await writeFile(path, jsonl(Array.from({ length: 60 }, (_, n) => turn(n)).flat()));
  await transcriptPage(store, path);
  await writeFile(path, jsonl(Array.from({ length: 70 }, (_, n) => [user(`other ${n}`), answer(`reply ${n}`)]).flat()));
  const pages = await Promise.all([transcriptPage(store, path), transcriptPage(store, path), transcriptPage(store, path)]);
  assert.equal(new Set(pages.map((page) => page.history_id)).size, 1);
  await transcriptPage(store, path, { before: pages[0].cursor });
});

test("reads the model and the context the last request filled", () => {
  const metadata = parseClaudeMetadata(jsonl([
    { type: "assistant", effort: "high", message: { role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 250_000 }, content: [] } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", model: "claude-haiku", usage: { input_tokens: 5 }, content: [] } },
  ]));
  assert.equal(metadata.model, "claude-opus-5-5", "a subagent's model is its own");
  assert.equal(metadata.reasoning_effort, "high");
  assert.deepEqual(metadata.context, { used: 250_010, window: 1_000_000 });
});

test("encodes a cwd the way Claude Code names its project", () => {
  assert.equal(claudeProjectDir("/home/u/project"), "-home-u-project");
  assert.equal(claudeProjectDir("/home/u/Development/test.com"), "-home-u-Development-test-com");
  assert.equal(claudeProjectDir("/home/u/my_project"), "-home-u-my-project");
  assert.equal(claudeProjectDir("/home/u/.dotfiles"), "-home-u--dotfiles");
  assert.equal(claudeProjectDir("/home/u/문서/app"), "-home-u----app");
  const deep = `/home/u/${"deep/".repeat(45)}project`;
  assert.equal(claudeProjectDir(deep), `${"-home-u-" + "deep-".repeat(38)}de-5cuwtt`);
});

test("uses CLAUDE_CONFIG_DIR when it is an absolute path, else ~/.claude", () => {
  assert.equal(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/srv/claude-work" }, "/home/u"), "/srv/claude-work");
  assert.equal(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: "relative" }, "/home/u"), "/home/u/.claude");
  assert.equal(defaultClaudeConfigDir({}, "/home/u"), "/home/u/.claude");
});

test("locates a transcript by cwd, then by scanning every project, and follows continuations", async (context) => {
  const configDir = join(await temp(context), "claude-config");
  const projects = join(configDir, "projects");
  const store = localTranscriptStore({ configDir });
  assert.equal(await locateClaudeTranscript(store, SESSION, ["/w/project"]), null);
  await mkdir(join(projects, claudeProjectDir("/w/My Project")), { recursive: true });
  const started = join(projects, claudeProjectDir("/w/My Project"), `${SESSION}.jsonl`);
  await writeFile(started, jsonl([user("hi")]));
  assert.equal(await locateClaudeTranscript(store, SESSION, [null, "/w/elsewhere", "/w/My Project"]), started);
  // the cwd names no project: any project holding the id answers
  await rename(join(projects, claudeProjectDir("/w/My Project")), join(projects, "-renamed"));
  const moved = join(projects, "-renamed", `${SESSION}.jsonl`);
  assert.equal(await locateClaudeTranscript(store, SESSION, ["/w/elsewhere"]), moved);
  // a session id that is not a UUID is never looked up
  assert.equal(await locateClaudeTranscript(store, "../../etc/passwd", ["/w"]), null);
  // continued-in, with no turn after it, leads to the session written now
  const next = "11111111-1111-4111-8111-111111111111";
  await writeFile(moved, jsonl([user("hi"), { type: "continued-in", continuedInSessionId: next }]));
  assert.equal(await locateClaudeTranscript(store, SESSION, []), moved);
  const active = join(projects, "-renamed", `${next}.jsonl`);
  await writeFile(active, jsonl([user("after resume")]));
  assert.equal(await locateClaudeTranscript(store, SESSION, []), active);
  // a turn after the record keeps the first file
  await appendFile(moved, jsonl([user("newer")]));
  assert.equal(await locateClaudeTranscript(store, SESSION, []), moved);
});

test("the scan fallback looks into a few projects at once and stops after a hit", async (context) => {
  const configDir = join(await temp(context), "claude-config");
  const projects = join(configDir, "projects");
  for (let n = 0; n < 40; n += 1) await mkdir(join(projects, `-p${String(n).padStart(2, "0")}`), { recursive: true });
  const holder = join(projects, "-p03", `${SESSION}.jsonl`);
  await writeFile(holder, jsonl([user("hi")]));
  let running = 0;
  let peak = 0;
  const looked = [];
  const statFile = async (path) => {
    looked.push(path);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return (await import("node:fs/promises")).stat(path);
  };
  const store = localTranscriptStore({ configDir, statFile });
  assert.equal(await locateClaudeTranscript(store, SESSION, []), holder);
  assert.ok(peak > 1 && peak <= 8, `${peak} stats at once`);
  // the later projects were not all looked into
  assert.ok(looked.length < 40, `${looked.length} stats`);
  // none holds another id: every project is looked into, still a few at a time
  looked.length = 0;
  peak = 0;
  assert.equal(await locateClaudeTranscript(store, "11111111-1111-4111-8111-111111111111", []), null);
  assert.equal(looked.length, 40);
  assert.ok(peak <= 8);
});

test("reports a projects folder it cannot read instead of calling the transcript missing", { skip: process.getuid?.() === 0 }, async (context) => {
  const configDir = join(await temp(context), "claude-config");
  const projects = join(configDir, "projects");
  await mkdir(join(projects, "-locked"), { recursive: true });
  await chmod(join(projects, "-locked"), 0o000);
  try {
    await assert.rejects(locateClaudeTranscript(localTranscriptStore({ configDir }), SESSION, []));
  } finally {
    await chmod(join(projects, "-locked"), 0o700);
  }
});

test("pages back through a long conversation without gaps, overlaps or split turns", async (context) => {
  forgetConversationState();
  const path = join(await temp(context), `${SESSION}.jsonl`);
  const whole = jsonl(Array.from({ length: 120 }, (_, n) => turn(n)).flat());
  await writeFile(path, whole);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  const newest = await transcriptPage(store, path);
  assert.equal(newest.turns.length, MAX_PAGE_PROMPTS * 2);
  assert.equal(texts(newest.turns)[0], "prompt 70");
  assert.match(newest.cursor, /^[0-9a-z-]+:\d+$/u);
  assert.equal(newest.cursor.split(":")[0], newest.history_id);
  const middle = await transcriptPage(store, path, { before: newest.cursor });
  assert.equal(texts(middle.turns)[0], "prompt 20");
  const first = await transcriptPage(store, path, { before: middle.cursor });
  assert.equal(first.cursor, null);
  assert.deepEqual(texts([...first.turns, ...middle.turns, ...newest.turns]), texts(parseClaudeTranscript(whole)));
});

test("since: keeps every turn from a held start inside the newest page, then fills the gap with before+since", async (context) => {
  forgetConversationState();
  const path = join(await temp(context), `${SESSION}.jsonl`);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  await writeFile(path, jsonl(Array.from({ length: 60 }, (_, n) => turn(n)).flat()));
  const held = (await transcriptPage(store, path)).cursor;
  await appendFile(path, jsonl([answer("still working")]));
  const growing = await transcriptPage(store, path, { since: held });
  assert.equal(growing.cursor, held);
  assert.equal(texts(growing.turns).at(-1), "answer 59 still working");
  await appendFile(path, jsonl(Array.from({ length: 10 }, (_, n) => turn(60 + n)).flat()));
  const newest = await transcriptPage(store, path, { since: held });
  assert.notEqual(newest.cursor, held);
  assert.equal(texts(newest.turns)[0], "prompt 20");
  const gap = await transcriptPage(store, path, { before: newest.cursor, since: held });
  assert.equal(gap.cursor, held);
  assert.equal(texts(gap.turns)[0], "prompt 10");
  assert.equal(texts(gap.turns).at(-1), "answer 19");
  for (const cursor of ["another-file:10", `${newest.history_id}:999999999`, "garbage", `${newest.history_id}:-1`]) {
    await assert.rejects(transcriptPage(store, path, { before: cursor }), HistoryChanged);
  }
  await assert.rejects(transcriptPage(store, path, { before: held, since: newest.cursor }), HistoryChanged);
});

test("a file rewritten in place, or a new session file, refuses old cursors", async (context) => {
  forgetConversationState();
  const directory = await temp(context);
  const path = join(directory, `${SESSION}.jsonl`);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  await writeFile(path, jsonl(Array.from({ length: 60 }, (_, n) => turn(n)).flat()));
  const before = await transcriptPage(store, path);
  await writeFile(path, jsonl(Array.from({ length: 55 }, (_, n) => turn(n)).flat()));
  await assert.rejects(transcriptPage(store, path, { before: before.cursor }), HistoryChanged);
  const other = join(directory, "other.jsonl");
  await writeFile(other, jsonl(Array.from({ length: 60 }, (_, n) => turn(n)).flat()));
  await assert.rejects(transcriptPage(store, other, { before: before.cursor }), HistoryChanged);
});

test("a file rewritten in place with longer content refuses old cursors; a real append keeps them", async (context) => {
  forgetConversationState();
  const directory = await temp(context);
  const path = join(directory, `${SESSION}.jsonl`);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  const history = Array.from({ length: 60 }, (_, n) => turn(n)).flat();
  await writeFile(path, jsonl(history));
  const first = await transcriptPage(store, path);
  const older = await transcriptPage(store, path, { before: first.cursor });
  // an append leaves the old bytes: the cursor still names them
  await appendFile(path, jsonl(turn(60)));
  const appended = await transcriptPage(store, path);
  assert.equal(appended.history_id, first.history_id);
  assert.equal((await transcriptPage(store, path, { before: first.cursor })).version, older.version);
  // a longer, different conversation written over the same file (same inode)
  await writeFile(path, jsonl(Array.from({ length: 90 }, (_, n) => [user(`other ${n}`), answer(`reply ${n}`)]).flat()));
  await assert.rejects(transcriptPage(store, path, { before: first.cursor }), HistoryChanged);
  const rewritten = await transcriptPage(store, path, { ifNoneMatch: [appended.version] });
  assert.notEqual(rewritten.notModified, true);
  assert.notEqual(rewritten.history_id, first.history_id);
  assert.equal(rewritten.turns.at(-1).parts[0].text, "reply 89");
});

test("answers notModified for an unchanged page, and a new version after an append", async (context) => {
  forgetConversationState();
  const path = join(await temp(context), `${SESSION}.jsonl`);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  await writeFile(path, jsonl(turn(0)));
  const page = await transcriptPage(store, path);
  assert.deepEqual(await transcriptPage(store, path, { ifNoneMatch: page.version }), { notModified: true, version: page.version });
  await appendFile(path, jsonl(turn(1)));
  const next = await transcriptPage(store, path, { ifNoneMatch: [page.version] });
  assert.notEqual(next.version, page.version);
  assert.equal(next.turns.length, 4);
});

test("a /clear on the page ends the history the page offers", async (context) => {
  forgetConversationState();
  const path = join(await temp(context), `${SESSION}.jsonl`);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  await writeFile(path, jsonl([...turn(0), user("<command-name>/clear</command-name>"), ...turn(1)]));
  const page = await transcriptPage(store, path);
  assert.deepEqual(texts(page.turns), ["prompt 1", "answer 1"]);
  assert.equal(page.cursor, null);
});

test("reads only a window from a large file's end; an older page reaches the long turn's start", async (context) => {
  forgetConversationState();
  const path = join(await temp(context), `${SESSION}.jsonl`);
  const reads = [];
  const base = localTranscriptStore({ configDir: "/nonexistent" });
  const store = { ...base, windowBytes: 64 * 1024, maxPageBytes: 1024 * 1024, read: (file, start, length) => { reads.push(length); return base.read(file, start, length); } };
  const big = answer("y".repeat(16 * 1024));
  await writeFile(path, jsonl([...turn(0), user("run the long job"), ...Array.from({ length: 20 }, () => big)]));
  const newest = await transcriptPage(store, path);
  assert.ok(reads.every((length) => length <= 64 * 1024));
  assert.ok(newest.turns.every((item) => item.role === "assistant"));
  const older = await transcriptPage(store, path, { before: newest.cursor });
  assert.deepEqual(texts(older.turns).slice(0, 3), ["prompt 0", "answer 0", "run the long job"]);
});

test("finds a tool's whole output by id, reading backwards in windows, capped", async (context) => {
  forgetConversationState();
  const path = join(await temp(context), `${SESSION}.jsonl`);
  const base = localTranscriptStore({ configDir: "/nonexistent" });
  const store = { ...base, windowBytes: 1024, maxToolScanBytes: 10 * 1024 * 1024 };
  const call = (id) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/x" } }] } });
  const result = (id, text) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  await writeFile(path, jsonl([
    call("toolu_first"), result("toolu_first", "first output"),
    call("toolu_long"), result("toolu_long", "z".repeat(5000)),
    ...Array.from({ length: 30 }, (_, n) => turn(n)).flat(),
    call("toolu_big"), result("toolu_big", "q".repeat(1_200_000)),
    ...turn(99),
  ]));
  assert.deepEqual(await transcriptToolOutput(store, path, "toolu_first"), { output: "first output", size: 12 });
  assert.equal((await transcriptToolOutput(store, path, "toolu_long")).output, "z".repeat(5000));
  const capped = await transcriptToolOutput(store, path, "toolu_big");
  assert.equal(capped.size, 1_200_000);
  assert.equal(capped.output.length, 1_000_000);
  assert.equal(await transcriptToolOutput(store, path, "toolu_missing"), null);
  assert.equal(await transcriptToolOutput(store, path, "../etc"), null);
  // a scan limit that stops short of the call finds nothing rather than reading on
  assert.equal(await transcriptToolOutput({ ...store, maxToolScanBytes: 4096 }, path, "toolu_first"), null);
});
