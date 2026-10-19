import test from "node:test";
import assert from "node:assert/strict";
import { lineDiff } from "../public/chat/diff.js";
import {
  commandText,
  formatWorkDuration,
  isLiveWorkTurn,
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
