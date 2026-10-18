import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HERDR_LOG_FILE, HERDR_STATE_FILE, HerdrUpdater, MANIFEST_URLS, MAX_HERDR_NOTES, MAX_MANIFEST_BYTES,
  cleanHerdrCheck, cleanHerdrRunStatus, fetchManifest, parseManifest, plainNotes, runHerdrUpdateScript,
} from "../src/herdr-update.mjs";
import { compareHerdrVersions } from "../src/herdr-version.mjs";
import { AppUpdater, MAX_LOG_BYTES } from "../src/app-update.mjs";

// Herdr, systemd-run, systemctl and herdr.dev are all answered here: no real
// Herdr runs, nothing is started, nothing goes over the network.
const BIN = "/opt/herdr/bin/herdr";
const SERVICE_ENV = {
  PATH: "/opt/herdr/bin:/usr/bin",
  HOME: "/home/me",
  HERDR_BIN: BIN,
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1-p1",
  HERDR_SOCKET_PATH: "/home/me/.config/herdr/herdr.sock",
  HERDR_WEB_PORT: "38787",
  SECRET_TOKEN: "do-not-pass",
  XDG_CONFIG_HOME: "/home/me/.cfg",
  XDG_RUNTIME_DIR: "relative/not-taken",
};
const NOTES = "### Fixed\n- **Prefix** shortcuts work again. See [the notes](https://example.invalid/x).\n\u001b[31mred\u001b[0m\u0007";

