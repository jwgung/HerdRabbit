import test from "node:test";
import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import {
  ensureHerdrExecutable,
  executableOnPath,
} from "../scripts/herdr-install.mjs";

test("uses an existing Herdr executable without installing it", async () => {
  const candidate = join("/", "opt", "herdr", "bin", "herdr");
  let installCalled = false;
  const resolved = await ensureHerdrExecutable({
    path: [join("/", "usr", "bin"), join("/", "opt", "herdr", "bin")].join(delimiter),
    isExecutable: async (path) => path === candidate,
    install: async () => { installCalled = true; },
    readVersion: async () => "0.9.3",
    update: async () => { throw new Error("a supported Herdr must not be updated"); },
    log: () => {},
  });

  assert.equal(resolved, candidate);
  assert.equal(installCalled, false);
});

test("updates an existing Herdr older than the supported version", async () => {
  const candidate = join("/", "opt", "herdr", "bin", "herdr");
  let version = "0.8.2";
  const updated = [];
  const resolved = await ensureHerdrExecutable({
    path: join("/", "opt", "herdr", "bin"),
    isExecutable: async (path) => path === candidate,
    install: async () => { throw new Error("an existing Herdr must not be reinstalled"); },
    readVersion: async () => version,
    update: async (executable) => { updated.push(executable); version = "0.9.3"; },
    log: () => {},
  });

  assert.equal(resolved, candidate);
  assert.deepEqual(updated, [candidate]);
});

test("refuses a Herdr that is still too old after updating", async () => {
  const candidate = join("/", "opt", "herdr", "bin", "herdr");
  await assert.rejects(
    ensureHerdrExecutable({
      path: join("/", "opt", "herdr", "bin"),
      isExecutable: async (path) => path === candidate,
      readVersion: async () => "0.8.2",
      update: async () => {},
      log: () => {},
    }),
    /Herdr 0\.8\.2 .* is older than 0\.9\.0/,
  );
});

test("installs Herdr and returns its absolute executable path when missing", async () => {
  const installDir = join("/", "home", "tester", ".local", "bin");
  const installed = join(installDir, "herdr");
  let installationFinished = false;
  const resolved = await ensureHerdrExecutable({
    path: join("", "usr", "bin"),
    installDir,
    isExecutable: async (path) => installationFinished && path === installed,
    install: async ({ installDir: target }) => {
      assert.equal(target, installDir);
      installationFinished = true;
    },
    readVersion: async () => "0.9.3",
    log: () => {},
  });

  assert.equal(resolved, installed);
});

test("reports a failed Herdr installation instead of writing a broken service", async () => {
  await assert.rejects(
    ensureHerdrExecutable({
      path: join("", "usr", "bin"),
      installDir: join("/", "home", "tester", ".local", "bin"),
      isExecutable: async () => false,
      install: async () => {},
      readVersion: async () => "0.9.3",
      log: () => {},
    }),
    /installation finished but .*herdr is not executable/,
  );
});

test("ignores empty PATH entries while resolving executables", async () => {
  const checked = [];
  const resolved = await executableOnPath("herdr", {
    path: `${delimiter}${join("", "usr", "local", "bin")}${delimiter}`,
    isExecutable: async (candidate) => {
      checked.push(candidate);
      return false;
    },
  });

  assert.equal(resolved, null);
  assert.deepEqual(checked, [join("", "usr", "local", "bin", "herdr")]);
});

test("checks the version of a Herdr it just installed too", async () => {
  const installDir = join("/", "home", "tester", ".local", "bin");
  const installed = join(installDir, "herdr");
  let present = false;
  let version = "0.8.2";
  const updated = [];
  const resolved = await ensureHerdrExecutable({
    path: join("", "usr", "bin"),
    installDir,
    isExecutable: async (path) => present && path === installed,
    install: async () => { present = true; },
    readVersion: async () => version,
    update: async (executable) => { updated.push(executable); version = "0.9.3"; },
    log: () => {},
  });
  assert.equal(resolved, installed);
  assert.deepEqual(updated, [installed]);

  await assert.rejects(ensureHerdrExecutable({
    path: join("", "usr", "bin"),
    installDir,
    isExecutable: async (path) => path === installed && present,
    install: async () => {},
    readVersion: async () => null,
    update: async () => {},
    log: () => {},
  }), /older than 0\.9\.0/);
});
