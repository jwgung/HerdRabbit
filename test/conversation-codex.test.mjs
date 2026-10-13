// Fixtures are hand-made in Codex's rollout format; many cases follow
// herdr-web-ui's server/codex.test.ts and server/codex.contract.test.ts (MIT,
// Copyright (c) 2026 devswha).
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_TRANSCRIPT,
  codexCallFailed,
  forgetCodexState,
  interactiveRolloutHeader,
  isCodexProcess,
  locateCodexRollout,
  matchCodexTranscript,
  parseCodexMetadata,
  parseCodexTranscript,
} from "../src/conversation/codex.mjs";
import {
  HistoryChanged,
  MAX_PAGE_PROMPTS,
  TOOL_OUTPUT_PREVIEW_CHARS,
  forgetConversationState,
  transcriptPage,
  transcriptToolOutput,
} from "../src/conversation/pages.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { defaultCodexHome, localTranscriptStore } from "../src/conversation/stores.mjs";

const THREAD = "019da5c2-66fd-7021-b565-5e94406b028e";
const OTHER = "019da5c2-0000-7000-8000-000000000001";
const ts = "2026-09-22T01:00:00.000Z";
const item = (payload, timestamp = ts) => ({ type: "response_item", timestamp, payload });
const event = (payload, timestamp = ts) => ({ type: "event_msg", timestamp, payload });
const message = (role, text, phase) => item({
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}),
});
const meta = (extra = {}) => ({ type: "session_meta", timestamp: ts, payload: { id: THREAD, cwd: "/work/app", source: "cli", ...extra } });
const jsonl = (...records) => `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
// One task as Codex writes it: started, the prompt twice (event + model copy), the answer twice.
const task = (n) => [
  event({ type: "task_started", turn_id: `t${n}` }),
  { type: "turn_context", payload: { model: "gpt-test", effort: "high" } },
  message("user", `prompt ${n}`),
  event({ type: "user_message", message: `prompt ${n}` }),
  event({ type: "agent_message", message: `answer ${n}` }),
  message("assistant", `answer ${n}`, "final_answer"),
  event({ type: "task_complete" }),
];
const texts = (turns) => turns.map((turn) => turn.parts.map((part) => part.text ?? `[${part.kind}]`).join(" "));

async function temp(context) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-codex-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A rollout under home/sessions/2026/09/22, as Codex names it.
async function rolloutIn(home, thread = THREAD, text = jsonl(meta({ id: thread }), ...task(1)), day = ["2026", "09", "22"]) {
  const folder = join(home, "sessions", ...day);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `rollout-2026-09-22T01-00-00-${thread}.jsonl`);
  await writeFile(path, text);
  return path;
}

// ---------------------------------------------------------------------------
// Records.

test("hides injected context, developer messages and metadata, keeping the real request", () => {
  const turns = parseCodexTranscript(jsonl(
    meta({ base_instructions: "internal system prompt" }),
    message("developer", "internal developer prompt"),
    message("user", "# AGENTS.md instructions for /project\n<INSTRUCTIONS>internal rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>"),
    message("user", "<environment_context>cwd</environment_context>"),
    item({ type: "message", role: "user", content: [null, { type: "input_text", text: "<environment_context>cwd</environment_context>" }, { type: "input_text", text: "Fix chat" }] }),
    message("user", "<skill>\n<name>review</name>\n<path>/project/skills/review/SKILL.md</path>\nPRIVATE SKILL INSTRUCTIONS\n</skill>"),
    event({ type: "user_message", kind: "internal", message: "injected reminder" }),
    event({ type: "token_count", info: { total: 10 } }),
    message("assistant", "Fixed", "final_answer"),
  ));
  assert.deepEqual(turns.map((turn) => turn.parts), [
    [{ kind: "text", text: "Fix chat" }],
    [{ kind: "text", text: "Fixed", phase: "final_answer" }],
  ]);
  assert.ok(!JSON.stringify(turns).includes("PRIVATE SKILL INSTRUCTIONS"));
});

test("reads the event and the model copy of one message once, in either order, but keeps real repeats", () => {
  for (const reverse of [false, true]) {
    const pair = [message("user", "continue"), event({ type: "user_message", message: "continue" })];
    if (reverse) pair.reverse();
    const turns = parseCodexTranscript(jsonl(
      ...pair,
      event({ type: "agent_message", message: "Done" }), message("assistant", "Done", "final_answer"),
      message("user", "continue"), message("user", "continue"),
    ));
    assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant", "user", "user"]);
    assert.deepEqual(turns[1].parts, [{ kind: "text", text: "Done", phase: "final_answer" }]);
  }
  // seconds apart, the same words are two messages
  assert.equal(parseCodexTranscript(jsonl(
    message("user", "continue"),
    event({ type: "user_message", message: "continue" }, "2026-09-22T01:00:02.000Z"),
  )).length, 2);
});

test("folds tool calls and their outputs into the agent's turn, the final answer last", () => {
  const turns = parseCodexTranscript(jsonl(
    message("user", "Check"),
    message("assistant", "Checking", "commentary"),
    item({ type: "function_call", call_id: "call_read", name: "exec_command", arguments: '{"cmd":"git status"}' }),
    item({ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch\n" }),
    item({ type: "custom_tool_call_output", call_id: "call_patch", output: "Success. Updated the following files:\nM src/a.ts" }),
    item({ type: "function_call_output", call_id: "call_read", output: [{ type: "text", text: "clean" }] }),
    item({ type: "function_call_output", call_id: "unknown", output: "not a chat message" }),
    item({ type: "function_call", call_id: "call_shell", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm test"] }) }),
    item({ type: "function_call_output", call_id: "call_shell", output: "Process exited with code 1\nOutput:\nfailed" }),
    message("assistant", "All fixed", "final_answer"),
  ));
  assert.equal(turns.length, 2);
  const parts = turns[1].parts;
  assert.deepEqual(parts.map((part) => part.kind), ["text", "tool", "tool", "tool", "text"]);
  assert.deepEqual(parts[1], {
    kind: "tool", id: "call_read", name: "exec_command", summary: "git status",
    input: JSON.stringify({ cmd: "git status" }, null, 2), output: "clean", output_size: 5,
  });
  assert.equal(parts[2].summary, "src/a.ts");
  assert.ok(parts[2].input.startsWith("*** Begin Patch"));
  assert.equal(parts[2].error, undefined);
  assert.equal(parts[3].summary, "npm test");
  assert.equal(parts[3].error, true);
  assert.deepEqual(parts.at(-1), { kind: "text", text: "All fixed", phase: "final_answer" });
  assert.ok(!JSON.stringify(turns).includes("not a chat message"));
});

test("reads a failure from what Codex recorded, judging a completed script as a whole", () => {
  assert.equal(codexCallFailed("Chunk ID: 1\nWall time: 0.0 seconds\nProcess exited with code 1\nOutput:\n"), true);
  assert.equal(codexCallFailed("Process exited with code 0\nOutput:\nok"), false);
  assert.equal(codexCallFailed('{"output":"boom","metadata":{"exit_code":2}}'), true);
  assert.equal(codexCallFailed("Script failed\nError: x"), true);
  assert.equal(codexCallFailed("apply_patch verification failed: Failed to find expected lines in /x"), true);
  assert.equal(codexCallFailed("Script completed\nProcess exited with code 1"), false);
  assert.equal(codexCallFailed("{\"accepted\":true}"), false);
});

test("keeps a long output's preview in the page and its size for the rest", () => {
  const turns = parseCodexTranscript(jsonl(
    item({ type: "function_call", call_id: "call_big", name: "exec_command", arguments: "{bad json" }),
    item({ type: "function_call_output", call_id: "call_big", output: "x".repeat(10_000) }),
  ));
  const tool = turns[0].parts[0];
  assert.equal(tool.output.length, TOOL_OUTPUT_PREVIEW_CHARS);
  assert.equal(tool.output_truncated, true);
  assert.equal(tool.output_size, 10_000);
  // freeform input that is not JSON stays as it was written
  assert.equal(tool.input, "{bad json");
});

test("shows reasoning summaries as thinking, never the encrypted reasoning", () => {
  const turns = parseCodexTranscript(jsonl(
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "Considering options" }], encrypted_content: "secret" }),
    item({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "Analysis text" }] }),
    message("assistant", "Answer", "final_answer"),
  ));
  assert.deepEqual(turns[0].parts.map((part) => part.kind), ["thinking", "thinking", "text"]);
  assert.ok(!JSON.stringify(turns).includes("secret"));
});

test("marks a compaction, and times a turn by its task rather than the idle time after it", () => {
  const turns = parseCodexTranscript(jsonl(
    event({ type: "task_started", started_at: ts }),
    message("user", "Check"),
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }], phase: "final_answer" }, "2026-09-22T01:00:06.000Z"),
    event({ type: "task_complete" }, "2026-09-22T01:00:07.000Z"),
    { type: "compacted", timestamp: "2026-09-22T01:30:00.000Z", payload: { message: "Summary of the work so far", replacement_history: [message("user", "old")] } },
    event({ type: "user_message", message: "Next" }, "2026-09-22T02:00:00.000Z"),
  ));
  assert.deepEqual(turns[1], { role: "assistant", ts, end_ts: "2026-09-22T01:00:07.000Z", parts: [{ kind: "text", text: "Done", phase: "final_answer" }] });
  assert.deepEqual(turns[2].parts, [{ kind: "compact", text: "Summary of the work so far" }]);
  assert.deepEqual(texts(turns), ["Check", "Done", "Summary of the work so far", "Next"]);
});

test("tolerates malformed and partly written records", () => {
  const text = `${jsonl(null, 1, [], { type: "response_item", payload: null }, { type: "event_msg" }, message("user", "hello"))}{"type":"response_item","payload":{"type":"mess`;
  assert.deepEqual(texts(parseCodexTranscript(text)), ["hello"]);
});

