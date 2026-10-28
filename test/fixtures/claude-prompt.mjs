import { CODEX_APPROVAL_ROWS, codexApprovalScreen } from "./codex-prompt.mjs";

// A Claude pane blocked on a tool approval, for the prompt card's tests and
// browser check: the screen Claude Code 2.1 draws, a cursor that the keys
// move, and every key and text that reached the pane.

export const APPROVAL_ROWS = Object.freeze(["Yes", "Yes, and don't ask again for: npm test", "No"]);

export function approvalScreen({ command = "npm test", description = "Run the test suite", rows = APPROVAL_ROWS, cursor = 0 } = {}) {
  return [
    "● Bash(npm test)",
    "",
    "─".repeat(60),
    " Bash command",
    "",
    `   ${command}`,
    `   ${description}`,
    "",
    " Do you want to proceed?",
    ...rows.map((row, index) => ` ${index === cursor ? "❯" : " "} ${index + 1}. ${row}`),
    "",
    " Esc to cancel · Tab to amend",
    "",
  ].join("\n");
}

export const QUESTION_ROWS = Object.freeze(["LM-O", "YCB-V", "T-LESS"]);

// Claude's multiple choice: ticked rows show [✔], and a tick marks the
// question's tab answered (☒).
export function questionScreen({ question = "Which datasets?", rows = QUESTION_ROWS, checked = [], cursor = 0 } = {}) {
  const ticked = new Set(checked);
  return [
    `←  ${ticked.size > 0 ? "☒" : "☐"} Sets  ✔ Submit  →`,
    question,
    ...rows.flatMap((row, index) => [
      `${index === cursor ? "❯" : " "} ${index + 1}. [${ticked.has(index) ? "✔" : " "}] ${row}`,
      `         Include the ${row} dataset.`,
    ]),
    `${cursor === rows.length ? "❯" : " "} ${rows.length + 1}. [ ] Type something`,
    "     Next",
    "─".repeat(40),
    `  ${rows.length + 2}. Chat about this`,
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
    "",
  ].join("\n");
}

export const ASK_ROWS = Object.freeze(["Keep the cache", "Drop the cache"]);
// What Claude wrote before asking, as the terminal draws it: its bullet, a
// table, a line with markup that must stay text. Synthetic.
export const ASK_MESSAGE = Object.freeze([
  "● The cache audit is done. Two stores still disagree:",
  "",
  "  ┌─────────┬──────────┬──────────┐",
  "  │ Store   │ Entries  │ Stale    │",
  "  ├─────────┼──────────┼──────────┤",
  "  │ north   │ 1200     │ 14       │",
  "  │ south   │ 980      │ 0        │",
  "  └─────────┴──────────┴──────────┘",
  "",
  "  The literal tag <b>x</b> is shown as text.",
  "  Dropping the cache costs one cold start.",
]);

// Claude's AskUserQuestion with one choice, the message it wrote before it
// above the question's rule, and the "Chat about this" row under its own
// rule. `cursor` counts every row: the options, "Type something.", then
// "Chat about this".
export function askScreen({ message = ASK_MESSAGE, header = "Cache", question = "Keep or drop the cache?", rows = ASK_ROWS, cursor = 0 } = {}) {
  const mark = (index) => index === cursor ? "❯" : " ";
  return [
    "❯ audit the caches",
    "",
    ...message,
    "",
    "─".repeat(60),
    ` ☐ ${header}`,
    "",
    question,
    "",
    ...rows.flatMap((row, index) => [`${mark(index)} ${index + 1}. ${row}`, `     ${row} for every store.`]),
    `${mark(rows.length)} ${rows.length + 1}. Type something.`,
    "─".repeat(60),
    `${mark(rows.length + 1)} ${rows.length + 2}. Chat about this`,
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
    "",
  ].join("\n");
}

