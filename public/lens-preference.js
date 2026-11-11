// Which lens a pane shows: its agent's conversation (Claude Code's or
// Codex's) as a chat, or its terminal.
// The last one chosen is kept per pane; a pane never chosen for opens in the
// lens Settings → Chat → "Open panes in" names, and on Auto in Chat on a
// phone-sized or touch layout and in Terminal on a desktop.
import { agentNamesWith, listOfNames, productNamesWith } from "./agents.js?v=1.4.50";

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

// A pane carried to another project has a new id: its choice follows.
export function renamePaneLenses(storage, moves) {
  if (!storage) return false;
  try {
    const all = readAll(storage);
    const moved = [];
    for (const move of Array.isArray(moves) ? moves : []) {
      if (validPaneId(move?.to) && move.from !== move.to && all.has(move.from)) moved.push([move.to, all.get(move.from)]);
    }
    if (moved.length === 0) return true;
    for (const move of moves) all.delete(move?.from);
    for (const [to, lens] of moved) { all.delete(to); all.set(to, lens); }
    storage.setItem(LENS_STORAGE_KEY, JSON.stringify(Object.fromEntries(all)));
    return true;
  } catch {
    return false;
  }
}

// Settings → Chat → "Open panes in": the lens a pane never chosen for opens
// in. "auto" is the layout's own default (below). Kept per browser.
export const OPEN_PANES_IN_STORAGE_KEY = "herdrbridge-open-panes-in";
export const OPEN_PANES_IN = Object.freeze(["auto", ...LENSES]);
const OPEN_PANES_IN_NAMES = Object.freeze({ auto: "Auto", chat: "Chat", terminal: "Terminal" });

export function openPanesInName(value) {
  return OPEN_PANES_IN_NAMES[value] ?? OPEN_PANES_IN_NAMES.auto;
}

export function readOpenPanesIn(storage) {
  try {
    const value = storage?.getItem(OPEN_PANES_IN_STORAGE_KEY);
    return OPEN_PANES_IN.includes(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeOpenPanesIn(storage, value) {
  if (!storage || !OPEN_PANES_IN.includes(value)) return false;
  try {
    storage.setItem(OPEN_PANES_IN_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

// The lens for a pane never chosen for: the one "Open panes in" names, and on
// Auto a phone (narrow) or touch layout reads the chat first, a desktop the terminal.
export function defaultLens({ preference = "auto", compact = false, touch = false } = {}) {
  if (LENSES.includes(preference)) return preference;
  return compact || touch ? "chat" : "terminal";
}

// The lens shown: the one chosen (or the default), but never a chat the pane
// does not have.
export function chooseLens({ stored = null, chatAvailable = false, preference = "auto", compact = false, touch = false } = {}) {
  const wanted = LENSES.includes(stored) ? stored : defaultLens({ preference, compact, touch });
  return wanted === "chat" && !chatAvailable ? "terminal" : wanted;
}

// The agents whose conversation the server can read (public/agents.js).
export const CHAT_AGENTS = Object.freeze(agentNamesWith("chat"));

function agentNames(pane, agent) {
  return [pane?.agent, pane?.agent_session?.agent, agent?.agent]
    .filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim().toLowerCase());
}

// Whether a snapshot names this pane's agent as Claude Code.
export function isClaudePane(pane, agent) {
  return agentNames(pane, agent).includes("claude");
}

// The agent the snapshot names for this pane when the chat can read its
// conversation (one of CHAT_AGENTS), else null. The pane's own agent comes
// first, as the server reads it.
export function chatAgent(pane, agent) {
  const [name] = agentNames(pane, agent);
  return CHAT_AGENTS.includes(name) ? name : null;
}

// What the disabled Chat button says, by the reason the server gave.
const UNAVAILABLE_TEXT = {
  pane_not_found: "Chat is unavailable: this pane is gone.",
  not_claude: "Chat is only for Claude Code panes.",
  not_supported_agent: `Chat is only for ${listOfNames(productNamesWith("chat"))} panes.`,
  unsupported_opencode_version: "Chat can't read this OpenCode version's conversations yet.",
  opencode_needs_newer_node: "Chat needs Node 22.13 or newer on this machine to read OpenCode conversations.",
  no_session_id: "Chat appears once the agent reports its conversation.",
  server_unavailable: "Chat is unavailable: the machine is not connected.",
  linked_pc_old: "Chat needs a newer HerdRabbit on that PC: update it there.",
  transcript_missing: "Chat is unavailable: the agent's conversation file was not found.",
  opencode_busy: "OpenCode's database is busy. Trying again shortly.",
};

export function chatUnavailableText(reason) {
  return UNAVAILABLE_TEXT[reason] ?? "Chat is unavailable for this pane.";
}

// A read that failed only this time (a database too busy to answer): the chat
// keeps what it shows and says so, rather than reading as no conversation.
export function chatReadBusy(reason) {
  return reason === "opencode_busy";
}

// Reasons that may change while the pane stays: worth asking again later.
export function chatMayBecomeAvailable(reason) {
  return reason !== "not_claude" && reason !== "not_supported_agent";
}

// What in a chat answers a click itself, so the click leaves focus there:
// controls, links, the prompt card's field, a file path. (The conversation's
// scroll box is focusable only to scroll by keyboard.)
const CHAT_OWN_CONTROLS = "a, button, input, textarea, select, summary, label, [contenteditable], [data-path], [data-action], " +
  "[tabindex]:not([tabindex='-1']):not(.pane-grid-cell):not(.chat-scroll)";

// A click on a chat that hands the typing to the composer: not on one of the
// chat's own controls, and not the end of a text selection, which stays to be copied.
export function chatPressTakesComposer(target, selection = globalThis.getSelection?.()) {
  if (typeof target?.closest !== "function" || target.closest(CHAT_OWN_CONTROLS)) return false;
  return selection?.isCollapsed ?? true;
}

// --- a grid cell's lens -------------------------------------------------------
// In a split (a Herdr grid or this window's view split) every cell shows its
// own pane in Chat or Terminal, by the same choice kept per pane above. A
// cell smaller than this has no room to read a conversation: it shows the
// terminal, and the pane opened alone shows its chat.
export const CHAT_CELL_MIN_WIDTH = 320;
export const CHAT_CELL_MIN_HEIGHT = 220;
export const CHAT_CELL_TOO_SMALL = "Too small for the chat. Open alone";

// Whether a cell of `width` by `height` px has room for its pane's chat.
export function chatCellRoomy({ width, height } = {}) {
  return width >= CHAT_CELL_MIN_WIDTH && height >= CHAT_CELL_MIN_HEIGHT;
}

// What a cell shows: `wanted` is the pane's lens (chooseLens, which already
// gives "terminal" to a pane with no chat), `chatAvailable` whether it has a
// chat, `roomy` whether the cell has room for one. `chatEnabled` is whether
// its Chat button can be pressed; `tooSmall` that the chat it wants does not
// fit (the cell says so).
export function cellLens({ wanted = "terminal", chatAvailable = false, roomy = true } = {}) {
  const wantsChat = wanted === "chat" && chatAvailable === true;
  return {
    lens: wantsChat && roomy ? "chat" : "terminal",
    chatEnabled: chatAvailable === true && roomy,
    tooSmall: wantsChat && !roomy,
  };
}
