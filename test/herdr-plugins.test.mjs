import test from "node:test";
import assert from "node:assert/strict";
import {
  PluginManager, cleanPluginState, isHerdRabbitPlugin, validatePluginId, validatePluginRef, validatePluginSource,
} from "../src/herdr-plugins.mjs";
import { HERDRABBIT, LINKED, NOTES, fakeHerdr } from "./fixtures/fake-herdr-plugins.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a plugin id is a short word, never an option or a path", () => {
  for (const ok of ["notes", "herdr-notes", "a", "x.y_z-1", "A".repeat(64)]) assert.equal(validatePluginId(ok), ok);
  for (const bad of ["", "-rf", "--yes", ".hidden", "a/b", "a b", "a;b", "A".repeat(65), "é", null, 3, "../x"]) {
    assert.throws(() => validatePluginId(bad), { status: 400, code: "invalid_plugin_id" }, String(bad));
  }
});

test("a source is owner/repo[/subdir] by GitHub's name rules", () => {
  assert.deepEqual(validatePluginSource("someone/herdr-notes"),
    { owner: "someone", repo: "herdr-notes", subdir: null, spec: "someone/herdr-notes" });
  assert.deepEqual(validatePluginSource("org-1/mono.repo/plugins/notes"),
    { owner: "org-1", repo: "mono.repo", subdir: "plugins/notes", spec: "org-1/mono.repo/plugins/notes" });
  for (const bad of [
    "", "someone", "someone/", "/repo", "-someone/repo", "someone-/repo", "some--one/repo", "a".repeat(40) + "/repo",
    "someone/repo.git", "someone/..", "someone/.", "someone/repo/../x", "someone/repo//x", "someone/re po",
    "https://github.com/someone/repo", "git@github.com:someone/repo", "someone/repo;rm", "someone/repo/a/b/c/d/e/f/g/h/i",
    "someone/" + "r".repeat(101), "someone/repo\n", null, {},
  ]) {
    assert.throws(() => validatePluginSource(bad), { status: 400, code: "invalid_plugin_source" }, JSON.stringify(bad));
  }
});

test("a ref is a git ref name: no spaces, no .., no leading -", () => {
  assert.equal(validatePluginRef(undefined), null);
  assert.equal(validatePluginRef(""), null);
  assert.equal(validatePluginRef(null), null);
  for (const ok of ["main", "v1.2.3", "feature/x", "1234abcd", "release-2026_01", "v1+build"]) assert.equal(validatePluginRef(ok), ok);
  for (const bad of ["-x", "--upload-pack=evil", "a b", "a..b", "a//b", "/a", "a/", "a.", "a.lock", "a/.b", ".a", "a~1", "a^", "a:b", "a\\b", "a@{1}", "x".repeat(201), 5]) {
    assert.throws(() => validatePluginRef(bad), { status: 400, code: "invalid_plugin_ref" }, String(bad));
  }
});

test("HerdRabbit is its id, the id this server runs as, an official repository or any repo named HerdRabbit", () => {
  assert.equal(isHerdRabbitPlugin("herdrabbit", null), true);
  assert.equal(isHerdRabbitPlugin("hr-dev", null, "hr-dev"), true);
  assert.equal(isHerdRabbitPlugin("x", { kind: "github", owner: "ultivis-iot", repo: "HerdRabbit" }), true);
  assert.equal(isHerdRabbitPlugin("x", { kind: "github", owner: "my-fork", repo: "herdrabbit" }), true);
  assert.equal(isHerdRabbitPlugin("notes", { kind: "github", owner: "someone", repo: "herdr-notes" }), false);
  assert.equal(isHerdRabbitPlugin("notes", { kind: "local" }), false);
});

test("the list keeps what the page shows and nothing of where it lives", () => {
  const state = cleanPluginState({ plugins: [HERDRABBIT, NOTES, LINKED, { plugin_id: "--bad" }, { name: "no id" }] });
  assert.deepEqual(state.plugins.map((item) => item.id), ["herdrabbit", "notes", "local-tool"]);
  assert.deepEqual(state.plugins[0], {
    id: "herdrabbit", name: "HerdRabbit", version: "1.4.27", description: "Phone access", enabled: true,
    source: { kind: "github", owner: "ultivis-iot", repo: "HerdRabbit", subdir: null, ref: "v1.4.27", commit: "a074fe0dbe4c3d96ed53fdeb325bd6d6cd1e080e" },
    protected: true, updatable: false, actions: [], panes: [],
  });
  assert.equal(state.plugins[1].enabled, false);
  assert.equal(state.plugins[1].updatable, true);
  assert.deepEqual(state.plugins[2].source, { kind: "local" });
  assert.equal(state.plugins[2].updatable, false);
  assert.doesNotMatch(JSON.stringify(state), /secret|\/home\/me/u);
  assert.equal(state.operation, null);
  // An answer from a connected PC that marks a plugin protected keeps it so.
  assert.equal(cleanPluginState({ plugins: [{ ...NOTES, protected: true }] }).plugins[0].protected, true);
});

