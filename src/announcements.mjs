// A leaf knows its hub -- that is what it was installed with -- so it can say
// where it is instead of waiting to be found. This matters when a machine runs
// more than one HerdRabbit, one per account: they share a tailnet address and
// differ only by port, and probing cannot guess a port.
//
// An announcement is not authority. It puts a row in a dialog; adding the
// server is still a person choosing it, and the choice still probes the address
// itself. So the guards here are about keeping the list small and honest, not
// about trusting what it says.

const MAX_ANNOUNCEMENTS = 32;

// Once a machine has said where it is, that is worth keeping: it does not stop
// being true because the hub restarted or the leaf went quiet for a while. A
// machine that is genuinely gone drops out of the dialog on its own, because
// every candidate is probed before it is offered.
export function announcementRegistry({ now = () => Date.now(), initial = [], save = () => {} } = {}) {
  const entries = new Map();
  for (const entry of initial) {
    if (entry?.address) entries.set(entry.address, { ...entry, at: entry.at ?? 0 });
  }

  const persist = () => save([...entries.values()]);

  // Nothing expires, so the cap needs a way to make room: the machine that has
  // gone longest without saying anything is the one least likely to be there.
  const evictOldest = () => {
    let oldest = null;
    for (const [address, entry] of entries) {
      if (oldest === null || entry.at < oldest.at) oldest = { address, at: entry.at };
    }
    if (oldest) entries.delete(oldest.address);
  };

  return {
    // `from` is the address the request actually arrived from. A machine may
    // announce itself and nothing else, which is the whole check: without it
    // one leaf could fill the dialog with rows pointing anywhere.
    record({ from, name, address, version, protocol }) {
      let parsed;
      try {
        parsed = new URL(address);
      } catch {
        return { ok: false, reason: "address" };
      }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.hostname !== from) {
        return { ok: false, reason: "address" };
      }
      if (typeof name !== "string" || name === "" || name.length > 80) {
        return { ok: false, reason: "name" };
      }
      if (!entries.has(parsed.origin) && entries.size >= MAX_ANNOUNCEMENTS) evictOldest();
      entries.set(parsed.origin, {
        name: name.trim(),
        address: parsed.origin,
        version: typeof version === "string" ? version : null,
        protocol: Number.isInteger(protocol) ? protocol : null,
        at: now(),
      });
      persist();
      return { ok: true };
    },

    // A machine that is reachable but has nothing on that port is not coming
    // back to it: it was uninstalled, or moved, or reinstalled somewhere else.
    // Keeping the row would mean a port change leaves a dead entry behind for
    // good, since nothing here expires.
    forget(addresses) {
      let removed = 0;
      for (const address of addresses) if (entries.delete(address)) removed += 1;
      if (removed > 0) persist();
      return removed;
    },

    list() {
      return [...entries.values()].map(({ at, ...entry }) => ({ ...entry }));
    },

    get size() {
      return entries.size;
    },
  };
}
