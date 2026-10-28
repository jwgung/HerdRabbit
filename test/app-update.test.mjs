import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppUpdater, MAX_LOG_BYTES, MAX_NOTES, MAX_RUN_MS, RESTART_WAIT_MS, OFFICIAL_ORIGINS, SERVICE_UNITS, cleanCheck, cleanLog, cleanRunStatus, execCommand, runLimiter,
  pluginRunEnvironment, runPluginUpdate, runUpdateScript, RUN_STEPS, SCRIPT_MARKERS, actionOutcome, invokedLogId, scriptPhase,
} from "../src/app-update.mjs";
import { EventEmitter } from "node:events";

// Git runs for real, in a scratch checkout whose origin is a bare repository
// beside it. The service manager never does: systemctl and systemd-run are
// answered here.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const PID = 4242;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function scratch(context) {
  const root = await mkdtemp(join(tmpdir(), "herdrabbit-update-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const publisher = join(root, "publisher");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", work);
  await writeFile(join(work, "package.json"), `${JSON.stringify({ version: "1.0.0" })}\n`);
  git(work, "add", "package.json");
  git(work, "commit", "--quiet", "-m", "First release");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "--quiet", "-u", "origin", "main");
  git(root, "clone", "--quiet", origin, publisher);
  let count = 0;
  async function publish(subject, version) {
    count += 1;
    if (version) await writeFile(join(publisher, "package.json"), `${JSON.stringify({ version })}\n`);
    await writeFile(join(publisher, `change-${count}.txt`), subject);
    git(publisher, "add", ".");
    git(publisher, "commit", "--quiet", "-m", subject);
    git(publisher, "push", "--quiet", "origin", "main");
  }
  return { root, origin, work, publish, stateDir: join(root, "state") };
}

// systemctl and systemd-run as a test says they answer; git for real.
function services(work, overrides = {}) {
  const state = {
    loaded: "herdrabbit.service", workingDirectory: work, mainPid: PID, active: "active", runCode: 0, calls: [], ...overrides,
  };
  state.exec = async (file, args, options) => {
    state.calls.push([file, ...args]);
    if (file === "git") return execCommand(file, args, options);
    if (file === "systemctl") {
      assert.equal(args[0], "--user");
      if (args[1] === "show") {
        if (state.unknownUnits?.includes(args[2])) return { code: 1, stdout: "" };
        const loaded = args[2] === state.loaded;
        return { code: 0, stdout: [
          `LoadState=${loaded ? "loaded" : "not-found"}`,
          `WorkingDirectory=${loaded ? state.workingDirectory : ""}`,
          `MainPID=${loaded ? state.mainPid : 0}`,
        ].join("\n") };
      }
      if (args[1] === "is-active") return { code: state.active === "active" ? 0 : 3, stdout: `${state.active}\n` };
    }
    if (file === "systemd-run") return { code: state.runCode, stdout: "" };
    throw new Error(`unexpected command ${file}`);
  };
  return state;
}

function updater(repo, fake, extra = {}) {
  return new AppUpdater({
    version: "1.0.0", repository: repo.work, stateDir: repo.stateDir, exec: fake.exec, pid: PID, platform: "linux",
    environment: GIT_ENV, nodeBin: "/opt/node/bin/node", originAllowed: (url) => url === repo.origin, ...extra,
  });
}

const fetches = (fake) => fake.calls.filter((call) => call[0] === "git" && call[1] === "fetch").length;

test("a checkout level with origin is up to date", async (context) => {
  const repo = await scratch(context);
  const result = await updater(repo, services(repo.work)).check();
  const sha = git(repo.work, "rev-parse", "--short", "HEAD");
  assert.deepEqual({ ...result, checkedAt: null }, {
    checkedAt: null,
    current: { sha, version: "1.0.0" },
    latest: { sha, version: "1.0.0" },
    available: false, notes: [], blocked: null, error: null, mode: "script",
  });
});

test("new commits on origin are an update, with their subjects as notes", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Fix the sidebar");
  await repo.publish("Release 1.0.1", "1.0.1");
  const result = await updater(repo, services(repo.work)).check();
  assert.equal(result.available, true);
  assert.equal(result.blocked, null);
  assert.deepEqual(result.notes, ["Release 1.0.1", "Fix the sidebar"]);
  assert.deepEqual(result.latest, { sha: git(repo.origin, "rev-parse", "--short", "main"), version: "1.0.1" });
  assert.equal(result.current.version, "1.0.0");
  // Nothing in the checkout moved: a check only fetches.
  assert.equal(git(repo.work, "rev-parse", "HEAD"), git(repo.work, "rev-parse", "main"));
  assert.equal(git(repo.work, "status", "--porcelain"), "");
});

test("local changes block an update, as update.sh would", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Next");
  await writeFile(join(repo.work, "notes.txt"), "mine");
  const result = await updater(repo, services(repo.work)).check();
  assert.equal(result.available, true);
  assert.equal(result.blocked, "local_changes");
});

test("a local main with its own commits has diverged", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  await writeFile(join(repo.work, "local.txt"), "local");
  git(repo.work, "add", "local.txt");
  git(repo.work, "commit", "--quiet", "-m", "Local only");
  const result = await updater(repo, services(repo.work)).check();
  assert.equal(result.available, true);
  assert.equal(result.blocked, "diverged");
  assert.deepEqual(result.notes, ["Upstream"]);
});

test("a checkout on another branch is not updated", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  git(repo.work, "checkout", "--quiet", "-b", "feature");
  assert.equal((await updater(repo, services(repo.work)).check()).blocked, "not_main");
});

