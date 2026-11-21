// A phone's pane header keeps the sidebar button, the pane's name and the Herdr
// mark. Its other controls (the split view's and grid's buttons, Chat or
// Terminal, Find) are hidden by the stylesheet and offered in one "More" menu,
// a bottom sheet. Each item clicks the hidden control it stands for, so every
// control keeps its one handler and its own rules for when it shows.

// Icons drawn on the 24-unit grid of createIcon.
const ICONS = Object.freeze({
  grid: ["M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  view: ["M3 4h8v16H3zM13 4h8v16h-8z"],
  apply: ["M3 4h18v16H3zM12 4v16", "m7.5 12 2.5 2.5L15 9.5"],
  close: ["M6 6l12 12M18 6 6 18"],
  chat: ["M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"],
  terminal: ["M3 4h18v16H3z", "m7 9 3 3-3 3M13 15h4"],
  find: ["M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12Z", "m14.5 14.5 5.5 5.5"],
});

const shown = (element) => Boolean(element) && !element.hidden;
const enabled = (element) => shown(element) && element.getAttribute("aria-disabled") !== "true";

// The menu's items for the header as it is now: what a desktop header would show.
export function headerMoreActions({ gridBack, viewBack, viewApply, viewClose, lensSwitch, lensChat, lensTerminal, findButton }) {
  const actions = [];
  const add = (key, label, icon, control) => actions.push({ key, label, icon, control });
  if (shown(gridBack)) add("grid-back", "Back to grid", ICONS.grid, gridBack);
  if (shown(viewBack)) add("view-back", "Back to split view", ICONS.view, viewBack);
  if (shown(viewApply)) add("view-apply", "Apply to Herdr", ICONS.apply, viewApply);
  if (shown(viewClose)) add("view-close", "Close split view", ICONS.close, viewClose);
  // Only the lens that is not showing: the screen already shows the other.
  if (shown(lensSwitch)) {
    if (lensChat?.getAttribute("aria-pressed") !== "true" && enabled(lensChat)) add("lens-chat", "Show chat", ICONS.chat, lensChat);
    if (lensTerminal?.getAttribute("aria-pressed") !== "true" && enabled(lensTerminal)) add("lens-terminal", "Show terminal", ICONS.terminal, lensTerminal);
  }
  if (enabled(findButton)) add("find", findButton.getAttribute("aria-label") || "Find", ICONS.find, findButton);
  return actions;
}

export function createHeaderMore({ slot, title, controls, sidebarActionMenu }) {
  const watched = Object.values(controls).filter(Boolean);
  let menu = null;
  let stale = false;
  // What the menu shows now. The header re-sets its controls' attributes to
  // the same values on every redraw; rebuilding then would close an open menu
  // under the finger, so the menu is only rebuilt when this changes.
  let shownKey = null;

  function render() {
    if (menu?.open) {
      stale = true;
      return;
    }
    stale = false;
    const actions = headerMoreActions(controls);
    const label = `More actions for ${title.textContent.trim() || "this pane"}`;
    const key = JSON.stringify([label, actions.map((action) => [action.key, action.label])]);
    if (key === shownKey) return;
    shownKey = key;
    slot.hidden = actions.length === 0;
    const next = sidebarActionMenu({
      id: "header-more",
      // The sheet's title is the pane's name (sidebarActionMenu drops the prefix).
      label,
      className: "header-more-menu",
      actions: actions.map(({ key, label, icon, control }) => ({
        key, label, paths: icon, onSelect: () => control.click(),
      })),
    });
    next.addEventListener("toggle", () => {
      if (!next.open && stale) queueMicrotask(render);
    });
    if (menu) menu.replaceWith(next);
    else slot.append(next);
    menu = next;
  }

  const observer = new MutationObserver(render);
  for (const element of watched) {
    observer.observe(element, { attributes: true, attributeFilter: ["hidden", "aria-pressed", "aria-disabled", "aria-label"] });
  }
  observer.observe(title, { childList: true, characterData: true, subtree: true });
  render();
  return { render };
}
