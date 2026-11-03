import test from "node:test";
import assert from "node:assert/strict";
import { chatImageTarget, parseInline, renderMarkdown } from "../public/chat/markdown.js";
import { createTicketCache, ticketUrl, resolveImagePath } from "../public/chat/chat-images.js";
import {
  arrowAction, clampView, copySize, FIT, swipeStep, wrapIndex, zoomAt, zoomPercent,
} from "../public/chat/image-viewer.js";

const html = (source) => renderMarkdown(source);
const imageOf = (source) => /<span class="md-image" data-image="([^"]*)"/u.exec(html(source))?.[1] ?? null;

// --- Which `![](…)` targets name a local image -------------------------------

test("a local image target is the path it names, decoded once, without query or anchor", () => {
  assert.equal(chatImageTarget("shot.png"), "shot.png");
  assert.equal(chatImageTarget("./out/chart.svg"), "./out/chart.svg");
  assert.equal(chatImageTarget("../shared/a.JPEG"), "../shared/a.JPEG");
  assert.equal(chatImageTarget("/home/me/proj/diagram.webp"), "/home/me/proj/diagram.webp");
  assert.equal(chatImageTarget("  docs/a.gif  "), "docs/a.gif");
  assert.equal(chatImageTarget("my%20shot.png"), "my shot.png");
  assert.equal(chatImageTarget("a%23b.png"), "a#b.png");
  assert.equal(chatImageTarget("a.png?raw=1"), "a.png");
  assert.equal(chatImageTarget("a.png#top"), "a.png");
  assert.equal(chatImageTarget("file:///tmp/plot.png"), "/tmp/plot.png");
  assert.equal(chatImageTarget("file:///tmp/my%20plot.png"), "/tmp/my plot.png");
});

test("anything that is not a local image file is refused", () => {
  for (const refused of [
    "", "   ", "#anchor",
    // remote and inline addresses never load: the chat shows only local files
    "https://example.com/a.png", "http://127.0.0.1:7317/api/browse/download/x.png", "HTTPS://x.dev/a.png",
    "//example.com/a.png", "data:image/png;base64,iVBORw0KGgo=", "javascript:alert(1)//.png",
    "blob:https://x.dev/1.png", "file://host/a.png", "file:///tmp/a.png?x=1",
    // a home or another machine's path cannot be resolved here
    "~/a.png", "~me/a.png", "C:\\pics\\a.png", "C:/pics/a.png", "pics\\a.png", "/a\u0000b.png", "a%00.png",
    "%E0%A4%A.png",
    // not an image: the file viewer would not draw it as one
    "notes.txt", "page.html", "report.pdf", "clip.mp4", "folder/", "a.png/",
  ]) {
    assert.equal(chatImageTarget(refused), null, JSON.stringify(refused));
  }
});

test("a local image becomes a placeholder that holds its plain fallback", () => {
  assert.equal(imageOf("![](shot.png)"), "shot.png");
  assert.equal(imageOf("see ![chart](./out/chart.png) here"), "./out/chart.png");
  const out = html("![The chart](out/chart.png)");
  assert.match(out, /^<p><span class="md-image" data-image="out\/chart\.png" data-alt="The chart">/u);
  // the fallback is what the image is when it cannot be drawn: its words, no `!`
  assert.match(out, /data-alt="The chart">The chart \(<code>out\/chart\.png<\/code>\)<\/span><\/p>$/u);
  // with nothing to say, the fallback is the path
  assert.match(html("![](shot.png)"), /data-alt=""><code>shot\.png<\/code><\/span>/u);
  // a path the page can open stays a button in the fallback
  const linked = renderMarkdown("![](shot.png)", { isLinkablePath: () => true });
  assert.match(linked, /<span class="md-image" data-image="shot\.png" data-alt=""><button type="button" class="md-file" data-path="shot\.png"/u);
  // nothing the agent wrote reaches an attribute unescaped
  const quoted = html('![a"b<c>](x%22y.png)');
  assert.match(quoted, /data-image="x&quot;y\.png" data-alt="a&quot;b&lt;c&gt;"/u);
  assert.doesNotMatch(quoted, /<img|src=/u);
  assert.equal(parseInline("![](a.png)")[0].path, "a.png");
});

