// OpenCode panes waiting on a prompt, for the prompt card's tests and browser
// check. SOURCE-DERIVED, NOT CAPTURED: these screens are drawn by hand from
// OpenCode 1.18.34's TUI source (github.com/anomalyco/opencode, tag v1.18.34,
// packages/tui/src/routes/session/permission.tsx and question.tsx, with the
// panel's bar from packages/tui/src/ui/border.ts): its strings, its paddings
// and gaps turned into columns and blank rows, and the selected button's
// background in the theme's warning colour (the colour of "△"). The colour
// values themselves are made up; a real screen read with --format ansi is
// still to be compared against these.

// Made-up theme colours, as 24-bit SGR parameters.
const COLOR = Object.freeze({
  warning: "245;167;66",
  error: "224;108;117",
  accent: "157;124;216",
  text: "238;238;238",
  muted: "128;128;128",
  selectedText: "10;10;10",
  panel: "20;20;20",
  element: "30;30;30",
  menu: "40;40;40",
});

const fg = (color) => `\u001b[38;2;${COLOR[color]}m`;
const bg = (color) => `\u001b[48;2;${COLOR[color]}m`;
const RESET = "\u001b[0m";

// A styled run: [text, fg colour, bg colour] → escapes (ansi) or plain text.
function paint(runs, ansi) {
  return runs.map(([text, color, back]) => (ansi && (color || back)
    ? `${color ? fg(color) : ""}${back ? bg(back) : ""}${text}${RESET}`
    : text)).join("");
}

// The panel's row: its bar (in the panel's colour) then the runs.
function row(runs, { ansi, bar }) {
  return paint([["┃", bar], ...runs], ansi);
}

// What the session shows above the panel: an earlier exchange.
const ABOVE = Object.freeze([
  "  Run the tests and tell me what fails.",
  "",
  "  I'll run the test suite first.",
  "",
]);

// A row of buttons, the selected one on the warning colour, then the hints:
// on the same row (`width` columns) or, under 80 columns, on a row of their own.
function buttons(labels, selected, hints, { ansi, width, bar }) {
  const runs = [["  "]];
  labels.forEach((label, index) => {
    if (index > 0) runs.push([" "]);
    const on = index === selected;
    runs.push([` ${label} `, on ? "selectedText" : "muted", on ? "warning" : "menu"]);
  });
  const used = 1 + runs.reduce((sum, [text]) => sum + text.length, 0);
  if (width < 80) return [row(runs, { ansi, bar }), row([], { ansi, bar }), row([["  "], [hints]], { ansi, bar })];
  const gap = Math.max(1, width - used - hints.length - 3);
  return [row([...runs, [" ".repeat(gap)], [hints]], { ansi, bar })];
}

// "△ Permission required" for `title` (with its `icon`), `body` lines under it.
// `body` lines are drawn at the panel's text column (a diff starts one left).
export function opencodePermissionScreen({
  icon = "#", title = "Shell command", body = ["$ npm test"], diff = false,
  selected = 0, width = 100, ansi = true, above = ABOVE,
} = {}) {
  const opts = { ansi, width, bar: "warning" };
  return [
    ...above,
    row([], opts),
    row([["  "], ["△", "warning"], [" Permission required"]], opts),
    row([[`    ${icon} ${title}`]], opts),
    row([], opts),
    ...body.map((line) => row([[`${diff ? " " : "  "}${line}`]], opts)),
    row([], opts),
    row([], opts),
    ...buttons(["Allow once", "Allow always", "Reject"], selected, "ctrl+f fullscreen  ⇆ select  enter confirm", opts),
    row([], opts),
  ].join("\n");
}

// After Allow always: "△ Always allow", what it allows, Confirm / Cancel.
export function opencodeAlwaysScreen({ permission = "bash", patterns = null, selected = 0, width = 100, ansi = true } = {}) {
  const opts = { ansi, width, bar: "warning" };
  const said = patterns
    ? [row([["  This will allow the following patterns until OpenCode is restarted"]], opts), row([], opts),
      ...patterns.map((pattern) => row([[`  - ${pattern}`]], opts))]
    : [row([[`  This will allow ${permission} until OpenCode is restarted.`]], opts)];
  return [
    ...ABOVE,
    row([], opts),
    row([["  "], ["△", "warning"], [" Always allow"]], opts),
    row([], opts),
    ...said,
    row([], opts),
    row([], opts),
    ...buttons(["Confirm", "Cancel"], selected, "⇆ select  enter confirm", opts),
    row([], opts),
  ].join("\n");
}

