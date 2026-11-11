import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { insideRoot, opensAsSite, siteBase, siteContentSecurityPolicy, siteContentType, siteOf, siteRelativePath } from "../src/site-preview.mjs";
import { defaultDataPaths, localProtectedPaths } from "../src/protected-paths.mjs";

test("a page's folder is served by path inside it and nowhere else", () => {
  assert.equal(siteRelativePath(""), "");
  assert.equal(siteRelativePath("css/site.css"), "css/site.css");
  assert.equal(siteRelativePath("./img//a%20b.png"), "img/a b.png");
  for (const bad of ["../secret", "a/../../b", "%2e%2e/x", "a%2Fb", "a\\b", "a%00b", "%E0%A4%A"]) {
    assert.equal(siteRelativePath(bad), null, bad);
  }
  assert.deepEqual(siteOf("/a/b/report.html"), { root: "/a/b", entry: "report.html" });
  assert.deepEqual(siteOf("/index.html"), { root: "/", entry: "index.html" });
  assert.equal(insideRoot("/a/b/c.css", "/a/b"), true);
  assert.equal(insideRoot("/a/bc/c.css", "/a/b"), false);
  assert.equal(insideRoot("/a/b", "/a/b"), true);
});

test("pages and Markdown open as sites; a page's files keep their types, the rest stay bytes", () => {
  assert.equal(opensAsSite("r.html"), true);
  assert.equal(opensAsSite("README.md"), true);
  assert.equal(opensAsSite("a.txt"), false);
  assert.equal(siteContentType("app.mjs"), "text/javascript; charset=utf-8");
  assert.equal(siteContentType("f.woff2"), "font/woff2");
  assert.equal(siteContentType("x.svg"), "image/svg+xml");
  assert.equal(siteContentType("Makefile"), "application/octet-stream");
  assert.equal(siteContentType("evil.exe"), "application/octet-stream");
});

test("a page draws without scripts unless allowed, held to its folder's URL unless the internet is", () => {
  const base = "http://h:1/api/browse/site/T/";
  const plain = siteContentSecurityPolicy(base);
  // No script: a page can show its files but cannot read one into a request.
  assert.match(plain, /script-src 'none'/u);
  assert.match(plain, /connect-src 'none'/u);
  assert.match(plain, /worker-src 'none'/u);
  assert.match(plain, /; sandbox$/u);
  assert.match(plain, /style-src http:\/\/h:1\/api\/browse\/site\/T\/ data: blob: 'unsafe-inline'/u);
  assert.match(plain, /img-src http:\/\/h:1\/api\/browse\/site\/T\/ data: blob:;/u);
  for (const directive of plain.split("; ").filter((d) => !d.startsWith("frame-ancestors"))) {
    assert.doesNotMatch(directive, /https:|'self'|\*/u, directive);
  }
  assert.match(plain, /form-action 'none'/u);
  // Scripts, when this browser allows them: still sandboxed, never same-origin, no downloads.
  const scripted = siteContentSecurityPolicy(base, { scripts: true });
  assert.match(scripted, /script-src http:\/\/h:1\/api\/browse\/site\/T\/ data: blob: 'unsafe-inline' 'unsafe-eval'/u);
  assert.match(scripted, /; sandbox allow-scripts$/u);
  assert.doesNotMatch(scripted, /allow-same-origin|allow-forms|allow-top-navigation|allow-popups|allow-downloads/u);
  const online = siteContentSecurityPolicy(base, { internet: true });
  assert.match(online, /img-src [^;]* https:;/u);
  assert.match(online, /script-src 'none'/u, "the internet alone runs no script");
});

test("only a plain host names a page's URL", () => {
  assert.equal(siteBase("127.0.0.1:38787", false, "T"), "http://127.0.0.1:38787/api/browse/site/T/");
  assert.equal(siteBase("box.tail.ts.net", true, "T"), "https://box.tail.ts.net/api/browse/site/T/");
  assert.equal(siteBase("[::1]:8080", false, "T"), "http://[::1]:8080/api/browse/site/T/");
  for (const bad of ["localhost:3000/;script-src *", "a b", "", undefined, "host;x"]) assert.equal(siteBase(bad, false, "T"), null, String(bad));
});

async function app(context) {
  const created = createHerdrHttpServer({ herdr: { async snapshot() { return {}; } }, csrfToken: "t", logger: { error() {} } });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));
  return `http://127.0.0.1:${created.server.address().port}`;
}

