// How the page talks to its server over HTTP. Three kinds of request share one
// way of sending and one way of failing, and differ only in what they hand back:
//
//   api(path, options)                  the JSON answer; a write (POST, PUT,
//                                       DELETE) carries the write token and a
//                                       JSON `body`, unless `csrf: false`
//   transferRequest(path, options)      the Response itself, for files and
//                                       tickets that are streamed or read as
//                                       something other than JSON
//   conversationRequest(path, {etag})   { payload, etag }, or { notModified }
//                                       on a 304, never from the HTTP cache
//
// A refusal is an ApiError carrying what the server said (status, code,
// details). One that says authentication_required also tells the page it is
// signed out, so no caller handles that itself.
export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// `launchToken()` and `csrfToken()` are read at each request, so a token the
// page replaces is used from the next one. `onAuthenticationRequired()` is
// where the page drops its launch token and shows the sign-in screen.
export function createApiClient({
  launchToken,
  csrfToken,
  onAuthenticationRequired,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  // The session gate wants the launch token as a header, which a plain link
  // cannot send, so every request goes through fetch with it.
  function headersFor(extra) {
    const headers = new Headers(extra);
    const token = launchToken();
    if (token) headers.set("X-Herdr-Launch-Token", token);
    return headers;
  }

  function refusal(response, payload) {
    const error = new ApiError(payload?.error?.message || `HTTP ${response.status}`, {
      status: response.status,
      code: payload?.error?.code,
      details: payload?.error?.details,
    });
    if (error.code === "authentication_required") onAuthenticationRequired();
    return error;
  }

  async function api(path, options = {}) {
    const { body, csrf = true, ...fetchOptions } = options;
    const headers = headersFor(options.headers);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (csrf && fetchOptions.method && fetchOptions.method !== "GET") headers.set("X-Herdr-CSRF", csrfToken());
    const response = await fetchImpl(path, {
      ...fetchOptions,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw refusal(response, payload);
    return payload;
  }

  async function transferRequest(path, options = {}) {
    const response = await fetchImpl(path, {
      ...options,
      headers: headersFor(options.headers),
      credentials: "same-origin",
    });
    if (!response.ok) throw refusal(response, await response.json().catch(() => ({})));
    return response;
  }

  async function conversationRequest(path, { etag } = {}) {
    const headers = headersFor();
    if (etag) headers.set("If-None-Match", etag);
    const response = await fetchImpl(path, { headers, credentials: "same-origin", cache: "no-store" });
    if (response.status === 304) return { notModified: true };
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw refusal(response, payload);
    return { payload, etag: response.headers.get("ETag") };
  }

  return { api, transferRequest, conversationRequest };
}

// What the page asks of one pane (the server's /api/panes/:id/..., src/pane-routes.mjs),
// as verbs over an `api`. The pane id is one path segment whatever it holds, and
// the path, the method and the body's shape are settled here. A body is sent as
// given; `{}` goes only where the server wants nothing but the pane.
const PANE_ACTIONS = new Set(["split", "close", "zoom"]);

export function paneApi(api) {
  const at = (paneId, tail) => `/api/panes/${encodeURIComponent(paneId)}/${tail}`;
  const post = (paneId, tail, body) => api(at(paneId, tail), { method: "POST", body });
  return {
    commands: (paneId) => api(at(paneId, "commands")),
    layout: (paneId) => api(at(paneId, "layout")),
    // From the grid: "split", "close" (with { confirmed: true }) or "zoom".
    act(paneId, action, body) {
      if (!PANE_ACTIONS.has(action)) throw new TypeError(`Not a pane action: ${action}`);
      return post(paneId, action, body);
    },
    move: (paneId, body) => post(paneId, "move", body),
    swap: (paneId, targetPaneId) => post(paneId, "swap", { targetPaneId }),
    relocate: (paneId, targetPaneId, side) => post(paneId, "relocate", { targetPaneId, side }),
    moveOut: (paneId) => post(paneId, "move-out", {}),
    evenLayout: (paneId) => post(paneId, "even-layout", {}),
    scrollToBottom: (paneId) => post(paneId, "scroll-bottom", {}),
    find: (paneId, body) => post(paneId, "find", body),
    reveal: (paneId, body) => post(paneId, "reveal", body),
  };
}
