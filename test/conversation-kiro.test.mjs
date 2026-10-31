// Fixtures are hand-made for Kiro CLI's messages.jsonl, whose records are
// each { id, timestamp, payload } with payload.type naming the event. The
// paging cases mirror test/conversation-claude.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import {
  KIRO_TRANSCRIPT,
  kiroWorkspaceHash,
  parseKiroMetadata,
  parseKiroTranscript,
} from "../src/conversation/kiro.mjs";
import {
  ConversationUnavailable,
  TOOL_OUTPUT_PREVIEW_CHARS,
  forgetConversationState,
  transcriptPage as pageOf,
} from "../src/conversation/pages.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
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

// ---------------------------------------------------------------------------
// Several Kiro panes in one folder: each pane's own Kiro process says which
// session it runs, through the log file it holds open
// (<config>/logs/<started>/kiro.log). A fake /proc stands in for Linux's.

// Writes `pid`'s fake /proc entry: its children, and an open descriptor on `file`.
async function fakeProcess(procRoot, pid, { children = [], file = null } = {}) {
  const { symlink } = await import("node:fs/promises");
  await mkdir(join(procRoot, String(pid), "task", String(pid)), { recursive: true });
  await writeFile(join(procRoot, String(pid), "task", String(pid), "children"), children.length ? `${children.join(" ")} ` : "");
  await mkdir(join(procRoot, String(pid), "fd"), { recursive: true });
  if (file) await symlink(file, join(procRoot, String(pid), "fd", "3"));
}

async function kiroLog(configDir, started, sessions) {
  const dir = join(configDir, "logs", started);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "kiro.log");
  const line = (message) => JSON.stringify({ timestamp: "2026-10-29T08:40:01.494Z", level: "info", message });
  await writeFile(path, `${sessions.map((session) => [
    line(`[KiroAgent] ACP session/new sessionId=sess_${session} modeId=vibe idempotent=false`),
    line(`fs.loadSession.ok {"system":"fs","sessionId":"sess_${session}","durationMs":4}`),
  ].join("\n")).join("\n")}\n`);
  return path;
}

test("the session a Kiro process runs is read from the log it holds open, through its child", async (context) => {
  const configDir = await mkdtemp(join(tmpdir(), "herdrabbit-kiro-"));
  const procRoot = await mkdtemp(join(tmpdir(), "herdrabbit-proc-"));
  context.after(() => Promise.all([rm(configDir, { recursive: true, force: true }), rm(procRoot, { recursive: true, force: true })]));
  const log = await kiroLog(configDir, "20261029T084001414", [UUID_A]);
  // kiro-cli → its TUI → the worker that holds the log
  await fakeProcess(procRoot, 100, { children: [101] });
  await fakeProcess(procRoot, 101, { children: [102] });
  await fakeProcess(procRoot, 102, { file: log });
  const store = localTranscriptStore({ kiroConfigDir: configDir, procRoot }).kiro;
  assert.deepEqual(await store.sessionsOfPids([100]), [UUID_A]);
  // a process holding no Kiro log runs no session
  await fakeProcess(procRoot, 200);
  assert.deepEqual(await store.sessionsOfPids([200]), []);
});

test("a session resumed later in the same process wins over the one it started with", async (context) => {
  const configDir = await mkdtemp(join(tmpdir(), "herdrabbit-kiro-"));
  const procRoot = await mkdtemp(join(tmpdir(), "herdrabbit-proc-"));
  context.after(() => Promise.all([rm(configDir, { recursive: true, force: true }), rm(procRoot, { recursive: true, force: true })]));
  const log = await kiroLog(configDir, "20261029T114235702", [UUID_A, UUID_B]);
  await fakeProcess(procRoot, 300, { file: log });
  const store = localTranscriptStore({ kiroConfigDir: configDir, procRoot }).kiro;
  assert.deepEqual(await store.sessionsOfPids([300]), [UUID_B]);
});

