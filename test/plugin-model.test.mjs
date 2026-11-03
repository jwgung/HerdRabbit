import test from "node:test";
import assert from "node:assert/strict";
import {
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
