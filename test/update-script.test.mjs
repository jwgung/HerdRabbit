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
  'git:archive FETCH_HEAD src') tar -cf - -T /dev/null ;;
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
    result = await execute("sh", [join(repo, "update.sh")], { cwd: directory, env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, HERD_RABBIT_INSTALL_DIR: "",
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

for (const mode of ["branch", "dirty", "wrong-service", "diverged", "fetch-failed", "install-failed", "verify-failed", "herdr-too-old"]) {
  test(`updater aborts without restarting on ${mode}`, async (t) => {
    const { result, commands } = await runFixture(t, mode);
    assert.notEqual(result.code, undefined);
    assert.doesNotMatch(commands, /systemctl --user restart/);
    if (["branch", "dirty", "wrong-service"].includes(mode)) assert.doesNotMatch(commands, /git fetch/);
    if (mode === "herdr-too-old") assert.doesNotMatch(commands, /git merge --ff-only|npm ci/, "a Herdr too old changes no file");
  });
}
