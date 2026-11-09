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
  codexTitleThreadName,
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

// Codex 0.150 and later: the model calls one code-mode `exec` script, and what
// the script did is recorded apart, as `item_completed` events.
test("names what a code-mode exec script ran, from what Codex recorded it running", () => {
  const exec = (callId, input) => item({ type: "custom_tool_call", call_id: callId, name: "exec", input });
  const done = (callId) => item({ type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: "Script completed\nOutput:\n" }] });
  const ran = (command) => event({ type: "item_completed", item: { type: "CommandExecution", id: "exec-1", command, status: "completed", exit_code: 0 } });
  const mcp = (tool) => event({ type: "item_completed", item: { type: "McpToolCall", id: "exec-2", server: "codex_apps", tool, status: "completed" } });
  const turns = parseCodexTranscript(jsonl(
    message("user", "Check"),
    exec("call_one", 'const r = await tools.exec_command({cmd:"git status"}); text(r.output);'),
    ran(["/bin/bash", "-lc", "git status"]),
    done("call_one"),
    exec("call_two", "await tools.exec_command({cmd: a}); await tools.exec_command({cmd: b});"),
    ran(["/bin/bash", "-lc", "npm test"]),
    ran(["git", "diff"]),
    done("call_two"),
    exec("call_mcp", "await tools.notion_create_comment({})"),
    mcp("notion.notion-create-comment"),
    done("call_mcp"),
    exec("call_patch", 'await tools.apply_patch("*** Begin Patch\\n*** Update File: src/a.ts\\n*** End Patch")'),
    ran(["/bin/bash", "-lc", "npm test"]),
    done("call_patch"),
    // nothing pending: a command the user ran is a row of its own
    ran(["/bin/bash", "-lc", "whoami"]),
  ));
  assert.deepEqual(turns[1].parts.map((part) => [part.name, part.summary]), [
    ["exec", "git status"],
    ["exec", "npm test; git diff"],
    ["exec", "notion.notion-create-comment"],
    ["exec", "src/a.ts"],
    ["exec_command", "whoami"],
  ]);
});

test("a script still running when its call returns is named by the command it was written to run", () => {
  const turns = parseCodexTranscript(jsonl(
    item({ type: "custom_tool_call", call_id: "call_long", name: "exec", input: 'const r = await tools.exec_command({cmd:"npm test",yield_time_ms:1000}); text(r.output);' }),
    item({ type: "custom_tool_call_output", call_id: "call_long", output: "Script running with cell ID g2:1" }),
    item({ type: "custom_tool_call", call_id: "call_var", name: "exec", input: "await tools.exec_command({cmd: command})" }),
    // Codex writes the key quoted as often as not
    item({ type: "custom_tool_call", call_id: "call_json", name: "exec", input: 'await tools.exec_command({"cmd":"pnpm lint","yield_time_ms":30000})' }),
  ));
  assert.deepEqual(turns[0].parts.map((part) => part.summary), ["npm test", "exec_command", "pnpm lint"]);
});

test("a wait on a running script is named by that script", () => {
  const turns = parseCodexTranscript(jsonl(
    item({ type: "custom_tool_call", call_id: "call_long", name: "exec", input: 'await tools.exec_command({cmd:"npm test"})' }),
    item({ type: "custom_tool_call_output", call_id: "call_long", output: [{ type: "input_text", text: "Script running with cell ID g2:7\nWall time 1.0 seconds" }] }),
    item({ type: "custom_tool_call", call_id: "call_wait", name: "wait", input: JSON.stringify({ cell_id: "g2:7", yield_time_ms: 30000 }) }),
    item({ type: "custom_tool_call_output", call_id: "call_wait", output: "Script completed\nOutput:\nok" }),
    item({ type: "custom_tool_call", call_id: "call_lost", name: "wait", input: JSON.stringify({ cell_id: "g9:9" }) }),
  ));
  assert.deepEqual(turns[0].parts.map((part) => part.summary), ["npm test", "npm test", "wait"]);
});

