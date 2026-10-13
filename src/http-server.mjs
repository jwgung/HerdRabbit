import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  InputValidationError,
  HerdrCommandError,
  ALLOWED_KEYS,
  MAX_PANE_READ_LINES,
  validation,
} from "./herdr-client.mjs";
import { PasswordAttemptsByKey, PasswordAuth } from "./password-auth.mjs";
import { PasskeyError, browserLabel, passkeyLabel } from "./passkey-auth.mjs";
import { OutputRevisions } from "./output-revisions.mjs";
import { attachTerminalWebSocket } from "./terminal-websocket.mjs";
import { HttpError, acceptUpload, aiAccountRoute, decodePaneId, readJsonBody, sendJson } from "./http-basics.mjs";
import { AiAccountError } from "./ai-accounts.mjs";
import {
  PEER_ADDRESS_HEADER, PEER_LOGIN_HEADER,
  isLoopbackSocket, nearestForwardedAddress, normalizeLogin, socketAddress,
} from "./peer-identity.mjs";
import { terminalOutputWatcher } from "./terminal-output-watch.mjs";
import { PushValidationError } from "./web-push-service.mjs";
import { validateTransferName } from "./file-store.mjs";
import { FileAccessError, fileAccessError, listDirectory, openFile, validateBrowsePath, directoryFingerprint } from "./file-browser.mjs";
import { MAX_TEXT_PREVIEW_BYTES, inlineTypeFor, isMarkdown } from "../public/file-preview.js";
import { renderMarkdown } from "./markdown.mjs";
import { secretPrompt } from "./secret-prompt.mjs";
import { validMachineLabel, validMachineTarget } from "./herdr-machines.mjs";
import { ConversationError } from "./conversation/pages.mjs";
import { ConversationMonitor } from "./conversation/monitor.mjs";
import { ConversationService } from "./conversation/service.mjs";
import { PromptService } from "./prompt/service.mjs";
import { PendingInputs } from "./pending-input.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const SIMPLEWEBAUTHN_BROWSER_BUNDLE = fileURLToPath(new URL(
  "../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js",
  import.meta.url,
));
const STATIC_FILES = new Map([
  ["/ui/index.html", { path: `${PUBLIC_DIR}/ui/index.html`, type: "text/html; charset=utf-8" }],
  ["/ui/ui.css", { path: `${PUBLIC_DIR}/ui/ui.css`, type: "text/css; charset=utf-8" }],
  ["/ui/tokens.css", { path: `${PUBLIC_DIR}/ui/tokens.css`, type: "text/css; charset=utf-8" }],
  ["/ui/base.css", { path: `${PUBLIC_DIR}/ui/base.css`, type: "text/css; charset=utf-8" }],
  ["/ui/components.css", { path: `${PUBLIC_DIR}/ui/components.css`, type: "text/css; charset=utf-8" }],
  ["/ui/examples.css", { path: `${PUBLIC_DIR}/ui/examples.css`, type: "text/css; charset=utf-8" }],
  ["/ui/examples.js", { path: `${PUBLIC_DIR}/ui/examples.js`, type: "text/javascript; charset=utf-8" }],
  ["/", { path: `${PUBLIC_DIR}/index.html`, type: "text/html; charset=utf-8" }],
  ["/app.js", { path: `${PUBLIC_DIR}/app.js`, type: "text/javascript; charset=utf-8" }],
  ["/terminal-links.js", { path: `${PUBLIC_DIR}/terminal-links.js`, type: "text/javascript; charset=utf-8" }],
  ["/terminal-connection.js", { path: `${PUBLIC_DIR}/terminal-connection.js`, type: "text/javascript; charset=utf-8" }],
  ["/xterm-terminal.js", { path: `${PUBLIC_DIR}/xterm-terminal.js`, type: "text/javascript; charset=utf-8" }],
  ["/terminal-widths.js", { path: `${PUBLIC_DIR}/terminal-widths.js`, type: "text/javascript; charset=utf-8" }],
  ["/touch-scroll.js", { path: `${PUBLIC_DIR}/touch-scroll.js`, type: "text/javascript; charset=utf-8" }],
  ["/terminal-selection.js", { path: `${PUBLIC_DIR}/terminal-selection.js`, type: "text/javascript; charset=utf-8" }],
  ["/vendor/xterm.mjs", { path: `${PUBLIC_DIR}/vendor/xterm.mjs`, type: "text/javascript; charset=utf-8" }],
  ["/vendor/xterm.css", { path: `${PUBLIC_DIR}/vendor/xterm.css`, type: "text/css; charset=utf-8" }],
  ["/key-combinations.js", { path: `${PUBLIC_DIR}/key-combinations.js`, type: "text/javascript; charset=utf-8" }],
  ["/file-preview.js", { path: `${PUBLIC_DIR}/file-preview.js`, type: "text/javascript; charset=utf-8" }],
  ["/ui-model.js", { path: `${PUBLIC_DIR}/ui-model.js`, type: "text/javascript; charset=utf-8" }],
  ["/pane-preference.js", { path: `${PUBLIC_DIR}/pane-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/browse-preference.js", { path: `${PUBLIC_DIR}/browse-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/workspace-preference.js", { path: `${PUBLIC_DIR}/workspace-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/terminal-preference.js", { path: `${PUBLIC_DIR}/terminal-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/completion-preference.js", { path: `${PUBLIC_DIR}/completion-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/alert-preference.js", { path: `${PUBLIC_DIR}/alert-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/input-history-preference.js", { path: `${PUBLIC_DIR}/input-history-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/composer-draft-preference.js", { path: `${PUBLIC_DIR}/composer-draft-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/secret-prompt.js", { path: `${PUBLIC_DIR}/secret-prompt.js`, type: "text/javascript; charset=utf-8" }],
  ["/key-bar-preference.js", { path: `${PUBLIC_DIR}/key-bar-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/key-bar.css", { path: `${PUBLIC_DIR}/key-bar.css`, type: "text/css; charset=utf-8" }],
  ["/launch-session.js", { path: `${PUBLIC_DIR}/launch-session.js`, type: "text/javascript; charset=utf-8" }],
  ["/push-notifications.js", { path: `${PUBLIC_DIR}/push-notifications.js`, type: "text/javascript; charset=utf-8" }],
  ["/lens-preference.js", { path: `${PUBLIC_DIR}/lens-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/markdown.js", { path: `${PUBLIC_DIR}/chat/markdown.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/diff.js", { path: `${PUBLIC_DIR}/chat/diff.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/work-blocks.js", { path: `${PUBLIC_DIR}/chat/work-blocks.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/conversation-refresh.js", { path: `${PUBLIC_DIR}/chat/conversation-refresh.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/chat-view.js", { path: `${PUBLIC_DIR}/chat/chat-view.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/chat-view.css", { path: `${PUBLIC_DIR}/chat/chat-view.css`, type: "text/css; charset=utf-8" }],
  ["/chat/chat-activity.js", { path: `${PUBLIC_DIR}/chat/chat-activity.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/prompt-card.js", { path: `${PUBLIC_DIR}/chat/prompt-card.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/prompt-card.css", { path: `${PUBLIC_DIR}/chat/prompt-card.css`, type: "text/css; charset=utf-8" }],
  ["/chat/pending-messages.js", { path: `${PUBLIC_DIR}/chat/pending-messages.js`, type: "text/javascript; charset=utf-8" }],
  ["/chat/pending-messages.css", { path: `${PUBLIC_DIR}/chat/pending-messages.css`, type: "text/css; charset=utf-8" }],
  ["/chat-font-preference.js", { path: `${PUBLIC_DIR}/chat-font-preference.js`, type: "text/javascript; charset=utf-8" }],
  ["/vendor/simplewebauthn-browser.js", { path: SIMPLEWEBAUTHN_BROWSER_BUNDLE, type: "text/javascript; charset=utf-8" }],
  ["/theme.js", { path: `${PUBLIC_DIR}/theme.js`, type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { path: `${PUBLIC_DIR}/styles.css`, type: "text/css; charset=utf-8" }],
  ["/manifest.webmanifest", { path: `${PUBLIC_DIR}/manifest.webmanifest`, type: "application/manifest+json; charset=utf-8" }],
  ["/sw.js", { path: `${PUBLIC_DIR}/sw.js`, type: "text/javascript; charset=utf-8" }],
  ["/favicon.ico", { path: `${PUBLIC_DIR}/favicon.ico`, type: "image/x-icon" }],
  ["/icons/favicon.svg", { path: `${PUBLIC_DIR}/icons/favicon.svg`, type: "image/svg+xml" }],
  ["/icons/app-icon.svg", { path: `${PUBLIC_DIR}/icons/app-icon.svg`, type: "image/svg+xml" }],
  ["/icons/favicon-32.png", { path: `${PUBLIC_DIR}/icons/favicon-32.png`, type: "image/png" }],
  ["/icons/rabbit-outline-v33.svg", { path: `${PUBLIC_DIR}/icons/favicon.svg`, type: "image/svg+xml" }],
  ["/icons/rabbit-outline-32-v33.png", { path: `${PUBLIC_DIR}/icons/favicon-32.png`, type: "image/png" }],
  ["/icons/rabbit-outline-180-v33.png", { path: `${PUBLIC_DIR}/icons/herdr-180.png`, type: "image/png" }],
  ["/icons/rabbit-outline-192-v33.png", { path: `${PUBLIC_DIR}/icons/herdr-192.png`, type: "image/png" }],
  ["/icons/rabbit-outline-512-v33.png", { path: `${PUBLIC_DIR}/icons/herdr-512.png`, type: "image/png" }],
  ["/icons/rabbit-outline-app-180-v35.png", { path: `${PUBLIC_DIR}/icons/herdr-180.png`, type: "image/png" }],
  ["/icons/rabbit-outline-app-192-v35.png", { path: `${PUBLIC_DIR}/icons/herdr-192.png`, type: "image/png" }],
  ["/icons/rabbit-outline-app-512-v35.png", { path: `${PUBLIC_DIR}/icons/herdr-512.png`, type: "image/png" }],
  ["/icons/herdr-180.png", { path: `${PUBLIC_DIR}/icons/herdr-180.png`, type: "image/png" }],
  ["/icons/herdr-192.png", { path: `${PUBLIC_DIR}/icons/herdr-192.png`, type: "image/png" }],
  ["/icons/herdr-512.png", { path: `${PUBLIC_DIR}/icons/herdr-512.png`, type: "image/png" }],
  ["/icons/notification-icon-192.png", { path: `${PUBLIC_DIR}/icons/notification-icon-192.png`, type: "image/png" }],
  ["/icons/notification-badge-96.png", { path: `${PUBLIC_DIR}/icons/notification-badge-96.png`, type: "image/png" }],
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_OUTPUT_LINES = 200;
const MAX_OUTPUT_LINES = MAX_PANE_READ_LINES - 1;
const OUTPUT_REVISION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
// Framed rather than drawn by an element, so it answers for itself rather than
// borrowing the app's headers -- the app's answer to being framed is "never".
function setFramedHeaders(response, type) {
  if (!FRAMED_TYPES.has(type)) return;
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Content-Security-Policy", FRAMED_TYPES.get(type));
}

const FRAMED_TYPES = new Map([
  ["text/html", [
    "default-src 'none'", "img-src data:", "style-src 'unsafe-inline'", "font-src data:",
    "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'", "sandbox",
  ].join("; ")],
]);


const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'";
// The app page alone may add inline styles: xterm's renderer creates <style>
// elements of its own, with no way to give them a nonce. Scripts, fonts,
// images and connections stay with this origin there too.
const APP_PAGE_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");

function applySecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}


function sendEmpty(response, status) {
  response.statusCode = status;
  response.end();
}

function requestHostname(request) {
  const host = request.headers.host;
  if (typeof host !== "string" || host.length > 255) {
    return null;
  }

  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function hasValidHost(request, allowedHosts) {
  const hostname = requestHostname(request)?.toLowerCase();
  return hostname !== undefined && hostname !== null && allowedHosts.has(hostname);
}

function safeTokenEquals(expected, candidate) {
  if (typeof candidate !== "string") {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return (
    expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

function requireWriteAuthorization(request, csrfToken) {
  if (!safeTokenEquals(csrfToken, request.headers["x-herdr-csrf"])) {
    throw new HttpError(403, "csrf_rejected", "Write token rejected");
  }

  requireSameOrigin(request);
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  const allowedOrigins = new Set([
    `http://${request.headers.host}`,
    `https://${request.headers.host}`,
  ]);
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    throw new HttpError(403, "origin_rejected", "Request origin rejected");
  }

  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "site_rejected", "Cross-site writes are not allowed");
  }
}

function forwardedProtocol(request) {
  return String(request.headers["x-forwarded-proto"] || "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
}

function requestOrigin(request) {
  if (typeof request.headers.origin === "string") {
    return request.headers.origin;
  }
  const protocol = request.socket.encrypted === true || forwardedProtocol(request) === "https"
    ? "https"
    : "http";
  return `${protocol}://${request.headers.host}`;
}

// Who is guessing, in terms the guesser cannot pick. Behind Tailscale Serve
// (a loopback socket) that is the login or the nearest forwarded address Serve
// stamps on; on any other socket it is the socket's own address.
export function attemptKey(request) {
  if (!isLoopbackSocket(request)) return `address:${socketAddress(request) ?? "unknown"}`;
  const login = normalizeLogin(request.headers[PEER_LOGIN_HEADER]);
  if (login) return `login:${login}`;
  const forwarded = nearestForwardedAddress(request.headers[PEER_ADDRESS_HEADER]);
  return forwarded ? `address:${forwarded}` : "loopback";
}

function isSecureRequest(request) {
  return request.socket.encrypted === true || forwardedProtocol(request) === "https";
}

function sendAuthenticatedSession(response, request, auth, extra = {}) {
  const secure = isSecureRequest(request);
  const device = auth.browserDevice(request.headers.cookie);
  const cookieSession = auth.createSession({
    agent: browserLabel(request.headers["user-agent"]), device, cookieHeader: request.headers.cookie,
  });
  const launchToken = auth.createLaunchToken();
  response.setHeader("Set-Cookie", [auth.sessionCookie(cookieSession, { secure }), auth.deviceCookie(device, { secure })]);
  sendJson(response, 200, {
    ok: true,
    required: true,
    launchToken,
    ...extra,
  });
  return launchToken;
}


function parseOutputLineLimit(value) {
  if (value === null || value === "") return DEFAULT_OUTPUT_LINES;
  const lines = Number(value);
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_OUTPUT_LINES) {
    throw new HttpError(
      400,
      "invalid_output_lines",
      `Output lines must be between 1 and ${MAX_OUTPUT_LINES}`,
    );
  }
  return lines;
}

function parseOutputRevision(value) {
  if (value === null || value === "") return null;
  if (!OUTPUT_REVISION_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_output_revision", "Output revision is invalid");
  }
  return value;
}

// Herdr answers a read short: blank rows at the bottom are trimmed and wrapped
// rows come back joined, so a Claude pane asked for 201 rows sends 199. One row
// past the window cannot tell whether older rows exist; half as many again, and
// never fewer than MIN_OUTPUT_OVERREAD_LINES, can.
const MIN_OUTPUT_OVERREAD_LINES = 64;

export function outputReadLines(lines) {
  const overread = Math.max(MIN_OUTPUT_OVERREAD_LINES, Math.ceil(lines / 2));
  return Math.min(MAX_PANE_READ_LINES, lines + overread);
}

export function outputWindow(output, requestedLines) {
  const rows = output === "" ? [] : String(output).split("\n");
  const hasMore = rows.length > requestedLines;
  const visibleRows = hasMore ? rows.slice(-requestedLines) : rows;
  return {
    output: visibleRows.join("\n"),
    requestedLines,
    returnedLines: visibleRows.length,
    hasMore,
  };
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  // File and SFTP failures already carry a status; without this they would
  // surface as 500s from the paths that throw outside a route's own handling.
  if (error instanceof FileAccessError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof InputValidationError) {
    return { status: 400, code: "invalid_input", message: error.message };
  }
  if (error instanceof PushValidationError) {
    return { status: 400, code: "invalid_push_subscription", message: error.message };
  }
  if (error instanceof PasskeyError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  // Messages and details are written by the account manager itself and name
  // no credential; details only ever lists the panes a switch would affect.
  if (error instanceof AiAccountError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  // A conversation that cannot be shown says why (details.reason) for the
  // page to word it; a stale cursor is a 409 the page reloads on.
  if (error instanceof ConversationError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof HerdrCommandError) {
    return {
      status: error.code === "herdr_timeout" ? 504 : 502,
      code: error.code,
      message: error.message,
    };
  }

  return { status: 500, code: "internal_error", message: "Internal server error" };
}

// Unlike readJsonBody, an oversized upload cannot be drained: the point of the
// limit is to not read it. Content-Length settles the question before a byte
// arrives, and a request that will not declare its size is refused outright.

// Node rejects header values above U+00FF, so a file copied in from a terminal
// under a Korean or emoji name has to travel as RFC 5987 percent-encoding. The
// attachment disposition and octet-stream type are what keep a stored HTML or
// SVG file from ever rendering in the browser, so neither is conditional.
// A size of null means the length is unknown -- procfs reports zero while still
// holding content -- so the body goes out chunked rather than with a header that
// would cut it short.
async function sendDownload(response, { file, stream }) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/octet-stream");
  if (file.size !== null && file.size !== undefined) {
    response.setHeader("Content-Length", file.size);
  }
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  );
  response.on("close", () => stream.destroy());
  await pipeline(stream, response);
}

// The viewer's door. Everything that makes it safe is decided before a byte
// moves: the type comes from an allow-list keyed on the name, never from the
// bytes, and `nosniff` is already on every response, so the browser cannot go
// looking for a second opinion. Nothing that can execute is on that list.
// Markdown is the one thing here that is not the file: it is what the file
// becomes. So it is read whole rather than streamed, and the length that goes
// out is the rendered length, not the source's.
async function readWholeFile(file) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of file.stream) {
    bytes += chunk.length;
    if (bytes > MAX_TEXT_PREVIEW_BYTES) {
      file.stream.destroy();
      throw new HttpError(413, "file_too_large", "That file is too long to show here.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function sendInline(response, { file, type, markdown = false }) {
  if (markdown) {
    const html = Buffer.from(renderMarkdown(await readWholeFile(file), file.name), "utf8");
    setFramedHeaders(response, type);
    response.statusCode = 200;
    response.setHeader("Content-Type", `${type}; charset=utf-8`);
    response.setHeader("Content-Length", html.length);
    response.end(html);
    return;
  }
  response.setHeader("Content-Type", type);
  // Images and media are drawn by an element on the page. HTML is drawn by the
  // browser itself, which it will only do inside a frame -- and this app
  // refuses to be framed at all, by two headers, on every response. So that
  // body answers for itself instead of borrowing the app's answer. `sandbox`
  // is the whole of it: the document loads into an opaque origin with no
  // script, no forms and no way to navigate what contains it, and that holds
  // for anyone who opens the URL, not just for our frame. On that footing
  // `style-src 'unsafe-inline'` costs nothing and is what lets a saved report
  // look like the report it is. Framing is reopened only to this origin, which
  // is the page doing the drawing; what those two headers guard against is
  // another site framing the app to trick a click, and file bytes are not that.
  //
  // A PDF is not framed at all -- it opens in a tab -- so it needs none of
  // this and gets none of it. See the viewer.
  setFramedHeaders(response, type);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader(
    "Content-Disposition",
    `inline; filename="preview"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  );
  // Whether this is a slice was settled when the file was opened -- reading it
  // back off the file is what keeps the header and the bytes from disagreeing.
  if (file.range) {
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${file.range.start}-${file.range.end}/${file.size}`);
  } else {
    response.statusCode = 200;
  }
  if (file.length !== null && file.length !== undefined) {
    response.setHeader("Content-Length", file.length);
  }
  response.on("close", () => file.stream.destroy());
  await pipeline(file.stream, response);
}

// Browsing reads whatever the service account can read, and a stuck NFS mount or
// a slow directory ties up a libuv thread that logins and static files share. A
// small ceiling keeps one wedged path from taking the whole app down.
function directoryReadLimiter(maxConcurrent) {
  let active = 0;
  return async function withSlot(work) {
    if (active >= maxConcurrent) {
      throw new HttpError(429, "browse_busy", "Too many folders are being read. Try again.");
    }
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
    }
  };
}

// A download is a plain navigation, so it cannot carry the launch token header
// the /api/ gate wants. A ticket stands in for that header: minted on an
// authorised request, short lived, spent once. It also keeps the file path out
// of every URL, and so out of any proxy log sitting in front of the app.
const LOCAL_SERVER = "local";
const AI_ACCOUNT_ROUTE = aiAccountRoute("/api/ai-accounts");
// The browser recognises sign-in projects by this prefix and keeps what is
// typed into them out of its prompt history.
const AI_LOGIN_LABEL_PREFIX = "AI login: ";

function downloadTickets({ ttlMs = 30_000, viewTtlMs = 10 * 60_000, max = 32 } = {}) {
  const tickets = new Map();
  const sweep = () => {
    const now = Date.now();
    for (const [key, value] of tickets) if (value.expiresAt <= now) tickets.delete(key);
  };
  return {
    // Whether this is a download or a view is settled here, on a request that
    // carried the CSRF token, and the type is settled with it. The link that
    // comes back cannot be turned into the other thing by editing the URL.
    issue(filePath, serverId = LOCAL_SERVER, inlineType = null, markdown = false) {
      sweep();
      if (tickets.size >= max) {
        throw new HttpError(429, "too_many_downloads", "Too many downloads are pending.");
      }
      const ticket = randomBytes(32).toString("base64url");
      // A download is one request; a video is a hundred, as the player seeks.
      // So a view ticket outlives its first use and expires on the clock
      // instead, while a download ticket is still spent the moment it is used.
      tickets.set(ticket, {
        path: filePath,
        serverId,
        inlineType,
        markdown,
        expiresAt: Date.now() + (inlineType ? viewTtlMs : ttlMs),
      });
      return ticket;
    },
    redeem(ticket) {
      sweep();
      const found = tickets.get(ticket);
      if (!found) throw new HttpError(404, "ticket_expired", "This download link has expired.");
      if (!found.inlineType) tickets.delete(ticket);
      return found;
    },
  };
}

// The browser module throws raw filesystem errors; without this an EACCES would
// surface as a 500 and be written to the error log.
function browseFailure(error) {
  const mapped = fileAccessError(error);
  if (!mapped) throw error;
  throw new HttpError(mapped.status, mapped.code, mapped.message);
}

function browsePath(value) {
  try {
    return validateBrowsePath(value);
  } catch (error) {
    return browseFailure(error);
  }
}

async function browseDirectory(value, options, source) {
  try {
    if (source) return await source.listDirectory(value, options);
    return await listDirectory(browsePath(value), options);
  } catch (error) {
    return browseFailure(error);
  }
}

async function openBrowsedFile(value, source, rangeHeader = null) {
  try {
    const file = source
      ? await source.openFile(value, { rangeHeader })
      : await openFile(value, { rangeHeader });
    return { file, stream: file.stream };
  } catch (error) {
    return browseFailure(error);
  }
}

async function serveStatic(response, pathname, method) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) {
    return false;
  }

  const body = await readFile(entry.path);
  response.statusCode = 200;
  if (pathname === "/") response.setHeader("Content-Security-Policy", APP_PAGE_CONTENT_SECURITY_POLICY);
  response.setHeader("Content-Type", entry.type);
  response.setHeader("Cache-Control", pathname === "/sw.js" ? "no-cache" : "no-cache, private");
  response.setHeader("Content-Length", body.length);
  response.end(method === "HEAD" ? undefined : body);
  return true;
}

// A conversation cursor from the query: absent or empty is none; the page
// read refuses one that does not name a place in the transcript.
function conversationCursor(value) {
  if (value === null || value === "") return undefined;
  if (value.length > 200) throw new HttpError(400, "invalid_cursor", "That conversation cursor is not valid.");
  return value;
}

// The versions an If-None-Match header names, without quotes or W/. `*`
// (RFC 9110) matches any current representation: the page read answers 304
// for it once the conversation exists.
function requestedVersions(header) {
  if (typeof header !== "string" || header.length > 1024) return [];
  if (header.trim() === "*") return ["*"];
  return header.split(",").map((tag) => tag.trim().replace(/^W\//u, "").replace(/^"(.*)"$/u, "$1")).filter(Boolean);
}

export function createHerdrHttpServer({
  herdr,
  files = null,
  auth = new PasswordAuth(),
  passkeys = null,
  push = null,
  notificationMonitor = null,
  allowedHosts = LOOPBACK_HOSTS,
  aiAccounts = null,
  attachments = null,
  machines = null,
  // A pane's Claude or Codex conversation (src/conversation/): this machine's
  // transcripts, and a Herdr machine's through its file client.
  conversations = null,
  // Prompt cards (src/prompt/): a blocked pane's approval or question.
  prompts = null,
  // Messages queued for a pane's next turn (src/pending-input.mjs).
  pending = null,
  // How many links to other HerdRabbits an older version saved. Those are not
  // used any more; the page says once to add those PCs again with herdr machine.
  legacyServers = 0,
  csrfToken = randomBytes(32).toString("base64url"),
  maxBodyBytes = 16 * 1024,
  maxTransferBytes = 50 * 1024 * 1024,
  logger = console,
  passwordAttempts = new PasswordAttemptsByKey(),
  recheckAttempts = new PasswordAttemptsByKey(),
  now = () => Date.now(),
} = {}) {
  if (!herdr) {
    throw new TypeError("herdr client is required");
  }
  const conversationService = conversations ?? new ConversationService({ herdr });
  const conversationMonitor = new ConversationMonitor({ resolve: (paneId) => conversationService.resolve(paneId) });
  const promptService = prompts ?? new PromptService({ herdr });
  const pendingInputs = pending ?? new PendingInputs({ herdr });
  {
    // A queued message that reached its pane is a request like one typed.
    const delivered = pendingInputs.onDelivered;
    pendingInputs.onDelivered = (paneId, text) => {
      delivered?.(paneId, text);
      outputWatcher.input(paneId);
      promptService.nudge(paneId);
      notificationMonitor?.recordRequest(paneId, text);
    };
  }

  // A message sent while the pane asks for a password is that password: the
  // page keeps it out of its input history, and no request is recorded. A
  // screen that cannot be read might be asking, so it is treated as asking.
  async function asksForSecret(paneId) {
    try {
      return secretPrompt(await herdr.readPane(paneId, { lines: 4, format: "text" })) !== null;
    } catch {
      return true;
    }
  }

  // One password check at a time: a burst sent while unlocked would otherwise
  // all pass the lock before any of them failed. Nobody types two at once.
  // Sign-in and the recheck count apart, so wrong guesses at the sign-in screen
  // cannot keep a signed-in owner from removing a lost device's passkey.
  let checkingPassword = false;
  async function checkPassword(request, response, password, attempts = passwordAttempts) {
    const key = attemptKey(request);
    if (checkingPassword) {
      response.setHeader("Retry-After", "1");
      throw new HttpError(429, "too_many_attempts", "Another password is being checked. Try again in a moment.");
    }
    const waitMs = attempts.retryAfterMs(key);
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1_000);
      response.setHeader("Retry-After", String(seconds));
      throw new HttpError(429, "too_many_attempts", `Too many wrong passwords. Try again in ${seconds} s.`);
    }
    checkingPassword = true;
    try {
      if (!(await auth.verifyPassword(password))) {
        attempts.failed(key);
        throw new HttpError(401, "invalid_password", "The password is incorrect.");
      }
      attempts.succeeded(key);
    } finally {
      checkingPassword = false;
    }
  }

  // A window that has just signed in with the password may add one passkey in
  // the next few minutes without typing it again, so the passkey offered right
  // after sign-in does not need it twice. Removing always asks. Keyed by that
  // window's launch token, and used up by the first registration it starts.
  const FRESH_LOGIN_MS = 5 * 60_000;
  const freshLogins = new Map();
  function rememberFreshLogin(launchToken) {
    for (const [token, expiresAt] of freshLogins) {
      if (expiresAt <= now()) freshLogins.delete(token);
    }
    // Oldest first, as a Map keeps them.
    while (freshLogins.size >= 64) freshLogins.delete(freshLogins.keys().next().value);
    freshLogins.set(launchToken, now() + FRESH_LOGIN_MS);
  }

  async function requirePasswordAgain(request, response, password, { freshLoginCounts = false } = {}) {
    if (!auth.required) {
      throw new HttpError(409, "password_auth_required", "Enable password authentication first.");
    }
    const launchToken = request.headers["x-herdr-launch-token"];
    if (freshLoginCounts && (password === undefined || password === "") && freshLogins.get(launchToken) > now()) {
      freshLogins.delete(launchToken);
      return;
    }
    await checkPassword(request, response, password, recheckAttempts);
  }

  const normalizedAllowedHosts = new Set(
    [...allowedHosts].map((host) => String(host).toLowerCase()),
  );
  const outputRevisions = new OutputRevisions();
  const server = createServer(async (request, response) => {
    applySecurityHeaders(response);

    try {
      if (!hasValidHost(request, normalizedAllowedHosts)) {
        throw new HttpError(421, "host_rejected", "Request host rejected");
      }

      const url = new URL(request.url || "/", `http://${request.headers.host}`);
      const method = request.method || "GET";

      if ((method === "GET" || method === "HEAD") && (await serveStatic(response, url.pathname, method))) {
        return;
      }

      if (method === "GET" && url.pathname === "/api/auth/status") {
        sendJson(response, 200, {
          required: auth.required,
          authenticated: auth.hasValidSession(request.headers.cookie) &&
            auth.hasValidLaunchToken(request.headers["x-herdr-launch-token"]),
          passkeyAvailable: auth.required && passkeys?.hasCredentials === true,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/login") {
        requireSameOrigin(request);
        const body = await readJsonBody(request, maxBodyBytes);
        if (!auth.required) {
          sendJson(response, 200, { ok: true, required: false });
          return;
        }
        await checkPassword(request, response, body.password);
        rememberFreshLogin(sendAuthenticatedSession(response, request, auth, {
          passkeyAvailable: passkeys?.hasCredentials === true,
        }));
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/passkeys/login/options") {
        requireSameOrigin(request);
        await readJsonBody(request, maxBodyBytes);
        if (!auth.required || !passkeys || passkeys.hasCredentials !== true) {
          throw new HttpError(404, "passkey_unavailable", "No passkey is registered.");
        }
        sendJson(response, 200, await passkeys.beginAuthentication(requestOrigin(request)));
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/passkeys/login/verify") {
        requireSameOrigin(request);
        const body = await readJsonBody(request, maxBodyBytes);
        if (!auth.required || !passkeys || passkeys.hasCredentials !== true) {
          throw new HttpError(404, "passkey_unavailable", "No passkey is registered.");
        }
        if (
          typeof body.attemptId !== "string" ||
          !body.credential ||
          typeof body.credential !== "object" ||
          Array.isArray(body.credential)
        ) {
          throw new HttpError(400, "invalid_passkey_response", "The passkey response is invalid.");
        }
        if (!(await passkeys.finishAuthentication(
          requestOrigin(request),
          body.attemptId,
          body.credential,
        ))) {
          throw new HttpError(401, "invalid_passkey", "Could not verify the passkey.");
        }
        sendAuthenticatedSession(response, request, auth, { passkeyAvailable: true });
        return;
      }

      // Ahead of the /api/ gate on purpose: a navigation cannot send the launch
      // token header, and the ticket already proves the request was authorised.
      const ticketMatch = url.pathname.match(/^\/api\/browse\/download\/([A-Za-z0-9_-]{16,86})$/u);
      if (method === "GET" && ticketMatch) {
        const claim = tickets.redeem(ticketMatch[1]);
        const from = claim.serverId === LOCAL_SERVER ? null : herdr.fileClient?.(claim.serverId);
        // A server removed since the ticket was issued must not fall back to
        // opening the same path on this machine.
        if (claim.serverId !== LOCAL_SERVER && !from) {
          throw new HttpError(404, "unknown_server", "That server is no longer configured.");
        }
        if (!claim.inlineType) {
          await sendDownload(response, await openBrowsedFile(claim.path, from));
          return;
        }
        // A rendered file is not sliced: what a range would name does not exist
        // until it has been rendered, so the whole of it is read either way.
        const range = claim.markdown ? null : request.headers.range ?? null;
        const opened = await openBrowsedFile(claim.path, from, range);
        await sendInline(response, {
          file: opened.file, type: claim.inlineType, markdown: claim.markdown,
        });
        return;
      }

      if (
        url.pathname.startsWith("/api/") &&
        auth.required &&
        (
          !auth.hasValidSession(request.headers.cookie) ||
          !auth.hasValidLaunchToken(request.headers["x-herdr-launch-token"])
        )
      ) {
        throw new HttpError(401, "authentication_required", "Enter your password.");
      }

      // Herdr's own SSH machines: added, renamed, turned off and removed with
      // `herdr machine`, so the sidebar and Herdr's TUI list the same ones.
      if (machines && url.pathname.startsWith("/api/machines")) {
        const match = url.pathname.match(/^\/api\/machines(?:\/(machine-[0-9a-f]{12})(\/disable|\/enable)?)?$/u);
        if (!match) throw new HttpError(404, "not_found", "Machine route not found");
        requireWriteAuthorization(request, csrfToken);
        const body = method === "DELETE" ? {} : await readJsonBody(request, maxBodyBytes);
        const [, serverId, toggle] = match;
        const machineId = serverId ? machines.machineIdFor(serverId) : null;
        if (serverId && !machineId) throw new HttpError(404, "not_found", "That machine is no longer in Herdr's list.");
        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (method === "POST" && !serverId) {
          if (!validMachineTarget(body.target)) throw new HttpError(400, "invalid_machine", "Enter an SSH target such as user@host or a host from your SSH config.");
          if (label && !validMachineLabel(label)) throw new HttpError(400, "invalid_machine", "A name is up to 60 characters on one line.");
          await machines.add({ target: body.target, label });
        } else if (method === "PUT" && serverId && !toggle) {
          if (!validMachineLabel(label)) throw new HttpError(400, "invalid_machine", "A name is 1 to 60 characters on one line.");
          await machines.rename(machineId, label);
        } else if (method === "POST" && toggle === "/disable") {
          await machines.disable(machineId);
        } else if (method === "POST" && toggle === "/enable") {
          await machines.enable(machineId);
        } else if (method === "DELETE" && serverId && !toggle) {
          await machines.remove(machineId);
        } else {
          throw new HttpError(405, "method_not_allowed", "Method not allowed");
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (files && url.pathname.startsWith("/api/files")) {
        const match = url.pathname.match(/^\/api\/files(?:\/([^/]+))?$/u);
        if (!match) throw new HttpError(404, "not_found", "File route not found");
        const name = match[1] === undefined ? null : validateTransferName(match[1]);
        // Writing to a Herdr machine goes to that machine's own uploads folder,
        // never to a path the request chooses.
        const { serverId: filesServer, source: remote } = fileSource(url.searchParams.get("server"));
        if (method === "GET" && !name) {
          // The directory is sent so the UI can tell when it is showing the
          // uploads folder and offer uploads there. It is a display hint only -- what
          // actually confines writes is that these routes cannot address a path
          // outside the uploads folder at all.
          const listing = remote
            ? { directory: await remote.uploadsDirectory(), files: await remote.listUploads() }
            : { directory: files.directory, files: await files.list() };
          sendJson(response, 200, { ...listing, server: filesServer });
          return;
        }
        if (method === "GET" && name) {
          if (remote) {
            const file = await remote.openUpload(name);
            await sendDownload(response, { file, stream: file.stream });
          } else {
            await sendDownload(response, await files.open(name));
          }
          return;
        }
        requireWriteAuthorization(request, csrfToken);
        if (method === "POST" && name) {
          const body = acceptUpload(request, maxTransferBytes);
          const saved = remote
            ? await remote.saveUpload(name, body, { bytes: Number(request.headers["content-length"]) })
            : await files.save(name, body);
          sendJson(response, 201, { file: saved, server: filesServer });
          return;
        }
        if (method === "DELETE" && name) {
          if (remote) await remote.removeUpload(name);
          else await files.remove(name);
          sendEmpty(response, 204);
          return;
        }
        throw new HttpError(405, "method_not_allowed", "Method not allowed");
      }

      // AI CLI accounts. Every route returns who an account belongs to and
      // nothing that signs in as it; the credentials stay on their machine.
      if (url.pathname.startsWith("/api/ai-accounts")) {
        const match = url.pathname.match(AI_ACCOUNT_ROUTE);
        if (!aiAccounts || !match) throw new HttpError(404, "not_found", "Not found");
        const [, action, loginId, step] = match;
        if (method === "GET" && !action && !loginId) {
          // Same-origin like browsing: a listing may wait on a Herdr machine.
          requireSameOrigin(request);
          const { serverId, source } = accountsSource(url.searchParams.get("server"));
          sendJson(response, 200, { ...(await source.list()), server: serverId });
          return;
        }
        if (method !== "POST" || (!action && !loginId)) throw new HttpError(405, "method_not_allowed", "Method not allowed");
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        const { serverId, source } = accountsSource(body.server);
        if (action === "current") {
          sendJson(response, 200, { ...(await source.saveCurrent(body.cli)), server: serverId });
        } else if (action === "switch") {
          const result = await source.switch(body.cli, body.account, { confirmRunning: body.confirmRunning === true });
          sendJson(response, 200, { ...result, server: serverId });
        } else if (action === "remove") {
          sendJson(response, 200, { ...(await source.remove(body.cli, body.account)), server: serverId });
        } else if (action === "logins") {
          const login = await source.startLogin(body.cli);
          let opened;
          try {
            opened = await openLoginPane(serverId, body.herdrSessionId, login);
          } catch (error) {
            await source.cancelLogin(login.cli, login.loginId).catch(() => {});
            throw error;
          }
          sendJson(response, 201, { cli: login.cli, loginId: login.loginId, server: serverId, ...opened });
        } else {
          const result = step === "finish"
            ? await source.finishLogin(body.cli, loginId)
            : await source.cancelLogin(body.cli, loginId);
          await closeLoginWorkspace(serverId, body.workspaceId);
          sendJson(response, 200, { ...result, server: serverId, snapshot: await herdr.snapshot() });
        }
        return;
      }

      if (url.pathname.startsWith("/api/browse")) {
        if (method === "GET" && url.pathname === "/api/browse") {
          // Same-origin only. Another site cannot read the reply, but it could
          // still trigger the request, and a wedged path costs a shared thread.
          requireSameOrigin(request);
          const prefix = url.searchParams.get("prefix") || "";
          if (prefix.length > 255) {
            throw new HttpError(400, "invalid_input", "That name is too long.");
          }
          const { serverId, source } = fileSource(url.searchParams.get("server"));
          const target = url.searchParams.get("path");
          // A Herdr machine does its own reading, so it needs none of the local
          // thread budget -- and one that stops answering cannot exhaust it.
          const listing = source
            ? await browseDirectory(target, { prefix }, source)
            : await withDirectorySlot(() => browseDirectory(target, { prefix }));
          sendJson(response, 200, { ...listing, server: serverId });
          return;
        }
        if (method === "GET" && url.pathname === "/api/browse/check") {
          requireSameOrigin(request);
          const { serverId, source } = fileSource(url.searchParams.get("server"));
          const rawTargets = url.searchParams.get("targets");
          let targets = {};
          if (rawTargets) {
            try {
              targets = JSON.parse(rawTargets);
            } catch {
              throw new HttpError(400, "invalid_input", "Malformed targets.");
            }
          }
          if (typeof targets !== "object" || targets === null || Array.isArray(targets)) {
            throw new HttpError(400, "invalid_input", "Malformed targets.");
          }
          const targetPaths = Object.keys(targets);
          if (targetPaths.length > 64) {
            throw new HttpError(400, "invalid_input", "Too many targets.");
          }
          const changed = [];
          // A Herdr SSH machine answers every folder in one round trip.
          if (typeof source?.directoryFingerprints === "function") {
            const current = await source.directoryFingerprints(targetPaths).catch(() => new Map());
            for (const path of targetPaths) {
              const fingerprint = current.get(path);
              if (fingerprint === null || fingerprint === undefined || fingerprint !== targets[path]) changed.push(path);
            }
            sendJson(response, 200, { changed, server: serverId });
            return;
          }
          for (const path of targetPaths) {
            const knownEtag = targets[path];
            try {
              const current = source
                ? await (typeof source.directoryFingerprint === "function"
                  ? source.directoryFingerprint(path)
                  : null)
                : await directoryFingerprint(browsePath(path));
              if (current === null || current !== knownEtag) {
                changed.push(path);
              }
            } catch {
              changed.push(path);
            }
          }
          sendJson(response, 200, { changed, server: serverId });
          return;
        }
        if (method === "POST" && url.pathname === "/api/browse/tickets") {
          requireWriteAuthorization(request, csrfToken);
          const body = await readJsonBody(request, maxBodyBytes);
          const { serverId, source } = fileSource(body.server);
          const filePath = source ? String(body.path) : browsePath(body.path);
          // Which door this link opens is decided here, on a request that
          // carried the CSRF token, from the name alone. A file with no viewable
          // type gets no view link at all rather than a downgraded one.
          const inlineType = body.view === true ? inlineTypeFor(filePath) : null;
          if (body.view === true && !inlineType) {
            throw new HttpError(415, "not_viewable", "That kind of file cannot be shown here.");
          }
          sendJson(response, 201, {
            ticket: tickets.issue(filePath, serverId, inlineType, inlineType ? isMarkdown(filePath) : false),
          });
          return;
        }
        // A download link that did not match the ticket pattern above is a
        // stale or mistyped one, which reads as expired rather than as a bad
        // method.
        if (method === "GET" && url.pathname.startsWith("/api/browse/download/")) {
          throw new HttpError(404, "ticket_expired", "This download link has expired.");
        }
        throw new HttpError(405, "method_not_allowed", "Method not allowed");
      }

      // Sign-ins, listed by browser and date. Ending one needs no password:
      // it only ever takes access away.
      if (method === "GET" && url.pathname === "/api/auth/sessions") {
        const current = auth.currentSessionId(request.headers.cookie);
        sendJson(response, 200, {
          sessions: auth.sessionSummaries().map((session) => ({ ...session, current: session.id === current })),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/sessions/end") {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        if (!(await auth.endSession(body.id))) {
          throw new HttpError(404, "session_not_found", "This sign-in has already ended.");
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/sessions/end-all") {
        requireWriteAuthorization(request, csrfToken);
        await readJsonBody(request, maxBodyBytes);
        await auth.endAllSessions();
        response.setHeader("Set-Cookie", auth.clearSessionCookie({ secure: isSecureRequest(request) }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/logout") {
        requireWriteAuthorization(request, csrfToken);
        await readJsonBody(request, maxBodyBytes);
        await auth.endCurrentSession(request.headers.cookie);
        response.setHeader("Set-Cookie", auth.clearSessionCookie({ secure: isSecureRequest(request) }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/auth/passkeys") {
        sendJson(response, 200, { passkeys: auth.passkeySummaries() });
        return;
      }

      // Adding or removing a passkey asks for the password again: a stolen
      // session alone must not be able to plant a sign-in that outlives it.
      if (method === "POST" && url.pathname === "/api/auth/passkeys/register/options") {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        if (!passkeys) {
          throw new HttpError(503, "passkey_unavailable", "Passkeys are unavailable.");
        }
        await requirePasswordAgain(request, response, body.password, { freshLoginCounts: true });
        sendJson(response, 200, await passkeys.beginRegistration(requestOrigin(request)));
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/passkeys/remove") {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        await requirePasswordAgain(request, response, body.password);
        if (!(await auth.removePasskey(body.handle))) {
          throw new HttpError(404, "passkey_not_registered", "This passkey is not registered.");
        }
        // Every other session ended with the removal; this browser keeps going.
        sendAuthenticatedSession(response, request, auth, { passkeyAvailable: auth.hasPasskeys });
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/passkeys/register/verify") {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        if (!passkeys) {
          throw new HttpError(503, "passkey_unavailable", "Passkeys are unavailable.");
        }
        if (
          typeof body.attemptId !== "string" ||
          !body.credential ||
          typeof body.credential !== "object" ||
          Array.isArray(body.credential)
        ) {
          throw new HttpError(400, "invalid_passkey_response", "The passkey response is invalid.");
        }
        if (!(await passkeys.finishRegistration(
          requestOrigin(request),
          body.attemptId,
          body.credential,
          { label: passkeyLabel(request.headers["user-agent"]) },
        ))) {
          throw new HttpError(400, "passkey_verification_failed", "Could not verify the passkey.");
        }
        sendJson(response, 200, { ok: true, passkeyAvailable: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/bootstrap") {
        sendJson(response, 200, {
          authRequired: auth.required,
          csrfToken,
          allowedKeys: ALLOWED_KEYS,
          pollIntervalMs: 1_000,
          pushPublicKey: push?.publicKey || null,
          // Whether SSH machines can be added here: not without a socket directory.
          machines: Boolean(machines),
          legacyServers,
        });
        return;
      }

      // Sent to every subscribed device, the asking one too, so each can see
      // that alerts arrive. It names no pane, so no open window swallows it.
      if (method === "POST" && url.pathname === "/api/push/test") {
        if (!push) {
          throw new HttpError(503, "push_unavailable", "Push notifications are unavailable");
        }
        requireWriteAuthorization(request, csrfToken);
        await readJsonBody(request, maxBodyBytes);
        await push.send({ title: "HerdRabbit", body: "Test notification. Alerts reach this device.", tag: "herd-rabbit:test", data: {} });
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/push/subscriptions") {
        if (!push) {
          throw new HttpError(503, "push_unavailable", "Push notifications are unavailable");
        }
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        if (method === "POST") {
          await push.subscribe(body.subscription);
          await notificationMonitor?.poll?.();
          sendJson(response, 201, { ok: true });
          return;
        }
        if (method === "DELETE") {
          await push.unsubscribe(body.endpoint);
          sendEmpty(response, 204);
          return;
        }
      }

      if (method === "GET" && url.pathname === "/api/snapshot") {
        sendJson(response, 200, { snapshot: await herdr.snapshot() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/workspaces") {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        if (body.herdrSessionId === undefined) {
          await herdr.createWorkspace(body.label);
        } else {
          await herdr.createWorkspace(body.label, body.herdrSessionId);
        }
        sendJson(response, 201, { snapshot: await herdr.snapshot() });
        return;
      }

      const workspaceRenameMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/rename$/,
      );
      if (method === "POST" && workspaceRenameMatch) {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        await herdr.renameWorkspace(
          decodePaneId(workspaceRenameMatch[1]),
          body.label,
        );
        sendJson(response, 200, { ok: true });
        return;
      }

      const workspaceTabsMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/tabs$/,
      );
      if (method === "POST" && workspaceTabsMatch) {
        requireWriteAuthorization(request, csrfToken);
        await readJsonBody(request, maxBodyBytes);
        await herdr.createTab(decodePaneId(workspaceTabsMatch[1]));
        sendJson(response, 201, { snapshot: await herdr.snapshot() });
        return;
      }

      const workspaceCloseMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/close$/,
      );
      if (method === "POST" && workspaceCloseMatch) {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        if (body.confirmed !== true) {
          throw new HttpError(400, "confirmation_required", "Close confirmation is required");
        }
        await herdr.closeWorkspace(decodePaneId(workspaceCloseMatch[1]));
        sendJson(response, 200, { snapshot: await herdr.snapshot() });
        return;
      }

      const tabRenameMatch = url.pathname.match(/^\/api\/tabs\/([^/]+)\/rename$/);
      if (method === "POST" && tabRenameMatch) {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        await herdr.renameTab(decodePaneId(tabRenameMatch[1]), body.label);
        sendJson(response, 200, { ok: true });
        return;
      }

      const tabCloseMatch = url.pathname.match(/^\/api\/tabs\/([^/]+)\/close$/);
      if (method === "POST" && tabCloseMatch) {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        if (body.confirmed !== true) {
          throw new HttpError(400, "confirmation_required", "Close confirmation is required");
        }
        await herdr.closeTab(decodePaneId(tabCloseMatch[1]));
        sendJson(response, 200, { snapshot: await herdr.snapshot() });
        return;
      }

      const outputMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/output$/);
      if (method === "GET" && outputMatch) {
        const paneId = decodePaneId(outputMatch[1]);
        const lines = parseOutputLineLimit(url.searchParams.get("lines"));
        const since = parseOutputRevision(url.searchParams.get("since"));
        // Legacy history=hybrid requests also use the terminal's own scrollback.
        const output = await herdr.readPane(paneId, {
          lines: outputReadLines(lines),
          format: "ansi",
        });
        const window = outputWindow(output, lines);
        const update = outputRevisions.update({ paneId, window, since });
        if (update === null) {
          sendEmpty(response, 204);
          return;
        }
        sendJson(response, 200, update);
        return;
      }

      // A Claude or Codex pane's conversation, a page of turns at a time. The ETag is
      // the answer's version: an unchanged poll costs no body.
      const conversationMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/conversation$/);
      if (method === "GET" && conversationMatch) {
        const answer = await conversationService.page(decodePaneId(conversationMatch[1]), {
          before: conversationCursor(url.searchParams.get("before")),
          since: conversationCursor(url.searchParams.get("since")),
          ifNoneMatch: requestedVersions(request.headers["if-none-match"]),
        });
        response.setHeader("ETag", `"${answer.version}"`);
        if (answer.notModified) {
          sendEmpty(response, 304);
          return;
        }
        sendJson(response, 200, answer);
        return;
      }

      // One tool call's whole output (capped), which a page only previews.
      const toolOutputMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/conversation\/tools\/([^/]+)$/);
      if (method === "GET" && toolOutputMatch) {
        sendJson(response, 200, await conversationService.toolOutput(
          decodePaneId(toolOutputMatch[1]), decodePaneId(toolOutputMatch[2]),
        ));
        return;
      }

      // The card a blocked pane shows (approval, question, menu), or null.
      const promptMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/prompt$/);
      if (method === "GET" && promptMatch) {
        sendJson(response, 200, { card: await promptService.card(decodePaneId(promptMatch[1])) });
        return;
      }

      // An option of that card, by its id: a card that changed meanwhile is a
      // 409 prompt_changed, and nothing is sent.
      const answerMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/prompt\/answer$/);
      if (method === "POST" && answerMatch) {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        const paneId = decodePaneId(answerMatch[1]);
        await promptService.answer(paneId, body);
        outputWatcher.input(paneId);
        sendJson(response, 200, { ok: true });
        return;
      }

      // Messages waiting for the pane's next turn: the list, a new one, and
      // what can be done to one (cancel, edit, move, retry, send now).
      const pendingMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/pending$/);
      if (pendingMatch && method === "GET") {
        sendJson(response, 200, { items: pendingInputs.list(decodePaneId(pendingMatch[1])), revision: pendingInputs.revision });
        return;
      }
      if (pendingMatch && method === "POST") {
        requireWriteAuthorization(request, csrfToken);
        // 8000 characters may take three bytes each.
        const body = await readJsonBody(request, Math.max(maxBodyBytes, 64 * 1024));
        const paneId = decodePaneId(pendingMatch[1]);
        const item = await pendingInputs.enqueue(paneId, body?.text);
        sendJson(response, 200, { item, items: pendingInputs.list(paneId), revision: pendingInputs.revision });
        return;
      }
      const pendingItemMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/pending\/([^/]+)$/);
      if (pendingItemMatch && method === "POST") {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, Math.max(maxBodyBytes, 64 * 1024));
        const paneId = decodePaneId(pendingItemMatch[1]);
        const id = decodePaneId(pendingItemMatch[2]);
        const action = body?.action;
        let outcome = {};
        if (action === "cancel") outcome = pendingInputs.cancel(paneId, id);
        else if (action === "edit") pendingInputs.edit(paneId, id, body.text);
        else if (action === "up" || action === "down") pendingInputs.move(paneId, id, action === "up" ? -1 : 1);
        else if (action === "retry") pendingInputs.retry(paneId, id);
        else if (action === "send-now") await pendingInputs.sendNow(paneId, id);
        else throw new HttpError(400, "invalid_action", "Unknown action.");
        sendJson(response, 200, { ...outcome, items: pendingInputs.list(paneId), revision: pendingInputs.revision });
        return;
      }

      const textMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/text$/);
      if (method === "POST" && textMatch) {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        const paneId = decodePaneId(textMatch[1]);
        const secret = body.submit === true && await asksForSecret(paneId);
        await herdr.sendText(paneId, body.text, {
          submit: body.submit === true,
        });
        promptService.nudge(paneId);
        if (body.submit === true && !secret) {
          notificationMonitor?.recordRequest(paneId, body.text);
        }
        sendJson(response, 200, { ok: true, ...(secret ? { secret } : {}) });
        return;
      }

      const keysMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/keys$/);
      if (method === "POST" && keysMatch) {
        requireWriteAuthorization(request, csrfToken);
        const body = await readJsonBody(request, maxBodyBytes);
        await herdr.sendKeys(decodePaneId(keysMatch[1]), body.keys);
        promptService.nudge(decodePaneId(keysMatch[1]));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (
        method !== "GET" &&
        method !== "HEAD" &&
        method !== "POST" &&
        method !== "DELETE"
      ) {
        response.setHeader("Allow", "GET, HEAD, POST, DELETE");
        throw new HttpError(405, "method_not_allowed", "Method not allowed");
      }

      throw new HttpError(404, "not_found", "Not found");
    } catch (error) {
      const publicError = errorResponse(error);
      if (publicError.status >= 500) {
        logger.error?.("request failed", {
          method: request.method,
          path: request.url?.split("?", 1)[0],
          code: publicError.code,
        });
      }
      if (!response.headersSent) {
        sendJson(response, publicError.status, {
          error: {
            code: publicError.code,
            message: publicError.message,
            ...(publicError.details === undefined ? {} : { details: publicError.details }),
          },
        });
      } else {
        response.destroy();
      }
    }
  });

  // Uploads stream a whole file through one request, and requestTimeout covers
  // the entire body, so the 10s that suits JSON routes would cut them off.
  // headersTimeout keeps the slowloris defence on the header phase.
  server.requestTimeout = 120_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;

  // A Herdr machine answers for its own files, so the id resolves to that
  // machine's client; local keeps the filesystem path.
  function fileSource(value) {
    if (value === undefined || value === null || value === "" || value === LOCAL_SERVER) {
      return { serverId: LOCAL_SERVER, source: null };
    }
    const source = herdr.fileClient?.(value);
    if (!source) throw new HttpError(404, "unknown_server", "That server is no longer configured.");
    return { serverId: value, source };
  }

  function accountsSource(value) {
    if (value === undefined || value === null || value === "" || value === LOCAL_SERVER) {
      return { serverId: LOCAL_SERVER, source: aiAccounts };
    }
    const source = typeof value === "string" ? herdr.aiAccountsClient?.(value) : null;
    if (!source) throw new HttpError(404, "unknown_server", "That server is no longer configured.");
    return { serverId: value, source };
  }

  // A sign-in runs in a project of its own on the machine being signed in to.
  // The command typed there names only the empty directory to sign in to.
  async function openLoginPane(serverId, herdrSessionId, login) {
    if (herdrSessionId !== undefined && typeof herdrSessionId !== "string") {
      throw new InputValidationError("Invalid Herdr session id");
    }
    const remote = serverId !== LOCAL_SERVER;
    if (remote && !herdrSessionId?.startsWith(`${serverId}!`)) {
      throw new InputValidationError("Choose a running Herdr session on that server");
    }
    if (!remote && herdrSessionId?.includes("!")) throw new InputValidationError("Invalid Herdr session id");
    const label = `${AI_LOGIN_LABEL_PREFIX}${login.label} (${login.loginId.slice(6, 14)})`;
    await (herdrSessionId === undefined ? herdr.createWorkspace(label) : herdr.createWorkspace(label, herdrSessionId));
    const snapshot = await herdr.snapshot();
    const workspace = (snapshot.workspaces ?? []).find((item) =>
      item.label === label && (item.server_id ?? LOCAL_SERVER) === serverId);
    const pane = workspace && (snapshot.panes ?? []).find((item) => item.workspace_id === workspace.workspace_id);
    if (!pane) throw new HttpError(502, "login_pane_missing", "The sign-in terminal could not be opened.");
    await herdr.sendText(pane.pane_id, login.command, { submit: true });
    return { workspaceId: workspace.workspace_id, paneId: pane.pane_id, snapshot };
  }

  // Only a sign-in project on the same server is closed, whatever id arrives.
  async function closeLoginWorkspace(serverId, workspaceId) {
    if (typeof workspaceId !== "string") return;
    const snapshot = await herdr.snapshot();
    const workspace = (snapshot.workspaces ?? []).find((item) => item.workspace_id === workspaceId &&
      (item.server_id ?? LOCAL_SERVER) === serverId && String(item.label).startsWith(AI_LOGIN_LABEL_PREFIX));
    if (workspace) await herdr.closeWorkspace(workspaceId).catch(() => {});
  }

  const tickets = downloadTickets();
  const withDirectorySlot = directoryReadLimiter(4);
  const outputWatcher = terminalOutputWatcher({ herdr, outputWindow, outputReadLines });
  attachTerminalWebSocket({
    server,
    onSessionsEnded: (listener) => auth.onSessionsEnded?.(listener) ?? (() => {}),
    authorizeUpgrade(request) {
      if (!hasValidHost(request, normalizedAllowedHosts) || !request.headers.origin) throw new Error("Origin required");
      requireSameOrigin(request);
      if (auth.required && !auth.hasValidSession(request.headers.cookie)) throw new Error("Authentication required");
    },
    authorizeMessage(request, credentials) {
      if (!credentials || !safeTokenEquals(csrfToken, credentials.csrf)) throw new Error("Write token rejected");
      if (auth.required && (!auth.hasValidSession(request.headers.cookie) ||
          !auth.hasValidLaunchToken(credentials.launchToken))) throw new Error("Authentication required");
    },
    async sendInput(message) {
      let secret = false;
      if (message.keys) await herdr.sendKeys(message.paneId, validation.validateKeys(message.keys));
      else {
        const text = validation.validateText(message.text);
        if (message.submit === true) secret = await asksForSecret(message.paneId);
        await herdr.sendText(message.paneId, text, { submit: message.submit === true });
      }
      outputWatcher.input(message.paneId);
      promptService.nudge(message.paneId);
      return { secret };
    },
    watchOutput: (...args) => outputWatcher.watch(...args),
    // What a page hears of the statuses, the queue hears too: a pane that
    // turns ready gets its next message without waiting for the next look.
    watchStatuses: typeof herdr.watchStatuses === "function"
      ? (paneIds, onStatus, onError) => herdr.watchStatuses(paneIds, (event) => {
        pendingInputs.status(event.pane_id, event.agent_status);
        onStatus(event);
      }, onError)
      : undefined,
    attachments,
    onRequest: (paneId, text) => notificationMonitor?.recordRequest(paneId, text),
    watchConversation: (paneId, listener) => conversationMonitor.watch(paneId, listener),
    watchPrompt: (paneId, listener) => promptService.watch(paneId, listener),
    watchPending: (paneId, listener) => pendingInputs.watch(paneId, listener),
  });
  server.once("close", () => { conversationMonitor.stop(); promptService.stop(); pendingInputs.stop(); });

  return Object.freeze({ server, csrfToken, conversationMonitor });
}
