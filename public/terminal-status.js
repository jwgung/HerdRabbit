// What the strip over the Terminal lens says when the terminal is not live,
// and whether it offers Reconnect. Pure: the page passes in the socket's and
// the attach's state, and the clock.

// The normal connect and attach say nothing unless they take longer than this.
export const SLOW_CONNECT_MS = 3_000;

const PANE_GONE = { text: "This pane is gone.", reconnect: false };
const HERDR_SILENT = { text: "Herdr is not answering.", reconnect: true };
const HERDR_FAILED = { text: "Herdr could not open this terminal.", reconnect: true };
const BUSY = { text: "Too many terminals are open. Close one, then reconnect.", reconnect: true };

// Why one pane could not attach, by the code the server gave. `machine` names
// a connected PC whose pane it is, or is null for this PC's own pane.
const ATTACH_REASONS = {
  pane_not_found: () => PANE_GONE,
  pane_not_restored: () => PANE_GONE,
  no_terminal: () => ({ text: "This pane has no terminal to open.", reconnect: true }),
  server_unavailable: (machine) => machine ? { ...HERDR_SILENT, text: `Herdr on ${machine} is not answering.` } : HERDR_SILENT,
  herdr_timeout: (machine) => machine ? { ...HERDR_SILENT, text: `Herdr on ${machine} is not answering.` } : HERDR_SILENT,
  herdr_command_failed: () => HERDR_FAILED,
  invalid_herdr_response: () => HERDR_FAILED,
  busy: () => BUSY,
  too_many_attachments: () => BUSY,
  link_unreachable: (machine) => ({ text: `${machine} is offline.`, reconnect: true }),
  link_timeout: (machine) => ({ text: `${machine} is not answering.`, reconnect: true }),
  link_unauthorized: (machine) => ({ text: `${machine} does not allow this PC. Add this PC to its allowed list there.`, reconnect: true }),
  link_tls: (machine) => ({ text: `${machine}'s HTTPS certificate was rejected.`, reconnect: true }),
  link_unsupported: (machine) => ({ text: `${machine} needs a newer HerdRabbit. Update it there.`, reconnect: true }),
  link_protocol_mismatch: (machine) => ({ text: `HerdRabbit on ${machine} does not match this one. Update both.`, reconnect: true }),
  link_not_herdrabbit: (machine) => ({ text: `${machine} is not answering as HerdRabbit.`, reconnect: true }),
  link_scope: (machine) => ({ text: `${machine} refused this terminal.`, reconnect: true }),
  // herdr ended the attach (the program quit, or herdr restarted): the screen
  // is mirrored until it attaches again.
  ended: () => ({ text: "The terminal closed. Showing its screen until it opens again.", reconnect: true }),
  // Never attaches here: a read-only mirror, said quietly, with nothing to retry.
  attach_unsupported: (machine, message) => ({
    text: !machine ? "Shown read-only: this PC can't attach terminals."
      : /too old/iu.test(message ?? "") ? `Shown read-only: ${machine} runs an older HerdRabbit that can't attach terminals.`
        : `Shown read-only: ${machine} can't attach terminals.`,
    reconnect: false,
    quiet: true,
  }),
};

// The reason one attach failed, as the strip words it.
export function attachProblemText(code, { machine = null, message = "" } = {}) {
  const reason = ATTACH_REASONS[code];
  const named = machine || "That PC";
  if (reason) return { quiet: false, ...reason(code.startsWith("link_") ? named : machine, message) };
  return { text: "Couldn't open this terminal.", reconnect: true, quiet: false };
}

function countdown(retryAt, now) {
  if (!Number.isFinite(retryAt)) return null;
  const seconds = Math.ceil((retryAt - now) / 1000);
  return seconds > 0 ? `retrying in ${seconds}s` : "retrying…";
}

