// A Claude card's words come from what Claude asked (its transcript), not the
// terminal, where a long plan scrolls away and a narrow pane cuts an option
// short; its id, rows and keys stay the screen's.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, pendingClaudeAsk } from "../src/conversation/claude.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { fillClaudeCard, parseClaudePrompt } from "../src/prompt/claude.mjs";
import { publicCard } from "../src/prompt/screen.mjs";
import { PromptService } from "../src/prompt/service.mjs";

const SESSION = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const call = (id, name, input) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

const PLAN = `# Move the cache\n\n${Array.from({ length: 60 }, (_, n) => `- step ${n + 1}`).join("\n")}\n\nThe last line of the plan.`;
// What a phone-sized pane shows of it: the start scrolled away.
const planScreen = `
- step 58
- step 59
- step 60

The last line of the plan.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. Tell Claude what to change
     shift+tab to approve with this feedback
`;
// A narrow pane: the question and the options cut with "…".
const questionScreen = `
☐ Storage

Which store should the cache move to, given the…

❯ 1. Redis on the shared cluster, with a …
     Fast, already run by…
  2. SQLite next to the app
     Nothing new to run.
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
const QUESTION = {
  questions: [{
    header: "Storage",
    question: "Which store should the cache move to, given the traffic we expect next quarter?",
    multiSelect: false,
    options: [
      { label: "Redis on the shared cluster, with a namespace of its own", description: "Fast, already run by the platform team, but shared." },
      { label: "SQLite next to the app", description: "Nothing new to run." },
    ],
  }],
};

test("the call Claude waits on is the last asking one without a result", () => {
  assert.equal(pendingClaudeAsk(""), null);
  const asked = jsonl([call("t1", "ExitPlanMode", { plan: "old" }), result("t1"), call("t2", "Bash", { command: "ls" }), call("t3", "AskUserQuestion", QUESTION)]);
  assert.deepEqual(pendingClaudeAsk(asked), { name: "AskUserQuestion", input: QUESTION });
  assert.equal(pendingClaudeAsk(asked + jsonl([result("t3")])), null);
  // a torn first line (a tail read) is skipped
  assert.equal(pendingClaudeAsk(`{"type":"assi\n${jsonl([call("t4", "ExitPlanMode", { plan: PLAN })])}`).input.plan, PLAN);
});

test("a plan card shows the whole plan, and a question card the whole question and options", () => {
  const plan = publicCard(parseClaudePrompt(planScreen));
  assert.doesNotMatch(plan.body, /step 1\n/u);
  const filled = fillClaudeCard(plan, { name: "ExitPlanMode", input: { plan: PLAN } });
  assert.equal(filled.body, PLAN);
  assert.equal(filled.id, plan.id);
  assert.deepEqual(filled.options, plan.options);

  const question = publicCard(parseClaudePrompt(questionScreen));
  const whole = fillClaudeCard(question, { name: "AskUserQuestion", input: QUESTION });
  assert.equal(whole.id, question.id);
  assert.equal(whole.question, QUESTION.questions[0].question);
  assert.deepEqual(whole.options, QUESTION.questions[0].options);
  // another question's call, or another kind of call, changes nothing
  const other = { questions: [{ question: "Something else entirely?", options: QUESTION.questions[0].options }, { question: "And this?", options: [] }] };
  assert.deepEqual(fillClaudeCard(question, { name: "AskUserQuestion", input: other }), question);
  assert.deepEqual(fillClaudeCard(plan, { name: "AskUserQuestion", input: QUESTION }), plan);
  assert.deepEqual(fillClaudeCard(question, null), question);
  // one option the screen shows as something else: another question, all the
  // screen's words stay, the alike ones too
  const moved = { questions: [{ ...QUESTION.questions[0], options: [{ label: "Postgres", description: "x" }, QUESTION.questions[0].options[1]] }] };
  assert.deepEqual(fillClaudeCard(question, { name: "AskUserQuestion", input: moved }), question);
});