test("a site ticket serves the page, its folder's files, and nothing outside", async (context) => {
  const base = await app(context);
  const root = await mkdtemp(join(tmpdir(), "herdrabbit-site-"));
  const outside = await mkdtemp(join(tmpdir(), "herdrabbit-outside-"));
  await mkdir(join(root, "css"));
  await writeFile(join(root, "page.html"), '<link rel="stylesheet" href="css/site.css"><img src="a.png"><script src="app.js"></script>');
  await writeFile(join(root, "css", "site.css"), "body{color:red}");
  await writeFile(join(root, "app.js"), "document.title='ran'");
  await writeFile(join(root, "notes.md"), "# Notes\n\n![p](a.png)\n");
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
  const issue = (body) => fetch(`${base}/api/browse/tickets`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "t", Origin: base },
    body: JSON.stringify(body),
  });

  const issued = await (await issue({ path: join(root, "page.html"), view: true, site: true })).json();
  assert.match(issued.url, /^\/api\/browse\/site\/[A-Za-z0-9_-]+\/page\.html$/u);
  const page = await fetch(`${base}${issued.url}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  const policy = page.headers.get("content-security-policy");
  assert.match(policy, new RegExp(`img-src ${base}/api/browse/site/${issued.ticket}/ data: blob:;`, "u"));
  assert.match(policy, /script-src 'none'/u, "no script unless this browser allows it");
  assert.equal(page.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");

  const folder = `${base}/api/browse/site/${issued.ticket}`;
  const css = await fetch(`${folder}/css/site.css`);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(await css.text(), "body{color:red}");
  assert.equal((await fetch(`${folder}/`)).status, 200, "the folder itself is the page");
  // URL parsing turns %2e%2e into a climb before the request leaves: it lands
  // outside every site route, and nothing is served either way.
  const climbed = await fetch(`${folder}/%2e%2e/secret.txt`);
  assert.ok(climbed.status >= 400, `a climb out answered ${climbed.status}`);
  assert.equal((await fetch(`${folder}/a%2F..%2F..%2Fx`)).status, 404, "an escaped slash is not a path");
  assert.equal((await fetch(`${folder}/leak.txt`)).status, 404, "a link out of the folder is refused");
  assert.equal((await fetch(`${folder}/missing.png`)).status, 404);

  const scripted = await (await issue({ path: join(root, "page.html"), view: true, site: true, scripts: true })).json();
  assert.match((await fetch(`${base}${scripted.url}`)).headers.get("content-security-policy"), /sandbox allow-scripts$/u);

  // Given back when the viewer closes: the folder is gone with it.
  const revoke = await fetch(`${base}/api/browse/tickets/revoke`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "t", Origin: base }, body: JSON.stringify({ ticket: scripted.ticket }),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(`${base}${scripted.url}`)).status, 404);

  // The internet is the page's own choice from Settings, fixed when it is opened.
  const online = await (await issue({ path: join(root, "page.html"), view: true, site: true, internet: true })).json();
  assert.match((await fetch(`${base}${online.url}`)).headers.get("content-security-policy"), / https:/u);

  // Markdown is rendered, so its relative pictures resolve in the folder.
  const md = await (await issue({ path: join(root, "notes.md"), view: true, site: true })).json();
  const rendered = await fetch(`${base}${md.url}`);
  assert.equal(rendered.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await rendered.text(), /<img[^>]+src="a\.png"/u);

  // Only pages open as sites, and a site ticket is not a download ticket.
  assert.equal((await issue({ path: join(root, "app.js"), view: true, site: true })).status, 415);
  assert.equal((await fetch(`${base}/api/browse/download/${issued.ticket}`)).status, 404);
});

test("Markdown with its folder links and shows the files beside it, never a script or another origin's path", async () => {
  const { renderMarkdown } = await import("../src/markdown.mjs");
  const html = renderMarkdown("![a](img/a.png) [b](b.md) [c](javascript:alert(1)) ![d](/etc/x.png) ![e](//evil/x.png)", "n", { site: true });
  assert.match(html, /<img src="img\/a\.png"/u);
  assert.match(html, /<a href="b\.md">b<\/a>/u);
  assert.doesNotMatch(html, /javascript:|src="\/etc|src="\/\/evil/u);
  // without its folder, as before: relative paths stay text
  assert.doesNotMatch(renderMarkdown("![a](img/a.png)", "n"), /<img/u);
});

test("a protected file inside a page's folder is refused like anywhere else", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "herdrabbit-site-home-"));
  await mkdir(join(home, ".ssh"));
  await writeFile(join(home, ".ssh", "id_ed25519"), "key");
  await writeFile(join(home, "index.html"), "<p>home page</p>");
  const protectedPaths = localProtectedPaths({ env: { HOME: home }, home, data: defaultDataPaths(home) });
  const created = createHerdrHttpServer({ herdr: { async snapshot() { return {}; } }, csrfToken: "t", protectedPaths, logger: { error() {} } });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  context.after(() => new Promise((resolve) => created.server.close(resolve)));
  const base = `http://127.0.0.1:${created.server.address().port}`;
  const issued = await (await fetch(`${base}/api/browse/tickets`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "t", Origin: base },
    body: JSON.stringify({ path: join(home, "index.html"), view: true, site: true }),
  })).json();
  assert.equal((await fetch(`${base}${issued.url}`)).status, 200);
  const key = await fetch(`${base}/api/browse/site/${issued.ticket}/.ssh/id_ed25519`);
  assert.ok(key.status === 403 || key.status === 404, `a key in the page's folder answered ${key.status}`);
  assert.notEqual(await key.text(), "key");
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const asked = request({ host: "127.0.0.1", port: created.server.address().port, path: issued.url,
      headers: { Host: `127.0.0.1:${created.server.address().port}/;script-src *` } }, (answer) => { answer.resume(); resolve(answer.statusCode); });
    asked.on("error", reject);
    asked.end();
  });
  assert.notEqual(status, 200, "a Host that is not a plain host gets no page");
});

