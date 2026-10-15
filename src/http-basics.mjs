// Small HTTP helpers for the browser API, kept apart from http-server.mjs so
// a route module of its own can use them without importing the server.

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

// AI account actions, answered by the browser API and the link under their own
// prefixes. The sign-in id segment is only picked out here; the account manager
// decides whether it is one it issued.
export function aiAccountRoute(prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}(?:/(current|switch|remove|logins)|/logins/([^/]+)/(finish|cancel))?$`, "u");
}

export function decodePaneId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_path", "Invalid pane path");
  }
}

// A conversation cursor from the query (the page API and the Connect PC
// port read it alike): absent or empty is none; the page
// read refuses one that does not name a place in the transcript.
export function conversationCursor(value) {
  if (value === null || value === "") return undefined;
  if (value.length > 200) throw new HttpError(400, "invalid_cursor", "That conversation cursor is not valid.");
  return value;
}

// The versions an If-None-Match header names, without quotes or W/. `*`
// (RFC 9110) matches any current representation: the page read answers 304
// for it once the conversation exists.
export function requestedVersions(header) {
  if (typeof header !== "string" || header.length > 1024) return [];
  if (header.trim() === "*") return ["*"];
  return header.split(",").map((tag) => tag.trim().replace(/^W\//u, "").replace(/^"(.*)"$/u, "$1")).filter(Boolean);
}

export async function readJsonBody(request, maxBodyBytes) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json");
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }

  if (tooLarge) {
    throw new HttpError(413, "body_too_large", "Request body is too large");
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Body is not an object");
    }
    return body;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  }
}

export function acceptUpload(request, maxTransferBytes) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/octet-stream")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/octet-stream");
  }

  const declared = Number(request.headers["content-length"]);
  if (!Number.isInteger(declared) || declared < 0) {
    throw new HttpError(411, "length_required", "Send the file size with the upload.");
  }
  if (declared > maxTransferBytes) {
    throw new HttpError(413, "body_too_large", "The file is larger than the upload limit.");
  }

  return request;
}