test("the prompt service fills the card from the pane's transcript, and answers by the screen", async (context) => {
  const configDir = await mkdtemp(join(tmpdir(), "herdrabbit-card-words-"));
  context.after(() => rm(configDir, { recursive: true, force: true }));
  const project = join(configDir, "projects", claudeProjectDir("/work/app"));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${SESSION}.jsonl`), jsonl([call("t1", "ExitPlanMode", { plan: PLAN })]));
  const herdr = {
    async snapshot() {
      return { panes: [{ pane_id: "w1:p1", cwd: "/work/app", agent: "claude", agent_status: "blocked", agent_session: { agent: "claude", kind: "id", value: SESSION } }] };
    },
    async readPane() { return planScreen; },
  };
  const conversations = new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) });
  const prompts = new PromptService({ herdr, details: (paneId, snapshot) => conversations.pendingAsk(paneId, snapshot) });
  context.after(() => prompts.stop());
  const card = await prompts.card("w1:p1");
  assert.equal(card.kind, "plan");
  assert.equal(card.body, PLAN);
  assert.equal(card.id, parseClaudePrompt(planScreen).id);
  // a snapshot in hand is used, herdr is not asked again
  const blind = new ConversationService({ herdr: { async snapshot() { throw new Error("asked again"); } }, localStore: localTranscriptStore({ configDir }) });
  assert.equal((await blind.pendingAsk("w1:p1", await herdr.snapshot()))?.input.plan, PLAN);
  // a transcript that cannot say leaves the screen's words
  await writeFile(join(project, `${SESSION}.jsonl`), jsonl([call("t1", "ExitPlanMode", { plan: PLAN }), result("t1")]));
  assert.match((await prompts.card("w1:p1")).body, /^\s*- step 58/u);
  const failing = new PromptService({ herdr, details: () => { throw new Error("unreadable"); } });
  context.after(() => failing.stop());
  assert.match((await failing.card("w1:p1")).body, /^\s*- step 58/u);
});

test("a plan or question an earlier session left open does not fill another card", () => {
  const plan = publicCard(parseClaudePrompt(planScreen));
  assert.deepEqual(fillClaudeCard(plan, { name: "ExitPlanMode", input: { plan: "# Something else\n\nAnother ending." } }), plan);
  const question = publicCard(parseClaudePrompt(questionScreen));
  const stranger = { questions: [{ question: "Pick a colour?", options: [{ label: "Red" }, { label: "Blue" }] }] };
  assert.deepEqual(fillClaudeCard(question, { name: "AskUserQuestion", input: stranger }), question);
  // of several questions, the one the screen shows
  const several = { questions: [stranger.questions[0], QUESTION.questions[0]] };
  assert.equal(fillClaudeCard(question, { name: "AskUserQuestion", input: several }).options[0].label, QUESTION.questions[0].options[0].label);
});

test("a watching page is told again once the transcript gives the card its whole words", async (context) => {
  let ask = null;
  const herdr = {
    async snapshot() { return { panes: [{ pane_id: "w1:p1", agent: "claude", agent_status: "blocked" }] }; },
    async readPane() { return planScreen; },
  };
  // the watch hands over the snapshot it took, so the transcript's lookup does not ask herdr again
  const handed = [];
  const prompts = new PromptService({ herdr, pollMs: 20, details: async (paneId, snapshot) => { handed.push(snapshot); return ask; } });
  context.after(() => prompts.stop());
  const heard = [];
  prompts.watch("w1:p1", (card) => heard.push(card));
  for (let tries = 0; tries < 100 && heard.length < 1; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(heard[0].body, /step 58/u);
  ask = { name: "ExitPlanMode", input: { plan: PLAN } };
  for (let tries = 0; tries < 100 && heard.length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(heard[1]?.body, PLAN);
  assert.equal(heard[1].id, heard[0].id);
  assert.ok(handed.length > 0 && handed.every((snapshot) => snapshot?.panes?.[0]?.pane_id === "w1:p1"));
});
