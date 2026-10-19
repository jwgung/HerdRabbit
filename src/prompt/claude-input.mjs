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
// The prompt row's text when it starts dim: Claude's tip in an empty box.
const DIM_TIP_RE = /^(?:\u001b\[0m)*\u001b\[2m/u;

// The box's text (rows joined by "\n", the prompt mark and indent dropped) and
// how many rows it takes, or null when the screen shows no input box: the
// last "❯" row with a rule right above it and one somewhere below it.
export function claudeInputBox(screen) {
  const raw = String(screen ?? "").split(/\r?\n/u);
  const lines = raw.map((line) => line.replace(ANSI_RE, "").replace(/\s+$/u, ""));
  const at = lines.findLastIndex((line) => PROMPT_RE.test(line));
  if (at < 1 || !RULE_RE.test(lines[at - 1].trim())) return null;
  // An empty box shows a tip in dim text ("Try …"); on a screen read with its
  // styles that is told from words typed there, which are not dim.
  const placeholder = DIM_TIP_RE.test(raw[at].replace(/^\u276f[ \u00a0]?/u, ""));
  const rows = [lines[at].replace(/^❯[ \u00a0]?/u, "")];
  let end = at + 1;
  for (; end < lines.length && !RULE_RE.test(lines[end].trim()); end += 1) rows.push(lines[end].replace(/^ {1,2}/u, ""));
  if (end >= lines.length) return null;
  if (placeholder) return { text: "", rows: 1, empty: true };
  return { text: rows.join("\n").replace(/\s+$/u, ""), rows: rows.length };
}

// Whitespace runs as one space, no space at the ends.
function collapsed(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

// How much of the message the box rows spell, in order: the rows are the
// message wrapped, so each row follows the last either right away (a word
// cut where the line ended) or after one space (a wrap at a space). Returns
// the length matched, or -1 when the rows are not the start of the message.
// Only wrap points are forgiven: "helloworld" is not "hello world".
function matchedLength(boxText, message) {
  const rows = String(boxText ?? "").split("\n").map(collapsed).filter(Boolean);
  let at = 0;
  for (const [index, row] of rows.entries()) {
    if (index > 0 && message[at] === " ") at += 1;
    if (!message.startsWith(row, at)) return -1;
    at += row.length;
  }
  return at;
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
  const wanted = collapsed(restored);
  const now = collapsed(box?.text);
  // A screen that cannot be read halfway through clearing may hide a piece
  // still there: the send is refused rather than typed after it.
  if (!box && before !== null) return { stuck: true };
  // empty (its tip showing, or nothing): there is nothing to type after
  if (box?.empty || (box && !now)) return { done: true };
  if (!box || !wanted) return { done: true };
  if (before === null) return matchedLength(box.text, wanted) === wanted.length ? { keys: ["ctrl+k", "ctrl+u"] } : { done: true };
  const matched = matchedLength(box.text, wanted);
  // Not a piece of the stopped message any more, nor empty: something else
  // changed it while it was being cleared. Refused rather than typed after.
  if (matched < 0) return { stuck: true };
  const shorter = matched < matchedLength(before.text, wanted) || box.rows < before.rows;
  return shorter ? { keys: ["backspace", "ctrl+u"] } : { stuck: true };
}
