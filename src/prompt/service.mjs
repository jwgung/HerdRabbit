// A pane's prompt card: read off its screen (any status for Claude, Codex and
// OpenCode panes, whose readers insist on the menu itself being on screen; the generic
// fallback only while herdr reports the agent blocked), answered by keys sent to the pane, and announced to the pages that
// watch the pane when it appears, changes or goes. An OpenCode pane has a card
// only while it runs a version its reader was checked against (SUPPORTED_OPENCODE_TUI).
//
// The answer flow follows herdr-web-ui's (MIT, Copyright (c) 2026 devswha,
// https://github.com/devswha/herdr-web-ui, server/prompt.ts): the screen is
// read again and the card must still be the one answered (else 409
// prompt_changed); the cursor moves go out first, and the key that commits
// (Enter, a typed answer) only once the screen shows the same card with the
// cursor on the row the moves were for. A multiple choice's answer is several
// such keys (a tick per option, then →): the screen is looked at before each.
// A card answered by its own keys that asks for it (OpenCode's Reject message
// and review) is looked at before each key and each typed text too: the same
// card still on screen, and once a message is typed, the box holding it. A
// step may ask that of itself: OpenCode's typed answer to a question types
// only once its box is open, and sends its Enter only once the box holds it.
import { createHash } from "node:crypto";
import { HttpError } from "../http-basics.mjs";
import { claudeQuestionContext, fillClaudeCard, parseClaudePrompt } from "./claude.mjs";
import { parseCodexPrompt } from "./codex.mjs";
import { parseFallbackPrompt } from "./fallback.mjs";
import { SUPPORTED_OPENCODE_TUI, fillOpencodeCard, opencodeDialogOpen, parseOpencodePrompt } from "./opencode.mjs";
import { InvalidAnswer, answerSteps, moveKeysOf, publicCard, verifiesCursor } from "./screen.mjs";

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
// The recent lines a question's context is looked for in: the message above
// it may be long, and scrolled above the visible screen.
const CONTEXT_LINES = 400;
// Reads of it for one card, at most, while they do not find the question.
const CONTEXT_TRIES = 3;
// Ticks a watched pane may be missing from the snapshot before it is let go.
const MISSING_TICKS = 3;
// How long a pane's agent version, once told, stands before it is asked again.
const VERSION_MS = 2_000;

// What each agent's pane is read with, by the name herdr gives it; what an
// agent leaves out is SCREEN_DEFAULTS'.
//   read:   its own reader (screen → card or null); an agent without one is
//           read only while blocked, by the fallback
//   noCard: screens on which its keys go somewhere no card can see, so no card
//           at all, not even the fallback: an OpenCode dialog (ctrl+p's
//           commands, ...) takes Enter and Esc, and its Enter runs the dialog's
//           highlighted entry
//   format, source: how the screen is read. OpenCode's selected permission
//           button is known only by its colour, so its screen comes with its
//           styles, from the visible screen (herdr's detection snapshot drops
//           the styles; checked on OpenCode 1.18.34)
//   fill:   the card's whole words, from the agent's own record of the call it
//           waits on
//   context: (screen, card) => the text the terminal shows above a question
//           card (the message its transcript does not have yet), null for
//           none, undefined when that screen does not show the question; read
//           from the pane's recent lines unwrapped, once per card
//   supports: (version) => whether the reader knows the screens of that
//           version of the agent (the pane's own record of it, `agentVersion`);
//           a pane of any other version, or of none known, has no card at all,
//           not even the fallback. Absent: any version.
const SCREEN_DEFAULTS = Object.freeze({ read: null, noCard: () => false, format: "text", source: "detection", fill: null, context: null, supports: null });
const AGENT_SCREENS = Object.freeze(Object.fromEntries(Object.entries({
  claude: { read: parseClaudePrompt, fill: fillClaudeCard, context: claudeQuestionContext },
  codex: { read: parseCodexPrompt },
  opencode: { read: parseOpencodePrompt, noCard: opencodeDialogOpen, format: "ansi", source: "visible", fill: fillOpencodeCard, supports: SUPPORTED_OPENCODE_TUI },
}).map(([name, screen]) => [name, Object.freeze({ ...SCREEN_DEFAULTS, ...screen })])));

