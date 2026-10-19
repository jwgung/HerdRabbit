import test from "node:test";
import assert from "node:assert/strict";
import { claudeInputBox, restoredDraftStep } from "../src/prompt/claude-input.mjs";
import { HerdrClient } from "../src/herdr-client.mjs";

// Claude Code's screen after a Stop, as `pane read --format text` gives it:
// the box framed by a rule named after the session and a plain one, the mode
// line under it. `rows` are the box's rows as drawn (the first after "❯ ").
const WIDTH = 76;
function claudeScreen(rows, { name = "adopt-herdr-web-ui-features", above = "⏺ 1번부터 시작할까요?" } = {}) {
  const [first = "", ...rest] = rows;
  return [
    above,
    "",
    "  ⎿  Interrupted · What should Claude do instead?",
    "",
    `${"─".repeat(WIDTH - name.length - 3)} ${name} ─`,
    `❯ ${first}`.trimEnd(),
    ...rest.map((row) => `  ${row}`),
    "─".repeat(WIDTH),
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
    "",
  ].join("\n");
}

test("reads what Claude's input box holds, and nothing when the screen has no box", () => {
  assert.deepEqual(claudeInputBox(claudeScreen(["ㄱㄱㄱㄲ"])), { text: "ㄱㄱㄱㄲ", rows: 1 });
  assert.deepEqual(claudeInputBox(claudeScreen([""])), { text: "", rows: 1 });
  assert.deepEqual(claudeInputBox(claudeScreen(["first line", "second line"])), { text: "first line\nsecond line", rows: 2 });
  // escapes as an ANSI read keeps them
  assert.equal(claudeInputBox(`\u001b[2m${"─".repeat(40)}\u001b[0m\n\u001b[1m❯\u001b[0m hello\n${"─".repeat(40)}\n`)?.text, "hello");
  // a menu's cursor row is no input box: no rule right above it
  assert.equal(claudeInputBox("Do you want to proceed?\n❯ 1. Yes\n  2. No\n"), null);
  // a box cut off at the bottom of the read is not trusted
  assert.equal(claudeInputBox(`${"─".repeat(40)}\n❯ hello\n`), null);
  assert.equal(claudeInputBox("$ ls\nREADME.md\n$ "), null);
  // a past prompt echoed in the output above the box is not the box
  assert.equal(claudeInputBox(`❯ an old prompt\n⏺ answer\n${claudeScreen([""])}`)?.text, "");
});

test("only the stopped message itself is cleared, never text typed in the terminal", () => {
  const box = (rows) => claudeInputBox(claudeScreen(rows));
  assert.deepEqual(restoredDraftStep(box(["ㄱㄱㄱㄲ"]), "ㄱㄱㄱㄲ"), { keys: ["ctrl+k", "ctrl+u"] });
  // a long message wraps in the box: the same words
  assert.deepEqual(restoredDraftStep(box(["run the tests and then", "fix the lint"]), "run the tests and then fix the lint"),
    { keys: ["ctrl+k", "ctrl+u"] });
  // an empty box, another text, more than the message, or no box: send as it is
  assert.deepEqual(restoredDraftStep(box([""]), "ㄱㄱㄱㄲ"), { done: true });
  assert.deepEqual(restoredDraftStep(box(["my own note"]), "ㄱㄱㄱㄲ"), { done: true });
  assert.deepEqual(restoredDraftStep(box(["ㄱㄱㄱㄲ and more"]), "ㄱㄱㄱㄲ"), { done: true });
  assert.deepEqual(restoredDraftStep(null, "ㄱㄱㄱㄲ"), { done: true });
  // after the keys: emptied, or a shorter piece of its start left (a row above)
  const first = box(["line one", "line two"]);
  assert.deepEqual(restoredDraftStep(box([""]), "line one\nline two", first), { done: true });
  assert.deepEqual(restoredDraftStep(box(["line one", ""]), "line one\nline two", first), { keys: ["backspace", "ctrl+u"] });
  // the keys changed nothing: refuse rather than run the two together
  assert.deepEqual(restoredDraftStep(first, "line one\nline two", first), { stuck: true });
  // what is left is not the message's start (something else changed it): refuse
  assert.deepEqual(restoredDraftStep(box(["typed"]), "line one\nline two", first), { stuck: true });
});

