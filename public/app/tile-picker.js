// The "What goes here?" picker: the new tile a tab dropped on its own pane
// opens (view-split.js, PICK_TILE). It lists the tabs that can fill it,
// grouped as this workspace, other workspaces and other machines, then New
// shell here, New tab… and Cancel split. Every choice is a button: Tab and
// the arrow keys move between them, Escape cancels the split.
import { createElement } from "./dom.js?v=1.4.56";

let pickers = 0;

// `onPick(paneId)`, `onNewShell()`, `onNewTab()` and `onCancel()` hear the
// choices; `agentMark(kind)` draws a tab's mark.
export function createTilePicker({ onPick, onNewShell, onNewTab, onCancel, agentMark }) {
  pickers += 1;
  const headingId = `tile-picker-heading-${pickers}`;
  const element = createElement("section", { className: "tile-picker" });
  element.setAttribute("aria-labelledby", headingId);
  const heading = createElement("h3", { className: "tile-picker-heading", text: "What goes here?" });
  heading.id = headingId;
  const hint = createElement("p", { className: "tile-picker-hint" });
  const list = createElement("div", { className: "tile-picker-list" });
  const cancel = createElement("button", { className: "secondary-button tile-picker-cancel", text: "Cancel split" });
  cancel.type = "button";
  cancel.addEventListener("click", () => onCancel());
  const actions = createElement("div", { className: "tile-picker-actions" });
  actions.append(cancel);
  element.append(heading, hint, list, actions);
  let drawnKey = "";

  const buttons = () => [...element.querySelectorAll("button:not([disabled])")];
  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const all = buttons();
    const at = all.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    all[(at + (event.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
  });

  function choiceButton({ label, context, kind, glyph, onClick, className = "" }) {
    const button = createElement("button", { className: `ui-nav-item tile-picker-choice ${className}`.trim() });
    button.type = "button";
    const mark = glyph ? createElement("span", { className: "tile-picker-glyph", text: glyph }) : agentMark?.(kind);
    if (mark) {
      mark.setAttribute?.("aria-hidden", "true");
      button.append(mark);
    } else button.append(createElement("span"));
    const copy = createElement("span", { className: "ui-nav-copy" });
    copy.append(createElement("strong", { text: label }));
    button.append(copy);
    if (context) button.append(createElement("small", { className: "tile-picker-context", text: context }));
    button.setAttribute("aria-label", context ? `${label}, ${context}` : label);
    button.addEventListener("click", onClick);
    return button;
  }

  function group(title, items) {
    if (items.length === 0) return [];
    const titleNode = createElement("h4", { className: "tile-picker-group", text: title });
    const ul = createElement("ul", { className: "tile-picker-items" });
    ul.setAttribute("aria-label", title);
    for (const item of items) {
      const li = createElement("li");
      li.append(choiceButton(item));
      ul.append(li);
    }
    return [titleNode, ul];
  }

  return {
    element,
    // `anchorLabel` names the pane split; `workspaceLabel` its workspace.
    // `groups` holds { here, workspaces, machines } of { paneId, label,
    // context, kind }. Drawn again only when something shown changed, so
    // the focus stays on its button.
    render({ anchorLabel, workspaceLabel, groups, canCreate = true }) {
      const key = JSON.stringify([anchorLabel, workspaceLabel, groups, canCreate]);
      if (key === drawnKey) return;
      drawnKey = key;
      const focusedIndex = buttons().indexOf(document.activeElement);
      hint.textContent = `${anchorLabel} is split. Pick what this half shows.`;
      const tabsOf = (items) => items.map((item) => ({ ...item, onClick: () => onPick(item.paneId) }));
      const fresh = canCreate ? [
        { label: "New shell here", context: `in ${workspaceLabel}`, glyph: ">_", className: "tile-picker-new-shell", onClick: () => onNewShell() },
        { label: "New tab…", context: "Choose an agent, folder and name", glyph: "+", className: "tile-picker-new-tab", onClick: () => onNewTab() },
      ] : [];
      list.replaceChildren(
        ...group(`${workspaceLabel} (this workspace)`, tabsOf(groups.here)),
        ...group("Other workspaces", tabsOf(groups.workspaces)),
        ...group("Other machines", tabsOf(groups.machines)),
        ...group("New", fresh),
      );
      if (focusedIndex >= 0) buttons()[Math.min(focusedIndex, buttons().length - 1)]?.focus();
    },
    // The first choice takes the focus, as a dialog's first control would.
    focus() {
      buttons()[0]?.focus({ preventScroll: true });
    },
    setBusy(busy) {
      element.setAttribute("aria-busy", String(busy));
      for (const button of element.querySelectorAll("button")) button.disabled = busy;
    },
  };
}
