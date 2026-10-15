// Screens adapted from herdr-web-ui's server/prompt.test.ts (MIT, Copyright
// (c) 2026 devswha), most of them captured live from Claude Code 2.1.
import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudePrompt } from "../src/prompt/claude.mjs";
import { parseFallbackPrompt } from "../src/prompt/fallback.mjs";
import { answerSteps, publicCard } from "../src/prompt/screen.mjs";
import { indexAtColumn, stringWidth } from "../src/prompt/text-width.mjs";
import { approvalScreen, questionScreen } from "./fixtures/claude-prompt.mjs";

const labels = (parsed) => parsed?.options.map((option) => option.label);
const keys = (steps) => steps.flatMap((step) => step.keys ?? [`text:${step.text}`]);

test("reads an approval: Yes / Yes, and don't ask again / No, with the command as its body", () => {
  const parsed = parseClaudePrompt(approvalScreen());
  assert.equal(parsed.kind, "approval");
  assert.equal(parsed.title, "Bash command");
  assert.equal(parsed.question, "Do you want to proceed?");
  assert.equal(parsed.body, "npm test\nRun the test suite");
  assert.deepEqual(labels(parsed), ["Yes", "Yes, and don't ask again for: npm test", "No"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 0 })), ["enter"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 1 })), ["down", "enter"]);
  assert.deepEqual(keys(answerSteps(parsed, { option: 2 })), ["down", "down", "enter"]);
  // from the cursor where it stands
  assert.deepEqual(keys(answerSteps(parseClaudePrompt(approvalScreen({ cursor: 2 })), { option: 0 })), ["up", "up", "enter"]);
  assert.throws(() => answerSteps(parsed, { option: 3 }), /valid option/);
  assert.throws(() => answerSteps(parsed, { text: "maybe" }), /typed answer/);
});

test("the card id stays while the cursor moves and changes with the command", () => {
  const first = parseClaudePrompt(approvalScreen()).id;
  assert.equal(parseClaudePrompt(approvalScreen()).id, first);
  assert.equal(parseClaudePrompt(approvalScreen({ cursor: 2 })).id, first);
  assert.notEqual(parseClaudePrompt(approvalScreen({ command: "rm -rf build" })).id, first);
  assert.notEqual(parseClaudePrompt(approvalScreen({ rows: ["Yes", "No"] })).id, first);
  // a difference past the display cap still counts
  const long = "x".repeat(12_100);
  assert.notEqual(parseClaudePrompt(approvalScreen({ command: `${long}a` })).id, parseClaudePrompt(approvalScreen({ command: `${long}b` })).id);
});

test("public cards leave out the reader's bookkeeping", () => {
  const card = publicCard(parseClaudePrompt(approvalScreen()));
  assert.deepEqual(Object.keys(card).sort(), ["agent", "body", "checked", "customOptionIndex", "id", "kind", "multiSelect", "options", "question", "title"]);
  assert.equal(publicCard(null), null);
});

