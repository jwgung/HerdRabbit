// Which lens a pane shows: its Claude conversation as a chat, or its terminal.
// The last one chosen is kept per pane; a pane never chosen for opens in Chat
// on a phone-sized or touch layout and in Terminal on a desktop.
export const LENS_STORAGE_KEY = "herdrbridge-pane-lens";
export const LENSES = Object.freeze(["chat", "terminal"]);
// Enough for every pane anyone keeps open; the oldest choices go first.
const MAX_REMEMBERED_PANES = 200;
const MAX_PANE_ID_LENGTH = 512;

function validPaneId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PANE_ID_LENGTH;
}

function readAll(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(LENS_STORAGE_KEY) ?? "null");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter(([paneId, lens]) => validPaneId(paneId) && LENSES.includes(lens)));
  } catch {
    return new Map();
  }
}

// The lens last chosen for `paneId`, or null when none was (or storage fails).
export function readPaneLens(storage, paneId) {
  if (!validPaneId(paneId)) return null;
  return readAll(storage).get(paneId) ?? null;
}

export function writePaneLens(storage, paneId, lens) {
  if (!validPaneId(paneId) || !LENSES.includes(lens) || !storage) return false;
  try {
    const all = readAll(storage);
    all.delete(paneId);
    all.set(paneId, lens);
    while (all.size > MAX_REMEMBERED_PANES) all.delete(all.keys().next().value);
    storage.setItem(LENS_STORAGE_KEY, JSON.stringify(Object.fromEntries(all)));
    return true;
  } catch {
    return false;
  }
}

// A phone (narrow) or touch layout reads the chat first; a desktop the terminal.
export function defaultLens({ compact = false, touch = false } = {}) {
  return compact || touch ? "chat" : "terminal";
}

// The lens shown: the one chosen (or the default), but never a chat the pane
// does not have.
export function chooseLens({ stored = null, chatAvailable = false, compact = false, touch = false } = {}) {
  const wanted = LENSES.includes(stored) ? stored : defaultLens({ compact, touch });
  return wanted === "chat" && !chatAvailable ? "terminal" : wanted;
}

// Whether a snapshot names this pane's agent as Claude Code. Only a Claude
// pane has a conversation the server can read.
export function isClaudePane(pane, agent) {
  const names = [pane?.agent, pane?.agent_session?.agent, agent?.agent];
  return names.some((name) => typeof name === "string" && name.toLowerCase() === "claude");
}

// What the disabled Chat button says, by the reason the server gave.
const UNAVAILABLE_TEXT = {
  pane_not_found: "Chat is unavailable: this pane is gone.",
  not_claude: "Chat is only for Claude Code panes.",
  no_session_id: "Chat appears once Claude Code reports its session.",
  server_unavailable: "Chat is unavailable: the machine is not connected.",
  transcript_missing: "Chat is unavailable: Claude's conversation file was not found.",
};

export function chatUnavailableText(reason) {
  return UNAVAILABLE_TEXT[reason] ?? "Chat is unavailable for this pane.";
}

// Reasons that may change while the pane stays: worth asking again later.
export function chatMayBecomeAvailable(reason) {
  return reason !== "not_claude";
}
