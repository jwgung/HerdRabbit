import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrSettings, MAX_CONFIG_BYTES, cleanHerdrSettings, configVersion, helpConfigPath, herdrSettingsRoute,
  parseIntegrationStatus, validateIntegrationName,
} from "../src/herdr-settings.mjs";
import { STATUS_OUTPUT, fakeHerdrSettings } from "./fixtures/fake-herdr-settings.mjs";

async function world(context, { initial = "[update]\nchannel = \"stable\"\n", ...options } = {}) {
  const home = await mkdtemp(join(tmpdir(), "herdr-settings-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const folder = join(home, ".config", "herdr");
  await mkdir(folder, { recursive: true });
  const configPath = join(folder, "config.toml");
  if (initial !== null) await writeFile(configPath, initial, { mode: 0o640 });
  const fake = fakeHerdrSettings({ configPath, ...options });
  const settings = new HerdrSettings({ run: fake.run, home, env: { PATH: "/usr/bin" }, now: () => Date.UTC(2026, 10, 4, 12, 0, 0) });
  return { home, folder, configPath, fake, settings };
}

const changes = (fake) => fake.state.calls.map((call) => call.args.join(" "))
  .filter((args) => !["--help", "channel show", "integration status", "config check"].includes(args));

test("reads Herdr's integration status lines, without the files they name", () => {
  const parsed = parseIntegrationStatus(STATUS_OUTPUT);
  assert.deepEqual(parsed.map((item) => [item.name, item.state, item.detail, item.experimental]), [
    ["pi", "not_installed", null, false],
    ["claude", "current", "v11", false],
    ["codex", "current", "v10", false],
    ["opencode", "needs_repair", "v13", false],
    ["antigravity-cli", "outdated", "v2 < v4", false],
    ["letta", "not_installed", null, true],
  ]);
  assert.doesNotMatch(JSON.stringify(parsed), /home|\.sh/u);
  assert.deepEqual(parseIntegrationStatus("garbage\n--flag: current\n"), []);
});

test("finds config.toml where Herdr's help says", () => {
  assert.equal(helpConfigPath("Options:\n\nConfig: /home/me/.config/herdr/config.toml\nLogs: x\n"), "/home/me/.config/herdr/config.toml");
  assert.equal(helpConfigPath("no config here"), null);
});

test("routes under a prefix", () => {
  assert.deepEqual(herdrSettingsRoute("/api/herdr/settings", "/api/herdr"), { kind: "settings" });
  assert.deepEqual(herdrSettingsRoute("/api/herdr/integrations/claude/install", "/api/herdr"),
    { kind: "integration", name: "claude", action: "install" });
  assert.deepEqual(herdrSettingsRoute("/api/herdr/integrations/claude/explode", "/api/herdr"), { kind: "unknown" });
  assert.equal(herdrSettingsRoute("/api/herdr-update", "/api/herdr"), null);
  assert.equal(herdrSettingsRoute("/api/plugins", "/api/herdr"), null);
});

test("an integration name is one of Herdr's words, never an option or a path", () => {
  for (const bad of ["--all", "-x", "../x", "a/b", "Claude", "", "a".repeat(40), "x y", null]) {
    assert.throws(() => validateIntegrationName(bad), { code: "invalid_integration" }, String(bad));
  }
  assert.equal(validateIntegrationName("antigravity-cli"), "antigravity-cli");
});

test("lists the channel, integrations and where config.toml is (under ~)", async (context) => {
  const { settings } = await world(context);
  const state = await settings.state();
  assert.equal(state.channel, "stable");
  assert.equal(state.integrations.length, 6);
  assert.deepEqual(state.config, { path: "~/.config/herdr/config.toml", exists: true, bytes: 28 });
  assert.deepEqual(cleanHerdrSettings({ channel: "nightly", integrations: [{ name: "--x" }], config: { path: "relative" } }),
    { channel: null, integrations: [], config: { path: null, exists: false, bytes: null } });
});

test("sets the channel and installs or uninstalls an integration Herdr lists, from argv", async (context) => {
  const { settings, fake } = await world(context);
  assert.equal((await settings.setChannel("preview")).channel, "preview");
  const installed = await settings.integration("install", "pi");
  assert.equal(installed.integrations.find((item) => item.name === "pi").state, "current");
  await settings.integration("uninstall", "claude");
  assert.deepEqual(changes(fake), ["channel set preview", "integration install pi", "integration uninstall claude"]);
  await assert.rejects(settings.setChannel("nightly"), { code: "invalid_channel" });
  await assert.rejects(settings.integration("install", "copilot"), { code: "integration_not_found", status: 404 });
  await assert.rejects(settings.integration("remove", "pi"), { status: 404 });
  assert.equal(changes(fake).length, 3, "nothing else ran");
});

test("one change at a time, and none while Herdr updates", async (context) => {
  const { settings, fake } = await world(context);
  fake.state.holdChannel = true;
  const first = settings.setChannel("preview");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(settings.integration("install", "pi"), { code: "herdr_settings_busy", status: 409 });
  fake.state.release();
  await first;
  const updating = new HerdrSettings({ run: fake.run, busy: async () => true });
  await assert.rejects(updating.setChannel("stable"), { code: "herdr_settings_busy" });
});

test("checks a config in a private temporary file, never the real one", async (context) => {
  const { settings, fake, configPath } = await world(context);
  const good = await settings.checkConfig("onboarding = false\n");
  assert.deepEqual(good, { ok: true, diagnostics: "config: ok" });
  const bad = await settings.checkConfig("onboarding = 3\n");
  assert.equal(bad.ok, false);
  assert.match(bad.diagnostics, /config parse error in config\.toml: invalid type/u);
  const checks = fake.state.calls.filter((call) => call.args.join(" ") === "config check");
  assert.equal(checks.length, 2);
  for (const call of checks) {
    assert.notEqual(call.configPath, configPath);
    await assert.rejects(stat(call.configPath), { code: "ENOENT" }, "the temporary file is gone");
  }
  assert.equal(await readFile(configPath, "utf8"), "[update]\nchannel = \"stable\"\n");
});

test("a save checks first, keeps a backup, writes in place and reloads Herdr", async (context) => {
  const { settings, fake, configPath, folder } = await world(context);
  const read = await settings.readConfig();
  assert.equal(read.version, configVersion(Buffer.from(read.text)));
  const saved = await settings.saveConfig("onboarding = false\n", read.version);
  assert.equal(saved.text, "onboarding = false\n");
  assert.equal(saved.reloaded, true);
  assert.match(saved.backup, /^config\.toml\.bak-\d{8}-\d{6}$/u);
  assert.equal(await readFile(configPath, "utf8"), "onboarding = false\n");
  assert.equal(await readFile(join(folder, saved.backup), "utf8"), read.text);
  assert.equal((await stat(configPath)).mode & 0o777, 0o640, "the file keeps its mode");
  assert.deepEqual((await readdir(folder)).filter((name) => name.includes("herdrabbit")), [], "no temporary file is left");
  assert.deepEqual(changes(fake), ["server reload-config"]);
  // a second save the same second gets a backup of its own
  const again = await settings.saveConfig("onboarding = true\n", saved.version);
  assert.notEqual(again.backup, saved.backup);
});

test("a save keeps the newest backups only, and clears a write left by a crash", async (context) => {
  const { settings, configPath, folder } = await world(context);
  const { utimes, symlink: link } = await import("node:fs/promises");
  // Twelve older backups (one of them a -2 of the same second), and look-alikes that are not ours to touch.
  const old = Array.from({ length: 11 }, (_, index) => `config.toml.bak-202601${String(index + 10)}-090000`);
  old.push("config.toml.bak-20260120-090000-2");
  for (const name of old) await writeFile(join(folder, name), name);
  await writeFile(join(folder, "config.toml.bak-notes"), "mine");
  await writeFile(join(folder, "other.toml.bak-20260101-090000"), "other");
  await mkdir(join(folder, "config.toml.bak-20250101-000000"));
  await link(configPath, join(folder, "config.toml.bak-20250102-000000"));
  // A write left by a crash an hour ago goes; one being written now (a minute old) stays.
  const stale = join(folder, ".config.toml.herdrabbit-0123456789ab");
  const fresh = join(folder, ".config.toml.herdrabbit-ba9876543210");
  await writeFile(stale, "x");
  await writeFile(fresh, "y");
  const now = Date.UTC(2026, 10, 4, 12, 0, 0) / 1000;
  await utimes(stale, now - 3600, now - 3600);
  await utimes(fresh, now - 60, now - 60);

  const saved = await settings.saveConfig("onboarding = false\n", (await settings.readConfig()).version);
  const names = await readdir(folder);
  const backups = names.filter((name) => /^config\.toml\.bak-\d{8}-\d{6}(?:-\d+)?$/u.test(name)).sort();
  assert.equal(backups.length, 12, "ten files, plus the folder and the link that are not files");
  assert.ok(backups.includes(saved.backup), "the one just made is kept");
  const files = [];
  for (const name of backups) if ((await stat(join(folder, name))).isFile() && !name.startsWith("config.toml.bak-2025")) files.push(name);
  assert.equal(files.length, 10);
  assert.ok(!files.includes("config.toml.bak-20260110-090000") && !files.includes("config.toml.bak-20260111-090000"), "the oldest go");
  assert.ok(files.includes("config.toml.bak-20260120-090000-2"));
  for (const kept of ["config.toml.bak-notes", "other.toml.bak-20260101-090000", "config.toml.bak-20250101-000000", "config.toml.bak-20250102-000000", "config.toml"]) {
    assert.ok(names.includes(kept), kept);
  }
  assert.ok(!names.includes(".config.toml.herdrabbit-0123456789ab"), "a crash's leftover goes");
  assert.ok(names.includes(".config.toml.herdrabbit-ba9876543210"), "a recent one stays");
});

test("the backup a save makes is kept even when the clock is behind the others, and -10 sorts after -9", async (context) => {
  const { configPath, folder, fake } = await world(context);
  const settings = new HerdrSettings({ run: fake.run, home: folder, env: { PATH: "/usr/bin" }, now: () => new Date(2020, 0, 1, 9, 0, 0).getTime() });
  const later = [...Array.from({ length: 8 }, (_, index) => `config.toml.bak-20300101-0900${String(index + 11)}`), "config.toml.bak-20300101-090000-9", "config.toml.bak-20300101-090000-10"];
  for (const name of later) await writeFile(join(folder, name), name);
  const saved = await settings.saveConfig("onboarding = false\n", (await settings.readConfig()).version);
  assert.match(saved.backup, /^config\.toml\.bak-20200101-090000$/u);
  const backups = (await readdir(folder)).filter((name) => name.startsWith("config.toml.bak-"));
  assert.equal(backups.length, 10);
  assert.ok(backups.includes(saved.backup), "the one just made stays");
  assert.ok(!backups.includes("config.toml.bak-20300101-090000-9"), "the oldest goes");
  assert.ok(backups.includes("config.toml.bak-20300101-090000-10"), "-10 is newer than -9");
  assert.equal(await readFile(configPath, "utf8"), "onboarding = false\n");
});

test("a config Herdr refuses is not saved, and its diagnostics come back", async (context) => {
  const { settings, fake, configPath, folder } = await world(context);
  const { version } = await settings.readConfig();
  await assert.rejects(settings.saveConfig("[ui\n", version), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "config_invalid");
    assert.match(error.details.diagnostics, /invalid table header/u);
    return true;
  });
  assert.equal(await readFile(configPath, "utf8"), "[update]\nchannel = \"stable\"\n");
  assert.deepEqual((await readdir(folder)).sort(), ["config.toml"], "no backup, no temporary file");
  assert.deepEqual(changes(fake), [], "Herdr was not reloaded");
});

