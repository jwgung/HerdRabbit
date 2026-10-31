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
    assert.deepEqual(labels(parsed), ['Trust "sub.txt"', "Trust entire tool (Write File)", "Change scope"]);
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
    assert.deepEqual(labels(parsed), ["Trust entire tool (web_search)", "Change scope"]);
    assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["enter"]);
  }
  assert.deepEqual(labels(parseKiroPrompt(KIRO_DENY_RULE_WEB_55)), ["Deny entire tool (web_search)", "Change scope"]);
});

test("one row is a card only in a scope menu, and the scope menu still ends at its hint", () => {
  const single = kiroApprovalScreen().replace(/ {3}Deny once\n| {3}Create[^\n]*\n/gu, "");
  assert.equal(parseKiroPrompt(single), null, "an approval with one row is not one Kiro draws");
  assert.equal(parseKiroPrompt(`${KIRO_RULE_WEB_56}  Rule created\n`), null);
  assert.equal(parseKiroPrompt(`${KIRO_RULE_WRITE_44}        to\n`), null);
});

// Review of #107: a hint that ends at "to select" has ended; only the scope
// menu's hint ("esc to go back …") goes on past it.
test("output under a hint that ends at 'to select' is output, not the hint's", () => {
  const ended = kiroApprovalScreen().replace(" · Tab to edit", "");
  assert.ok(parseKiroPrompt(ended), "the screen alone is a card");
  for (const tail of [" back\n", " to\n", " s\n", " go back\n", " Enter\n", " ·\n", "  to\n  back\n"]) {
    assert.equal(parseKiroPrompt(`${ended}${tail}`), null, JSON.stringify(tail));
  }
  const trust = kiroTrustScreen().replace(/\n Revoke later[^\n]*/u, "");
  assert.ok(parseKiroPrompt(trust));
  assert.equal(parseKiroPrompt(`${trust} back\n`), null);
});

test("a scope row of its own without a second column is not joined to the row above", () => {
  const screen = KIRO_RULE_WRITE_100.replace(
    '   Trust entire tool (Write File)    session\n',
    '   Trust command prefix\n   Trust entire tool (Write File)    session\n',
  );
  assert.deepEqual(labels(parseKiroPrompt(screen)), ['Trust "sub.txt"', "Trust command prefix", "Trust entire tool (Write File)", "Change scope"]);
});

// The scope menu's own key: s cycles the rule's scope (session → workspace →
// user → session), the cursor staying where it is. The card offers it as its
// last option; it sends s and nothing else, and the card that comes back shows
// the new scope.
test("the scope menu offers changing the scope, as Kiro's s does", () => {
  const parsed = parseKiroPrompt(KIRO_RULE_WRITE_100);
  assert.deepEqual(labels(parsed), ['Trust "sub.txt"', "Trust entire tool (Write File)", "Change scope"]);
  assert.equal(parsed.options[2].description, "session → workspace");
  assert.deepEqual(answerSteps(parsed, { option: 2 }), [{ text: "s" }]);
  // the rows are answered as before
  assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["down", "enter"]);
  assert.deepEqual(labels(parseKiroPrompt(KIRO_RULE_WEB_44)), ["Trust entire tool (web_search)", "Change scope"]);
});

test("the next scope follows the one in brackets, and after user comes session", () => {
  const at = (scope) => KIRO_RULE_WRITE_100.replace("Scope:  [session]   workspace    user",
    { session: "Scope:  [session]   workspace    user", workspace: "Scope:   session   [workspace]   user", user: "Scope:   session    workspace   [user]" }[scope]);
  assert.equal(parseKiroPrompt(at("workspace")).options.at(-1).description, "workspace → user");
  assert.equal(parseKiroPrompt(at("user")).options.at(-1).description, "user → session");
  assert.notEqual(parseKiroPrompt(at("user")).id, parseKiroPrompt(at("session")).id, "another scope is another card");
});

test("only the scope menu has a Change scope option", () => {
  assert.ok(!labels(parseKiroPrompt(kiroApprovalScreen())).includes("Change scope"));
  assert.ok(!labels(parseKiroPrompt(kiroTrustScreen())).includes("Change scope"));
  const noBracket = KIRO_RULE_WRITE_100.replace("[session]", " session ");
  assert.ok(!labels(parseKiroPrompt(noBracket)).includes("Change scope"), "no scope chosen, nothing to cycle");
});

