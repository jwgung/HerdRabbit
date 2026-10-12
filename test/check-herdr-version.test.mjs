import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/check-herdr-version.mjs", import.meta.url).pathname;

async function fixture(t, version) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const herdr = join(directory, "herdr");
  await writeFile(herdr, `#!/bin/sh\nprintf 'herdr ${version}\\n'\n`, { mode: 0o755 });
  // Whatever the surrounding shell set must not decide which module is read.
  const { HERDR_VERSION_MODULE: _inherited, ...environment } = process.env;
  const check = (module) => spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...environment, HERDR_BIN: herdr, ...(module ? { HERDR_VERSION_MODULE: module } : {}) },
  });
  const module = async (source) => {
    const path = join(directory, `version-${Math.random().toString(16).slice(2)}.mjs`);
    await writeFile(path, source);
    return path;
  };
  return { check, module, directory };
}

// An incoming module in the shape the current one has, with its own minimum.
const rules = (minimum) => `export const MIN_HERDR_VERSION = ${minimum};
export { readHerdrVersion, herdrVersionSupported } from ${JSON.stringify(new URL("../src/herdr-version.mjs", import.meta.url).href)};
`;

test("checks Herdr against the minimum the incoming code names", async (t) => {
  const { check, module } = await fixture(t, "0.9.3");
  assert.equal(check().status, 0, "the current minimum without an incoming module");
  assert.equal(check(await module(rules('"0.9.0"'))).status, 0);
  const raised = check(await module(`// reformatted\n${rules("'0.10.0'")}`));
  assert.equal(raised.status, 1, "a raised minimum is enforced whatever the declaration looks like");
  assert.match(raised.stderr, /older than 0\.10\.0/);
});

test("stops instead of guessing when the incoming module cannot be read", async (t) => {
  const { check, module, directory } = await fixture(t, "0.9.3");
  assert.equal(check(join(directory, "missing.mjs")).status, 1);
  const unnamed = check(await module("export const SOMETHING_ELSE = 1;\n"));
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stderr, /names no MIN_HERDR_VERSION/);
});

test("judges with the incoming code's own rules, not the installed ones", async (t) => {
  const { check, module } = await fixture(t, "0.9.3");
  const strict = check(await module('export const MIN_HERDR_VERSION = "0.9.0";\nexport async function readHerdrVersion() { return "0.9.3"; }\nexport function herdrVersionSupported() { return false; }\n'));
  assert.equal(strict.status, 1);
  const partial = check(await module('export const MIN_HERDR_VERSION = "0.9.0";\n'));
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /has no readHerdrVersion/);
});
