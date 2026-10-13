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

// An in-process herdr with panes, each either a menu or plain output.
// `menus[paneId]` = { command, rows, cursor }; keys move it, Enter answers
// it (the pane goes back to work), Esc dismisses it.
export function fakePromptHerdr({ panes, agents = [], menus = {}, outputs = {} }) {
  const sent = [];
  const answered = [];
  const snapshot = { workspaces: [], tabs: [], panes, agents };
  const statusOf = (paneId) => agents.find((agent) => agent.pane_id === paneId) ?? panes.find((pane) => pane.pane_id === paneId);
  const herdr = {
    sent,
    answered,
    menus,
    outputs,
    reads: [],
    async snapshot() { return structuredClone(snapshot); },
    async readPane(paneId, options = {}) {
      herdr.reads.push({ paneId, ...options });
      const menu = menus[paneId];
      return menu ? approvalScreen(menu) : outputs[paneId] ?? "$ ";
    },
    async sendKeys(paneId, keys) {
      sent.push({ paneId, keys: [...keys] });
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