test("only the service's own process, in this checkout, may update", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  for (const overrides of [
    { loaded: "nothing.service" },
    { mainPid: 1 },
    { workingDirectory: repo.root },
  ]) {
    assert.equal((await updater(repo, services(repo.work, overrides)).check()).blocked, "not_service", JSON.stringify(overrides));
  }
  // The older unit name counts too, as it does for update.sh.
  assert.equal((await updater(repo, services(repo.work, { loaded: "herdr-web-local.service" })).check()).blocked, null);
  assert.equal((await updater(repo, services(repo.work), { platform: "darwin" }).check()).blocked, "not_service");
});

test("an origin update.sh does not update from blocks it, and is never repeated", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  const fake = services(repo.work);
  const result = await updater(repo, fake, { originAllowed: () => false }).check();
  assert.equal(result.blocked, "wrong_origin");
  assert.equal(fetches(fake), 0, "an address that is not the official one was fetched from");
  assert.doesNotMatch(JSON.stringify(result), /origin\.git/u);
});

test("an origin that cannot be reached is a failed check, not an update", async (context) => {
  const repo = await scratch(context);
  await rm(repo.origin, { recursive: true });
  const result = await updater(repo, services(repo.work)).check();
  assert.equal(result.error, "fetch_failed");
  assert.equal(result.available, false);
  assert.doesNotMatch(JSON.stringify(result), /origin\.git/u);
});

test("checks are coalesced: one fetch at a time, and a recent one is the answer", async (context) => {
  const repo = await scratch(context);
  const fake = services(repo.work);
  let now = 1_000_000;
  const subject = updater(repo, fake, { now: () => now });
  const [first, second] = await Promise.all([subject.check(), subject.check()]);
  assert.equal(fetches(fake), 1);
  assert.deepEqual(first, second);
  now += 30_000;
  await subject.check();
  assert.equal(fetches(fake), 1, "a check under a minute old is reused");
  await subject.check({ fresh: true });
  assert.equal(fetches(fake), 2, "the Check button may ask again after ten seconds");
  await subject.check({ fresh: true });
  assert.equal(fetches(fake), 2);
  now += 61_000;
  await subject.check();
  assert.equal(fetches(fake), 3);
});

test("starting runs update.sh in a unit of its own, with a fixed command line", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Release 1.0.1", "1.0.1");
  const fake = services(repo.work);
  let now = 1_700_000_000_000;
  const subject = updater(repo, fake, { now: () => now });
  const status = await subject.start();
  assert.equal(status.state, "running");
  const run = fake.calls.filter((call) => call[0] === "systemd-run");
  assert.equal(run.length, 1);
  assert.deepEqual(run[0], [
    "systemd-run", "--user", "--unit=herdrabbit-update-1700000000000", "--collect", "--quiet",
    `--property=WorkingDirectory=${repo.work}`,
    `--setenv=PATH=${["/opt/node/bin", GIT_ENV.PATH].filter(Boolean).join(":")}`,
    "/opt/node/bin/node", join(repo.work, "scripts", "run-update.mjs"), repo.stateDir,
  ]);
  // One at a time: a run in progress blocks the next, and the check says so without fetching.
  const before = fetches(fake);
  await assert.rejects(subject.start(), { status: 409, code: "update_running" });
  assert.equal((await subject.check({ fresh: true })).blocked, "running");
  assert.equal(fetches(fake), before);
  // Its unit gone without a word: cut short, not running for ever.
  fake.active = "inactive";
  now += 11_000;
  const ended = await subject.runStatus();
  assert.equal(ended.state, "failed");
  assert.equal(ended.reason, "interrupted");
  // And not started again within the minute.
  now += 5_000;
  await assert.rejects(subject.start(), { status: 429, code: "too_many_requests" });
});

test("a run being started is not interrupted before its unit exists", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Release 1.0.1", "1.0.1");
  const fake = services(repo.work);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const inner = fake.exec;
  fake.exec = async (file, args, options) => {
    if (file === "systemd-run") { fake.calls.push(["systemd-run-pending"]); await pending; }
    return inner(file, args, options);
  };
  let now = 1_700_000_000_000;
  const subject = updater(repo, fake, { now: () => now });
  const starting = subject.start();
  // Wait until the record is written and systemd-run is pending.
  while (!fake.calls.some((call) => call[0] === "systemd-run-pending")) await new Promise((resolve) => setImmediate(resolve));
  fake.active = "inactive";
  assert.equal((await subject.runStatus()).state, "running");
  now += 30_000;
  assert.equal((await subject.runStatus()).state, "running", "still starting, however long");
  fake.active = "active";
  release();
  assert.equal((await starting).state, "running");
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.match(record.unit, /^herdrabbit-update-/u);
  // A fresh run is also given a moment after systemd-run returns.
  fake.active = "inactive";
  now = 1_700_000_000_000 + 1_000;
  assert.equal((await subject.runStatus()).state, "running");
});

test("a symlinked update.log is refused and its target left alone", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  const fake = services(repo.work);
  await mkdir(repo.stateDir, { mode: 0o700 });
  const target = join(repo.root, "victim.txt");
  await writeFile(target, "precious");
  await symlink(target, join(repo.stateDir, "update.log"));
  await assert.rejects(updater(repo, fake).start(), { code: "update_state_unsafe" });
  assert.equal(await readFile(target, "utf8"), "precious");
  assert.equal(fake.calls.filter((call) => call[0] === "systemd-run").length, 0);
});

