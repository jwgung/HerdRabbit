// Tells watchers when a pane's transcript (Claude's or Codex's) changed, without reading it:
// a stat (identity, size, time) of the file every 250 ms on this machine and
// every 1.5 s on a PC connected with Connect PC (one change signature asked
// of it), only while someone watches
// the pane. The pane is looked up again every few seconds, so a new
// session (a new file) is noticed too. No timer runs while nobody watches.
//
// Ported from herdr-web-ui (MIT, Copyright (c) 2026 devswha),
// https://github.com/devswha/herdr-web-ui -- server/conversation-monitor.ts.
import { createHash, randomUUID } from "node:crypto";
import { ConversationUnavailable } from "./pages.mjs";

export const STAT_INTERVAL_MS = 250;
export const REMOTE_STAT_INTERVAL_MS = 1_500;
const RESOLVE_INTERVAL_MS = 5_000;
const MISSING_RESOLVE_INTERVAL_MS = 2_000;

export class ConversationMonitor {
  // `resolve(paneId)` answers { serverId, store, session, path } as
  // ConversationService.resolve does.
  constructor({
    resolve,
    statIntervalMs = STAT_INTERVAL_MS,
    remoteStatIntervalMs = REMOTE_STAT_INTERVAL_MS,
    resolveIntervalMs = RESOLVE_INTERVAL_MS,
    missingResolveIntervalMs = MISSING_RESOLVE_INTERVAL_MS,
    now = () => Date.now(),
  }) {
    this.resolveTarget = resolve;
    this.statIntervalMs = statIntervalMs;
    this.remoteStatIntervalMs = remoteStatIntervalMs;
    this.resolveIntervalMs = resolveIntervalMs;
    this.missingResolveIntervalMs = missingResolveIntervalMs;
    this.now = now;
    this.panes = new Map();
    this.salt = randomUUID();
    this.timer = null;
    this.stopped = false;
  }

  // Panes watched, and whether the stat timer runs.
  get size() { return this.panes.size; }
  get running() { return this.timer !== null; }

  // `listener(signature)` hears each change; the first observation counts as
  // one. Returns the call that stops this listener.
  watch(paneId, listener) {
    if (this.stopped) return () => {};
    let state = this.panes.get(paneId);
    if (!state) {
      state = { listeners: new Set(), target: null, observed: undefined, nextResolve: 0, nextStat: 0, resolving: false, statting: false };
      this.panes.set(paneId, state);
    }
    state.listeners.add(listener);
    if (this.timer === null) {
      this.timer = setInterval(() => this.#poll(), this.statIntervalMs);
      this.timer.unref?.();
    }
    this.#poll();
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      this.#unwatch(paneId, listener);
    };
  }

  #unwatch(paneId, listener) {
    const state = this.panes.get(paneId);
    if (!state) return;
    state.listeners.delete(listener);
    if (state.listeners.size === 0) this.panes.delete(paneId);
    if (this.panes.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop() {
    this.stopped = true;
    this.panes.clear();
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  #publish(paneId, state, observed) {
    if (this.panes.get(paneId) !== state || observed === state.observed) return;
    state.observed = observed;
    const signature = createHash("sha256").update(`${this.salt}\0${paneId}\0${observed}`).digest("base64url").slice(0, 22);
    for (const listener of [...state.listeners]) {
      try { listener(signature); } catch { /* one listener's failure is its own */ }
    }
  }

  #poll() {
    const now = this.now();
    for (const [paneId, state] of this.panes) {
      if (state.target && !state.statting && state.nextStat <= now) void this.#stat(paneId, state);
      if (!state.resolving && state.nextResolve <= now) void this.#resolve(paneId, state);
    }
  }

  async #stat(paneId, state) {
    const target = state.target;
    state.statting = true;
    try {
      const stat = await target.store.stat(target.path);
      if (this.panes.get(paneId) !== state || state.target !== target) return;
      if (!stat) {
        // gone: look the pane up again at once rather than at the next interval
        state.nextResolve = 0;
        this.#publish(paneId, state, `missing\0${target.serverId}\0${target.path}`);
        return;
      }
      this.#publish(paneId, state, `file\0${target.serverId}\0${target.path}\0${stat.identity}\0${stat.size}\0${stat.mtimeMs}`);
    } catch (error) {
      // A database this version cannot read (OpenCode) is news: a new signature
      // makes an open chat read again and learn why. Anything else (a PC that
      // dropped its connection) says nothing new; the next stat asks again.
      if (error instanceof ConversationUnavailable && this.panes.get(paneId) === state && state.target === target) {
        this.#publish(paneId, state, `unavailable\0${error.reason}`);
      }
    } finally {
      state.statting = false;
      state.nextStat = this.now() + (target.store.remote ? this.remoteStatIntervalMs : 0);
    }
  }

  async #resolve(paneId, state) {
    state.resolving = true;
    let present = state.target !== null;
    try {
      const target = await this.resolveTarget(paneId);
      if (this.panes.get(paneId) !== state) return;
      if (target.path === null) {
        state.target = null;
        present = false;
        this.#publish(paneId, state, `unwritten\0${target.serverId}\0${target.session}`);
      } else {
        const same = state.target && state.target.path === target.path && state.target.store === target.store;
        if (!same) {
          state.target = { serverId: target.serverId, store: target.store, path: target.path };
          state.nextStat = 0;
        }
        present = true;
      }
    } catch (error) {
      if (this.panes.get(paneId) !== state) return;
      if (error instanceof ConversationUnavailable) {
        state.target = null;
        present = false;
        this.#publish(paneId, state, `unavailable\0${error.reason}`);
      }
      // Anything else (Herdr busy, a PC offline) keeps what was known.
    } finally {
      state.resolving = false;
      state.nextResolve = this.now() + (present ? this.resolveIntervalMs : this.missingResolveIntervalMs);
    }
  }
}
