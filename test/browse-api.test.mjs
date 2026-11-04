import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { createPasswordConfiguration, PasswordAuth } from "../src/password-auth.mjs";

const herdr = { async snapshot() { return {}; } };

async function startServer(options = {}) {
  const created = createHerdrHttpServer({
    herdr,
    csrfToken: "fixed-test-token",
    logger: { error() {} },
    ...options,
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  return { ...created, baseUrl: `http://127.0.0.1:${created.server.address().port}` };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-browse-api-"));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "report.txt"), "terminal output");
  await writeFile(join(directory, ".hidden"), "quiet");
  return directory;
}

function browse(app, path) {
  return fetch(`${app.baseUrl}/api/browse?path=${encodeURIComponent(path)}`, {
    headers: { Origin: app.baseUrl },
  });
}

async function ticketFor(app, path, headers = {}) {
  const response = await fetch(`${app.baseUrl}/api/browse/tickets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Herdr-CSRF": "fixed-test-token",
      Origin: app.baseUrl,
      ...headers,
    },
    body: JSON.stringify({ path }),
  });
  return response;
}

test("lists a folder with its parent and entries", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));
  const directory = await fixture();

  const listing = await browse(app, directory).then((response) => response.json());
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["nested", ".hidden", "report.txt"]);
  assert.equal(listing.entries[1].hidden, true);
  assert.ok(listing.parent);
});

test("~ and ~/… list from the home folder of the machine read", async (context) => {
  const directory = await fixture();
  const asked = [];
  const remote = {
    async home() { return "/home/far"; },
    async listDirectory(path) { asked.push(path); return { path: path ?? "/home/far", parent: null, entries: [], truncated: false, total: 0 }; },
  };
  const LINK = "link_11111111-1111-1111-1111-111111111111";
  const app = await startServer({
    homeDirectory: directory,
    herdr: { ...herdr, fileClient: (id) => (id === LINK ? remote : null) },
  });
  context.after(() => closeServer(app.server));
  const home = await (await browse(app, "~")).json();
  assert.equal(home.path, directory);
  assert.ok(home.entries.some((entry) => entry.name === "nested"));
  assert.equal((await (await browse(app, "~/nested")).json()).path, join(directory, "nested"));
  assert.equal((await browse(app, "~other")).status, 400);
  const far = (path) => fetch(`${app.baseUrl}/api/browse?server=${LINK}&path=${encodeURIComponent(path)}`, { headers: { Origin: app.baseUrl } });
  assert.equal((await (await far("~")).json()).path, "/home/far");
  assert.equal((await (await far("~/src")).json()).path, "/home/far/src");
  assert.deepEqual(asked, [null, "/home/far/src"]);
});

test("carries a file down through a one-time ticket", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));
  const directory = await fixture();
  const filePath = join(directory, "report.txt");

  const issued = await ticketFor(app, filePath);
  assert.equal(issued.status, 201);
  const { ticket } = await issued.json();

  const download = await fetch(`${app.baseUrl}/api/browse/download/${ticket}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-length"), "15");
  assert.match(download.headers.get("content-disposition"), /report\.txt$/u);
  assert.equal(await download.text(), "terminal output");

  // Spent once: a replay of the same link must not work.
  const replay = await fetch(`${app.baseUrl}/api/browse/download/${ticket}`);
  assert.equal(replay.status, 404);
  assert.equal((await replay.json()).error.code, "ticket_expired");
});

test("serves a download to a navigation that carries no headers", async (context) => {
  // The route sits ahead of the /api/ gate for exactly this reason: a plain
  // <a download> cannot send the launch token, and the ticket is the credential.
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const app = await startServer({ auth });
  context.after(() => closeServer(app.server));
  const directory = await fixture();

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { launchToken } = await login.json();

  const issued = await ticketFor(app, join(directory, "report.txt"), {
    Cookie: cookie,
    "X-Herdr-Launch-Token": launchToken,
  });
  assert.equal(issued.status, 201);
  const { ticket } = await issued.json();

  const bare = await fetch(`${app.baseUrl}/api/browse/download/${ticket}`);
  assert.equal(bare.status, 200, "no cookie, no launch token, still served");
  assert.equal(await bare.text(), "terminal output");
});

test("keeps browsing behind the session and ticket issuing behind CSRF", async (context) => {
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const app = await startServer({ auth });
  context.after(() => closeServer(app.server));
  const directory = await fixture();

  assert.equal((await browse(app, directory)).status, 401);

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({ password: "secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const { launchToken } = await login.json();
  const session = { Cookie: cookie, "X-Herdr-Launch-Token": launchToken, Origin: app.baseUrl };

  const listed = await fetch(`${app.baseUrl}/api/browse?path=${encodeURIComponent(directory)}`, {
    headers: session,
  });
  assert.equal(listed.status, 200);

  const noCsrf = await fetch(`${app.baseUrl}/api/browse/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...session },
    body: JSON.stringify({ path: join(directory, "report.txt") }),
  });
  assert.equal(noCsrf.status, 403);
});

test("refuses a cross-site browse request", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));
  const directory = await fixture();

  const foreign = await fetch(`${app.baseUrl}/api/browse?path=${encodeURIComponent(directory)}`, {
    headers: { Origin: "http://evil.example" },
  });
  assert.equal(foreign.status, 403);
});

test("maps filesystem failures onto meaningful statuses", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));
  const directory = await fixture();

  assert.equal((await browse(app, join(directory, "absent"))).status, 404);
  assert.equal((await browse(app, "relative/path")).status, 400);
  assert.equal((await browse(app, join(directory, "report.txt"))).status, 404, "a file is not a folder");
  assert.equal((await browse(app, "/root")).status, 403);

  const directoryTicket = await ticketFor(app, directory);
  assert.equal(directoryTicket.status, 201, "the path is only opened when redeemed");
  const { ticket } = await directoryTicket.json();
  assert.equal((await fetch(`${app.baseUrl}/api/browse/download/${ticket}`)).status, 400);
});

test("rejects an unknown or malformed ticket", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));

  assert.equal((await fetch(`${app.baseUrl}/api/browse/download/short`)).status, 404);
  assert.equal(
    (await fetch(`${app.baseUrl}/api/browse/download/${"a".repeat(43)}`)).status,
    404,
  );
});

async function viewTicket(app, path) {
  const response = await fetch(`${app.baseUrl}/api/browse/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "fixed-test-token", Origin: app.baseUrl },
    body: JSON.stringify({ path, view: true }),
  });
  return response;
}

test("a view link opens a second door, and only for what may go through it", async (context) => {
  // Downloads stay octet-stream attachments -- that is what keeps a stored page
  // from running at this origin -- so viewing is a separate link with its own
  // rules, and a file with nothing safe to be shown as gets no such link.
  const app = await startServer();
  context.after(() => closeServer(app.server));
  const directory = await fixture();
  await writeFile(join(directory, "shot.png"), "not really a png");

  const refused = await viewTicket(app, join(directory, "report.txt"));
  assert.equal(refused.status, 415, "text is read as bytes, never served as itself");
  assert.equal((await refused.json()).error.code, "not_viewable");

  const { ticket } = await (await viewTicket(app, join(directory, "shot.png"))).json();
  const shown = await fetch(`${app.baseUrl}/api/browse/download/${ticket}`);
  assert.equal(shown.headers.get("content-type"), "image/png");
  assert.match(shown.headers.get("content-disposition"), /^inline;/u);
  assert.equal(shown.headers.get("accept-ranges"), "bytes");
  // The name decided that type. The bytes were never consulted, and nosniff
  // keeps the browser from consulting them either.
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
});

test("reopens framing for the two types a browser has to frame, and for nothing else", async (context) => {
  // The app refuses to be framed at all, twice over. A document cannot be shown
  // without a frame, so its own response carries a narrower answer -- and that
  // narrowing must not leak to any other body.
  const app = await startServer();
  context.after(() => closeServer(app.server));
  const directory = await fixture();
  await writeFile(join(directory, "report.html"), "<h1>hi</h1>");
  await writeFile(join(directory, "manual.pdf"), "%PDF-1.4");
  await writeFile(join(directory, "shot.png"), "not really a png");

  const headersFor = async (name) => {
    const { ticket } = await (await viewTicket(app, join(directory, name))).json();
    const response = await fetch(`${app.baseUrl}/api/browse/download/${ticket}`);
    return {
      frameOptions: response.headers.get("x-frame-options"),
      policy: response.headers.get("content-security-policy"),
    };
  };

  const image = await headersFor("shot.png");
  assert.equal(image.frameOptions, "DENY", "an image is drawn by an element, so nothing is reopened");
  assert.match(image.policy, /frame-ancestors 'none'/u);

  const html = await headersFor("report.html");
  assert.equal(html.frameOptions, "SAMEORIGIN");
  assert.match(html.policy, /frame-ancestors 'self'/u);
  // The whole of what makes serving HTML here safe: opaque origin, no script.
  assert.match(html.policy, /(^|; )sandbox$/u);
  assert.match(html.policy, /default-src 'none'/u);

  // A PDF is opened in a tab, not framed, so it needs no exception and gets
  // none. Browsers disagree about PDFs in frames -- Android Chrome draws
  // nothing there -- and a tab is not framing at all.
  const pdf = await headersFor("manual.pdf");
  assert.equal(pdf.frameOptions, "DENY");
  assert.match(pdf.policy, /frame-ancestors 'none'/u);
});

test("checks browse folders for changes without transferring full listings", async (context) => {
  const app = await startServer();
  context.after(() => closeServer(app.server));
  const directory = await fixture();

  const listing = await browse(app, directory).then((r) => r.json());
  assert.ok(listing.etag, "listing must include an etag");

  // When etag matches, returns changed: []
  const checkSame = await fetch(
    `${app.baseUrl}/api/browse/check?targets=${encodeURIComponent(JSON.stringify({ [directory]: listing.etag }))}`,
    { headers: { Origin: app.baseUrl } },
  ).then((r) => r.json());
  assert.deepEqual(checkSame.changed, []);

  // When a file is added, check detects it
  await writeFile(join(directory, "new-file.txt"), "hello");
  const checkChanged = await fetch(
    `${app.baseUrl}/api/browse/check?targets=${encodeURIComponent(JSON.stringify({ [directory]: listing.etag }))}`,
    { headers: { Origin: app.baseUrl } },
  ).then((r) => r.json());
  assert.deepEqual(checkChanged.changed, [directory]);
});

