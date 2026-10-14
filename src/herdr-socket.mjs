import { createConnection } from "node:net";

// What Herdr's socket clients share: opening the connection, acting once it is
// up, and cutting its newline-delimited JSON stream into lines. Each client
// keeps its own limits and error handling, which differ on purpose.

// `openSocket` is the test seam; it may return a socket or a promise of one.
export function connectHerdrSocket(socketPath, openSocket) {
  return openSocket ? openSocket(socketPath) : createConnection(socketPath);
}

// Runs `action` now if the socket is up, else when it connects.
export function whenConnected(socket, action) {
  if (socket.connecting) socket.once("connect", action);
  else action();
}

// Chunks in, whole non-empty lines out. The caller checks `length` (what is
// held, partial line included) after `append` and before `lines()`, so an
// oversized chunk is refused before any of it is read.
export function createLineBuffer() {
  let pending = "";
  return {
    append(chunk) { pending += chunk; },
    get length() { return pending.length; },
    *lines() {
      let boundary;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (line) yield line;
      }
    },
  };
}
