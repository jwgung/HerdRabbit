// Antigravity CLI ("agy") writes a step ledger to
// ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl.
// Each line is one step; payload.type names it. Unlike Kiro, agy gives tool
// calls and their results no shared id, so a GENERIC result is tied to the
// call before it by order. These tests pin that ordering and the record
// shapes, mirroring test/conversation-kiro.test.mjs.
//
// Record shapes adapted from ovis (MIT, Copyright (c) 2026 devswha),
// server/agy.ts and server/agy.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGY_TRANSCRIPT,
  agyStoreFromLocks,
  agyUserText,
  localAgyStore,
  parseAgyMetadata,
  parseAgyTranscript,
} from "../src/conversation/agy.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { ConversationUnavailable } from "../src/conversation/pages.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";

let step = 0;
const rec = (payload) => JSON.stringify({ step_index: step++, status: "DONE", created_at: "2026-10-16T20:56:34Z", ...payload });
const jsonl = (lines) => `${lines.join("\n")}\n`;
const userInput = (content) => rec({ source: "USER_EXPLICIT", type: "USER_INPUT", content });
const planner = (fields) => rec({ source: "MODEL", type: "PLANNER_RESPONSE", ...fields });
const generic = (content) => rec({ source: "MODEL", type: "GENERIC", content });
const texts = (turns) => turns.map((turn) => turn.parts.map((p) => p.text ?? `[${p.kind}:${p.name ?? ""}]`).join(" | "));

test("a USER_INPUT opens a user turn, its request unwrapped from the envelope", () => {
  const turns = parseAgyTranscript(jsonl([
    userInput("<USER_REQUEST>\nfix the build\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>"),
  ]));
  assert.deepEqual(turns, [{ role: "user", ts: "2026-10-16T20:56:34Z", parts: [{ kind: "text", text: "fix the build" }] }]);
});

test("a plain request with no envelope is kept as it is", () => {
  assert.equal(agyUserText("just do it"), "just do it");
  assert.equal(agyUserText("<USER_REQUEST>\nhi\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"), "hi");
  // an unknown envelope after the request is left whole rather than guessed at
  assert.equal(agyUserText("<USER_REQUEST>\nhi\n</USER_REQUEST>\ntrailing"), "<USER_REQUEST>\nhi\n</USER_REQUEST>\ntrailing");
});

test("a PLANNER_RESPONSE carries text, thinking and tool calls in order", () => {
  const turns = parseAgyTranscript(jsonl([
    userInput("go"),
    planner({ thinking: "let me look", content: "Checking the workflow.", tool_calls: [
      { name: "run_command", args: { CommandLine: "ls .github", Cwd: "/w", toolSummary: "list" } },
    ] }),
  ]));
  assert.equal(turns.length, 2);
  const parts = turns[1].parts;
  assert.deepEqual(parts.map((p) => p.kind), ["thinking", "text", "tool"]);
  assert.equal(parts[0].text, "let me look");
  assert.equal(parts[1].text, "Checking the workflow.");
  assert.equal(parts[2].name, "run_command");
  assert.equal(parts[2].summary, "ls .github");
});

test("a GENERIC result fills the output of the tool call before it, by order", () => {
  const turns = parseAgyTranscript(jsonl([
    userInput("go"),
    planner({ tool_calls: [
      { name: "run_command", args: { CommandLine: "echo one" } },
      { name: "view_file", args: { AbsolutePath: "/w/a.txt" } },
    ] }),
    generic("one"),
    generic("file body"),
  ]));
  const tools = turns[1].parts.filter((p) => p.kind === "tool");
  assert.equal(tools[0].output, "one");
  assert.equal(tools[1].output, "file body");
  // the view_file call is summarised by its path
  assert.equal(tools[1].summary, "/w/a.txt");
});

test("more results than open calls, or fewer, do not throw and leave extras out", () => {
  const turns = parseAgyTranscript(jsonl([
    userInput("go"),
    planner({ tool_calls: [{ name: "run_command", args: { CommandLine: "x" } }] }),
    generic("result"),
    generic("orphan result with no call"),
  ]));
  const tools = turns[1].parts.filter((p) => p.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].output, "result");
});

test("steps that are not DONE are skipped", () => {
  const turns = parseAgyTranscript(jsonl([
    userInput("go"),
    JSON.stringify({ step_index: 99, status: "RUNNING", type: "PLANNER_RESPONSE", source: "MODEL", content: "half-written" }),
  ]));
  assert.deepEqual(texts(turns), ["go"]);
});

test("ERROR_MESSAGE, SYSTEM_MESSAGE and CHECKPOINT carry no turn text", () => {
  const turns = parseAgyTranscript(jsonl([
    userInput("go"),
    rec({ source: "SYSTEM", type: "ERROR_MESSAGE", error: "boom" }),
    rec({ source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "note" }),
    rec({ source: "SYSTEM", type: "CHECKPOINT", content: "cp" }),
  ]));
  assert.deepEqual(texts(turns), ["go"]);
});

test("consecutive planner/generic steps merge into one assistant turn", () => {
  const turns = parseAgyTranscript(jsonl([
    userInput("go"),
    planner({ content: "first" }),
    planner({ content: "second", tool_calls: [{ name: "run_command", args: { CommandLine: "x" } }] }),
    generic("out"),
  ]));
  assert.equal(turns.length, 2);
  assert.equal(turns[1].role, "assistant");
});