test("a symlinked state folder is refused", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  const fake = services(repo.work);
  const real = join(repo.root, "elsewhere");
  await mkdir(real);
  await symlink(real, repo.stateDir);
  await assert.rejects(updater(repo, fake).start(), { code: "update_state_unsafe" });
  assert.equal((await lstat(repo.stateDir)).isSymbolicLink(), true);
  assert.deepEqual(await (await import("node:fs/promises")).readdir(real), []);
  assert.equal(fake.calls.filter((call) => call[0] === "systemd-run").length, 0);
});

test("the state folder is made private", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  await mkdir(repo.stateDir, { mode: 0o755 });
  await chmod(repo.stateDir, 0o755);
  await updater(repo, services(repo.work)).start();
  assert.equal((await lstat(repo.stateDir)).mode & 0o777, 0o700);
});

test("an update that would stop is refused before anything starts", async (context) => {
  const repo = await scratch(context);
  const fake = services(repo.work);
  await assert.rejects(updater(repo, fake).start(), { status: 409, code: "up_to_date" });
  await repo.publish("Upstream");
  await writeFile(join(repo.work, "notes.txt"), "mine");
  await assert.rejects(updater(repo, fake).start(), { status: 409, code: "update_blocked" });
  assert.equal(fake.calls.filter((call) => call[0] === "systemd-run").length, 0);
  assert.equal((await updater(repo, fake).runStatus()).state, "idle");
});

test("a unit that does not start is a failed run", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  const subject = updater(repo, services(repo.work, { runCode: 1 }));
  await assert.rejects(subject.start(), { status: 502, code: "update_start_failed" });
  const status = await subject.runStatus();
  assert.equal(status.state, "failed");
  assert.equal(status.reason, "start_failed");
  // nothing started, so the minute is not used up: a second try goes ahead
  await assert.rejects(subject.start(), { status: 502, code: "update_start_failed" });
});

test("a run whose shell cannot even be started is recorded as failed, not left running", async (context) => {
  const repo = await scratch(context);
  const subject = updater(repo, services(repo.work));
  await repo.publish("Upstream");
  await subject.start();
  const exit = await runUpdateScript({
    repository: repo.work, stateDir: repo.stateDir, script: join(repo.root, "never.sh"),
    spawnImpl: () => { throw new Error("spawn EMFILE"); },
  });
  assert.equal(exit, -1);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.state, "failed");
  assert.equal(record.reason, "script_failed");
});

test("the service units and official addresses here are the ones update.sh uses", async () => {
  const script = await readFile(new URL("../update.sh", import.meta.url), "utf8");
  for (const unit of SERVICE_UNITS) assert.match(script, new RegExp(`UPDATE_SERVICE=${unit.replace(".", "\\.")}`, "u"), `${unit} is not in update.sh`);
  const allowed = script.match(/^\s*(https:\/\/github\.com\/ultivis-iot[^)]*)\)\s*;;/mu)?.[1].split("|").map((origin) => origin.trim());
  assert.deepEqual(new Set(allowed), OFFICIAL_ORIGINS, "update.sh and the app allow different origins");
});

test("the run records how update.sh ended and keeps its output as the log", async (context) => {
  const repo = await scratch(context);
  const subject = updater(repo, services(repo.work));
  await repo.publish("Upstream");
  await subject.start();
  // A stand-in for update.sh: never the real one.
  const script = join(repo.root, "fake-update.sh");
  await writeFile(script, "echo '  > Fetching main'\necho 'From https://user:secret@example.invalid/x'\necho '  x verification failed' >&2\nexit 3\n");
  await chmod(script, 0o700);
  assert.equal(await runUpdateScript({ repository: repo.work, stateDir: repo.stateDir, script }), 3);
  const status = await subject.runStatus();
  assert.equal(status.state, "failed");
  assert.equal(status.exitCode, 3);
  assert.equal(status.reason, "script_failed");
  assert.match(status.log, /Fetching main/u);
  assert.match(status.log, /verification failed/u);
  assert.doesNotMatch(status.log, /secret/u);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.match(record.unit, /^herdrabbit-update-\d+$/u);

  await writeFile(script, "echo done\n");
  assert.equal(await runUpdateScript({ repository: repo.work, stateDir: repo.stateDir, script }), 0);
  assert.equal((await subject.runStatus()).state, "succeeded");
});

test("what a connected PC says about its update is held to the shape shown here", () => {
  const cleaned = cleanCheck({
    checkedAt: "2026-10-17T00:00:00.000Z",
    current: { sha: "abc1234", version: "2.0.0", extra: "x" },
    latest: { sha: "<script>", version: "2.0.1" },
    available: "yes",
    notes: [...Array.from({ length: 40 }, (_, index) => `note ${index}`), 42, "x".repeat(500), "bad\u001b[2Jline"],
    blocked: "Local changes!",
    error: "fetch_failed",
    remote: "https://token@github.com/x",
  });
  assert.equal(cleaned.available, false);
  assert.deepEqual(cleaned.current, { sha: "abc1234", version: "2.0.0" });
  assert.deepEqual(cleaned.latest, { sha: null, version: "2.0.1" });
  assert.equal(cleaned.notes.length, MAX_NOTES);
  assert.equal(cleaned.blocked, null);
  assert.equal(cleaned.error, "fetch_failed");
  assert.equal("remote" in cleaned, false);
  assert.equal(cleaned.mode, null);
  assert.equal(cleanCheck({ mode: "plugin" }).mode, "plugin");
  const long = cleanCheck({ notes: ["x".repeat(500), "bad\u001b[2Jline"] });
  assert.equal(long.notes[0].length, 200);
  assert.equal(long.notes[1], "bad [2Jline");

  const status = cleanRunStatus({ state: "exploded", exitCode: 1.5, log: `${"line\n".repeat(5000)}end`, boot: "x" });
  assert.equal(status.state, "idle");
  assert.equal(status.exitCode, null);
  assert.ok(Buffer.byteLength(status.log) <= MAX_LOG_BYTES);
  assert.ok(status.log.split("\n").length <= 40);
  assert.match(status.log, /end$/u);
  assert.equal("boot" in status, false);
  assert.equal(cleanLog("\u001b[31mred\u001b[0m\r\nnext"), "red\nnext");
});

