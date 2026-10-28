// How the composer's Enter behaves on a touch device: "auto" sends once a
// physical keyboard has typed on this page and inserts a newline otherwise,
// "newline" always inserts a newline (an on-screen keyboard's only way to
// break a line), "send" always sends. Kept per browser.
const STORAGE_KEY = "herdrBridge.enterKey.v1";
export const ENTER_KEY_MODES = Object.freeze(["auto", "newline", "send"]);
const LABELS = Object.freeze({ auto: "Auto", newline: "New line", send: "Send" });

export function readEnterKeyMode(storage) {
  if (!storage) return "auto";
  try {
    const value = storage.getItem(STORAGE_KEY);
    return ENTER_KEY_MODES.includes(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeEnterKeyMode(storage, mode) {
  if (!storage || !ENTER_KEY_MODES.includes(mode)) return;
  try {
    storage.setItem(STORAGE_KEY, mode);
  } catch {}
}

export function nextEnterKeyMode(mode) {
  const index = ENTER_KEY_MODES.indexOf(mode);
  return ENTER_KEY_MODES[(index + 1) % ENTER_KEY_MODES.length];
}

export function enterKeyModeLabel(mode) {
  return `Enter: ${LABELS[mode] || LABELS.auto}`;
}

// A keydown that only a physical keyboard sends: a letter or digit with its
// physical `code`. On-screen keyboards leave `code` empty (iOS) or send
// keyCode 229 with key "Unidentified" (Android); an input method mid-word
// sends 229 / isComposing. Shortcuts and synthetic events are not counted.
export function looksLikePhysicalKey(event) {
  if (!event || event.isTrusted !== true) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (typeof event.key !== "string" || [...event.key].length !== 1) return false;
  return typeof event.code === "string" && /^(Key[A-Z]|Digit[0-9])$/u.test(event.code);
}

export { STORAGE_KEY as ENTER_KEY_STORAGE_KEY };
