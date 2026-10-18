// Adapted from herdr-web-ui (MIT), src/lib/keyBar.ts: the key bar as a list of
// items the user can add to, remove from and reorder, kept in localStorage.
// Key names are herdr's (esc, pageup, f5 ...), checked with key-combinations.js.
import { combinedTerminalKey } from "./key-combinations.js?v=1.2.71";

export const KEY_BAR_STORAGE_KEY = "herdrbridge-key-bar";
export const KEY_BAR_ITEMS_MAX = 40;
export const KEY_BAR_MODIFIERS = Object.freeze(["ctrl", "alt", "shift"]);

// What the "Add key" list offers. Single printable characters are also valid
// as the base of a custom combination.
export const KEY_BAR_KEYS = Object.freeze([
  "esc", "tab", "enter", "backspace", "delete", "insert", "space",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "/", "-", "|", "~",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

const key = (name, modifiers) => (modifiers ? { type: "key", key: name, modifiers } : { type: "key", key: name });
const modifier = (name) => ({ type: "modifier", modifier: name });

// The bar as it shipped before it could be edited, in the same order.
export const DEFAULT_KEY_BAR_ITEMS = Object.freeze([
  key("esc"), key("/"), key("-"), key("home"), key("up"), key("end"), key("pageup"),
  modifier("shift"), key("tab"), modifier("ctrl"), modifier("alt"),
  key("left"), key("down"), key("right"), key("pagedown"), key("enter"),
].map(Object.freeze));

const CAPS = Object.freeze({
  esc: "Esc", tab: "Tab", enter: "Enter", backspace: "⌫", delete: "Del", insert: "Ins", space: "Space",
  home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn",
  up: "↑", down: "↓", left: "←", right: "→", "-": "−",
});

function normalizedModifiers(value) {
  if (!Array.isArray(value)) return null;
  const set = new Set(value.filter((part) => KEY_BAR_MODIFIERS.includes(part)));
  return KEY_BAR_MODIFIERS.filter((part) => set.has(part));
}

// Stable identity: the same key held-modifier-aware and as an exact chord differ.
export function keyBarItemId(item) {
  if (item.type === "modifier") return `modifier:${item.modifier}`;
  return `key:${item.key}:${item.modifiers ? item.modifiers.join("+") : "held"}`;
}

export function keyBarItemLabel(item) {
  if (item.type === "modifier") return { ctrl: "Ctrl", alt: "Alt", shift: "Shift" }[item.modifier];
  const base = CAPS[item.key] ?? (/^f\d+$/u.test(item.key) ? item.key.toUpperCase()
    : /^[a-z]$/u.test(item.key) ? item.key.toUpperCase() : item.key);
  if (!item.modifiers) return base;
  const names = item.modifiers.map((part) => ({ ctrl: "Ctrl", alt: "Alt", shift: "Shift" }[part]));
  return [...names, base].join("+");
}

// The key sent to herdr for a press, or null when the item is a modifier or
// would not be a valid key. A saved combination ignores the held modifiers.
export function keyBarItemKey(item, heldModifiers = []) {
  if (item.type !== "key") return null;
  return combinedTerminalKey(item.key, item.modifiers ?? heldModifiers);
}

// What the window can create: a name from the list, or one printable character.
function isOfferedBase(name) {
  if (KEY_BAR_KEYS.includes(name)) return true;
  return [...name].length === 1 && !/[\p{C}\s+]/u.test(name);
}

function sanitizeItem(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (raw.type === "modifier") {
    return KEY_BAR_MODIFIERS.includes(raw.modifier) ? modifier(raw.modifier) : null;
  }
  if (raw.type !== "key" || typeof raw.key !== "string" || raw.key.includes("+")) return null;
  if (!isOfferedBase(raw.key) || !combinedTerminalKey(raw.key, [])) return null;
  if (raw.modifiers === undefined) return key(raw.key);
  const modifiers = normalizedModifiers(raw.modifiers);
  if (!modifiers || !combinedTerminalKey(raw.key, modifiers)) return null;
  return modifiers.length ? key(raw.key, modifiers) : key(raw.key);
}

// Keeps an explicit empty list, drops anything malformed or repeated, and
// caps the length, so a hand-edited value can neither break the bar nor
// smuggle in anything but a valid key.
export function sanitizeKeyBarItems(raw, fallback = DEFAULT_KEY_BAR_ITEMS) {
  const source = Array.isArray(raw) ? raw : fallback;
  const result = [];
  const seen = new Set();
  for (const entry of source) {
    const item = sanitizeItem(entry);
    if (!item) continue;
    const id = keyBarItemId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
    if (result.length === KEY_BAR_ITEMS_MAX) break;
  }
  return result;
}

// A saved combination from a base key (a name from the list, or one printable
// character) and the modifiers to press with it; null when it is no valid key.
export function customKeyBarItem(base, modifiers = []) {
  if (typeof base !== "string") return null;
  const name = [...base].length === 1 ? base.toLowerCase() : base;
  if (!isOfferedBase(name)) return null;
  const parts = normalizedModifiers(modifiers) ?? [];
  if (!combinedTerminalKey(name, []) || !combinedTerminalKey(name, parts)) return null;
  return parts.length ? key(name, parts) : key(name);
}

export function addKeyBarItem(items, item) {
  const next = sanitizeKeyBarItems([...items, item], []);
  return next.length === items.length + 1 ? next : [...items];
}

export function removeKeyBarItem(items, index) {
  return items.filter((_, at) => at !== index);
}

export function moveKeyBarItem(items, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) ||
      from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function readKeyBarItems(storage) {
  try {
    const raw = storage?.getItem(KEY_BAR_STORAGE_KEY);
    if (!raw) return sanitizeKeyBarItems(null);
    const value = JSON.parse(raw);
    return sanitizeKeyBarItems(value?.version === 1 ? value.items : null);
  } catch {
    return sanitizeKeyBarItems(null);
  }
}

export function writeKeyBarItems(storage, items) {
  try {
    if (!storage) return false;
    storage.setItem(KEY_BAR_STORAGE_KEY, JSON.stringify({ version: 1, items: sanitizeKeyBarItems(items, []) }));
    return true;
  } catch {
    return false;
  }
}

export function resetKeyBarItems(storage) {
  try {
    storage?.removeItem?.(KEY_BAR_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