test("each change runs Herdr's own command from argv, one at a time", async () => {
  const herdr = fakeHerdr(undefined, { hold: true });
  const manager = new PluginManager({ run: herdr.run, now: () => Date.parse("2026-01-01T00:00:00Z") });
  const started = await manager.start("disable", { plugin: "local-tool" });
  assert.equal(started.operation.state, "running");
  assert.deepEqual(started.operation, {
    action: "disable", plugin: "local-tool", ref: null, state: "running", detail: null,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null,
  });
  await assert.rejects(manager.start("enable", { plugin: "notes" }), { status: 409, code: "plugin_busy" });
  herdr.release();
  await settle();
  assert.equal((await manager.list()).operation.state, "succeeded");

  for (const [action, input, args] of [
    ["enable", { plugin: "notes" }, ["plugin", "enable", "notes"]],
    ["update", { plugin: "notes" }, ["plugin", "update", "notes", "--yes"]],
    ["uninstall", { plugin: "notes" }, ["plugin", "uninstall", "notes"]],
    ["install", { source: "someone/tool" }, ["plugin", "install", "someone/tool", "--yes"]],
    ["install", { source: "org/mono/plugins/x", ref: "v2.0.0" }, ["plugin", "install", "org/mono/plugins/x", "--ref", "v2.0.0", "--yes"]],
  ]) {
    herdr.calls.length = 0;
    const answer = manager.start(action, input);
    await settle();
    herdr.release();
    await answer;
    await settle();
    const ran = herdr.calls.filter((call) => call.args[1] !== "list");
    assert.deepEqual(ran.map((call) => call.args), [args], action);
    assert.ok(ran[0].timeout >= (action === "install" || action === "update" ? 10 * 60_000 : 30_000), `${action} timeout`);
  }
});

test("HerdRabbit, an unknown plugin and a non-GitHub update are refused before Herdr runs", async () => {
  const herdr = fakeHerdr();
  const manager = new PluginManager({ run: herdr.run, selfId: "herdrabbit" });
  for (const action of ["enable", "disable", "update", "uninstall"]) {
    await assert.rejects(manager.start(action, { plugin: "herdrabbit" }), { status: 403, code: "plugin_protected" });
  }
  await assert.rejects(manager.start("install", { source: "ultivis-iot/HerdRabbit" }), { status: 403, code: "plugin_protected" });
  await assert.rejects(manager.start("install", { source: "a-fork/herdrabbit", ref: "main" }), { status: 403, code: "plugin_protected" });
  await assert.rejects(manager.start("enable", { plugin: "missing" }), { status: 404, code: "plugin_not_found" });
  await assert.rejects(manager.start("update", { plugin: "local-tool" }), { status: 409, code: "plugin_not_updatable" });
  await assert.rejects(manager.start("install", { source: "someone/tool", ref: "--upload-pack=x" }), { code: "invalid_plugin_ref" });
  await assert.rejects(manager.start("remove", { plugin: "notes" }), { status: 404 });
  assert.deepEqual(herdr.calls.filter((call) => call.args[1] !== "list"), []);
  // The refusals leave the slot free.
  await manager.start("enable", { plugin: "notes" });
});

test("a failed change says Herdr's last line; nothing starts while an update runs", async () => {
  const herdr = fakeHerdr(undefined, { fail: "error: repository not found" });
  const manager = new PluginManager({ run: herdr.run });
  await manager.start("install", { source: "someone/missing" });
  await settle();
  const { operation } = await manager.list();
  assert.equal(operation.state, "failed");
  assert.equal(operation.detail, "error: repository not found");

  let updating = true;
  const blocked = new PluginManager({ run: fakeHerdr().run, busy: async () => updating });
  await assert.rejects(blocked.start("enable", { plugin: "notes" }), { status: 409, code: "plugin_busy" });
  updating = false;
  await blocked.start("enable", { plugin: "notes" });
});

test("a Herdr that fails to list says so", async () => {
  const broken = new PluginManager({ run: async () => ({ code: 2, stdout: "", stderr: "unknown command\n", timedOut: false }) });
  await assert.rejects(broken.list(), { status: 502, code: "plugin_list_failed", message: /unknown command/u });
  const garbled = new PluginManager({ run: async () => ({ code: 0, stdout: "not json", stderr: "", timedOut: false }) });
  await assert.rejects(garbled.list(), { status: 502, code: "plugin_list_failed" });
});

test("a failed change names a folder by its last part, never this PC's whole path", async () => {
  const herdr = fakeHerdr(undefined, { fail: "error: build failed in /home/me/.config/herdr/plugins/notes-1/checkout: npm ci exited 1" });
  const manager = new PluginManager({ run: herdr.run });
  await manager.start("update", { plugin: "notes" });
  await new Promise((resolve) => setImmediate(resolve));
  const { operation } = await manager.list();
  assert.equal(operation.state, "failed");
  assert.equal(operation.detail, "error: build failed in …/checkout: npm ci exited 1");
  assert.doesNotMatch(operation.detail, /\/home|\.config/u);
});

test("readers who ask at once share one herdr plugin list", async () => {
  const herdr = fakeHerdr();
  const manager = new PluginManager({ run: herdr.run });
  await Promise.all([manager.list(), manager.list(), manager.list()]);
  assert.equal(herdr.calls.filter((call) => call.args[1] === "list").length, 1);
});