// A Claude pane as the client sees it through herdr: what its box holds, the
// keys that change it, and every command in order.
function claudePane(initial, { ctrlU = (rows) => [...rows.slice(0, -1), ""] } = {}) {
  const pane = { rows: [...initial], calls: [] };
  pane.runner = async (binary, commandArgs) => {
    const args = commandArgs.filter((arg) => !arg.startsWith("--session="));
    pane.calls.push(args);
    if (args[1] === "read") return { stdout: claudeScreen(pane.rows), stderr: "" };
    if (args[1] === "send-keys") {
      for (const key of args.slice(3)) {
        if (key === "ctrl+u") pane.rows = ctrlU(pane.rows);
        if (key === "backspace" && pane.rows.length > 1 && pane.rows.at(-1) === "") pane.rows = pane.rows.slice(0, -1);
        if (key === "esc" && pane.sent) pane.rows = [pane.sent];
      }
    }
    if (args[1] === "run") pane.sent = pane.rows.join("\n").replace(/^$/u, "") + args[3];
    return { stdout: "", stderr: "" };
  };
  return pane;
}
const commands = (pane) => pane.calls.map((args) => args[1] === "read" ? "read" : args.slice(1).join(" "));

test("after a Stop, the message Claude put back is cleared before the next one goes", async () => {
  const pane = claudePane([""]);
  const client = new HerdrClient({ runner: pane.runner, sleep: async () => {}, sessionName: "stopdraft-a" });
  await client.sendText("w1:p1", "ㄱㄱㄱㄲ", { submit: true });
  await client.sendKeys("w1:p1", ["esc"]);
  assert.deepEqual(pane.rows, ["ㄱㄱㄱㄲ"], "Claude put it back");
  await client.sendText("w1:p1", "잠깐, 먼저 메인에 어디까지 올라감 지금?", { submit: true });
  assert.equal(pane.sent, "잠깐, 먼저 메인에 어디까지 올라감 지금?", "Claude got the new message alone");
  assert.deepEqual(commands(pane), [
    "run w1:p1 ㄱㄱㄱㄲ", "send-keys w1:p1 esc",
    "read", "send-keys w1:p1 ctrl+k ctrl+u", "read",
    "run w1:p1 잠깐, 먼저 메인에 어디까지 올라감 지금?",
  ]);
});

test("without a Stop, or with the person's own text in the box, nothing is read or cleared", async () => {
  const pane = claudePane([""]);
  const client = new HerdrClient({ runner: pane.runner, sleep: async () => {}, sessionName: "stopdraft-b" });
  await client.sendText("w1:p1", "first", { submit: true });
  await client.sendText("w1:p1", "second", { submit: true });
  assert.deepEqual(commands(pane), ["run w1:p1 first", "run w1:p1 second"]);

  pane.calls.length = 0;
  await client.sendKeys("w1:p1", ["esc"]);
  pane.rows = ["my own words"]; // typed in the terminal meanwhile
  await client.sendText("w1:p1", "third", { submit: true });
  assert.deepEqual(commands(pane), ["send-keys w1:p1 esc", "read", "run w1:p1 third"]);

  // another key after the Esc changed the box: nothing is cleared for it
  pane.calls.length = 0;
  await client.sendKeys("w1:p1", ["esc"]);
  await client.sendKeys("w1:p1", ["left"]);
  await client.sendText("w1:p1", "fourth", { submit: true });
  assert.deepEqual(commands(pane), ["send-keys w1:p1 esc", "send-keys w1:p1 left", "run w1:p1 fourth"]);
});

test("a multi-line message put back is cleared row by row", async () => {
  const pane = claudePane([""]);
  const client = new HerdrClient({ runner: pane.runner, sleep: async () => {}, sessionName: "stopdraft-c" });
  await client.sendText("w1:p1", "line one\nline two", { submit: true });
  pane.rows = ["line one", "line two"];
  await client.sendKeys("w1:p1", ["esc"]);
  pane.rows = ["line one", "line two"];
  await client.sendText("w1:p1", "next", { submit: true });
  assert.equal(pane.sent, "next");
  assert.deepEqual(commands(pane).slice(2), [
    "read", "send-keys w1:p1 ctrl+k ctrl+u", "read", "send-keys w1:p1 backspace ctrl+u", "read", "run w1:p1 next",
  ]);
});