test("Change scope through the service sends s once the same menu is still on screen, and no key", async (context) => {
  const keepAlive = setInterval(() => {}, 1_000);
  context.after(() => clearInterval(keepAlive));
  const scopes = ["session", "workspace", "user"];
  const menu = { scope: 0 };
  const screen = () => KIRO_RULE_WRITE_100.replace("Scope:  [session]   workspace    user",
    ["Scope:  [session]   workspace    user", "Scope:   session   [workspace]   user", "Scope:   session    workspace   [user]"][menu.scope]);
  const sent = [];
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [{ pane_id: "w1:p1", agent: "kiro", agent_status: "blocked" }], agents: [] }; },
    async readPane() { return screen(); },
    async sendKeys(_paneId, pressed) { sent.push(["keys", ...pressed]); },
    async sendText(_paneId, text) { sent.push(["text", text]); if (text === "s") menu.scope = (menu.scope + 1) % scopes.length; },
  };
  const service = new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 300 });
  const card = await service.card("w1:p1");
  assert.equal(card.options.at(-1).label, "Change scope");
  await service.answer("w1:p1", { cardId: card.id, option: card.options.length - 1 });
  assert.deepEqual(sent, [["text", "s"]]);
  assert.equal(scopes[menu.scope], "workspace");
  const next = await service.card("w1:p1");
  assert.notEqual(next.id, card.id);
  assert.equal(next.options.at(-1).description, "workspace → user");
  service.stop();
});

// Review of #109: after s, Kiro redraws the menu a moment later. An answer to
// the same card meanwhile (another device) would pick a row at the new scope.
function slowScopeMenu({ redrawMs }) {
  const menu = { scope: 0 };
  const screen = () => KIRO_RULE_WRITE_100.replace("Scope:  [session]   workspace    user",
    ["Scope:  [session]   workspace    user", "Scope:   session   [workspace]   user", "Scope:   session    workspace   [user]"][menu.scope]);
  const sent = [];
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [{ pane_id: "w1:p1", agent: "kiro", agent_status: "blocked" }], agents: [] }; },
    async readPane() { return screen(); },
    async sendKeys(_paneId, pressed) { sent.push(["keys", ...pressed]); },
    async sendText(_paneId, text) {
      sent.push(["text", text]);
      if (text === "s" && redrawMs !== null) setTimeout(() => { menu.scope = (menu.scope + 1) % 3; }, redrawMs);
    },
  };
  return { herdr, sent, menu };
}

test("an answer to the card right after Change scope, before Kiro redraws, sends nothing", async (context) => {
  const { herdr, sent, menu } = slowScopeMenu({ redrawMs: 80 });
  const service = new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 300 });
  context.after(() => service.stop());
  const card = await service.card("w1:p1");
  const scope = service.answer("w1:p1", { cardId: card.id, option: card.options.length - 1 });
  const row = service.answer("w1:p1", { cardId: card.id, option: 0 });
  assert.deepEqual(await scope, { ok: true, stays: true }, "the page is told the menu is still up");
  await assert.rejects(row, (error) => error.code === "prompt_changed");
  assert.deepEqual(sent, [["text", "s"]]);
  assert.equal(menu.scope, 1);
});

test("a card Change scope did not redraw is refused for a moment", async (context) => {
  const { herdr, sent } = slowScopeMenu({ redrawMs: null });
  const service = new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 60 });
  context.after(() => service.stop());
  const card = await service.card("w1:p1");
  await service.answer("w1:p1", { cardId: card.id, option: card.options.length - 1 });
  await assert.rejects(service.answer("w1:p1", { cardId: card.id, option: 0 }), (error) => error.code === "prompt_changed");
  assert.deepEqual(sent, [["text", "s"]]);
});

test("a Scope line cut off at the pane's edge offers no Change scope", () => {
  for (const cut of ["Scope:  [session]   workspace    us…", "Scope:  [session]   work...", "Scope:   session   [works…]", "Scope:   session   [workspace]"]) {
    const screen = KIRO_RULE_WRITE_100.replace("Scope:  [session]   workspace    user", cut);
    const parsed = parseKiroPrompt(screen);
    assert.ok(parsed, cut);
    assert.ok(!labels(parsed).includes("Change scope"), cut);
  }
});

