// The Chat lens's text size, apart from the terminal's: the chat is set in a
// proportional font and reads well a size or two larger. Ctrl/Cmd+wheel, a
// trackpad pinch or a two-finger pinch over the chat change it in steps.
export const CHAT_FONT_SIZE_STORAGE_KEY = "herdrbridge-chat-font-size";
export const DEFAULT_CHAT_FONT_SIZE = 14;
export const MIN_CHAT_FONT_SIZE = 12;
export const MAX_CHAT_FONT_SIZE = 24;

export function normalizedChatFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return DEFAULT_CHAT_FONT_SIZE;
  return Math.min(MAX_CHAT_FONT_SIZE, Math.max(MIN_CHAT_FONT_SIZE, Math.round(size)));
}

export function readChatFontSize(storage) {
  try {
    const stored = storage?.getItem(CHAT_FONT_SIZE_STORAGE_KEY);
    return stored === null || stored === undefined ? DEFAULT_CHAT_FONT_SIZE : normalizedChatFontSize(stored);
  } catch {
    return DEFAULT_CHAT_FONT_SIZE;
  }
}

export function writeChatFontSize(storage, size) {
  try {
    if (!storage) return false;
    storage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, String(normalizedChatFontSize(size)));
    return true;
  } catch {
    return false;
  }
}

export function adjustedChatFontSize(size, direction) {
  const current = normalizedChatFontSize(size);
  if (direction === "larger") return Math.min(MAX_CHAT_FONT_SIZE, current + 1);
  if (direction === "smaller") return Math.max(MIN_CHAT_FONT_SIZE, current - 1);
  return current;
}

// The size a two-finger pinch reaches: the size it began at, scaled by how
// far the fingers spread, in whole pixels within bounds.
export function pinchedChatFontSize(start, startDistance, distance) {
  if (!(startDistance > 0) || !(distance > 0)) return normalizedChatFontSize(start);
  return normalizedChatFontSize(normalizedChatFontSize(start) * distance / startDistance);
}

// The chat's scale for CSS (--chat-scale): every size in the chat is its
// default times this, so markdown, code, tool rows and the prompt card grow together.
export function chatScale(size) {
  return normalizedChatFontSize(size) / DEFAULT_CHAT_FONT_SIZE;
}
