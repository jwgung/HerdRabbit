// Screens adapted from herdr-web-ui's server/prompt.test.ts (MIT, Copyright
// (c) 2026 devswha), captured there from Codex 0.146-0.160.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexPrompt } from "../src/prompt/codex.mjs";
import { parseFallbackPrompt } from "../src/prompt/fallback.mjs";
import { answerSteps, publicCard } from "../src/prompt/screen.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { fakePromptHerdr } from "./fixtures/claude-prompt.mjs";
import { codexApprovalScreen, codexQuestionScreen } from "./fixtures/codex-prompt.mjs";

const labels = (parsed) => parsed?.options.map((option) => option.label);
const keys = (steps) => steps.flatMap((step) => step.keys ?? [`text:${step.text}`]);

test("reads a command approval, its command in the body, and answers its refusal with Esc", () => {
  const parsed = parseCodexPrompt(codexApprovalScreen({ command: "curl -I https://example.com" }));
  assert.equal(parsed.agent, "codex");
  assert.equal(parsed.kind, "approval");
  assert.equal(parsed.title, "Would you like to run the following command?");
  assert.match(parsed.body, /curl -I https:\/\/example\.com/u);
  assert.deepEqual(labels(parsed), ["Yes, proceed (y)", "Yes, and don't ask again for commands that start with npm", "No, and tell Codex what to do differently (esc)"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["enter"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["down", "enter"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 2 })), ["esc"]);
  assert.throws(() => answerSteps(parsed, { text: "maybe" }), /typed answer/);
  assert.equal(publicCard(parsed).agent, "codex");
});

test("the card id stays while the cursor moves and changes with the command", () => {
  const first = parseCodexPrompt(codexApprovalScreen()).id;
  assert.equal(parseCodexPrompt(codexApprovalScreen({ cursor: 1 })).id, first);
  assert.notEqual(parseCodexPrompt(codexApprovalScreen({ command: "rm -rf build" })).id, first);
  const long = "x".repeat(12_010);
  assert.notEqual(parseCodexPrompt(codexApprovalScreen({ command: `${long}a` })).id, parseCodexPrompt(codexApprovalScreen({ command: `${long}b` })).id);
});

test("reads Codex's continue menu, a plan-mode question and a folder to trust", () => {
  const menu = parseCodexPrompt(`
✨ Update available! 0.146.0 -> 0.146.1

› 1. Update now
  2. Skip
  3. Skip until next version

Press enter to continue
`);
  assert.equal(menu.kind, "menu");
  assert.equal(menu.question, "Choose how to continue");
  assert.deepEqual(keys(answerSteps(menu, { option: 2 })), ["down", "down", "enter"]);

  const question = parseCodexPrompt(codexQuestionScreen());
  assert.equal(question.kind, "question");
  assert.equal(question.question, "Which export format should we use?");
  assert.equal(question.customOptionIndex, 2);
  assert.deepEqual(labels(question), ["ONNX", "TensorRT"]);
  assert.equal(question.options[0].description, "Export a portable ONNX model.");
  // a typed answer goes into the last row's notes
  assert.deepEqual(keys(answerSteps(question, { text: "ROCm" })), ["down", "down", "tab", "text:ROCm", "enter"]);
  assert.deepEqual(keys(answerSteps(question, { option: 1 })), ["down", "enter"]);

  const last = parseCodexPrompt(`
  Question 2/2 (1 unanswered)
  Which split?
  › 1. train (Recommended)  Use the training split.
    2. test                 Use the test split.
    3. None of the above    Optionally, add details in notes (tab).
  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt
`);
  assert.equal(last.title, "Question 2 of 2");
  assert.deepEqual(labels(last), ["train (Recommended)", "test"]);

  const trust = parseCodexPrompt(`
  Folder access
  /tmp/prompt-lab-codex
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Back to Agent Command Center
  enter continue · esc back
`);
  assert.equal(trust.kind, "approval");
  assert.equal(trust.title, "Trust this folder?");
  assert.equal(trust.body, "Codex can read, edit, and run files here, subject to your permission settings.");
  assert.deepEqual(keys(answerSteps(trust, { option: 0 })), ["enter"]);
});