// Kiro's menu for its subagents' tool approvals (lifelog, 2026-11-01: a phone
// showed the fallback card's Enter/Esc for it). No hint line: under a rule,
// "⚠ N tool approval(s) pending", then rows "(a) …" with the ❯ on one. The
// arrows move the ❯ and Enter picks, as in Kiro's other menus.
import {
  KIRO_SUBAGENT_APPROVAL_161, KIRO_SUBAGENT_APPROVAL_160, KIRO_SUBAGENT_APPROVAL_62,
  KIRO_SUBAGENT_APPROVAL_55, KIRO_SUBAGENT_APPROVAL_44, KIRO_SUBAGENT_APPROVAL_44_DOWN,
  KIRO_SUBAGENT_APPROVAL_SECOND_160, KIRO_SUBAGENT_APPROVAL_SECOND_62, KIRO_SUBAGENT_APPROVAL_SECOND_44, KIRO_SUBAGENT_APPROVAL_SECOND_32,
} from "./fixtures/kiro-prompt.mjs";

const SUBAGENT_ROWS = [
  "Approve all pending",
  "Approve all pending and auto-approve future subagent requests",
  "Configure individually (agent monitor)",
  "Exit (cancel subagents)",
];

test("a subagent's pending tool approval is a card with Kiro's own rows, at any width", () => {
  for (const [name, screen] of Object.entries({
    KIRO_SUBAGENT_APPROVAL_161, KIRO_SUBAGENT_APPROVAL_160, KIRO_SUBAGENT_APPROVAL_62, KIRO_SUBAGENT_APPROVAL_55, KIRO_SUBAGENT_APPROVAL_44,
    KIRO_SUBAGENT_APPROVAL_SECOND_160, KIRO_SUBAGENT_APPROVAL_SECOND_62, KIRO_SUBAGENT_APPROVAL_SECOND_44, KIRO_SUBAGENT_APPROVAL_SECOND_32,
  })) {
    const parsed = parseKiroPrompt(screen);
    assert.equal(parsed?.agent, "kiro", name);
    assert.equal(parsed.kind, "approval", name);
    assert.equal(parsed.question, "1 tool approval pending", name);
    assert.deepEqual(labels(parsed), SUBAGENT_ROWS, name);
    assert.equal(parsed.selectedIndex, 0, name);
    assert.equal(publicCard(parsed).fallback, undefined, name);
  }
});

test("a subagent approval row is answered by moving the cursor onto it, then Enter", () => {
  const parsed = parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_44);
  assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["enter"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 3 })), ["down", "down", "down", "enter"]);
  const moved = parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_44_DOWN);
  assert.equal(moved.selectedIndex, 1);
  assert.equal(moved.id, parsed.id, "a moved cursor is the same card");
  assert.deepEqual(keys(answerSteps(moved, { option: 0 })), ["up", "enter"]);
});

test("a subagent approval that is answered, or has anything else under it, is no card", () => {
  const answered = KIRO_SUBAGENT_APPROVAL_160.replace(/─+\n ⚠[\s\S]*$/u, "");
  assert.equal(parseKiroPrompt(answered), null);
  assert.equal(parseKiroPrompt(`${KIRO_SUBAGENT_APPROVAL_160} Approved 1 tool request\n`), null);
  assert.equal(parseKiroPrompt(`${KIRO_SUBAGENT_APPROVAL_160}›  ask a question\n`), null);
  // the count alone, or one row, is no menu
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_160.replace(/ ❯[\s\S]*$/u, "")), null);
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_160.replace(/\n {3}\(f\)[\s\S]*$/u, "\n")), null);
  // no cursor, or two, is no menu either
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_160.replace(" ❯ (a)", "   (a)")), null);
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_160.replace("   (c)", " ❯ (c)")), null);
  // the count must sit right under Kiro's rule
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_160.replace(/─+\n ⚠/u, "something\n ⚠")), null);
});

test("several pending approvals read the same way", () => {
  const parsed = parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_160.replace("⚠ 1 tool approval pending", "⚠ 3 tool approvals pending"));
  assert.equal(parsed?.question, "3 tool approvals pending");
  assert.deepEqual(labels(parsed), SUBAGENT_ROWS);
});

