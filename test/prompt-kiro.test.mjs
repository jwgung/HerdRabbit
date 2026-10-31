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

// Recorded screens (test/fixtures/kiro-prompt.mjs): what a phone-width pane
// shows. Each was a fallback card (Enter / Esc) before Kiro's reader read it.
import {
  KIRO_APPROVAL_44_CURSOR0, KIRO_APPROVAL_44_CURSOR2, KIRO_APPROVAL_58_CURSOR0, KIRO_APPROVAL_60_CURSOR2, KIRO_TRUST_60,
} from "./fixtures/kiro-prompt.mjs";

test("on a rule row the hint says Enter shows more options, and the menu is still a card", () => {
  const parsed = parseKiroPrompt(KIRO_APPROVAL_60_CURSOR2);
  assert.equal(parsed?.kind, "approval");
  assert.equal(parsed.question, "Write File requires approval");
  assert.deepEqual(labels(parsed), KIRO_APPROVAL_ROWS);
  assert.equal(parsed.selectedIndex, 2);
  assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["up", "up", "enter"]);
});

test("a row too long for the pane goes on to the next line and is still one option", () => {
  for (const [screen, cursor] of [[KIRO_APPROVAL_58_CURSOR0, 0], [KIRO_APPROVAL_44_CURSOR0, 0], [KIRO_APPROVAL_44_CURSOR2, 2]]) {
    const parsed = parseKiroPrompt(screen);
    assert.deepEqual(labels(parsed), KIRO_APPROVAL_ROWS, `rows at cursor ${cursor}`);
    assert.equal(parsed.selectedIndex, cursor);
    assert.match(parsed.body, /^fs_write → note2?\.txt$/u);
  }
  // the selected row's second line belongs to it: down from it skips that line
  assert.deepEqual(keys(answerSteps(parseKiroPrompt(KIRO_APPROVAL_44_CURSOR2), { option: 3 })), ["down", "enter"]);
});

test("a narrow pane's menu with its hint on two lines, or its note under the hint on three, is a card", () => {
  assert.deepEqual(labels(parseKiroPrompt(KIRO_APPROVAL_58_CURSOR0)), KIRO_APPROVAL_ROWS);
  const trust = parseKiroPrompt(KIRO_TRUST_60);
  assert.equal(trust?.question, "Trust this workspace?");
  assert.deepEqual(labels(trust), ["Trust, continue", "Don't trust, exit"]);
});

test("output under a narrow pane's answered menu still means it is no card", () => {
  assert.equal(parseKiroPrompt(`${KIRO_APPROVAL_44_CURSOR0}  Allowed once\n• Write note.txt\n`), null);
  assert.equal(parseKiroPrompt(`${KIRO_APPROVAL_60_CURSOR2}\n  Allowed once\n`), null);
});

// What may follow a narrow menu's hint is its own further lines and nothing
// else: an answered menu with output under it must not stay a card, or a
// press would send its keys into Kiro's input (found in review of #104).
test("output under a narrow pane's menu is not taken for the hint's further lines", () => {
  for (const [screen, tail] of [
    [KIRO_APPROVAL_60_CURSOR2, "        const x = 1;\n        return x;\n"],
    [KIRO_APPROVAL_44_CURSOR0, "         12+  foo bar\n"],
    [KIRO_APPROVAL_58_CURSOR0, "                edit\n                edit\n                edit\n"],
  ]) {
    assert.equal(parseKiroPrompt(`${screen}${tail}`), null, JSON.stringify(tail));
  }
});

test("only the trust note's path goes on under it, and it ends where the path does", () => {
  for (const tail of [">\n", "⠋\nThinking…\n", "        indented\n", "a\nb\nc\nd.yaml\n"]) {
    assert.equal(parseKiroPrompt(`${KIRO_TRUST_60}${tail}`), null, JSON.stringify(tail));
  }
  // the note on one line, as on a wide pane, needs no further lines
  assert.equal(parseKiroPrompt(kiroTrustScreen())?.question, "Trust this workspace?");
});