// How the agent named `name` (or none) has its pane read.
function screenOf(name) {
  return typeof name === "string" && Object.hasOwn(AGENT_SCREENS, name) ? AGENT_SCREENS[name] : SCREEN_DEFAULTS;
}

// The agent's dedicated reader decides from the screen alone, so the pane is
// read whatever herdr says it is doing (it does not always say blocked while a
// menu waits); any other agent is read only while blocked.
function readerName(agent) {
  const name = agent.claude ? "claude" : agent.name;
  return screenOf(name).read ? name : null;
}

// Kept referenced: an answer whose keys are still going out holds the process
// (and a test) open until they have.
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function promptChanged() {
  return new HttpError(409, "prompt_changed", "The prompt changed. Look at it again and choose once more.");
}

// Whether the snapshot cannot tell yet if the pane is there: its connected
// PC is still being reached.
function serverPending(snapshot, paneId) {
  const separator = paneId.indexOf("!");
  if (separator < 0) return false;
  const server = (snapshot?.servers ?? []).find((item) => item.id === paneId.slice(0, separator));
  return Boolean(server && !server.available && server.connecting);
}

// What a watching page is told again for: another card, or other ticks.
// The words count too: a card's whole words may come from the transcript a
// moment after the menu shows.
function cardVersion(card) {
  if (!card) return null;
  const words = createHash("sha256").update(JSON.stringify([card.question, card.body, card.options, card.context ?? null])).digest("base64url").slice(0, 16);
  return `${card.id}:${(card.checked ?? []).join(",")}:${words}`;
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
  const session = [pane?.agent_session?.value, agent?.agent_session?.value].find((item) => typeof item === "string" && item) ?? null;
  return { claude, name, session, status: KNOWN_STATES.has(value) ? value : "unknown" };
}

// Ticks between reads of a non-blocked pane that has shown no menu for
// `quiet` reads running: 1, then 2, then at most 4.
function quietStride(quiet) {
  return quiet < 3 ? 1 : quiet < 6 ? 2 : 4;
}

export class PromptService {
  // `details(paneId, snapshot)`: the call a Claude pane's agent waits on, from
  // its transcript, for the card's whole words (optional); `snapshot` is the
  // herdr snapshot already in hand, when there is one. `agentVersion(paneId,
  // snapshot)`: the version of the agent the pane runs, from its own record,
  // or null; without it an agent whose reader `supports` only some versions
  // (OpenCode) has no card.
  constructor({ herdr, details = null, agentVersion = null, settleMs = 1_500, stepDelayMs = 30, lookMs = 50, pollMs = 1_000 }) {
    this.herdr = herdr;
    this.details = details;
    this.agentVersion = agentVersion;
    // paneId + agent session -> { version, at }: the agent version last told,
    // for VERSION_MS; another session in the same pane is asked again
    this.versions = new Map();
    // paneId -> { id, text }: the context read for the card `id` (text or
    // null); the text above an open question does not change while it waits
    this.contexts = new Map();
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
  // Claude, Codex or OpenCode pane is read whatever its status, by its agent's reader;
  // any other pane only while herdr reports it blocked. The fallback card (any
  // agent) is for blocked panes only. A password prompt is never a card.
  // `fresh`: the version is asked now, not taken from the last few seconds
  // (an answer, whose keys go to the pane).
  async read(paneId, snapshot = null, { fresh = false } = {}) {
    const given = snapshot ?? await this.herdr.snapshot();
    const agent = paneAgent(given, paneId);
    if (!agent) throw new HttpError(404, "pane_not_found", "This pane is gone.");
    return this.#readScreen(paneId, agent, given, fresh);
  }

  #screen(paneId, reader) {
    const { format, source } = screenOf(reader);
    return this.herdr.readPane(paneId, { lines: SCREEN_LINES, format, source });
  }