async function scratch(context) {
  const root = await mkdtemp(join(tmpdir(), "herdrabbit-herdr-update-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir: join(root, "state") };
}

function fakes(overrides = {}) {
  const state = {
    version: "herdr 0.9.3\n", channel: "stable\n", channelCode: 0, systemdRun: 0, runCode: 0, active: "active",
    manifest: JSON.stringify({ version: "0.9.5", protocol: 22, notes: NOTES }), status: 200, headers: {},
    calls: [], urls: [], ...overrides,
  };
  state.exec = async (file, args, options = {}) => {
    state.calls.push({ file, args, options });
    if (file === BIN && args[0] === "--version") return { code: 0, stdout: state.version };
    if (file === BIN && args[0] === "channel") return { code: state.channelCode, stdout: state.channel };
    if (file === "systemd-run" && args[0] === "--version") return { code: state.systemdRun, stdout: "systemd 255\n" };
    if (file === "systemd-run") return { code: state.runCode, stdout: "" };
    if (file === "systemctl") return { code: state.active === "active" ? 0 : 3, stdout: `${state.active}\n` };
    throw new Error(`unexpected command ${file} ${args.join(" ")}`);
  };
  state.fetch = async (url, options) => {
    state.urls.push({ url, options });
    return new Response(state.manifest, { status: state.status, headers: state.headers });
  };
  return state;
}

function updater(dir, fake, extra = {}) {
  let clock = 1_000_000;
  const subject = new HerdrUpdater({
    binary: "herdr", stateDir: dir.stateDir, exec: fake.exec, fetchImpl: fake.fetch, platform: "linux",
    environment: SERVICE_ENV, nodeBin: "/opt/node/bin/node", repository: "/srv/herdrabbit",
    isExecutable: async (path) => path === BIN, resolvePath: async (path) => path,
    now: () => clock, ...extra,
  });
  subject.advance = (ms) => { clock += ms; };
  return subject;
}

const fetchCount = (fake) => fake.urls.length;

test("versions compare as semver does, prereleases included", () => {
  assert.ok(compareHerdrVersions("0.9.5", "0.9.3") > 0);
  assert.ok(compareHerdrVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareHerdrVersions("0.9.3", "0.9.3"), 0);
  assert.ok(compareHerdrVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareHerdrVersions("1.0.0-beta.2", "1.0.0-beta.1") > 0);
  assert.ok(compareHerdrVersions("1.0.0-beta.10", "1.0.0-beta.9") > 0);
  assert.ok(compareHerdrVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert.ok(compareHerdrVersions("1.0.0-alpha.beta", "1.0.0-alpha.1") > 0);
  assert.equal(compareHerdrVersions("latest", "0.9.3"), null);
});

test("a newer Herdr on the stable channel is an update, with its notes as plain text", async (context) => {
  const dir = await scratch(context);
  const fake = fakes();
  const told = [];
  const result = await updater(dir, fake, { onVersion: (version) => told.push(version) }).check();
  assert.equal(result.current, "0.9.3");
  // what this service reports follows the Herdr it finds, without a restart
  assert.deepEqual(told, ["0.9.3"]);
  assert.equal(result.latest, "0.9.5");
  assert.equal(result.channel, "stable");
  assert.equal(result.available, true);
  assert.equal(result.blocked, null);
  assert.equal(result.error, null);
  assert.equal(result.notes, "Fixed\n- Prefix shortcuts work again. See the notes.\nred");
  assert.deepEqual(fake.urls.map((entry) => entry.url), [MANIFEST_URLS.stable]);
  assert.equal(fake.urls[0].options.redirect, "error");
  assert.ok(fake.urls[0].options.signal instanceof AbortSignal);
  // Herdr's own questions get PATH and HOME and nothing else.
  for (const call of fake.calls.filter((entry) => entry.file === BIN)) {
    assert.deepEqual(call.options.env, { PATH: `/opt/herdr/bin:${SERVICE_ENV.PATH}`, HOME: "/home/me", XDG_CONFIG_HOME: "/home/me/.cfg" });
  }
});

test("the preview channel reads the preview manifest, and the same version is up to date", async (context) => {
  const dir = await scratch(context);
  const fake = fakes({ channel: "preview\n", version: "herdr 0.9.5\n" });
  const result = await updater(dir, fake).check();
  assert.equal(result.channel, "preview");
  assert.deepEqual(fake.urls.map((entry) => entry.url), [MANIFEST_URLS.preview]);
  assert.equal(result.available, false);
  assert.equal(result.notes, "");
  // A Herdr without channels follows stable.
  const old = fakes({ channelCode: 2, channel: "" });
  assert.equal((await updater(dir, old).check()).channel, "stable");
  assert.equal(old.urls[0].url, MANIFEST_URLS.stable);
});

test("a preview newer than the release is an update; an older release is not", async (context) => {
  const dir = await scratch(context);
  const preview = fakes({ version: "herdr 0.9.5\n", manifest: JSON.stringify({ version: "0.9.6-beta.1" }) });
  assert.equal((await updater(dir, preview).check()).available, true);
  const older = fakes({ version: "herdr 0.9.6-beta.1\n", manifest: JSON.stringify({ version: "0.9.5" }) });
  assert.equal((await updater(dir, older).check()).available, false);
});

test("a manifest that is not JSON, too large, or names no version is a failed check", async (context) => {
  const dir = await scratch(context);
  const cases = [
    { manifest: "<html>nope</html>" },
    { manifest: JSON.stringify({ version: "v0.9.5" }) },
    { manifest: JSON.stringify({ version: "0.9.5; rm -rf /" }) },
    { manifest: JSON.stringify(["0.9.5"]) },
    { manifest: JSON.stringify({ notes: "no version" }) },
    { manifest: JSON.stringify({ version: "0.9.5", notes: "x".repeat(MAX_MANIFEST_BYTES) }) },
    { manifest: "{}", headers: { "content-length": String(MAX_MANIFEST_BYTES + 1) } },
    { status: 503 },
  ];
  for (const overrides of cases) {
    const result = await updater(dir, fakes(overrides)).check();
    assert.equal(result.error, "manifest_failed", JSON.stringify(overrides).slice(0, 80));
    assert.equal(result.available, false);
    assert.equal(result.current, "0.9.3");
  }
  const thrown = fakes();
  thrown.fetch = async () => { throw new TypeError("fetch failed"); };
  assert.equal((await updater(dir, thrown).check()).error, "manifest_failed");
});

test("the manifest reader stops at the size cap even without a length", async () => {
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (pulled > 200) controller.close();
    },
  });
  await assert.rejects(fetchManifest(MANIFEST_URLS.stable, async () => new Response(body)), /too large/u);
  assert.ok(pulled <= MAX_MANIFEST_BYTES / (64 * 1024) + 2, `read ${pulled} chunks`);
  assert.deepEqual(parseManifest(JSON.stringify({ version: "1.2.3-rc.1", notes: 42 })), { version: "1.2.3-rc.1", notes: "" });
  // any SemVer: hyphens inside a prerelease, build metadata
  for (const version of ["1.2.3-beta-1", "1.0.0+linux", "1.0.0-rc.1+b.2"]) assert.equal(parseManifest(JSON.stringify({ version })).version, version);
  for (const version of ["1.0", "1.0.0-", "v1.0.0"]) assert.throws(() => parseManifest(JSON.stringify({ version })));
});