// A hint has further lines only when it stops mid-sentence, and they come
// right under it; a trust note that already ends with its path has no pieces
// (second review of #104).
test("a hint that ended, a line after a blank, or a path after a whole note is output, not the menu's", () => {
  const A60 = kiroApprovalScreen();
  for (const [name, screen] of [
    ["ended hint + more", `${A60}          more\n`],
    ["rule-row hint + to edit", `${KIRO_APPROVAL_60_CURSOR2}        to edit\n`],
    ["rule-row hint + see more / options", `${KIRO_APPROVAL_60_CURSOR2}        see more\n        options\n`],
    ["blank then Enter", `${KIRO_APPROVAL_60_CURSOR2}\n        Enter\n`],
    ["wrapped hint already ended + select", `${KIRO_APPROVAL_58_CURSOR0}        select\n`],
    ["44 + to after its ended second line", `${KIRO_APPROVAL_44_CURSOR0}        to\n`],
    ["trust 60 + yaml line", `${KIRO_TRUST_60}/tmp/a.yaml\n`],
    ["wide trust + yaml line", `${kiroTrustScreen()}/x/foo.yaml\n`],
    ["wide trust + two pieces", `${kiroTrustScreen()}/x/a\n.yaml\n`],
  ]) {
    assert.equal(parseKiroPrompt(screen), null, name);
  }
});

// The menu a rule row opens: its scope is chosen there (s cycles it), and its
// rows read as a card too (reported from a phone, 2026-10-31).
import {
  KIRO_RULE_WRITE_100, KIRO_RULE_WRITE_55, KIRO_RULE_WRITE_44, KIRO_RULE_WEB_56, KIRO_RULE_WEB_44, KIRO_DENY_RULE_WEB_55,
} from "./fixtures/kiro-prompt.mjs";

test("a rule's scope menu is a card: each row's name, what it matches as its description", () => {
  for (const screen of [KIRO_RULE_WRITE_100, KIRO_RULE_WRITE_55, KIRO_RULE_WRITE_44]) {
    const parsed = parseKiroPrompt(screen);
    assert.equal(parsed?.question, "Create allow rule: sub.txt");
    assert.deepEqual(labels(parsed), ['Trust "sub.txt"', "Trust entire tool (Write File)"]);
    assert.equal(parsed.selectedIndex, 0);
    assert.match(parsed.options[1].description, /^session$/u);
    assert.match(parsed.body, /^fs_write → sub\.txt\nScope: +\[session\]/u);
    assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["down", "enter"]);
  }
  assert.equal(parseKiroPrompt(KIRO_RULE_WRITE_100).options[0].description, "exact match · session");
});

test("a tool with one rule has a one-row scope menu, and it is a card", () => {
  for (const screen of [KIRO_RULE_WEB_56, KIRO_RULE_WEB_44]) {
    const parsed = parseKiroPrompt(screen);
    assert.equal(parsed?.question, "Create allow rule: web_search");
    assert.deepEqual(labels(parsed), ["Trust entire tool (web_search)"]);
    assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["enter"]);
  }
  assert.deepEqual(labels(parseKiroPrompt(KIRO_DENY_RULE_WEB_55)), ["Deny entire tool (web_search)"]);
});

test("one row is a card only in a scope menu, and the scope menu still ends at its hint", () => {
  const single = kiroApprovalScreen().replace(/ {3}Deny once\n| {3}Create[^\n]*\n/gu, "");
  assert.equal(parseKiroPrompt(single), null, "an approval with one row is not one Kiro draws");
  assert.equal(parseKiroPrompt(`${KIRO_RULE_WEB_56}  Rule created\n`), null);
  assert.equal(parseKiroPrompt(`${KIRO_RULE_WRITE_44}        to\n`), null);
});
