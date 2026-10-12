// Ported from herdr-web-ui (MIT), server/attach-output.ts.

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
