import test from "node:test";
import assert from "node:assert/strict";
import { nextPatch, releasedText, releaseFiles } from "../scripts/release.mjs";

test("a release is the next patch version", () => {
  assert.equal(nextPatch("1.4.43"), "1.4.44");
  assert.equal(nextPatch("2.0.9"), "2.0.10");
  assert.throws(() => nextPatch("1.4"), /x\.y\.z/u);
  assert.throws(() => nextPatch("1.4.3-beta"), /x\.y\.z/u);
});

test("the version is replaced as written and as a regular expression spells it", () => {
  const before = 'import "./a.js?v=1.4.43";\nassert.match(x, /\\?v=(?!1\\.4\\.43)/u);\nconst CACHE_NAME = "herd-rabbit-v1.4.43";';
  const after = 'import "./a.js?v=1.4.44";\nassert.match(x, /\\?v=(?!1\\.4\\.44)/u);\nconst CACHE_NAME = "herd-rabbit-v1.4.44";';
  assert.equal(releasedText(before, "1.4.43", "1.4.44"), after);
  // a longer version that starts the same is not this one
  assert.equal(releasedText("v1.4.430 and 11.4.43", "1.4.43", "1.4.44"), "v1.4.430 and 11.4.43");
});

test("the files a release touches leave the checks' own fixtures alone", () => {
  const tracked = [
    "package.json", "package-lock.json", "herdr-plugin.toml", "public/app.js", "public/sw.js",
    "test/release-version.test.mjs", "scripts/check-herdr-settings.mjs", "docs/guide.md", "src/http-server.mjs",
  ];
  assert.deepEqual(releaseFiles(tracked), [
    "package.json", "package-lock.json", "herdr-plugin.toml", "public/app.js", "public/sw.js", "test/release-version.test.mjs",
  ]);
});
