// Settings → Chat → "Chat width": how wide the conversation column may grow
// on a wide window. The page sets it as `data-chat-width` on the root
// (public/chat/chat-view.css reads it). Kept per browser.
export const CHAT_WIDTH_STORAGE_KEY = "herdrbridge-chat-width";
export const CHAT_WIDTHS = Object.freeze(["narrow", "default", "wide", "full"]);
const NAMES = Object.freeze({ narrow: "Narrow", default: "Default", wide: "Wide", full: "Full" });

export function chatWidthName(width) {
  return NAMES[width] ?? NAMES.default;
}

export function readChatWidth(storage) {
  try {
    const value = storage?.getItem(CHAT_WIDTH_STORAGE_KEY);
    return CHAT_WIDTHS.includes(value) ? value : "default";
  } catch {
    return "default";
  }
}

export function writeChatWidth(storage, width) {
  if (!storage || !CHAT_WIDTHS.includes(width)) return false;
  try {
    storage.setItem(CHAT_WIDTH_STORAGE_KEY, width);
    return true;
  } catch {
    return false;
  }
}
