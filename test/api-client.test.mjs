import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApiClient } from "../public/api-client.js";

// A fake network: each call is answered with the next queued Response, and the
// page's hooks are recorded.
function setup({ launchToken = "launch-1", csrfToken = "csrf-1" } = {}) {
  const sent = [];
  const answers = [];
  const page = { launchToken, csrfToken, signedOut: 0 };
  const client = createApiClient({
    launchToken: () => page.launchToken,
    csrfToken: () => page.csrfToken,
    onAuthenticationRequired: () => { page.signedOut += 1; },
    fetchImpl: async (path, init) => {
      sent.push({ path, init });
      return answers.shift() ?? new Response("{}", { status: 200 });
    },
  });
  const answer = (body, status = 200, headers = {}) => answers.push(new Response(
    body === null ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers },
  ));
  return { client, sent, answer, page };
}

const failure = (message, code, details) => ({ error: { message, code, ...(details === undefined ? {} : { details }) } });

test("api sends the launch token and same-origin credentials, and returns the JSON", async () => {
  const { client, sent, answer } = setup();
  answer({ snapshot: { panes: [] } });
  assert.deepEqual(await client.api("/api/snapshot"), { snapshot: { panes: [] } });
  assert.equal(sent[0].path, "/api/snapshot");
  assert.equal(sent[0].init.credentials, "same-origin");
  assert.equal(sent[0].init.headers.get("X-Herdr-Launch-Token"), "launch-1");
  assert.equal(sent[0].init.headers.get("X-Herdr-CSRF"), null, "a read carries no write token");
  assert.equal(sent[0].init.headers.get("Content-Type"), null);
  assert.equal(sent[0].init.body, undefined);
});

test("api writes carry the write token and a JSON body", async () => {
  const { client, sent, answer } = setup();
  answer({ ok: true });
  await client.api("/api/panes/w1/text", { method: "POST", body: { text: "hi" } });
  const { init } = sent[0];
  assert.equal(init.method, "POST");
  assert.equal(init.headers.get("X-Herdr-CSRF"), "csrf-1");
  assert.equal(init.headers.get("Content-Type"), "application/json");
  assert.equal(init.body, JSON.stringify({ text: "hi" }));
});

test("api leaves the write token off when asked, and for a GET that names its method", async () => {
  const { client, sent, answer } = setup();
  answer({}); answer({});
  await client.api("/api/auth/status", { method: "POST", body: {}, csrf: false });
  await client.api("/api/snapshot", { method: "GET" });
  assert.equal(sent[0].init.headers.get("X-Herdr-CSRF"), null);
  assert.equal(sent[1].init.headers.get("X-Herdr-CSRF"), null);
});

test("api keeps the caller's own headers and takes the tokens as they are at each call", async () => {
  const { client, sent, answer, page } = setup();
  answer({}); answer({});
  await client.api("/api/x", { headers: { "X-Extra": "1" } });
  page.launchToken = "launch-2";
  await client.api("/api/x");
  assert.equal(sent[0].init.headers.get("X-Extra"), "1");
  assert.equal(sent[0].init.headers.get("X-Herdr-Launch-Token"), "launch-1");
  assert.equal(sent[1].init.headers.get("X-Herdr-Launch-Token"), "launch-2");
});

test("without a launch token none is sent", async () => {
  const { client, sent, answer } = setup({ launchToken: "" });
  answer({});
  await client.api("/api/snapshot");
  assert.equal(sent[0].init.headers.has("X-Herdr-Launch-Token"), false);
});

test("a refusal is an ApiError with what the server said", async () => {
  const { client, answer, page } = setup();
  answer(failure("No such pane.", "pane_not_found", { paneId: "w9" }), 404);
  await assert.rejects(client.api("/api/x"), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, "ApiError");
    assert.equal(error.message, "No such pane.");
    assert.equal(error.status, 404);
    assert.equal(error.code, "pane_not_found");
    assert.deepEqual(error.details, { paneId: "w9" });
    return true;
  });
  assert.equal(page.signedOut, 0, "only a sign-in refusal signs the page out");
});

test("a refusal without a readable body still says its status", async () => {
  const { client, answer } = setup();
  answer("<html>bad gateway</html>", 502);
  await assert.rejects(client.api("/api/x"), (error) => error.message === "HTTP 502" && error.status === 502 && error.code === undefined);
});

test("authentication_required signs the page out, from every kind of request", async () => {
  const { client, answer, page } = setup();
  for (const [index, call] of [
    () => client.api("/api/x"),
    () => client.transferRequest("/api/files"),
    () => client.conversationRequest("/api/panes/w1/conversation"),
  ].entries()) {
    answer(failure("Enter your password.", "authentication_required"), 401);
    await assert.rejects(call(), (error) => error instanceof ApiError && error.status === 401);
    assert.equal(page.signedOut, index + 1);
  }
});

test("transferRequest hands back the Response itself, with the launch token and the caller's options", async () => {
  const { client, sent, answer } = setup();
  answer("file bytes", 200, { "Content-Type": "text/plain" });
  const response = await client.transferRequest("/api/files/a.txt", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "abc" });
  assert.equal(await response.text(), "file bytes");
  const { init } = sent[0];
  assert.equal(init.method, "POST");
  assert.equal(init.body, "abc");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.headers.get("Content-Type"), "text/plain");
  assert.equal(init.headers.get("X-Herdr-Launch-Token"), "launch-1");
  assert.equal(init.headers.get("X-Herdr-CSRF"), null, "a transfer carries no write token of its own");
});

test("transferRequest refuses a failed transfer with an ApiError", async () => {
  const { client, answer } = setup();
  answer(failure("That file is too large.", "file_too_large"), 413);
  await assert.rejects(client.transferRequest("/api/files/a"), (error) => error.code === "file_too_large" && error.status === 413);
});

test("conversationRequest asks with the etag, never from cache, and returns the page with its new etag", async () => {
  const { client, sent, answer } = setup();
  answer({ turns: [] }, 200, { ETag: '"v2"' });
  const result = await client.conversationRequest("/api/panes/w1/conversation", { etag: '"v1"' });
  assert.deepEqual(result, { payload: { turns: [] }, etag: '"v2"' });
  const { init } = sent[0];
  assert.equal(init.cache, "no-store");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.headers.get("If-None-Match"), '"v1"');
  assert.equal(init.headers.get("X-Herdr-Launch-Token"), "launch-1");
});

test("conversationRequest says not modified on a 304, and sends no etag when it has none", async () => {
  const { client, sent, answer } = setup();
  answer(null, 304);
  assert.deepEqual(await client.conversationRequest("/api/panes/w1/conversation", { etag: '"v1"' }), { notModified: true });
  answer({ turns: [] });
  await client.conversationRequest("/api/panes/w1/conversation");
  assert.equal(sent[1].init.headers.has("If-None-Match"), false);
});
