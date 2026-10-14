import { createServer } from "node:http";
import { HttpError, sendJson } from "./http-basics.mjs";
import { PeerRejected } from "./peer-identity.mjs";
import { errorResponse } from "./http-server.mjs";

// The Connect PC port: what another PC's HerdRabbit calls to show this PC's
// sessions on its own page. It is a listener of its own, apart from the page's
// (src/http-server.mjs), and the two share nothing a caller could cross:
//
//   - this port answers /api/link/ and nothing else, so a peer never reaches
//     the page, the login, or the browser API;
//   - the page's listener has no /api/link/ routes at all, so a browser (or
//     anything holding a page session) never reaches the peer API;
//   - a peer is let in by its tailnet address or account (PeerIdentity), never
//     by a cookie, a password or a header, and a browser by those alone.
//
// `link` is leafLinkRoutes (src/link-server.mjs); `peer` is a PeerIdentity.
// With an empty allowed list every request is refused.
export function createPeerServer({ peer, link, logger = console }) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(request.url || "/", "http://peer.invalid");
      const method = request.method || "GET";
      // Narrowed before asking who is calling, so the refusal is the same for
      // everyone and nothing else here is ever served.
      if (!url.pathname.startsWith("/api/link/")) throw new HttpError(404, "not_found", "Not found");
      await peer.authorize(request);
      if (await link(request, response, url, method)) return;
      throw new HttpError(404, "not_found", "Not found");
    } catch (error) {
      const failure = error instanceof PeerRejected
        ? { status: error.status, code: error.code, message: error.message }
        : errorResponse(error);
      if (failure.status >= 500) logger.error?.(`Connect PC request failed: ${error?.message || error}`);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, failure.status, {
        error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) },
      });
    }
  });
  // Nothing here speaks WebSocket; an upgrade is turned away before any route.
  server.on("upgrade", (request, socket) => {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  // A status stream stays open for as long as the hub watches, and an upload
  // as long as it keeps sending.
  server.requestTimeout = 0;
  return server;
}
