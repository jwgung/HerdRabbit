import test from "node:test";
import assert from "node:assert/strict";
import { nextPatch, releasedLock, releasedText, releaseFiles } from "../scripts/release.mjs";

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
  assert.equal(releasedText("v1.4.430 and 11.4.43 and 1.4.43.1", "1.4.43", "1.4.44"), "v1.4.430 and 11.4.43 and 1.4.43.1");
});

test("the files a release touches leave the checks' own fixtures alone", () => {
  const tracked = [
    "package.json", "package-lock.json", "herdr-plugin.toml", "public/app.js", "public/sw.js",
    "test/release-version.test.mjs", "scripts/check-herdr-settings.mjs", "docs/guide.md", "src/http-server.mjs",
  ];
  assert.deepEqual(releaseFiles(tracked), [
    "package.json", "herdr-plugin.toml", "public/app.js", "public/sw.js", "test/release-version.test.mjs",
  ]);
});

test("the lock file gets the package's own version only, as JSON", () => {
  const lock = {
    name: "herd-rabbit", version: "1.4.43", lockfileVersion: 3,
    packages: {
      "": { name: "herd-rabbit", version: "1.4.43" },
      "node_modules/x": { version: "1.4.43", resolved: "https://r/x-1.4.43.tgz" },
    },
  };
  const next = JSON.parse(releasedLock(`${JSON.stringify(lock, null, 2)}\n`, "1.4.44"));
  assert.equal(next.version, "1.4.44");
  assert.equal(next.packages[""].version, "1.4.44");
  // a dependency that shares the number keeps its version and its tarball
  assert.deepEqual(next.packages["node_modules/x"], lock.packages["node_modules/x"]);
});
