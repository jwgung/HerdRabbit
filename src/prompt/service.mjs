// A pane's prompt card: read off its screen (any status for Claude and Codex
// panes, whose readers insist on the menu itself being on screen; the generic
// fallback only while herdr reports the agent blocked), answered by keys sent to the pane, and announced to the pages that
// watch the pane when it appears, changes or goes.
//
// The answer flow follows herdr-web-ui's (MIT, Copyright (c) 2026 devswha,
// https://github.com/devswha/herdr-web-ui, server/prompt.ts): the screen is
// read again and the card must still be the one answered (else 409
// prompt_changed); the cursor moves go out first, and the key that commits
// (Enter, a typed answer) only once the screen shows the same card with the
// cursor on the row the moves were for. A multiple choice's answer is several
// such keys (a tick per option, then →): the screen is looked at before each.
import { HttpError } from "../http-basics.mjs";
import { parseClaudePrompt } from "./claude.mjs";
import { parseCodexPrompt } from "./codex.mjs";
import { parseFallbackPrompt } from "./fallback.mjs";
import { InvalidAnswer, KEY, answerSteps, publicCard, verifiesCursor } from "./screen.mjs";

// The screen's bottom: enough for a long approval panel.
const SCREEN_LINES = 120;
const KNOWN_STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);
// Panes one server watches at most (each readable one costs a read a tick).
const MAX_WATCHED_PANES = 16;
// Every watch, panes gone from the snapshot included: those hold no place
// among the 16 but cannot pile up without end either.
const MAX_WATCHES = 64;
// Panes whose screens one tick reads at once.
const READS_AT_ONCE = 4;
// Ticks a watched pane may be missing from the snapshot before it is let go.
const MISSING_TICKS = 3;

// Each agent's own readers, by the name herdr gives it.
const READERS = { claude: parseClaudePrompt, codex: parseCodexPrompt };