test("hides memory citations in answers but not quoted ones", () => {
  const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[context]\n</citation_entries>\n</oai-mem-citation>";
  const turns = parseCodexTranscript(jsonl(
    event({ type: "agent_message", message: "Done" }),
    message("assistant", `Done\n${citation}`, "final_answer"),
  ));
  assert.deepEqual(turns[0].parts, [{ kind: "text", text: "Done", phase: "final_answer" }]);
  const quoted = "Match the literal tag `<oai-mem-citation>` in the parser.";
  assert.equal(parseCodexTranscript(jsonl(message("assistant", quoted)))[0].parts[0].text, quoted);
});

test("shows what a queued question was answered, and names attached images", () => {
  const reply = `<send_user_message_question_reply>\n${JSON.stringify([{ answer: "YCB-V", question: "Which dataset?", questionItemId: '["request_user_input_async","call_a",0]' }])}\n</send_user_message_question_reply>`;
  const turns = parseCodexTranscript(jsonl(
    item({ type: "function_call", call_id: "call_a", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ title: "Which dataset?" }, { title: "Any notes?" }] }) }),
    message("user", reply),
    event({ type: "user_message", message: "look", local_images: ["/tmp/shot.png", "https://example.com/x.png"] }),
  ));
  assert.equal(turns[0].parts[0].summary, "Which dataset? · Any notes?");
  assert.deepEqual(turns[1].parts, [{ kind: "text", text: "YCB-V" }]);
  assert.deepEqual(turns[2].parts, [{ kind: "image", media_type: "image/png" }, { kind: "text", text: "look" }]);
});

