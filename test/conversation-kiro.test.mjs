// Fixtures are hand-made for Kiro CLI's messages.jsonl, whose records are
// each { id, timestamp, payload } with payload.type naming the event. The
// paging cases mirror test/conversation-claude.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KIRO_TRANSCRIPT,
  kiroWorkspaceHash,
  parseKiroMetadata,
  parseKiroTranscript,
} from "../src/conversation/kiro.mjs";
import {
  TOOL_OUTPUT_PREVIEW_CHARS,
  forgetConversationState,
  transcriptPage as pageOf,
} from "../src/conversation/pages.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { mkdir } from "node:fs/promises";

const transcriptPage = (store, path, options) => pageOf(KIRO_TRANSCRIPT, store, path, options);

const SESSION = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

// A record as Kiro writes it: { id, timestamp, payload }.
let seq = 0;
const rec = (payload, ts) => ({ id: `evt_${seq++}`, timestamp: ts ?? "2026-09-19T08:00:00.000Z", payload });
const user = (content, ts) => rec({ type: "user", content }, ts);
const turnStart = (ts) => rec({ type: "turn_start", executionId: "exec", turnId: "turn", userMessageTag: "tag" }, ts);
const say = (content, ts) => rec({ type: "assistant", content, operationType: "Say" }, ts);
const reasoning = (content, model, ts) => rec({ type: "assistant", content, operationType: "Reasoning", reasoningModelId: model }, ts);
const toolCall = (toolCallId, toolName, args, ts) => rec({ type: "tool_call", toolCallId, toolName, args, status: "ok", kind: "fs" }, ts);
const toolResult = (toolCallId, content, success, ts) => rec({ type: "tool_result", toolCallId, content, success }, ts);

const texts = (turns) => turns.map((item) => item.parts.map((part) => part.text ?? `[${part.kind}]`).join(" "));

