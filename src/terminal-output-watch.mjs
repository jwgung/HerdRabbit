import { OutputRevisions } from "./output-revisions.mjs";

// Outside a terminal attach, Herdr has match notifications, not a general
// output-change stream.
// Share server-side observation across viewers and send only changed snapshots.
export function terminalOutputWatcher({ herdr, outputWindow, outputReadLines, activeMs = 50, idleMs = 500 }) {
  const watches = new Map();
  function schedule(entry, delay) {
    clearTimeout(entry.timer);
    if (!entry.listeners.size || entry.running) return;
    entry.timer = setTimeout(() => void poll(entry), delay);
    entry.timer.unref?.();
  }
  async function poll(entry) {
    if (!entry.listeners.size || entry.running) return;
    entry.running = true;
    try {
      const output = await herdr.readPane(entry.paneId, { lines: outputReadLines(entry.lines), format: "ansi" });
      const window = outputWindow(output, entry.lines);
      const update = entry.revisions.update({ paneId: entry.paneId, window, since: entry.revision });
      if (update) {
        entry.revision = update.revision;
        entry.latest = { ...window, revision: update.revision, update: "replace" };
        entry.hotUntil = Date.now() + 1000;
        for (const listener of entry.listeners) listener.update(update);
      }
    } catch (error) {
      for (const listener of entry.listeners) listener.error(error);
    } finally {
      entry.running = false;
      schedule(entry, Date.now() < entry.hotUntil ? activeMs : idleMs);
    }
  }
  return {
    watch(paneId, lines, update, error) {
      const key = `${paneId}\0${lines}`;
      let entry = watches.get(key);
      if (!entry) {
        entry = { paneId, lines, listeners: new Set(), revisions: new OutputRevisions(), revision: null,
          latest: null, running: false, timer: null, hotUntil: Date.now() + 1000 };
        watches.set(key, entry);
      }
      const listener = { update, error };
      entry.listeners.add(listener);
      if (entry.latest) update(entry.latest);
      schedule(entry, 0);
      return () => {
        entry.listeners.delete(listener);
        if (!entry.listeners.size) { clearTimeout(entry.timer); watches.delete(key); }
      };
    },
    input(paneId) {
      for (const entry of watches.values()) {
        if (entry.paneId !== paneId) continue;
        entry.hotUntil = Date.now() + 3000;
        schedule(entry, 0);
      }
    },
  };
}