test("a command or file change no waiting call took is a row of its own, unless a script of the turn names it", () => {
  const done = (payload) => event({ type: "item_completed", item: payload });
  const turns = parseCodexTranscript(jsonl(
    message("user", "Build"),
    item({ type: "custom_tool_call", call_id: "call_build", name: "exec", input: 'await tools.exec_command({"cmd":"pnpm build","yield_time_ms":1000})' }),
    item({ type: "custom_tool_call_output", call_id: "call_build", output: "Script completed\nProcess running with session ID 81418" }),
    // the build the script started finishes after it returned: it is that script's row already
    done({ type: "CommandExecution", command: ["/bin/bash", "-lc", "pnpm build"], aggregated_output: "built", exit_code: 0 }),
    done({ type: "CommandExecution", id: "exec-9", command: ["/bin/bash", "-lc", "make check"], aggregated_output: "1 failed", exit_code: 2 }),
    done({ type: "FileChange", id: "exec-10", status: "completed", changes: {
      "/w/src/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-x\n+y\n" },
      "/w/src/new.ts": { type: "add", content: "one\ntwo\n" },
      "/w/src/old.ts": { type: "delete" },
    } }),
  ));
  const parts = turns[1].parts;
  assert.deepEqual(parts.map((part) => [part.name, part.summary]), [
    ["exec", "pnpm build"],
    ["exec_command", "make check"],
    ["apply_patch", "/w/src/a.ts, /w/src/new.ts, /w/src/old.ts"],
  ]);
  assert.equal(parts[1].id, "exec-9");
  assert.deepEqual(JSON.parse(parts[1].input), { cmd: "make check" });
  assert.equal(parts[1].output, "1 failed");
  assert.equal(parts[1].error, true);
  assert.equal(parts[2].input, [
    "*** Begin Patch",
    "*** Update File: /w/src/a.ts", "@@ -1 +1 @@", "-x", "+y",
    "*** Add File: /w/src/new.ts", "+one", "+two",
    "*** Delete File: /w/src/old.ts",
    "*** End Patch",
  ].join("\n"));
  assert.equal(parts[2].error, undefined);
});

test("names what else a script did, and Codex's own agent and sleep tools", () => {
  const exec = (callId) => item({ type: "custom_tool_call", call_id: callId, name: "exec", input: "await tools.anything({})" });
  const done = (payload) => event({ type: "item_completed", item: payload });
  const call = (callId, name, args) => item({ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) });
  const turns = parseCodexTranscript(jsonl(
    exec("call_search"),
    done({ type: "Extension", kind: "web.search", query: "thin-edge software_update" }),
    item({ type: "custom_tool_call_output", call_id: "call_search", output: "Script completed" }),
    exec("call_view"),
    done({ type: "ImageView", path: "file:///tmp/home.png" }),
    item({ type: "custom_tool_call_output", call_id: "call_view", output: "Script completed" }),
    exec("call_image"),
    done({ type: "Extension", kind: "image_gen.generation", revisedPrompt: "an icon", result: "iVBORw0KGgo" }),
    item({ type: "custom_tool_call_output", call_id: "call_image", output: "Script completed" }),
    item({ type: "custom_tool_call", call_id: "call_sleep", name: "sleep", input: JSON.stringify({ duration_ms: 30000 }) }),
    call("call_spawn", "spawn_agent", { task_name: "ota_api_470", message: "gAAAAAB-encrypted" }),
    call("call_send", "send_message", { target: "/root/ota_api_470", message: "gAAAAAB-encrypted" }),
  ));
  assert.deepEqual(turns[0].parts.map((part) => part.summary), [
    "Search thin-edge software_update",
    "View /tmp/home.png",
    "Generate image: an icon",
    "30s",
    "ota_api_470",
    "/root/ota_api_470",
  ]);
  assert.ok(!JSON.stringify(turns).includes("iVBORw0KGgo"));
});

