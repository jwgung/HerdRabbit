import test from "node:test";
import assert from "node:assert/strict";
import {
  marketplaceDetails, marketplaceInstalled, marketplaceSummary, marketplaceUrl, timeAgo,
  pluginLogSummary, pluginTarget, pluginTargetText, pluginWorkspaces,
  parsePluginSource, pluginMachines, pluginOperationText, pluginSourceText, pluginSourceUrl, validPluginRef,
} from "../public/app/plugin-model.js";
import { validatePluginRef, validatePluginSource } from "../src/herdr-plugins.mjs";

test("a typed or pasted source becomes owner/repo[/folder] and its GitHub address", () => {
  assert.deepEqual(parsePluginSource(" someone/herdr-notes "),
    { owner: "someone", repo: "herdr-notes", subdir: null, spec: "someone/herdr-notes", url: "https://github.com/someone/herdr-notes" });
  assert.equal(parsePluginSource("https://github.com/someone/herdr-notes.git").spec, "someone/herdr-notes");
  assert.equal(parsePluginSource("github.com/someone/herdr-notes/").spec, "someone/herdr-notes");
  assert.deepEqual(parsePluginSource("https://github.com/org/mono/tree/main/plugins/x"),
    { owner: "org", repo: "mono", subdir: "plugins/x", spec: "org/mono/plugins/x", url: "https://github.com/org/mono" });
  for (const bad of ["", "someone", "a b/c", "-a/b", "a/..", "a/b/../c", "https://gitlab.com/a/b", "a/b;c"]) {
    assert.equal(parsePluginSource(bad), null, bad);
  }
});

test("what the page sends is what the server takes", () => {
  for (const typed of ["a/b", "org-1/mono.repo/plugins/notes", "https://github.com/a/b.git"]) {
    const parsed = parsePluginSource(typed);
    assert.equal(validatePluginSource(parsed.spec).spec, parsed.spec);
  }
  for (const ref of ["", "main", "v1.2.3", "feature/x"]) {
    assert.equal(validPluginRef(ref), true);
    assert.doesNotThrow(() => validatePluginRef(ref));
  }
  for (const ref of ["-x", "a b", "a..b", "a.lock", "/a", "a~1"]) {
    assert.equal(validPluginRef(ref), false, ref);
    assert.throws(() => validatePluginRef(ref));
  }
});

test("a plugin's source reads owner/repo@ref, or how it was installed", () => {
  const github = { source: { kind: "github", owner: "someone", repo: "notes", subdir: null, ref: "main", commit: "1234567890" } };
  assert.equal(pluginSourceText(github), "someone/notes@main");
  assert.equal(pluginSourceText({ source: { ...github.source, ref: null } }), "someone/notes@1234567");
  assert.equal(pluginSourceText({ source: { ...github.source, subdir: "p/x" } }), "someone/notes/p/x@main");
  assert.equal(pluginSourceUrl(github), "https://github.com/someone/notes");
  assert.equal(pluginSourceText({ source: { kind: "local" } }), "Linked from a folder");
  assert.equal(pluginSourceUrl({ source: { kind: "local" } }), null);
  assert.equal(pluginSourceText({ source: null }), "Unknown source");
});

test("a change reads as it goes and as it ended", () => {
  const plugins = [{ id: "notes", name: "Notes" }];
  assert.equal(pluginOperationText(null), null);
  assert.deepEqual(pluginOperationText({ action: "disable", plugin: "notes", state: "running" }, plugins),
    { text: "Turning off Notes…", error: false, running: true });
  assert.deepEqual(pluginOperationText({ action: "install", plugin: "a/b", ref: "v1", state: "running" }),
    { text: "Installing a/b@v1… This can take a few minutes.", error: false, running: true });
  assert.equal(pluginOperationText({ action: "update", plugin: "notes", state: "succeeded" }, plugins).text, "Updated Notes.");
  assert.deepEqual(pluginOperationText({ action: "uninstall", plugin: "notes", state: "failed", detail: "busy" }, plugins),
    { text: "Couldn't uninstall Notes: busy", error: true, running: false });
});

test("the machines are this PC, then each connected PC", () => {
  assert.deepEqual(pluginMachines([
    { id: "local", machine: "desk", transport: "local" },
    { id: "link_1", name: "Laptop", transport: "link" },
    { id: "ssh", name: "Old", transport: "ssh" },
  ]), [{ id: "local", name: "This PC (desk)" }, { id: "link_1", name: "Laptop" }]);
  assert.deepEqual(pluginMachines([]), [{ id: "local", name: "This PC" }]);
});

