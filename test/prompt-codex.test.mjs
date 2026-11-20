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

test("an approval whose hint a narrow pane wraps is still a card", () => {
  for (const hint of ["Press enter to confirm or esc\nto cancel", "Press enter to confirm or esc to\ncancel", "Press enter to confirm or\nesc to cancel"]) {
    const parsed = parseCodexPrompt(codexApprovalScreen().replace("Press enter to confirm or esc to cancel", hint));
    assert.equal(parsed?.kind, "approval", hint);
  }
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
  assert.deepEqual(labels(fallback), ["↑", "↓", "←", "→", "Tab", "Space", "Enter", "Esc"]);
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

// The screens below are Codex 0.171's own (its .snap files).
test("reads a plan-mode question without a 'None of the above' row, and a free-form one", () => {
  const multi = parseCodexPrompt(`
  Question 1/2 (2 unanswered)
  Choose an option.

  › 1. Option 1  First choice.
    2. Option 2  Second choice.
    3. Option 3  Third choice.

  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt
`);
  assert.equal(multi.kind, "question");
  assert.equal(multi.title, "Question 1 of 2");
  assert.equal(multi.customOptionIndex, null);
  assert.deepEqual(labels(multi), ["Option 1", "Option 2", "Option 3"]);
  assert.equal(multi.options[1].description, "Second choice.");
  assert.deepEqual(keys(answerSteps(multi, { option: 2 })), ["down", "down", "enter"]);
  assert.throws(() => answerSteps(multi, { text: "x" }), /typed answer/);

  const freeForm = parseCodexPrompt(`
  Question 1/1 (1 unanswered)
  Share details.

  › Type your answer (optional)



  enter to submit answer | esc to interrupt
`);
  assert.equal(freeForm.question, "Share details.");
  assert.deepEqual(freeForm.options, []);
  assert.deepEqual(keys(answerSteps(freeForm, { text: "all of them" })), ["text:all of them", "enter"]);

  const last = parseCodexPrompt(`
  Question 2/2 (2 unanswered)
  Share details.

  › Type your answer (optional)





  enter to submit all | ⌃p / ⌃n change question | esc to interrupt
`);
  assert.equal(last.title, "Question 2 of 2");
  assert.equal(last.question, "Share details.");

  // the words alone, under no question form, are no card
  assert.equal(parseCodexPrompt("Share details.\n\n1. one\n2. two\n\nenter to submit answer | esc to interrupt\n"), null);
  assert.equal(parseCodexPrompt("Share details.\n\n› Type your answer (optional)\n\nenter to submit answer | esc to interrupt\n"), null);
});

test("a question's rows are moved to by arrows whatever their number, past the ninth too", () => {
  const rows = Array.from({ length: 12 }, (_, index) => `${index === 0 ? "›" : " "} ${index + 1}. Choice ${index + 1}  About ${index + 1}.`);
  const parsed = parseCodexPrompt(`\n  Question 1/1 (1 unanswered)\n  Pick one.\n\n${rows.join("\n")}\n\n  tab to add notes | enter to submit answer | esc to interrupt\n`);
  assert.equal(parsed.options.length, 12);
  assert.deepEqual(keys(answerSteps(parsed, { option: 11 })), [...Array(11).fill("down"), "enter"]);
});

test("reads the confirmation of unanswered questions and the network approval", () => {
  const confirm = parseCodexPrompt(`
  Submit with unanswered questions?
  2 unanswered questions

  › 1. Proceed  Submit with 2 unanswered questions
    2. Go back  Return to the first unanswered question




  Press enter to confirm or esc to go back
`);
  assert.equal(confirm.kind, "approval");
  assert.equal(confirm.title, "Submit with unanswered questions?");
  assert.deepEqual(labels(confirm), ["Proceed", "Go back"]);
  assert.equal(confirm.options[1].description, "Return to the first unanswered question");
  assert.deepEqual(keys(answerSteps(confirm, { option: 1 })), ["down", "enter"]);

  const network = parseCodexPrompt(`
  Do you want to approve network access to "example.com"?

  Reason: network request blocked



› 1. Yes, just this once (y)
  2. Yes, and allow this host for this conversation (a)
  3. Yes, and allow this host in the future (p)
  4. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`);
  assert.equal(network.kind, "approval");
  assert.equal(network.title, 'Do you want to approve network access to "example.com"?');
  assert.match(network.body, /network request blocked/u);
  assert.deepEqual(keys(answerSteps(network, { option: 1 })), ["down", "enter"]);
  assert.deepEqual(keys(answerSteps(network, { option: 3 })), ["esc"]);
});

test("reads an MCP tool's approval and the user verification, Cancel picked by its row", () => {
  const mcp = parseCodexPrompt(`
  Calendar needs your approval.

› 1. Yes, provide the requested info (y)
  2. No, but continue without it (n)
  3. Cancel this request (c)

  Press enter to confirm or esc to cancel
`);
  assert.equal(mcp.kind, "approval");
  assert.equal(mcp.title, "Calendar needs your approval.");
  assert.equal(mcp.options.length, 3);
  // Esc cancels the whole request: the "No" row is picked, not escaped
  assert.deepEqual(keys(answerSteps(mcp, { option: 1 })), ["down", "enter"]);
  assert.deepEqual(keys(answerSteps(mcp, { option: 2 })), ["down", "down", "enter"]);

  const verify = parseCodexPrompt(`
  Production deployment needs your approval.

  Server: deployments

  Approve deploying the reviewed release?


› 1. Verify and approve (y)
  2. Cancel this request (c)

  Press enter to confirm or esc to cancel
`);
  assert.equal(verify.title, "Production deployment needs your approval.");
  assert.match(verify.body, /Server: deployments/u);
  assert.deepEqual(keys(answerSteps(verify, { option: 1 })), ["down", "enter"]);

  assert.equal(parseCodexPrompt("The deploy needs your approval.\nthen more output\n"), null);
});

test("reads an MCP server's form: its choice fields, never a text field", () => {
  const boolean = parseCodexPrompt(`
  Field 1/1 (1 required unanswered)
  Server: server-1 (environment env-b)

  Allow this request?

  Confirm
  Approve the pending action.
  › 1. True
    2. False




  enter to submit | esc to cancel
`);
  assert.equal(boolean.kind, "question");
  assert.equal(boolean.question, "Allow this request?");
  assert.deepEqual(labels(boolean), ["True", "False"]);
  assert.equal(boolean.customOptionIndex, null);
  assert.deepEqual(keys(answerSteps(boolean, { option: 1 })), ["down", "enter"]);

  const message = parseCodexPrompt(`
  Field 2/3
  Boolean elicit MCP example: do you confirm?
  › 1. Allow   Allow this request and continue
    2. Deny    Decline this request and continue
    3. Cancel  Cancel this request

  enter to submit answer | ←/→ to navigate fields | esc to cancel
`);
  assert.equal(message.title, "Field 2 of 3");
  assert.deepEqual(labels(message), ["Allow", "Deny", "Cancel"]);
  assert.equal(message.options[1].description, "Decline this request and continue");

  assert.equal(parseCodexPrompt(`
  Field 1/1
  Your name
  › Type your answer

  enter to submit | esc to cancel
`), null);
});

test("reads the update offer by either footer, and the popups that ask a decision", () => {
  const update = parseCodexPrompt(`
  Update available · 0.0.0 → 9.9.9
  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  enter continue · esc skip
`);
  assert.equal(update.kind, "menu");
  assert.match(update.body, /Update available/u);
  assert.deepEqual(keys(answerSteps(update, { option: 1 })), ["down", "enter"]);

  const plan = parseCodexPrompt(`
  Implement this plan?


› 1. Yes, implement this plan          Switch to Default and start coding
  2. Yes, clear context and implement  Fresh thread with this plan
  3. No, stay in Plan mode             Continue planning with the model

  enter select · esc back
`);
  assert.equal(plan.kind, "approval");
  assert.equal(plan.title, "Implement this plan?");
  assert.deepEqual(labels(plan), ["Yes, implement this plan", "Yes, clear context and implement", "No, stay in Plan mode"]);
  assert.equal(plan.options[0].description, "Switch to Default and start coding");
  assert.deepEqual(keys(answerSteps(plan, { option: 0 })), ["enter"]);
  // "No" stays a row picked, not an Esc
  assert.deepEqual(keys(answerSteps(plan, { option: 2 })), ["down", "down", "enter"]);

  const full = parseCodexPrompt(`
      Enable full access?
      When Codex runs with full access, it can edit any file.

    › 1. Yes, continue anyway  Apply full access for this session
      2. Cancel                Go back without enabling full access

      enter select · esc back
`);
  assert.equal(full.title, "Enable full access?");
  assert.deepEqual(keys(answerSteps(full, { option: 1 })), ["down", "enter"]);

  const hooks = parseCodexPrompt(`
  Hooks need review
  2 hooks are new or changed.

› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)

  enter confirm · esc skip
`);
  assert.equal(hooks.title, "Hooks need review");
  assert.equal(hooks.options.length, 3);
  assert.deepEqual(keys(answerSteps(hooks, { option: 2 })), ["down", "down", "enter"]);
});

test("Codex's lists whose Enter saves a setting stay no card", () => {
  assert.equal(parseCodexPrompt(`
  Select Reasoning Level for GPT-5.5


  1. Low               Fast responses with lighter reasoning
  2. Medium (default)  Balances speed and reasoning depth for everyday tasks
› 3. High (current)    Greater reasoning depth for complex problems

  enter default · s session · esc back
`), null);
  assert.equal(parseCodexPrompt(`
  Update Model Permissions


› 1. Ask for approval  Read and edit workspace files and run commands
  2. Full Access       Use with caution

  enter select · esc back
`), null);
  assert.equal(parseCodexPrompt("  Select Model and Effort\n\n› 1. GPT-6-Astra (current)  Fast\n  2. GPT-6-Sol  Deep\n\n  enter select · esc back\n"), null);
});

test("reads a queued question as Codex 0.171 draws it: no header, ⌃] to skip", () => {
  const other = parseCodexPrompt(`
  2 of 2
  Second

  › 1. Other
    2. Other (write an answer)

  enter submit   ⌃] skip   ⇧→ prev question
`);
  assert.equal(other.title, "Question 2 of 2");
  assert.equal(other.question, "Second");
  assert.deepEqual(labels(other), ["Other"]);
  assert.deepEqual(keys(answerSteps(other, { text: "mine" })), ["down", "text:mine", "enter"]);

  const freeForm = parseCodexPrompt(`
• Done with the cleanup.

  1 of 2

  Run this command:

  printf 'x'

  Then review the diagnostics?

  Type your answer

  enter submit   ⌃] skip   ⇧→ main prompt
  ⇧← next question
`);
  assert.equal(freeForm.title, "Question 1 of 2");
  assert.equal(freeForm.question, "Run this command: printf 'x' Then review the diagnostics?");
  assert.deepEqual(keys(answerSteps(freeForm, { text: "yes" })), ["text:yes", "enter"]);

  assert.equal(parseCodexPrompt("Notes\n\nType your answer\n\nenter submit   ⌃] skip\n"), null);
});
