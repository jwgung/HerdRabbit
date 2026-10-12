import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const source = await readFile(new URL("../update.sh", import.meta.url), "utf8");

async function runFixture(t, mode = "success") {
  const directory = await mkdtemp(join(tmpdir(), "herdr-update-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const repo = join(directory, "installed app");
  await mkdir(bin);
  await mkdir(repo);
  await writeFile(join(repo, "update.sh"), source);
  const fake = `#!/bin/sh
name=\${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$UPDATE_TEST_LOG"
case "$name:$*" in
  'node:scripts/check-herdr-version.mjs') [ "$UPDATE_TEST_MODE" != herdr-too-old ] ;;
  'node:scripts/service-environment.mjs HERDR_BIN') if [ "$UPDATE_TEST_MODE" = service-herdr ]; then printf '%s/custom-herdr\\n' "$UPDATE_TEST_BIN"; fi ;;
  'node:scripts/service-environment.mjs HERDR_WEB_ROLE') if [ "$UPDATE_TEST_MODE" = leaf ]; then printf 'leaf\\n'; fi ;;
  'node:'*) printf '22\\n' ;;
  'herdr:update --handoff'|'custom-herdr:update --handoff') [ "$UPDATE_TEST_MODE" != herdr-update-failed ] ;;
  'systemctl:'*'--property=Environment --value') if [ "$UPDATE_TEST_MODE" = service-herdr ]; then printf 'HERDR_WEB_PORT=38787 HERDR_BIN=%s/custom-herdr\\n' "$UPDATE_TEST_BIN"; fi ;;
  'git:rev-parse --show-toplevel') printf '%s\\n' "$UPDATE_TEST_REPO" ;;
  'git:remote get-url origin') printf 'https://github.com/ultivis-iot/HerdRabbit.git\\n' ;;
  'git:rev-parse --git-path herdrabbit-update.lock') printf '%s/lock\\n' "$UPDATE_TEST_REPO" ;;
  'git:branch --show-current') if [ "$UPDATE_TEST_MODE" = branch ]; then printf 'dev\\n'; else printf 'main\\n'; fi ;;
  'git:status --porcelain') if [ "$UPDATE_TEST_MODE" = dirty ]; then printf ' M local-file\\n'; fi ;;
  'git:fetch origin main') [ "$UPDATE_TEST_MODE" != fetch-failed ] ;;
  'git:merge-base --is-ancestor HEAD FETCH_HEAD') [ "$UPDATE_TEST_MODE" != diverged ] ;;
  'git:rev-parse --short HEAD') printf '123abcd\\n' ;;
  'git:archive FETCH_HEAD src') if [ "$UPDATE_TEST_MODE" = archive-failed ]; then exit 1; fi; tar -cf - -T /dev/null ;;
  'git:rev-parse HEAD') printf 'previous000\\n' ;;
  'git:rev-parse --short previous000') printf 'prev000\\n' ;;
  'systemctl:--user is-active --quiet'*) [ "$UPDATE_TEST_MODE" != inactive ] ;;
  'npm:run verify') [ "$UPDATE_TEST_MODE" != verify-failed ] ;;
  'npm:ci --omit=dev') [ "$UPDATE_TEST_MODE" != install-failed ] ;;
  'systemctl:'*'--property=LoadState --value') printf 'loaded\\n' ;;
  'systemctl:'*'--property=WorkingDirectory --value') if [ "$UPDATE_TEST_MODE" = wrong-service ]; then printf '/tmp\\n'; else printf '%s\\n' "$UPDATE_TEST_REPO"; fi ;;
esac
`;
  for (const command of ["node", "git", "npm", "systemctl", "herdr", "custom-herdr"]) {
    await writeFile(join(bin, command), fake, { mode: 0o755 });
  }
  const log = join(directory, "commands");
  let result;
  try {
    // The updater reads HERDR_BIN; one inherited from the shell (update.sh
    // exports the service's own) would run the real Herdr instead of the fake.
    const { HERDR_BIN: _inherited, ...environment } = process.env;
    result = await execute("sh", [join(repo, "update.sh")], { cwd: directory, env: {
      ...environment, PATH: `${bin}:${process.env.PATH}`, HERD_RABBIT_INSTALL_DIR: "",
      UPDATE_TEST_MODE: mode, UPDATE_TEST_REPO: repo, UPDATE_TEST_LOG: log, UPDATE_TEST_BIN: bin,
    } });
  } catch (error) { result = error; }
  return { result, commands: await readFile(log, "utf8") };
}

test("updater locates its installation and verifies before restarting without reconfiguring", async (t) => {
  const { result, commands } = await runFixture(t);
  assert.equal(result.code, undefined, result.stderr);
  assert.match(result.stdout, /Updated to 123abcd/);
  assert.ok(commands.indexOf("npm run verify") < commands.indexOf("systemctl --user restart"));
  assert.ok(commands.indexOf("node scripts/configure-claude.mjs") > commands.indexOf("npm run verify"));
  assert.ok(commands.indexOf("node scripts/configure-claude.mjs") < commands.indexOf("systemctl --user restart"));
  assert.ok(commands.indexOf("herdr update --handoff") < commands.indexOf("git merge --ff-only"), "Herdr before any file changes");
  assert.ok(commands.indexOf("node scripts/check-herdr-version.mjs") > commands.indexOf("herdr update --handoff"));
  assert.ok(commands.indexOf("node scripts/check-herdr-version.mjs") < commands.indexOf("git merge --ff-only"));
  assert.ok(commands.indexOf("git archive FETCH_HEAD src") < commands.indexOf("herdr update --handoff"),
    "the incoming code is read before Herdr is touched");
  assert.ok(commands.indexOf("git archive FETCH_HEAD src") < commands.indexOf("node scripts/check-herdr-version.mjs"),
    "Herdr is checked against the incoming code's minimum");
  assert.match(commands, /git merge --ff-only FETCH_HEAD/);
  assert.doesNotMatch(commands, /install-service|tailscale|reset --hard/);
});

test("updater updates the Herdr the service runs, not the shell's", async (t) => {
  const { result, commands } = await runFixture(t, "service-herdr");
  assert.equal(result.code, undefined, result.stderr);
  assert.match(commands, /custom-herdr update --handoff/);
  assert.doesNotMatch(commands, /^herdr update/m);
});

test("updater keeps the installed Herdr when its update fails but it is new enough", async (t) => {
  const { result, commands } = await runFixture(t, "herdr-update-failed");
  assert.equal(result.code, undefined, result.stderr);
  assert.match(result.stdout, /Herdr could not be updated/);
  assert.match(commands, /systemctl --user restart/);
});

test("updater stops a former leaf before changing anything and says how to move it over", async (t) => {
  const { result, commands } = await runFixture(t, "leaf");
  assert.notEqual(result.code, undefined);
  assert.match(result.stdout, /installed as a leaf/u);
  assert.match(result.stdout, /npm run install-service/u);
  assert.match(result.stderr, /nothing was changed/u);
  assert.doesNotMatch(commands, /git fetch|herdr update|git merge --ff-only|npm ci|systemctl --user restart/);
});

test("updater changes nothing, Herdr included, when it cannot read the new code", async (t) => {
  const { result, commands } = await runFixture(t, "archive-failed");
  assert.notEqual(result.code, undefined);
  assert.doesNotMatch(commands, /herdr update|git merge --ff-only|npm ci|systemctl --user restart/);
});

for (const mode of ["install-failed", "verify-failed"]) {
  test(`updater rolls back to the previous commit on ${mode}`, async (t) => {
    const { result, commands } = await runFixture(t, mode);
    assert.notEqual(result.code, undefined);
    assert.match(commands, /git reset --hard previous000/);
    assert.ok(commands.lastIndexOf("npm ci --omit=dev") > commands.indexOf("git reset --hard"));
    assert.match(result.stderr, /rolled back/);
  });
}

test("updater rolls back and restarts the previous version when the new one will not run", async (t) => {
  const { result, commands } = await runFixture(t, "inactive");
  assert.notEqual(result.code, undefined);
  const reset = commands.indexOf("git reset --hard previous000");
  assert.ok(reset > commands.indexOf("systemctl --user restart"));
  assert.ok(commands.indexOf("systemctl --user restart", reset) > reset, "the previous version is started again");
});

for (const mode of ["branch", "dirty", "wrong-service", "diverged", "fetch-failed", "install-failed", "verify-failed", "herdr-too-old"]) {
  test(`updater aborts without restarting on ${mode}`, async (t) => {
    const { result, commands } = await runFixture(t, mode);
    assert.notEqual(result.code, undefined);
    assert.doesNotMatch(commands, /systemctl --user restart/);
    if (["branch", "dirty", "wrong-service"].includes(mode)) assert.doesNotMatch(commands, /git fetch/);
    if (mode === "herdr-too-old") assert.doesNotMatch(commands, /git merge --ff-only|npm ci/, "a Herdr too old changes no file");
  });
}