// The agent's dedicated reader decides from the screen alone, so the pane is
// read whatever herdr says it is doing (it does not always say blocked while a
// menu waits); any other agent is read only while blocked.
function readerName(agent) {
  const name = agent.claude ? "claude" : agent.name;
  return Object.hasOwn(READERS, name) ? name : null;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

function promptChanged() {
  return new HttpError(409, "prompt_changed", "The prompt changed. Look at it again and choose once more.");
}

// Whether the snapshot cannot tell yet if the pane is there: its herdr
// machine is still being listed or reached.
function serverPending(snapshot, paneId) {
  const separator = paneId.indexOf("!");
  if (separator < 0) return false;
  if (snapshot?.servers_pending) return true;
  const server = (snapshot?.servers ?? []).find((item) => item.id === paneId.slice(0, separator));
  return Boolean(server && !server.available && server.connecting);
}

// What a watching page is told again for: another card, or other ticks.
function cardVersion(card) {
  return card ? `${card.id}:${(card.checked ?? []).join(",")}` : null;
}

async function eachLimited(items, limit, run) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function paneAgent(snapshot, paneId) {
  const pane = (snapshot?.panes ?? []).find((item) => item.pane_id === paneId) ?? null;
  const agent = (snapshot?.agents ?? []).find((item) => item.pane_id === paneId) ?? null;
  if (!pane && !agent) return null;
  const names = [pane?.agent, pane?.agent_session?.agent, agent?.agent];
  const name = names.find((item) => typeof item === "string" && item.trim())?.trim().toLowerCase() ?? "unknown";
  const claude = names.some((item) => typeof item === "string" && item.toLowerCase() === "claude");
  const value = agent?.agent_status || agent?.state || pane?.agent_status || pane?.agent_state;
  return { claude, name, status: KNOWN_STATES.has(value) ? value : "unknown" };
}

export class PromptService {
  constructor({ herdr, settleMs = 1_500, stepDelayMs = 30, lookMs = 50, pollMs = 1_000 }) {
    this.herdr = herdr;
    this.settleMs = settleMs;
    this.stepDelayMs = stepDelayMs;
    this.lookMs = lookMs;
    this.pollMs = pollMs;
    this.turns = new Map();
    // paneId -> { answer, at }: the answer given last, refused again for a
    // moment while the terminal may still show its card (a second tab, a
    // retried POST); another option on the same card is a new answer
    this.answered = new Map();
    this.answeredMs = 3_000;
    this.watches = new Map();
    // One tick looks at every watched pane: a snapshot (one per server, the
    // client's own), then the screens of the readable ones.
    this.timer = null;
    this.dueAt = Infinity;
    this.running = false;
    this.again = false;
  }

  // The card the pane shows now, with the reader's bookkeeping, or null. A
  // Claude or Codex pane is read whatever its status, by its agent's reader;
  // any other pane only while herdr reports it blocked. The fallback card (any
  // agent) is for blocked panes only. A password prompt is never a card.
  async read(paneId) {
    const agent = paneAgent(await this.herdr.snapshot(), paneId);
    if (!agent) throw new HttpError(404, "pane_not_found", "This pane is gone.");
    return this.#readScreen(paneId, agent);
  }

  async #readScreen(paneId, agent) {
    const reader = readerName(agent);
    const blocked = agent.status === "blocked";
    if (!reader && !blocked) return null;
    const screen = await this.herdr.readPane(paneId, { lines: SCREEN_LINES, format: "text", source: "detection" });
    const card = reader ? READERS[reader](screen) ?? null : null;
    if (card || !blocked) return card;
    return parseFallbackPrompt(screen, { agent: reader ?? agent.name });
  }

  async card(paneId) {
    return publicCard(await this.read(paneId));
  }

  // Answers one pane at a time, in the order the answers came.
  answer(paneId, body) {
    const previous = this.turns.get(paneId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.#answer(paneId, body));
    const settled = run.catch(() => {});
    this.turns.set(paneId, settled);
    void settled.then(() => { if (this.turns.get(paneId) === settled) this.turns.delete(paneId); });
    return run;
  }

  async #answer(paneId, body) {
    if (!body || typeof body !== "object" || typeof body.cardId !== "string" || !body.cardId) {
      throw new HttpError(400, "invalid_answer", "cardId is required.");
    }
    const given = JSON.stringify([body.cardId, body.option ?? null, body.options ?? null, body.text ?? null]);
    const last = this.answered.get(paneId);
    if (last && last.answer === given && Date.now() - last.at < this.answeredMs) throw promptChanged();
    const parsed = await this.read(paneId);
    if (!parsed || parsed.id !== body.cardId) throw promptChanged();
    let steps;
    try {
      steps = answerSteps(parsed, { option: body.option, options: body.options, text: body.text });
    } catch (error) {
      if (error instanceof InvalidAnswer) throw new HttpError(400, "invalid_answer", error.message);
      throw error;
    }
    const verify = verifiesCursor(parsed);
    let cursor = parsed.selectedIndex;
    let sent = false;
    let typed = false;
    let committed = false;
    try {
      for (const [index, step] of steps.entries()) {
        const move = step.keys?.every((key) => key === KEY.up || key === KEY.down) ?? false;
        // A key that picks or ticks goes only once the screen shows this
        // prompt again with the cursor where the keys so far left it: the menu
        // answered in the terminal meanwhile, with another in its place, would
        // take it. Each tick of a multiple choice is looked at, and so is the
        // → that ends it, and so is the first key when it already commits (the
        // option under the cursor). Once a typed answer is in, the row shows it
        // and the rest goes as it is; so does the rest of a single choice once
        // its first key went (Codex's Tab opens a notes line under the menu).
        if (!move && !typed && verify && (parsed.multiSelect || !committed)
            && !(await this.#onRow(paneId, parsed.promptKey ?? parsed.id, cursor))) {
          throw promptChanged();
        }
        if (step.keys) await this.herdr.sendKeys(paneId, step.keys);
        else await this.herdr.sendText(paneId, step.text);
        sent = true;
        if (step.text !== undefined) typed = true;
        if (!move) committed = true;
        if (move) {
          for (const key of step.keys) cursor = key === KEY.down ? cursor + 1 : Math.max(0, cursor - 1);
        }
        if (index < steps.length - 1) await delay(this.stepDelayMs);
      }
      this.answered.set(paneId, { answer: given, at: Date.now() });
    } finally {
      this.nudge(paneId);
    }
    return { ok: true };
  }

  async #onRow(paneId, promptKey, cursor) {
    const deadline = Date.now() + this.settleMs;
    while (Date.now() < deadline) {
      const shown = await this.read(paneId).catch(() => null);
      if (shown && (shown.promptKey ?? shown.id) === promptKey && shown.selectedIndex === cursor) return true;
      await delay(this.lookMs);
    }
    return false;
  }

  // Hears the pane's card (or null) whenever it appears, changes or goes,
  // shared by every page that watches the pane. Returns the call that stops.
  // A pane missing from the snapshot a few looks running is told null and
  // holds no place among the watched, but stays watched: back again, its
  // card comes to the pages still listening.
  watch(paneId, listener) {
    let entry = this.watches.get(paneId);
    if (!entry) {
      const held = [...this.watches.values()].filter((watched) => (watched.missing ?? 0) < MISSING_TICKS).length;
      if (held >= MAX_WATCHED_PANES || this.watches.size >= MAX_WATCHES) throw new HttpError(503, "busy", "Too many panes are watched.");
      entry = { paneId, listeners: new Set(), known: undefined, card: null };
      this.watches.set(paneId, entry);
    }
    entry.listeners.add(listener);
    if (entry.known !== undefined) listener(entry.card);
    this.#schedule(0);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && this.watches.get(paneId) === entry) this.watches.delete(paneId);
      if (this.watches.size === 0) this.#cancel();
    };
  }

  // Looks again soon: input went to the pane.
  nudge(paneId) {
    if (this.watches.has(paneId)) this.#schedule(100);
  }

  stop() {
    this.#cancel();
    this.watches.clear();
  }

  #cancel() {
    clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = Infinity;
  }

  // The next tick in `ms`, unless one is due sooner.
  #schedule(ms) {
    if (this.watches.size === 0) return;
    if (this.running) {
      if (ms < this.pollMs) this.again = true;
      return;
    }
    const at = Date.now() + ms;
    if (this.timer !== null && this.dueAt <= at) return;
    clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dueAt = Infinity;
      void this.#tick();
    }, ms);
    this.timer.unref?.();
  }

  async #tick() {
    if (this.running || this.watches.size === 0) return;
    this.running = true;
    this.again = false;
    try {
      const snapshot = await this.herdr.snapshot().catch(() => null);
      if (!snapshot) return;
      const reading = [];
      for (const entry of [...this.watches.values()]) {
        const agent = paneAgent(snapshot, entry.paneId);
        if (agent) entry.missing = 0;
        if (agent && (agent.status === "blocked" || readerName(agent))) reading.push({ entry, agent });
        else if (agent) this.#tell(entry, null);
        else if (!serverPending(snapshot, entry.paneId)) {
          // One snapshot without the pane is not the end of it (a tab moved,
          // a machine reconnecting); a few running give its place back, and
          // its listeners keep it until they stop watching.
          this.#tell(entry, null);
          entry.missing = (entry.missing ?? 0) + 1;
        }
      }
      await eachLimited(reading, READS_AT_ONCE, async ({ entry, agent }) => {
        const card = publicCard(await this.#readScreen(entry.paneId, agent).catch(() => null));
        this.#tell(entry, card);
      });
    } finally {
      this.running = false;
      this.#schedule(this.again ? 0 : this.pollMs);
    }
  }

  #tell(entry, card) {
    const version = cardVersion(card);
    if (entry.known === version || !entry.listeners.size) return;
    entry.known = version;
    entry.card = card;
    for (const listener of entry.listeners) listener(card);
  }
}
