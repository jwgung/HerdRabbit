import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { acceptUpload } from "../src/http-basics.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { createPasswordConfiguration, PasswordAuth } from "../src/password-auth.mjs";
import { FileStore } from "../src/file-store.mjs";

const herdr = { async snapshot() { return {}; } };

async function startServer(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-api-"));
  const files = await FileStore.load(directory, { maxBytes: options.maxTransferBytes ?? 32 });
  const created = createHerdrHttpServer({
    herdr,
    files,
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    ...options,
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  return {
    ...created,
    directory,
    files,
    baseUrl: `http://127.0.0.1:${created.server.address().port}`,
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function uploadHeaders(extra = {}) {
  return {
    "Content-Type": "application/octet-stream",
    "X-Herdr-CSRF": "fixed-test-token",
    ...extra,
  };
}

test("carries a file up and back down again", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));

  const upload = await fetch(`${app.baseUrl}/api/files/report.log`, {
    method: "POST",
    headers: uploadHeaders({ Origin: app.baseUrl }),
    body: "terminal output",
  });
  assert.equal(upload.status, 201);
  const { file } = await upload.json();
  assert.equal(file.name, "report.log");
  assert.equal(file.path, join(app.directory, "report.log"));

  const listed = await fetch(`${app.baseUrl}/api/files`).then((response) => response.json());
  assert.deepEqual(listed.files.map((entry) => entry.name), ["report.log"]);

  const download = await fetch(`${app.baseUrl}/api/files/report.log`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition"), /^attachment;/u);
  assert.equal(await download.text(), "terminal output");

  const removed = await fetch(`${app.baseUrl}/api/files/report.log`, {
    method: "DELETE",
    headers: { "X-Herdr-CSRF": "fixed-test-token", Origin: app.baseUrl },
  });
  assert.equal(removed.status, 204);
  assert.deepEqual(await app.files.list(), []);
});

test("serves a file the terminal left under a non-ASCII name", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));
  await writeFile(join(app.directory, "보고서.pdf"), "report");

  const download = await fetch(`${app.baseUrl}/api/files/${encodeURIComponent("보고서.pdf")}`);
  assert.equal(download.status, 200);
  assert.equal(
    download.headers.get("content-disposition"),
    `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`,
  );
  assert.equal(await download.text(), "report");
});

test("refuses an oversized upload before reading the body", async (context) => {
  const app = await startServer({ maxTransferBytes: 8 });
  context.after(() => closeServer(app.server));

  const rejected = await fetch(`${app.baseUrl}/api/files/big.bin`, {
    method: "POST",
    headers: uploadHeaders({ Origin: app.baseUrl }),
    body: "far more than eight bytes",
  });
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).error.code, "body_too_large");
  assert.deepEqual(await app.files.list(), []);
});

