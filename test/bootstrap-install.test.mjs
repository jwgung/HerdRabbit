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
