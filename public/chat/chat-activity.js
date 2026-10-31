// What the end of the Chat lens says while the agent works: a "Claude is
// working" (or "Codex is working", "OpenCode is working") row with the time it has taken, and the message just sent shown as
// a pending bubble until the transcript has it.

import { agentLabelFor, agentNamesWith } from "../agents.js?v=1.4.14";

// How long a sent message waits for the transcript before its bubble goes.
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
export function agentLabel(agent) {
  return agentLabelFor(agent);
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
  return userEntries(turns).map((entry) => entry.text);
}

// The user turns that say something, each with a mark that finds it again in
// a later read of the transcript (its time and words).
function userEntries(turns) {
  return (turns ?? []).filter((turn) => turn?.role === "user").flatMap((turn) => {
    const raw = (turn.parts ?? []).filter((part) => part.kind === "text").map((part) => part.text).join("\n\n");
    const text = comparableText(raw);
    return text ? [{ text, mark: `${turn.ts ?? ""}\u0000${text}` }] : [];
  });
}

// Whether a user turn is the message sent: the same words, or the same words
// at its end. After a Stop, Claude Code puts the stopped message back in its
// input box and the next one is typed after it, so Claude gets both as one,
// with no space between. So an ending counts only when what comes before it
// is a message this page sent earlier (priors); "do not deploy" is not
// "deploy", whoever sent it. Anything else waits for the stale rule.
export function saysSent(said, sent, priors = []) {
  const wanted = comparableText(sent);
  if (wanted === "") return false;
  if (said === wanted) return true;
  if (!said.endsWith(wanted)) return false;
  const before = said.slice(0, -wanted.length);
  return priors.some((prior) => comparableText(prior) === before.trim());
}

// How long a pending message waits on a newer user turn that is not it before
// it goes: the transcript said something else where it should have been.
export const STALE_PENDING_MS = 5_000;

// A pending message as sent: its text, when, the last user turn the
// transcript had then (its turn comes after that one), how many messages were
// still on their way before it (their turns come first), and how many user
// turns already said it (for a transcript where that last turn is gone).
export function pendingMessage(text, turns, now = Date.now(), ahead = 0, priors = []) {
  const entries = userEntries(turns);
  const after = entries.at(-1)?.mark ?? null;
  return {
    text, at: now, ahead, after, priors: priors.map(comparableText),
    // which turn with that mark it is (one without a time can repeat)
    afterNth: entries.filter((entry) => entry.mark === after).length,
    baseline: entries.filter((entry) => saysSent(entry.text, text, priors)).length,
  };
}

// The user turns that came after a pending message was sent, or null when the
// turn it was sent after is no longer in the transcript read.
function turnsAfter(item, entries) {
  if (item.after === null || item.after === undefined) return entries;
  let seen = 0;
  const index = entries.findIndex((entry) => entry.mark === item.after && (seen += 1) === item.afterNth);
  return index < 0 ? null : entries.slice(index + 1);
}

// The pending messages still waiting. One goes once a user turn after it
// says it (or ends in it), once newer user turns than the ones before it have
// come for STALE_PENDING_MS and none said it, or after PENDING_MS at most.
export function settlePending(pending, turns, now = Date.now(), maxAge = PENDING_MS) {
  const entries = userEntries(turns);
  return pending.filter((item) => {
    if (now - item.at > maxAge) return false;
    const after = turnsAfter(item, entries);
    if (after === null) return entries.filter((entry) => saysSent(entry.text, item.text, item.priors)).length <= (item.baseline ?? 0);
    if (after.some((entry) => saysSent(entry.text, item.text, item.priors))) return false;
    return !(now - item.at >= STALE_PENDING_MS && after.length > (item.ahead ?? 0));
  });
}

// The agents whose chat offers Stop: Esc interrupts them (OpenCode's takes
// two, see stopPresses).
const STOP_AGENTS = Object.freeze(agentNamesWith("stop"));

// What Stop sends to the agent: how many Escs, and the pause between them.
// OpenCode (1.18.34, packages/tui/src/component/prompt/index.tsx) interrupts
// only on a second Esc within 5 seconds of the first ("esc again to
// interrupt"), so its Stop sends both. They go apart, not as one write:
// two Escs back to back can read as Alt+Esc.
export const OPENCODE_STOP_GAP_MS = 400;
export function stopPresses(agent) {
  return String(agent ?? "").toLowerCase() === "opencode"
    ? { presses: 2, gapMs: OPENCODE_STOP_GAP_MS }
    : { presses: 1, gapMs: 0 };
}

// OpenCode's Esc is not always its interrupt: an open autocomplete list, its
// shell mode ("!") or an input without the focus takes it first, and the two
// Escs then stop nothing. So a moment after an OpenCode Stop the chat looks
// again, and says so if the agent still works. A hint, not a retry: another
// Esc could close what the first one opened.
export const OPENCODE_STOP_CHECK_MS = 2_500;
export const OPENCODE_STOP_HINT = "OpenCode is still working. If it should stop, press Stop again or press Esc twice in the terminal.";
export function stopFollowUp(agent) {
  return String(agent ?? "").toLowerCase() === "opencode"
    ? { afterMs: OPENCODE_STOP_CHECK_MS, message: OPENCODE_STOP_HINT }
    : null;
}

// Whether the composer shows Stop: the Chat lens is on the pane of an agent
// with Stop (public/agents.js) whose agent herdr says is working. A blocked agent has its card instead, and
// a send no status has answered yet is only a guess, so neither shows it.
export function showsStop({ lens, agent, status }) {
  return lens === "chat" && STOP_AGENTS.includes(String(agent ?? "").toLowerCase()) && status === "working";
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