// An in-process herdr with panes, each either a menu or plain output.
// `menus[paneId]` = { command, rows, cursor }; keys move it, Enter answers
// it (the pane goes back to work), Esc dismisses it; `agent: "codex"` draws it
// as Codex's approval. `questions[paneId]` =
// { question, rows, checked, cursor } is a multiple choice: Enter ticks or
// unticks the row, → answers it with the ticked rows. `asks[paneId]` =
// askScreen's options: Enter on an option or on "Chat about this" answers it.
// `snapshots` counts the snapshots asked for.
export function fakePromptHerdr({ panes, agents = [], menus = {}, outputs = {}, questions = {}, asks = {} }) {
  const sent = [];
  const answered = [];
  const snapshot = { workspaces: [], tabs: [], panes, agents };
  const statusOf = (paneId) => agents.find((agent) => agent.pane_id === paneId) ?? panes.find((pane) => pane.pane_id === paneId);
  const herdr = {
    sent,
    answered,
    menus,
    outputs,
    questions,
    asks,
    reads: [],
    snapshots: 0,
    async snapshot() { herdr.snapshots += 1; return structuredClone(snapshot); },
    async readPane(paneId, options = {}) {
      herdr.reads.push({ paneId, ...options });
      const menu = menus[paneId];
      if (questions[paneId]) return questionScreen(questions[paneId]);
      if (asks[paneId]) return askScreen(asks[paneId]);
      if (menu?.agent === "codex") return codexApprovalScreen(menu);
      return menu ? approvalScreen(menu) : outputs[paneId] ?? "$ ";
    },
    async sendKeys(paneId, keys) {
      sent.push({ paneId, keys: [...keys] });
      const ask = asks[paneId];
      if (ask) {
        const rows = ask.rows ?? ASK_ROWS;
        ask.cursor ??= 0;
        for (const key of keys) {
          if (key === "down") ask.cursor = Math.min(rows.length + 1, ask.cursor + 1);
          else if (key === "up") ask.cursor = Math.max(0, ask.cursor - 1);
          else if (key === "enter" && ask.cursor !== rows.length) {
            answered.push({ paneId, answer: ask.cursor < rows.length ? rows[ask.cursor] : "Chat about this" });
            delete asks[paneId];
            outputs[paneId] = "● Fine, let us talk it over.\n";
            herdr.setStatus(paneId, "working");
            break;
          }
        }
        return;
      }
      const asked = questions[paneId];
      if (asked) {
        const rows = asked.rows ?? QUESTION_ROWS;
        asked.checked ??= [];
        asked.cursor ??= 0;
        for (const key of keys) {
          if (key === "down") asked.cursor = Math.min(rows.length, asked.cursor + 1);
          else if (key === "up") asked.cursor = Math.max(0, asked.cursor - 1);
          else if (key === "enter" && asked.cursor < rows.length) {
            asked.checked = asked.checked.includes(asked.cursor)
              ? asked.checked.filter((index) => index !== asked.cursor) : [...asked.checked, asked.cursor].sort();
          } else if (key === "right") {
            answered.push({ paneId, answer: asked.checked.map((index) => rows[index]) });
            delete questions[paneId];
            outputs[paneId] = "● Thanks\n";
            herdr.setStatus(paneId, "working");
            break;
          }
        }
        return;
      }
      const menu = menus[paneId];
      if (!menu) return;
      for (const key of keys) {
        const rows = menu.rows ?? (menu.agent === "codex" ? CODEX_APPROVAL_ROWS : APPROVAL_ROWS);
        if (key === "down") menu.cursor = Math.min(rows.length - 1, menu.cursor + 1);
        else if (key === "up") menu.cursor = Math.max(0, menu.cursor - 1);
        else if (key === "enter" || key === "esc") {
          answered.push({ paneId, answer: key === "enter" ? rows[menu.cursor] : "esc" });
          delete menus[paneId];
          outputs[paneId] = `${menu.agent === "codex" ? "•" : "●"} ${key === "enter" ? "Running npm test" : "Cancelled"}\n`;
          const record = statusOf(paneId);
          if (record) record[("agent_status" in record) ? "agent_status" : "state"] = "working";
          break;
        }
      }
    },
    async sendText(paneId, text) { sent.push({ paneId, text }); },
    setStatus(paneId, status) {
      const record = statusOf(paneId);
      if (record) record[("agent_status" in record) ? "agent_status" : "state"] = status;
    },
  };
  return herdr;
}
