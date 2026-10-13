// Messages queued for a pane's next turn: typed while its agent works (or
// waits on a prompt card), held here on the server so a reload or another
// device sees the same list, and delivered one per turn, in order, once the
// agent is ready again (idle or done).
//
// The turn gate follows herdr-web-ui's pending input (MIT, Copyright (c) 2026
// devswha, https://github.com/devswha/herdr-web-ui, server/pending-input.ts):
// after a delivery the next message waits until the agent has left ready
// (working, or blocked on a card) or a while has passed, so a status read
// before the agent took the message cannot send the next one into the same
// turn. Rewritten for one queue per pane without owners or leases.
import { randomUUID } from "node:crypto";
import { HttpError } from "./http-basics.mjs";
import { paneAgent } from "./prompt/service.mjs";
import { secretPrompt } from "./secret-prompt.mjs";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
// herdr's send-text takes at most 8000 characters: the paste's two marks are
// part of them.
export const MAX_PENDING_TEXT = 8_000 - PASTE_START.length - PASTE_END.length;
export const MAX_PENDING_ITEMS = 20;
// Panes with a queue or a watching page, at most.
const MAX_PANES = 64;
export const TURN_TIMEOUT_MS = 10_000;
const READY = new Set(["idle", "done"]);
// Control characters other than newline and tab: an escape could end the
// paste early, and a carriage return would submit half the message.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

// What the pane receives: the text as one paste, so its newlines stay in the
// message instead of submitting each line.
export function bracketedPaste(text) {
  return `${PASTE_START}${text}${PASTE_END}`;
}

export function validatePendingText(value) {
  if (typeof value !== "string") throw new HttpError(400, "invalid_text", "Text must be a string.");
  const text = value.replace(/\r\n?/gu, "\n");
  if (!text.trim()) throw new HttpError(400, "invalid_text", "Text must not be empty.");
  if (text.length > MAX_PENDING_TEXT) throw new HttpError(400, "invalid_text", `Text must be at most ${MAX_PENDING_TEXT} characters.`);
  if (CONTROL.test(text)) throw new HttpError(400, "invalid_text", "Text must not contain control characters.");
  return text;
}

function notFound() {
  return new HttpError(404, "pending_not_found", "That queued message is gone.");
}

function publicItem(item) {
  return { id: item.id, text: item.text, state: item.state, ...(item.error ? { error: item.error } : {}) };
}

// The agent session herdr reports for a pane (Claude's session id and the
// like): a new session of the same agent is a different reader.
function paneSession(snapshot, paneId) {
  const pane = (snapshot?.panes ?? []).find((item) => item.pane_id === paneId);
  const agent = (snapshot?.agents ?? []).find((item) => item.pane_id === paneId);
  const value = pane?.agent_session?.value ?? agent?.agent_session?.value;
  return typeof value === "string" && value ? value : null;
}

// Whether a message queued for `item` may go to the pane as it is now.
function sameReader(item, pane) {
  if (item.agent !== pane.agent) return false;
  // a session noted at queueing must still be the one there, and be known
  return !item.session || item.session === pane.session;
}

export class PendingInputs {
  constructor({
    herdr,
    pollMs = 1_000,
    turnTimeoutMs = TURN_TIMEOUT_MS,
    enterDelayMs = 60,
    maxItems = MAX_PENDING_ITEMS,
    now = Date.now,
    newId = randomUUID,
    // Whether the pane shows a password prompt now. A screen that cannot be
    // read might, so it counts as one.
    asksForSecret = null,
    // A message went to the pane (to note the request, look at it again soon).
    onDelivered = () => {},
  }) {
    this.herdr = herdr;
    this.pollMs = pollMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.enterDelayMs = enterDelayMs;
    this.maxItems = maxItems;
    this.now = now;
    this.newId = newId;
    this.asksForSecret = asksForSecret ?? (async (paneId) => {
      try {
        return secretPrompt(await herdr.readPane(paneId, { lines: 4, format: "text" })) !== null;
      } catch {
        return true;
      }
    });
    this.onDelivered = onDelivered;
    // paneId -> { items, status, gate, busy, listeners }
    this.panes = new Map();
    // Rises with every change to any list: a page keeps the newest it heard,
    // whichever way (an answer or a push) it came.
    this.revision = 0;
    this.timer = null;
    this.running = false;
    this.again = false;
    this.stopped = false;
  }

