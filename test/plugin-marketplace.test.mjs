import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKETPLACE_URL, PluginMarketplace, cleanMarketplace, marketplaceQuery,
} from "../src/plugin-marketplace.mjs";
import { validatePluginSource } from "../src/herdr-plugins.mjs";
import { fakeFetch, marketplaceIndex } from "./fixtures/fake-plugin-marketplace.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const unavailable = (pattern) => ({ status: 502, code: "marketplace_unavailable", message: pattern });

function clock(start = Date.parse("2026-11-04T00:00:00Z")) {
  const time = { now: start };
  return { time, now: () => time.now };
}

test("each listing is one plugin manifest, cleaned, with a source an install takes", () => {
  const { generatedAt, entries } = cleanMarketplace(marketplaceIndex());
  assert.equal(generatedAt, "2026-11-03T21:00:33.655Z");
  const items = entries.map((entry) => entry.item);
  assert.deepEqual(items.map((item) => item.spec), [
    "zenbu-labs/terminal-browser/herdr-plugin", "someone/herdr-notes", "annotate-dev/annotate",
    "annotate-dev/annotate/links", "jwgung/HerdRabbit", "ok/tricks/ok",
  ]);
  for (const item of items) assert.equal(validatePluginSource(item.spec).spec, item.spec);
  assert.deepEqual(items[0], {
    owner: "zenbu-labs", repo: "terminal-browser", subdir: "herdr-plugin", spec: "zenbu-labs/terminal-browser/herdr-plugin",
    name: "Terminal Browser", id: "zenbu-labs.terminal-browser", version: "0.1.1", description: "Open a browser inside herdr",
    stars: 4403, starsThisWeek: 127, pushedAt: "2026-11-03T20:48:08.000Z", listedAt: "2026-08-11T04:31:10.754Z",
    platforms: ["linux", "macos"], minHerdrVersion: "0.8.2",
    url: "https://github.com/zenbu-labs/terminal-browser/tree/HEAD/herdr-plugin", protected: false,
  });
  // Text loses control, direction and invisible characters; a manifest without a
  // description takes the repository's.
  assert.equal(items[2].description, "Comment on selections");
  assert.equal(items[3].description, "Ctrl-click links in Annotate");
  // HerdRabbit is listed, protected: it is never installed from here.
  assert.equal(items[4].protected, true);
  // Bad numbers, versions, times and platforms are dropped, not passed on;
  // the link is built from owner/repo, never the index's own URL.
  assert.deepEqual(items[5], {
    owner: "ok", repo: "tricks", subdir: "ok", spec: "ok/tricks/ok", name: "tricks", id: "tricks", version: null,
    description: null, stars: 0, starsThisWeek: 0, pushedAt: null, listedAt: "2026-08-01T00:00:00.000Z",
    platforms: ["linux"], minHerdrVersion: null, url: "https://github.com/ok/tricks/tree/HEAD/ok", protected: false,
  });
});

test("an index in another schema, or without a plugin list, is refused", () => {
  assert.throws(() => cleanMarketplace({ ...marketplaceIndex(), schemaVersion: 2 }), unavailable(/schema 2/u));
  assert.throws(() => cleanMarketplace({ schemaVersion: 1, plugins: {} }), unavailable(/no plugin list/u));
  assert.throws(() => cleanMarketplace(null), unavailable(/schema none/u));
});

test("reads Herdr's index with the global fetch's options, and pages, searches and sorts it", async () => {
  const fake = fakeFetch();
  const market = new PluginMarketplace({ fetch: fake.fetch });
  const page = await market.page({ sort: "popular", offset: 0, limit: 2 });
  assert.equal(fake.calls[0].url, MARKETPLACE_URL);
  assert.ok(fake.calls[0].options.signal instanceof AbortSignal);
  assert.equal(fake.calls[0].options.redirect, "error");
  assert.equal(page.total, 6);
  assert.equal(page.generatedAt, "2026-11-03T21:00:33.655Z");
  assert.equal(page.stale, undefined);
  assert.deepEqual(page.items.map((item) => item.id), ["zenbu-labs.terminal-browser", "annotate"]);
  const ids = async (query) => (await market.page(query)).items.map((item) => item.id);
  assert.deepEqual(await ids({ sort: "popular", offset: 2, limit: 2 }), ["annotate-links", "notes"]);
  assert.deepEqual(await ids({ sort: "name" }), ["annotate", "annotate-links", "herdrabbit", "notes", "zenbu-labs.terminal-browser", "tricks"]);
  assert.deepEqual((await ids({ sort: "recent" })).slice(0, 3), ["zenbu-labs.terminal-browser", "annotate", "annotate-links"]);
  assert.deepEqual((await ids({ sort: "newest" }))[0], "notes");
  // Trending is Herdr's: growth this week, from 10 new stars.
  assert.deepEqual((await ids({ sort: "trending" })).slice(0, 2), ["notes", "zenbu-labs.terminal-browser"]);
  // Every word must match: name, id, owner/repo, description, language, topic.
  assert.deepEqual(await ids({ q: "annotate links" }), ["annotate-links"]);
  assert.deepEqual(await ids({ q: "browser" }), ["zenbu-labs.terminal-browser"]);
  assert.deepEqual(await ids({ q: "rust someone" }), ["notes"]);
  assert.deepEqual(await ids({ q: "nothing-like-this" }), []);
  assert.equal(fake.calls.length, 1, "the index is read once and kept");
});