test("requires a declared size and a binary content type", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));

  const wrongType = await fetch(`${app.baseUrl}/api/files/note.txt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", Origin: app.baseUrl },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);

  const chunked = await fetch(`${app.baseUrl}/api/files/note.txt`, {
    method: "POST",
    headers: uploadHeaders({ Origin: app.baseUrl }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    }),
    duplex: "half",
  });
  assert.equal(chunked.status, 411);
});

test("rejects names that try to leave the uploads folder", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));

  // A bare ".." never reaches the server: URL parsing resolves dot segments,
  // encoded or not, before the request is sent. What can arrive is a segment
  // that only becomes a separator once the server decodes it.
  for (const name of ["%2e%2e%2fpasswd", "%2fetc%2fpasswd", "%5cwindows", "%00cut", ".part-abc"]) {
    const response = await fetch(`${app.baseUrl}/api/files/${name}`);
    assert.equal(response.status, 400, name);
    assert.equal((await response.json()).error.code, "invalid_input");
  }

  const missing = await fetch(`${app.baseUrl}/api/files/absent.txt`);
  assert.equal(missing.status, 400);
});

test("keeps writes behind the CSRF token and reads behind the session", async (context) => {
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const app = await startServer({ auth });
  context.after(() => closeServer(app.server));

  const unauthenticated = await fetch(`${app.baseUrl}/api/files`);
  assert.equal(unauthenticated.status, 401);

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { launchToken } = await login.json();
  const session = { Cookie: cookie, "X-Herdr-Launch-Token": launchToken, Origin: app.baseUrl };

  const listed = await fetch(`${app.baseUrl}/api/files`, { headers: session });
  assert.equal(listed.status, 200);

  const withoutCsrf = await fetch(`${app.baseUrl}/api/files/note.txt`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...session },
    body: "denied",
  });
  assert.equal(withoutCsrf.status, 403);

  const accepted = await fetch(`${app.baseUrl}/api/files/note.txt`, {
    method: "POST",
    headers: uploadHeaders(session),
    body: "allowed",
  });
  assert.equal(accepted.status, 201);
});

test("gives uploads room to finish streaming", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));

  // Node's whole-request timer is off; the server guards requests itself so
  // only an upload may outlast it.
  assert.equal(app.server.requestTimeout, 0);
  assert.equal(app.server.headersTimeout, 5_000);
});

function trickle(app, { path, headers, chunks, gapMs }) {
  return new Promise((resolve) => {
    const request = httpRequest(`${app.baseUrl}${path}`, { method: "POST", headers }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode }));
    });
    request.on("error", (error) => resolve({ error: error.code }));
    let sent = 0;
    const next = () => {
      if (sent >= chunks) { if (chunks > 0) request.end(); return; }
      sent += 1;
      request.write("x");
      setTimeout(next, gapMs);
    };
    next();
  });
}

test("a slow upload outlasts the request timeout while it keeps sending", async (context) => {
  const app = await startServer({ maxTransferBytes: Infinity, requestTimeoutMs: 100, uploadIdleMs: 400 });
  context.after(() => closeServer(app.server));

  // Eight bytes, one every 60ms: about 480ms in all, nearly five times the request timeout.
  const started = Date.now();
  const result = await trickle(app, {
    path: "/api/files/slow.bin",
    headers: uploadHeaders({ Origin: app.baseUrl, "Content-Length": "8" }),
    chunks: 8,
    gapMs: 60,
  });
  assert.equal(result.status, 201);
  assert.ok(Date.now() - started > 400);
  assert.equal((await app.files.list())[0].size, 8);
});

test("an upload that goes quiet is dropped and leaves no file", async (context) => {
  const app = await startServer({ maxTransferBytes: Infinity, requestTimeoutMs: 100, uploadIdleMs: 300 });
  context.after(() => closeServer(app.server));

  const started = Date.now();
  const result = await trickle(app, {
    path: "/api/files/stalled.bin",
    headers: uploadHeaders({ Origin: app.baseUrl, "Content-Length": "8" }),
    chunks: 2,
    gapMs: 10_000,
  });
  assert.ok(result.error, "the connection is cut");
  // close to the idle period after the last byte, not up to twice it
  assert.ok(Date.now() - started < 300 * 1.5, `cut after ${Date.now() - started}ms`);
  assert.deepEqual(await app.files.list(), []);
});

test("other requests still have to arrive within the request timeout", async (context) => {
  const app = await startServer({ requestTimeoutMs: 150, uploadIdleMs: 10_000 });
  context.after(() => closeServer(app.server));

  const result = await trickle(app, {
    path: "/api/auth/login",
    headers: { "Content-Type": "application/json", "Content-Length": "100", "X-Herdr-CSRF": "fixed-test-token", Origin: app.baseUrl },
    chunks: 2,
    gapMs: 10_000,
  });
  assert.ok(result.error, "the connection is cut");
});

test("takes any size when no limit is set, and bootstrap says so", async (context) => {
  const app = await startServer({ maxTransferBytes: Infinity });
  context.after(() => closeServer(app.server));
  assert.equal((await (await fetch(`${app.baseUrl}/api/bootstrap`)).json()).maxTransferBytes, null);

  const accepted = await fetch(`${app.baseUrl}/api/files/ok.bin`, {
    method: "POST",
    headers: uploadHeaders({ Origin: app.baseUrl }),
    body: "x".repeat(1000),
  });
  assert.equal(accepted.status, 201);
});

test("bootstrap reports a configured limit in bytes", async (context) => {
  const app = await startServer({ maxTransferBytes: 8 });
  context.after(() => closeServer(app.server));
  assert.equal((await (await fetch(`${app.baseUrl}/api/bootstrap`)).json()).maxTransferBytes, 8);
});

test("acceptUpload compares the declared size only when there is a limit", () => {
  const request = (length) => ({ headers: { "content-type": "application/octet-stream", "content-length": length } });
  assert.equal(acceptUpload(request("99999999999999"), Infinity).headers["content-length"], "99999999999999");
  assert.throws(() => acceptUpload(request("9"), 8), { status: 413 });
  assert.doesNotThrow(() => acceptUpload(request("8"), 8));
  assert.throws(() => acceptUpload({ headers: { "content-type": "application/octet-stream" } }, Infinity), { status: 411 });
});

test("stays out of the way when no uploads folder is configured", async (context) => {
  const created = createHerdrHttpServer({ herdr, csrfToken: "fixed-test-token", logger: { error() {} } });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => closeServer(created.server));

  const response = await fetch(`http://127.0.0.1:${created.server.address().port}/api/files`);
  assert.equal(response.status, 404);
});

test("a request answered before its body is read has its socket closed, even if the body trickles", async (context) => {
  const app = await startServer({ requestTimeoutMs: 10_000, uploadIdleMs: 10_000 });
  context.after(() => closeServer(app.server));

  const socket = connect(app.server.address().port, "127.0.0.1");
  context.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write(`POST /api/nothing-here HTTP/1.1\r\nHost: 127.0.0.1:${app.server.address().port}\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n`);
  const trickle = setInterval(() => socket.write("x", () => {}), 20);
  context.after(() => clearInterval(trickle));
  socket.on("error", () => {});
  const started = Date.now();
  await new Promise((resolve) => socket.once("close", resolve));
  clearInterval(trickle);
  assert.ok(Date.now() - started < 2_000);
});

test("a POST whose body was read in full keeps its connection for the next request", async (context) => {
  const app = await startServer({ requestTimeoutMs: 10_000, uploadIdleMs: 10_000 });
  context.after(() => closeServer(app.server));
  const port = app.server.address().port;
  const socket = connect(port, "127.0.0.1");
  context.after(() => socket.destroy());
  await once(socket, "connect");
  let received = "";
  socket.on("data", (chunk) => { received += chunk.toString("latin1"); });
  const body = JSON.stringify({ password: "wrong" });
  // the login route reads the whole body before it answers
  socket.write(`POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  for (let tries = 0; tries < 100 && !/\r\n\r\n/u.test(received); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotMatch(received.split("\r\n\r\n")[0], /^connection: close$/imu);
  const first = received.length;
  socket.write(`GET /api/auth/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  for (let tries = 0; tries < 100 && !/HTTP\/1\.1 200/u.test(received.slice(first)); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(received.slice(first), /^HTTP\/1\.1 200/u, "the same connection answers a second request");
  assert.equal(socket.destroyed, false);
});