test("notes are plain text, without control characters, and bounded", () => {
  const notes = plainNotes(`# Title\r\n\u0000\u0008\u009b**bold** \`code\`\n\n\n\n${"y".repeat(5_000)}`);
  assert.ok(notes.length <= MAX_HERDR_NOTES);
  assert.ok(notes.startsWith("Title\nbold code\n\ny"));
  assert.doesNotMatch(notes, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
});

test("a missing Herdr, another system, no systemd-run or a package-manager install say why", async (context) => {
  const dir = await scratch(context);
  const missing = await updater(dir, fakes(), { isExecutable: async () => false }).check();
  assert.equal(missing.error, "herdr_missing");
  assert.equal(missing.current, null);
  assert.equal((await updater(dir, fakes(), { platform: "darwin" }).check()).blocked, "unsupported_platform");
  assert.equal((await updater(dir, fakes({ systemdRun: 127 })).check()).blocked, "no_systemd_run");
  const brew = await updater(dir, fakes(), {
    resolvePath: async () => "/home/linuxbrew/.linuxbrew/Cellar/herdr/0.9.3/bin/herdr",
  }).check();
  assert.equal(brew.blocked, "managed_install");
  assert.equal(brew.available, true, "still says there is a newer Herdr");
  const nix = await updater(dir, fakes(), { resolvePath: async () => "/nix/store/abc-herdr-0.9.3/bin/herdr" }).check();
  assert.equal(nix.blocked, "managed_install");
  // An absolute HERDR_BIN is used as it is.
  const named = fakes();
  await updater(dir, named, { binary: BIN, environment: { HOME: "/home/me" } }).check();
  assert.ok(named.calls.some((call) => call.file === BIN));
  const unknown = await updater(dir, fakes({ version: "herdr ???\n" })).check();
  assert.equal(unknown.error, "version_unknown");
  assert.equal(unknown.latest, "0.9.5");
});

test("checks are coalesced: a recent look is the answer, Check may ask sooner", async (context) => {
  const dir = await scratch(context);
  const fake = fakes();
  const subject = updater(dir, fake);
  await Promise.all([subject.check(), subject.check()]);
  assert.equal(fetchCount(fake), 1);
  subject.advance(5_000);
  await subject.check({ fresh: true });
  assert.equal(fetchCount(fake), 1);
  subject.advance(6_000);
  await subject.check({ fresh: true });
  assert.equal(fetchCount(fake), 2);
  await subject.check();
  assert.equal(fetchCount(fake), 2);
  subject.advance(60_000);
  await subject.check();
  assert.equal(fetchCount(fake), 3);
});

test("while HerdRabbit updates, Herdr is not looked at and says so", async (context) => {
  const dir = await scratch(context);
  const fake = fakes();
  const result = await updater(dir, fake, { busy: async () => true }).check();
  assert.equal(result.blocked, "running");
  assert.equal(fetchCount(fake), 0);
});

test("a start runs herdr update in its own unit with only PATH, HOME and the XDG folders", async (context) => {
  const dir = await scratch(context);
  const fake = fakes();
  const subject = updater(dir, fake);
  const status = await subject.start();
  assert.equal(status.state, "running");
  const run = fake.calls.find((call) => call.file === "systemd-run" && call.args[0] === "--user");
  assert.deepEqual(run.args, [
    "--user", "--unit=herdr-update-1000000", "--collect", "--quiet",
    "--property=WorkingDirectory=/home/me",
    `--setenv=PATH=/opt/herdr/bin:${SERVICE_ENV.PATH}`,
    "--setenv=HOME=/home/me",
    // where Herdr keeps its config and sockets goes along; a relative one does not
    "--setenv=XDG_CONFIG_HOME=/home/me/.cfg",
    "/opt/node/bin/node", "/srv/herdrabbit/scripts/run-herdr-update.mjs", dir.stateDir, BIN,
  ]);
  assert.equal(run.options.env, undefined, "systemd-run itself is not handed this service's environment");
  assert.doesNotMatch(run.args.join(" "), /HERDR_|SECRET|38787/u);
  const record = JSON.parse(await readFile(join(dir.stateDir, HERDR_STATE_FILE), "utf8"));
  assert.equal(record.unit, "herdr-update-1000000");
  assert.equal(record.state, "running");
  assert.equal((await lstat(dir.stateDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(dir.stateDir, HERDR_LOG_FILE))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(dir.stateDir, HERDR_STATE_FILE))).mode & 0o777, 0o600);
  // HerdRabbit's own record is not touched.
  await assert.rejects(lstat(join(dir.stateDir, "update-state.json")), { code: "ENOENT" });
  assert.equal((await subject.check()).blocked, "running");
});