test("a config changed since it was read is not overwritten", async (context) => {
  const { settings, configPath } = await world(context);
  const { version } = await settings.readConfig();
  await writeFile(configPath, "[update]\nchannel = \"preview\"\n");
  await assert.rejects(settings.saveConfig("onboarding = false\n", version), { code: "config_changed", status: 409 });
  await assert.rejects(settings.saveConfig("onboarding = false\n", "made-up"), { code: "invalid_config_version" });
  assert.equal(await readFile(configPath, "utf8"), "[update]\nchannel = \"preview\"\n");
});

test("a first config.toml is written without a backup; a server not running is said, not a failure", async (context) => {
  const { settings, configPath } = await world(context, { initial: null, reloadFails: true });
  const read = await settings.readConfig();
  assert.deepEqual([read.exists, read.text, read.version], [false, "", "none"]);
  const saved = await settings.saveConfig("onboarding = false\n", "none");
  assert.equal(saved.backup, null);
  assert.equal(saved.reloaded, false);
  assert.match(saved.reloadDetail, /no running herdr server/u);
  assert.doesNotMatch(saved.reloadDetail, /\/home\/me\/\.config/u, "folders are shortened");
  assert.equal(await readFile(configPath, "utf8"), "onboarding = false\n");
});

test("a linked config.toml stays a link: the file it names is written", async (context) => {
  const { settings, configPath, home } = await world(context, { initial: null });
  const real = join(home, "dotfiles-herdr.toml");
  await writeFile(real, "onboarding = true\n");
  await symlink(real, configPath);
  const { version } = await settings.readConfig();
  await settings.saveConfig("onboarding = false\n", version);
  assert.equal(await readFile(real, "utf8"), "onboarding = false\n");
  assert.equal(await readFile(configPath, "utf8"), "onboarding = false\n");
});

