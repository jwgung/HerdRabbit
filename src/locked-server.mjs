import { createServer } from "node:http";

// Serves nothing but `message`: every request gets 503 with it, and every
// WebSocket upgrade is turned away. A former leaf with no password runs this
// instead of HerdRabbit, so its service stays up (an update does not roll
// back) while its terminals stay closed. Resolves once the server has closed,
// on SIGINT or SIGTERM or when `stop` aborts, or when it cannot listen.
export function serveLocked({ host, port }, message, { signals = ["SIGINT", "SIGTERM"], stop, onListening = () => {} } = {}) {
  const server = createServer((request, response) => {
    response.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end(`${message}\n`);
  });
  server.on("upgrade", (request, socket) => {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return new Promise((resolve) => {
    const close = () => server.close(() => resolve());
    for (const signal of signals) process.once(signal, close);
    stop?.addEventListener("abort", close, { once: true });
    server.on("close", () => {
      for (const signal of signals) process.off(signal, close);
      resolve();
    });
    server.on("error", (error) => {
      console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use.` : `Server failed: ${error.message}`);
      process.exitCode = 1;
      server.close();
      resolve();
    });
    server.listen(port, host, () => onListening(server.address()));
  });
}
