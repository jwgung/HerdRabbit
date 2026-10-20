import test from "node:test";
import assert from "node:assert/strict";
import { lineDiff } from "../public/chat/diff.js";
import { parseClaudeTranscript } from "../src/conversation/claude.mjs";
import {
  commandText,
  deliveredFiles,
  formatWorkDuration,
  MAX_DELIVERED_FILES,
  isLiveWorkTurn,
  splitDeliveredPath,
  splitTurn,
  todoCallSummary,
  todoItems,
  toolVerb,
  workFailed,
  workStartsOpen,
  workSummary,
  workTitle,
} from "../public/chat/work-blocks.js";

const text = (value) => ({ kind: "text", text: value });
const tool = (name, input, extra = {}) => ({ kind: "tool", id: `t_${name}`, name, summary: Object.values(input)[0] ?? name, input: JSON.stringify(input, null, 2), output: "", ...extra });

test("a line diff keeps unchanged lines once and the changes in place", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nB\nc\nd"), [
    { kind: "same", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "B" },
    { kind: "same", text: "c" },
    { kind: "add", text: "d" },
  ]);
  assert.deepEqual(lineDiff("", "new"), [{ kind: "add", text: "new" }]);
  assert.deepEqual(lineDiff("old", ""), [{ kind: "del", text: "old" }]);
  // too large to compare line by line: all removed, then all added
  const big = Array.from({ length: 600 }, (_, n) => `${n}`).join("\n");
  const diff = lineDiff(big, `${big}x`);
  assert.equal(diff.length, 1200);
  assert.equal(diff[0].kind, "del");
  assert.equal(diff.at(-1).kind, "add");
});

test("a turn splits into its work and the answer after the last action", () => {
  const parts = [text("Looking."), { kind: "thinking", text: "hmm" }, tool("Bash", { command: "ls" }), text("Done: two files.")];
  const { work, answer } = splitTurn(parts);
  assert.deepEqual(work, parts.slice(0, 3));
  assert.deepEqual(answer, [parts[3]]);
  // words with no action after them are all answer; blank text is neither
  assert.deepEqual(splitTurn([text("only words"), text("  ")]), { work: [], answer: [text("only words")] });
  // the block opens while the turn runs, and when the last words are inside it
  assert.equal(workStartsOpen(true, parts), true);
  assert.equal(workStartsOpen(false, parts), false);
  assert.equal(workStartsOpen(false, [tool("Bash", { command: "ls" }), text("then"), tool("Read", { file_path: "a" })]), true);
});

test("the work header counts by kind, leaves todos out, and counts failures apart", () => {
  const parts = [
    tool("Edit", { file_path: "a" }), tool("Write", { file_path: "b" }), tool("Read", { file_path: "c" }),
    tool("Bash", { command: "x" }, { error: true }), tool("WebFetch", { url: "u" }), tool("TodoWrite", { todos: [] }),
  ];
  assert.equal(workSummary(parts), "2 edits · 1 file read · 1 command · 1 other tool");
  assert.equal(workFailed(parts), 1);
  assert.equal(workSummary([tool("Bash", { command: "x" })]), "1 command");
});