test("metadata reads nothing fatal from an empty or odd transcript", () => {
  assert.deepEqual(parseAgyMetadata(""), { model: null, reasoning_effort: null });
  assert.equal(AGY_TRANSCRIPT.source, "agy-transcript");
});

test("turnStarts marks each USER_INPUT DONE line", () => {
  const text = jsonl([userInput("a"), planner({ content: "x" }), userInput("b")]);
  const starts = AGY_TRANSCRIPT.turnStarts(Buffer.from(text));
  assert.equal(starts.length, 2);
});

// A real agy session on this machine, when present: the parser must not throw
// and must produce turns with the expected roles. Skipped where agy has never
// run (CI, a fresh machine).
test("parses a real agy transcript without throwing", async (context) => {
  const { readFile, access } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(homedir(), ".gemini/antigravity-cli/brain",
    "ec36e9be-42a3-407e-b586-8ddb11fa0374/.system_generated/logs/transcript_full.jsonl");
  try {
    await access(file);
  } catch {
    context.skip("no local agy session");
    return;
  }
  const turns = parseAgyTranscript(await readFile(file, "utf8"));
  assert.ok(turns.length > 0, "a non-empty session yields turns");
  assert.ok(turns.every((turn) => turn.role === "user" || turn.role === "assistant"));
  assert.ok(turns.every((turn) => turn.parts.length > 0));
  // the conversation opens with the person's first prompt
  assert.equal(turns[0].role, "user");
});

// ---------------------------------------------------------------------------
// The store: a session is found by the presence lock the pane's agy process
// holds, and its transcript is read from the brain directory beside it.

const UUID = "ec36e9be-42a3-407e-b586-8ddb11fa0374";

test("derives the session and transcript path from a single presence lock", () => {
  const root = "/home/me/.gemini/antigravity-cli";
  const store = agyStoreFromLocks([
    "/home/me/.gemini/antigravity-cli/presence/" + UUID + ".lock",
  ]);
  assert.equal(store.session, UUID);
  assert.equal(store.path, root + "/brain/" + UUID + "/.system_generated/logs/transcript_full.jsonl");
});

test("non-lock paths are ignored; exactly one lock must remain", () => {
  const lock = "/r/presence/" + UUID + ".lock";
  // other open files the process holds are not locks
  assert.ok(agyStoreFromLocks(["/r/presence/" + UUID + ".lock", "/etc/hosts", "/r/brain/x/log"]));
  // no lock at all, or more than one, is not a usable session
  assert.equal(agyStoreFromLocks(["/etc/hosts"]), null);
  assert.equal(agyStoreFromLocks([
    "/r/presence/" + UUID + ".lock",
    "/r/presence/11111111-1111-4111-8111-111111111111.lock",
  ]), null);
  // a path shaped like a lock but not under presence/ does not count
  assert.equal(agyStoreFromLocks(["/r/brain/" + UUID + ".lock"]), null);
  assert.ok(lock);
});

test("the store reads a transcript the brain directory holds", async (context) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "herdrabbit-agy-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const logs = join(dir, "brain", UUID, ".system_generated", "logs");
  await mkdir(logs, { recursive: true });
  const path = join(logs, "transcript_full.jsonl");
  const body = jsonl([userInput("hi"), planner({ content: "hello" })]);
  await writeFile(path, body);

  const store = localAgyStore(dir);
  const info = await store.stat(path);
  assert.ok(info && info.size === Buffer.byteLength(body));
  const bytes = await store.read(path, 0, info.size);
  assert.equal(bytes.toString("utf8"), body);
  // a file that is not there is a miss, not a throw
  assert.equal(await store.stat(join(logs, "missing.jsonl")), null);
});

// ---------------------------------------------------------------------------
// The conversation service routes an agy pane to the agy resolver.

test("an agy pane is routed to the agy resolver, not refused as unsupported", async () => {
  const pane = { pane_id: "w1:p1", agent: "agy", cwd: "/work/app" };
  const herdr = {
    async snapshot() { return { panes: [pane] }; },
    // the pane runs agy, but with no reachable presence lock the session is not found
    async paneProcessInfo() { return { process_info: { foreground_processes: [{ pid: 999999, name: "agy" }] } }; },
  };
  const service = new ConversationService({ herdr });
  // reaching #resolveAgy (not "not_supported_agent") proves the route is wired;
  // with no lock the reason is "no_session_id", never "not_supported_agent"
  await assert.rejects(
    service.resolve("w1:p1"),
    (error) => error instanceof ConversationUnavailable && error.reason === "no_session_id",
  );
});

test("a pane whose agent has no reader is still refused as unsupported", async () => {
  const pane = { pane_id: "w1:p1", agent: "gemini", cwd: "/work/app" };
  const herdr = { async snapshot() { return { panes: [pane] }; } };
  const service = new ConversationService({ herdr });
  await assert.rejects(
    service.resolve("w1:p1"),
    (error) => error instanceof ConversationUnavailable && error.reason === "not_supported_agent",
  );
});