test("one start a minute, counting only runs that started", async (context) => {
  const dir = await scratch(context);
  const fake = fakes({ runCode: 1 });
  const subject = updater(dir, fake);
  await assert.rejects(subject.start(), { status: 502, code: "update_start_failed" });
  assert.equal((await subject.runStatus()).reason, "start_failed");
  fake.runCode = 0;
  await subject.start();
  await assert.rejects(subject.start(), { status: 409, code: "update_running" });
  // The unit went away without a word: an interrupted run, not one for ever.
  subject.advance(20_000);
  fake.active = "inactive";
  assert.equal((await subject.runStatus()).reason, "interrupted");
  await assert.rejects(subject.start(), { status: 429, code: "too_many_requests" });
  subject.advance(60_000);
  assert.equal((await subject.start()).state, "running");
});

test("a start is refused while HerdRabbit updates, when up to date, or when blocked", async (context) => {
  const dir = await scratch(context);
  await assert.rejects(updater(dir, fakes(), { busy: async () => true }).start(), { status: 409, code: "update_running" });
  await assert.rejects(updater(dir, fakes({ version: "herdr 0.9.5\n" })).start(), { status: 409, code: "up_to_date" });
  await assert.rejects(updater(dir, fakes({ systemdRun: 1 })).start(), { status: 409, code: "update_blocked" });
  await assert.rejects(updater(dir, fakes({ status: 500 })).start(), { status: 409, code: "update_check_failed" });
  // None of those started anything, so the next real start may go at once.
  const fake = fakes();
  const subject = updater(dir, fake);
  assert.equal((await subject.start()).state, "running");
  assert.equal(fake.calls.filter((call) => call.file === "systemd-run" && call.args[0] === "--user").length, 1);
});

test("a state folder that is a link is refused", async (context) => {
  const dir = await scratch(context);
  await mkdir(join(dir.root, "elsewhere"));
  await symlink(join(dir.root, "elsewhere"), dir.stateDir);
  await assert.rejects(updater(dir, fakes()).start(), { code: "update_state_unsafe" });
});

function fakeSpawn(output, exit) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    writeSync(options.stdio[1], output);
    const child = new EventEmitter();
    setImmediate(() => child.emit("close", exit));
    return child;
  };
  return { calls, spawnImpl };
}

test("the run gives Herdr only PATH, HOME and the XDG folders and records how it ended", async (context) => {
  const dir = await scratch(context);
  const subject = updater(dir, fakes());
  await subject.start();
  const { calls, spawnImpl } = fakeSpawn("Downloading herdr 0.9.5\nInstalled. Handed off 3 panes.\n", 0);
  const exit = await runHerdrUpdateScript({
    stateDir: dir.stateDir, binary: BIN, spawnImpl, environment: { ...SERVICE_ENV, PATH: "/opt/herdr/bin:/usr/bin" },
  });
  assert.equal(exit, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, BIN);
  assert.deepEqual(calls[0].args, ["update", "--handoff"]);
  assert.deepEqual(calls[0].options.env, { PATH: "/opt/herdr/bin:/usr/bin", HOME: "/home/me", XDG_CONFIG_HOME: "/home/me/.cfg" });
  assert.equal(calls[0].options.cwd, "/home/me");
  const status = await subject.runStatus();
  assert.equal(status.state, "succeeded");
  assert.equal(status.exitCode, 0);
  assert.equal(status.detail, null);
  assert.match(status.log, /Handed off 3 panes/u);
});

test("a package-manager refusal is the run's reason, in Herdr's own words", async (context) => {
  const dir = await scratch(context);
  const subject = updater(dir, fakes());
  await subject.start();
  const refusal = "error: self-update is disabled for Homebrew installs; run `brew update && brew upgrade herdr`";
  for (const exit of [1, 0]) {
    const { spawnImpl } = fakeSpawn(`${refusal}\n`, exit);
    assert.equal(await runHerdrUpdateScript({ stateDir: dir.stateDir, binary: BIN, spawnImpl, environment: SERVICE_ENV }), 1);
    const status = await subject.runStatus();
    assert.equal(status.state, "failed");
    assert.equal(status.reason, "self_update_refused");
    assert.equal(status.detail, refusal);
  }
  const { spawnImpl } = fakeSpawn("Downloading…\nerror: download failed: 404\n", 2);
  assert.equal(await runHerdrUpdateScript({ stateDir: dir.stateDir, binary: BIN, spawnImpl, environment: SERVICE_ENV }), 2);
  const failed = await subject.runStatus();
  assert.equal(failed.reason, "script_failed");
  assert.equal(failed.detail, "error: download failed: 404");
  await assert.rejects(runHerdrUpdateScript({ stateDir: dir.stateDir, binary: "herdr", spawnImpl }), TypeError);
  const broken = await runHerdrUpdateScript({
    stateDir: dir.stateDir, binary: BIN, environment: SERVICE_ENV, spawnImpl: () => { throw new Error("spawn EACCES"); },
  });
  assert.equal(broken, -1);
});

