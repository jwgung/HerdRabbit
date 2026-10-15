import { LINK_PROTOCOL } from "./leaf-protocol.mjs";

// A leaf on a port nobody would guess -- a second account on a machine that
// already runs one -- cannot be found by probing. It can say where it is,
// because it was installed knowing which hub it answers to.
const RETRY_MS = 60_000;
const REFRESH_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5_000;

export function announceToHub({
  hub,
  address,
  name,
  version,
  fetchImpl = globalThis.fetch,
  logger = console,
  refreshMs = REFRESH_MS,
  retryMs = RETRY_MS,
}) {
  if (!hub) return { stop() {} };
  let timer = null;
  let stopped = false;

  const send = async () => {
    if (stopped) return;
    let delay = refreshMs;
    try {
      const response = await fetchImpl(`${hub}/api/announce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, address, version, link_protocol: LINK_PROTOCOL }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        // A hub that refuses is a configuration answer, not a blip, but it may
        // also simply be starting up -- so retry slowly rather than give up.
        logger.warn?.(`Hub at ${hub} did not accept this server's announcement (${response.status}).`);
        delay = retryMs;
      }
    } catch {
      delay = retryMs;
    }
    if (stopped) return;
    timer = setTimeout(() => void send(), delay);
    timer.unref?.();
  };

  void send();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
