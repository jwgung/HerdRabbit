import { createConnection } from "node:net";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
let nextRequest = 0;

// One request to Herdr's socket API, for the methods its CLI does not offer
// (tab.move, workspace.move): a JSON line out, the line with the same id back.
// `wrapError` turns Herdr's own { code, message } into the caller's error type.
export function callHerdrSocket({ socketPath, method, params, openSocket, timeoutMs = 5_000, wrapError }) {
  const id = `herdrabbit-${process.pid}-${++nextRequest}`;
  return new Promise((resolve, reject) => {
    let socket = null;
    let buffer = "";
    // Counted in bytes as they arrive, not in the decoded string's characters.
    let received = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(wrapError({ code: "herdr_timeout", message: "Herdr command timed out" })), timeoutMs);
    Promise.resolve(openSocket ? openSocket(socketPath) : createConnection(socketPath)).then((opened) => {
      socket = opened;
      if (settled) { socket.destroy(); return; }
      socket.setEncoding("utf8");
      socket.on("error", () => finish(wrapError({ code: "server_unavailable", message: "Herdr socket is unavailable" })));
      socket.on("close", () => finish(wrapError({ code: "herdr_command_failed", message: "Herdr command failed" })));
      socket.on("data", (chunk) => {
        buffer += chunk;
        received += Buffer.byteLength(chunk, "utf8");
        if (received > MAX_RESPONSE_BYTES) {
          finish(wrapError({ code: "invalid_herdr_response", message: "Herdr returned too much" }));
          return;
        }
        let boundary;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            finish(wrapError({ code: "invalid_herdr_response", message: "Herdr returned invalid JSON" }));
            return;
          }
          if (message?.id !== id) continue;
          if (message.error) {
            const code = typeof message.error.code === "string" ? message.error.code : "herdr_command_failed";
            const text = typeof message.error.message === "string" && message.error.message.length <= 300
              ? message.error.message
              : "Herdr command failed";
            finish(wrapError({ code, message: text }));
          } else finish(null, message.result);
          return;
        }
      });
      const send = () => socket.write(`${JSON.stringify({ id, method, params })}\n`);
      if (socket.connecting) socket.once("connect", send);
      else send();
    }, () => finish(wrapError({ code: "server_unavailable", message: "Herdr socket is unavailable" })));
  });
}