test("the query from the URL is bounded", () => {
  const query = (text) => marketplaceQuery(new URLSearchParams(text));
  assert.deepEqual(query(""), { q: "", sort: "popular", offset: 0, limit: 50 });
  assert.deepEqual(query("q=%20Notes%20&sort=stars&offset=50&limit=100"), { q: "notes", sort: "popular", offset: 50, limit: 100 });
  assert.equal(query("sort=updated").sort, "recent");
  for (const bad of ["sort=random", "limit=0", "limit=101", "offset=-1", "offset=1e3", "limit=abc", `q=${"x".repeat(101)}`]) {
    assert.throws(() => query(bad), { status: 400, code: "invalid_input" }, bad);
  }
});

test("an index larger than the cap is refused while it arrives, and by its length", async () => {
  const big = JSON.stringify({ ...marketplaceIndex(), padding: "x".repeat(4096) });
  const streamed = new PluginMarketplace({ fetch: fakeFetch(big).fetch, maxBytes: 2048 });
  await assert.rejects(streamed.catalog(), unavailable(/larger than/u));
  let pulled = 0;
  const endless = new PluginMarketplace({
    maxBytes: 4096,
    fetch: async () => new Response(new ReadableStream({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024)); },
    })),
  });
  await assert.rejects(endless.catalog(), unavailable(/larger than/u));
  assert.ok(pulled < 10, `read ${pulled} chunks past the cap`);
  const declared = new PluginMarketplace({ fetch: fakeFetch("{}", { headers: { "Content-Length": "999999" } }).fetch, maxBytes: 1024 });
  await assert.rejects(declared.catalog(), unavailable(/larger than/u));
});

test("a slow, failing, or unreadable answer is a readable 502", async () => {
  const slow = new PluginMarketplace({
    timeoutMs: 20,
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  await assert.rejects(slow.catalog(), unavailable(/took too long.*Install plugin…/u));
  // A body that never ends is stopped by the same timeout.
  const stuck = new PluginMarketplace({
    timeoutMs: 20, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1)); } })),
  });
  await assert.rejects(stuck.catalog(), unavailable(/took too long/u));
  await assert.rejects(new PluginMarketplace({ fetch: fakeFetch({}, { status: 503 }).fetch }).catalog(), unavailable(/HTTP 503/u));
  await assert.rejects(new PluginMarketplace({ fetch: fakeFetch("<html>").fetch }).catalog(), unavailable(/not JSON/u));
  await assert.rejects(new PluginMarketplace({ fetch: fakeFetch(new TypeError("fetch failed")).fetch }).catalog(), unavailable(/could not be reached/u));
});

test("kept ten minutes; a failed read serves the copy marked stale, and waits before trying again", async () => {
  const { time, now } = clock();
  let answer = marketplaceIndex();
  let calls = 0;
  const market = new PluginMarketplace({
    now,
    fetch: async () => {
      calls += 1;
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer));
    },
  });
  const first = await market.page();
  assert.equal(first.fetchedAt, "2026-11-04T00:00:00.000Z");
  time.now += 9 * 60_000;
  await market.page();
  assert.equal(calls, 1);
  time.now += 2 * 60_000;
  answer = new Error("offline");
  const stale = await market.page();
  assert.equal(calls, 2);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, "2026-11-04T00:00:00.000Z");
  assert.equal(stale.total, 6);
  // Not tried again for 30 seconds.
  time.now += 10_000;
  assert.equal((await market.page()).stale, true);
  assert.equal(calls, 2);
  time.now += 30_000;
  answer = { ...marketplaceIndex(), plugins: marketplaceIndex().plugins.slice(0, 1) };
  const fresh = await market.page();
  assert.equal(calls, 3);
  assert.equal(fresh.stale, undefined);
  assert.equal(fresh.total, 1);
  assert.equal(fresh.fetchedAt, new Date(time.now).toISOString());
});

test("with no copy a failure is the error, and is not retried at once", async () => {
  const { time, now } = clock();
  const fake = fakeFetch({}, { status: 500 });
  const market = new PluginMarketplace({ fetch: fake.fetch, now });
  await assert.rejects(market.catalog(), unavailable(/HTTP 500/u));
  await assert.rejects(market.catalog(), unavailable(/HTTP 500/u));
  assert.equal(fake.calls.length, 1);
  time.now += 31_000;
  await assert.rejects(market.catalog(), unavailable(/HTTP 500/u));
  assert.equal(fake.calls.length, 2);
});

test("one read at a time: callers meanwhile share it", async () => {
  const fake = fakeFetch(marketplaceIndex(), { hold: true });
  const market = new PluginMarketplace({ fetch: fake.fetch });
  const pages = [market.page(), market.page({ sort: "name" }), market.page({ q: "notes" })];
  await settle();
  assert.equal(fake.calls.length, 1);
  fake.release();
  const [popular, byName, found] = await Promise.all(pages);
  assert.equal(popular.total, 6);
  assert.equal(byName.items[0].id, "annotate");
  assert.equal(found.total, 1);
  assert.equal(fake.calls.length, 1);
});