// Review of #120: the card says which subagent waits on which tool, from the
// agent list above the rule, and another request in its place is another card.
test("a subagent approval card names the subagent and tool it waits on, rebuilt from a narrow column", () => {
  const first = parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_160);
  assert.equal(first.body, "The user explicitly asked t… general-task-execution WebFetch ⚠ tool approval needed");
  // 62 columns cut the status to a column of its own, mid-word
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_62).body, first.body);
  // of three agents, the one waiting
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_161).body, "Ticket #66 (default model a… general-task-execution WebFetch ⚠ tool approval needed");
  const second = parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_SECOND_160);
  assert.equal(second.body, "Delegate fetching example #2 general-task-execution WebFetch ⚠ tool approval needed");
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_SECOND_62).body, second.body);
  assert.notEqual(second.id, first.id, "another request is another card");
  // a pane too narrow for the status column shows none, as Kiro does
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_44).body, null);
  assert.equal(parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_SECOND_32).body, null);
});

test("a row's further line is one the pane wrapped to, even when it starts with a bracket", () => {
  const rule = "─".repeat(30);
  const screen = `• Orchestrating (1 agent)\n  esc to cancel\n${rule}\n ⚠ 1 tool approval pending\n ❯ (a) Approve all pending\n   (c) Configure individually\n   (agent monitor)\n   (x) Exit (cancel\n   subagents)\n`;
  assert.deepEqual(labels(parseKiroPrompt(screen)), ["Approve all pending", "Configure individually (agent monitor)", "Exit (cancel subagents)"]);
  // a short line with room left after it does not go on: what follows is output
  assert.equal(parseKiroPrompt(`${KIRO_SUBAGENT_APPROVAL_160}   npm WARN deprecated foo\n`), null);
  assert.equal(parseKiroPrompt(screen.replace("   (agent monitor)", "\n   (agent monitor)")), null, "a further line sits right under its row");
});

test("a blocked Kiro pane's subagent approval is answered through the service, the cursor checked first", async (context) => {
  const keepAlive = setInterval(() => {}, 1_000);
  context.after(() => clearInterval(keepAlive));
  const menu = { cursor: 0, answered: false };
  const screen = () => menu.answered
    ? KIRO_SUBAGENT_APPROVAL_160.replace(/─+\n ⚠[\s\S]*$/u, "")
    : menu.cursor === 0 ? KIRO_SUBAGENT_APPROVAL_160 : KIRO_SUBAGENT_APPROVAL_160.replace(" ❯ (a)", "   (a)").replace("   (f)", " ❯ (f)");
  const sent = [];
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [{ pane_id: "w1:p1", agent: "kiro", agent_status: menu.answered ? "working" : "blocked" }], agents: [] }; },
    async readPane() { return screen(); },
    async sendKeys(_paneId, pressed) {
      sent.push(...pressed);
      for (const key of pressed) {
        if (key === "down") menu.cursor += 1;
        if (key === "enter") menu.answered = true;
      }
    },
    async sendText() { throw new Error("no text"); },
  };
  const service = new PromptService({ herdr, stepDelayMs: 1, lookMs: 5, settleMs: 300 });
  context.after(() => service.stop());
  const card = await service.card("w1:p1");
  assert.equal(card.fallback, undefined);
  assert.deepEqual(card.options.map((option) => option.label), SUBAGENT_ROWS);
  await service.answer("w1:p1", { cardId: card.id, option: 1 });
  assert.deepEqual(sent, ["down", "enter"]);
  assert.equal(await service.card("w1:p1"), null);
});

// Second review of #120: a status word that ends exactly at its column's edge
// reads like one cut mid-word; the waiting tool is read with the status's
// spaces taken out, so every width shows the same card.
import { KIRO_SUBAGENT_APPROVAL_BY_WIDTH } from "./fixtures/kiro-prompt.mjs";

test("the same subagent request is the same card at every width that shows its status", () => {
  const wide = parseKiroPrompt(KIRO_SUBAGENT_APPROVAL_160);
  for (const [width, screen] of Object.entries(KIRO_SUBAGENT_APPROVAL_BY_WIDTH)) {
    const parsed = parseKiroPrompt(screen);
    assert.deepEqual(labels(parsed), SUBAGENT_ROWS, `width ${width}`);
    assert.equal(parsed.body, wide.body, `width ${width}`);
    assert.equal(parsed.id, wide.id, `width ${width}`);
  }
});
