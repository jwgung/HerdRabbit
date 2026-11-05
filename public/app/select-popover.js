// The app's own list for a native <select>, on a desktop. The select stays the
// source of truth: its value, options and change events are what the rest of
// the app reads, and this only swaps the OS's list for a popover that looks
// like the rest of the app (an optgroup is a group header, the chosen option
// has a check, an option may carry a status dot and a short description).
//
// A touch device keeps the OS picker, which is easier to hit with a thumb, so
// there this does nothing at all. An option opts in to the extras with
// data-attributes: data-status="online|offline|attention" for the dot and
// data-description="…" for the grey text after its name.
const TOUCH = "(hover: none), (pointer: coarse)";
const CHECK_PATH = "m3.5 8.5 3 3 6-7";

const enhanced = new WeakSet();

// The options as the popover lists them: groups with their headers, in order.
export function selectItems(select) {
  const items = [];
  const addOption = (option) => {
    items.push({
      type: "option",
      option,
      label: option.textContent.trim(),
      description: option.dataset.description || "",
      status: option.dataset.status || "",
      disabled: option.disabled,
    });
  };
  for (const child of select.children) {
    if (child.tagName === "OPTGROUP") {
      items.push({ type: "group", label: child.label });
      for (const option of child.children) addOption(option);
    } else if (child.tagName === "OPTION") {
      addOption(child);
    }
  }
  return items;
}

// The enabled option that follows `from` in a direction, or `from` at an end.
export function stepIndex(options, from, step) {
  let index = from;
  for (let next = from + step; next >= 0 && next < options.length; next += step) {
    if (!options[next].disabled) { index = next; break; }
  }
  return index;
}

// Type-ahead: the first enabled option after `from` whose label starts with the typed text.
export function typeAheadIndex(options, from, typed) {
  const text = typed.toLowerCase();
  const order = options.map((_, i) => (from + 1 + i) % options.length);
  // Typing one letter again cycles; typing a word stays on a match of the word.
  const start = text.length > 1 && options[from]?.label.toLowerCase().startsWith(text) ? [from] : order;
  return start.find((i) => !options[i].disabled && options[i].label.toLowerCase().startsWith(text)) ?? -1;
}

function svgCheck() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ui-select-check");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", CHECK_PATH);
  svg.append(path);
  return svg;
}