test("run starts forwarded from this page are limited per PC", () => {
  let now = 0;
  const allow = runLimiter(60_000, () => now);
  allow("local");
  allow("link_a");
  assert.throws(() => allow("local"), { status: 429 });
  now = 60_000;
  allow("local");
});

test("a PC with only the older service unit is still its service, even when systemctl fails on the newer name", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  const fake = services(repo.work, { loaded: "herdr-web-local.service", unknownUnits: ["herdrabbit.service"] });
  const result = await updater(repo, fake).check();
  assert.notEqual(result.blocked, "not_service", "the older unit was never looked at");
});

test("a run systemctl cannot tell about is not left running past any update's length", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  const fake = services(repo.work);
  let now = 1_700_000_000_000;
  const subject = updater(repo, fake, { now: () => now });
  await subject.start();
  fake.active = "";
  now += 20_000;
  assert.equal((await subject.runStatus()).state, "running");
  now += MAX_RUN_MS;
  const ended = await subject.runStatus();
  assert.equal(ended.state, "failed");
  assert.equal(ended.reason, "interrupted");
});

test("a unit systemctl says is active stays running, however long it takes", async (context) => {
  const repo = await scratch(context);
  await repo.publish("Upstream");
  const fake = services(repo.work);
  let now = 1_700_000_000_000;
  const subject = updater(repo, fake, { now: () => now });
  await subject.start();
  now += MAX_RUN_MS * 2;
  assert.equal((await subject.runStatus()).state, "running");
  await assert.rejects(subject.start(), { status: 409, code: "update_running" });
});

// Herdr's plugin checkout: a shallow clone left on a commit, on no branch.
async function pluginCheckout(repo) {
  const checkout = join(repo.root, "plugin-checkout");
  git(repo.root, "clone", "--quiet", "--depth", "1", `file://${repo.origin}`, checkout);
  git(checkout, "checkout", "--quiet", "--detach");
  git(checkout, "remote", "set-url", "origin", repo.origin);
  return checkout;
}

// A child process that has started, with the pid a test gives it.
function fakeSpawner(pid = 9191) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = pid;
    child.unref = () => { child.unrefed = true; };
    calls.at(-1).child = child;
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  return { calls, spawnImpl };
}

test("a plugin's checkout, on no branch and outside any service, is updated by Herdr", async (context) => {
  const repo = await scratch(context);
  const checkout = await pluginCheckout(repo);
  await repo.publish("Release 1.0.1", "1.0.1");
  const fake = services(repo.work, { loaded: "none" });
  const subject = updater({ ...repo, work: checkout }, fake, { plugin: { id: "herdrabbit", binary: "/opt/herdr" } });
  const result = await subject.check();
  assert.equal(result.available, true);
  assert.equal(result.blocked, null);
  assert.equal(result.mode, "plugin");
  assert.deepEqual(result.notes, ["Release 1.0.1"]);
  assert.equal(fake.calls.some((call) => call[0] === "systemctl"), false, "a plugin never asks systemd");
  // Without the plugin the same checkout cannot update itself.
  assert.equal((await updater({ ...repo, work: checkout }, fake).check()).blocked, "not_service");
});

test("a plugin run starts detached with a fixed command line and is followed by its pid", async (context) => {
  const repo = await scratch(context);
  const checkout = await pluginCheckout(repo);
  await repo.publish("Release 1.0.1", "1.0.1");
  const fake = services(repo.work, { loaded: "none" });
  const spawner = fakeSpawner();
  let alive = true;
  let now = 1_700_000_000_000;
  const subject = updater({ ...repo, work: checkout }, fake, {
    now: () => now, plugin: { id: "herdrabbit", binary: "/opt/herdr" }, spawnImpl: spawner.spawnImpl, alive: () => alive,
    environment: { ...GIT_ENV, HOME: repo.root },
  });
  assert.equal((await subject.start()).state, "running");
  assert.equal(fake.calls.some((call) => call[0] === "systemd-run"), false);
  assert.equal(spawner.calls.length, 1);
  const [call] = spawner.calls;
  assert.equal(call.file, "/opt/node/bin/node");
  assert.deepEqual(call.args, [join(checkout, "scripts", "run-update.mjs"), repo.stateDir, "--plugin", "herdrabbit", "/opt/herdr"]);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.cwd, repo.root);
  assert.equal(call.child.unrefed, true);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.pid, 9191);
  // Still going while its process is; cut short once it is gone without a word.
  now += 30_000;
  assert.equal((await subject.runStatus()).state, "running");
  alive = false;
  const ended = await subject.runStatus();
  assert.equal(ended.state, "failed");
  assert.equal(ended.reason, "interrupted");
});

