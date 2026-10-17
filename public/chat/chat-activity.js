// What the end of the Chat lens says while the agent works: a "Claude is
// working" (or "Codex is working") row with the time it has taken, and the message just sent shown as
// a pending bubble until the transcript has it.

// How long a sent message waits for the transcript before its bubble goes.
import { CHAT_AGENTS } from "../lens-preference.js?v=1.2.71";

export const PENDING_MS = 30_000;
// How long a send alone (no status yet) keeps the working row up.
export const OPTIMISTIC_MS = 30_000;

// Whether the working row shows: the agent works, or a message just went out
// and no status has answered it yet. A blocked agent shows its card instead.
export function showsWorking({ status, optimisticUntil = 0, now = Date.now() }) {
  if (status === "blocked") return false;
  if (status === "working") return true;
  return optimisticUntil > now;
}

// "12s", "1m 12s", "1h 3m".
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// The name a row or card gives the agent herdr names.
const AGENT_LABELS = { claude: "Claude", codex: "Codex" };
export function agentLabel(agent) {
  return AGENT_LABELS[String(agent ?? "").toLowerCase()] ?? "The agent";
}

export function workingText(since, now = Date.now(), agent = "claude") {
  const working = `${agentLabel(agent)} is working`;
  return since === null || since === undefined ? working : `${working} · ${formatElapsed(now - since)}`;
}

// A user turn's text as the composer would have sent it, for matching.
export function comparableText(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

export function userTexts(turns) {
  return (turns ?? []).filter((turn) => turn?.role === "user")
    .map((turn) => comparableText((turn.parts ?? []).filter((part) => part.kind === "text").map((part) => part.text).join("\n\n")));
}

// A pending message as sent: its text, when, and how many user turns already
// said the same (it resolves once one more does).
export function pendingMessage(text, turns, now = Date.now()) {
  const wanted = comparableText(text);
  return { text, at: now, baseline: userTexts(turns).filter((said) => said === wanted).length };
}

// The pending messages still waiting: the ones the transcript has not shown
// yet, and not older than PENDING_MS.
export function settlePending(pending, turns, now = Date.now(), maxAge = PENDING_MS) {
  const said = userTexts(turns);
  return pending.filter((item) => {
    if (now - item.at > maxAge) return false;
    const wanted = comparableText(item.text);
    return said.filter((text) => text === wanted).length <= item.baseline;
  });
}

// Whether the composer shows Stop: the Chat lens is on a Claude or Codex pane
// whose agent herdr says is working. A blocked agent has its card instead, and
// a send no status has answered yet is only a guess, so neither shows it.
export function showsStop({ lens, agent, status }) {
  return lens === "chat" && CHAT_AGENTS.includes(String(agent ?? "").toLowerCase()) && status === "working";
}

// What the composer's Send button does: Stop while Stop shows and the composer
// is not focused, Send otherwise. Typing in the composer always gets Send.
export function sendButtonMode({ lens, agent, status, composerFocused = false }) {
  return !composerFocused && showsStop({ lens, agent, status }) ? "stop" : "send";
}

// Whether Esc in the composer stops the agent, as the Stop button does. Only a
// plain Esc while Stop shows, and never while something else answers Esc: an
// IME composing, the @ file list, the find bar or a dialog.
export function composerEscapeStops({ key, isComposing = false, keyCode = 0, ctrlKey = false, altKey = false,
  metaKey = false, shiftKey = false, stopShown = false, ownedElsewhere = false }) {
  if (key !== "Escape" || isComposing || keyCode === 229) return false;
  if (ctrlKey || altKey || metaKey || shiftKey) return false;
  return stopShown && !ownedElsewhere;
}
