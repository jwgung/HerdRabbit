// Kiro's menus read off its pane's screen: a tool approval and the workspace
// trust question. Each row is answered the way the terminal's user picks it:
// the arrow keys move the ❯, then Enter. Screens are in
// test/fixtures/kiro-prompt.mjs, captured from Kiro CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { parseKiroPrompt } from "../src/prompt/kiro.mjs";
import { parseFallbackPrompt } from "../src/prompt/fallback.mjs";
import { answerSteps, publicCard } from "../src/prompt/screen.mjs";
import { PromptService } from "../src/prompt/service.mjs";
import { KIRO_APPROVAL_ROWS, kiroApprovalScreen, kiroTrustScreen } from "./fixtures/kiro-prompt.mjs";

const labels = (parsed) => parsed?.options.map((option) => option.label);
const keys = (steps) => steps.flatMap((step) => step.keys ?? [`text:${step.text}`]);

test("a tool approval is a card with Kiro's own options, not the arrow keys", () => {
  const parsed = parseKiroPrompt(kiroApprovalScreen());
  assert.equal(parsed.agent, "kiro");
  assert.equal(parsed.kind, "approval");
  assert.equal(parsed.question, "Print probe requires approval");
  assert.equal(parsed.body, "shell → echo probe");
  assert.deepEqual(labels(parsed), KIRO_APPROVAL_ROWS);
  assert.equal(parsed.selectedIndex, 0);
  assert.equal(publicCard(parsed).fallback, undefined);
});

test("an option is answered by moving the cursor onto it, then Enter", () => {
  const parsed = parseKiroPrompt(kiroApprovalScreen());
  assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["enter"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["down", "enter"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 3 })), ["down", "down", "down", "enter"]);
  // from where the cursor is now, not from the top
  const moved = parseKiroPrompt(kiroApprovalScreen({ cursor: 2 }));
  assert.equal(moved.selectedIndex, 2);
  assert.deepEqual(keys(answerSteps(moved, { option: 0 })), ["up", "up", "enter"]);
  assert.throws(() => answerSteps(parsed, { text: "maybe" }), /typed answer/);
});

test("the card id stays while the cursor moves and changes with what is asked", () => {
  const first = parseKiroPrompt(kiroApprovalScreen()).id;
  assert.equal(parseKiroPrompt(kiroApprovalScreen({ cursor: 3 })).id, first);
  assert.notEqual(parseKiroPrompt(kiroApprovalScreen({ target: "rm -rf build" })).id, first);
});

test("the workspace trust question reads its folder and explanation as the body", () => {
  const parsed = parseKiroPrompt(kiroTrustScreen());
  assert.equal(parsed.kind, "menu");
  assert.equal(parsed.question, "Trust this workspace?");
  assert.match(parsed.body, /^\/tmp\/kiro-probe\n/u);
  assert.match(parsed.body, /execute files here\.$/u);
  assert.deepEqual(labels(parsed), ["Trust, continue", "Don't trust, exit"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["down", "enter"]);
});

test("a menu already answered, with later output under it, is no card", () => {
  const answered = `${kiroApprovalScreen()}  Allowed once\n• Shell echo probe\n  probe\n`;
  assert.equal(parseKiroPrompt(answered), null);
  assert.equal(parseKiroPrompt("$ "), null);
  assert.equal(parseKiroPrompt(""), null);
});

test("a blocked Kiro approval is answered through the service, the cursor checked first", async (context) => {
  const keepAlive = setInterval(() => {}, 1_000);
  context.after(() => clearInterval(keepAlive));
  const menu = { cursor: 0, answered: null };
  const sent = [];
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [{ pane_id: "w1:p1", agent: "kiro", agent_status: "blocked" }], agents: [] }; },
    async readPane() { return menu.answered === null ? kiroApprovalScreen({ cursor: menu.cursor }) : "  Allowed once\n"; },
    async sendKeys(_paneId, pressed) {
      sent.push([...pressed]);
      for (const key of pressed) {
        if (key === "down") menu.cursor = Math.min(KIRO_APPROVAL_ROWS.length - 1, menu.cursor + 1);
        else if (key === "up") menu.cursor = Math.max(0, menu.cursor - 1);
        else if (key === "enter") menu.answered = KIRO_APPROVAL_ROWS[menu.cursor];
      }
    },
  };
  const service = new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 300 });
  const card = await service.card("w1:p1");
  assert.equal(card.agent, "kiro");
  assert.deepEqual(card.options.map((option) => option.label), KIRO_APPROVAL_ROWS);
  await service.answer("w1:p1", { cardId: card.id, option: 1 });
  assert.equal(menu.answered, "Deny once");
  assert.deepEqual(sent, [["down"], ["enter"]]);
  service.stop();
});

test("a blocked Kiro pane whose screen is no Kiro menu still gets the fallback card", () => {
  const fallback = parseFallbackPrompt("Waiting\n\nContinue? (y/n)\n", { agent: "kiro" });
  assert.equal(fallback.agent, "kiro");
  assert.deepEqual(labels(fallback), ["Yes (y)", "No (n)", "Enter", "Esc"]);
});