test("a plugin run is told the plugin's folders when Herdr named them, and only absolute ones", async (context) => {
  const repo = await scratch(context);
  const checkout = await pluginCheckout(repo);
  await repo.publish("Release 1.0.1", "1.0.1");
  const runArgs = async (folders) => {
    const spawner = fakeSpawner();
    const subject = updater({ ...repo, work: checkout }, services(repo.work, { loaded: "none" }), {
      plugin: { id: "herdrabbit", binary: "/opt/herdr", ...folders }, spawnImpl: spawner.spawnImpl, alive: () => true,
    });
    await subject.start();
    await rm(join(repo.stateDir, "update-state.json"));
    return spawner.calls[0].args.slice(1);
  };
  assert.deepEqual(await runArgs({ configDir: "/cfg", stateDir: "/st" }), [repo.stateDir, "--plugin", "herdrabbit", "/opt/herdr", "/cfg", "/st"]);
  assert.deepEqual(await runArgs({ configDir: "cfg", stateDir: "/st" }), [repo.stateDir, "--plugin", "herdrabbit", "/opt/herdr"]);
});

test("a plugin run whose process cannot start is a failed run", async (context) => {
  const repo = await scratch(context);
  const checkout = await pluginCheckout(repo);
  await repo.publish("Release 1.0.1", "1.0.1");
  const subject = updater({ ...repo, work: checkout }, services(repo.work, { loaded: "none" }), {
    plugin: { id: "herdrabbit", binary: "/opt/herdr" },
    spawnImpl: () => { throw new Error("spawn EAGAIN"); },
  });
  await assert.rejects(subject.start(), { status: 502, code: "update_start_failed" });
  const status = await subject.runStatus();
  assert.equal(status.state, "failed");
  assert.equal(status.reason, "start_failed");
});

// A stand-in for herdr that writes down what it was asked and fails where told.
// `invoke` is what `plugin action invoke` prints; `logs` the JSON lines
// `plugin log list` prints, one per call (the last one repeats); `root` the
// checkout `plugin list --json` names.
async function fakeHerdr(root, { failUpdate = false, failRestart = false, invoke = "HerdRabbit restarted", logs = [], pluginRoot = null } = {}) {
  const binary = join(root, "fake-herdr");
  const asked = join(root, "asked.txt");
  const calls = join(root, "log-calls.txt");
  const lines = [
    "#!/bin/sh",
    `echo "$*" >> '${asked}'`,
    `[ "$2" = update ] && { echo 'Updated herdrabbit.'; ${failUpdate ? "exit 4" : "exit 0"}; }`,
    `[ "$2" = action ] && { printf '%s\\n' '${invoke}'; ${failRestart ? "echo 'herdr: server not reachable' >&2; exit 5" : "exit 0"}; }`,
  ];
  for (const [index, answer] of logs.entries()) {
    await writeFile(join(root, `log-${index}.json`), answer);
  }
  lines.push(
    `[ "$2" = log ] && { echo x >> '${calls}'; n=$(wc -l < '${calls}'); i=$((n - 1)); [ "$i" -ge ${Math.max(logs.length, 1)} ] && i=${Math.max(logs.length - 1, 0)}; cat '${root}'/log-$i.json; exit 0; }`,
    `[ "$2" = list ] && { printf '%s\\n' '${JSON.stringify({ id: "cli:plugin", result: { type: "plugin_list", plugins: pluginRoot ? [{ plugin_id: "herdrabbit", plugin_root: pluginRoot }] : [] } })}'; exit 0; }`,
    "exit 9",
  );
  await writeFile(binary, lines.join("\n"));
  await chmod(binary, 0o700);
  return { binary, asked: async () => (await readFile(asked, "utf8")).trim().split("\n") };
}

// Herdr's answer to `plugin action invoke`, and its log of that action.
const INVOKED = JSON.stringify({ id: "cli:plugin", result: { type: "plugin_action_invoked", log: { log_id: "plugin-log-35" } } });
const actionLog = (fields) => JSON.stringify({
  id: "cli:plugin",
  result: {
    type: "plugin_log_list",
    logs: [
      { log_id: "plugin-log-34", action_id: "restart", status: "succeeded", exit_code: 0, finished_unix_ms: 1 },
      { log_id: "plugin-log-35", action_id: "restart", plugin_id: "herdrabbit", started_unix_ms: 2, stdout: "", stderr: "", ...fields },
    ],
  },
});
const SPAWN_FAILED = actionLog({ status: "failed", error: "No such file or directory (os error 2)", finished_unix_ms: 3 });

// A new checkout as Herdr installs it, and a stand-in for node that writes
// down how it was run and exits as told.
async function newCheckout(root, { exit = 0 } = {}) {
  const checkout = join(root, "new-checkout");
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await writeFile(join(checkout, "scripts", "plugin.mjs"), "");
  const node = join(root, "fake-node");
  const ran = join(root, "node-ran.txt");
  await writeFile(node, [
    "#!/bin/sh",
    `echo "$* | $PWD | $HERDR_PLUGIN_ID | $HERDR_PLUGIN_ROOT | $HERDR_PLUGIN_CONFIG_DIR | $HERDR_PLUGIN_STATE_DIR | $HERDR_BIN_PATH" >> '${ran}'`,
    "echo 'HerdRabbit restarted directly'",
    `exit ${exit}`,
  ].join("\n"));
  await chmod(node, 0o700);
  return { checkout, node, ran: async () => (await readFile(ran, "utf8").catch(() => "")).trim().split("\n").filter(Boolean) };
}

const pluginRun = (repo, herdr, extra = {}) => runPluginUpdate({
  stateDir: repo.stateDir, id: "herdrabbit", binary: herdr.binary, cwd: repo.root,
  sleep: async () => {}, environment: { PATH: "/usr/bin", HOME: repo.root, SECRET: "s" }, ...extra,
});

