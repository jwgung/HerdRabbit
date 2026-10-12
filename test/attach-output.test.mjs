// Ported from herdr-web-ui (MIT).
import test from "node:test";
import { expect } from "./fixtures/expect.mjs";
import { AttachOutputTail, attachEnd, isAttachPreamble, isRefusing } from "../src/attach-output.mjs";

const teardown = "\x1b[?1049l\x1b[?25h\x1b[0 q";
const diagnostic = "herdr: server shut down: terminal attach taken over\r\n";

test("drops only the confirmed trailing diagnostic across every read boundary, keeping terminal modes", () => {
  const output = "pane output" + teardown + diagnostic;
  for (let cut = 1; cut < output.length; cut++) {
    const tail = new AttachOutputTail();
    expect(tail.push(output.slice(0, cut)) + tail.push(output.slice(cut)) + tail.flush(true)).toBe("pane output" + teardown);
  }
  const tail = new AttachOutputTail();
  expect([...output].map((byte) => tail.push(byte)).join("") + tail.flush(true)).toBe("pane output" + teardown);
});

test("preserves ordinary pane output, incomplete diagnostics and diagnostics without a takeover exit", () => {
  for (const output of [diagnostic, teardown + diagnostic + "more output", teardown + "herdr: another error", teardown + diagnostic, teardown + diagnostic + "\n".repeat(1000)]) {
    const tail = new AttachOutputTail();
    expect(tail.push(output) + tail.flush()).toBe(output);
  }
  const tail = new AttachOutputTail();
  expect(tail.push(teardown + "herdr: server shut down: term") + tail.flush(true)).toBe(teardown + "herdr: server shut down: term");
});

// herdr 0.9.3's own words, captured from `herdr terminal attach` on a pty: the
// contract the attachment's decisions rest on. The read race is herdr-web-ui's
// record of herdr 0.9 (src/server/alt_screen_read.rs); it is hard to provoke.
const TEARDOWN = "\x1b[?1049l\x1b[?25h\x1b[0 q";
const HERDR_0_9_3 = {
  held: `${TEARDOWN}herdr: server shut down: terminal attach failed: terminal term_65da0a8fe6c0ca already has an attached client; retry with --takeover\r\n`,
  takenOver: `${TEARDOWN}herdr: server shut down: terminal attach taken over\r\n`,
  gone: `${TEARDOWN}herdr: server shut down: terminal attach failed: terminal  not found\r\n`,
  readRace: `${TEARDOWN}herdr: terminal attach failed: terminal term_1 has a read in progress; retry\r\n`,
};

test("reads why herdr 0.9.3 ended an attach", () => {
  const screen = "\x1b[?1049h$ ls\r\n";
  expect(attachEnd(screen + HERDR_0_9_3.held, 1)).toBe("held");
  expect(attachEnd(screen + HERDR_0_9_3.takenOver, 1)).toBe("taken-over");
  expect(attachEnd(screen + HERDR_0_9_3.readRace, 1)).toBe("read-race");
  expect(attachEnd(screen + HERDR_0_9_3.gone, 1)).toBe("ended");
  expect(attachEnd(screen, 0)).toBe("ended");
  // The same words inside the pane's own output, with more after them, are the pane's.
  expect(attachEnd(HERDR_0_9_3.held + "$ still running\r\n", 1)).toBe("ended");
  expect(isRefusing(HERDR_0_9_3.held)).toBe(true);
  expect(isRefusing(screen)).toBe(false);
});

test("tells the attach's mode switches from a screen", () => {
  expect(isAttachPreamble("\x1b[?1049h\x1b[?1000h\x1b[?100")).toBe(true);
  expect(isAttachPreamble("\x1b[?1049hready")).toBe(false);
  expect(isAttachPreamble(HERDR_0_9_3.held)).toBe(false);
});