test("says whether a script only ran commands or only edited files, and names polls and other tools", () => {
  const exec = (callId, input) => item({ type: "custom_tool_call", call_id: callId, name: "exec", input });
  const out = (callId, output) => item({ type: "custom_tool_call_output", call_id: callId, output });
  const done = (payload) => event({ type: "item_completed", item: payload });
  const patch = "*** Begin Patch\\n*** Update File: /w/a.ts\\n@@\\n-x\\n+y\\n*** End Patch\\n";
  const turns = parseCodexTranscript(jsonl(
    exec("call_run", 'const r = await tools.exec_command({"cmd":"pnpm build","yield_time_ms":1000}); text(JSON.stringify(r));'),
    out("call_run", 'Script completed\nOutput:\n{"session_id":81418,"output":"building"}'),
    exec("call_poll", "const r = await tools.write_stdin({session_id:81418,chars:\"\"}); text(r);"),
    out("call_poll", "Script completed"),
    // a patch held in a variable: the files come from what Codex recorded it changing
    exec("call_edit", `const patch = "${patch}"; text(await tools.apply_patch(patch));`),
    done({ type: "FileChange", changes: { "/w/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-x\n+y\n" } }, status: "completed" }),
    out("call_edit", "Script completed"),
    exec("call_both", "const old = (await tools.exec_command({cmd: c})).output; await tools.apply_patch(p);"),
    done({ type: "CommandExecution", command: ["cat", "a"] }),
    done({ type: "FileChange", changes: { "/w/b.ts": { type: "add", content: "x" } } }),
    out("call_both", "Script completed"),
    exec("call_web", "const r = await tools.web__run({open: []}); const t = await tools.clock__curr_time({}); text(r);"),
  ));
  assert.deepEqual(turns[0].parts.map((part) => [part.summary, part.action]), [
    ["pnpm build", "command"],
    ["pnpm build", "command"],
    ["/w/a.ts", "edit"],
    ["cat a; /w/b.ts", undefined],
    ["web__run, clock__curr_time", undefined],
  ]);
});

test("a script's row is named in one line of at most 120 characters", () => {
  const long = `npm run build -- ${"--flag ".repeat(40)}`;
  const turns = parseCodexTranscript(jsonl(
    item({ type: "custom_tool_call", call_id: "call_long", name: "exec", input: "await tools.anything({})" }),
    event({ type: "item_completed", item: { type: "CommandExecution", command: ["/bin/bash", "-lc", long] } }),
    event({ type: "item_completed", item: { type: "CommandExecution", command: ["/bin/bash", "-lc", "git\n status"] } }),
  ));
  const summary = turns[0].parts[0].summary;
  assert.equal(summary.length, 120);
  assert.ok(summary.startsWith("npm run build -- --flag --flag"));
  assert.ok(!summary.includes("\n"));
});