test("the plugin run updates the plugin, then restarts it, and records how it ended", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  const herdr = await fakeHerdr(repo.root);
  assert.equal(await runPluginUpdate({ stateDir: repo.stateDir, id: "herdrabbit", binary: herdr.binary, cwd: repo.root }), 0);
  assert.deepEqual(await herdr.asked(), ["plugin update herdrabbit --yes", "plugin action invoke herdrabbit.restart"]);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.state, "succeeded");
  assert.equal(record.phase, "restart");
  const log = await readFile(join(repo.stateDir, "update.log"), "utf8");
  assert.match(log, /Updated herdrabbit\.\n {2}> Restarting HerdRabbit\nHerdRabbit restarted/u);
});

test("a failed plugin update restarts nothing", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  const herdr = await fakeHerdr(repo.root, { failUpdate: true });
  assert.equal(await runPluginUpdate({ stateDir: repo.stateDir, id: "herdrabbit", binary: herdr.binary, cwd: repo.root }), 4);
  assert.deepEqual(await herdr.asked(), ["plugin update herdrabbit --yes"]);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.state, "failed");
  assert.equal(record.reason, "update_failed");
  assert.equal(record.phase, "fetch");
});

test("a plugin that updated but did not restart says so", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  const herdr = await fakeHerdr(repo.root, { failRestart: true });
  // No plugin folders were named: the restart is not tried directly.
  assert.equal(await runPluginUpdate({ stateDir: repo.stateDir, id: "herdrabbit", binary: herdr.binary, cwd: repo.root }), 1);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.reason, "restart_failed");
  assert.equal(record.phase, "restart");
  assert.match(record.detail, /^herdr: server not reachable; the plugin's folders are unknown/u);
  await assert.rejects(runPluginUpdate({ stateDir: repo.stateDir, id: "../x", binary: herdr.binary }), TypeError);
});

test("a restart Herdr ran and finished is the run's success, with nothing restarted twice", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  const fresh = await newCheckout(repo.root);
  const running = actionLog({ status: "running" });
  const done = actionLog({ status: "succeeded", exit_code: 0, finished_unix_ms: 3 });
  const herdr = await fakeHerdr(repo.root, { invoke: INVOKED, logs: [running, done], pluginRoot: fresh.checkout });
  const dirs = { configDir: join(repo.root, "cfg"), stateDir: join(repo.root, "pstate") };
  assert.equal(await pluginRun(repo, herdr, { pluginDirs: dirs, nodeBin: fresh.node }), 0);
  assert.deepEqual(await herdr.asked(), [
    "plugin update herdrabbit --yes", "plugin action invoke herdrabbit.restart",
    "plugin log list --plugin herdrabbit --limit 50", "plugin log list --plugin herdrabbit --limit 50",
  ]);
  assert.deepEqual(await fresh.ran(), []);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.state, "succeeded");
  assert.equal(record.detail, null);
});

test("a restart action Herdr could not start is done directly from the new checkout", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  const fresh = await newCheckout(repo.root);
  const herdr = await fakeHerdr(repo.root, { invoke: INVOKED, logs: [SPAWN_FAILED], pluginRoot: fresh.checkout });
  const dirs = { configDir: join(repo.root, "cfg"), stateDir: join(repo.root, "pstate") };
  assert.equal(await pluginRun(repo, herdr, { pluginDirs: dirs, nodeBin: fresh.node }), 0);
  assert.ok((await herdr.asked()).includes("plugin list --plugin herdrabbit --json"));
  // node scripts/plugin.mjs restart, in the new checkout, with the folders Herdr gives actions
  assert.deepEqual(await fresh.ran(), [[
    `${join(fresh.checkout, "scripts", "plugin.mjs")} restart`, fresh.checkout, "herdrabbit", fresh.checkout,
    dirs.configDir, dirs.stateDir, herdr.binary,
  ].join(" | ")]);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.state, "succeeded");
  assert.equal(record.reason, null);
  const log = await readFile(join(repo.stateDir, "update.log"), "utf8");
  assert.match(log, /Herdr could not restart HerdRabbit: No such file or directory \(os error 2\)/u);
  assert.match(log, /HerdRabbit restarted directly\n {2}> Restarted directly/u);
});

test("a restart neither Herdr nor the run managed is a failed run that says why", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  const fresh = await newCheckout(repo.root, { exit: 1 });
  const herdr = await fakeHerdr(repo.root, { invoke: INVOKED, logs: [SPAWN_FAILED], pluginRoot: fresh.checkout });
  const dirs = { configDir: join(repo.root, "cfg"), stateDir: join(repo.root, "pstate") };
  assert.equal(await pluginRun(repo, herdr, { pluginDirs: dirs, nodeBin: fresh.node }), 1);
  assert.equal((await fresh.ran()).length, 1);
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.state, "failed");
  assert.equal(record.reason, "restart_failed");
  assert.equal(record.phase, "restart");
  assert.equal(record.detail, "No such file or directory (os error 2); the direct restart exited with 1");
  // A checkout Herdr does not name (or that holds no plugin.mjs) is not run at all.
  const other = await scratch(context);
  await mkdir(other.stateDir, { mode: 0o700 });
  const nameless = await fakeHerdr(other.root, { invoke: INVOKED, logs: [SPAWN_FAILED] });
  const node = await newCheckout(other.root);
  assert.equal(await pluginRun(other, nameless, { pluginDirs: dirs, nodeBin: node.node }), 1);
  assert.deepEqual(await node.ran(), []);
  assert.match(JSON.parse(await readFile(join(other.stateDir, "update-state.json"), "utf8")).detail, /new checkout could not be found/u);
});

