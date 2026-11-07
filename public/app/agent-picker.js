import { sessionAgentChoices } from "../agents.js?v=1.4.45";
import { createTabStrip } from "./tab-strip.js?v=1.4.45";

// The Agent choice of the New tab, New workspace and New worktree dialogs: a
// one-row tab strip (tab-strip.js), Shell first and then each installed
// agent, each with its program's mark, scrolling sideways when they do not
// fit instead of wrapping. The strip goes in the fieldset's .agent-choices
// box, under its legend. The fieldset is still the control: disabling it
// disables every tab, and choosing a tab fires a change event on it, as a
// radio button's would. Each tab carries data-agent (its agent, "shell" for
// Shell). `agentMark(kind)` draws a mark; "shell" is the shell's.
// `panel`, when given, is the id of the element the tabs control (New tab's
// list of earlier conversations).
export function createAgentPicker(fieldset, { agentMark, panel = "" }) {
  const box = fieldset.querySelector(".agent-choices");
  const label = fieldset.querySelector("legend")?.textContent || "Agent";
  let strip = null;

  // The agent chosen, "" for a shell.
  function value() {
    const chosen = strip?.selected;
    return !chosen || chosen === "shell" ? "" : chosen;
  }

  // The tabs for `installed` agent names, `wanted` chosen when it is one of
  // them, else Shell.
  function fill(installed, wanted = "") {
    const options = sessionAgentChoices(installed);
    const chosen = options.some((option) => option.value === wanted) ? wanted : "";
    const id = (option) => option.value || "shell";
    strip = createTabStrip({
      label,
      tabs: options.map((option) => ({
        id: id(option),
        label: option.label,
        icon: agentMark(id(option)),
        data: { agent: id(option) },
        ...(panel ? { controls: panel } : {}),
      })),
      selected: chosen || "shell",
      onSelect: () => fieldset.dispatchEvent(new Event("change", { bubbles: true })),
    });
    box.replaceChildren(strip.element);
  }

  function focus() {
    if (!strip) return;
    strip.buttons.get(strip.selected)?.focus();
  }

  // The chosen tab's button, which names the panel it controls.
  function selectedTab() {
    return strip?.buttons.get(strip.selected) ?? null;
  }

  return { fill, value, focus, selectedTab };
}