test("reads the model, effort and context of the newest turn", () => {
  const metadata = parseCodexMetadata(jsonl(
    meta(),
    { type: "turn_context", payload: { model: "gpt-old", effort: "low" } },
    event({ type: "token_count", info: { last_token_usage: { total_tokens: 1200 }, model_context_window: 272_000 } }),
    { type: "turn_context", payload: { model: "gpt-test", collaboration_mode: { settings: { reasoning_effort: "xhigh" } } } },
  ));
  assert.deepEqual(metadata, { model: "gpt-test", reasoning_effort: "xhigh", context: { used: 1200, window: 272_000 } });
});

// ---------------------------------------------------------------------------
// Pages.

test("pages back through a long rollout by its tasks, without gaps or overlaps, and reads metadata from its head", async (context) => {
  forgetConversationState();
  const home = await temp(context);
  const count = MAX_PAGE_PROMPTS + 15;
  const path = await rolloutIn(home, THREAD, jsonl(meta(), ...Array.from({ length: count }, (_, n) => task(n)).flat()));
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  const newest = await transcriptPage(CODEX_TRANSCRIPT, store, path);
  assert.equal(newest.source, "codex-transcript");
  assert.equal(newest.turns.length, MAX_PAGE_PROMPTS * 2);
  assert.deepEqual(newest.metadata, { model: "gpt-test", reasoning_effort: "high" });
  assert.equal(texts(newest.turns)[0], `prompt ${count - MAX_PAGE_PROMPTS}`);
  const older = await transcriptPage(CODEX_TRANSCRIPT, store, path, { before: newest.cursor });
  assert.deepEqual(texts(older.turns), Array.from({ length: count - MAX_PAGE_PROMPTS }, (_, n) => [`prompt ${n}`, `answer ${n}`]).flat());
  assert.equal(older.cursor, null);
  assert.equal((await transcriptPage(CODEX_TRANSCRIPT, store, path, { ifNoneMatch: newest.version })).notModified, true);
  await appendFile(path, jsonl(...task(count)));
  const grown = await transcriptPage(CODEX_TRANSCRIPT, store, path, { since: newest.cursor });
  assert.equal(texts(grown.turns).at(-1), `answer ${count}`);
  await writeFile(path, jsonl(meta(), ...task(1)));
  await assert.rejects(transcriptPage(CODEX_TRANSCRIPT, store, path, { before: newest.cursor }), HistoryChanged);
});