test("a restart still running when the wait is over is left to the server that answers next", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  const fresh = await newCheckout(repo.root);
  const herdr = await fakeHerdr(repo.root, { invoke: INVOKED, logs: [actionLog({ status: "running" })], pluginRoot: fresh.checkout });
  let now = 1_700_000_000_000;
  const exit = await pluginRun(repo, herdr, {
    pluginDirs: { configDir: "/cfg", stateDir: "/st" }, nodeBin: fresh.node, now: () => now, sleep: async (ms) => { now += ms; },
  });
  assert.equal(exit, 0);
  assert.deepEqual(await fresh.ran(), []);
  const polls = (await herdr.asked()).filter((call) => call.startsWith("plugin log list")).length;
  assert.ok(polls >= 30 && polls <= 32, String(polls));
});

test("Herdr's action log is read for the outcome of the restart it queued", () => {
  assert.equal(invokedLogId(INVOKED), "plugin-log-35");
  assert.equal(invokedLogId('{"log":{"log_id":"plugin-log-2"}}'), "plugin-log-2");
  assert.equal(invokedLogId("HerdRabbit restarted"), null);
  assert.equal(invokedLogId('{"result":{"log":{"log_id":"bad id; rm"}}}'), null);
  assert.deepEqual(actionOutcome(undefined), { outcome: "pending", detail: null });
  assert.deepEqual(actionOutcome({ status: "running" }), { outcome: "pending", detail: null });
  assert.deepEqual(actionOutcome({ status: "succeeded", exit_code: 0, finished_unix_ms: 1 }), { outcome: "ok", detail: null });
  assert.deepEqual(actionOutcome({ status: "failed", error: "No such file or directory (os error 2)", finished_unix_ms: 1 }),
    { outcome: "failed", detail: "No such file or directory (os error 2)" });
  assert.deepEqual(actionOutcome({ status: "failed", exit_code: 1, finished_unix_ms: 1, stdout: "stopped\nnot answering in 15s\n" }),
    { outcome: "failed", detail: "not answering in 15s -- exit code 1" });
  assert.ok(actionOutcome({ status: "failed", error: "x".repeat(1000) }).detail.length <= 300);
});

test("update.sh's step is read from the lines it logs", () => {
  assert.equal(scriptPhase(""), null);
  assert.equal(scriptPhase("", "verify"), "verify");
  const lines = [
    ["  > Fetching main in /home/me/HerdRabbit", "fetch"],
    ["  > Updating Herdr", "herdr"],
    ["  > Installing runtime dependencies", "install"],
    ["  > Verifying the updated code", "verify"],
    ["  > Restarting herdrabbit.service", "restart"],
    ["  > Updated to abc1234. Refresh the web app or PWA.", "done"],
  ];
  let log = "";
  for (const [text, phase] of lines) {
    log += `${text}\n`;
    assert.equal(scriptPhase(log), phase, text);
    assert.equal(scriptPhase(text, "fetch"), phase, text);
  }
  // Other output keeps the step it is at, wherever it comes from.
  assert.equal(scriptPhase("added 120 packages\n> herdrabbit@1.4.0 verify\nUpdating Herdr", "install"), "install");
  assert.equal(scriptPhase("  > Configuring Claude to use native terminal scrollback\n  x verification failed", "verify"), "verify");
  assert.equal(scriptPhase("  > Rolling back to abc1234", "verify"), "verify");
});

test("update.sh still prints every line the step is read from", async () => {
  const script = await readFile(new URL("../update.sh", import.meta.url), "utf8");
  for (const [marker, phase] of SCRIPT_MARKERS) {
    const logged = new RegExp(`^\\s*log "${marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[^"]*" # step: ${phase}$`, "mu");
    assert.match(script, logged, marker);
  }
  // Every step but the page's reload has a line, in the order update.sh runs them.
  const ids = SCRIPT_MARKERS.map(([, phase]) => phase).filter((phase) => phase !== "done");
  assert.deepEqual(ids, RUN_STEPS.script.map((step) => step.id).filter((id) => id !== "reload"));
});

