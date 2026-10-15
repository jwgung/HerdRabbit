import { STATUS_CODES, createServer } from "node:http";
import { HttpError, sendJson } from "./http-basics.mjs";
import { PeerRejected } from "./peer-identity.mjs";
import { errorResponse } from "./error-response.mjs";
import { hostPort } from "./config.mjs";

// How many sockets the port holds open at once. A hub keeps a few: its polls,
// a status stream for each page watching, a file or two moving.
export const MAX_PEER_CONNECTIONS = 64;
// How long a request (headers and body) may take to arrive. An upload is the
// longest; the hub itself gives one two minutes.
const REQUEST_TIMEOUT_MS = 180_000;

// Only a server calls this port. A browser that ended up here -- a page whose
// name was pointed at this address (DNS rebinding), with an allowed device's
// address behind it -- says so in headers a server's fetch does not send.
// Node's fetch sends Sec-Fetch-Mode, so that one alone is not a browser.
function browserRequest(headers) {
  return headers.origin !== undefined ||
    headers["sec-fetch-site"] !== undefined ||
    headers["sec-fetch-dest"] !== undefined ||
    headers["sec-fetch-user"] !== undefined;
}

// The Connect PC port: what another PC's HerdRabbit calls to show this PC's
// sessions on its own page. It is a listener of its own, apart from the page's
// (src/http-server.mjs), and the two share nothing a caller could cross:
//
//   - this port answers /api/link/ and nothing else, so a peer never reaches
//     the page, the login, or the browser API;
//   - the page's listener has no /api/link/ routes at all, so a browser (or
//     anything holding a page session) never reaches the peer API;
//   - a peer is let in by its tailnet address or account (PeerIdentity), never
//     by a cookie, a password or a header, and a browser by those alone;
//   - a request must name this port by the address it listens on (or one of
//     `hostNames`), so a page on someone else's name that resolves here is
//     refused before anything else is looked at.
//
// `link` is linkRoutes (src/link-server.mjs); `peer` is a PeerIdentity.
// `attach` is linkAttachSockets (src/link-attach.mjs), the one WebSocket this
// port speaks: a hub attaching to a pane's terminal. Without it every upgrade
// is turned away. `hostNames` returns other names this PC is reached by, such
// as its tailnet DNS name. With an empty allowed list every request is refused.
export function createPeerServer({ peer, link, attach = null, hostNames = () => [], logger = console }) {
  // What every request and every upgrade passes, in this order, before any
  // route sees it.
  async function admit(request) {
    if (!expectedHost(request.headers.host)) {
      throw new HttpError(421, "wrong_host", "This port answers only to its own address.");
    }
    if (browserRequest(request.headers)) {
      throw new HttpError(403, "browser_refused", "This port answers other PCs, not browsers.");
    }
    const url = new URL(request.url || "/", "http://peer.invalid");
    // Narrowed before asking who is calling, so the refusal is the same for
    // everyone and nothing else here is ever served.
    if (!url.pathname.startsWith("/api/link/")) throw new HttpError(404, "not_found", "Not found");
    await peer.authorize(request);
    return url;
  }

  function failureOf(error) {
    const failure = error instanceof PeerRejected
      ? { status: error.status, code: error.code, message: error.message }
      : errorResponse(error);
    if (failure.status >= 500) logger.error?.(`Connect PC request failed: ${error?.message || error}`);
    return failure;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = await admit(request);
      if (await link(request, response, url, request.method || "GET")) return;
      throw new HttpError(404, "not_found", "Not found");
    } catch (error) {
      const failure = failureOf(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, failure.status, {
        error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) },
      });
    }
  });

  // What the socket is bound to, read when asked: the port is not known
  // until listening, and a test listens wherever it is given.
  function expectedHost(value) {
    if (typeof value !== "string" || value === "") return false;
    const bound = server.address();
    if (!bound || typeof bound !== "object") return false;
    const host = value.toLowerCase();
    if (host === hostPort(bound.address, bound.port).toLowerCase()) return true;
    return hostNames().some((name) => typeof name === "string" && name !== "" &&
      host === `${name.toLowerCase()}:${bound.port}`);
  }

  // A terminal attach is the only upgrade: it passes the same checks as any
  // request, then the attach's own (pane, size, how many are open). A refusal
  // is an ordinary HTTP answer and the connection closes.
  server.on("upgrade", async (request, socket, head) => {
    socket.on("error", () => {});
    try {
      const url = await admit(request);
      if (!attach?.matches(url.pathname)) throw new HttpError(404, "not_found", "Not found");
      await attach.upgrade(request, socket, head, url);
    } catch (error) {
      const failure = failureOf(error);
      if (socket.destroyed) return;
      const body = JSON.stringify({ error: { code: failure.code, message: failure.message } });
      socket.end(`HTTP/1.1 ${failure.status} ${STATUS_CODES[failure.status] ?? "Error"}\r\n` +
        "Connection: close\r\nCache-Control: no-store\r\nContent-Type: application/json; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  });
  server.maxConnections = MAX_PEER_CONNECTIONS;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  // Covers receiving a request, not answering it: a status stream's request
  // is a short body, and the stream that follows it is the response.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