test("reads a question from Codex's queue: wrapped, with its typed-answer row, or free form", () => {
  const queued = parseCodexPrompt(`
• Queued follow-up inputs
  1 of 2
  Should the cleanup cover only the Q255 outputs, or every
  experiment under output/test?
  › 1. Only the Q255 outputs
    2. Every experiment under output/test, and record the
       results in a table
    3. Other
  enter submit   ctrl+] skip   alt+↓ main prompt   alt+↑ next question
`);
  assert.equal(queued.title, "Question 1 of 2");
  assert.equal(queued.question, "Should the cleanup cover only the Q255 outputs, or every experiment under output/test?");
  assert.deepEqual(labels(queued), ["Only the Q255 outputs", "Every experiment under output/test, and record the results in a table"]);
  assert.deepEqual(keys(answerSteps(queued, { text: "Q255 only, keep logs" })), ["down", "down", "text:Q255 only, keep logs", "enter"]);
  assert.deepEqual(keys(answerSteps(queued, { option: 1 })), ["down", "enter"]);

  const freeForm = parseCodexPrompt(`
• Queued follow-up inputs
  Any notes?
  Type your answer
  enter submit   ctrl+] skip   alt+↓ main prompt
`);
  assert.equal(freeForm.question, "Any notes?");
  assert.deepEqual(freeForm.options, []);
  assert.deepEqual(keys(answerSteps(freeForm, { text: "none" })), ["text:none", "enter"]);

  // under a message sent before, without the queue header
  const plain = parseCodexPrompt(`
› 1. Do this first

• Understood.

Which accelerator?

› 1. CUDA
  2. CPU
  3. Other

enter submit   ctrl + ] skip
option 1/3   shift + → main prompt
`);
  assert.equal(plain.question, "Which accelerator?");
  assert.deepEqual(labels(plain), ["CUDA", "CPU"]);
});

test("an answered approval above later output, or a password prompt, is no card", () => {
  assert.equal(parseCodexPrompt(`
Would you like to run the following command?
› 1. Yes, proceed
  2. No, and tell Codex what to do differently
Press enter to confirm or esc to cancel

• Command completed successfully.
› Ask Codex to do something
`), null);
  assert.equal(parseCodexPrompt("Running sudo\n[sudo] password for me:"), null);
  assert.equal(parseCodexPrompt("Enter to select · ↑/↓ to navigate · Esc to cancel"), null);
});

test("the fallback card speaks for Codex, but never over its /model list", () => {
  const fallback = parseFallbackPrompt("Working on it\n\nPress any key to review the diff (q to quit)\n", { agent: "codex" });
  assert.equal(fallback.agent, "codex");
  assert.equal(fallback.question, "Press any key to review the diff (q to quit)");
  assert.deepEqual(labels(fallback), ["Enter", "Esc"]);
  assert.equal(parseFallbackPrompt("", { agent: "codex" }), null);
  const models = [
    "  >_ OpenAI Codex (v0.160.1)",
    "",
    "  Select Model and Effort",
    "",
    "› 1. GPT-6-Astra (current)  Fast and capable",
    "  2. GPT-6-Sol             Deep reasoning",
    "",
    "  enter select · esc back",
  ].join("\n");
  assert.equal(parseFallbackPrompt(models, { agent: "codex" }), null);
  assert.equal(parseFallbackPrompt(`${models.replace("enter select · esc back", "enter default · s session · esc back")}\n`, { agent: "codex" }), null);
});

test("a blocked Codex pane's approval is answered through the service, the cursor checked first", async (context) => {
  // the service's own waits do not hold the process open: this test does
  const keepAlive = setInterval(() => {}, 1_000);
  context.after(() => clearInterval(keepAlive));
  const herdr = fakePromptHerdr({
    panes: [{ pane_id: "w1:p1", agent: "codex", agent_status: "blocked" }, { pane_id: "w1:p2", agent: "codex", agent_status: "blocked" }],
    menus: { "w1:p1": { agent: "codex", cursor: 0 }, "w1:p2": { agent: "codex", cursor: 0 } },
  });
  const service = new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 300 });
  const card = await service.card("w1:p1");
  assert.equal(card.agent, "codex");
  assert.equal(card.kind, "approval");
  assert.equal(card.fallback, undefined);
  await service.answer("w1:p1", { cardId: card.id, option: 1 });
  assert.deepEqual(herdr.answered, [{ paneId: "w1:p1", answer: "Yes, and don't ask again for commands that start with npm" }]);
  assert.deepEqual(herdr.sent.filter((item) => item.paneId === "w1:p1").map((item) => item.keys), [["down"], ["enter"]]);
  // the refusal is Codex's own Esc
  const other = await service.card("w1:p2");
  await service.answer("w1:p2", { cardId: other.id, option: 2 });
  assert.deepEqual(herdr.answered.at(-1), { paneId: "w1:p2", answer: "esc" });
  // a card answered meanwhile is stale
  herdr.menus["w1:p1"] = { agent: "codex", cursor: 0, command: "npm run deploy" };
  await assert.rejects(service.answer("w1:p1", { cardId: card.id, option: 0 }), { code: "prompt_changed" });
  service.stop();
});