test("the run's status names its steps and the one it is at", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  let now = 1_700_000_000_000;
  const write = (record) => writeFile(join(repo.stateDir, "update-state.json"), `${JSON.stringify(record)}\n`);
  const fake = services(repo.work, { active: "active" });
  const script = updater(repo, fake, { now: () => now });
  assert.deepEqual(await script.runStatus().then(({ state, phase, steps }) => ({ state, phase, steps: steps.length })),
    { state: "idle", phase: null, steps: 6 });
  await write({ state: "running", unit: "herdrabbit-update-1", startedAt: new Date(now).toISOString(), mode: "script" });
  await writeFile(join(repo.stateDir, "update.log"), "  > Fetching main in /x\n  > Updating Herdr\n");
  let status = await script.runStatus();
  assert.equal(status.mode, "script");
  assert.deepEqual(status.steps, RUN_STEPS.script);
  assert.equal(status.phase, "herdr");
  // Long output after a line keeps it; "Updated to" leaves only the reload.
  await writeFile(join(repo.stateDir, "update.log"), `  > Installing runtime dependencies\n${"npm output\n".repeat(200)}`);
  assert.equal((await script.runStatus()).phase, "install");
  await writeFile(join(repo.stateDir, "update.log"), "npm output only\n");
  assert.equal((await script.runStatus()).phase, "install", "the step seen last is kept");
  await writeFile(join(repo.stateDir, "update.log"), "  > Updated to abc1234.\n");
  assert.equal((await script.runStatus()).phase, "reload");
  // A failed run stays at the step it failed in.
  await write({ state: "failed", startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), reason: "script_failed", mode: "script" });
  await writeFile(join(repo.stateDir, "update.log"), "  > Verifying the updated code\n  x verification failed\n");
  status = await script.runStatus();
  assert.equal(status.phase, "verify");
  assert.equal(status.detail, null);

  // A plugin run's step is in its record, and its failure's detail with it.
  const plugin = updater(repo, services(repo.work, { loaded: "none" }), {
    now: () => now, plugin: { id: "herdrabbit", binary: "/opt/herdr" }, alive: () => true,
  });
  await write({ state: "running", startedAt: new Date(now).toISOString(), pid: 77, mode: "plugin", phase: "restart" });
  status = await plugin.runStatus();
  assert.deepEqual(status.steps, RUN_STEPS.plugin);
  assert.equal(status.phase, "restart");
  await write({
    state: "failed", startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), mode: "plugin",
    phase: "restart", reason: "restart_failed", detail: `No such file or directory (os error 2)\u001b[31m${"x".repeat(400)}`,
  });
  status = await plugin.runStatus();
  assert.equal(status.reason, "restart_failed");
  assert.equal(status.phase, "restart");
  assert.match(status.detail, /^No such file or directory \(os error 2\) \[31mx+$/u);
  assert.equal(status.detail.length, 300);
  // What a connected PC says about its steps is held to the same shape.
  const clean = cleanRunStatus({
    ...status, phase: "elsewhere", steps: [...status.steps, { id: "<script>", label: "x" }, { id: "fetch", label: 4 }],
  });
  assert.deepEqual(clean.steps, RUN_STEPS.plugin);
  assert.equal(clean.phase, null);
  assert.equal(cleanRunStatus({ mode: "other" }).mode, null);
  assert.deepEqual(cleanRunStatus({}).steps, []);
});

test("a plugin run whose pid was never written is cut short like any unnamed run", async (context) => {
  const repo = await scratch(context);
  await mkdir(repo.stateDir, { mode: 0o700 });
  let now = 1_700_000_000_000;
  const subject = updater(repo, services(repo.work, { loaded: "none" }), {
    now: () => now, plugin: { id: "herdrabbit", binary: "/opt/herdr" }, alive: () => true,
  });
  for (const pid of [undefined, 0, -3, "12"]) {
    await writeFile(join(repo.stateDir, "update-state.json"), `${JSON.stringify({ state: "running", startedAt: new Date(now).toISOString(), pid })}\n`);
    now += 11_000;
    assert.equal((await subject.runStatus()).reason, "interrupted", String(pid));
  }
  // A live pid is believed for no longer than any update could take.
  await writeFile(join(repo.stateDir, "update-state.json"), `${JSON.stringify({ state: "running", startedAt: new Date(now).toISOString(), pid: 77 })}\n`);
  now += MAX_RUN_MS + 1;
  assert.equal((await subject.runStatus()).reason, "interrupted");
});

test("a plugin with a bad id or no Herdr is not a plugin, and the run is given no settings", async (context) => {
  const repo = await scratch(context);
  for (const plugin of [{ id: "../x", binary: "/opt/herdr" }, { id: "herdrabbit" }, { id: "-rf", binary: "/opt/herdr" }]) {
    const result = await updater(repo, services(repo.work, { loaded: "none" }), { plugin }).check();
    assert.equal(result.blocked, "not_service", JSON.stringify(plugin));
  }
  const env = pluginRunEnvironment({
    HOME: "/home/me", XDG_RUNTIME_DIR: "/run/user/1", HERDR_WEB_AUTH_FILE: "/x", HERDR_BIN: "/h", SECRET: "s",
    HTTPS_PROXY: "http://proxy:3128", npm_config_registry: "https://npm.example", NODE_EXTRA_CA_CERTS: "/ca.pem",
  }, "/bin");
  assert.deepEqual(env, {
    PATH: "/bin", HOME: "/home/me", XDG_RUNTIME_DIR: "/run/user/1",
    HTTPS_PROXY: "http://proxy:3128", npm_config_registry: "https://npm.example", NODE_EXTRA_CA_CERTS: "/ca.pem",
  });
});

test("a plugin run's success is told by the server that replaced this one", async (context) => {
  const repo = await scratch(context);
  const checkout = await pluginCheckout(repo);
  await repo.publish("Release 1.0.1", "1.0.1");
  let now = 1_700_000_000_000;
  const options = (pid) => ({
    now: () => now, pid, plugin: { id: "herdrabbit", binary: "/opt/herdr" }, spawnImpl: fakeSpawner().spawnImpl, alive: () => true,
  });
  const old = updater({ ...repo, work: checkout }, services(repo.work, { loaded: "none" }), options(PID));
  await old.start();
  // The run queued the restart and ended; this server has not been replaced yet.
  const record = JSON.parse(await readFile(join(repo.stateDir, "update-state.json"), "utf8"));
  assert.equal(record.restartOf, PID);
  now += 20_000;
  await writeFile(join(repo.stateDir, "update-state.json"), `${JSON.stringify({ ...record, state: "succeeded", exitCode: 0, finishedAt: new Date(now).toISOString() })}\n`);
  assert.equal((await old.runStatus()).state, "running");
  const replacement = updater({ ...repo, work: checkout }, services(repo.work, { loaded: "none" }), options(PID + 1));
  assert.equal((await replacement.runStatus()).state, "succeeded");
  // A restart that never came is a failed run, not one waiting for ever.
  now += RESTART_WAIT_MS + 1;
  const late = await old.runStatus();
  assert.equal(late.state, "failed");
  assert.equal(late.reason, "restart_failed");
});