test("finds a tool's whole output by its call id", async (context) => {
  forgetConversationState();
  const home = await temp(context);
  const big = "y".repeat(50_000);
  const path = await rolloutIn(home, THREAD, jsonl(meta(), ...task(1),
    item({ type: "function_call", call_id: "call_big", name: "exec_command", arguments: '{"cmd":"cat big"}' }),
    item({ type: "function_call_output", call_id: "call_big", output: big }),
    ...task(2)));
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  assert.deepEqual(await transcriptToolOutput(CODEX_TRANSCRIPT, store, path, "call_big"), { output: big, size: big.length });
  assert.equal(await transcriptToolOutput(CODEX_TRANSCRIPT, store, path, "call_none"), null);
});

// ---------------------------------------------------------------------------
// Where the rollout is.

test("uses CODEX_HOME when it is an absolute path, else ~/.codex", () => {
  assert.equal(defaultCodexHome({ CODEX_HOME: "/srv/codex" }, "/home/me"), "/srv/codex");
  assert.equal(defaultCodexHome({ CODEX_HOME: "relative" }, "/home/me"), "/home/me/.codex");
  assert.equal(defaultCodexHome({}, "/home/me"), "/home/me/.codex");
});

test("takes the rollout herdr reports only inside the store's sessions, and only an interactive one", async (context) => {
  forgetCodexState();
  const home = await temp(context);
  const outside = await temp(context);
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  const path = await rolloutIn(home);
  assert.equal(await locateCodexRollout(store, { session: { kind: "path", value: path } }), path);
  // a link from inside the store to a file outside it is not the store's
  const foreign = join(outside, "rollout-x.jsonl");
  await writeFile(foreign, jsonl(meta()));
  const link = join(home, "sessions", "2026", "09", "22", `rollout-2026-09-22T02-00-00-${OTHER}.jsonl`);
  await symlink(foreign, link);
  for (const value of [foreign, link, join(home, "sessions", "missing.jsonl"), `${home}/sessions/../sessions/2026/09/22/none.jsonl`, "relative.jsonl"]) {
    assert.equal(await locateCodexRollout(store, { session: { kind: "path", value } }), null, value);
  }
  // a subagent's rollout, or a file that is no rollout, is not the pane's conversation
  const subagent = await rolloutIn(home, "019da5c2-0000-7000-8000-000000000002", jsonl(meta({ source: { subagent: "review" } }), ...task(1)));
  const plain = await rolloutIn(home, "019da5c2-0000-7000-8000-000000000003", jsonl(...task(1)));
  assert.equal(await locateCodexRollout(store, { session: { kind: "path", value: subagent } }), null);
  assert.equal(await locateCodexRollout(store, { session: { kind: "path", value: plain } }), null);
  assert.equal(interactiveRolloutHeader(JSON.stringify(meta({ thread_source: "subagent" }))), false);
  assert.equal(interactiveRolloutHeader(JSON.stringify(meta({ agent_role: "worker" }))), false);
});

test("finds a reported thread by its file name, the newest day first", async (context) => {
  forgetCodexState();
  const home = await temp(context);
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  assert.equal(await locateCodexRollout(store, { session: { kind: "id", value: THREAD } }), null);
  const path = await rolloutIn(home, THREAD, undefined, ["2026", "10", "01"]);
  await rolloutIn(home, OTHER);
  assert.equal(await locateCodexRollout(store, { session: { kind: "id", value: THREAD } }), path);
  assert.equal(await locateCodexRollout(store, { session: { kind: "id", value: "not-a-thread" } }), null);
});

