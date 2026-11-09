import { createElement } from "./dom.js?v=1.4.46";
import {
  DEFAULT_KEY_BAR_ITEMS,
  KEY_BAR_ITEMS_MAX,
  KEY_BAR_KEYS,
  KEY_BAR_MODIFIERS,
  addKeyBarItem,
  customKeyBarItem,
  keyBarItemId,
  keyBarItemLabel,
  moveKeyBarItem,
  removeKeyBarItem,
  resetKeyBarItems,
  writeKeyBarItems,
} from "../key-bar-preference.js?v=1.4.46";
import { ENTER_KEY_MODES, enterKeyModeHint, writeEnterKeyMode } from "../enter-key-preference.js?v=1.4.46";

// The key bar's layout and the composer's Enter mode are app.js's own `let`s
// (the bar and the composer read them), so this reads and assigns them through
// the getters and setters it is given.
export function createKeyBarEditor({
  panePreferenceStorage,
  getKeyBarItems,
  assignKeyBarItems,
  getEnterKeyMode,
  setEnterKeyMode,
  renderKeyBar,
  usesTouchInputEnvironment,
}) {
  // The "Edit keys" window: a list in bar order (drag a row on a desktop, or use
  // the arrows), a list of keys to add, and custom combinations. Every change is
  // saved and drawn on the bar at once.
  const keyBarDialog = {
    root: document.querySelector("#key-bar-dialog"),
    list: document.querySelector("#key-bar-list"),
    empty: document.querySelector("#key-bar-empty"),
    addSelect: document.querySelector("#key-bar-add-select"),
    add: document.querySelector("#key-bar-add"),
    comboKey: document.querySelector("#key-bar-combo-key"),
    comboChar: document.querySelector("#key-bar-combo-char"),
    comboPreview: document.querySelector("#key-bar-combo-preview"),
    comboAdd: document.querySelector("#key-bar-combo-add"),
  };
  const KEY_BAR_CHARACTER = "character";
  const comboModifiers = new Set();
  let keyBarDragFrom = null;

  function setKeyBarItems(next) {
    assignKeyBarItems(next);
    writeKeyBarItems(panePreferenceStorage, getKeyBarItems());
    renderKeyBar();
    renderKeyBarDialog();
  }

  function keyBarComboItem() {
    const base = keyBarDialog.comboKey.value === KEY_BAR_CHARACTER ? keyBarDialog.comboChar.value : keyBarDialog.comboKey.value;
    if (keyBarDialog.comboKey.value === KEY_BAR_CHARACTER && [...base].length !== 1) return { error: "Enter one character." };
    const item = customKeyBarItem(base, [...comboModifiers]);
    return item ? { item } : { error: "That is not a key the terminal can take." };
  }

  function renderKeyBarCombo() {
    const character = keyBarDialog.comboKey.value === KEY_BAR_CHARACTER;
    keyBarDialog.comboChar.hidden = !character;
    for (const button of keyBarDialog.root.querySelectorAll("[data-combo-modifier]")) {
      button.setAttribute("aria-pressed", String(comboModifiers.has(button.dataset.comboModifier)));
    }
    const { item, error } = keyBarComboItem();
    const exists = item && getKeyBarItems().some((current) => keyBarItemId(current) === keyBarItemId(item));
    keyBarDialog.comboPreview.textContent = item ? keyBarItemLabel(item) : error;
    keyBarDialog.comboAdd.disabled = !item || exists || getKeyBarItems().length >= KEY_BAR_ITEMS_MAX;
    keyBarDialog.comboAdd.title = exists ? "Already on the bar" : "";
  }

  function fillKeyBarSelects() {
    const keyOption = (name) => {
      const option = createElement("option", { text: keyBarItemLabel({ type: "key", key: name }) });
      option.value = name;
      return option;
    };
    const modifierOption = (name) => {
      const option = createElement("option", { text: `${keyBarItemLabel({ type: "modifier", modifier: name })} (held for the next key)` });
      option.value = `modifier:${name}`;
      return option;
    };
    const chosen = keyBarDialog.addSelect.value;
    const present = new Set(getKeyBarItems().map(keyBarItemId));
    const options = [
      ...KEY_BAR_MODIFIERS.filter((name) => !present.has(`modifier:${name}`)).map(modifierOption),
      ...KEY_BAR_KEYS.filter((name) => !present.has(keyBarItemId({ type: "key", key: name }))).map(keyOption),
    ];
    if (!options.length) {
      const none = createElement("option", { text: "All keys added" });
      none.value = "";
      options.push(none);
    }
    keyBarDialog.addSelect.replaceChildren(...options);
    if (options.some((option) => option.value === chosen)) keyBarDialog.addSelect.value = chosen;
    keyBarDialog.add.disabled = !keyBarDialog.addSelect.value || getKeyBarItems().length >= KEY_BAR_ITEMS_MAX;
    if (!keyBarDialog.comboKey.options.length) {
      const comboOptions = KEY_BAR_KEYS.map(keyOption);
      const character = createElement("option", { text: "Single character" });
      character.value = KEY_BAR_CHARACTER;
      keyBarDialog.comboKey.replaceChildren(...comboOptions, character);
      keyBarDialog.comboKey.value = KEY_BAR_CHARACTER;
    }
  }

  function renderKeyBarDialog() {
    fillKeyBarSelects();
    keyBarDialog.empty.hidden = getKeyBarItems().length > 0;
    const rows = getKeyBarItems().map((item, index) => {
      const name = keyBarItemLabel(item);
      const row = createElement("li", { className: "key-bar-item" });
      row.draggable = true;
      row.dataset.index = String(index);
      row.append(
        createElement("span", { className: "key-bar-cap", text: name }),
        createElement("span", {
          className: "key-bar-kind",
          text: item.type === "modifier" ? "Held for the next key" : item.modifiers ? "Combination" : "",
        }),
      );
      const actions = createElement("span", { className: "key-bar-item-actions" });
      const action = (label, text, handler, disabled = false) => {
        const button = createElement("button", { text });
        button.type = "button";
        button.disabled = disabled;
        button.setAttribute("aria-label", `${label} ${name}`);
        button.title = `${label} ${name}`;
        button.addEventListener("click", handler);
        return button;
      };
      actions.append(
        action("Move up", "↑", () => setKeyBarItems(moveKeyBarItem(getKeyBarItems(), index, index - 1)), index === 0),
        action("Move down", "↓", () => setKeyBarItems(moveKeyBarItem(getKeyBarItems(), index, index + 1)), index === getKeyBarItems().length - 1),
        action("Remove", "×", () => setKeyBarItems(removeKeyBarItem(getKeyBarItems(), index))),
      );
      row.append(actions);
      return row;
    });
    keyBarDialog.list.replaceChildren(...rows);
    renderKeyBarCombo();
  }

  function keyBarDropTarget(event) {
    const row = event.target.closest?.(".key-bar-item");
    if (!row || keyBarDragFrom === null) return null;
    const rect = row.getBoundingClientRect();
    return { row, index: Number(row.dataset.index), after: event.clientY > rect.top + rect.height / 2 };
  }

  function clearKeyBarDropMarks() {
    for (const row of keyBarDialog.list.children) {
      delete row.dataset.drop;
      delete row.dataset.dragging;
    }
  }

  keyBarDialog.list.addEventListener("dragstart", (event) => {
    const row = event.target.closest?.(".key-bar-item");
    if (!row) return;
    keyBarDragFrom = Number(row.dataset.index);
    row.dataset.dragging = "true";
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(keyBarDragFrom));
  });
  keyBarDialog.list.addEventListener("dragover", (event) => {
    const target = keyBarDropTarget(event);
    if (!target) return;
    event.preventDefault();
    for (const row of keyBarDialog.list.children) delete row.dataset.drop;
    target.row.dataset.drop = target.after ? "after" : "before";
  });
  keyBarDialog.list.addEventListener("drop", (event) => {
    const target = keyBarDropTarget(event);
    if (!target) return;
    event.preventDefault();
    let to = target.index + (target.after ? 1 : 0);
    if (keyBarDragFrom < to) to -= 1;
    const from = keyBarDragFrom;
    keyBarDragFrom = null;
    clearKeyBarDropMarks();
    setKeyBarItems(moveKeyBarItem(getKeyBarItems(), from, to));
  });
  keyBarDialog.list.addEventListener("dragend", () => {
    keyBarDragFrom = null;
    clearKeyBarDropMarks();
  });

  keyBarDialog.add.addEventListener("click", () => {
    const value = keyBarDialog.addSelect.value;
    if (!value) return;
    const item = value.startsWith("modifier:")
      ? { type: "modifier", modifier: value.slice("modifier:".length) }
      : { type: "key", key: value };
    setKeyBarItems(addKeyBarItem(getKeyBarItems(), item));
  });
  keyBarDialog.comboKey.addEventListener("change", renderKeyBarCombo);
  keyBarDialog.comboChar.addEventListener("input", renderKeyBarCombo);
  for (const button of keyBarDialog.root.querySelectorAll("[data-combo-modifier]")) {
    button.addEventListener("click", () => {
      const name = button.dataset.comboModifier;
      if (comboModifiers.has(name)) comboModifiers.delete(name);
      else comboModifiers.add(name);
      renderKeyBarCombo();
    });
  }
  keyBarDialog.comboAdd.addEventListener("click", () => {
    const { item } = keyBarComboItem();
    if (item) setKeyBarItems(addKeyBarItem(getKeyBarItems(), item));
  });
  document.querySelector("#key-bar-reset").addEventListener("click", () => {
    resetKeyBarItems(panePreferenceStorage);
    assignKeyBarItems([...DEFAULT_KEY_BAR_ITEMS]);
    renderKeyBar();
    renderKeyBarDialog();
  });
  document.querySelector("#key-bar-close").addEventListener("click", () => keyBarDialog.root.close());

  function openKeyBarDialog() {
    renderKeyBarDialog();
    renderEnterKeyChoice();
    keyBarDialog.root.showModal();
  }

  // What the composer's Enter does, chosen in Edit keys. Touch devices only: with
  // a mouse-oriented environment Enter always sends.
  const enterKeyChoice = {
    root: document.querySelector("#key-bar-enter"),
    hint: document.querySelector("#key-bar-enter-hint"),
    buttons: [...document.querySelectorAll("#key-bar-enter [data-enter-mode]")],
  };

  function renderEnterKeyChoice() {
    enterKeyChoice.root.hidden = !usesTouchInputEnvironment();
    for (const button of enterKeyChoice.buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.enterMode === getEnterKeyMode()));
    }
    enterKeyChoice.hint.textContent = enterKeyModeHint(getEnterKeyMode());
  }

  for (const button of enterKeyChoice.buttons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.enterMode;
      if (!ENTER_KEY_MODES.includes(mode)) return;
      setEnterKeyMode(mode);
      writeEnterKeyMode(panePreferenceStorage, getEnterKeyMode());
      renderEnterKeyChoice();
    });
  }

  return { openKeyBarDialog };
}