test("refuses text that is too large or holds a NUL", async (context) => {
  const { settings } = await world(context);
  await assert.rejects(settings.checkConfig("#".repeat(MAX_CONFIG_BYTES + 1)), { code: "config_too_large", status: 413 });
  await assert.rejects(settings.saveConfig("a\u0000b", "none"), { code: "invalid_config" });
  await assert.rejects(settings.checkConfig(42), { code: "invalid_config" });
});

test("Herdr's defaults are read, never written", async (context) => {
  const { settings, fake } = await world(context);
  assert.match((await settings.defaultConfig()).text, /^# herdr configuration/u);
  assert.deepEqual(changes(fake), ["--default-config"]);
});

test("an edit made on that PC while Herdr checks is not overwritten, and no backup is left", async (context) => {
  const { settings, configPath, folder, fake } = await world(context);
  const { version } = await settings.readConfig();
  const run = fake.run;
  // the other editor writes while `config check` runs on the temporary file
  settings.run = async (args, options) => {
    if (args[0] === "config" && options?.env?.HERDR_CONFIG_PATH && options.env.HERDR_CONFIG_PATH !== configPath) {
      await writeFile(configPath, "onboarding = true\n");
    }
    return run(args, options);
  };
  await assert.rejects(settings.saveConfig("onboarding = false\n", version), { code: "config_changed", status: 409 });
  assert.equal(await readFile(configPath, "utf8"), "onboarding = true\n");
  assert.deepEqual((await readdir(folder)).sort(), ["config.toml"], "no backup, no temporary file");
});

test("a config.toml that links to nothing is not replaced by a file; a first one is the user's alone", async (context) => {
  const { settings, configPath, home } = await world(context, { initial: null });
  await symlink(join(home, "gone.toml"), configPath);
  await assert.rejects(settings.saveConfig("onboarding = false\n", "none"), { code: "config_link_broken", status: 409 });
  await rm(configPath);
  await settings.saveConfig("onboarding = false\n", "none");
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});