test("finds a reported thread through Codex's thread index, read only", async (context) => {
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { context.skip("node:sqlite is not available"); return; }
  forgetCodexState();
  const home = await temp(context);
  // the index names a file the folder scan would not find by its name
  const folder = join(home, "sessions", "2026", "09", "22");
  await mkdir(folder, { recursive: true });
  const path = join(folder, "renamed.jsonl");
  await writeFile(path, jsonl(meta(), ...task(1)));
  const db = new sqlite.DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, source TEXT, updated_at INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 'cli', 1)").run(THREAD, path, "/work/app");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 'exec', 2)").run(OTHER, join(folder, "exec.jsonl"), "/work/app");
  db.close();
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  assert.equal(await locateCodexRollout(store, { session: { kind: "id", value: THREAD } }), path);
  // the index lists the directory's interactive threads, not its `codex exec` runs
  assert.deepEqual(await store.codex.threadsIn("/work/app"), [path]);
  assert.deepEqual(await store.codex.threadsIn("/elsewhere"), []);
});

test("takes the one rollout the pane's Codex process holds open", async (context) => {
  if (process.platform !== "linux") { context.skip("reads /proc"); return; }
  forgetCodexState();
  const home = await temp(context);
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  const path = await rolloutIn(home);
  const other = await rolloutIn(home, OTHER);
  // this test's own process stands in for Codex: it holds the rollout open
  const handle = await open(path, "r");
  context.after(() => handle.close());
  assert.equal(await locateCodexRollout(store, { pids: [process.pid] }), path);
  // two open rollouts tell nothing, and the reported thread decides
  const second = await open(other, "r");
  context.after(() => second.close());
  assert.equal(await locateCodexRollout(store, { pids: [process.pid] }), null);
  assert.equal(await locateCodexRollout(store, { pids: [process.pid], session: { kind: "id", value: OTHER } }), other);
  assert.equal(isCodexProcess(["/usr/local/bin/codex"]), true);
  assert.equal(isCodexProcess(["node", "--no-warnings", "/opt/codex/bin/codex.js"]), true);
  assert.equal(isCodexProcess(["node", "-e", "codex.js"]), false);
  assert.equal(isCodexProcess(["bash"]), false);
});

test("matches a pane by a substantial answer on its screen, and only a unique one", async (context) => {
  forgetCodexState();
  const answer = "The native Codex conversation now preserves the actual user request and final response while removing internal instructions.";
  const candidates = [
    { path: "correct", text: jsonl(message("assistant", answer, "final_answer")) },
    { path: "unrelated", text: jsonl(message("assistant", "Another conversation")) },
  ];
  assert.equal(matchCodexTranscript(`• ${answer.replaceAll(" ", "\n  ")}`, candidates), "correct");
  assert.equal(matchCodexTranscript("Different pane", candidates), null);
  assert.equal(matchCodexTranscript(answer, [...candidates, { ...candidates[0], path: "copy" }]), null);
  assert.equal(matchCodexTranscript("Done", [{ path: "short", text: jsonl(message("assistant", "Done")) }]), null);

  // through the store: the directory's threads are read, the screen decides
  const home = await temp(context);
  const path = await rolloutIn(home, THREAD, jsonl(meta(), message("user", "go"), message("assistant", answer, "final_answer")));
  const other = await rolloutIn(home, OTHER, jsonl(meta({ id: OTHER }), message("user", "go"), message("assistant", "Something else entirely, long enough to anchor on the screen of a pane.")));
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  store.codex = { ...store.codex, threadsIn: async () => [other, path] };
  assert.equal(await locateCodexRollout(store, { cwd: "/work/app", readScreen: async () => `› go\n\n• ${answer}\n` }), path);
  assert.equal(await locateCodexRollout(store, { cwd: "/work/app", readScreen: async () => "› go\n" }), null);
  // no screen to read, or no directory: nothing tells
  assert.equal(await locateCodexRollout(store, { cwd: "/work/app" }), null);
});

// ---------------------------------------------------------------------------
// The service.

function codexService(home, panes, herdr = {}) {
  return new ConversationService({
    herdr: { async snapshot() { return { panes }; }, ...herdr },
    localStore: localTranscriptStore({ configDir: join(home, "claude"), codexHome: home }),
  });
}

