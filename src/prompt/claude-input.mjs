// Claude Code's input box as its screen shows it, and what to do about a
// message an Esc put back there.
//
// Esc right after a message went in interrupts Claude Code and hands the
// message back to its input box for editing. The next message HerdRabbit sends
// is typed after it, so Claude would get the two run together. Before that
// send, the box is read: if it holds exactly the message HerdRabbit sent before
// the stop, it is cleared. Anything else in it (text typed in the terminal) is
// left as it is.
import { ANSI_RE } from "./screen.mjs";

// Claude's prompt row: "❯ text" from the left edge. Claude Code draws a
// no-break space (U+00A0) after the mark, not a plain one.
const PROMPT_RE = /^❯(?:[ \u00a0]|$)/u;
// The box's rules: plain, or named after the session ("──── my-session ─").
const RULE_RE = /^─{3,}(?: \S(?:.*\S)? ─)?$/u;

// The box's text (rows joined by "\n", the prompt mark and indent dropped) and
// how many rows it takes, or null when the screen shows no input box: the
// last "❯" row with a rule right above it and one somewhere below it.
export function claudeInputBox(screen) {
  const lines = String(screen ?? "").replace(ANSI_RE, "").split(/\r?\n/u).map((line) => line.replace(/\s+$/u, ""));
  const at = lines.findLastIndex((line) => PROMPT_RE.test(line));
  if (at < 1 || !RULE_RE.test(lines[at - 1].trim())) return null;
  const rows = [lines[at].replace(/^❯[ \u00a0]?/u, "")];
  let end = at + 1;
  for (; end < lines.length && !RULE_RE.test(lines[end].trim()); end += 1) rows.push(lines[end].replace(/^ {1,2}/u, ""));
  if (end >= lines.length) return null;
  return { text: rows.join("\n").replace(/\s+$/u, ""), rows: rows.length };
}

// Text as compared here: no whitespace at all, as a long line wraps anywhere.
function squashed(text) {
  return String(text ?? "").replace(/\s+/gu, "");
}

// The next step in clearing the message put back after a stop, given the box
// as it is now and as it was before the last keys (null on the first look):
// { done: true } to send the new message, { keys } to send and look again, or
// { stuck: true } when the keys change nothing (the send is refused, so the
// person clears the box themselves rather than get the two run together).
//
// Only ever deletes the message itself: the first look must find exactly it,
// each later one a shorter piece of its start. Ctrl+K then Ctrl+U empty the
// row the cursor is on; on a row already empty, Backspace joins it to the one
// above, which Ctrl+U then empties.
export function restoredDraftStep(box, restored, before = null) {
  const wanted = squashed(restored);
  const now = squashed(box?.text);
  if (!box || !wanted || !now) return { done: true };
  if (before === null) return now === wanted ? { keys: ["ctrl+k", "ctrl+u"] } : { done: true };
  if (!wanted.startsWith(now)) return { done: true };
  const shorter = now.length < squashed(before.text).length || box.rows < before.rows;
  return shorter ? { keys: ["backspace", "ctrl+u"] } : { stuck: true };
}