test("an empty link without `!` is still text, and an image in a link label is only its words", () => {
  assert.equal(html("[](a.png)"), "<p>[](a.png)</p>");
  assert.doesNotMatch(html("[![](a.png)](https://x.dev)"), /md-image/u);
});

test("a remote image keeps what markdown.js did before: a link to it, never a picture", () => {
  const out = html("![logo](https://example.com/logo.png)");
  assert.equal(out, '<p>!<a href="https://example.com/logo.png" target="_blank" rel="noopener noreferrer">logo</a></p>');
  assert.equal(imageOf("![x](javascript:alert(1))"), null);
  assert.doesNotMatch(html("![x](data:image/png;base64,AAAA)"), /md-image|<img|href="data/u);
  assert.equal(imageOf("![notes](notes.txt)"), null);
});

// --- Where a placeholder's image comes from ---------------------------------

test("a path is resolved against the pane's folder the way path links are", () => {
  assert.equal(resolveImagePath("/a/b.png", null), "/a/b.png");
  assert.equal(resolveImagePath("shot.png", "/work/proj"), "/work/proj/shot.png");
  assert.equal(resolveImagePath("./img/a.png", "/work/proj/"), "/work/proj/img/a.png");
  assert.equal(resolveImagePath("../a.png", "/work/proj"), "/work/a.png");
  assert.equal(resolveImagePath("../../../a.png", "/work"), "/a.png");
  assert.equal(resolveImagePath("/a/./b/../c.png", null), "/a/c.png");
  assert.equal(resolveImagePath("my shot.png", "/w"), "/w/my shot.png");
  // a relative path with no folder to go on, or a folder that is not absolute, has no file
  for (const cwd of [null, undefined, "", "relative/dir", "~/proj", 7]) assert.equal(resolveImagePath("a.png", cwd), null, String(cwd));
  for (const bad of ["", "a.txt", "~/a.png", "https://x.dev/a.png", null, 3]) assert.equal(resolveImagePath(bad, "/w"), null, String(bad));
});

test("the image URL is the file route's ticket URL, and only for a well-formed ticket", () => {
  const ticket = "A".repeat(43);
  assert.equal(ticketUrl(ticket), `/api/browse/download/${ticket}`);
  assert.equal(ticketUrl("abc_-0123456789xyz"), "/api/browse/download/abc_-0123456789xyz");
  for (const bad of ["", "short", "A".repeat(87), "../../etc/passwd", "a/b".padEnd(20, "x"), "x".repeat(20) + "?y", null, undefined, 42, "https://evil.example/".padEnd(30, "a")]) {
    assert.equal(ticketUrl(bad), null, String(bad));
  }
});

test("view tickets are asked for once per file while they last, and a refusal is not kept", async () => {
  let now = 0;
  const asked = [];
  let refuse = false;
  const cache = createTicketCache(async (server, path) => {
    asked.push(`${server} ${path}`);
    if (refuse) throw Object.assign(new Error("Protected"), { status: 403 });
    return `ticket${asked.length}`.padEnd(20, "x");
  }, { ttlMs: 1000, now: () => now });
  const first = await cache.get("local", "/w/a.png");
  assert.equal(await cache.get("local", "/w/a.png"), first);
  assert.notEqual(await cache.get("link_1", "/w/a.png"), first, "another machine's file is another ticket");
  assert.equal(asked.length, 2);
  now = 1000;
  assert.notEqual(await cache.get("local", "/w/a.png"), first, "an expired ticket is asked for again");
  assert.equal(asked.length, 3);
  refuse = true;
  await assert.rejects(cache.get("local", "/w/secret.png"), /Protected/u);
  refuse = false;
  await cache.get("local", "/w/secret.png");
  assert.equal(asked.length, 5, "a failure is asked again next time");
  cache.forget("local", "/w/secret.png");
  await cache.get("local", "/w/secret.png");
  assert.equal(asked.length, 6);
});

test("the chat holds at most a set number of tickets, leaving the rest of the server's for downloads", async () => {
  let now = 0;
  let asked = 0;
  const cache = createTicketCache(async () => `ticket${++asked}`.padEnd(20, "x"), { ttlMs: 1000, now: () => now, max: 2 });
  await cache.get("local", "/w/1.png");
  await cache.get("local", "/w/2.png");
  await assert.rejects(cache.get("local", "/w/3.png"), /Too many images/u);
  assert.equal(asked, 2, "the server was not asked for the third");
  await cache.get("local", "/w/1.png");
  assert.equal(asked, 2, "one already held is still given");
  now = 1000;
  await cache.get("local", "/w/3.png");
  assert.equal(asked, 3, "once the others expire there is room again");
});

// --- The full-screen viewer's arithmetic -----------------------------------

test("stepping through the chat's images wraps at both ends", () => {
  assert.equal(wrapIndex(0, 3), 0);
  assert.equal(wrapIndex(3, 3), 0);
  assert.equal(wrapIndex(-1, 3), 2);
  assert.equal(wrapIndex(-4, 3), 2);
  assert.equal(wrapIndex(5, 0), 0);
});

test("zooming keeps the point under the pointer where it was, within 1x-8x", () => {
  const view = zoomAt(FIT, 2, { x: 100, y: -50 });
  assert.deepEqual(view, { scale: 2, x: -100, y: 50 });
  // the point 100,-50 from the centre is still at 100,-50 after the zoom
  assert.equal(view.x + 100 * view.scale, 100);
  assert.equal(view.y + -50 * view.scale, -50);
  const back = zoomAt(view, 0.5, { x: 100, y: -50 });
  assert.deepEqual(back, FIT);
  assert.equal(zoomAt(FIT, 100, { x: 0, y: 0 }).scale, 8);
  assert.deepEqual(zoomAt(FIT, 0.1, { x: 40, y: 40 }), FIT, "never smaller than fit");
  assert.equal(zoomPercent(FIT), 100);
  assert.equal(zoomPercent({ scale: 2.456 }), 246);
});

test("a zoomed image pans only as far as its edges, and at fit it stays centred", () => {
  const fitted = { width: 400, height: 300 };
  const stage = { width: 400, height: 600 };
  assert.deepEqual(clampView({ scale: 1, x: 50, y: -20 }, fitted, stage), FIT);
  // 800 wide over 400: 200 either way; 600 tall in 600: none
  assert.deepEqual(clampView({ scale: 2, x: 500, y: 90 }, fitted, stage), { scale: 2, x: 200, y: 0 });
  assert.deepEqual(clampView({ scale: 2, x: -500, y: 0 }, fitted, stage), { scale: 2, x: -200, y: 0 });
  assert.deepEqual(clampView({ scale: 3, x: 0, y: 1000 }, fitted, stage), { scale: 3, x: 0, y: 150 });
});

test("a swipe at fit steps to the next or previous image; a zoomed one pans instead", () => {
  assert.equal(swipeStep(-80, 5, false), 1);
  assert.equal(swipeStep(80, -10, false), -1);
  assert.equal(swipeStep(30, 0, false), 0, "too short");
  assert.equal(swipeStep(-80, 70, false), 0, "more down than across");
  assert.equal(swipeStep(-200, 0, true), 0, "zoomed: that was a pan");
});

test("arrow keys step at fit and pan when zoomed", () => {
  assert.deepEqual(arrowAction("ArrowRight", false, 3), { step: 1 });
  assert.deepEqual(arrowAction("ArrowLeft", false, 3), { step: -1 });
  assert.equal(arrowAction("ArrowRight", false, 1), null, "one image: nowhere to step");
  assert.equal(arrowAction("ArrowUp", false, 3), null);
  assert.deepEqual(arrowAction("ArrowRight", true, 3), { pan: { x: -48, y: 0 } });
  assert.deepEqual(arrowAction("ArrowUp", true, 1), { pan: { x: 0, y: 48 } });
  assert.equal(arrowAction("Enter", true, 3), null);
});

test("Copy draws the picture at its own size, a huge one smaller and an unsized SVG at 1024", () => {
  assert.deepEqual(copySize({ width: 640, height: 360 }, { width: 320, height: 180 }), { width: 640, height: 360 });
  assert.deepEqual(copySize({ width: 10000, height: 5000 }, { width: 400, height: 200 }), { width: 4096, height: 2048 });
  assert.deepEqual(copySize({ width: 0, height: 0 }, { width: 300, height: 150 }), { width: 1024, height: 512 });
  assert.deepEqual(copySize({ width: 0, height: 0 }, { width: 0, height: 0 }), { width: 1024, height: 1024 });
});