test("durations and titles", () => {
  assert.equal(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:07Z"), "7s");
  assert.equal(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:12Z"), "1m 12s");
  assert.equal(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:02:00Z"), "2m");
  assert.equal(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T02:05:00Z"), "2h 5m");
  assert.equal(formatWorkDuration(null, "2026-01-01T00:00:00Z"), null);
  assert.equal(formatWorkDuration("2026-01-01T00:00:09Z", "2026-01-01T00:00:00Z"), null);
  const agent = { role: "assistant", parts: [] };
  assert.equal(isLiveWorkTurn(agent, true, "working"), true);
  assert.equal(isLiveWorkTurn(agent, false, "working"), false);
  assert.equal(isLiveWorkTurn(agent, true, "done"), false);
  assert.equal(isLiveWorkTurn({ role: "user", parts: [] }, true, "working"), false);
  assert.equal(workTitle({ live: true, status: "blocked", duration: "3s" }), "Needs you");
  assert.equal(workTitle({ live: true, status: "working", duration: "3s" }), "Working…");
  assert.equal(workTitle({ live: false, status: "done", duration: "3s" }), "Worked for 3s");
  assert.equal(workTitle({ live: false, status: "done", duration: null }), "Worked");
});

test("a known tool reads as a verb when its summary is the call's own command or path", () => {
  assert.equal(toolVerb(tool("Bash", { command: "npm test" })), "Ran");
  assert.equal(toolVerb(tool("Read", { file_path: "/a/b.ts" })), "Read");
  assert.equal(toolVerb(tool("Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y" })), "Edited");
  assert.equal(toolVerb(tool("Write", { file_path: "/a/b.ts", content: "x" })), "Wrote");
  assert.equal(toolVerb(tool("Grep", { pattern: "x" })), null, "an unknown tool keeps its name");
  assert.equal(toolVerb({ ...tool("Bash", { command: "ls" }), summary: "List files" }), null, "a description is not the object");
  assert.equal(toolVerb({ ...tool("Bash", { command: "ls" }), input: "{cut" }), null);
});

test("Codex's commands and patches read as verbs too", () => {
  assert.equal(toolVerb(tool("exec_command", { cmd: "git status" })), "Ran");
  assert.equal(toolVerb({ ...tool("shell", { command: ["bash", "-lc", "npm test"] }), summary: "npm test" }), "Ran");
  assert.equal(toolVerb({ kind: "tool", name: "apply_patch", summary: "src/a.ts", input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }), "Edited");
  assert.equal(toolVerb({ kind: "tool", name: "apply_patch", summary: "x", input: "not a patch" }), null);
  assert.equal(commandText(["bash", "-lc", "make"]), "make");
  assert.equal(commandText(["ls", "-la"]), "ls -la");
  assert.equal(commandText([1]), undefined);
});

test("a TodoWrite call reads as its list", () => {
  const call = tool("TodoWrite", { todos: [
    { content: "plan", status: "completed" }, { content: "build", status: "in_progress" }, { content: "ship", status: "weird" }, { content: " " },
  ] });
  assert.deepEqual(todoItems(call.input), [
    { label: "plan", status: "completed" }, { label: "build", status: "in_progress" }, { label: "ship", status: "pending" },
  ]);
  assert.equal(todoCallSummary(call), "1/3 done");
  assert.equal(todoCallSummary(tool("Bash", { command: "x" })), null);
  assert.equal(todoItems("not json"), null);
});

test("an OpenCode todowrite call reads as its list too, a cancelled item as cancelled", () => {
  const call = tool("todowrite", { todos: [
    { content: "plan", status: "completed", priority: "high", id: "1" }, { content: "drop", status: "cancelled", priority: "low", id: "2" },
    { content: "build", status: "pending", priority: "medium", id: "3" },
  ] });
  assert.deepEqual(todoItems(call.input), [
    { label: "plan", status: "completed" }, { label: "drop", status: "cancelled" }, { label: "build", status: "pending" },
  ]);
  assert.equal(todoCallSummary(call), "1/3 done");
  assert.equal(workSummary([call, tool("bash", { command: "ls" })]), "1 command", "a todo list is no edit");
});

test("OpenCode's tools read with the verbs Claude's do, by the names the server gives their fields", () => {
  assert.equal(toolVerb({ ...tool("read", { file_path: "/a.js" }), summary: "/a.js" }), "Read");
  assert.equal(toolVerb({ ...tool("edit", { file_path: "/a.js", old_string: "a", new_string: "b" }), summary: "/a.js" }), "Edited");
  assert.equal(toolVerb({ ...tool("bash", { command: "npm test", description: "Run" }), summary: "npm test" }), "Ran");
  assert.equal(workSummary([tool("grep", { pattern: "x" }), tool("glob", { pattern: "*" }), tool("write", { file_path: "/b" })]), "1 edit · 2 file reads");
});

// A SendUserFile call as the server hands it over once its result is in.
const sent = (input, extra = {}) => {
  const count = Array.isArray(input.files) ? input.files.length : 1;
  const output = `${count} ${count === 1 ? "file" : "files"} delivered to user.`;
  return tool("SendUserFile", input, { summary: "SendUserFile", output, output_size: output.length, ...extra });
};
const APK = "/home/me/lifelog/app/build/outputs/apk/release/LoreLog-0.3.14.apk";

test("a SendUserFile call that handed its files over reads as the files and its caption", () => {
  const call = sent({ files: [APK], caption: "0.3.14 — **AEC**", status: "normal", display: "attach" });
  assert.deepEqual(deliveredFiles(call), { files: [APK], caption: "0.3.14 — **AEC**" });
  assert.deepEqual(deliveredFiles(sent({ files: [APK, "notes.md"] })), { files: [APK, "notes.md"], caption: null });
  assert.deepEqual(deliveredFiles(sent({ files: [APK], caption: "  " })).caption, null);
  assert.deepEqual(splitDeliveredPath(APK), { name: "LoreLog-0.3.14.apk", folder: "/home/me/lifelog/app/build/outputs/apk/release/" });
  assert.deepEqual(splitDeliveredPath("notes.md"), { name: "notes.md", folder: "" });
  assert.deepEqual(splitDeliveredPath("./out/build/"), { name: "build", folder: "./out/" });
});

test("a SendUserFile call the card cannot read keeps the tool row: running, failed, cut short or odd input", () => {
  assert.equal(deliveredFiles(tool("SendUserFile", { files: [APK] })), null, "still running: no result yet");
  assert.equal(deliveredFiles(sent({ files: [APK] }, { error: true })), null);
  assert.equal(deliveredFiles(sent({ files: [APK] }, { input_truncated: true })), null);
  assert.equal(deliveredFiles(sent({ files: APK })), null, "not a list");
  assert.equal(deliveredFiles(sent({ files: [] })), null);
  assert.equal(deliveredFiles(sent({ files: [APK, 3] })), null);
  assert.equal(deliveredFiles(sent({ files: [" "] })), null);
  assert.equal(deliveredFiles(sent({ files: ["a\nb.txt"] })), null);
  assert.equal(deliveredFiles(sent({ files: ["x".repeat(5000)] })), null);
  assert.equal(deliveredFiles(sent({ files: Array.from({ length: MAX_DELIVERED_FILES + 1 }, (_, n) => `/f/${n}.txt`) })), null);
  assert.notEqual(deliveredFiles(sent({ files: Array.from({ length: MAX_DELIVERED_FILES }, (_, n) => `/f/${n}.txt`) })), null);
  assert.equal(deliveredFiles({ ...sent({ files: [APK] }), input: "not json" }), null);
  assert.equal(deliveredFiles(sent({ files: [APK] }, { name: "Send" })), null, "only SendUserFile");
  // Claude Code marks no error when a file did not reach the user; its result says so
  for (const output of [
    "1 file could NOT be delivered to the user:\n  /tmp/big.apk (612 MiB): too large",
    "1 file NOT delivered to Remote Control (phone/web) viewers \u2014 only visible in the desktop app on this machine",
    "1 file reached only one of its viewers:\n  /tmp/big.apk",
    // wordings not known: a card only for a result that says the files went
    "1 file not delivered to user",
    "No files were delivered",
    "Upload failed",
    "",
    "Done.",
    "1 file delivered to user.\n1 file could NOT be delivered to the user:\n  /tmp/big.apk (612 MiB): too large",
  ]) assert.equal(deliveredFiles(sent({ files: [APK] }, { output, output_size: output.length })), null, output);
  // what Claude Code says when the files went, with the lines it adds after
  // a count other than the call's own files: some did not go
  assert.equal(deliveredFiles(sent({ files: [APK, "/b"] }, { output: "1 file delivered to user.", output_size: 25 })), null);
  assert.equal(deliveredFiles(sent({ files: [APK] }, { output: "2 files delivered to user.", output_size: 26 })), null);
  assert.notEqual(deliveredFiles(sent({ files: [APK, "/b"] }, { output: "2 files delivered to the user.\n  /a → file_uuid: 1\n  /b → file_uuid: 2", output_size: 60 })), null);
  for (const output of ["1 file delivered to user.",
    "1 file delivered to user.\n  /home/me/failed-error-not-delivered.log → file_uuid: 366a-9b"]) {
    assert.notEqual(deliveredFiles(sent({ files: [APK] }, { output, output_size: output.length })), null, output);
  }
  // a result too long for the page to carry whole cannot say it went
  assert.equal(deliveredFiles(sent({ files: [APK] }, { output_truncated: true, output_size: 9000 })), null);
});

test("delivered files stay out of the folded work, in their place among the answer", () => {
  const delivery = sent({ files: [APK] });
  const build = tool("Bash", { command: "gradle build" });
  // sent last, after its words: both are the answer, in order
  let parts = [build, text("Here it is."), delivery];
  assert.deepEqual(splitTurn(parts), { work: [build], answer: [parts[1], delivery] });
  assert.equal(workStartsOpen(false, parts), false);
  // sent mid-way: out of the work all the same, ahead of the answer
  parts = [delivery, build, text("Done.")];
  assert.deepEqual(splitTurn(parts), { work: [build], answer: [delivery, parts[2]] });
  // only a delivery after the work's last words: those words stay in the work, which opens
  parts = [text("Building."), build, delivery];
  assert.deepEqual(splitTurn(parts), { work: [parts[0], build], answer: [delivery] });
  assert.equal(workStartsOpen(false, parts), true);
  // one still running is an ordinary tool row in the work
  const running = tool("SendUserFile", { files: [APK] });
  assert.deepEqual(splitTurn([build, running]), { work: [build, running], answer: [] });
});

test("a SendUserFile call read from a Claude transcript is delivered once its result is in", () => {
  const line = (entry) => JSON.stringify(entry);
  const call = { type: "assistant", timestamp: "2026-10-01T09:00:00Z", message: { role: "assistant", stop_reason: "tool_use", content: [
    { type: "tool_use", id: "toolu_send", name: "SendUserFile", input: { files: [APK], caption: "0.3.14", status: "normal", display: "attach" } },
  ] } };
  const result = { type: "user", timestamp: "2026-10-01T09:00:01Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_send", content: `1 file delivered to user.\n  ${APK} → file_uuid: 366a` },
  ] } };
  const running = parseClaudeTranscript(`${line(call)}\n`)[0].parts[0];
  assert.equal(deliveredFiles(running), null);
  const done = parseClaudeTranscript(`${line(call)}\n${line(result)}\n`)[0].parts[0];
  assert.deepEqual(deliveredFiles(done), { files: [APK], caption: "0.3.14" });
});