test("serves a Codex pane's conversation by the thread herdr reports, and its tool output", async (context) => {
  forgetConversationState();
  forgetCodexState();
  const home = await temp(context);
  await rolloutIn(home, THREAD, jsonl(meta(), ...task(1),
    item({ type: "function_call", call_id: "call_1", name: "exec_command", arguments: '{"cmd":"ls"}' }),
    item({ type: "function_call_output", call_id: "call_1", output: "a\nb" })));
  const service = codexService(home, [
    { pane_id: "w1:p1", agent: "codex", agent_session: { agent: "codex", kind: "id", value: THREAD }, cwd: "/work/app" },
    { pane_id: "w1:p2", agent: "codex", agent_session: { agent: "codex", kind: "id", value: OTHER }, cwd: "/work/app" },
    { pane_id: "w1:p3", agent: "codex", agent_session: null, cwd: "/work/app" },
    { pane_id: "w1:p4", agent: "gemini", cwd: "/work/app" },
    { pane_id: "w1:p5", agent: "codex", agent_session: { agent: "claude", kind: "id", value: THREAD }, cwd: "/work/app" },
  ]);
  const page = await service.page("w1:p1");
  assert.equal(page.source, "codex-transcript");
  assert.deepEqual(texts(page.turns), ["prompt 1", "answer 1 [tool]"]);
  assert.deepEqual(await service.toolOutput("w1:p1", "call_1"), { id: "call_1", output: "a\nb", output_size: 3, truncated: false });
  // a thread Codex has not written yet is an empty conversation
  const empty = await service.page("w1:p2");
  assert.deepEqual([empty.source, empty.turns, empty.cursor, empty.history_id], ["codex-transcript", [], null, `unwritten-${OTHER}`]);
  for (const [pane, reason] of [["w1:p3", "no_session_id"], ["w1:p4", "not_supported_agent"], ["w1:p5", "no_session_id"]]) {
    await assert.rejects(service.page(pane), (error) => error.code === "conversation_unavailable" && error.reason === reason, pane);
  }
});

test("finds a Codex pane's rollout through herdr's process info on this machine", async (context) => {
  if (process.platform !== "linux") { context.skip("reads /proc"); return; }
  forgetConversationState();
  forgetCodexState();
  const home = await temp(context);
  const path = await rolloutIn(home);
  const handle = await open(path, "r");
  context.after(() => handle.close());
  const asked = [];
  const service = codexService(home, [{ pane_id: "w1:p1", agent: "codex", cwd: "/work/app" }], {
    async paneProcessInfo(paneId) {
      asked.push(paneId);
      // a Codex process (this test's own pid, holding the file) and a shell that is not one
      return { process_info: { foreground_processes: [{ pid: process.pid, argv: ["/usr/bin/codex"] }, { pid: 1, argv: ["bash"] }] } };
    },
  });
  assert.deepEqual(texts((await service.page("w1:p1")).turns), ["prompt 1", "answer 1"]);
  assert.deepEqual(asked, ["w1:p1"]);
});

test("a Codex pane herdr names no session for is matched by its screen among its directory's threads", async (context) => {
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { context.skip("node:sqlite is not available"); return; }
  forgetConversationState();
  forgetCodexState();
  const home = await temp(context);
  const answer = "The rollout this pane shows ends with an answer long enough to tell it from every other thread here.";
  const path = await rolloutIn(home, THREAD, jsonl(meta(), message("user", "go"), message("assistant", answer, "final_answer")));
  const other = await rolloutIn(home, OTHER, jsonl(meta({ id: OTHER }), message("user", "go"), message("assistant", "Another thread of the same directory, with an answer of its own that is long enough.")));
  const db = new sqlite.DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER, updated_at INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, '/work/app', 0, 1)").run(THREAD, path);
  db.prepare("INSERT INTO threads VALUES (?, ?, '/work/app', 0, 2)").run(OTHER, other);
  db.close();
  const reads = [];
  const service = codexService(home, [{ pane_id: "w1:p1", agent: "codex", cwd: "/work/app" }], {
    async readPane(paneId, options) { reads.push({ paneId, ...options }); return `>_ OpenAI Codex (v0.160.1)\n› go\n\n• ${answer}\n`; },
  });
  assert.deepEqual(texts((await service.page("w1:p1")).turns), ["go", answer]);
  assert.deepEqual(reads, [{ paneId: "w1:p1", lines: 400, format: "text", source: "recent-unwrapped" }]);
});
