// A one-row tab strip (the .ui-tab-strip component in public/ui/components.css)
// that scrolls sideways instead of wrapping. Used by the AI accounts dialog and
// the New tab dialog's agent picker.
//
//   const strip = createTabStrip({
//     label: "AI CLIs",                       // aria-label of the tablist
//     tabs: [{ id, label, icon?, count?, dot?, ariaLabel?, domId?, controls?, data? }],
//     selected: "claude",                     // an id; defaults to the first tab
//     onSelect: (id, { focus }) => {},        // a click or key chose a tab
//   });
//   parent.append(strip.element);
//   strip.select("codex");                    // choose from code; no onSelect call
//   strip.buttons.get("codex");               // the tab's <button>, to add to or watch
//
// icon is a node (an svg), count a number shown as a badge when above 0, dot
// a boolean. domId and controls become the tab's id and aria-controls; data is
// copied to its dataset. A tab is a WAI-ARIA tab: ArrowLeft and ArrowRight
// (wrapping), Home and End move to a tab and choose it as they go, only the
// chosen tab is in the Tab order, and the chosen tab is scrolled into view.
// The ‹ and › buttons are for the pointer and are out of the Tab order; they
// show only on a side that has more tabs past it.

import { createElement } from "./dom.js?v=1.4.51";

export function createTabStrip({ label, tabs, selected, onSelect = () => {} }) {
  const element = createElement("div", { className: "ui-tab-strip" });
  const scroller = createElement("div", { className: "ui-tab-strip-scroller" });
  scroller.setAttribute("role", "tablist");
  scroller.setAttribute("aria-label", label);
  const arrow = (side, glyph) => {
    const button = createElement("button", { className: `ui-tab-strip-arrow is-${side}`, text: glyph });
    button.type = "button";
    button.hidden = true;
    button.tabIndex = -1;
    button.setAttribute("aria-hidden", "true");
    return button;
  };
  const start = arrow("start", "‹");
  const end = arrow("end", "›");

  const ids = tabs.map((tab) => tab.id);
  const buttons = new Map();
  for (const tab of tabs) {
    const button = createElement("button", { className: "ui-tab" });
    button.type = "button";
    button.setAttribute("role", "tab");
    if (tab.domId) button.id = tab.domId;
    if (tab.controls) button.setAttribute("aria-controls", tab.controls);
    if (tab.ariaLabel) button.setAttribute("aria-label", tab.ariaLabel);
    Object.assign(button.dataset, tab.data);
    if (tab.icon) button.append(tab.icon);
    button.append(createElement("span", { className: "ui-tab-name", text: tab.label }));
    if (tab.count > 0) button.append(createElement("span", { className: "ui-badge ui-tab-count", text: String(tab.count) }));
    if (tab.dot) button.append(createElement("span", { className: "ui-tab-dot" }));
    button.addEventListener("click", () => choose(tab.id));
    buttons.set(tab.id, button);
  }
  scroller.append(...buttons.values());
  element.append(start, scroller, end);

  // Which sides have more tabs past them, from where the row is scrolled.
  function updateOverflow() {
    const { scrollLeft, scrollWidth, clientWidth } = scroller;
    const before = scrollLeft > 1;
    const after = scrollLeft + clientWidth < scrollWidth - 1;
    element.toggleAttribute("data-overflow-start", before);
    element.toggleAttribute("data-overflow-end", after);
    start.hidden = !before;
    end.hidden = !after;
  }

  let current = null;
  function select(id, { focus = false } = {}) {
    if (!buttons.has(id)) return;
    current = id;
    for (const [tabId, button] of buttons) {
      const chosen = tabId === id;
      button.setAttribute("aria-selected", String(chosen));
      button.tabIndex = chosen ? 0 : -1;
    }
    const button = buttons.get(id);
    if (focus) button.focus();
    button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    updateOverflow();
  }
  function choose(id, options) {
    select(id, options);
    onSelect(id, { focus: Boolean(options?.focus) });
  }

  scroller.addEventListener("keydown", (event) => {
    const at = ids.indexOf([...buttons].find(([, button]) => button === event.target)?.[0]);
    if (at < 0) return;
    const last = ids.length - 1;
    const to = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    choose(ids[to], { focus: true });
  });
  scroller.addEventListener("scroll", updateOverflow, { passive: true });
  const page = (direction) => () => scroller.scrollBy?.({ left: direction * scroller.clientWidth * 0.8, behavior: "smooth" });
  start.addEventListener("click", page(-1));
  end.addEventListener("click", page(1));
  if (typeof ResizeObserver === "function") new ResizeObserver(updateOverflow).observe(scroller);
  else window.addEventListener("resize", updateOverflow);

  select(buttons.has(selected) ? selected : ids[0]);
  return { element, buttons, select, get selected() { return current; } };
}
