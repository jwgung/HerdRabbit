import test from "node:test";
import assert from "node:assert/strict";
import { attachProblemText, terminalStatus, terminalStatusSentence, SLOW_CONNECT_MS } from "../public/terminal-status.js";

const ready = { state: "ready", since: 0, retryAt: null, failed: false };
const say = (input) => terminalStatusSentence(terminalStatus({ now: 10_000, ...input }).status);

test("a normal connect says nothing until it takes longer than a few seconds", () => {
  const connecting = { state: "connecting", since: 10_000, retryAt: null, failed: false };
  const quiet = terminalStatus({ connection: connecting, now: 10_000 });
  assert.equal(quiet.status, null);
  assert.equal(quiet.recheckAt, 10_000 + SLOW_CONNECT_MS, "looked at again once the quiet time is over");
  const slow = terminalStatus({ connection: connecting, now: 10_000 + SLOW_CONNECT_MS });
  assert.equal(slow.status.text, "Still connecting to HerdRabbit…");
  assert.equal(slow.status.reconnect, true);
  assert.equal(say({ connection: { state: "idle" } }), "");
  assert.equal(say({ connection: ready, attach: { state: "live", since: 0, problem: null } }), "");
});

test("a lost socket says so with a countdown and offers Reconnect, until it is ready again", () => {
  const waiting = terminalStatus({ connection: { state: "waiting", since: 9_000, retryAt: 17_500, failed: true }, now: 10_000 });
  assert.equal(terminalStatusSentence(waiting.status), "Disconnected from HerdRabbit — retrying in 8s");
  assert.equal(waiting.status.reconnect, true);
  assert.equal(waiting.status.target, "connection");
  assert.equal(waiting.recheckAt, 11_000, "the countdown ticks");
  assert.equal(say({ connection: { state: "connecting", since: 10_000, failed: true } }), "Disconnected from HerdRabbit — reconnecting…",
    "a retry after a failure is said at once, not after the quiet seconds");
  assert.equal(say({ connection: { state: "waiting", retryAt: 12_000, failed: true }, offline: true }), "No network connection — retrying in 2s");
  // The socket comes first: an attach problem waits for a socket to tell.
  assert.match(say({ connection: { state: "waiting", retryAt: 12_000, failed: true },
    attach: { state: "failed", problem: { code: "pane_not_found", retryAt: 15_000 } } }), /^Disconnected/u);
});

test("an ended sign-in asks for a reload and offers no Reconnect; a page in the background says nothing", () => {
  const { status } = terminalStatus({ connection: { state: "signed-out", failed: true }, now: 0 });
  assert.equal(status.text, "Sign-in expired — reload to sign in again.");
  assert.equal(status.reconnect, false);
  assert.equal(say({ connection: { state: "paused" } }), "");
});

test("each attach error has its own reason, and Reconnect only where a retry can help", () => {
  const cases = [
    ["pane_not_found", null, "This pane is gone.", false],
    ["pane_not_restored", null, "This pane is gone.", false],
    ["no_terminal", null, "This pane has no terminal to open.", true],
    ["server_unavailable", null, "Herdr is not answering.", true],
    ["herdr_timeout", "desk", "Herdr on desk is not answering.", true],
    ["busy", null, "Too many terminals are open. Close one, then reconnect.", true],
    ["link_unreachable", "desk", "desk is offline.", true],
    ["link_timeout", "desk", "desk is not answering.", true],
    ["link_unauthorized", "desk", "desk does not allow this PC. Add this PC to its allowed list there.", true],
    ["link_unreachable", null, "That PC is offline.", true],
    ["ended", null, "The terminal closed. Showing its screen until it opens again.", true],
    ["attach_failed", null, "Couldn't open this terminal.", true],
    ["something_new", null, "Couldn't open this terminal.", true],
  ];
  for (const [code, machine, text, reconnect] of cases) {
    assert.deepEqual(attachProblemText(code, { machine }), { quiet: false, text, reconnect }, code);
  }
});

test("a read-only mirror says why quietly, with no Reconnect and no countdown", () => {
  assert.deepEqual(attachProblemText("attach_unsupported"), { text: "Shown read-only: this PC can't attach terminals.", reconnect: false, quiet: true });
  assert.equal(attachProblemText("attach_unsupported", { machine: "desk" }).text, "Shown read-only: desk can't attach terminals.");
  assert.equal(attachProblemText("attach_unsupported", { machine: "desk", message: "HerdRabbit at http://desk is too old to attach its terminals." }).text,
    "Shown read-only: desk runs an older HerdRabbit that can't attach terminals.");
  const { status, recheckAt } = terminalStatus({ connection: ready, now: 0,
    attach: { state: "failed", since: 0, problem: { code: "attach_unsupported", retryAt: Infinity } } });
  assert.equal(terminalStatusSentence(status), "Shown read-only: this PC can't attach terminals.");
  assert.equal(status.quiet, true);
  assert.equal(recheckAt, null);
});

test("a failed attach counts down to its retry, keeps its reason while retrying, and a held or live pane says nothing", () => {
  const problem = { code: "server_unavailable", message: "", retryAt: 14_200 };
  const failed = terminalStatus({ connection: ready, attach: { state: "failed", since: 9_000, problem }, now: 10_000 });
  assert.equal(terminalStatusSentence(failed.status), "Herdr is not answering — retrying in 5s");
  assert.equal(failed.status.target, "attach");
  assert.equal(say({ connection: ready, attach: { state: "attaching", since: 10_000, problem } }), "Herdr is not answering — retrying…");
  assert.equal(say({ connection: ready, attach: { state: "failed", since: 0, problem: { code: "pane_not_found", retryAt: 15_000 } } }),
    "This pane is gone.", "nothing to count down to without a Reconnect");
  assert.equal(say({ connection: ready, attach: { state: "held", since: 0, problem: null } }), "", "the held strip says it already");
  assert.equal(say({ connection: ready, attach: { state: "attaching", since: 9_000, problem: null } }), "");
  const slow = terminalStatus({ connection: ready, attach: { state: "attaching", since: 0, problem: null }, now: SLOW_CONNECT_MS });
  assert.equal(slow.status.text, "Opening this terminal…");
  assert.equal(slow.status.reconnect, false);
});