test("a box the keys cannot empty refuses the send, and the next send looks again", async () => {
  const pane = claudePane([""], { ctrlU: (rows) => rows });
  const client = new HerdrClient({ runner: pane.runner, sleep: async () => {}, sessionName: "stopdraft-d" });
  await client.sendText("w1:p1", "ㄱㄱㄱㄲ", { submit: true });
  await client.sendKeys("w1:p1", ["esc"]);
  await assert.rejects(client.sendText("w1:p1", "next", { submit: true }),
    (error) => error.code === "input_not_empty" && /input box/u.test(error.message));
  assert.ok(!commands(pane).includes("run w1:p1 next"), "nothing was typed after it");
  pane.calls.length = 0;
  pane.rows = [""]; // cleared in the terminal
  await client.sendText("w1:p1", "next", { submit: true });
  assert.deepEqual(commands(pane), ["read", "run w1:p1 next"]);
});

test("a screen that cannot be read after a Stop refuses the send: the stopped message may be there", async () => {
  const pane = claudePane([""]);
  const runner = async (binary, args) => {
    if (args.includes("read")) throw Object.assign(new Error("gone"), { stderr: "" });
    return pane.runner(binary, args);
  };
  const client = new HerdrClient({ runner, sleep: async () => {}, sessionName: "stopdraft-e" });
  await client.sendText("w1:p1", "one", { submit: true });
  await client.sendKeys("w1:p1", ["esc"]);
  await assert.rejects(client.sendText("w1:p1", "two", { submit: true }), (error) => error.code === "input_not_empty");
  assert.deepEqual(commands(pane).filter((item) => item !== "read"), ["run w1:p1 one", "send-keys w1:p1 esc"]);
});

// A real Claude Code 2.1 screen (captured in a test herdr session) right after
// a message was sent and stopped with Esc: the message is back in the box, and
// the prompt mark is followed by a no-break space (U+00A0), not a plain one.
const REAL_RESTORED = ["\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500", "\u276f\u00a0reply with only the word ok", "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500", "  \u23f5\u23f5 auto mode on (shift+tab to cycle)                                                  /rc"].join("\n");

test("a real screen with the stopped message put back is read and cleared", () => {
  assert.ok(REAL_RESTORED.includes("\u276f\u00a0reply"), "the fixture keeps Claude's no-break space");
  const box = claudeInputBox(REAL_RESTORED);
  assert.deepEqual(box, { text: "reply with only the word ok", rows: 1 });
  assert.deepEqual(restoredDraftStep(box, "reply with only the word ok"), { keys: ["ctrl+k", "ctrl+u"] });
});

test("a screen that cannot be read halfway through clearing refuses the send", () => {
  const before = { text: "long long long", rows: 2 };
  assert.deepEqual(restoredDraftStep(null, "long long long long", before), { stuck: true });
  // before any key, an unreadable screen just lets the message go as it would have
  assert.deepEqual(restoredDraftStep(null, "long long long long"), { done: true });
});

test("only a wrap's whitespace is forgiven when comparing the box with the stopped message", () => {
  const box = (rows) => claudeInputBox(claudeScreen(rows));
  const clear = { keys: ["ctrl+k", "ctrl+u"] };
  // typed in the terminal without the space: not the stopped message
  assert.deepEqual(restoredDraftStep(box(["helloworld"]), "hello world"), { done: true });
  assert.deepEqual(restoredDraftStep(box(["hello", "world"]), "hello world"), clear);
  // a word cut where the line ended
  assert.deepEqual(restoredDraftStep(box(["abcdef", "ghi"]), "abcdefghi"), clear);
  // a wrapped long text, rows split at spaces
  assert.deepEqual(restoredDraftStep(box(["run the tests and then", "fix the lint now"]), "run the tests and then fix the lint now"), clear);
  // a run of spaces is one space; a real newline looks like a wrap and is accepted
  assert.deepEqual(restoredDraftStep(box(["hello  world"]), "hello world"), clear);
  assert.deepEqual(restoredDraftStep(box(["hello", "world"]), "hello\nworld"), clear);
  // later looks: a prefix cut at a wrap, but not a squashed one
  const first = box(["hello", "world"]);
  assert.deepEqual(restoredDraftStep(box(["hello"]), "hello world", first), { keys: ["backspace", "ctrl+u"] });
  assert.deepEqual(restoredDraftStep(box(["helloworl"]), "hello world", first), { stuck: true });
});

