// Codex panes blocked on a prompt, for the prompt card's tests and browser
// check: the screens Codex 0.146-0.156 draws (adapted from herdr-web-ui's
// server/prompt.test.ts, MIT, Copyright (c) 2026 devswha).

export const CODEX_APPROVAL_ROWS = Object.freeze([
  "Yes, proceed (y)",
  "Yes, and don't ask again for commands that start with npm",
  "No, and tell Codex what to do differently (esc)",
]);

// "Would you like to run the following command?" with the command, its rows
// and the hint under them.
export function codexApprovalScreen({ command = "npm test", rows = CODEX_APPROVAL_ROWS, cursor = 0 } = {}) {
  return [
    "• Running the tests",
    "",
    "Would you like to run the following command?",
    "",
    "Environment: local",
    `$ ${command}`,
    "",
    ...rows.map((row, index) => `${index === cursor ? "›" : " "} ${index + 1}. ${row}`),
    "",
    "Press enter to confirm or esc to cancel",
    "",
  ].join("\n");
}

export const CODEX_QUESTION_ROWS = Object.freeze([
  ["ONNX", "Export a portable ONNX model."],
  ["TensorRT", "Build an NVIDIA TensorRT engine."],
  ["None of the above", "Optionally, add details in notes (tab)."],
]);

// A plan-mode question with its options' descriptions in a second column.
export function codexQuestionScreen({ question = "Which export format should we use?", rows = CODEX_QUESTION_ROWS, cursor = 0 } = {}) {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return [
    "Question 1/1 (1 unanswered)",
    question,
    "",
    ...rows.map(([label, description], index) => `${index === cursor ? "›" : " "} ${index + 1}. ${label.padEnd(width)}${description}`),
    "",
    "tab to add notes | enter to submit answer | esc to interrupt",
    "",
  ].join("\n");
}
