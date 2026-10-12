// Ported from herdr-web-ui (MIT), server/output-window.ts.
import { randomUUID } from "node:crypto";

// Count UTF-8 payload bytes, not JSON framing or UTF-16 string length. A fresh
// stream id keeps a late acknowledgement from crediting a later attach.
export const OUTPUT_HIGH_BYTES = 256 * 1024;
export const OUTPUT_LOW_BYTES = 64 * 1024;
export const OUTPUT_HARD_BYTES = 1024 * 1024;
export const OUTPUT_STALL_MS = 2000;

export class OutputWindow {
  id = randomUUID();
  sent = 0;
  acknowledged = 0;
  blocked = false;

  get pending() { return this.sent - this.acknowledged; }

  write(bytes) {
    this.sent += bytes;
    if (this.pending >= OUTPUT_HIGH_BYTES) this.blocked = true;
    return this.sent;
  }

  acknowledge(id, offset) {
    if (id !== this.id || !Number.isSafeInteger(offset) || offset < 0 || offset > this.sent) return false;
    // Duplicate and out-of-order acknowledgements cannot release credit twice.
    this.acknowledged = Math.max(this.acknowledged, offset);
    if (this.pending <= OUTPUT_LOW_BYTES) this.blocked = false;
    return true;
  }
}

// DEC private mode switches (CSI ? Pm h / CSI ? Pm l): alternate screen, mouse reporting, ...
const PRIVATE_MODES = /\x1b\[\?([\d;]+)([hl])/gu;
// xterm's modifyOtherKeys: CSI > 4 ; level m, off with CSI > 4 m, CSI > 4 n, or a bare CSI > m / CSI > n.
const MODIFY_OTHER_KEYS = /\x1b\[>(4(?:;(\d*))?)?([mn])/gu;
// An ESC, or a CSI still missing its final byte.
const INCOMPLETE_CSI = /^\x1b(\[[\x30-\x3f]*[\x20-\x2f]*)?$/u;

// What a client joining a live attachment is sent: the bounded tail of the
// stream, led by the private modes set by output that has already fallen out of
// it. `herdr terminal attach` turns the alternate screen and mouse reporting on
// once, at the start; a late joiner without them would turn the wheel into
// arrow keys and walk the agent's prompt history instead of herdr's scrollback.
export class ReplayBuffer {
  #tail = "";
  // Each mode's last switch before the tail, in the order of those switches:
  // order matters (1016l after 1006h leaves the mouse encoding at the default).
  #modes = new Map();
  #modifyOtherKeys = 0;

  constructor(limit) { this.limit = limit; }

  // Keeps a bounded UTF-8 tail, never starting inside a code point or a control sequence.
  append(data) {
    const bytes = Buffer.from(this.#tail + data);
    let start = Math.max(0, bytes.length - this.limit);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    const escape = start > 0 ? bytes.lastIndexOf(0x1b, start - 1) : -1;
    if (escape >= 0 && INCOMPLETE_CSI.test(bytes.subarray(escape, start).toString("latin1"))) start = escape;
    if (start === 0) {
      this.#tail += data;
      return;
    }
    const cut = bytes.subarray(0, start).toString("utf8");
    for (const [, params, state] of cut.matchAll(PRIVATE_MODES)) {
      for (const mode of params.split(";").filter(Boolean)) {
        this.#modes.delete(mode);
        this.#modes.set(mode, state);
      }
    }
    for (const [, resource, level, final] of cut.matchAll(MODIFY_OTHER_KEYS)) {
      this.#modifyOtherKeys = resource && final === "m" ? Number(level || 0) : 0;
    }
    this.#tail = bytes.subarray(start).toString("utf8");
  }

  // The stream as a client joining now sees it. Empty until the pane has written anything.
  text() {
    if (!this.#tail) return "";
    const keys = this.#modifyOtherKeys > 0 ? `\x1b[>4;${this.#modifyOtherKeys}m` : "";
    return [...this.#modes].map(([mode, state]) => `\x1b[?${mode}${state}`).join("") + keys + this.#tail;
  }

  get recent() { return this.#tail; }
}