const NOW = Date.parse("2026-11-04T00:00:00Z");
const listing = {
  owner: "zenbu-labs", repo: "terminal-browser", subdir: "herdr-plugin", spec: "zenbu-labs/terminal-browser/herdr-plugin",
  id: "zenbu-labs.terminal-browser", name: "Terminal Browser", stars: 4403, starsThisWeek: 127,
  pushedAt: "2026-11-01T00:00:00Z", platforms: ["linux", "macos"], minHerdrVersion: "0.8.2",
  url: "https://github.com/zenbu-labs/terminal-browser/tree/HEAD/herdr-plugin",
};

test("a marketplace listing links only to its GitHub repository or folder", () => {
  assert.equal(marketplaceUrl(listing), listing.url);
  assert.equal(marketplaceUrl({ url: "https://github.com/a/b" }), "https://github.com/a/b");
  for (const url of ["javascript:alert(1)", "http://github.com/a/b", "https://github.com.evil/a/b", "https://github.com/a",
    "https://github.com/a/b/tree/HEAD/../x", "https://github.com/a/b?x=1", "https://github.com/a/b/blob/HEAD/x", null]) {
    assert.equal(marketplaceUrl({ url }), null, String(url));
  }
});

test("a listing is installed when its id or its repository and folder are", () => {
  const github = (owner, repo, subdir = null) => ({ id: "other", source: { kind: "github", owner, repo, subdir } });
  assert.equal(marketplaceInstalled(listing, [{ id: "zenbu-labs.terminal-browser", source: { kind: "local" } }]), true);
  assert.equal(marketplaceInstalled(listing, [github("Zenbu-Labs", "Terminal-Browser", "herdr-plugin")]), true);
  assert.equal(marketplaceInstalled(listing, [github("zenbu-labs", "terminal-browser")]), false);
  assert.equal(marketplaceInstalled({ ...listing, subdir: null, id: "x" }, [github("zenbu-labs", "terminal-browser")]), true);
  assert.equal(marketplaceInstalled(listing, []), false);
});

test("a listing's details and the list's summary read as sentences", () => {
  assert.equal(timeAgo("2026-11-03T23:59:30Z", NOW), "just now");
  assert.equal(timeAgo("2026-11-03T23:00:00Z", NOW), "1 hour ago");
  assert.equal(timeAgo("2026-10-01T00:00:00Z", NOW), "1 month ago");
  assert.equal(timeAgo("nonsense", NOW), null);
  assert.equal(marketplaceDetails(listing, NOW),
    "★ 4,403 · +127 this week · updated 3 days ago · linux, macos · needs Herdr 0.8.2 or later");
  assert.equal(marketplaceDetails({ stars: 0 }, NOW), "★ 0");
  assert.equal(marketplaceSummary({ total: 2042, generatedAt: "2026-11-03T21:00:00Z" }, "", NOW),
    "2,042 plugins, listed by Herdr 3 hours ago.");
  assert.equal(marketplaceSummary({ total: 1, generatedAt: null }, "notes", NOW), '1 plugin matches "notes".');
  assert.equal(marketplaceSummary({ total: 0 }, "zzz", NOW), 'No plugins in Herdr\'s marketplace match "zzz".');
  assert.equal(marketplaceSummary({ total: 3, stale: true, fetchedAt: "2026-11-03T22:00:00Z" }, "", NOW),
    "3 plugins. Herdr's marketplace could not be read just now; this list was read 2 hours ago.");
});