test("an exec script's commands are named only when one call is waiting", () => {
  const exec = (callId) => item({ type: "custom_tool_call", call_id: callId, name: "exec", input: "await tools.exec_command({cmd: x})" });
  const turns = parseCodexTranscript(jsonl(
    exec("call_a"),
    exec("call_b"),
    event({ type: "item_completed", item: { type: "CommandExecution", command: ["ls"] } }),
  ));
  // nothing names either call but the tool its script calls
  assert.deepEqual(turns[0].parts.map((part) => part.summary), ["exec_command", "exec_command"]);
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

test("finds the whole output of a command no call took by the id Codex recorded it under", async (context) => {
  forgetConversationState();
  const home = await temp(context);
  const big = "z".repeat(50_000);
  const path = await rolloutIn(home, THREAD, jsonl(meta(), ...task(1),
    event({ type: "item_completed", item: { type: "CommandExecution", id: "exec-big", command: ["make"], aggregated_output: big, exit_code: 0 } }),
    ...task(2)));
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  assert.deepEqual(await transcriptToolOutput(CODEX_TRANSCRIPT, store, path, "exec-big"), { output: big, size: big.length });
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

test("a thread not written yet is looked for in the newest day folders only, for a while", async (context) => {
  forgetCodexState();
  const home = await temp(context);
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  for (const day of ["01", "02", "03"]) await rolloutIn(home, OTHER, undefined, ["2026", "10", day]);
  assert.equal(await locateCodexRollout(store, { session: { kind: "id", value: THREAD } }), null);
  // written in an old day folder meanwhile: not scanned for again yet
  await rolloutIn(home, THREAD, undefined, ["2026", "10", "01"]);
  assert.equal(await locateCodexRollout(store, { session: { kind: "id", value: THREAD } }), null);
  // a new rollout lands in the newest day: found at once
  const path = await rolloutIn(home, THREAD, undefined, ["2026", "10", "03"]);
  assert.equal(await locateCodexRollout(store, { session: { kind: "id", value: THREAD } }), path);
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

test("the rollout the pane's Codex holds open wins over a reported path left behind by a /fork", async (context) => {
  if (process.platform !== "linux") { context.skip("reads /proc"); return; }
  forgetCodexState();
  const home = await temp(context);
  const store = localTranscriptStore({ configDir: join(home, "claude"), codexHome: home });
  const stale = await rolloutIn(home);
  const forked = await rolloutIn(home, OTHER);
  const handle = await open(forked, "r");
  context.after(() => handle.close());
  assert.equal(await locateCodexRollout(store, { pids: [process.pid], session: { kind: "path", value: stale } }), forked);
  assert.equal(await locateCodexRollout(store, { pids: [], session: { kind: "path", value: stale } }), stale);
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
  // only what follows the screen's last Codex header counts: an answer an earlier
  // run left above a restart or /new is no evidence of the conversation shown now
  assert.equal(matchCodexTranscript(`>_ OpenAI Codex (v0.160.1)\n• ${answer}\n>_ OpenAI Codex (v0.162.1)\n› Ask Codex to do anything\n`, candidates), null);
  assert.equal(matchCodexTranscript(`>_ OpenAI Codex (v0.160.1)\n>_ OpenAI Codex (v0.162.1)\n• ${answer}\n`, candidates), "correct");

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
  await assert.rejects(service.page("w1:p4"), (error) => error.code === "conversation_unavailable" && error.reason === "not_supported_agent");
  // nothing names the pane's thread yet (or only another agent's): an empty chat, never another rollout
  for (const pane of ["w1:p3", "w1:p5"]) {
    const pending = await service.page(pane);
    assert.deepEqual([pending.turns, pending.cursor, pending.history_id], [[], null, "pending"], pane);
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

test("two Codex panes in one directory with no session named each get their own rollout", async (context) => {
  if (process.platform !== "linux") { context.skip("reads /proc"); return; }
  forgetConversationState();
  forgetCodexState();
  const home = await temp(context);
  const first = await rolloutIn(home, THREAD, jsonl(meta({ id: THREAD }), ...task(1)));
  const second = await rolloutIn(home, OTHER, jsonl(meta({ id: OTHER }), ...task(2)));
  const handles = { "w1:p1": await open(first, "r"), "w1:p2": await open(second, "r") };
  context.after(() => Promise.all(Object.values(handles).map((handle) => handle.close())));
  // each pane's process holds only its own file open: a helper process per pane
  const { spawn } = await import("node:child_process");
  const holders = {};
  for (const [paneId, path] of [["w1:p1", first], ["w1:p2", second]]) {
    const child = spawn(process.execPath, ["-e", `require("fs").openSync(${JSON.stringify(path)}, "r"); setInterval(() => {}, 1000)`], { stdio: "ignore" });
    holders[paneId] = child;
    context.after(() => child.kill());
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const service = codexService(home, [
    { pane_id: "w1:p1", agent: "codex", cwd: "/work/app" },
    { pane_id: "w1:p2", agent: "codex", cwd: "/work/app" },
  ], {
    async paneProcessInfo(paneId) {
      return { process_info: { foreground_processes: [{ pid: holders[paneId].pid, argv: ["/usr/bin/codex"] }] } };
    },
  });
  assert.deepEqual(texts((await service.page("w1:p1")).turns), ["prompt 1", "answer 1"]);
  assert.deepEqual(texts((await service.page("w1:p2")).turns), ["prompt 2", "answer 2"], "not the first pane's conversation");
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

// Codex's TUI titles its own pane "<thread name> | <folder>" (a spinner first
// while it works). The title comes from the pane itself, so it tells the
// pane's thread even where herdr's report is missing or names another pane's
// (Codex 0.157+ runs hooks in a shared daemon: herdrdev/herdr#4649).
test("reads the thread name a Codex pane's title shows, and nothing from a title that names none", () => {
  const cwd = "/work/app";
  assert.equal(codexTitleThreadName("Write about owls | app", cwd), "Write about owls");
  assert.equal(codexTitleThreadName("⠸ Write about owls | app", cwd), "Write about owls");
  // a name may hold the separator itself: the folder is the last part
  assert.equal(codexTitleThreadName("A | B | app", cwd), "A | B");
  // the folder may be the repository the pane works in, above its folder
  assert.equal(codexTitleThreadName("Fix the build | work", "/work/app/sub"), "Fix the build");
  // before the first answer the title names no thread
  assert.equal(codexTitleThreadName("app", cwd), null);
  assert.equal(codexTitleThreadName("⠦ | app", cwd), null);
  assert.equal(codexTitleThreadName("⠙ ⠙ | app", cwd), null);
  // a title for another folder, or one set by the user, is not Codex's
  assert.equal(codexTitleThreadName("Write about owls | elsewhere", cwd), null);
  assert.equal(codexTitleThreadName("", cwd), null);
  assert.equal(codexTitleThreadName(null, cwd), null);
  assert.equal(codexTitleThreadName("Write about owls | app", null), null);
  // a name with control characters is no name Codex gave
  assert.equal(codexTitleThreadName("Owls\u0000x | app", cwd), null);
  assert.equal(codexTitleThreadName("Owls\u001b[31m | app", cwd), null);
});

test("a Codex pane's thread is the one its title names, before a report herdr may have bound from another pane", async (context) => {
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { context.skip("node:sqlite is not available"); return; }
  forgetConversationState();
  forgetCodexState();
  const home = await temp(context);
  const owls = await rolloutIn(home, THREAD, jsonl(meta(), message("user", "owls"), message("assistant", "Owls hunt at night.", "final_answer")));
  const bears = await rolloutIn(home, OTHER, jsonl(meta({ id: OTHER }), message("user", "bears"), message("assistant", "Bears sleep in winter.", "final_answer")));
  const twinA = "019da5c2-0000-7000-8000-00000000000a";
  const twinB = "019da5c2-0000-7000-8000-00000000000b";
  const first = await rolloutIn(home, twinA, jsonl(meta({ id: twinA }), message("user", "a"), message("assistant", "One.", "final_answer")));
  const second = await rolloutIn(home, twinB, jsonl(meta({ id: twinB }), message("user", "b"), message("assistant", "Two.", "final_answer")));
  const db = new sqlite.DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, source TEXT, name TEXT, updated_at INTEGER)");
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, '/work/app', 0, NULL, 'vscode', ?, ?)");
  insert.run(THREAD, owls, "Write about owls", 1);
  insert.run(OTHER, bears, "Describe bears", 2);
  insert.run(twinA, first, "Same name", 3);
  insert.run(twinB, second, "Same name", 4);
  db.close();
  const pane = (id, title, extra = {}) => ({ pane_id: id, agent: "codex", cwd: "/work/app", terminal_title: title, terminal_title_stripped: title, ...extra });
  const service = codexService(home, [
    // herdr bound the bears thread here, from the pane that started the daemon
    pane("w1:p1", "⠸ Write about owls | app", { agent_session: { agent: "codex", kind: "id", value: OTHER } }),
    pane("w1:p2", "app"),
    pane("w1:p3", "Same name | app"),
    pane("w1:p4", "Same name | app", { agent_session: { agent: "codex", kind: "id", value: twinB } }),
  ]);
  assert.deepEqual(texts((await service.page("w1:p1")).turns), ["owls", "Owls hunt at night."]);
  // a Codex with no thread yet: an empty chat, never the folder's last thread
  assert.equal((await service.page("w1:p2")).history_id, "pending");
  // two threads of that name: the title decides nothing, and the rest of the lookup does
  assert.equal((await service.page("w1:p3")).history_id, "pending");
  assert.deepEqual(texts((await service.page("w1:p4")).turns), ["b", "Two."]);
});
