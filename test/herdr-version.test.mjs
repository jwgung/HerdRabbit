import test from "node:test";
import assert from "node:assert/strict";
import { herdrVersionSupported, parseHerdrVersion, readHerdrVersion } from "../src/herdr-version.mjs";

test("parses the version Herdr prints", () => {
  assert.deepEqual(parseHerdrVersion("herdr 0.9.3\n"), { core: [0, 9, 3], prerelease: "", text: "0.9.3" });
  assert.deepEqual(parseHerdrVersion("herdr 0.9.0-beta.1"), { core: [0, 9, 0], prerelease: "beta.1", text: "0.9.0-beta.1" });
  assert.equal(parseHerdrVersion("herdr"), null);
  assert.equal(parseHerdrVersion("herdr 0.9.0broken"), null);
  assert.equal(parseHerdrVersion("herdr 0.9.0+"), null);
  assert.equal(parseHerdrVersion("herdr 0.9.0+build.7").text, "0.9.0+build.7");
  assert.deepEqual(parseHerdrVersion("herdr 0.9.0+build.7").core, [0, 9, 0]);
});

test("accepts 0.9.0 and newer only", () => {
  assert.equal(herdrVersionSupported("0.9.0"), true);
  assert.equal(herdrVersionSupported("herdr 0.10.1"), true);
  assert.equal(herdrVersionSupported("1.0.0"), true);
  assert.equal(herdrVersionSupported("0.8.2"), false);
  assert.equal(herdrVersionSupported(null), false);
  assert.equal(herdrVersionSupported("herdr 0.9.0-beta.1"), false, "a prerelease comes before its release");
  assert.equal(herdrVersionSupported("0.9.1-rc.1"), true);
  assert.equal(herdrVersionSupported("0.10.0-alpha.1", "0.10.0-rc.1"), false, "alpha comes before rc");
  assert.equal(herdrVersionSupported("0.10.0-rc.2", "0.10.0-rc.1"), true);
  assert.equal(herdrVersionSupported("0.10.0-rc.10", "0.10.0-rc.9"), true, "numbers compare as numbers");
  assert.equal(herdrVersionSupported("0.10.0-rc", "0.10.0-rc.1"), false, "a shorter list comes first");
  assert.equal(herdrVersionSupported("0.10.0", "0.10.0-rc.1"), true);
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