async function temp(context) {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-kiro-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("merges a prompt with its assistant turn, folding tool results and splitting Say from Reasoning", () => {
  const turns = parseKiroTranscript(jsonl([
    user("리팩터링 시작해줘", "2026-09-19T08:00:00.000Z"),
    turnStart("2026-09-19T08:00:01.000Z"),
    say("먼저 상태를 확인하겠습니다.", "2026-09-19T08:00:02.000Z"),
    toolCall("tool_01", "execute_bash", { command: "git status --short" }, "2026-09-19T08:00:03.000Z"),
    toolResult("tool_01", "M src/app.ts", true, "2026-09-19T08:00:04.000Z"),
    reasoning("one file", "kiro-model-x", "2026-09-19T08:00:05.000Z"),
    say("변경된 파일이 하나입니다.", "2026-09-19T08:00:05.000Z"),
  ]));
  assert.deepEqual(turns, [
    { role: "user", ts: "2026-09-19T08:00:00.000Z", parts: [{ kind: "text", text: "리팩터링 시작해줘" }] },
    { role: "assistant", ts: "2026-09-19T08:00:02.000Z", end_ts: "2026-09-19T08:00:05.000Z", parts: [
      { kind: "text", text: "먼저 상태를 확인하겠습니다." },
      { kind: "tool", id: "tool_01", name: "execute_bash", summary: "git status --short",
        input: JSON.stringify({ command: "git status --short" }, null, 2), output: "M src/app.ts", output_size: 12 },
      { kind: "thinking", text: "one file" },
      { kind: "text", text: "변경된 파일이 하나입니다." },
    ] },
  ]);
});

test("marks a failed tool result with error, and ignores a result whose id matches no call", () => {
  const turns = parseKiroTranscript(jsonl([
    user("run it"),
    turnStart(),
    toolCall("tool_ok", "execute_bash", { command: "ls" }),
    toolResult("tool_ok", "boom", false),
    toolResult("tool_stray", "no call for me", true),
  ]));
  const tool = turns[1].parts[0];
  assert.equal(tool.name, "execute_bash");
  assert.equal(tool.output, "boom");
  assert.equal(tool.error, true);
  // the stray result added no part
  assert.equal(turns[1].parts.length, 1);
});

test("cuts a long tool output in the page", () => {
  const turns = parseKiroTranscript(jsonl([
    user("write a lot"),
    turnStart(),
    toolCall("big", "fs_write", { path: "/tmp/x" }),
    toolResult("big", "x".repeat(10_000), true),
  ]));
  const tool = turns[1].parts[0];
  assert.equal(tool.summary, "/tmp/x");
  assert.equal(tool.output.length, TOOL_OUTPUT_PREVIEW_CHARS);
  assert.equal(tool.output_truncated, true);
  assert.equal(tool.output_size, 10_000);
});

test("reads the model from a Reasoning record and the context a session_metadata holds", () => {
  const metadata = parseKiroMetadata(jsonl([
    user("q"),
    turnStart(),
    reasoning("thinking", "kiro-reasoner-5"),
    say("answer"),
    rec({ type: "session_metadata", key: "contextUsage", value: { usagePercentage: 42 } }),
  ]));
  assert.equal(metadata.model, "kiro-reasoner-5");
  assert.deepEqual(metadata.context, { usedPercent: 42 });
});

test("names a workspace by the first 16 hex of sha256(cwd), and nothing for a bad cwd", () => {
  assert.equal(kiroWorkspaceHash("/home/capalace/Git/HerdRabbit"), "b3964dfe4cb0304b");
  assert.equal(kiroWorkspaceHash(""), null);
  assert.equal(kiroWorkspaceHash(42), null);
  assert.equal(kiroWorkspaceHash(null), null);
});

test("pages the Kiro transcript through a store, keeping each prompt with its turn", async (context) => {
  forgetConversationState();
  const directory = await temp(context);
  const path = join(directory, `${SESSION}.jsonl`);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  const turnRecords = (n) => [
    user(`prompt ${n}`),
    turnStart(),
    say(`answer ${n}`),
  ];
  await writeFile(path, jsonl(Array.from({ length: 5 }, (_, n) => turnRecords(n)).flat()));
  const page = await transcriptPage(store, path);
  assert.equal(page.source, "kiro-transcript");
  assert.deepEqual(texts(page.turns), [
    "prompt 0", "answer 0",
    "prompt 1", "answer 1",
    "prompt 2", "answer 2",
    "prompt 3", "answer 3",
    "prompt 4", "answer 4",
  ]);
  // the whole short file fits one page: nothing older to offer
  assert.equal(page.cursor, null);
});

test("an older page begins on a prompt, not mid-turn", async (context) => {
  forgetConversationState();
  const directory = await temp(context);
  const path = join(directory, `${SESSION}.jsonl`);
  const store = localTranscriptStore({ configDir: "/nonexistent" });
  const turnRecords = (n) => [user(`prompt ${n}`), turnStart(), say(`answer ${n}`)];
  await writeFile(path, jsonl(Array.from({ length: 120 }, (_, n) => turnRecords(n)).flat()));
  const newest = await transcriptPage(store, path);
  // the newest page keeps whole prompt+answer pairs
  assert.equal(texts(newest.turns)[0], "prompt 70");
  assert.equal(texts(newest.turns).at(-1), "answer 119");
  assert.notEqual(newest.cursor, null);
  const older = await transcriptPage(store, path, { before: newest.cursor });
  assert.equal(texts(older.turns)[0], "prompt 20");
});

// ---------------------------------------------------------------------------
// The store that finds a pane's transcript from its workspace, the way
// src/conversation/service.mjs's #resolveKiro uses it.

async function kiroHome(context) {
  const configDir = await mkdtemp(join(tmpdir(), "herdrabbit-kiro-"));
  context.after(() => rm(configDir, { recursive: true, force: true }));
  const store = localTranscriptStore({ kiroConfigDir: configDir }).kiro;
  // Writes a session's messages.jsonl under its workspace hash, and returns its id.
  const writeSession = async (cwd, session, lines, mtime = null) => {
    const hash = kiroWorkspaceHash(cwd);
    const dir = join(configDir, "sessions", hash, `sess_${session}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "messages.jsonl");
    await writeFile(path, lines);
    if (mtime !== null) {
      const { utimes } = await import("node:fs/promises");
      await utimes(path, mtime, mtime);
    }
    return path;
  };
  return { configDir, store, writeSession };
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

test("locates a pane's transcript by the workspace hash of its cwd", async (context) => {
  const { store, writeSession } = await kiroHome(context);
  const cwd = "/home/me/project";
  const path = await writeSession(cwd, UUID_A, jsonl([user("hi"), turnStart(), say("hello")]));
  const found = await store.locate({ session: null, hashes: [kiroWorkspaceHash(cwd)] });
  assert.equal(found.path, path);
  assert.equal(found.session, UUID_A);
});

test("with no reported session, the newest sess_ in the workspace wins", async (context) => {
  const { store, writeSession } = await kiroHome(context);
  const cwd = "/home/me/project";
  await writeSession(cwd, UUID_A, jsonl([user("old")]), 1_000);
  const newer = await writeSession(cwd, UUID_B, jsonl([user("new")]), 2_000);
  const found = await store.locate({ session: null, hashes: [kiroWorkspaceHash(cwd)] });
  assert.equal(found.path, newer);
  assert.equal(found.session, UUID_B);
});

test("a reported session is preferred over the newest, when its directory is there", async (context) => {
  const { store, writeSession } = await kiroHome(context);
  const cwd = "/home/me/project";
  const older = await writeSession(cwd, UUID_A, jsonl([user("old")]), 1_000);
  await writeSession(cwd, UUID_B, jsonl([user("new")]), 2_000);
  const found = await store.locate({ session: UUID_A, hashes: [kiroWorkspaceHash(cwd)] });
  assert.equal(found.path, older);
  assert.equal(found.session, UUID_A);
});

test("a workspace with no session directory, or none written, locates nothing", async (context) => {
  const { store, writeSession } = await kiroHome(context);
  assert.equal(await store.locate({ session: null, hashes: [kiroWorkspaceHash("/nowhere")] }), null);
  // a directory with no messages.jsonl is not a transcript
  const cwd = "/home/me/empty";
  const hash = kiroWorkspaceHash(cwd);
  await mkdir(join((await kiroHome(context)).configDir, "sessions", hash, `sess_${UUID_A}`), { recursive: true });
  assert.equal(await store.locate({ session: null, hashes: [hash] }), null);
});

test("several cwds are tried in turn; the first workspace that holds a session wins", async (context) => {
  const { store, writeSession } = await kiroHome(context);
  const foreground = "/home/me/project/sub";
  const start = "/home/me/project";
  const path = await writeSession(start, UUID_A, jsonl([user("hi")]));
  const found = await store.locate({ session: null, hashes: [kiroWorkspaceHash(foreground), kiroWorkspaceHash(start)] });
  assert.equal(found.path, path);
});