  #pane(paneId, { create = false } = {}) {
    let pane = this.panes.get(paneId);
    if (!pane && create) {
      // Panes holding messages count; panes only watched (any id a page asks
      // about) cannot crowd them out, though they are bounded too.
      const holding = [...this.panes.values()].filter((other) => other.items.length > 0 || other.gate).length;
      if (holding >= MAX_PANES || this.panes.size >= MAX_PANES * 4) throw new HttpError(503, "busy", "Too many panes have queued messages.");
      pane = { paneId, items: [], status: undefined, gate: null, busy: false, listeners: new Set() };
      this.panes.set(paneId, pane);
    }
    return pane ?? null;
  }

  #release(pane) {
    if (pane.items.length === 0 && pane.listeners.size === 0 && !pane.gate && !pane.busy) this.panes.delete(pane.paneId);
  }

  #item(paneId, id) {
    const pane = this.#pane(paneId);
    const item = pane?.items.find((entry) => entry.id === id);
    if (!item) throw notFound();
    return { pane, item };
  }

  list(paneId) {
    return (this.#pane(paneId)?.items ?? []).map(publicItem);
  }

  #publish(pane, removed) {
    this.revision += 1;
    const message = { items: pane.items.map(publicItem), revision: this.revision, ...(removed ? { removed } : {}) };
    for (const listener of pane.listeners) {
      try { listener(message); } catch { /* one page cannot stop the others */ }
    }
  }

  // Hears the pane's list whenever it changes, and once now. Returns the call
  // that stops.
  watch(paneId, listener) {
    const pane = this.#pane(paneId, { create: true });
    pane.listeners.add(listener);
    listener({ items: pane.items.map(publicItem), revision: this.revision });
    return () => {
      pane.listeners.delete(listener);
      this.#release(pane);
    };
  }

  async enqueue(paneId, value) {
    const text = validatePendingText(value);
    const existing = this.#pane(paneId);
    if ((existing?.items.length ?? 0) >= this.maxItems) {
      throw new HttpError(409, "pending_limit", `At most ${this.maxItems} messages can wait. Send or remove one first.`);
    }
    const snapshot = await this.herdr.snapshot();
    const agent = paneAgent(snapshot, paneId);
    if (!agent) throw new HttpError(404, "pane_not_found", "This pane is gone.");
    // A message waits for the agent it was written to: with no agent known,
    // the text could reach a shell as a command.
    if (agent.name === "unknown") throw new HttpError(409, "no_agent", "Only a pane running an agent can queue messages. Send it directly instead.");
    // An answer to a password prompt is never kept, not even for a moment.
    if (await this.asksForSecret(paneId)) {
      throw new HttpError(409, "secret_prompt", "This pane may be asking for a password. Send it directly instead of queueing it.");
    }
    const pane = this.#pane(paneId, { create: true });
    if (pane.items.length >= this.maxItems) {
      throw new HttpError(409, "pending_limit", `At most ${this.maxItems} messages can wait. Send or remove one first.`);
    }
    const item = { id: this.newId(), text, state: "queued", agent: agent.name, session: paneSession(snapshot, paneId) };
    pane.items.push(item);
    this.#publish(pane);
    this.#schedule(0);
    return publicItem(item);
  }

  cancel(paneId, id) {
    const { pane, item } = this.#item(paneId, id);
    if (item.state === "sending") throw new HttpError(409, "pending_sending", "This message is being sent.");
    pane.items.splice(pane.items.indexOf(item), 1);
    this.#publish(pane, [{ id, outcome: "discarded" }]);
    this.#release(pane);
    // Its text may already sit in the pane's input (typed, the Enter failed):
    // the page says so, since removing it here cannot take it back there.
    return { typed: Boolean(item.pasted) };
  }

  edit(paneId, id, value) {
    const { pane, item } = this.#item(paneId, id);
    if (item.state !== "queued" || item.pasted) throw new HttpError(409, "pending_not_queued", "Only a message that still waits can be edited.");
    item.text = validatePendingText(value);
    this.#publish(pane);
  }

  move(paneId, id, offset) {
    const { pane, item } = this.#item(paneId, id);
    if (item.state === "sending") throw new HttpError(409, "pending_sending", "This message is being sent.");
    const from = pane.items.indexOf(item);
    const to = Math.max(0, Math.min(pane.items.length - 1, from + offset));
    // Nothing goes ahead of a message already on its way.
    if (to === from || pane.items[to].state === "sending") return;
    pane.items.splice(from, 1);
    pane.items.splice(to, 0, item);
    this.#publish(pane);
  }

  // A failed message waits again, at its place, and the queue moves on.
  retry(paneId, id) {
    const { pane, item } = this.#item(paneId, id);
    if (item.state !== "failed") throw new HttpError(409, "pending_not_failed", "Only a message that failed can be tried again.");
    item.state = "queued";
    delete item.error;
    // The user tries it again for whatever agent runs there when it goes,
    // unless its text is already typed there: then only the reader it was
    // typed for may get the Enter.
    if (!item.pasted) {
      item.agent = null;
      item.session = null;
    }
    this.#publish(pane);
    this.#schedule(0);
  }

  // Sends this message now, ahead of the others and whatever the agent is
  // doing, unless the pane waits on a prompt card or a password.
  async sendNow(paneId, id) {
    const { pane, item } = this.#item(paneId, id);
    if (item.state === "sending" || pane.busy) throw new HttpError(409, "pending_sending", "A message is being sent. Try again in a moment.");
    pane.busy = true;
    try {
      const snapshot = await this.herdr.snapshot();
      const agent = paneAgent(snapshot, paneId);
      if (!agent) throw new HttpError(404, "pane_not_found", "This pane is gone.");
      if (agent.name === "unknown") throw new HttpError(409, "no_agent", "No agent runs in this pane now: the text would reach a shell. Send it directly if you mean to.");
      if (item.agent !== null && !sameReader(item, { agent: agent.name, session: paneSession(snapshot, paneId) })) throw new HttpError(409, "agent_changed", "The program in this pane changed since this was queued. Send it directly if it still applies.");
      if (agent.status === "blocked") throw new HttpError(409, "pane_blocked", "The pane is asking something. Answer it first.");
      if (await this.asksForSecret(paneId)) throw new HttpError(409, "secret_prompt", "The pane is asking for a password. Answer it in the terminal first.");
      if (!pane.items.includes(item) || item.state === "sending") throw notFound();
      if (!(await this.#deliver(pane, item))) {
        throw new HttpError(502, "send_failed", item.error ?? "The message could not be sent.");
      }
    } finally {
      pane.busy = false;
      this.#release(pane);
      this.#schedule(this.pollMs);
    }
  }

  // A status herdr announced for the pane (the status stream): taken at once.
  status(paneId, status) {
    const pane = this.#pane(paneId);
    if (!pane) return;
    this.#apply(pane, status);
    if (READY.has(status)) this.#schedule(0);
  }

  #apply(pane, status) {
    pane.status = status;
    if (pane.gate && (status === "working" || status === "blocked")) pane.gate = null;
  }

  // One look at every pane with a message to deliver: one snapshot, then the
  // head of each ready pane's queue.
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.again = false;
    try {
      const waiting = [...this.panes.values()].filter((pane) => this.#waiting(pane));
      if (waiting.length === 0) return;
      const snapshot = await this.herdr.snapshot().catch(() => null);
      if (!snapshot) return;
      for (const pane of waiting) {
        const agent = paneAgent(snapshot, pane.paneId);
        pane.agent = agent?.name ?? null;
        pane.session = paneSession(snapshot, pane.paneId);
        this.#apply(pane, agent?.status ?? "unknown");
        if (pane.gate && this.now() >= pane.gate.deadline) {
          pane.gate = null;
          // nothing more to send there and nobody watching: the pane goes
          this.#release(pane);
        }
      }
      // Panes go on their own: one slow machine holds back only its panes.
      await Promise.allSettled(waiting.map((pane) => this.#next(pane)));
    } finally {
      this.running = false;
      this.#schedule(this.again ? 0 : this.pollMs);
    }
  }

  // A pane is looked at while a message waits there, or its turn gate is open.
  #waiting(pane) {
    return pane.gate !== null || pane.items.some((item) => item.state === "queued");
  }

  async #next(pane) {
    if (pane.busy || pane.gate || !READY.has(pane.status)) return;
    // A failed message holds the queue until it is tried again or removed.
    if (pane.items.some((item) => item.state !== "queued")) return;
    const head = pane.items[0];
    if (!head) { this.#release(pane); return; }
    // A retried message goes to the agent there now, if there is one.
    if (head.agent === null && pane.agent && pane.agent !== "unknown") {
      head.agent = pane.agent;
      head.session = pane.session ?? null;
    }
    // The agent it was queued for is gone (exited to a shell, or another
    // program took the pane): the message waits for the user instead.
    if (!sameReader(head, pane)) {
      head.state = "failed";
      head.error = "The program in this pane changed since this was queued.";
      this.#publish(pane);
      return;
    }
    pane.busy = true;
    try {
      if (await this.asksForSecret(pane.paneId)) return;
      // the list may have changed while the screen was read
      if (pane.items[0] !== head || head.state !== "queued" || pane.gate || !READY.has(pane.status)) return;
      await this.#deliver(pane, head);
    } finally {
      pane.busy = false;
      this.#release(pane);
    }
  }

  // The text as one paste, then Enter. The turn gate opens: the next message
  // waits for the agent to take this one.
  async #deliver(pane, item) {
    item.state = "sending";
    delete item.error;
    this.#publish(pane);
    try {
      // A text already pasted when its Enter failed is not pasted again: a
      // retry only presses Enter, or the text would land twice.
      if (!item.pasted) {
        await this.herdr.sendText(pane.paneId, bracketedPaste(item.text));
        item.pasted = true;
        if (this.enterDelayMs > 0) await delay(this.enterDelayMs);
      }
      await this.herdr.sendKeys(pane.paneId, ["enter"]);
    } catch (error) {
      item.state = "failed";
      const reason = typeof error?.message === "string" && error.message ? error.message.slice(0, 300) : "The message could not be sent.";
      item.error = item.pasted ? `Typed but not submitted: ${reason}` : reason;
      this.#publish(pane);
      return false;
    }
    pane.items.splice(pane.items.indexOf(item), 1);
    pane.gate = { deadline: this.now() + this.turnTimeoutMs };
    pane.status = undefined;
    this.#publish(pane, [{ id: item.id, outcome: "sent", text: item.text }]);
    try { this.onDelivered(pane.paneId, item.text); } catch { /* noted only */ }
    return true;
  }

  #schedule(ms) {
    if (this.stopped) return;
    if (this.running) {
      if (ms < this.pollMs) this.again = true;
      return;
    }
    if (![...this.panes.values()].some((pane) => this.#waiting(pane))) {
      clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer !== null && ms >= this.pollMs) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
