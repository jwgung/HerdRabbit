import { connectHerdrSocket, createLineBuffer, whenConnected } from "./herdr-socket.mjs";

export async function subscribeHerdrStatuses({ socketPath, paneIds, openSocket, onStatus, onError }) {
  const socket = await connectHerdrSocket(socketPath, openSocket);
  const buffer = createLineBuffer();
  let closed = false;
  let acknowledged = false;
  const allowed = new Set(paneIds);
  return new Promise((resolve, reject) => {
    const dispose = () => { closed = true; clearTimeout(timeout); socket.destroy(); };
    const fail = error => {
      if (closed) return;
      dispose();
      if (acknowledged) onError(error);
      else reject(error);
    };
    const timeout = setTimeout(() => fail(new Error("Herdr status subscription timed out")), 5000);
    socket.setEncoding("utf8");
    socket.on("error", () => fail(new Error("Herdr status connection failed")));
    socket.on("close", () => fail(new Error("Herdr status connection closed")));
    socket.on("data", chunk => {
      buffer.append(chunk);
      if (buffer.length > 2 * 1024 * 1024) { fail(new Error("Herdr status message too large")); return; }
      for (const line of buffer.lines()) {
        try {
          const message = JSON.parse(line);
          if (message.error) throw new Error("Herdr rejected status subscription");
          if (message.result?.type === "subscription_started") {
            acknowledged = true;
            clearTimeout(timeout);
            resolve(dispose);
          } else if (message.event === "pane.agent_status_changed" && allowed.has(message.data?.pane_id)) {
            onStatus({ pane_id: message.data.pane_id, agent_status: message.data.agent_status });
          }
        } catch (error) { fail(error); return; }
      }
    });
    const request = () => socket.write(JSON.stringify({ id: "herdrabbit-status", method: "events.subscribe",
      params: { subscriptions: paneIds.map(pane_id => ({ type: "pane.agent_status_changed", pane_id })) } }) + "\n");
    whenConnected(socket, request);
  });
}