// A subagent's permission rejected: the message box and its hints.
export function opencodeRejectScreen({ typed = "", width = 100, ansi = true } = {}) {
  const opts = { ansi, width, bar: "error" };
  const hints = "enter confirm  esc cancel";
  return [
    ...ABOVE,
    row([], opts),
    row([["  "], ["△", "error"], [" Reject permission"]], opts),
    row([], opts),
    row([["  Tell OpenCode what to do differently"]], opts),
    row([], opts),
    row([], opts),
    row([[`  ${typed}`.padEnd(width - hints.length - 4)], [hints]], opts),
    row([], opts),
  ].join("\n");
}

export const OPENCODE_OPTIONS = Object.freeze([
  ["ONNX", "Export a portable ONNX model."],
  ["TensorRT", "Build an NVIDIA TensorRT engine."],
]);

// A question from the question tool: `multiple` takes several answers (and
// so has tabs: its header, then Confirm), `tabs` names several questions'
// headers. `checked` ticks rows of a multiple choice; `custom` false drops
// "Type your own answer"; `typing` opens its box.
export function opencodeQuestionScreen({
  question = "Which export format should we use?", options = OPENCODE_OPTIONS, multiple = false,
  tabs = null, checked = [], custom = true, typing = null, ansi = true,
} = {}) {
  const opts = { ansi, bar: "accent" };
  const headers = tabs ?? (multiple ? ["Formats"] : null);
  const enter = multiple ? "toggle" : headers ? "confirm" : "submit";
  const label = (text, index) => (multiple ? `[${checked.includes(index) ? "✓" : " "}] ${text}` : text);
  const rows = options.flatMap(([text, description], index) => [
    row([[`  ${index + 1}. ${label(text, index)}`]], opts),
    row([[`     ${description}`]], opts),
  ]);
  if (custom) {
    rows.push(row([[`  ${options.length + 1}. ${label("Type your own answer", options.length)}`]], opts));
    if (typing !== null) rows.push(row([[`     ${typing || "Type your own answer"}`]], opts));
  }
  return [
    ...ABOVE,
    row([], opts),
    ...(headers ? [row([[`   ${[...headers, "Confirm"].join("   ")}`]], opts), row([], opts)] : []),
    row([[`  ${question}${multiple ? " (select all that apply)" : ""}`]], opts),
    row([], opts),
    ...rows,
    row([], opts),
    row([[`  ${headers ? "⇆ tab  " : ""}↑↓ select  enter ${enter}  esc dismiss`]], opts),
    row([], opts),
  ].join("\n");
}

// The questions' Confirm tab: each header and its answer.
export function opencodeReviewScreen({ headers = ["Formats"], answers = [["ONNX", "TensorRT"]], ansi = true } = {}) {
  const opts = { ansi, bar: "accent" };
  return [
    ...ABOVE,
    row([], opts),
    row([[`   ${[...headers, "Confirm"].join("   ")}`]], opts),
    row([], opts),
    row([["  Review"]], opts),
    ...headers.flatMap((header, index) => [row([], opts), row([[`  ${header}: ${answers[index]?.length ? answers[index].join(", ") : "(not answered)"}`]], opts)]),
    row([], opts),
    row([["  ⇆ tab  enter submit  esc dismiss"]], opts),
    row([], opts),
  ].join("\n");
}

