// Ported from herdr-web-ui (MIT), server/attach-output.ts.

// Everything HerdRabbit reads from `herdr terminal attach`'s own words lives
// here. herdr 0.9 tells why an attach ended only in its last stderr line, after
// it restores the terminal; test/attach-output.test.mjs holds that output as
// herdr 0.9.3 prints it, so a herdr that words it differently fails there.

// A read of the same terminal is in progress; herdr asks for a retry.
const READ_RACE_RE = /has a read in progress; retry/u;
// Another client holds the terminal's one attach slot. Only the attach's last
// line counts: the same words earlier in the pane's own output do not.
const HELD_RE = /terminal attach failed: [^\r\n]*(?:already has an attached client|retry with --takeover)[^\r\n]*\s*$/u;
// A refusal, maybe not all of it yet, still the last output before the exit.
const REFUSING_RE = /terminal attach failed[^\r\n]*\s*$/u;
// What the attach writes before herdr answers: mode switches only.
const PREAMBLE_RE = /^(?:\x1b\[\?[\d;]+[hl])*(?:\x1b(?:\[(?:\?[\d;]*)?)?)?$/u;

// Why an attach that exited with `code` ended, from its last output:
// "taken-over" (another client took the slot), "held" (another client has it),
// "read-race" (try again), or "ended" (the pane's terminal went away, or the
// attach just stopped).
export function attachEnd(output, code) {
  if (code === 0) return "ended";
  if (isTakeoverExit(output)) return "taken-over";
  if (READ_RACE_RE.test(output)) return "read-race";
  if (HELD_RE.test(output)) return "held";
  return "ended";
}

// The output so far ends in a refusal whose exit has not come yet.
export function isRefusing(output) {
  return REFUSING_RE.test(output);
}

// Nothing but the mode switches the attach writes before herdr has answered.
export function isAttachPreamble(text) {
  return PREAMBLE_RE.test(text);
}

// herdr 0.9's terminal teardown immediately before its own stderr diagnostic.
const TEARDOWN = "\x1b[?1049l\x1b[?25h\x1b[0 q";
const TAKEN = `${TEARDOWN}herdr: server shut down: terminal attach taken over`;

// The attach's own final diagnostic, not these words in the pane's screen.
export function isTakeoverExit(output) {
  return output.trimEnd().endsWith(TAKEN);
}

// Holds back only a possible trailing takeover diagnostic until the exit
// confirms it. Everything else passes through, including the same words in the
// pane's own screen.
export class AttachOutputTail {
  #tail = "";

  get pending() { return this.#tail.length > 0; }

  push(data) {
    const text = this.#tail + data;
    this.#tail = "";
    const full = text.lastIndexOf(TAKEN);
    if (full !== -1 && /^[\r\n]{0,4}$/u.test(text.slice(full + TAKEN.length))) {
      this.#tail = text.slice(full);
      return text.slice(0, full);
    }
    // A read may split anywhere in the teardown or the diagnostic, even at the first ESC.
    for (let length = Math.min(text.length, TAKEN.length - 1); length > 0; length--) {
      if (text.endsWith(TAKEN.slice(0, length))) {
        this.#tail = text.slice(-length);
        return text.slice(0, -length);
      }
    }
    return text;
  }

  flush(taken = false) {
    const data = taken && this.#tail.startsWith(TAKEN) ? TEARDOWN : this.#tail;
    this.#tail = "";
    return data;
  }
}
