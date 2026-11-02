// Small DOM helpers every part of the page draws with. Nothing here reads the
// page's state.

export function array(value) {
  return Array.isArray(value) ? value : [];
}

export function createElement(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createIcon(paths, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  for (const pathData of array(paths)) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

export function workspaceActionButton({ className = "", label, paths, type = "button" }) {
  const button = createElement("button", {
    className: `workspace-action ${className}`.trim(),
  });
  button.type = type;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(createIcon(paths));
  return button;
}

// The top layer has no anchor of its own, so the menu is measured against the
// button that opened it and nudged back inside the viewport.
export function placeFloatingMenu(popover, summary) {
  popover.showPopover();
  // A narrow phone draws every menu as a sheet along the bottom; the 520px
  // matches the sheet's media query in public/ui/components.css.
  if (window.matchMedia("(max-width: 520px)").matches) {
    popover.style.left = "";
    popover.style.top = "";
    return;
  }
  const anchor = summary.getBoundingClientRect();
  const menu = popover.getBoundingClientRect();
  const left = Math.min(Math.max(8, anchor.right - menu.width), window.innerWidth - menu.width - 8);
  const below = anchor.bottom + 4;
  const top = below + menu.height > window.innerHeight - 8
    ? Math.max(8, anchor.top - menu.height - 4)
    : below;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

export function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function browserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