test("two Kiro panes in one folder each show their own conversation", async (context) => {
  forgetConversationState();
  const configDir = await mkdtemp(join(tmpdir(), "herdrabbit-kiro-"));
  const procRoot = await mkdtemp(join(tmpdir(), "herdrabbit-proc-"));
  context.after(() => Promise.all([rm(configDir, { recursive: true, force: true }), rm(procRoot, { recursive: true, force: true })]));
  const cwd = "/home/me/project";
  const writeSession = async (session, text, mtime) => {
    const dir = join(configDir, "sessions", kiroWorkspaceHash(cwd), `sess_${session}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "messages.jsonl");
    await writeFile(path, text);
    const { utimes } = await import("node:fs/promises");
    await utimes(path, mtime, mtime);
    return path;
  };
  const older = await writeSession(UUID_A, jsonl([user("first pane")]), 1_000);
  const newer = await writeSession(UUID_B, jsonl([user("second pane")]), 2_000);
  await fakeProcess(procRoot, 100, { file: await kiroLog(configDir, "a", [UUID_A]) });
  await fakeProcess(procRoot, 200, { file: await kiroLog(configDir, "b", [UUID_B]) });
  const panes = [
    { pane_id: "w1:p1", agent: "kiro", cwd },
    { pane_id: "w1:p2", agent: "kiro", cwd },
  ];
  const pids = { "w1:p1": 100, "w1:p2": 200 };
  const herdr = {
    async snapshot() { return { panes }; },
    async paneProcessInfo(paneId) { return { process_info: { foreground_processes: [{ pid: pids[paneId], name: "kiro-cli" }] } }; },
  };
  const service = new ConversationService({ herdr, localStore: localTranscriptStore({ configDir: "/nonexistent", kiroConfigDir: configDir, procRoot }) });
  assert.equal((await service.resolve("w1:p1")).path, older);
  assert.equal((await service.resolve("w1:p2")).path, newer);
});

test("two Kiro panes in one folder whose sessions cannot be told show neither, never the same one", async (context) => {
  forgetConversationState();
  const configDir = await mkdtemp(join(tmpdir(), "herdrabbit-kiro-"));
  context.after(() => rm(configDir, { recursive: true, force: true }));
  const cwd = "/home/me/project";
  const dir = join(configDir, "sessions", kiroWorkspaceHash(cwd), `sess_${UUID_A}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "messages.jsonl"), jsonl([user("hi")]));
  const panes = [{ pane_id: "w1:p1", agent: "kiro", cwd }, { pane_id: "w1:p2", agent: "kiro", cwd }];
  // no process info: the system cannot say which pane runs which session
  const herdr = { async snapshot() { return { panes }; } };
  const service = new ConversationService({ herdr, localStore: localTranscriptStore({ configDir: "/nonexistent", kiroConfigDir: configDir }) });
  await assert.rejects(service.resolve("w1:p1"), (error) => error instanceof ConversationUnavailable && error.reason === "no_session_id");
  // alone in its folder, a pane still shows the folder's newest session
  const alone = new ConversationService({ herdr: { async snapshot() { return { panes: [panes[0]] }; } }, localStore: localTranscriptStore({ configDir: "/nonexistent", kiroConfigDir: configDir }) });
  assert.equal((await alone.resolve("w1:p1")).session, UUID_A);
});

// Kiro writes a Reasoning record of only "..." where its thinking is kept
// encrypted (reasoningSignature), most often right after the answer. It is no
// thinking to show, and a part after the answer would fold the answer into the
// work block as if the agent were still at it.
test("a Reasoning of only dots is no thinking part, so the answer stays the turn's last words", () => {
  const turns = parseKiroTranscript(jsonl([
    user("what next?"),
    turnStart(),
    reasoning("Let me weigh the two options.", "claude-opus"),
    say("Pick the code page."),
    reasoning("...", "claude-opus"),
    reasoning("  …  ", "claude-opus"),
  ]));
  assert.deepEqual(turns[1].parts.map((part) => [part.kind, part.text]), [
    ["thinking", "Let me weigh the two options."],
    ["text", "Pick the code page."],
  ]);
});

