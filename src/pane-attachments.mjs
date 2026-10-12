// A pane's terminal, as herdr itself draws it: one `herdr terminal attach` on a
// real pseudo-terminal per pane, shared by every browser that has the pane open.
// Ported from herdr-web-ui (MIT), server/index.ts (attachments) and
// server/pty/pty-host.mjs, without its Bun sidecar: node-pty runs in this process.
import { AttachOutputTail, isTakeoverExit } from "./attach-output.mjs";
import {
  OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS, OutputWindow, ReplayBuffer,
} from "./output-window.mjs";

export const MAX_REPLAY_BYTES = 256 * 1024;
// herdr refuses an attach while a read of the same terminal is in progress and
// asks for a retry. A long read of an idle alt-screen agent can take seconds.
const ATTACH_READ_RACE_RE = /has a read in progress; retry/u;
// herdr's refusal when another client holds the terminal's one attach slot: the
// attach's last line, after its teardown.
const ATTACH_HELD_RE = /terminal attach failed: [^\r\n]*(?:already has an attached client|retry with --takeover)[^\r\n]*\s*$/u;
// A refusal, maybe not all of it yet, still the last output before the exit.
const ATTACH_REFUSING_RE = /terminal attach failed[^\r\n]*\s*$/u;
// What the attach writes before herdr has answered: mode switches only. They say
// nothing about whether the attach took, so they do not start the hold.
const ATTACH_PREAMBLE_RE = /^(?:\x1b\[\?[\d;]+[hl])*(?:\x1b(?:\[(?:\?[\d;]*)?)?)?$/u;
const PANE_GONE_CODES = new Set(["pane_not_found", "pane_not_restored", "no_terminal"]);
export const ATTACH_DEFAULTS = Object.freeze({
  retryForMs: 20_000,
  retryMs: 50,
  retryMaxMs: 500,
  // A refused attach says so within milliseconds of its first bytes; those are
  // held this long so a refusal is never painted into the terminal.
  holdMs: 100,
  refusalExitMs: 2_000,
  // How often a terminal another client holds is tried again.
  heldRetryMs: 3_000,
  // A live handoff moves every pane to a new terminal id and ends each attach
  // the way an exited pane's ends: the pane is looked up again for this long.
  relookupForMs: 5_000,
  relookupMs: 100,
});

const validSize = (value) => Number.isInteger(value) && value >= 1 && value <= 1000;

export class PaneAttachments {
  #attachments = new Map();
  #pending = new Map();
  #retiring = new Map();
  #windows = new WeakMap();
  #stopped = false;

  // resolveTerminal(paneId, timeoutMs) answers { command, args, env, terminalId, cols, rows }
  // or throws an error whose `code` says why; spawnPty runs one command on a pty.
  constructor({ resolveTerminal, spawnPty, options = {}, log = (message) => console.error(message) }) {
    this.resolveTerminal = resolveTerminal;
    this.spawnPty = spawnPty;
    this.options = { ...ATTACH_DEFAULTS, ...options };
    this.log = log;
  }

  // Joins the pane's attachment, creating it when nobody has it open. One
  // client sets the shared grid's size: the first to open the pane, then
  // whoever types. The others show that grid as it is. An observer, or a
  // client that keeps the pane's size, never sets it.
  async attach(client, paneId, { cols, rows, keepSize = false }) {
    if (!validSize(cols) || !validSize(rows)) throw new RangeError("cols and rows must be integers in 1..1000");
    const observing = client.mode === "observe" || keepSize;
    const attachment = await this.#ensure(paneId, cols, rows, observing);
    if (this.#stopped || client.closed || this.#attachments.get(paneId) !== attachment) {
      if (attachment.clients.size === 0) this.#close(paneId);
      if (this.#attachments.get(paneId) !== attachment) client.send({ type: "pty-exit", pane_id: paneId, code: null });
      return;
    }
    // Attaching twice must not replay the screen twice.
    if (attachment.clients.has(client)) return;
    attachment.clients.add(client);
    this.#windowsOf(client).set(paneId, new OutputWindow());
    const replay = attachment.replay.text();
    if (replay) this.#sendOutput(client, paneId, replay);
    if (attachment.held) client.send({ type: "attach-held", pane_id: paneId });
    this.#reconcile(paneId);
    if (client.closed) return;
    if (attachment.ready && !attachment.held) client.send({ type: "input-ready", pane_id: paneId });
    if (!observing) attachment.sizes.set(client, { cols, rows });
    if (!observing && !attachment.clients.has(attachment.owner)) this.#own(paneId, client);
    else this.#sendGeometry(client, paneId);
  }

  detach(client, paneId) {
    this.#windowsOf(client).delete(paneId);
    const attachment = this.#attachments.get(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    attachment.stalled.delete(client);
    attachment.sizes.delete(client);
    if (attachment.clients.size === 0) { this.#close(paneId); return; }
    if (attachment.owner === client) this.#handOff(paneId);
    this.#reconcile(paneId);
  }

  detachAll(client) {
    for (const [paneId, attachment] of this.#attachments) {
      if (attachment.clients.has(client)) this.detach(client, paneId);
    }
  }

  // Typing goes straight to the pty, from a client that may type, once herdr took the attach.
  input(client, paneId, data) {
    const attachment = this.#attachments.get(paneId);
    if (client.mode !== "interact" || !attachment?.clients.has(client) || !attachment.ready || attachment.held) return false;
    // Typing here means this is the screen being used: it sets the size now.
    if (attachment.owner !== client && attachment.sizes.has(client)) this.#own(paneId, client);
    attachment.pty.write(data);
    return true;
  }

  resize(client, paneId, cols, rows) {
    if (client.mode !== "interact" || !validSize(cols) || !validSize(rows)) return false;
    const attachment = this.#attachments.get(paneId);
    if (!attachment?.clients.has(client) || !attachment.sizes.has(client)) return false;
    attachment.sizes.set(client, { cols, rows });
    if (attachment.owner === client) this.#resize(paneId, cols, rows);
    return true;
  }

  // Watching only, a client stops being one that may set a pane's size; back
  // to typing, it may again.
  setMode(client, mode) {
    client.mode = mode;
    for (const [paneId, attachment] of this.#attachments) {
      if (!attachment.clients.has(client)) continue;
      if (mode === "interact") {
        if (!attachment.sizes.has(client)) attachment.sizes.set(client, { cols: attachment.cols, rows: attachment.rows });
        continue;
      }
      attachment.sizes.delete(client);
      if (attachment.owner === client) this.#handOff(paneId);
    }
  }

  // An acknowledgement for a pane this client has left is not an error: a page
  // that just switched panes finishes drawing the old one and acknowledges it late.
  acknowledge(client, paneId, streamId, offset) {
    const window = this.#windowsOf(client).get(paneId);
    if (window && window.id === streamId && !window.acknowledge(streamId, offset)) return false;
    this.#reconcile(paneId);
    return true;
  }

  // A held terminal's next try takes the slot from whoever holds it, for this client.
  takeOver(client, paneId) {
    if (client.mode !== "interact") return false;
    const attachment = this.#attachments.get(paneId);
    if (!attachment?.clients.has(client)) return false;
    attachment.takeOver?.(client);
    return true;
  }

  close() {
    this.#stopped = true;
    for (const paneId of [...this.#attachments.keys()]) this.#close(paneId);
  }

  #windowsOf(client) {
    let windows = this.#windows.get(client);
    if (!windows) { windows = new Map(); this.#windows.set(client, windows); }
    return windows;
  }

  #broadcast(paneId, message) {
    for (const client of this.#attachments.get(paneId)?.clients ?? []) client.send(message);
  }

  #sendOutput(client, paneId, data) {
    const window = this.#windowsOf(client).get(paneId);
    const bytes = Buffer.byteLength(data);
    if ((window && window.pending + bytes > OUTPUT_HARD_BYTES) || client.bufferedAmount() >= OUTPUT_HARD_BYTES) {
      this.#stopSlowClient(client);
      return;
    }
    client.send({ type: "pty-data", pane_id: paneId, data, ...(window ? { flow: { stream_id: window.id, offset: window.write(bytes) } } : {}) });
  }

  #stopSlowClient(client) {
    if (client.closed) return;
    this.detachAll(client);
    client.close(4002, "Terminal output stalled");
  }

  // Output stops while any client is behind, for at most OUTPUT_STALL_MS: a
  // client that stays behind is dropped instead of holding everyone else.
  #reconcile(paneId) {
    const attachment = this.#attachments.get(paneId);
    if (!attachment?.pty) return;
    let paused = false;
    for (const client of [...attachment.clients]) {
      const window = this.#windowsOf(client).get(paneId);
      const buffered = client.bufferedAmount();
      if (!(window?.blocked || buffered >= OUTPUT_HIGH_BYTES)) {
        attachment.stalled.delete(client);
        continue;
      }
      const since = attachment.stalled.get(client) ?? Date.now();
      attachment.stalled.set(client, since);
      if (Date.now() - since >= OUTPUT_STALL_MS || buffered >= OUTPUT_HARD_BYTES) this.#stopSlowClient(client);
      else paused = true;
    }
    if (this.#attachments.get(paneId) !== attachment) return;
    clearTimeout(attachment.stallCheck);
    if (paused) {
      attachment.pty.pause();
      // A paused pty writes nothing, so nothing else would call this again: a
      // client that never acknowledges (a phone gone to the background) must
      // still be dropped once its time is up.
      attachment.stallCheck = setTimeout(() => this.#reconcile(paneId), OUTPUT_STALL_MS);
    } else {
      attachment.pty.resume();
    }
  }

  // `client` sets the grid from now on, at the size it last asked for.
  #own(paneId, client) {
    const attachment = this.#attachments.get(paneId);
    attachment.owner = client;
    // Moved to the end: when this one leaves, the next most recent takes over.
    const size = attachment.sizes.get(client);
    attachment.sizes.delete(client);
    attachment.sizes.set(client, size);
    if (!this.#resize(paneId, size.cols, size.rows)) {
      for (const member of attachment.clients) this.#sendGeometry(member, paneId);
    }
  }

  // The size passes to the client that asked for one most recently; with none
  // left, the grid stays as it is and nobody sets it.
  #handOff(paneId) {
    const attachment = this.#attachments.get(paneId);
    attachment.owner = null;
    const next = [...attachment.sizes.keys()].at(-1);
    if (next) this.#own(paneId, next);
    else for (const member of attachment.clients) this.#sendGeometry(member, paneId);
  }

  #sendGeometry(client, paneId) {
    const attachment = this.#attachments.get(paneId);
    client.send({ type: "pane-geometry", pane_id: paneId, cols: attachment.cols, rows: attachment.rows, owner: attachment.owner === client });
  }

  // False when the grid already had that size.
  #resize(paneId, cols, rows) {
    const attachment = this.#attachments.get(paneId);
    if (!attachment || (attachment.cols === cols && attachment.rows === rows)) return false;
    attachment.cols = cols;
    attachment.rows = rows;
    attachment.pty.resize(cols, rows);
    for (const client of attachment.clients) this.#sendGeometry(client, paneId);
    return true;
  }

  #close(paneId) {
    const attachment = this.#attachments.get(paneId);
    if (!attachment) return;
    this.#attachments.delete(paneId);
    clearTimeout(attachment.retry);
    clearTimeout(attachment.relookup);
    clearTimeout(attachment.stallCheck);
    attachment.closed = true;
    for (const client of attachment.clients) this.#windowsOf(client).delete(paneId);
    // herdr frees its one attach slot only once the old attach has exited.
    const retired = attachment.pty.exited.finally(() => {
      if (this.#retiring.get(paneId) === retired) this.#retiring.delete(paneId);
    });
    this.#retiring.set(paneId, retired);
    attachment.pty.kill();
  }

  // Two attaches that arrive while the terminal is still being looked up share
  // one pty: two would leave an orphan streaming into the survivor.
  #ensure(paneId, cols, rows, observing) {
    const existing = this.#attachments.get(paneId);
    if (existing) return Promise.resolve(existing);
    const pending = this.#pending.get(paneId);
    if (pending) return pending;
    const created = this.#spawn(paneId, cols, rows, observing).finally(() => this.#pending.delete(paneId));
    this.#pending.set(paneId, created);
    return created;
  }

  async #spawn(paneId, cols, rows, observing) {
    await this.#retiring.get(paneId);
    const target = await this.resolveTerminal(paneId);
    if (this.#stopped) throw new Error("The server is stopping");
    // An observer's attach starts at the pane's own grid, not at a phone's viewport.
    const attachment = {
      ready: false, held: false, closed: false, pty: null,
      clients: new Set(), stalled: new Map(),
      // Who sets the grid, and the size each client that may set it asked for.
      owner: null, sizes: new Map(),
      cols: observing ? target.cols ?? 80 : cols,
      rows: observing ? target.rows ?? 24 : rows,
      replay: new ReplayBuffer(MAX_REPLAY_BYTES),
    };
    this.#attachments.set(paneId, attachment);
    const options = this.options;
    const current = () => this.#attachments.get(paneId) === attachment;
    const forward = (data) => {
      if (!current()) return;
      attachment.replay.append(data);
      for (const client of attachment.clients) this.#sendOutput(client, paneId, data);
      this.#reconcile(paneId);
    };
    let retries = 0;
    let refusedSince = null;
    // Who asked the next start to take the slot, and who asked while a try was running.
    let takeover = null;
    let takeoverWanted = null;
    const mayTakeOver = (client) => client !== null && attachment.clients.has(client) && client.mode === "interact" && !client.closed;
    // An attempt, a live attach or a terminal lookup is running: another start waits.
    let trying = false;
    let terminal = target;
    const fail = (error) => {
      this.log(`terminal attach for pane ${paneId} failed to start: ${error.message}`);
      this.#broadcast(paneId, { type: "attach-error", pane_id: paneId, message: error.message });
      this.#broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
      this.#close(paneId);
    };
    const restart = () => {
      try { attachment.pty = start(); } catch (error) { fail(error); }
    };
    const again = () => {
      if (!current() || trying) return;
      clearTimeout(attachment.retry);
      attachment.retry = undefined;
      if (attachment.clients.size === 0) { this.#close(paneId); return; }
      restart();
    };
    const start = () => {
      let takingOver = mayTakeOver(takeover) ? takeover : null;
      takeover = null;
      trying = true;
      // This attach's own last words: herdr's refusal is in them.
      let output = "";
      // Its first bytes wait options.holdMs: a refusal is dropped, never painted.
      let held = "";
      let heldSince = 0;
      let holding = false;
      let holdTimer;
      let quietTimer;
      const outputTail = new AttachOutputTail();
      let tailTimer;
      const flushTail = (taken = false) => {
        clearTimeout(tailTimer);
        const data = outputTail.flush(taken);
        if (data) forward(data);
      };
      const publish = (data) => {
        clearTimeout(tailTimer);
        const visible = outputTail.push(data);
        if (visible) forward(visible);
        // A pane may print those bytes itself and keep running: never keep them for long.
        if (outputTail.pending) tailTimer = setTimeout(flushTail, options.holdMs);
      };
      // Ended before its exit came: whatever it still prints is no attach's.
      let retired = false;
      const release = () => {
        clearTimeout(holdTimer);
        clearTimeout(quietTimer);
        if (held === null) return;
        const data = held;
        held = null;
        if (data) publish(data);
      };
      const took = () => {
        if (!current()) return;
        // A refusal whose exit is late is no attach: wait for that exit a while.
        if (ATTACH_REFUSING_RE.test(output)) {
          if (Date.now() - heldSince < options.refusalExitMs) {
            holdTimer = setTimeout(took, options.holdMs);
            return;
          }
          retired = true;
          session.kill();
          ended(null);
          return;
        }
        takeoverWanted = null;
        takeover = null;
        takingOver = null;
        if (attachment.held) {
          attachment.held = false;
          this.#broadcast(paneId, { type: "attach-resumed", pane_id: paneId });
        }
        attachment.ready = true;
        this.#broadcast(paneId, { type: "input-ready", pane_id: paneId });
        release();
      };
      const ended = (code) => {
        trying = false;
        clearTimeout(holdTimer);
        clearTimeout(quietTimer);
        clearTimeout(tailTimer);
        if (!current()) return;
        if (attachment.ready) this.#broadcast(paneId, { type: "input-ready", pane_id: paneId, ready: false });
        attachment.ready = false;
        const now = Date.now();
        // Displaced after attaching: herdr's last words say the slot was taken over.
        const displaced = code !== 0 && isTakeoverExit(output);
        if (!displaced && code !== 0 && ATTACH_READ_RACE_RE.test(output) && now - (refusedSince ??= now) < options.retryForMs) {
          held = null;
          retries += 1;
          takeover = mayTakeOver(takingOver) ? takingOver : takeoverWanted;
          takeoverWanted = null;
          attachment.retry = setTimeout(again, Math.min(options.retryMs * 2 ** (retries - 1), options.retryMaxMs));
          return;
        }
        if (displaced || (code !== 0 && ATTACH_HELD_RE.test(output))) {
          flushTail(displaced);
          held = null;
          refusedSince = null;
          retries = 0;
          // Someone else holds herdr's one attach slot. It is left alone; this
          // pane waits for it to let go, unless a client here takes it on purpose.
          if (!attachment.held) this.#broadcast(paneId, { type: "attach-held", pane_id: paneId });
          attachment.held = true;
          if (!displaced && mayTakeOver(takeoverWanted)) {
            takeover = takeoverWanted;
            takeoverWanted = null;
            again();
          } else {
            takeoverWanted = null;
            attachment.retry = setTimeout(again, options.heldRetryMs);
          }
          return;
        }
        takeoverWanted = null;
        takeover = null;
        takingOver = null;
        // A live-handoff lookup owns the next start until it finishes.
        trying = true;
        release();
        flushTail();
        const finish = () => {
          this.#broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          this.#close(paneId);
        };
        if (retired) { finish(); return; }
        // herdr ended the attach, maybe not the pane: after a live handoff the
        // pane lives on under a new terminal, and the same clients attach to it.
        const deadline = Date.now() + options.relookupForMs;
        const retryLookup = () => {
          if (Date.now() >= deadline) { finish(); return; }
          attachment.relookup = setTimeout(relookup, options.relookupMs);
        };
        const relookup = () => {
          Promise.resolve(this.resolveTerminal(paneId, Math.max(1, deadline - Date.now()))).then((next) => {
            if (!current()) return;
            if (next.terminalId === terminal.terminalId) { retryLookup(); return; }
            if (attachment.clients.size === 0) { this.#close(paneId); return; }
            terminal = next;
            refusedSince = null;
            retries = 0;
            restart();
          }, (error) => {
            if (!current()) return;
            if (PANE_GONE_CODES.has(error?.code)) { finish(); return; }
            retryLookup();
          });
        };
        relookup();
      };
      const session = this.spawnPty({
        command: terminal.command,
        // --takeover goes after the id: before it, herdr reads the id as an option.
        args: [...terminal.args, ...(takingOver ? ["--takeover"] : [])],
        env: terminal.env,
        cols: attachment.cols,
        rows: attachment.rows,
        onData: (data) => {
          if (retired || !current()) return;
          output = (output + data).slice(-1024);
          if (held === null) { publish(data); return; }
          // An attach that set its modes and then stays quiet (an idle pane
          // with nothing to redraw) took too: with no refusal by then, it is ready.
          if (held === "") quietTimer = setTimeout(() => {
            if (holding || held === null) return;
            holding = true;
            heldSince = Date.now();
            took();
          }, options.refusalExitMs);
          held += data;
          if (!holding && !ATTACH_PREAMBLE_RE.test(held)) {
            holding = true;
            heldSince = Date.now();
            holdTimer = setTimeout(took, options.holdMs);
          }
        },
        onExit: ended,
      });
      return session;
    };
    attachment.takeOver = (client) => {
      if (!current() || !attachment.held) return;
      if (trying) { takeoverWanted = client; return; }
      clearTimeout(attachment.retry);
      takeover = client;
      again();
    };
    try {
      attachment.pty = start();
    } catch (error) {
      this.#attachments.delete(paneId);
      this.log(`terminal attach for pane ${paneId} failed to start: ${error.message}`);
      throw error;
    }
    return attachment;
  }
}

// node-pty, loaded only when a terminal is first attached: without its native
// module the server still runs, and panes fall back to the screen-text view.
export async function loadNodePty() {
  try {
    const pty = await import("@lydell/node-pty");
    return pty.default ?? pty;
  } catch {
    return null;
  }
}

export function nodePtySpawner(pty) {
  return ({ command, args, env, cols, rows, onData, onExit }) => {
    const term = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME ?? "/",
      env: { ...process.env, ...env, TERM: "xterm-256color" },
    });
    let exited = false;
    let resolveExit;
    const exitedPromise = new Promise((resolve) => { resolveExit = resolve; });
    term.onData(onData);
    term.onExit(({ exitCode }) => {
      exited = true;
      resolveExit();
      onExit(exitCode ?? null);
    });
    let paused = false;
    return {
      exited: exitedPromise,
      write: (data) => { if (!exited) term.write(data); },
      resize: (nextCols, nextRows) => { if (!exited) term.resize(nextCols, nextRows); },
      pause: () => { if (!exited && !paused) { paused = true; term.pause(); } },
      resume: () => { if (!exited && paused) { paused = false; term.resume(); } },
      kill: () => {
        if (exited) return;
        try { term.kill(); term.resume(); } catch { return; }
        // A child can ignore SIGHUP: it must not keep the slot.
        setTimeout(() => { if (!exited) { try { term.kill("SIGKILL"); } catch { /* gone */ } } }, 2000).unref();
      },
    };
  };
}