  async #readScreen(paneId, agent, snapshot = null, fresh = false) {
    const reader = readerName(agent);
    const blocked = agent.status === "blocked";
    if (!reader && !blocked) return null;
    if (reader && !(await this.#supported(paneId, reader, snapshot, agent.session, fresh))) return null;
    const screen = await this.#screen(paneId, reader);
    const { read, noCard } = screenOf(reader);
    if (reader && noCard(screen)) return null;
    const card = reader ? read(screen) ?? null : null;
    if (card || !blocked) return card;
    return parseFallbackPrompt(screen, { agent: reader ?? agent.name });
  }

  // Whether the pane's agent is a version its reader knows: always, for a
  // reader that does not ask; never, when the version cannot be told.
  // The version is kept for VERSION_MS per pane and agent session: an answer
  // looks at the screen every few milliseconds, and a connected PC's pane is
  // asked over its link. `fresh` asks again whatever is kept.
  async #supported(paneId, reader, snapshot, session = null, fresh = false) {
    const { supports } = screenOf(reader);
    if (!supports) return true;
    if (typeof this.agentVersion !== "function") return false;
    const key = JSON.stringify([paneId, session]);
    const known = fresh ? null : this.versions.get(key);
    let version = known && Date.now() - known.at < VERSION_MS ? known.version : undefined;
    if (version === undefined) {
      try { version = await this.agentVersion(paneId, snapshot); } catch { version = null; }
      this.versions.delete(key);
      this.versions.set(key, { version, at: Date.now() });
      if (this.versions.size > MAX_WATCHES) this.versions.delete(this.versions.keys().next().value);
    }
    return supports(version) === true;
  }

  async card(paneId) {
    // one snapshot for the screen and the transcript both
    const snapshot = await this.herdr.snapshot();
    return this.#worded(paneId, publicCard(await this.read(paneId, snapshot)), snapshot);
  }