// A fake herdr whose OpenCode panes act on keys as OpenCode's prompts do:
// left/right move the permission's selection (round), Enter picks, Esc
// rejects; a question's digits pick or tick, → leaves for Confirm, whose
// Enter submits. `prompts[paneId]` is the prompt a pane shows.
export function fakeOpencodeHerdr({ panes, prompts = {}, outputs = {} }) {
  const sent = [];
  const answered = [];
  const snapshot = { workspaces: [], tabs: [], panes, agents: [] };
  const finish = (paneId, answer) => {
    answered.push({ paneId, answer });
    delete prompts[paneId];
    outputs[paneId] = "  Done.\n";
    const pane = snapshot.panes.find((item) => item.pane_id === paneId);
    if (pane) pane.agent_status = "working";
  };
  const herdr = {
    sent,
    answered,
    prompts,
    reads: [],
    async snapshot() { return structuredClone(snapshot); },
    async readPane(paneId, options = {}) {
      herdr.reads.push({ paneId, ...options });
      const prompt = prompts[paneId];
      const ansi = options.format === "ansi";
      if (!prompt) return outputs[paneId] ?? "$ ";
      if (prompt.kind === "permission") return opencodePermissionScreen({ ...prompt.screen, selected: prompt.selected ?? 0, ansi });
      if (prompt.kind === "always") return opencodeAlwaysScreen({ ...prompt.screen, selected: prompt.selected ?? 0, ansi });
      if (prompt.kind === "reject") return opencodeRejectScreen({ typed: prompt.typed ?? "", ansi });
      if (prompt.kind === "question") return opencodeQuestionScreen({ ...prompt.screen, checked: prompt.checked ?? [], typing: prompt.typing ?? null, ansi });
      if (prompt.kind === "review") return opencodeReviewScreen({ ...prompt.screen, ansi });
      return "$ ";
    },
    async sendText(paneId, text) {
      sent.push({ paneId, text });
      const prompt = prompts[paneId];
      if (prompt?.kind === "reject") prompt.typed = `${prompt.typed ?? ""}${text}`;
      if (prompt?.kind === "question" && prompt.typing !== undefined && prompt.typing !== null) prompt.typing += text;
      return { ok: true };
    },
    async sendKeys(paneId, keys) {
      sent.push({ paneId, keys: [...keys] });
      for (const key of keys) {
        const prompt = prompts[paneId];
        if (!prompt) break;
        if (prompt.kind === "permission" || prompt.kind === "always") {
          const count = prompt.kind === "permission" ? 3 : 2;
          prompt.selected ??= 0;
          if (key === "right") prompt.selected = (prompt.selected + 1) % count;
          else if (key === "left") prompt.selected = (prompt.selected + count - 1) % count;
          else if (prompt.kind === "permission" && key === "esc") finish(paneId, "reject");
          else if (prompt.kind === "always" && key === "esc") { prompt.kind = "permission"; prompt.selected = 0; }
          else if (key === "enter" && prompt.kind === "permission") {
            if (prompt.selected === 0) finish(paneId, "once");
            else if (prompt.selected === 1) { prompt.kind = "always"; prompt.selected = 0; }
            else finish(paneId, "reject");
          } else if (key === "enter") {
            if (prompt.selected === 0) finish(paneId, "always");
            else { prompt.kind = "permission"; prompt.selected = 0; }
          }
        } else if (prompt.kind === "reject") {
          if (key === "enter") finish(paneId, `reject: ${prompt.typed ?? ""}`);
          else if (key === "esc") { prompt.kind = "permission"; prompt.selected = 0; }
        } else if (prompt.kind === "question") {
          const options = prompt.screen?.options ?? OPENCODE_OPTIONS;
          if (/^[1-9]$/u.test(key)) {
            const index = Number(key) - 1;
            if (index === options.length) { prompt.typing = ""; continue; }
            if (prompt.screen?.multiple) {
              prompt.checked = (prompt.checked ?? []).includes(index)
                ? prompt.checked.filter((item) => item !== index) : [...(prompt.checked ?? []), index].sort();
            } else finish(paneId, options[index]?.[0]);
          } else if (key === "enter" && prompt.typing !== undefined && prompt.typing !== null) finish(paneId, prompt.typing);
          else if (key === "right" && prompt.screen?.multiple) {
            prompts[paneId] = { kind: "review", screen: { answers: [(prompt.checked ?? []).map((index) => options[index][0])] }, picked: prompt.checked ?? [] };
          } else if (key === "esc") finish(paneId, "dismissed");
        } else if (prompt.kind === "review") {
          if (key === "enter") finish(paneId, prompt.screen.answers);
          else if (key === "esc") finish(paneId, "dismissed");
        }
      }
      return { ok: true };
    },
    setStatus(paneId, status) {
      const pane = snapshot.panes.find((item) => item.pane_id === paneId);
      if (pane) pane.agent_status = status;
    },
  };
  return herdr;
}
