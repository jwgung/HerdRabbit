import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const installer = await readFile(
  new URL("../install.sh", import.meta.url),
  "utf8",
);

test("offers a public one-line installer without losing the interactive prompt", () => {
  assert.match(installer, /https:\/\/github\.com\/ultivis-iot\/HerdRabbit\.git/);
  // The current code, fetched into a folder of its own and removed afterwards.
  assert.match(installer, /TEMPORARY="\$\(mktemp -d\)"/);
  assert.match(installer, /trap 'rm -rf "\$TEMPORARY"' EXIT/);
  assert.match(installer, /npm --prefix "\$TEMPORARY\/HerdRabbit" ci --omit=dev/);
  // Only node reads the terminal; the shell keeps reading the piped script.
  assert.match(installer, /scripts\/install-plugin\.mjs" <\/dev\/tty/);
  assert.doesNotMatch(installer, /exec <\/dev\/tty/);
  assert.match(installer, /Node\.js 22 or newer/);
  assert.match(installer, /need npm/);
  assert.match(installer, /^main "\$@"$/mu);
});

// The migration wrapper, run for real against a stand-in checkout, git and
// npm: from a checkout it uses that checkout, piped it fetches one.
test("the migration wrapper runs its own checkout, and fetches one only when piped", async (context) => {
  const { execFileSync } = await import("node:child_process");
  const { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "herdrabbit-wrapper-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const calls = join(root, "calls.txt");
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await mkdir(bin);
  await copyFile(new URL("../migrate-to-plugin.sh", import.meta.url), join(checkout, "migrate-to-plugin.sh"));
  await writeFile(join(checkout, "scripts", "migrate-to-plugin.mjs"), "console.log('ran local', process.argv.slice(2).join(' '));\n");
  // git clone makes a checkout whose script says where it ran from; npm does nothing.
  await writeFile(join(bin, "git"), [
    "#!/bin/sh", `echo "git $*" >> '${calls}'`,
    'eval "target=\\${$#}"', 'mkdir -p "$target/scripts"',
    "echo \"console.log('ran fetched')\" > \"$target/scripts/migrate-to-plugin.mjs\"",
  ].join("\n"));
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> '${calls}'\n`);
  await chmod(join(bin, "git"), 0o755);
  await chmod(join(bin, "npm"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, DIRECTORY: "/nowhere" };
  const run = (args, options) => execFileSync("sh", args, { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
  const readCalls = async () => (await import("node:fs/promises")).readFile(calls, "utf8").catch(() => "");

  assert.match(run(["migrate-to-plugin.sh", "--yes"], { cwd: checkout }), /ran local --yes/u);
  assert.match(run([join(checkout, "migrate-to-plugin.sh")], { cwd: root }), /ran local/u);
  assert.equal(await readCalls(), "", "a checkout is never fetched again");

  const piped = run(["-s", "--", "--yes"], { cwd: root, input: await (await import("node:fs/promises")).readFile(join(checkout, "migrate-to-plugin.sh"), "utf8") });
  assert.match(piped, /ran fetched/u);
  assert.match(await readCalls(), /^git clone --quiet --depth 1 https:\/\/github\.com\/ultivis-iot\/HerdRabbit\.git /mu);
  assert.match(await readCalls(), /^npm --prefix .* ci --omit=dev$/mu);
});