test("a finished run makes the last look stale, so the new version shows", async (context) => {
  const dir = await scratch(context);
  const fake = fakes();
  const subject = updater(dir, fake, { now: () => Date.now() });
  await subject.start();
  fake.version = "herdr 0.9.5\n";
  const { spawnImpl } = fakeSpawn("ok\n", 0);
  await runHerdrUpdateScript({ stateDir: dir.stateDir, binary: BIN, spawnImpl, environment: SERVICE_ENV });
  const after = await subject.check({ fresh: true });
  assert.equal(after.current, "0.9.5");
  assert.equal(after.available, false);
});

test("what a connected PC says about Herdr is held to what the page shows", () => {
  const check = cleanHerdrCheck({
    checkedAt: "2026-10-19T00:00:00.000Z", current: "0.9.3<script>", latest: "0.9.5", channel: "nightly",
    available: "yes", notes: `${"n".repeat(4_000)}\u001b[2J`, blocked: "Not A Code", error: null, extra: "x",
  });
  assert.deepEqual(Object.keys(check).sort(), ["available", "blocked", "channel", "checkedAt", "current", "error", "latest", "notes"]);
  assert.equal(check.current, null);
  assert.equal(check.latest, "0.9.5");
  assert.equal(check.channel, null);
  assert.equal(check.available, false);
  assert.equal(check.notes.length, MAX_HERDR_NOTES);
  assert.equal(check.blocked, null);
  assert.equal(cleanHerdrCheck("nope"), null);
  const status = cleanHerdrRunStatus({ state: "exploded", log: "x\n".repeat(20_000), detail: `a\u0007${"d".repeat(900)}`, boot: "b" });
  assert.equal(status.state, "idle");
  assert.ok(Buffer.byteLength(status.log) <= MAX_LOG_BYTES);
  assert.ok(status.detail.length <= 300);
  assert.equal("boot" in status, false);
});

test("HerdRabbit's check carries Herdr's, and neither update starts while the other runs", async (context) => {
  const dir = await scratch(context);
  let herdrState = "idle";
  const herdr = {
    starting: false,
    async check() { return { current: "0.9.3", latest: "0.9.5", available: true }; },
    async runStatus() { return { state: herdrState }; },
  };
  const app = new AppUpdater({
    version: "1.0.0", repository: dir.root, stateDir: dir.stateDir, platform: "linux", herdr,
    exec: async () => ({ code: 1, stdout: "" }),
  });
  const check = await app.check();
  assert.equal(check.error, "not_git");
  assert.deepEqual(check.herdr, { current: "0.9.3", latest: "0.9.5", available: true });
  herdrState = "running";
  await assert.rejects(app.start(), { status: 409, code: "update_running" });
  assert.equal((await app.check({ fresh: true })).blocked, "running");
  // Without a Herdr updater the answer is as it was.
  const plain = new AppUpdater({ version: "1.0.0", repository: dir.root, stateDir: dir.stateDir, exec: async () => ({ code: 1, stdout: "" }) });
  assert.equal("herdr" in await plain.check(), false);
});

test("the page puts the dot up for a newer Herdr alone, and its confirm says panes are handed off", async () => {
  const { anyUpdate, herdrConfirmText, herdrBlockedText, herdrErrorText } = await import("../public/app-update.js");
  assert.equal(anyUpdate([{ supported: true, available: false, herdr: { available: true } }]), true);
  assert.equal(anyUpdate([{ supported: true, available: false, herdr: null }]), false);
  assert.equal(anyUpdate([{ supported: false, herdr: { available: true } }]), false);
  const text = herdrConfirmText("devbox", { current: "0.9.3", latest: "0.9.5" });
  assert.match(text, /^Update Herdr on devbox from 0\.9\.3 to 0\.9\.5\?/u);
  assert.match(text, /handoff/u);
  assert.match(text, /keep running/u);
  assert.match(herdrBlockedText("managed_install"), /package manager/u);
  assert.match(herdrErrorText("manifest_failed"), /herdr\.dev/u);
});

test("notes carry no direction marks that could disguise a line", () => {
  assert.equal(plainNotes("safe \u202eexe.txt\u202c and \u2066x\u2069"), "safe exe.txt and x");
});