// connection: { state: "idle" | "connecting" | "ready" | "waiting" | "paused" | "signed-out",
//   since, retryAt, failed } -- `failed` once a socket closed and none is ready yet.
// attach: null, or { state: "attaching" | "live" | "held" | "failed", since,
//   problem: { code, message, retryAt } | null, machine } for the pane on screen.
// Answers null when nothing is to be said, or
// { text, countdown, reconnect, target: "connection" | "attach", quiet };
// `recheckAt` says when the answer may change without any event (a countdown
// ticking, or the quiet first seconds of a connect running out).
export function terminalStatus({ connection, attach = null, offline = false, now = Date.now() }) {
  const state = connection?.state ?? "idle";
  if (state === "paused") return { status: null, recheckAt: null };
  if (state === "signed-out") {
    return { status: { text: "Sign-in expired — reload to sign in again.", countdown: null, reconnect: false, target: "connection", quiet: false }, recheckAt: null };
  }
  const lost = offline ? "No network connection" : "Disconnected from HerdRabbit";
  if (state === "waiting") {
    return {
      status: { text: lost, countdown: countdown(connection.retryAt, now), reconnect: true, target: "connection", quiet: false },
      recheckAt: now + 1000,
    };
  }
  if (state === "connecting") {
    if (connection.failed) {
      return { status: { text: lost, countdown: "reconnecting…", reconnect: true, target: "connection", quiet: false }, recheckAt: null };
    }
    const slowAt = (connection.since ?? now) + SLOW_CONNECT_MS;
    if (now < slowAt) return { status: null, recheckAt: slowAt };
    return { status: { text: "Still connecting to HerdRabbit…", countdown: null, reconnect: true, target: "connection", quiet: false }, recheckAt: null };
  }
  if (state !== "ready" || !attach) return { status: null, recheckAt: null };
  if (attach.state === "live" || attach.state === "held") return { status: null, recheckAt: null };
  const problem = attach.problem;
  if (problem) {
    const reason = attachProblemText(problem.code, { machine: attach.machine, message: problem.message });
    const retrying = attach.state === "attaching" ? "retrying…" : countdown(problem.retryAt, now);
    return {
      status: { ...reason, countdown: reason.reconnect ? retrying : null, target: "attach" },
      recheckAt: reason.reconnect && attach.state === "failed" && Number.isFinite(problem.retryAt) ? now + 1000 : null,
    };
  }
  if (attach.state !== "attaching") return { status: null, recheckAt: null };
  const slowAt = (attach.since ?? now) + SLOW_CONNECT_MS;
  if (now < slowAt) return { status: null, recheckAt: slowAt };
  return { status: { text: "Opening this terminal…", countdown: null, reconnect: false, target: "attach", quiet: true }, recheckAt: null };
}

// The strip's whole sentence, as a screen reader and a test read it.
// The strip's two parts: the reason (announced when it changes) and the
// countdown after it (ticking silently).
export function terminalStatusParts(status) {
  if (!status) return { reason: "", countdown: "" };
  return status.countdown
    ? { reason: status.text.replace(/\.$/u, ""), countdown: ` — ${status.countdown}` }
    : { reason: status.text, countdown: "" };
}

export function terminalStatusSentence(status) {
  const { reason, countdown } = terminalStatusParts(status);
  return reason + countdown;
}

// Where the pane on screen is in attaching, and why each pane last failed to.
// The page notes what it hears of the attach and asks for the pane's:
//   note(paneId, next, now)    the pane's attach is "attaching", "held" or "live";
//                              only the pane on screen has one, so this replaces
//                              any other pane's. The same state again keeps its
//                              `since`. A reason carries over until "live".
//   failed(paneId, problem, now)  the pane could not attach (it is mirrored);
//                              remembered for any pane, and the attach of the
//                              pane on screen becomes "failed"
//   of(paneId)                 { paneId, state, since, problem } for terminalStatus,
//                              or null; a pane not on screen that failed is
//                              "failed" with `since` 0
export function createAttachTracker() {
  let attach = null;
  const problems = new Map();
  return {
    note(paneId, next, now = Date.now()) {
      if (next === "live") problems.delete(paneId);
      const same = attach?.paneId === paneId;
      const problem = next === "live" ? null : (same ? attach.problem : null) ?? problems.get(paneId) ?? null;
      const since = same && attach.state === next ? attach.since : now;
      attach = { paneId, state: next, since, problem };
    },
    failed(paneId, problem, now = Date.now()) {
      problems.set(paneId, problem);
      if (attach?.paneId === paneId) attach = { paneId, state: "failed", since: now, problem };
    },
    of(paneId) {
      if (!paneId) return null;
      if (attach?.paneId === paneId) return attach;
      if (problems.has(paneId)) return { paneId, state: "failed", since: 0, problem: problems.get(paneId) };
      return null;
    },
  };
}
