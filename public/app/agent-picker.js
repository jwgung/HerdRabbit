import { createElement } from "./dom.js?v=1.4.31";
import { sessionAgentChoices } from "../agents.js?v=1.4.31";

// The Agent choice of the New tab and New workspace dialogs: a fieldset of
// radio buttons, Shell first and then each installed agent, each with its
// program's mark, which a select cannot show. The choices go in the
// fieldset's .agent-choices box, under its legend. The fieldset is the control:
// disabling it disables every choice, and a choice's change event reaches it.
// `agentMark(kind)` draws a mark; "shell" is the shell's.
export function createAgentPicker(fieldset, { agentMark }) {
  const name = `${fieldset.id}-choice`;
  const box = fieldset.querySelector(".agent-choices");

  function choices() {
    return [...fieldset.querySelectorAll('input[type="radio"]')];
  }

  // The agent chosen, "" for a shell.
  function value() {
    return choices().find((input) => input.checked)?.value ?? "";
  }

  // The choices for `installed` agent names, `wanted` chosen when it is one of
  // them, else Shell.
  function fill(installed, wanted = "") {
    const options = sessionAgentChoices(installed);
    const chosen = options.some((option) => option.value === wanted) ? wanted : "";
    box.replaceChildren();
    for (const option of options) {
      const input = createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = option.value;
      // Not defaultChecked: a form's reset clears the choice, so the dialog
      // chooses again when it next fills (none chosen reads as Shell).
      input.checked = option.value === chosen;
      const label = createElement("label", { className: "agent-choice" });
      label.dataset.agent = option.value || "shell";
      label.append(input, agentMark(option.value || "shell"), createElement("span", { text: option.label }));
      box.append(label);
    }
  }

  function focus() {
    (choices().find((input) => input.checked) ?? choices()[0])?.focus();
  }

  return { fill, value, focus };
}
