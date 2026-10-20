// Which lens a pane shows: its agent's conversation (Claude Code's or
// Codex's) as a chat, or its terminal.
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

// The agents whose conversation the server can read.
export const CHAT_AGENTS = Object.freeze(["claude", "codex", "opencode"]);

function agentNames(pane, agent) {
  return [pane?.agent, pane?.agent_session?.agent, agent?.agent]
    .filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim().toLowerCase());
}

// Whether a snapshot names this pane's agent as Claude Code.
export function isClaudePane(pane, agent) {
  return agentNames(pane, agent).includes("claude");
}

// The agent the snapshot names for this pane when the chat can read its
// conversation ("claude", "codex" or "opencode"), else null. The pane's own agent comes
// first, as the server reads it.
export function chatAgent(pane, agent) {
  const [name] = agentNames(pane, agent);
  return CHAT_AGENTS.includes(name) ? name : null;
}

// What the disabled Chat button says, by the reason the server gave.
const UNAVAILABLE_TEXT = {
  pane_not_found: "Chat is unavailable: this pane is gone.",
  not_claude: "Chat is only for Claude Code panes.",
  not_supported_agent: "Chat is only for Claude Code, Codex and OpenCode panes.",
  unsupported_opencode_version: "Chat can't read this OpenCode version's conversations yet.",
  opencode_needs_newer_node: "Chat needs Node 22.5 or newer on this machine to read OpenCode conversations.",
  no_session_id: "Chat appears once the agent reports its session.",
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