test("a message put back over many rows is read whole and cleared to the end", async () => {
  // 60 rows of a long message wrapped on a narrow pane: more than a 40-line look would hold
  const rows = Array.from({ length: 60 }, (_, n) => `row${n} words words`);
  const pane = claudePane([""]);
  const client = new HerdrClient({ runner: pane.runner, sleep: async () => {}, sessionName: "stopdraft-long" });
  await client.sendText("w1:p1", rows.join(" "), { submit: true });
  await client.sendKeys("w1:p1", ["esc"]);
  pane.rows = [...rows];
  await client.sendText("w1:p1", "next", { submit: true });
  assert.equal(pane.sent, "next");
  const read = pane.calls.find((args) => args[1] === "read");
  const lines = Number(read[read.indexOf("--lines") + 1]);
  assert.ok(lines >= 400, `the look read only ${lines} lines`);
  assert.ok(commands(pane).includes("run w1:p1 next"));
});

// Real Claude Code 2.1 boxes read with their styles (pane read --format ansi):
// empty with its dim tip, and a long message wrapped over rows.
const REAL_EMPTY_ANSI = ["\u001b[0m\u001b[38;5;7m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[0m", "\u276f\u00a0\u001b[0m\u001b[2mTry \"edit <filepath> to...\"\u001b[0m", "\u001b[0m\u001b[38;5;7m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[0m"].join("\n");
const REAL_WRAPPED_ANSI = ["\u001b[0m\u001b[38;5;7m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[0m", "\u276f\u00a0long long long long long long long long long long long long long long long long long long", "  long long long long long long long long long long long long long long long long long", "  long long long long long long long long long long long long long long long long long long", "  long long long long long long long end", "\u001b[0m\u001b[38;5;7m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[0m"].join("\n");

test("an empty box's dim tip reads as empty, typed words do not", () => {
  assert.deepEqual(claudeInputBox(REAL_EMPTY_ANSI), { text: "", rows: 1, empty: true });
  const wrapped = claudeInputBox(REAL_WRAPPED_ANSI);
  assert.equal(wrapped.empty, undefined);
  assert.ok(wrapped.rows > 1);
  // cleared to its tip halfway through: done
  assert.deepEqual(restoredDraftStep(claudeInputBox(REAL_EMPTY_ANSI), "long long", wrapped), { done: true });
});

test("halfway through clearing, words that are no piece of the stopped message refuse the send", () => {
  const before = { text: "hello world again", rows: 1 };
  assert.deepEqual(restoredDraftStep({ text: "something else", rows: 1 }, "hello world again", before), { stuck: true });
});

test("an Esc that did not go through is no Stop: the next send is not held up", async () => {
  const pane = claudePane([""]);
  let failEsc = true;
  const runner = async (binary, args) => {
    if (failEsc && args.includes("send-keys") && args.includes("esc")) {
      failEsc = false;
      throw Object.assign(new Error("timed out"), { stderr: "" });
    }
    return pane.runner(binary, args);
  };
  const client = new HerdrClient({ runner, sleep: async () => {}, sessionName: "stopdraft-esc-fail" });
  await client.sendText("w1:p1", "one", { submit: true });
  await assert.rejects(client.sendKeys("w1:p1", ["esc"]));
  await client.sendText("w1:p1", "two", { submit: true });
  assert.deepEqual(commands(pane), ["run w1:p1 one", "run w1:p1 two"], "the box was read or cleared after a failed Esc");
});