function enhanceSelect(select) {
  if (enhanced.has(select) || select.multiple) return;
  enhanced.add(select);
  select.setAttribute("aria-haspopup", "listbox");
  select.setAttribute("aria-expanded", "false");

  let popover = null;
  let rows = [];
  let active = -1;
  let typed = "";
  let typedTimer = 0;
  let counter = 0;

  const options = () => rows.filter((row) => row.item.type === "option").map((row) => row.item);

  function setActive(index, scroll = true) {
    const list = rows.filter((row) => row.item.type === "option");
    active = index;
    list.forEach((row, i) => row.el.classList.toggle("is-active", i === index));
    const current = list[index];
    if (current) {
      popover.setAttribute("aria-activedescendant", current.el.id);
      if (scroll) current.el.scrollIntoView({ block: "nearest" });
    }
  }

  function position() {
    const box = select.getBoundingClientRect();
    popover.style.minWidth = `${box.width}px`;
    popover.style.left = `${box.left}px`;
    const below = innerHeight - box.bottom;
    const room = Math.max(below, box.top) - 12;
    popover.style.maxHeight = `${Math.min(320, room)}px`;
    if (below >= Math.min(popover.scrollHeight, 200) || below >= box.top) {
      popover.style.top = `${box.bottom + 4}px`;
      popover.style.bottom = "";
    } else {
      popover.style.top = "";
      popover.style.bottom = `${innerHeight - box.top + 4}px`;
    }
    const overflow = popover.getBoundingClientRect().right - (innerWidth - 8);
    if (overflow > 0) popover.style.left = `${Math.max(8, box.left - overflow)}px`;
  }

  function choose(option) {
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close();
    select.focus();
  }

  function open() {
    if (popover || select.disabled) return;
    popover = document.createElement("div");
    popover.className = "ui-select-popover";
    popover.setAttribute("role", "listbox");
    popover.tabIndex = -1;
    rows = [];
    for (const item of selectItems(select)) {
      const el = document.createElement("div");
      if (item.type === "group") {
        el.className = "ui-select-group";
        el.setAttribute("role", "presentation");
        el.textContent = item.label;
      } else {
        counter += 1;
        el.id = `${select.id || "select"}-opt-${counter}`;
        el.className = "ui-select-option";
        el.setAttribute("role", "option");
        el.setAttribute("aria-selected", String(item.option.selected));
        if (item.disabled) el.setAttribute("aria-disabled", "true");
        if (item.status) {
          const dot = document.createElement("span");
          dot.className = "ui-select-dot";
          dot.dataset.status = item.status;
          el.append(dot);
        }
        const name = document.createElement("span");
        name.className = "ui-select-name";
        name.textContent = item.label;
        el.append(name);
        if (item.description) {
          const description = document.createElement("span");
          description.className = "ui-select-description";
          description.textContent = item.description;
          el.append(description);
        }
        if (item.option.selected) el.append(svgCheck());
        // mousedown, not click: the select keeps focus, and a click on the
        // option must not first count as an outside click.
        el.addEventListener("mousedown", (event) => event.preventDefault());
        el.addEventListener("click", () => { if (!item.disabled) choose(item.option); });
        el.addEventListener("mousemove", () => {
          const index = options().indexOf(item);
          if (index !== active && !item.disabled) setActive(index, false);
        });
      }
      rows.push({ item, el });
      popover.append(el);
    }
    // A modal dialog is in the top layer: a popover on the body would sit under it.
    (select.closest("dialog[open]") || document.body).append(popover);
    select.setAttribute("aria-expanded", "true");
    position();
    setActive(Math.max(0, options().findIndex((item) => item.option.selected)));
    document.addEventListener("mousedown", outside, true);
    addEventListener("resize", close);
    document.addEventListener("scroll", scrolled, true);
  }

  function close() {
    if (!popover) return;
    popover.remove();
    popover = null;
    select.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", outside, true);
    removeEventListener("resize", close);
    document.removeEventListener("scroll", scrolled, true);
  }

  function outside(event) {
    if (!popover?.contains(event.target) && event.target !== select) close();
  }

  // The list stays put when only itself scrolls, and closes when the page moves under it.
  function scrolled(event) {
    if (popover && !popover.contains(event.target)) close();
  }

  select.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || matchMedia(TOUCH).matches) return;
    event.preventDefault();
    select.focus();
    if (popover) close(); else open();
  });

  select.addEventListener("keydown", (event) => {
    if (matchMedia(TOUCH).matches || event.altKey || event.ctrlKey || event.metaKey) return;
    const list = popover ? options() : [];
    if (!popover) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        open();
      }
      return;
    }
    const move = (index) => { event.preventDefault(); setActive(index); };
    switch (event.key) {
      case "ArrowDown": move(stepIndex(list, active, 1)); break;
      case "ArrowUp": move(stepIndex(list, active, -1)); break;
      case "Home": move(stepIndex(list, -1, 1)); break;
      case "End": move(stepIndex(list, list.length, -1)); break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (list[active] && !list[active].disabled) choose(list[active].option);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation(); // a dialog must not close with its select's list
        close();
        break;
      case "Tab": close(); break;
      default:
        if (event.key.length === 1) {
          typed += event.key;
          clearTimeout(typedTimer);
          typedTimer = setTimeout(() => { typed = ""; }, 600);
          const hit = typeAheadIndex(list, active, typed);
          if (hit >= 0) move(hit);
        }
    }
  });

  select.addEventListener("blur", close);
}

// Every select under a root. Safe to call again: a select is enhanced once.
export function enhanceSelects(root = document) {
  if (matchMedia(TOUCH).matches) return;
  for (const select of root.querySelectorAll("select")) enhanceSelect(select);
}
