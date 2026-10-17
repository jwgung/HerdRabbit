import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppUpdater, MAX_LOG_BYTES, MAX_NOTES, OFFICIAL_ORIGINS, SERVICE_UNITS, cleanCheck, cleanLog, cleanRunStatus, execCommand, runLimiter, runUpdateScript,
} from "../src/app-update.mjs";

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
    available: false, notes: [], blocked: null, error: null,
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