// Kiro names a session's directory after the folder it started in and keeps
// writing there. A folder renamed under a running Kiro (open-physics →
// puppy-land, 2026-10-31) is reported at its new path, whose hash holds
// nothing: the session its process names is found under whichever hash holds it.
test("a session its process names is found even when the pane's folder was renamed since Kiro started", async (context) => {
  forgetConversationState();
  const configDir = await mkdtemp(join(tmpdir(), "herdrabbit-kiro-"));
  const procRoot = await mkdtemp(join(tmpdir(), "herdrabbit-proc-"));
  context.after(() => Promise.all([rm(configDir, { recursive: true, force: true }), rm(procRoot, { recursive: true, force: true })]));
  const before = "/home/me/open-physics";
  const after = "/home/me/puppy-land";
  const dir = join(configDir, "sessions", kiroWorkspaceHash(before), `sess_${UUID_A}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  await writeFile(path, jsonl([user("hi"), turnStart(), say("hello")]));
  await fakeProcess(procRoot, 100, { file: await kiroLog(configDir, "a", [UUID_A]) });
  const herdr = {
    async snapshot() { return { panes: [{ pane_id: "w1:p1", agent: "kiro", cwd: after, foreground_cwd: after }] }; },
    async paneProcessInfo() { return { process_info: { foreground_processes: [{ pid: 100, name: "kiro-cli" }] } }; },
  };
  const service = new ConversationService({ herdr, localStore: localTranscriptStore({ configDir: "/nonexistent", kiroConfigDir: configDir, procRoot }) });
  const found = await service.resolve("w1:p1");
  assert.equal(found.path, path);
  assert.equal(found.session, UUID_A);
});

test("a named session is looked for under other workspaces only by its own name, and only when its process named it", async (context) => {
  const { store, writeSession } = await kiroHome(context);
  const elsewhere = await writeSession("/home/me/old-name", UUID_A, jsonl([user("mine")]));
  await writeSession("/home/me/other", UUID_B, jsonl([user("not mine")]), 9_000);
  const here = kiroWorkspaceHash("/home/me/new-name");
  assert.equal((await store.locate({ session: UUID_A, hashes: [here], anywhere: true })).path, elsewhere);
  // found again where it was found, and again after it moves once more
  assert.equal((await store.locate({ session: UUID_A, hashes: [here], anywhere: true })).path, elsewhere);
  const { rename } = await import("node:fs/promises");
  const moved = join(dirname(dirname(dirname(elsewhere))), kiroWorkspaceHash("/home/me/third"));
  await rename(dirname(dirname(elsewhere)), moved);
  assert.equal((await store.locate({ session: UUID_A, hashes: [here], anywhere: true })).path, join(moved, `sess_${UUID_A}`, "messages.jsonl"));
  // a name only reported (not by the pane's process) is looked for in the pane's folder alone
  assert.equal(await store.locate({ session: UUID_A, hashes: [here] }), null);
  // without a name, only the pane's own folder counts: another folder's newest is not the pane's
  assert.equal(await store.locate({ session: null, hashes: [here], anywhere: true }), null);
  const missing = "33333333-3333-4333-8333-333333333333";
  assert.equal(await store.locate({ session: missing, hashes: [here], anywhere: true }), null);
});

// Kiro's steering: a message sent while Kiro works is written as the user's
// own record ({ id: "steer-…", source: "steer" }), and then once more inside
// the instructions Kiro gives itself (a user record marked
// syntheticUserMessageReason "steering-injection"). Only the user's words show.
const steer = (id, content) => ({ id, timestamp: "2026-10-31T14:11:51.010Z", payload: { type: "user", content, source: "steer" } });
const injected = (ids, words) => rec({
  type: "user",
  content: `[LIVE STEERING - New message from user]\n\nThe user sent a new message while you are working. As the currently active agent, adjust your approach if necessary based on this guidance.\n\n${ids.map((id, index) => `<user_message id="${id}">\n${words[index]}\n</user_message>`).join("\n\n")}\n\nIMPORTANT: After completing your work, include a brief note about how you handled this steering message. Use this exact format:\n\n[STEERING ${ids[0]}: <describe what you did or why it wasn't applicable>]`,
  _meta: { kiro: { syntheticUserMessageReason: "steering-injection", steeringConsumedIds: ids } },
});

test("a message sent while Kiro works shows once, as the user's words, not Kiro's steering instructions", () => {
  const id = "steer-59da8b42-02c1-44e5-8b85-a3f78bbf6ab8";
  const turns = parseKiroTranscript(jsonl([
    user("read every mail"),
    turnStart(),
    say("Running both evals."),
    steer(id, "한글로 말해..."),
    toolCall("tool_01", "execute_bash", { command: "ls" }),
    toolResult("tool_01", "ok", true),
    injected([id], ["한글로 말해..."]),
    say("알겠습니다."),
  ]));
  assert.deepEqual(texts(turns), ["read every mail", "Running both evals.", "한글로 말해...", "[tool] 알겠습니다."]);
  assert.ok(!JSON.stringify(turns).includes("LIVE STEERING"));
});

test("steering instructions whose message has no record of its own show the message inside them", () => {
  const turns = parseKiroTranscript(jsonl([
    user("start"),
    turnStart(),
    say("working"),
    injected(["steer-1", "steer-2"], ["외부 연동도 좋고", "300통 말고 더 마니 읽어"]),
    say("ok"),
  ]));
  assert.deepEqual(texts(turns), ["start", "working", "외부 연동도 좋고", "300통 말고 더 마니 읽어", "ok"]);
});

test("a prompt that only starts like steering, or steering whose messages cannot be read, still shows", () => {
  const pasted = "[LIVE STEERING - New message from user] was in the log";
  const unreadable = rec({ type: "user", content: "[LIVE STEERING - New message from user]\n\n<message>새 형식</message>",
    _meta: { kiro: { syntheticUserMessageReason: "steering-injection" } } });
  const turns = parseKiroTranscript(jsonl([user(pasted), turnStart(), say("ok"), unreadable]));
  assert.deepEqual(texts(turns), [pasted, "ok", "[LIVE STEERING - New message from user]\n\n<message>새 형식</message>"]);
});

test("the same steering message given to Kiro again shows once", () => {
  const id = "steer-aaaa";
  const turns = parseKiroTranscript(jsonl([
    user("start"), turnStart(), say("working"),
    steer(id, "더 읽어"), injected([id], ["더 읽어"]), say("reading"), injected([id], ["더 읽어"]), say("done"),
  ]));
  assert.deepEqual(texts(turns), ["start", "working", "더 읽어", "reading done"]);
});

// A steering message Kiro could not give the model before its turn ended:
// Kiro writes it ({ source: "steer" }), clears it with a boundary record
// (steeringClearedIds), and sends the same words as the next prompt
// (puppy-land, 2026-10-30, "도장크기를 좀더 키워줘"). It shows once, as that
// prompt, and the work around it stays one block.
const boundary = (ids) => ({ id: `steering_boundary_${seq++}`, timestamp: "2026-10-30T04:27:05.000Z",
  payload: { type: "user", content: "", source: "steer", _meta: { kiro: { steeringClearedIds: ids } } } });
const turnEnd = () => rec({ type: "turn_end" });

function resentSteering(id, words) {
  return [
    user("make the stamp"), turnStart(), say("drawing it"),
    toolCall("tool_01", "execute_bash", { command: "ls" }), toolResult("tool_01", "ok", true),
    steer(id, words), boundary([id]), say("the pixelation is from the viewport"), turnEnd(),
    user(words), turnStart(), say("enlarging the stamp"),
  ];
}

test("a steering message Kiro sends again as the next prompt shows once, as that prompt", () => {
  const turns = parseKiroTranscript(jsonl(resentSteering("steer-d007", "도장크기를 좀더 키워줘")));
  assert.deepEqual(texts(turns), [
    "make the stamp",
    "drawing it [tool] the pixelation is from the viewport",
    "도장크기를 좀더 키워줘",
    "enlarging the stamp",
  ]);
});

test("a cleared steering message followed by other words shows as it was sent", () => {
  const records = resentSteering("steer-e1", "p03 위젯은 뭐야?");
  records[records.length - 3] = user("p03의 첫번째 위젯은 왜 비어있지");
  assert.deepEqual(texts(parseKiroTranscript(jsonl(records))), [
    "make the stamp", "drawing it [tool]", "p03 위젯은 뭐야?", "the pixelation is from the viewport",
    "p03의 첫번째 위젯은 왜 비어있지", "enlarging the stamp",
  ]);
});

test("a steering message given to the model and cleared later is no resend, even when the next prompt says the same", () => {
  const id = "steer-c1";
  const records = [
    user("start"), turnStart(), say("working"),
    steer(id, "더 읽어"), injected([id], ["더 읽어"]), say("reading"), boundary([id]), turnEnd(),
    user("더 읽어"), turnStart(), say("again"),
  ];
  assert.deepEqual(texts(parseKiroTranscript(jsonl(records))), ["start", "working", "더 읽어", "reading", "더 읽어", "again"]);
});

test("pages never start at a steering message's resend, so its page holds the message too", async (context) => {
  const directory = await temp(context);
  const path = join(directory, "messages.jsonl");
  const records = [];
  for (let index = 0; index < 10; index += 1) records.push(user(`prompt ${index}`), turnStart(), say(`answer ${index}`), turnEnd());
  records.push(...resentSteering("steer-p1", "다시 보내진 말"));
  const resend = records.at(-3);
  // 49 turns after the resend: a page of 50 would begin exactly on it
  for (let index = 0; index < 49; index += 1) records.push(user(`later ${index}`), turnStart(), say(`reply ${index}`), turnEnd());
  const { KIRO_TRANSCRIPT: format } = await import("../src/conversation/kiro.mjs");
  const bytes = Buffer.from(jsonl(records));
  const starts = format.turnStarts(bytes);
  const resendAt = bytes.indexOf(Buffer.from(JSON.stringify(resend)));
  assert.ok(resendAt > 0);
  assert.ok(!starts.includes(resendAt), "the resend opens no page");
  await writeFile(path, bytes);
  const store = localTranscriptStore({ configDir: directory });
  const all = [];
  let page = await transcriptPage(store, path);
  for (;;) {
    all.unshift(...page.turns);
    if (page.cursor === null) break;
    page = await transcriptPage(store, path, { before: page.cursor });
  }
  assert.equal(texts(all).filter((text) => text === "다시 보내진 말").length, 1);
  assert.equal(texts(all).filter((text) => text.startsWith("prompt ") || text.startsWith("later ")).length, 59);
});

test("a page opens at a prompt, never at a steering boundary or Kiro's steering instructions", () => {
  const id = "steer-s1";
  const records = [
    user("start"), turnStart(), say("working"),
    steer(id, "더 읽어"), injected([id], ["더 읽어"]), say("reading"), boundary([id]), turnEnd(),
    boundary([]), turnStart(), say("a turn with no prompt of its own"),
  ];
  const bytes = Buffer.from(jsonl(records));
  const at = (item) => bytes.indexOf(Buffer.from(JSON.stringify(item)));
  // the prompt opens the first turn; the second, with no prompt, opens on its turn_start
  assert.deepEqual(KIRO_TRANSCRIPT.turnStarts(bytes), [at(records[0]), at(records[9])]);
});

test("a steering message sent right as a turn starts, and sent again, shows once and keeps the turn's times", () => {
  const id = "steer-t1";
  const records = [
    user("start"), turnStart(),
    steer(id, "패치버전으로"), boundary([id]), turnEnd(),
    user("패치버전으로"), turnStart(), say("patching", "2026-09-19T09:00:00.000Z"),
  ];
  const turns = parseKiroTranscript(jsonl(records));
  assert.deepEqual(texts(turns), ["start", "패치버전으로", "patching"]);
  // work split by a removed message is one block, from its first record to its last
  const split = resentSteering("steer-t2", "다시");
  split[2] = say("drawing it", "2026-09-19T08:00:01.000Z");
  split[7] = say("the pixelation is from the viewport", "2026-09-19T08:00:09.000Z");
  const merged = parseKiroTranscript(jsonl(split))[1];
  assert.equal(merged.ts, "2026-09-19T08:00:01.000Z");
  assert.equal(merged.end_ts, "2026-09-19T08:00:09.000Z");
});

test("a page window whose edge falls between a steering message and its resend still shows it once", async (context) => {
  const directory = await temp(context);
  const path = join(directory, "messages.jsonl");
  const records = [];
  for (let index = 0; index < 5; index += 1) records.push(user(`prompt ${index}`), turnStart(), say(`answer ${index}`), turnEnd());
  records.push(...resentSteering("steer-w1", "창 경계의 말"));
  for (let index = 0; index < 3; index += 1) records.push(user(`later ${index}`), turnStart(), say(`reply ${index}`), turnEnd());
  const bytes = Buffer.from(jsonl(records));
  await writeFile(path, bytes);
  const steerAt = bytes.indexOf(Buffer.from('"창 경계의 말","source":"steer"'));
  const resendAt = bytes.indexOf(Buffer.from(JSON.stringify(records.at(-15))));
  assert.ok(steerAt > 0 && resendAt > steerAt);
  // every window size puts the edge somewhere; some put it between the two
  for (let windowBytes = 200; windowBytes <= bytes.length; windowBytes += 37) {
    forgetConversationState();
    const base = localTranscriptStore({ configDir: directory });
    const store = new Proxy(base, { get: (target, key) => (key === "windowBytes" ? windowBytes : target[key]) });
    const all = [];
    let page = await transcriptPage(store, path);
    for (let guard = 0; guard < 1_000; guard += 1) {
      all.unshift(...page.turns);
      if (page.cursor === null) break;
      page = await transcriptPage(store, path, { before: page.cursor });
    }
    assert.equal(texts(all).filter((text) => text === "창 경계의 말").length, 1, `window ${windowBytes}`);
  }
});

// A page cut mid-turn (the newest page with no turn start in its window, or an
// older page at its byte cap) moves past a steering message and the line that
// shows it in its place, so one page holds both.
async function walkEveryWindow(context, records, words, { step = 41 } = {}) {
  const directory = await temp(context);
  const path = join(directory, "messages.jsonl");
  const bytes = Buffer.from(jsonl(records));
  await writeFile(path, bytes);
  const whole = texts(parseKiroTranscript(bytes.toString("utf8")));
  // user words and assistant text, in order: a page that lost or repeated a
  // record would read differently from the whole file
  const flat = (turns) => texts(turns).join(" ").split(/\s+/u).filter(Boolean);
  for (let windowBytes = 200; windowBytes <= bytes.length + step; windowBytes += step) {
    for (const maxPageBytes of [windowBytes * 4]) {
      forgetConversationState();
      const base = localTranscriptStore({ configDir: directory });
      const store = new Proxy(base, { get: (target, key) => (key === "windowBytes" ? windowBytes : key === "maxPageBytes" ? maxPageBytes : target[key]) });
      const all = [];
      let page = await transcriptPage(store, path);
      const newestCursor = page.cursor;
      for (let guard = 0; guard < 2_000; guard += 1) {
        all.unshift(...page.turns);
        if (page.cursor === null) break;
        page = await transcriptPage(store, path, { before: page.cursor });
      }
      const label = `window ${windowBytes}, cap ${maxPageBytes}`;
      assert.equal(texts(all).filter((text) => text.split(" ").includes(words) || text === words).length, 1, label);
      assert.deepEqual(flat(all), flat(parseKiroTranscript(bytes.toString("utf8"))), label);
      // an open chat holding its newest page's cursor reads the same turns from it
      if (newestCursor !== null) {
        const held = await transcriptPage(store, path, { since: newestCursor });
        const older = [];
        let back = { cursor: newestCursor };
        for (let guard = 0; guard < 2_000 && back.cursor !== null; guard += 1) {
          back = await transcriptPage(store, path, { before: back.cursor });
          older.unshift(...back.turns);
        }
        assert.deepEqual(flat([...older, ...held.turns]), flat(parseKiroTranscript(bytes.toString("utf8"))), `${label}, since`);
      }
    }
  }
  assert.ok(whole.length > 0);
}

test("a live turn after a steering message's resend, read in any window, shows the message once", async (context) => {
  const records = [user("start"), turnStart(), say("first")];
  records.push(...resentSteering("steer-l1", "살아있는말"));
  for (let index = 0; index < 30; index += 1) records.push(say(`step ${index} ${"x".repeat(60)}`));
  await walkEveryWindow(context, records, "살아있는말");
});

test("a steering message and the instructions that give it to the model, read in any window, show once", async (context) => {
  const id = "steer-i1";
  const records = [user("start"), turnStart(), say("first"), steer(id, "건네진말")];
  for (let index = 0; index < 20; index += 1) records.push(say(`work ${index} ${"y".repeat(60)}`));
  records.push(injected([id], ["건네진말"]));
  for (let index = 0; index < 20; index += 1) records.push(say(`more ${index} ${"z".repeat(60)}`));
  await walkEveryWindow(context, records, "건네진말");
});

test("a page filling an open chat's gap never reaches back past the cursor it holds, even for a steering message", async (context) => {
  const directory = await temp(context);
  const path = join(directory, "messages.jsonl");
  const id = "steer-f1";
  const records = [user("start"), turnStart(), say("first"), steer(id, "바닥말")];
  for (let index = 0; index < 20; index += 1) records.push(say(`work ${index} ${"y".repeat(60)}`));
  records.push(injected([id], ["바닥말"]));
  for (let index = 0; index < 20; index += 1) records.push(say(`more ${index} ${"z".repeat(60)}`));
  const bytes = Buffer.from(jsonl(records));
  await writeFile(path, bytes);
  // the chat holds a cursor between the message and Kiro's instructions
  const held = bytes.indexOf(Buffer.from(JSON.stringify(records[10])));
  assert.ok(held > bytes.indexOf(Buffer.from('"바닥말","source":"steer"')));
  const base = localTranscriptStore({ configDir: directory });
  const store = new Proxy(base, { get: (target, key) => (key === "windowBytes" ? 300 : key === "maxPageBytes" ? 1_200 : target[key]) });
  forgetConversationState();
  const { history_id: historyId } = await transcriptPage(store, path);
  let before = bytes.length;
  for (let guard = 0; guard < 100 && before > held; guard += 1) {
    const page = await transcriptPage(store, path, { before: `${historyId}:${before}`, since: `${historyId}:${held}` });
    const start = page.cursor === null ? 0 : Number(page.cursor.split(":").at(-1));
    assert.ok(start >= held, `a page from ${start}, below the held ${held}`);
    if (start === before) break;
    before = start;
  }
});
