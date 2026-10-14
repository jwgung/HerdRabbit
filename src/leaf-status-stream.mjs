const MAX_FRAME_BYTES = 64 * 1024;

function parseFrame(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return { event, data: data.join("\n") };
}

// Mirrors subscribeHerdrStatuses: the promise settles on whether the
// subscription was established, and everything after that is onError's problem.
// A caller written against the local path must not have to tell them apart.
export async function subscribeLeafStatuses({
  url,
  paneIds,
  headers = {},
  fetchImpl = globalThis.fetch,
  onStatus,
  onError,
  openTimeoutMs = 5_000,
  idleTimeoutMs = 45_000,
}) {
  const controller = new AbortController();
  let settled = false;
  let closed = false;
  let idleTimer = null;

  const dispose = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    controller.abort();
  };

  const fail = (error) => {
    if (closed) return;
    dispose();
    if (settled) onError(error);
  };

  const touch = () => {
    clearTimeout(idleTimer);
    // A leaf sends a heartbeat every 15s, so silence well past that means the
    // connection is gone in a way neither end noticed.
    idleTimer = setTimeout(() => fail(new Error("The linked server stopped sending status updates.")), idleTimeoutMs);
    idleTimer.unref?.();
  };

  const open = setTimeout(() => controller.abort(), openTimeoutMs);
  open.unref?.();

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ paneIds }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(open);
    dispose();
    throw error;
  }
  clearTimeout(open);

  if (!response.ok || !response.body) {
    dispose();
    throw new Error(`The linked server refused the status subscription (${response.status}).`);
  }

  const wanted = new Set(paneIds);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const ready = new Promise((resolve, reject) => {
    const pump = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            const ended = new Error("The linked server closed the status stream.");
            if (settled) fail(ended); else { dispose(); reject(ended); }
            return;
          }
          touch();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_FRAME_BYTES) {
            const oversized = new Error("The linked server sent an oversized status frame.");
            if (settled) fail(oversized); else { dispose(); reject(oversized); }
            return;
          }
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const { event, data } = parseFrame(buffer.slice(0, split));
            buffer = buffer.slice(split + 2);
            if (event === "ready") {
              settled = true;
              resolve();
            } else if (event === "error") {
              let message = "The linked server could not report status.";
              try { message = JSON.parse(data).message || message; } catch { /* keep the default */ }
              const failure = new Error(message);
              if (settled) fail(failure); else { dispose(); reject(failure); }
              return;
            } else if (data !== "") {
              try {
                const status = JSON.parse(data);
                if (wanted.has(status.pane_id)) {
                  onStatus({ pane_id: status.pane_id, agent_status: status.agent_status });
                }
              } catch { /* a frame we cannot read is not worth ending the stream for */ }
            }
            split = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (closed && settled) return;
        if (settled) fail(error); else { dispose(); reject(error); }
      }
    };
    void pump();
    touch();
  });

  await ready;
  return dispose;
}
