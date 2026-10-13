// A pane's prompt card: read off its screen while herdr reports the agent
// blocked, answered by keys sent to the pane, and announced to the pages that
// watch the pane when it appears, changes or goes.
//
// The answer flow follows herdr-web-ui's (MIT, Copyright (c) 2026 devswha,
// https://github.com/devswha/herdr-web-ui, server/prompt.ts): the screen is
// read again and the card must still be the one answered (else 409
// prompt_changed); the cursor moves go out first, and the key that commits
// (Enter, a typed answer) only once the screen shows the same card with the
// cursor on the row the moves were for.
import { HttpError } from "../http-basics.mjs";
import { InvalidAnswer, KEY, answerSteps, parseClaudePrompt, parseFallbackPrompt, publicCard, verifiesCursor } from "./claude.mjs";

// The screen's bottom: enough for a long approval panel.
const SCREEN_LINES = 120;
const KNOWN_STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);
// Panes one server watches at most (each costs a snapshot and a read a tick).
const MAX_WATCHED_PANES = 16;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

function promptChanged() {
  return new HttpError(409, "prompt_changed", "The prompt changed. Look at it again and choose once more.");
}

export function paneAgent(snapshot, paneId) {
  const pane = (snapshot?.panes ?? []).find((item) => item.pane_id === paneId) ?? null;
  const agent = (snapshot?.agents ?? []).find((item) => item.pane_id === paneId) ?? null;
  if (!pane && !agent) return null;
  const names = [pane?.agent, pane?.agent_session?.agent, agent?.agent];
  const claude = names.some((name) => typeof name === "string" && name.toLowerCase() === "claude");
  const value = agent?.agent_status || agent?.state || pane?.agent_status || pane?.agent_state;
  return { claude, status: KNOWN_STATES.has(value) ? value : "unknown" };
}

export class PromptService {
  constructor({ herdr, settleMs = 1_500, stepDelayMs = 30, lookMs = 50, pollMs = 1_000 }) {
    this.herdr = herdr;
    this.settleMs = settleMs;
    this.stepDelayMs = stepDelayMs;
    this.lookMs = lookMs;
    this.pollMs = pollMs;
    this.turns = new Map();
    this.watches = new Map();
  }

  // The card the pane shows now, with the reader's bookkeeping, or null. Only
  // a pane herdr reports blocked is read: Claude's readers first, then the
  // fallback card for any agent. A password prompt is never a card.
  async read(paneId) {
    const agent = paneAgent(await this.herdr.snapshot(), paneId);
    if (!agent) throw new HttpError(404, "pane_not_found", "This pane is gone.");
    if (agent.status !== "blocked") return null;
    const screen = await this.herdr.readPane(paneId, { lines: SCREEN_LINES, format: "text", source: "detection" });
    return (agent.claude ? parseClaudePrompt(screen) : null) ?? parseFallbackPrompt(screen);
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
    let moved = false;
    let committed = false;
    try {
      for (const [index, step] of steps.entries()) {
        const move = step.keys?.every((key) => key === KEY.up || key === KEY.down) ?? false;
        if (!move && !committed) {
          // The menu answered in the terminal meanwhile, with another one in
          // its place, would take this Enter: it goes only once the screen
          // shows this card again with the cursor where the moves left it.
          // Claude's unnumbered menus are looked at even without a move.
          if (verify && (moved || parsed.responder === "claude-confirm") && !(await this.#onRow(paneId, parsed.id, cursor))) {
            throw promptChanged();
          }
          committed = true;
        }
        if (step.keys) await this.herdr.sendKeys(paneId, step.keys);
        else await this.herdr.sendText(paneId, step.text);
        if (move) {
          moved = true;
          for (const key of step.keys) cursor = key === KEY.down ? cursor + 1 : Math.max(0, cursor - 1);
        }
        if (index < steps.length - 1) await delay(this.stepDelayMs);
      }
    } finally {
      this.nudge(paneId);
    }
    return { ok: true };
  }

  async #onRow(paneId, cardId, cursor) {
    const deadline = Date.now() + this.settleMs;
    while (Date.now() < deadline) {
      const shown = await this.read(paneId).catch(() => null);
      if (shown?.id === cardId && shown.selectedIndex === cursor) return true;
      await delay(this.lookMs);
    }
    return false;
  }

  // Hears the pane's card (or null) whenever it appears, changes or goes,
  // shared by every page that watches the pane. Returns the call that stops.
  watch(paneId, listener) {
    let entry = this.watches.get(paneId);
    if (!entry) {
      if (this.watches.size >= MAX_WATCHED_PANES) throw new HttpError(503, "busy", "Too many panes are watched.");
      entry = { paneId, listeners: new Set(), timer: null, running: false, known: undefined, card: null };
      this.watches.set(paneId, entry);
    }
    entry.listeners.add(listener);
    if (entry.known !== undefined) listener(entry.card);
    this.#schedule(entry, 0);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        clearTimeout(entry.timer);
        if (this.watches.get(paneId) === entry) this.watches.delete(paneId);
      }
    };
  }

  // Looks again soon: input went to the pane.
  nudge(paneId) {
    const entry = this.watches.get(paneId);
    if (entry) this.#schedule(entry, 100);
  }

  stop() {
    for (const entry of this.watches.values()) clearTimeout(entry.timer);
    this.watches.clear();
  }

  #schedule(entry, ms) {
    clearTimeout(entry.timer);
    if (!entry.listeners.size) return;
    entry.timer = setTimeout(() => void this.#poll(entry), ms);
    entry.timer.unref?.();
  }

  async #poll(entry) {
    if (entry.running || !entry.listeners.size) return;
    entry.running = true;
    try {
      const card = await this.card(entry.paneId).catch(() => null);
      const id = card?.id ?? null;
      if (entry.known !== id) {
        entry.known = id;
        entry.card = card;
        for (const listener of entry.listeners) listener(card);
      }
    } finally {
      entry.running = false;
      this.#schedule(entry, this.pollMs);
    }
  }
}
