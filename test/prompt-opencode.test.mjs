// OpenCode's prompts, read off screens drawn from OpenCode 1.18.34's TUI
// source (see test/fixtures/opencode-prompt.mjs: source-derived, not captured).
import test from "node:test";
import assert from "node:assert/strict";
import { parseFallbackPrompt } from "../src/prompt/fallback.mjs";
import { fillOpencodeCard, parseOpencodePrompt, selectedButton, styledLine } from "../src/prompt/opencode.mjs";
import { answerSteps, publicCard } from "../src/prompt/screen.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import {
  fakeOpencodeHerdr,
  opencodeAlwaysScreen,
  opencodePermissionScreen,
  opencodeQuestionScreen,
  opencodeRejectScreen,
  opencodeReviewScreen,
} from "./fixtures/opencode-prompt.mjs";
import * as REAL from "./fixtures/opencode-dialog-screens.mjs";

const labels = (parsed) => parsed?.options.map((option) => option.label);
const keys = (steps) => steps.flatMap((step) => step.keys ?? [`text:${step.text}`]);
const plain = (screen) => screen.replace(/\u001b\[[0-9;]*m/gu, "");

// --- permissions ---------------------------------------------------------

test("reads a shell permission: its title, its command, its three buttons and the selected one", () => {
  const parsed = parseOpencodePrompt(opencodePermissionScreen());
  assert.equal(parsed.agent, "opencode");
  assert.equal(parsed.kind, "approval");
  assert.equal(parsed.title, "Permission required");
  assert.equal(parsed.question, "Shell command");
  assert.equal(parsed.body, "$ npm test");
  assert.deepEqual(labels(parsed), ["Allow once", "Allow always", "Reject"]);
  assert.equal(parsed.selectedIndex, 0);
  assert.equal(parseOpencodePrompt(opencodePermissionScreen({ selected: 2 })).selectedIndex, 2);
  assert.equal(publicCard(parsed).agent, "opencode");
});

test("the buttons are answered with ← and → from the selected one, then Enter; Reject is Esc wherever the selection is", () => {
  const first = parseOpencodePrompt(opencodePermissionScreen({ selected: 0 }));
  assert.deepEqual(keys(answerSteps(first, { option: 0 })), ["enter"]);
  assert.deepEqual(keys(answerSteps(first, { option: 1 })), ["right", "enter"]);
  assert.deepEqual(keys(answerSteps(first, { option: 2 })), ["esc"]);
  const last = parseOpencodePrompt(opencodePermissionScreen({ selected: 2 }));
  assert.deepEqual(keys(answerSteps(last, { option: 0 })), ["left", "left", "enter"]);
  assert.deepEqual(keys(answerSteps(last, { option: 1 })), ["left", "enter"]);
  assert.throws(() => answerSteps(first, { text: "no" }), /typed answer/u);
});

test("an edit's diff is the body, line for line", () => {
  const diff = ["1 - const answer = 41;", "1 + const answer = 42;", "2   export default answer;"];
  const parsed = parseOpencodePrompt(opencodePermissionScreen({ icon: "→", title: "Edit src/answer.js", body: diff, diff: true }));
  assert.equal(parsed.question, "Edit src/answer.js");
  assert.equal(parsed.body, diff.join("\n"));
});

test("an external folder's patterns are the body", () => {
  const parsed = parseOpencodePrompt(opencodePermissionScreen({
    icon: "←", title: "Access external directory ~/notes", body: ["Patterns", "", "- /home/me/notes/*", "- /home/me/notes"],
  }));
  assert.equal(parsed.question, "Access external directory ~/notes");
  assert.equal(parsed.body, "Patterns\n\n- /home/me/notes/*\n- /home/me/notes");
  // other tools' icons go too
  for (const [icon, title] of [["✱", 'Grep "TODO"'], ["%", "WebFetch https://example.com"], ["⚙", "Call tool mcp_lookup"], ["⟳", "Continue after repeated failures"]]) {
    assert.equal(parseOpencodePrompt(opencodePermissionScreen({ icon, title })).question, title);
  }
});

test("a pane under 80 columns puts the hints on their own row; the card is the same", () => {
  const wide = parseOpencodePrompt(opencodePermissionScreen());
  const narrow = parseOpencodePrompt(opencodePermissionScreen({ width: 70, selected: 1 }));
  assert.equal(narrow.id, wide.id, "where the selection is and how wide the pane is change nothing");
  assert.equal(narrow.selectedIndex, 1);
  assert.notEqual(parseOpencodePrompt(opencodePermissionScreen({ body: ["$ rm -rf build"] })).id, wide.id);
});

test("read without colours, the card shows but only Reject (Esc) answers: the selection cannot be seen", () => {
  const parsed = parseOpencodePrompt(opencodePermissionScreen({ ansi: false, selected: 1 }));
  assert.equal(parsed.selectedIndex, null);
  assert.equal(parsed.id, parseOpencodePrompt(opencodePermissionScreen()).id);
  assert.throws(() => answerSteps(parsed, { option: 0 }), /cannot be seen/u);
  assert.throws(() => answerSteps(parsed, { option: 1 }), /cannot be seen/u);
  assert.deepEqual(keys(answerSteps(parsed, { option: 2 })), ["esc"]);
});

test("the selected button is the one on the colour of △, and only when exactly one is; no guess from a background unlike the others", () => {
  const BUTTONS = ["Allow once", "Allow always", "Reject"];
  const screen = opencodePermissionScreen({ selected: 1 }).split("\n");
  const row = screen.find((line) => plain(line).includes("Allow once"));
  const header = screen.find((line) => plain(line).includes("Permission required"));
  assert.equal(selectedButton(row, BUTTONS, header), 1);
  // without the colour of △ to go by, the odd background out is no answer
  assert.equal(selectedButton(row, BUTTONS), null);
  assert.equal(selectedButton(row, BUTTONS, plain(header)), null);
  const reversed = "┃   \u001b[48;5;236m Allow once \u001b[0m \u001b[7m Allow always \u001b[27m \u001b[48;5;236m Reject \u001b[0m";
  assert.equal(selectedButton(reversed, BUTTONS, header), null);
  // two buttons on the warning colour: which is selected cannot be told
  const warning = "\u001b[48;2;245;167;66m";
  const twoMarked = `┃  ${warning} Allow once \u001b[0m ${warning} Allow always \u001b[0m \u001b[48;2;40;40;40m Reject \u001b[0m`;
  assert.equal(selectedButton(twoMarked, BUTTONS, header), null);
  assert.equal(selectedButton(plain(row), BUTTONS, header), null);
  const styled = styledLine("a\u001b[38;2;1;2;3mb\u001b[0mc");
  assert.equal(styled.text, "abc");
  assert.deepEqual(styled.fgs, ["", "#1,2,3", ""]);
});

test("Allow always's check: what it allows, Confirm with ←/→ and Enter, Cancel with Esc", () => {
  const one = parseOpencodePrompt(opencodeAlwaysScreen());
  assert.equal(one.title, "Always allow");
  assert.equal(one.question, "This will allow bash until OpenCode is restarted.");
  assert.equal(one.body, null);
  assert.deepEqual(labels(one), ["Confirm", "Cancel"]);
  assert.deepEqual(keys(answerSteps(one, { option: 0 })), ["enter"]);
  assert.deepEqual(keys(answerSteps(one, { option: 1 })), ["esc"]);
  const patterns = parseOpencodePrompt(opencodeAlwaysScreen({ patterns: ["npm *", "git status"], selected: 1 }));
  assert.equal(patterns.question, "This will allow the following patterns until OpenCode is restarted");
  assert.equal(patterns.body, "- npm *\n- git status");
  assert.equal(patterns.selectedIndex, 1);
  assert.deepEqual(keys(answerSteps(patterns, { option: 0 })), ["left", "enter"]);
});

test("a subagent's rejection asks what to do instead: typed and sent with Enter, none, or back", () => {
  const parsed = parseOpencodePrompt(opencodeRejectScreen());
  assert.equal(parsed.title, "Reject permission");
  assert.equal(parsed.question, "Tell OpenCode what to do differently");
  assert.equal(parsed.customOptionIndex, 2);
  assert.deepEqual(publicCard(parsed).options.map((option) => option.label), ["Reject without a message", "Back to the permission"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["enter"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["esc"]);
  assert.deepEqual(keys(answerSteps(parsed, { text: "use pnpm instead" })), ["text:use pnpm instead", "enter"]);
  assert.throws(() => answerSteps(parsed, { text: "a\u001bb" }), /control characters/u);
  // words already typed in the terminal are the terminal's to send
  assert.equal(parseOpencodePrompt(opencodeRejectScreen({ typed: "half a thought" })), null);
});

// --- questions -------------------------------------------------------------

test("reads a question: its rows by number, their descriptions, and a typed answer through its own row", () => {
  const parsed = parseOpencodePrompt(opencodeQuestionScreen());
  assert.equal(parsed.kind, "question");
  assert.equal(parsed.question, "Which export format should we use?");
  assert.deepEqual(labels(parsed), ["ONNX", "TensorRT"]);
  assert.equal(parsed.options[1].description, "Build an NVIDIA TensorRT engine.");
  assert.equal(parsed.multiSelect, false);
  assert.equal(parsed.customOptionIndex, 2);
  // a digit picks its row, wherever the cursor is
  assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["1"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["2"]);
  assert.deepEqual(keys(answerSteps(parsed, { text: "ROCm" })), ["3", "text:ROCm", "enter"]);
  assert.throws(() => answerSteps(parsed, { option: 2 }), /valid option/u);
});

test("a question that forbids a typed answer has no box; one with more than nine rows is no card (a digit cannot reach the tenth)", () => {
  const closed = parseOpencodePrompt(opencodeQuestionScreen({ custom: false }));
  assert.equal(closed.customOptionIndex, null);
  assert.deepEqual(labels(closed), ["ONNX", "TensorRT"]);
  assert.throws(() => answerSteps(closed, { text: "ROCm" }), /typed answer/u);
  // nine rows in all (eight choices and the typed answer): every one answerable
  const nine = parseOpencodePrompt(opencodeQuestionScreen({ options: Array.from({ length: 8 }, (_, index) => [`Option ${index + 1}`, "A choice."]) }));
  assert.equal(nine.options.length, 8);
  assert.deepEqual(keys(answerSteps(nine, { option: 7 })), ["8"]);
  assert.deepEqual(keys(answerSteps(nine, { text: "mine" })), ["9", "text:mine", "enter"]);
  // ten rows: the tenth has no digit, so the card would offer what it cannot send
  assert.equal(parseOpencodePrompt(opencodeQuestionScreen({ options: Array.from({ length: 10 }, (_, index) => [`Option ${index + 1}`, "A choice."]) })), null);
});

test("a multiple choice ticks each change by its digit and leaves for Confirm with →; its review submits with Enter", () => {
  const parsed = parseOpencodePrompt(opencodeQuestionScreen({ multiple: true, checked: [0] }));
  assert.equal(parsed.multiSelect, true);
  assert.equal(parsed.question, "Which export format should we use?");
  assert.deepEqual(parsed.checkedOptionIndices, [0]);
  assert.equal(parsed.customOptionIndex, null);
  assert.deepEqual(publicCard(parsed).checked, [0]);
  assert.deepEqual(keys(answerSteps(parsed, { options: [1] })), ["1", "2", "right"]);
  assert.deepEqual(keys(answerSteps(parsed, { options: [0, 1] })), ["2", "right"]);
  // the ticks do not change the card
  assert.equal(parseOpencodePrompt(opencodeQuestionScreen({ multiple: true })).promptKey, parsed.promptKey);
  const review = parseOpencodePrompt(opencodeReviewScreen());
  assert.equal(review.title, "Review your answers");
  assert.equal(review.body, "Formats: ONNX, TensorRT");
  assert.deepEqual(keys(answerSteps(review, { option: 0 })), ["enter"]);
  assert.deepEqual(keys(answerSteps(review, { option: 1 })), ["esc"]);
});

test("one of several questions: its tabs above, Enter there confirms and moves on; picked by its digit", () => {
  const parsed = parseOpencodePrompt(opencodeQuestionScreen({ tabs: ["Format", "Target"] }));
  assert.equal(parsed.question, "Which export format should we use?");
  assert.equal(parsed.multiSelect, false);
  assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["2"]);
});

test("not a prompt: ordinary output, a prompt above later output, one half drawn, a typed answer's box open", () => {
  assert.equal(parseOpencodePrompt("  1. first\n  2. second\n\n> "), null);
  assert.equal(parseOpencodePrompt(""), null);
  const permission = opencodePermissionScreen();
  assert.equal(parseOpencodePrompt(`${permission}\n  Ran the tests.\n  Everything passed.\n  Anything else?\n\n> `), null);
  // half drawn: the header and the title, no buttons or hints yet
  assert.equal(parseOpencodePrompt(permission.split("\n").slice(0, -4).join("\n")), null);
  assert.equal(parseOpencodePrompt(permission.split("\n").slice(0, -2).join("\n")), null, "the buttons without their hints");
  const question = opencodeQuestionScreen();
  assert.equal(parseOpencodePrompt(question.split("\n").slice(0, -3).join("\n")), null, "the rows without their hints");
  // the typed answer's box open: digits would be typed there
  assert.equal(parseOpencodePrompt(opencodeQuestionScreen({ typing: "" })), null);
  assert.equal(parseOpencodePrompt(opencodeQuestionScreen({ typing: "RO" })), null);
  // a password prompt is never a card
  assert.equal(parseOpencodePrompt(`${permission}\n[sudo] password for me:`), null);
});

// --- the question's words from OpenCode's database --------------------------------

test("a question card takes the question tool's whole words when they are the screen's", () => {
  const card = publicCard(parseOpencodePrompt(opencodeQuestionScreen({ question: "Which export format should we use for the release build of the", options: [["ONNX", "Export a portable…"], ["TensorRT", "Build an NVIDIA TensorRT engine."]] })));
  const ask = { name: "question", input: { questions: [{
    question: "Which export format should we use for the release build of the model?", header: "Format",
    options: [{ label: "ONNX", description: "Export a portable ONNX model with opset 18." }, { label: "TensorRT", description: "Build an NVIDIA TensorRT engine." }],
  }] } };
  const filled = fillOpencodeCard(card, ask);
  assert.equal(filled.question, "Which export format should we use for the release build of the model?");
  assert.equal(filled.options[0].description, "Export a portable ONNX model with opset 18.");
  assert.equal(filled.id, card.id, "the card is the same card");
  // another question, other options, another agent's card: left as they are
  assert.equal(fillOpencodeCard(card, { name: "question", input: { questions: [{ question: "Which target?", options: ask.input.questions[0].options }] } }), card);
  assert.equal(fillOpencodeCard(card, { name: "question", input: { questions: [{ ...ask.input.questions[0], options: [{ label: "CoreML" }, { label: "TensorRT" }] }] } }), card);
  assert.equal(fillOpencodeCard(card, null), card);
  assert.equal(fillOpencodeCard({ ...card, agent: "claude" }, ask).question, card.question);
});

// --- the service ---------------------------------------------------------------

const PANE = "w1:p1";

function world({ status = "blocked", prompt = { kind: "permission" }, details = null } = {}) {
  const herdr = fakeOpencodeHerdr({ panes: [{ pane_id: PANE, agent: "opencode", agent_status: status }], prompts: prompt ? { [PANE]: prompt } : {} });
  const service = new PromptService({ herdr, details, stepDelayMs: 1, lookMs: 2, settleMs: 100, pollMs: 1_000 });
  return { herdr, service };
}

test("an OpenCode pane is read by its own reader, with the screen's colours, whatever herdr says it is doing", async () => {
  for (const status of ["blocked", "working", "idle"]) {
    const { herdr, service } = world({ status });
    const card = await service.card(PANE);
    assert.equal(card.agent, "opencode", status);
    assert.equal(card.title, "Permission required");
    assert.equal(herdr.reads.at(-1).format, "ansi");
    // herdr's detection snapshot has no styles: OpenCode's screen is read as it is shown
    assert.equal(herdr.reads.at(-1).source, "visible");
  }
  // blocked on a screen the reader does not know: the fallback card, OpenCode's
  const { herdr, service } = world({ prompt: null });
  herdr.answered.length = 0;
  const outputs = { [PANE]: "Pick a color (red/green)?\nPress enter to continue" };
  herdr.readPane = async () => outputs[PANE];
  const fallback = await service.card(PANE);
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.agent, "opencode");
  assert.equal(fallback.id, publicCard(parseFallbackPrompt(outputs[PANE], { agent: "opencode" })).id);
  // not blocked and no prompt: no card
  assert.equal(await world({ status: "working", prompt: null }).service.card(PANE), null);
});

test("Allow once from Reject moves left twice, looks at the selection, then sends Enter", async () => {
  const { herdr, service } = world({ prompt: { kind: "permission", selected: 2 } });
  const card = await service.card(PANE);
  assert.deepEqual(await service.answer(PANE, { cardId: card.id, option: 0 }), { ok: true });
  assert.deepEqual(herdr.sent.map((item) => item.keys), [["left"], ["left"], ["enter"]]);
  assert.deepEqual(herdr.answered, [{ paneId: PANE, answer: "once" }]);
});

test("Allow always opens OpenCode's check, which is a card of its own", async () => {
  const { herdr, service } = world();
  const card = await service.card(PANE);
  await service.answer(PANE, { cardId: card.id, option: 1 });
  assert.deepEqual(herdr.sent.map((item) => item.keys), [["right"], ["enter"]]);
  const check = await service.card(PANE);
  assert.equal(check.title, "Always allow");
  await service.answer(PANE, { cardId: check.id, option: 0 });
  assert.deepEqual(herdr.answered, [{ paneId: PANE, answer: "always" }]);
});

test("Reject is one Esc", async () => {
  const { herdr, service } = world({ prompt: { kind: "permission", selected: 1 } });
  const card = await service.card(PANE);
  await service.answer(PANE, { cardId: card.id, option: 2 });
  assert.deepEqual(herdr.sent.map((item) => item.keys), [["esc"]]);
  assert.deepEqual(herdr.answered, [{ paneId: PANE, answer: "reject" }]);
});

test("an answer to a card that changed is a 409 prompt_changed and sends nothing", async () => {
  const { herdr, service } = world();
  const card = await service.card(PANE);
  herdr.prompts[PANE].screen = { body: ["$ rm -rf build"] };
  await assert.rejects(service.answer(PANE, { cardId: card.id, option: 0 }), { status: 409, code: "prompt_changed" });
  assert.deepEqual(herdr.sent, []);
});

test("an Enter goes only once the screen shows the selection where the moves left it", async () => {
  const { herdr, service } = world();
  const card = await service.card(PANE);
  // a pane that drops the → : the selection stays on Allow once
  const sendKeys = herdr.sendKeys;
  herdr.sendKeys = async (paneId, keys) => (keys.includes("right") ? herdr.sent.push({ paneId, keys }) : sendKeys(paneId, keys));
  await assert.rejects(service.answer(PANE, { cardId: card.id, option: 1 }), { status: 409, code: "prompt_changed" });
  assert.deepEqual(herdr.sent.map((item) => item.keys), [["right"]], "no Enter on Allow once");
  assert.deepEqual(herdr.answered, []);
});

test("a question is answered by its digit, a typed answer through its row, a multiple choice by ticks and →", async () => {
  {
    const { herdr, service } = world({ prompt: { kind: "question" } });
    const card = await service.card(PANE);
    await service.answer(PANE, { cardId: card.id, option: 1 });
    assert.deepEqual(herdr.sent.map((item) => item.keys), [["2"]]);
    assert.deepEqual(herdr.answered, [{ paneId: PANE, answer: "TensorRT" }]);
  }
  {
    const { herdr, service } = world({ prompt: { kind: "question" } });
    const card = await service.card(PANE);
    await service.answer(PANE, { cardId: card.id, text: "ROCm" });
    assert.deepEqual(herdr.sent.map((item) => item.keys ?? `text:${item.text}`), [["3"], "text:ROCm", ["enter"]]);
    assert.deepEqual(herdr.answered, [{ paneId: PANE, answer: "ROCm" }]);
  }
  {
    const { herdr, service } = world({ prompt: { kind: "question", screen: { multiple: true } } });
    const card = await service.card(PANE);
    await service.answer(PANE, { cardId: card.id, options: [0, 1] });
    assert.deepEqual(herdr.sent.map((item) => item.keys), [["1"], ["2"], ["right"]]);
    const review = await service.card(PANE);
    assert.equal(review.title, "Review your answers");
    await service.answer(PANE, { cardId: review.id, option: 0 });
    assert.deepEqual(herdr.answered, [{ paneId: PANE, answer: [["ONNX", "TensorRT"]] }]);
  }
});

test("a question card's words come from the pane's question tool call when there is one", async () => {
  const ask = { name: "question", input: { questions: [{ question: "Which export format should we use?", options: [
    { label: "ONNX", description: "Export a portable ONNX model, opset 18." }, { label: "TensorRT", description: "Build an NVIDIA TensorRT engine." },
  ] }] } };
  const asked = [];
  const { service } = world({ prompt: { kind: "question" }, details: async (paneId) => { asked.push(paneId); return ask; } });
  const card = await service.card(PANE);
  assert.equal(card.options[0].description, "Export a portable ONNX model, opset 18.");
  assert.deepEqual(asked, [PANE]);
  // a permission card asks nothing of the database
  const permission = world({ details: async () => { throw new Error("not asked"); } });
  assert.equal((await permission.service.card(PANE)).title, "Permission required");
});

// Real OpenCode 1.18.34 screens, captured in a test herdr session (permission
// asked for `echo second`): read with styles from the visible screen, with
// "Allow once" and then "Allow always" selected, and herdr's detection
// snapshot, which has no styles.
const REAL_SELECTED_0 = ["\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                                                           \u001b[0m\u001b[38;2;72;72;72m\u001b[48;2;30;30;30m\u2588\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m     \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;10;10;10m$\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;10;10;10mecho second\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                                         \u001b[0m\u001b[38;2;72;72;72m\u001b[48;2;30;30;30m\u2588\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                                                           \u001b[0m\u001b[38;2;72;72;72m\u001b[48;2;30;30;30m\u2588\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m     \u001b[0m\u001b[38;2;92;156;245m\u001b[48;2;10;10;10m\u25a3 \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;10;10;10mBuild\u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;10;10;10m \u00b7 Qwen3.8 27B [\uc0ac\ub0b4\u00b7\uc548\uc804]\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                    \u001b[0m\u001b[38;2;72;72;72m\u001b[48;2;30;30;30m\u2588\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                                                              \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u25b3\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;20;20;20mPermission required\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                  \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m    \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;20;20;20m#\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;20;20;20mShell command\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                      \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m  \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;20;20;20m$ echo second\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                          \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;245;167;66m \u001b[0m\u001b[38;2;10;10;10m\u001b[48;2;245;167;66mAllow once\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;245;167;66m \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mAllow always\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m   \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mReject\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m       \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;30;30;30mctrl+f \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mfullscreen\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;30;30;30m\u21c6 \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mselect\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;30;30;30menter \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mconfirm\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m   \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m"].join("\n");
const REAL_SELECTED_1 = ["\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                                                           \u001b[0m\u001b[38;2;72;72;72m\u001b[48;2;30;30;30m\u2588\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m     \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;10;10;10m$\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;10;10;10mecho second\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                                         \u001b[0m\u001b[38;2;72;72;72m\u001b[48;2;30;30;30m\u2588\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                                                           \u001b[0m\u001b[38;2;72;72;72m\u001b[48;2;30;30;30m\u2588\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m     \u001b[0m\u001b[38;2;92;156;245m\u001b[48;2;10;10;10m\u25a3 \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;10;10;10mBuild\u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;10;10;10m \u00b7 Qwen3.8 27B [\uc0ac\ub0b4\u00b7\uc548\uc804]\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                    \u001b[0m\u001b[38;2;72;72;72m\u001b[48;2;30;30;30m\u2588\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m                                                                                              \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u25b3\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;20;20;20mPermission required\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                  \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m    \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;20;20;20m#\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;20;20;20mShell command\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                      \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m  \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;20;20;20m$ echo second\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                          \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;20;20;20m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m   \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mAllow once\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;245;167;66m \u001b[0m\u001b[38;2;10;10;10m\u001b[48;2;245;167;66mAllow always\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;245;167;66m \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mReject\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m       \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;30;30;30mctrl+f \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mfullscreen\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;30;30;30m\u21c6 \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mselect\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m  \u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;30;30;30menter \u001b[0m\u001b[38;2;128;128;128m\u001b[48;2;30;30;30mconfirm\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m   \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m", "\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m\u001b[38;2;245;167;66m\u001b[48;2;20;20;20m\u2503\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m                                                                                         \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;10;10;10m  \u001b[0m"].join("\n");
const REAL_DETECTION = ["                                                                                           \u2588", "     $ echo second                                                                         \u2588", "                                                                                           \u2588", "     \u25a3  Build \u00b7 Qwen3.8 27B [\uc0ac\ub0b4\u00b7\uc548\uc804]                                                    \u2588", "", "  \u2503", "  \u2503  \u25b3 Permission required", "  \u2503    # Shell command", "  \u2503", "  \u2503  $ echo second", "  \u2503", "  \u2503", "  \u2503   Allow once   Allow always   Reject       ctrl+f fullscreen  \u21c6 select  enter confirm", "  \u2503"].join("\n");

test("real OpenCode 1.18.34 permission screens read as the card, with the selected button from its colour", () => {
  for (const [screen, selected] of [[REAL_SELECTED_0, 0], [REAL_SELECTED_1, 1]]) {
    const card = parseOpencodePrompt(screen);
    assert.equal(card.kind, "approval");
    assert.equal(card.body, "$ echo second");
    assert.deepEqual(card.options.map((option) => option.label), ["Allow once", "Allow always", "Reject"]);
    assert.equal(card.selectedIndex, selected);
  }
  // without styles the same card shows, but which button is selected is unknown
  const plain = parseOpencodePrompt(REAL_DETECTION);
  assert.equal(plain.kind, "approval");
  assert.equal(plain.selectedIndex, null);
});

test("a 16-colour theme's bright colours match: the selected one of two buttons is read", () => {
  // the warning mark in bright yellow (93) and the selected button on bright yellow (103)
  const header = "\u001b[93m\u2503\u001b[0m  \u001b[93m\u25b3\u001b[0m Always allow";
  const row = "\u001b[30;103m Confirm \u001b[0m  \u001b[37;100m Cancel \u001b[0m";
  assert.equal(selectedButton(row, ["Confirm", "Cancel"], header), 0);
  // and the same colour in its 256-colour number (38;5;11 / 48;5;11) reads the same
  const header256 = "\u001b[38;5;11m\u25b3\u001b[0m Always allow";
  const row256 = "\u001b[37;100m Confirm \u001b[0m  \u001b[30;48;5;11m Cancel \u001b[0m";
  assert.equal(selectedButton(row256, ["Confirm", "Cancel"], header256), 1);
});


// --- real 1.18.34 screens: dialogs, a question of two paragraphs ----------------

const PERMISSION_BUTTONS = ["Allow once", "Allow always", "Reject"];
const realRow = (screen, text) => screen.split("\n").find((line) => plain(line).includes(text));

test("real 1.18.34: a dialog open over a prompt (ctrl+p's commands, the sessions, the models) is no card: its keys go to the dialog", () => {
  const alone = parseOpencodePrompt(REAL.permission);
  assert.equal(alone.title, "Permission required");
  assert.equal(alone.body, "$ echo hi");
  assert.equal(alone.selectedIndex, 0);
  // Under ctrl+p's list the whole panel still shows, dimmed, and the selected
  // button still carries the (dimmed) colour of △: only the dialog tells.
  const under = REAL.permissionUnderPalette;
  assert.equal(selectedButton(realRow(under, "Allow once"), PERMISSION_BUTTONS, realRow(under, "Permission required")), 0);
  for (const [name, screen] of Object.entries({
    permissionUnderPalette: REAL.permissionUnderPalette,
    permissionUnderSessions: REAL.permissionUnderSessions,
    permissionUnderModels: REAL.permissionUnderModels,
    alwaysUnderPalette: REAL.alwaysUnderPalette,
  })) {
    assert.equal(parseOpencodePrompt(screen), null, name);
    assert.equal(parseOpencodePrompt(plain(screen)), null, `${name}, read without styles`);
  }
  // a drawn screen with the palette's title row over it, a question too
  const title = `                     Commands${" ".repeat(41)}esc                  █`;
  assert.notEqual(parseOpencodePrompt(opencodeQuestionScreen()), null);
  assert.equal(parseOpencodePrompt(`${title}\n${opencodeQuestionScreen()}`), null);
  assert.equal(parseOpencodePrompt(`${title}\n${opencodePermissionScreen()}`), null);
});

test("real 1.18.34: a question of two paragraphs shows both, and takes the question tool's words", () => {
  const card = parseOpencodePrompt(REAL.twoParagraphQuestion);
  assert.equal(card.kind, "question");
  // both paragraphs, and nothing of the message above the panel
  assert.equal(card.question, "We need to pick an export format for the release build.\n\nWhich export format should we use?");
  assert.deepEqual(labels(card), ["ONNX", "TensorRT"]);
  const options = [{ label: "ONNX", description: "Open Neural Network Exchange format" }, { label: "TensorRT", description: "NVIDIA TensorRT optimized format" }];
  const asked = (question) => ({ name: "question", input: { questions: [{ question, header: "Format", options }] } });
  const whole = "We need to pick an export format for the release build.\n\nWhich export format should we use?";
  assert.equal(fillOpencodeCard(publicCard(card), asked(whole)).question, whole);
  // a first paragraph the panel's top cut off: the words on screen are still the call's
  const longer = `Some context first.\n\n${whole}`;
  assert.equal(fillOpencodeCard(publicCard(card), asked(longer)).question, longer);
  // another question is not this one
  assert.equal(fillOpencodeCard(publicCard(card), asked("Which target should we use?")).question, card.question);
});

// --- cards answered by their own keys look again before each ---------------------

test("the review's Enter goes only while the review is still on screen", async () => {
  const { herdr, service } = world({ prompt: { kind: "review", screen: { answers: [["ONNX"]] } } });
  const card = await service.card(PANE);
  assert.equal(card.title, "Review your answers");
  // the review goes (dismissed in the terminal) right after the answer's own look at it
  const readPane = herdr.readPane;
  let reads = 0;
  herdr.readPane = async (paneId, options) => {
    reads += 1;
    if (reads === 1) return readPane(paneId, options);
    delete herdr.prompts[PANE];
    return "  ┃  ask anything\n";
  };
  await assert.rejects(service.answer(PANE, { cardId: card.id, option: 0 }), { status: 409, code: "prompt_changed" });
  assert.deepEqual(herdr.sent, [], "no Enter into OpenCode's input");
});

test("a Reject message: typed only while the panel shows, its Enter only while the box holds it", async () => {
  {
    const { herdr, service } = world({ prompt: { kind: "reject" } });
    const card = await service.card(PANE);
    await service.answer(PANE, { cardId: card.id, text: "use pnpm instead" });
    assert.deepEqual(herdr.sent.map((item) => item.keys ?? `text:${item.text}`), ["text:use pnpm instead", ["enter"]]);
    assert.deepEqual(herdr.answered, [{ paneId: PANE, answer: "reject: use pnpm instead" }]);
  }
  {
    // the text went somewhere else (the panel closed meanwhile): no Enter after it
    const { herdr, service } = world({ prompt: { kind: "reject" } });
    const card = await service.card(PANE);
    herdr.sendText = async (paneId, text) => { herdr.sent.push({ paneId, text }); delete herdr.prompts[PANE]; return { ok: true }; };
    await assert.rejects(service.answer(PANE, { cardId: card.id, text: "!rm -rf build" }), { status: 409, code: "prompt_changed" });
    assert.deepEqual(herdr.sent.map((item) => item.keys ?? `text:${item.text}`), ["text:!rm -rf build"]);
  }
  {
    // the panel gone before anything is typed: nothing goes
    const { herdr, service } = world({ prompt: { kind: "reject" } });
    const card = await service.card(PANE);
    const readPane = herdr.readPane;
    let reads = 0;
    herdr.readPane = async (paneId, options) => { reads += 1; return reads === 1 ? readPane(paneId, options) : "  ┃  ask anything\n"; };
    await assert.rejects(service.answer(PANE, { cardId: card.id, text: "use pnpm" }), { status: 409, code: "prompt_changed" });
    await assert.rejects(service.answer(PANE, { cardId: card.id, option: 0 }), { status: 409, code: "prompt_changed" });
    assert.deepEqual(herdr.sent, []);
  }
});