test("reads the older approval markers and a plan", () => {
  const approval = parseClaudePrompt(`
Bash command

  curl -I https://example.com
  Fetch HTTP headers.

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don’t ask again for: curl *
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain
`);
  assert.equal(approval.kind, "approval");
  assert.equal(approval.title, "Fetch HTTP headers.");
  assert.deepEqual(labels(approval), ["Yes", "Yes, and don’t ask again for: curl *", "No"]);

  const plan = parseClaudePrompt(`
Ready to code?

Here is Claude's plan:
Add a heading to the README file.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, refine with Ultraplan on Claude Code on the web
  4. Tell Claude what to change
     shift+tab to approve with this feedback
`);
  assert.equal(plan.kind, "plan");
  assert.equal(plan.customOptionIndex, 3);
  assert.match(plan.body, /Add a heading/);
  assert.deepEqual(answerSteps(plan, { text: "Keep the introduction" }), [
    { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { text: "Keep the introduction" }, { keys: ["shift+tab"] },
  ]);
});

test("reads Claude Code 2.1 approvals for a file, an MCP tool, and a label wrapped by a narrow pane", () => {
  const write = parseClaudePrompt(`
● Write(hello.txt)
────────────────────────────────────────
 Create file
 hello.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 hi
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create hello.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)
   3. No
 Esc to cancel · Tab to amend
`);
  assert.equal(write.title, "Create file");
  assert.equal(write.question, "Do you want to create hello.txt?");
  assert.equal(write.body, "hello.txt\n1 hi");

  const mcp = parseClaudePrompt(`
● github - create_issue (MCP)(title: "Flaky test")
────────────────────────────────────────
 Tool use
   github - create_issue(title: "Flaky test")
────────────────────────────────────────
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
  assert.equal(mcp.title, "Tool use");

  const wrapped = parseClaudePrompt(`
────────────────────────────────────────
 Bash command
   rm -rf junk
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
   /tmp/prompt-lab/junk from this project
   3. No
 Esc to cancel · Tab to amend
`);
  assert.deepEqual(labels(wrapped), ["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "No"]);
});

test("an approval answered above another program's prompt is no card", () => {
  const rule = "─".repeat(80);
  assert.equal(parseClaudePrompt([rule, " Bash command", " sudo -v", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "",
    " Esc to cancel · Tab to amend", "Password:", "Esc to cancel", ""].join("\n")), null);
  // and output after it means it was answered
  assert.equal(parseClaudePrompt(`${approvalScreen()}\n● Ran the tests.\n\n❯ `), null);
});

test("reads an AskUserQuestion with descriptions, a typed answer and its chip", () => {
  const screen = `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. T-LESS
     Texture-less objects.
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const question = parseClaudePrompt(screen);
  assert.equal(question.kind, "question");
  assert.equal(question.title, "Dataset");
  assert.equal(question.question, "Which evaluation dataset should we use?");
  assert.equal(question.multiSelect, false);
  assert.equal(question.customOptionIndex, 3);
  assert.deepEqual(labels(question), ["LM-O", "YCB-V", "T-LESS"]);
  assert.equal(question.options[0].description, "Occlusion benchmark.");
  assert.deepEqual(keys(answerSteps(question, { option: 2 })), ["down", "down", "enter"]);
  assert.deepEqual(keys(answerSteps(question, { text: "HOPE" })), ["down", "down", "down", "text:HOPE", "enter"]);
  for (const text of ["HOPE\rnow", "a\nb", "\u001b[A", "stop\u0003", "x\u009b1"]) {
    assert.throws(() => answerSteps(question, { text }), /control characters/, JSON.stringify(text));
  }
  assert.throws(() => answerSteps(question, { option: 3 }), /valid option/);
});

test("reads question tabs, a multiple choice, and the review of the answers", () => {
  const first = parseClaudePrompt(`
←  ☐ Route  ☐ Author  ✔ Submit  →
Which way should the PR go?
❯ 1. Log in as owner
     Authenticate as the repository owner and open the PR directly on the repo.
  2. Fork
     Push the branch to a fork and open the PR from there.
  3. Type something.
────────────────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
  assert.equal(first.title, "Route · 1 of 2");
  assert.deepEqual(labels(first), ["Log in as owner", "Fork"]);

  const sets = parseClaudePrompt(`
←  ☒ Route  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
         Include the LM-O dataset.
  2. [ ] YCB-V
         Include the YCB-V dataset.
  3. [ ] T-LESS
         Include the T-LESS dataset.
  4. [ ] Type something
     Next
────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
  assert.equal(sets.title, "Sets · 2 of 2");
  assert.equal(sets.multiSelect, true);
  assert.equal(sets.customOptionIndex, null);
  // → moves on: an Enter on the next tab would pick its first option
  assert.deepEqual(keys(answerSteps(sets, { options: [0, 2] })), ["enter", "down", "down", "enter", "right"]);
  assert.throws(() => answerSteps(sets, { option: 0 }), /valid option/);

  const review = parseClaudePrompt(`
←  ☒ Route  ☒ Author  ✔ Submit  →
Review your answers
 ● Which way should the PR go?
   → Log in as owner
 ● Who should author the commits?
   → Repo owner
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`);
  assert.equal(review.kind, "menu");
  assert.equal(review.title, "Review your answers");
  assert.match(review.body, /→ Repo owner/);
  assert.deepEqual(labels(review), ["Submit answers", "Cancel"]);

  // newer Claude Code puts its key hint under the review's rows; still the card
  const hinted = parseClaudePrompt(`
←  ☒ Route  ☒ Author  ✔ Submit  →
Review your answers
 ● Which way should the PR go?
   → Log in as owner
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
  assert.equal(hinted?.title, "Review your answers");
  assert.deepEqual(labels(hinted), ["Submit answers", "Cancel"]);
  // but anything else after the rows means the review has gone
  assert.equal(parseClaudePrompt(`
←  ☒ Route  ✔ Submit  →
Review your answers
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
⏺ Answers submitted, carrying on
`), null);
  // nor when a later prompt ends the screen with its own "Esc to cancel"
  const finished = `
←  ☒ Route  ✔ Submit  →
Review your answers
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`;
  assert.notEqual(parseClaudePrompt(`${finished}⏺ later output\nEsc to cancel\n`)?.responder, "claude-submit");
  const trust = parseClaudePrompt(`${finished}⏺ Answers submitted
Do you trust the files in this folder?
❯ 1. Yes, proceed
  2. No, exit
Enter to confirm · Esc to cancel
`);
  assert.notEqual(trust?.title, "Review your answers", "a finished review came back over a trust prompt");
});

test("a multiple choice ticked in the terminal unticks only what is not wanted", () => {
  const screen = (ticked, at) => [
    `←  ${ticked ? "☒" : "☐"} Pick  ✔ Submit  →`,
    "Which ones?",
    `${at === "A" ? "❯" : " "} 1. [${ticked ? "✔" : " "}] Option A`,
    "         First description",
    `${at === "B" ? "❯" : " "} 2. [${ticked ? "✔" : " "}] Option B`,
    "         Second description",
    "  3. [ ] Type something",
    `${at === "Submit" ? "❯" : " "}    Submit`,
    "─".repeat(40),
    `${at === "Chat" ? "❯" : " "} 4. Chat about this`,
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const prompt = parseClaudePrompt(screen(true, "B"));
  assert.deepEqual(labels(prompt), ["Option A", "Option B"]);
  assert.deepEqual(keys(answerSteps(prompt, { options: [0] })), ["enter", "right"]);
  assert.deepEqual(keys(answerSteps(parseClaudePrompt(screen(true, "Submit")), { options: [0] })), ["up", "up", "enter", "right"]);
  assert.deepEqual(keys(answerSteps(parseClaudePrompt(screen(false, "Chat")), { options: [0] })), ["up", "up", "up", "up", "enter", "right"]);
});

test("a multiple choice's ticks travel with its card, and an answer keeps, adds or removes them", () => {
  const ticked = parseClaudePrompt(questionScreen({ checked: [0, 1], cursor: 1 }));
  assert.deepEqual(publicCard(ticked).checked, [0, 1]);
  assert.deepEqual(publicCard(parseClaudePrompt(questionScreen())).checked, []);
  assert.deepEqual(publicCard(parseClaudePrompt(approvalScreen())).checked, []);
  // keep: only → goes
  assert.deepEqual(keys(answerSteps(ticked, { options: [1, 0] })), ["right"]);
  // add
  assert.deepEqual(keys(answerSteps(ticked, { options: [0, 1, 2] })), ["down", "enter", "right"]);
  // remove
  assert.deepEqual(keys(answerSteps(ticked, { options: [1] })), ["up", "enter", "right"]);
  // remove one, add another
  assert.deepEqual(keys(answerSteps(ticked, { options: [0, 2] })), ["enter", "down", "enter", "right"]);
  assert.throws(() => answerSteps(ticked, { options: [] }), /one or more/);
});

test("a tick leaves a multiple choice the same prompt between an answer's keys", () => {
  const before = parseClaudePrompt(questionScreen());
  const after = parseClaudePrompt(questionScreen({ checked: [0] }));
  // the tab is marked answered, so the card reads (and is told) anew
  assert.notEqual(after.id, before.id);
  assert.equal(after.promptKey, before.promptKey);
  assert.notEqual(parseClaudePrompt(questionScreen({ question: "Which models?" })).promptKey, before.promptKey);
  const approval = parseClaudePrompt(approvalScreen());
  assert.equal(approval.promptKey, approval.id);
});

test("reads a Korean question in a narrow pane whose hint wrapped", () => {
  const narrow = `────────────────────────────────────────────
 ☐ 재현 테스트

│ 재현용 테스트 질문입니다. 지금 이 질문
│ 화면을 백그라운드에서 캡처하고 있으니,
│ 15초쯤 기다렸다가 아무거나 골라 주세요.

❯ 1. 채팅에 카드가 안 떠요
     채팅 모드에 이 질문이 보이지 않음
  2. 채팅에 카드가 떠요
     채팅 모드에 이 질문이 카드로 보임
  3. Type something.
────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to
cancel
`;
  const prompt = parseClaudePrompt(narrow);
  assert.equal(prompt.title, "재현 테스트");
  assert.deepEqual(labels(prompt), ["채팅에 카드가 안 떠요", "채팅에 카드가 떠요"]);
  assert.match(prompt.question, /^재현용 테스트 질문입니다\./);
  assert.equal(parseClaudePrompt(`${narrow}\n● Done.\n\n> `), null);
});

test("reads the question, not a numbered message sent earlier, and not a numbered line in a description", () => {
  const prompt = parseClaudePrompt(`
❯ 1. 로그인해서 커넥트 눌럿어

⏺ Tailscale 로그인은 완료됐습니다.
────────────────────────────────────────────────────────────
 ☐ Buzz 공개

│ Buzz를 Tailscale 없이 인터넷에서 쓰도록 공개할까요?

❯ 1. 공개 진행 (추천)
     Cloudflare Tunnel로 엽니다.
  2. Tailscale 유지
     지금 구성 그대로 갑니다(이미 동작 중).
  3. Type something.
────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
─────────────────────────────────────────── Buzz 슬랙 대체 AI 조사 ─
`);
  assert.equal(prompt.title, "Buzz 공개");
  assert.deepEqual(labels(prompt), ["공개 진행 (추천)", "Tailscale 유지"]);
  assert.deepEqual(keys(answerSteps(prompt, { option: 1 })), ["down", "enter"]);

  const setup = parseClaudePrompt(`
 ☐ Setup

How should we set up?

  1. Script
     Runs these steps:
     1. Install deps
❯ 2. Manual
     Follow the guide.
  3. Type something.
────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
  assert.deepEqual(labels(setup), ["Script", "Manual"]);
  assert.deepEqual(keys(answerSteps(setup, { option: 0 })), ["up", "enter"]);
});

test("cuts an option preview off at its terminal column, with wide characters and joined emoji", () => {
  const withPreview = `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ Layout  ☐ Features  ✔ Submit  →

Which layout?

❯ 1. Grid                         ┌──────────────────────────────────────────┐
  2. List                         │ ┌──┐ ┌──┐                                │
                                  │ │  │ │  │                                │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel
`;
  const prompt = parseClaudePrompt(withPreview);
  assert.equal(prompt.title, "Layout · 1 of 2");
  assert.deepEqual(prompt.options, [{ label: "Grid", description: null }, { label: "List", description: null }]);
  assert.equal(prompt.customOptionIndex, null);
  const relabel = (screen, from, to) => {
    assert.ok(screen.includes(from));
    return screen.replace(from, to + " ".repeat(stringWidth(from) - stringWidth(to)));
  };
  const wide = relabel(relabel(withPreview, "❯ 1. Grid                         ", "❯ 1. 격자 보기"), "  2. List                         ", "  2. 目录列表  │ 宽");
  assert.deepEqual(labels(parseClaudePrompt(wide)), ["격자 보기", "目录列表  │ 宽"]);
  const emoji = relabel(withPreview, "❯ 1. Grid                         ", "❯ 1. 👩‍💻 Code");
  assert.deepEqual(labels(parseClaudePrompt(emoji)), ["👩‍💻 Code", "List"]);
});

test("counts terminal columns by East Asian width", () => {
  assert.equal(stringWidth("abc"), 3);
  assert.equal(stringWidth("한글"), 4);
  assert.equal(stringWidth("目录"), 4);
  assert.equal(stringWidth("👩‍💻"), 2);
  assert.equal(stringWidth("é"), 1);
  assert.equal(stringWidth("a​b"), 2);
  assert.equal(indexAtColumn("한a", 2), 1);
  assert.equal(indexAtColumn("한a", 1), -1);
});

test("reads the question over Claude's task list and session rule", () => {
  const question = `────────────────────────────────────────
←  ☐ 방향 검토  ☐ 문구  ✔ Submit  →

검토용 목업 페이지를 만들까요?

❯ 1. 만들지 않음 (Recommended)
     조건과 문구만 바뀌어 테스트로 확인 가능.
  2. 만듦
     목업으로 먼저 보고 확정한 뒤 구현.
  3. Type something.
────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;
  const tasks = (rows) => `────────────────────────────── 세션 이름 ─\n\n${rows}\n`;
  for (const rows of ["", "  3 tasks (0 done, 3 open)\n  ◻ 준비\n  ◻ 구현\n  ◻ 검증"]) {
    assert.deepEqual(labels(parseClaudePrompt(question + tasks(rows))), ["만들지 않음 (Recommended)", "만듦"]);
  }
  assert.equal(parseClaudePrompt(`${question}\n⏺ Done.\n──── user@host:~/project ─\n`), null);
});

test("reads Claude's unnumbered menus, answered from the cursor", () => {
  const trust = (selected = 0, after = "") => `
❯ claude

────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/user/projects/new-app

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this folder

 Enter to confirm · Esc to cancel
${after}`;
  const prompt = parseClaudePrompt(trust());
  assert.equal(prompt.kind, "menu");
  assert.equal(prompt.title, "Accessing workspace");
  assert.equal(prompt.question, "Is this a project you created or one you trust?");
  assert.deepEqual(labels(prompt), ["No, exit", "Yes, I trust this folder"]);
  assert.deepEqual(keys(answerSteps(prompt, { option: 1 })), ["down", "enter"]);
  assert.equal(parseClaudePrompt(trust(1)).id, prompt.id);
  assert.equal(parseClaudePrompt(trust(1, " ▐▛███▛█   Claude Code v2.1.285\n❯ Try \"fix typecheck errors\"\n")), null);
});

test("ordinary output and password prompts are no card", () => {
  assert.equal(parseClaudePrompt("No response requested. The task is complete."), null);
  assert.equal(parseClaudePrompt(""), null);
  assert.equal(parseClaudePrompt("[sudo] password for me:"), null);
  assert.equal(parseFallbackPrompt("Running sudo\n[sudo] password for me:"), null);
});

test("the fallback card offers the screen's own keys and Enter / Esc", () => {
  const yesNo = parseFallbackPrompt("Overwrite the config?\nContinue? (y/n)");
  assert.equal(yesNo.fallback, true);
  assert.equal(yesNo.question, "Continue? (y/n)");
  assert.deepEqual(labels(yesNo), ["Yes (y)", "No (n)", "Enter", "Esc"]);
  assert.deepEqual(answerSteps(yesNo, { option: 0 }), [{ text: "y" }]);
  assert.deepEqual(answerSteps(yesNo, { option: 3 }), [{ keys: ["esc"] }]);

  const menu = parseFallbackPrompt("Pick a target?\n  1. Staging\n  2. Production\n  3. Cancel\nEnter a number to choose");
  assert.deepEqual(labels(menu), ["Staging", "Production", "Cancel", "Enter", "Esc"]);
  assert.deepEqual(answerSteps(menu, { option: 1 }), [{ text: "2" }]);

  const plain = parseFallbackPrompt("Something happened\nPress any key");
  assert.deepEqual(labels(plain), ["Enter", "Esc"]);
  assert.equal(publicCard(plain).fallback, true);
  // the id follows the screen, not Claude's ticking working line
  const working = (time) => `✻ Tempering… (${time} · ↓ 10.0k tokens)\nPress any key`;
  assert.equal(parseFallbackPrompt(working("1m 5s")).id, parseFallbackPrompt(working("1m 6s")).id);
  assert.notEqual(parseFallbackPrompt("A\nPress any key").id, parseFallbackPrompt("B\nPress any key").id);
});

test("no fallback card over Claude's model list, whose Enter would save a default", () => {
  assert.equal(parseFallbackPrompt(" Select model\n ❯ 1. Opus\n   2. Sonnet\n\n Enter to set as default · s to use this session only · Esc to cancel"), null);
});

test("a blank screen, caught mid-redraw, is no fallback card", () => {
  for (const screen of ["", "\n\n   \n", "\u001b[2J\u001b[H\n\n"]) assert.equal(parseFallbackPrompt(screen), null, JSON.stringify(screen));
});
