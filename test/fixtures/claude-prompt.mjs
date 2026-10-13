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

// An in-process herdr with panes, each either a menu or plain output.
// `menus[paneId]` = { command, rows, cursor }; keys move it, Enter answers
// it (the pane goes back to work), Esc dismisses it. `questions[paneId]` =
// { question, rows, checked, cursor } is a multiple choice: Enter ticks or
// unticks the row, → answers it with the ticked rows. `snapshots` counts the
// snapshots asked for.
export function fakePromptHerdr({ panes, agents = [], menus = {}, outputs = {}, questions = {} }) {
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
    reads: [],
    snapshots: 0,
    async snapshot() { herdr.snapshots += 1; return structuredClone(snapshot); },
    async readPane(paneId, options = {}) {
      herdr.reads.push({ paneId, ...options });
      const menu = menus[paneId];
      if (questions[paneId]) return questionScreen(questions[paneId]);
      return menu ? approvalScreen(menu) : outputs[paneId] ?? "$ ";
    },
    async sendKeys(paneId, keys) {
      sent.push({ paneId, keys: [...keys] });
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
        const rows = menu.rows ?? APPROVAL_ROWS;
        if (key === "down") menu.cursor = Math.min(rows.length - 1, menu.cursor + 1);
        else if (key === "up") menu.cursor = Math.max(0, menu.cursor - 1);
        else if (key === "enter" || key === "esc") {
          answered.push({ paneId, answer: key === "enter" ? rows[menu.cursor] : "esc" });
          delete menus[paneId];
          outputs[paneId] = `● ${key === "enter" ? "Running npm test" : "Cancelled"}\n`;
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
