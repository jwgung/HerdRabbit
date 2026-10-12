import test from "node:test";
import assert from "node:assert/strict";
import { herdrVersionSupported, parseHerdrVersion, readHerdrVersion } from "../src/herdr-version.mjs";

test("parses the version Herdr prints", () => {
  assert.deepEqual(parseHerdrVersion("herdr 0.9.3\n"), [0, 9, 3]);
  assert.equal(parseHerdrVersion("herdr"), null);
});

test("accepts 0.9.0 and newer only", () => {
  assert.equal(herdrVersionSupported("0.9.0"), true);
  assert.equal(herdrVersionSupported("herdr 0.10.1"), true);
  assert.equal(herdrVersionSupported("1.0.0"), true);
  assert.equal(herdrVersionSupported("0.8.2"), false);
  assert.equal(herdrVersionSupported(null), false);
});

test("reads the installed version and reports a failing binary as unknown", async () => {
  const calls = [];
  const runner = (binary, args, options, callback) => {
    calls.push([binary, args]);
    callback(null, "herdr 0.9.3\n");
  };
  assert.equal(await readHerdrVersion("/bin/herdr", { runner }), "0.9.3");
  assert.deepEqual(calls, [["/bin/herdr", ["--version"]]]);
  const failing = (binary, args, options, callback) => callback(new Error("ENOENT"), "");
  assert.equal(await readHerdrVersion("herdr", { runner: failing }), null);
});
