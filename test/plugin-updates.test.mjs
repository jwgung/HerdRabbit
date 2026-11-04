import test from "node:test";
import assert from "node:assert/strict";
import { PluginMarketplace, cleanMarketplace, pluginUpdateAvailable } from "../src/plugin-marketplace.mjs";
import { cleanPluginState } from "../src/herdr-plugins.mjs";
import { fakeFetch, marketplaceIndex } from "./fixtures/fake-plugin-marketplace.mjs";

// The fixture's repositories are all at this commit.
const HEAD = "ad4614fcee1a9049a08ea9ca421889b9ce6966f8";
const OLD = "1234567890abcdef1234567890abcdef12345678";

// One plugin as `herdr plugin list --json` names it, cleaned as the server does.
function installed({ id = "notes", owner = "someone", repo = "herdr-notes", subdir, ref = null, commit = OLD, kind = "github" } = {}) {
  const source = kind === "github"
    ? { kind, owner, repo, ...(subdir ? { subdir } : {}), requested_ref: ref, resolved_commit: commit }
    : { kind, path: "/home/me/tool" };
  return cleanPluginState({ plugins: [{ plugin_id: id, name: id, enabled: true, source }] }).plugins[0];
}

const { heads } = cleanMarketplace(marketplaceIndex());

test("a plugin on its default branch is behind when the index's head commit differs", () => {
  assert.equal(pluginUpdateAvailable(installed(), heads), true);
  assert.equal(pluginUpdateAvailable(installed({ commit: HEAD }), heads), false);
  // an abbreviated commit is compared as a prefix
  assert.equal(pluginUpdateAvailable(installed({ commit: HEAD.slice(0, 12) }), heads), false);
  // owner and repository are matched without case, as GitHub does
  assert.equal(pluginUpdateAvailable(installed({ owner: "SomeOne", repo: "Herdr-Notes" }), heads), true);
});

test("a manifest is matched by its id or its folder", () => {
  assert.equal(pluginUpdateAvailable(installed({ id: "annotate-links", owner: "annotate-dev", repo: "annotate", subdir: "links" }), heads), true);
  assert.equal(pluginUpdateAvailable(installed({ id: "renamed", owner: "annotate-dev", repo: "annotate", subdir: "links" }), heads), true);
  assert.equal(pluginUpdateAvailable(installed({ id: "zenbu-labs.terminal-browser", owner: "zenbu-labs", repo: "terminal-browser" }), heads), true);
  // neither its id nor its folder is in the repository's entry
  assert.equal(pluginUpdateAvailable(installed({ id: "elsewhere", owner: "annotate-dev", repo: "annotate", subdir: "other" }), heads), null);
  // the repository is not in the index
  assert.equal(pluginUpdateAvailable(installed({ owner: "nobody", repo: "nothing" }), heads), null);
});

test("a pinned ref, a linked plugin, HerdRabbit, no commit or no index tell nothing", () => {
  assert.equal(pluginUpdateAvailable(installed({ ref: "main" }), heads), null, "the index does not name the default branch");
  assert.equal(pluginUpdateAvailable(installed({ ref: "v0.2.0" }), heads), null);
  assert.equal(pluginUpdateAvailable(installed({ kind: "local" }), heads), null);
  assert.equal(pluginUpdateAvailable(installed({ id: "herdrabbit", owner: "jwgung", repo: "HerdRabbit" }), heads), null);
  assert.equal(pluginUpdateAvailable(installed({ commit: null }), heads), null);
  assert.equal(pluginUpdateAvailable(installed(), null), null);
});

test("a ref equal to the default branch the index names is compared", () => {
  const index = marketplaceIndex();
  index.plugins[1].defaultBranch = "main";
  const named = cleanMarketplace(index).heads;
  assert.equal(pluginUpdateAvailable(installed({ ref: "main" }), named), true);
  assert.equal(pluginUpdateAvailable(installed({ ref: "dev" }), named), null);
  // a head commit that is not a full commit is not compared
  index.plugins[1].headCommit = "abc";
  assert.equal(pluginUpdateAvailable(installed(), cleanMarketplace(index).heads), null);
});

test("updatesFor marks each plugin, and a marketplace that cannot be read leaves them at null", async () => {
  const plugins = [installed(), installed({ id: "pinned", ref: "v1" }), installed({ id: "tool", kind: "local" })];
  const read = await new PluginMarketplace({ fetch: fakeFetch().fetch }).updatesFor(plugins);
  assert.deepEqual(read.map((item) => [item.id, item.updateAvailable]), [["notes", true], ["pinned", null], ["tool", null]]);
  const down = await new PluginMarketplace({ fetch: fakeFetch({}, { status: 503 }).fetch }).updatesFor(plugins);
  assert.deepEqual(down.map((item) => item.updateAvailable), [null, null, null]);
  const thrown = await new PluginMarketplace({ fetch: fakeFetch(new Error("offline")).fetch }).updatesFor(plugins);
  assert.deepEqual(thrown.map((item) => item.updateAvailable), [null, null, null]);
});

test("updatesFor does not wait long for a slow index, and does not trust a stale copy", async () => {
  const slow = fakeFetch(undefined, { hold: true });
  const market = new PluginMarketplace({ fetch: slow.fetch });
  const answer = await market.updatesFor([installed()], { waitMs: 10 });
  assert.equal(answer[0].updateAvailable, null);
  slow.release();
  await market.catalog();
  assert.equal((await market.updatesFor([installed()]))[0].updateAvailable, true, "the read went on for the next look");

  const time = { now: 0 };
  let fail = false;
  const fetch = async (...args) => (fail ? new Response("", { status: 503 }) : fakeFetch().fetch(...args));
  const stale = new PluginMarketplace({ fetch, now: () => time.now });
  assert.equal((await stale.updatesFor([installed()]))[0].updateAvailable, true);
  fail = true;
  time.now += 11 * 60_000;
  assert.equal((await stale.catalog()).stale, true);
  assert.equal((await stale.updatesFor([installed()]))[0].updateAvailable, null);
});