  // A Claude card's words, whole, from its transcript, and an OpenCode
  // question's from its database; the screen's when those cannot be read.
  async #worded(paneId, card, snapshot = null) {
    card = await this.#withContext(paneId, card);
    const fill = card && !card.fallback ? screenOf(card.agent).fill : null;
    if (!fill || !this.details || (card.kind !== "plan" && card.kind !== "question")) return card;
    let ask = null;
    try { ask = await this.details(paneId, snapshot); } catch { /* the screen's words, then */ }
    return fill(card, ask);
  }

  // A question card with the text above it on the terminal (`context`), when
  // its agent's reader finds one; read once per card, and the card as it is
  // when it cannot be read.
  async #withContext(paneId, card) {
    const { context } = card && !card.fallback ? screenOf(card.agent) : SCREEN_DEFAULTS;
    if (!context || card.kind !== "question") { this.contexts.delete(paneId); return card; }
    let known = this.contexts.get(paneId);
    if (known?.id !== card.id) known = { id: card.id, text: null, tries: 0, done: false };
    if (!known.done) {
      let text;
      try {
        text = context(await this.herdr.readPane(paneId, { lines: CONTEXT_LINES, format: "text", source: "recent-unwrapped" }), card);
      } catch { text = undefined; }
      // a screen that did not show this question (yet), or a read that
      // failed, is tried again on the next looks, a few times
      known.tries += 1;
      known.done = text !== undefined || known.tries >= CONTEXT_TRIES;
      known.text = typeof text === "string" && text ? text : null;
      this.contexts.delete(paneId);
      this.contexts.set(paneId, known);
      if (this.contexts.size > MAX_WATCHES) this.contexts.delete(this.contexts.keys().next().value);
    }
    return known.text ? { ...card, context: known.text } : card;
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
    const given = JSON.stringify([body.cardId, body.option ?? null, body.options ?? null, body.text ?? null, body.action ?? null]);
    const last = this.answered.get(paneId);
    if (last && last.answer === given && Date.now() - last.at < this.answeredMs) throw promptChanged();
    const parsed = await this.read(paneId, null, { fresh: true });
    if (!parsed || parsed.id !== body.cardId) throw promptChanged();
    let steps;
    try {
      steps = answerSteps(parsed, { option: body.option, options: body.options, text: body.text, action: body.action });
    } catch (error) {
      if (error instanceof InvalidAnswer) throw new HttpError(400, "invalid_answer", error.message);
      throw error;
    }
    const verify = verifiesCursor(parsed);
    const moves = moveKeysOf(parsed);
    let cursor = parsed.selectedIndex;
    let sent = false;
    let typed = false;
    let typedText = "";
    let committed = false;
    try {
      for (const [index, step] of steps.entries()) {
        // A step that is checked: "card", the same card still on screen;
        // "box", the card's text box holding what is typed so far ("" for a
        // box just opened). A card that checks each step checks "card" until
        // a message is typed and "box" after; a step may name its own check
        // (OpenCode's typed answer: its text and Enter wait on the box). If
        // the check fails, nothing more goes.
        const check = step.check ?? (parsed.checksEachStep ? (typed ? "box" : "card") : null);
        if (check === "box" && !(await this.#holds(paneId, parsed, typedText))) throw promptChanged();
        if (check === "card" && !(await this.#onRow(paneId, parsed.promptKey ?? parsed.id, parsed.selectedIndex, { anyRow: true }))) {
          throw promptChanged();
        }
        const move = step.keys?.every((key) => key === moves.back || key === moves.forward) ?? false;
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
        if (step.text !== undefined) { typed = true; typedText += step.text; }
        if (!move) committed = true;
        if (move) {
          for (const key of step.keys) cursor = key === moves.forward ? cursor + 1 : Math.max(0, cursor - 1);
        }
        if (index < steps.length - 1) await delay(this.stepDelayMs);
      }
      this.answered.set(paneId, { answer: given, at: Date.now() });
    } finally {
      this.nudge(paneId);
    }
    return { ok: true };
  }

  // Whether the screen shows the card `promptKey` with the cursor on `cursor`
  // (any row, with `anyRow`), within the settle time.
  async #onRow(paneId, promptKey, cursor, { anyRow = false } = {}) {
    const deadline = Date.now() + this.settleMs;
    while (Date.now() < deadline) {
      const shown = await this.read(paneId).catch(() => null);
      if (shown && (shown.promptKey ?? shown.id) === promptKey && (anyRow || shown.selectedIndex === cursor)) return true;
      await delay(this.lookMs);
    }
    return false;
  }

  // Whether the screen shows the card's text box holding `text`, within the
  // settle time: the card's reader tells (`holdsText`); one that cannot tell holds nothing.
  async #holds(paneId, parsed, text) {
    if (typeof parsed.holdsText !== "function") return false;
    const deadline = Date.now() + this.settleMs;
    while (Date.now() < deadline) {
      const screen = await this.#screen(paneId, parsed.agent).catch(() => null);
      if (screen !== null && parsed.holdsText(screen, text)) return true;
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
    const entry = this.watches.get(paneId);
    if (!entry) return;
    // input may have opened a menu: look at once and every tick again
    entry.quiet = 0;
    entry.skipped = Infinity;
    this.#schedule(100);
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
        if (agent && agent.status === "blocked") { entry.quiet = 0; reading.push({ entry, agent }); }
        else if (agent && readerName(agent)) {
          // A Claude, Codex or OpenCode pane herdr does not call blocked may still wait
          // on a menu, so it is read too -- but less often while nothing has
          // shown: every tick, then every 2nd, then every 4th, until a card,
          // a status change or input (a nudge) brings it back to every tick.
          if (entry.lastStatus !== agent.status) entry.quiet = 0;
          entry.lastStatus = agent.status;
          entry.skipped = (entry.skipped ?? 0) + 1;
          if (entry.skipped >= quietStride(entry.quiet ?? 0)) { entry.skipped = 0; reading.push({ entry, agent }); }
        }
        else if (agent) this.#tell(entry, null);
        else if (!serverPending(snapshot, entry.paneId)) {
          // One snapshot without the pane is not the end of it (a tab moved,
          // a PC reconnecting); a few running give its place back, and
          // its listeners keep it until they stop watching.
          this.#tell(entry, null);
          entry.missing = (entry.missing ?? 0) + 1;
        }
      }
      await eachLimited(reading, READS_AT_ONCE, async ({ entry, agent }) => {
        const card = await this.#worded(entry.paneId, publicCard(await this.#readScreen(entry.paneId, agent, snapshot).catch(() => null)), snapshot);
        entry.quiet = card ? 0 : (entry.quiet ?? 0) + 1;
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