test("a plugin's actions run and panes open for the pane on show when it is on that machine", () => {
  const records = {
    workspaces: [{ workspace_id: "w1", label: "Platform" }, { workspace_id: "link_1!w2", label: "Laptop work" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", server_id: "local" },
      { pane_id: "link_1!w2:p1", workspace_id: "link_1!w2" },
    ],
  };
  assert.deepEqual(pluginTarget(records, "w1:p1", "local"), { paneId: "w1:p1", workspace: "Platform", workspaceId: "w1", shown: true });
  assert.deepEqual(pluginTarget(records, "link_1!w2:p1", "link_1"), { paneId: "link_1!w2:p1", workspace: "Laptop work", workspaceId: "link_1!w2", shown: true });
  assert.equal(pluginTarget(records, "w1:p1", "link_1"), null);
  assert.equal(pluginTarget(records, "link_1!w2:p1", "local"), null);
  assert.equal(pluginTarget(records, "gone", "local"), null);
  assert.equal(pluginTarget(records, null, "local"), null);

  assert.deepEqual(pluginTargetText({ paneId: "w1:p1", workspace: "Platform", shown: true }, "This PC"), {
    actions: "Runs for the pane you have open, in Platform.",
    panes: "Opens as a new tab in Platform, beside the pane you have open.",
  });
  assert.match(pluginTargetText(null, "Laptop").actions, /Herdr's own focus is on Laptop/u);
  assert.match(pluginTargetText(null, "Laptop").panes, /^Open a pane on Laptop first/u);
  assert.match(pluginTargetText(null, "Laptop", false).actions, /is off/u);
});

test("a plugin's actions may run for another workspace of that machine, at its active pane", () => {
  const records = {
    workspaces: [
      { workspace_id: "w1", label: "Platform", active_tab_id: "w1:t1" },
      { workspace_id: "w3", label: "Docs", active_tab_id: "w3:t2" },
      { workspace_id: "w4", label: "", active_tab_id: null },
      { workspace_id: "w5", label: "Empty" },
      { workspace_id: "link_1!w2", label: "Laptop work", active_tab_id: "link_1!w2:t1" },
    ],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", focused: true },
      { pane_id: "w3:p1", workspace_id: "w3", tab_id: "w3:t1", focused: true },
      { pane_id: "w3:p2", workspace_id: "w3", tab_id: "w3:t2" },
      { pane_id: "w3:p3", workspace_id: "w3", tab_id: "w3:t2", focused: true },
      { pane_id: "w4:p1", workspace_id: "w4", tab_id: "w4:t1" },
      { pane_id: "link_1!w2:p1", workspace_id: "link_1!w2", tab_id: "link_1!w2:t1" },
    ],
  };
  const local = pluginWorkspaces(records, "local");
  assert.deepEqual(local.map((item) => [item.workspaceId, item.workspace]), [["w1", "Platform"], ["w3", "Docs"], ["w4", "w4"]], "a workspace with no pane is not offered");
  assert.deepEqual(pluginWorkspaces(records, "link_1").map((item) => item.workspaceId), ["link_1!w2"]);

  // The pane on show when it is in the workspace chosen, else that workspace's active tab's focused pane.
  assert.deepEqual(pluginTarget(records, "w1:p1", "local", "w1"), { paneId: "w1:p1", workspace: "Platform", workspaceId: "w1", shown: true });
  assert.deepEqual(pluginTarget(records, "w1:p1", "local", "w3"), { paneId: "w3:p3", workspace: "Docs", workspaceId: "w3", shown: false });
  assert.deepEqual(pluginTarget(records, null, "local", "w4"), { paneId: "w4:p1", workspace: "w4", workspaceId: "w4", shown: false });
  assert.equal(pluginTarget(records, "w1:p1", "local", "link_1!w2"), null, "not a workspace of that machine");
  assert.equal(pluginTarget(records, "w1:p1", "local", "w5"), null);
  // Without a choice it stays the pane on show.
  assert.equal(pluginTarget(records, "w1:p1", "local").paneId, "w1:p1");

  assert.deepEqual(pluginTargetText({ paneId: "w3:p3", workspace: "Docs", shown: false }, "This PC"), {
    actions: "Runs for the active pane of Docs.",
    panes: "Opens as a new tab in Docs.",
  });
});

test("a log's line names what ran, how it went and when", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const plugin = { actions: [{ id: "apply", title: "Apply layout" }] };
  assert.equal(pluginLogSummary({ action: "apply", status: "failed", exitCode: 2, startedAt: "2026-11-04T11:57:00Z" }, plugin, now),
    "Apply layout · Failed (exit 2) · 3 minutes ago");
  assert.equal(pluginLogSummary({ action: "gone", status: "succeeded", exitCode: 0, startedAt: "2026-11-04T12:00:00Z" }, plugin, now),
    "gone · Succeeded · just now");
  assert.equal(pluginLogSummary({ event: "startup", status: "running" }, plugin, now), "Startup hook · Running");
  assert.equal(pluginLogSummary({ event: "pane_created", status: "weird" }, null, now), "Event: pane_created · Unknown");
  assert.equal(pluginLogSummary({}, null, now), "Command · Unknown");
});

test("linking and unlinking read as changes", () => {
  assert.deepEqual(pluginOperationText({ action: "link", plugin: "layout", state: "running" }), { text: "Linking layout…", error: false, running: true });
  assert.deepEqual(pluginOperationText({ action: "unlink", plugin: "layout", state: "succeeded" }, [{ id: "layout", name: "Layout" }]),
    { text: "Unlinked Layout.", error: false, running: false });
});
