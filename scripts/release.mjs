// Makes a release's one commit: the version, everywhere this checkout names it.
//
//   node scripts/release.mjs            next patch version (1.4.43 -> 1.4.44)
//   node scripts/release.mjs 1.5.0      that version
//
// It prints the new version and leaves the change uncommitted. CI runs it
// after a merge to main (.github/workflows/ci.yml, release job), commits the
// result as "release: x.y.z" and tags it; run by hand it makes the same edit.
//
// The version is the package's and the plugin's, and every page and script
// asks for its assets with `?v=<version>` (the service worker's cache name
// too), so a new version reaches every browser in one load. A browser check's
// own fake "up to date" status (scripts/) is a fixture, not this app's
// version, and is left alone.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;

export function nextPatch(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`A release version is x.y.z, not "${version}".`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// 1.4.43 as a regular expression spells it: 1\.4\.43
const spelled = (version) => version.replace(/\./gu, "\\.");

// `from` as it is written and as a regular expression spells it (in the
// release test), and only where no other digit or dotted part continues it.
export function releasedText(text, from, to) {
  const edge = (pattern) => new RegExp(`(?<![\\d.\\\\])${pattern}(?!\\.?\\d|\\\\\\.\\d)`, "gu");
  return text
    .replace(edge(escape(spelled(from))), spelled(to))
    .replace(edge(escape(from)), to);
}

// Where the version lives as text: the package, the plugin manifest, the web
// app, and the test that holds them to one version. The lock file is set as
// JSON instead (releasedLock), so a dependency that shares the number keeps it.
export function releaseFiles(tracked) {
  return tracked.filter((path) =>
    ["package.json", "herdr-plugin.toml", "test/release-version.test.mjs"].includes(path) ||
    path.startsWith("public/"));
}

// package-lock.json with the package's own version (its top and its "" entry) set.
export function releasedLock(text, to) {
  const lock = JSON.parse(text);
  lock.version = to;
  if (lock.packages?.[""]) lock.packages[""].version = to;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function release(root, wanted) {
  const read = (path) => readFileSync(new URL(path, root), "utf8");
  const from = JSON.parse(read("package.json")).version;
  const to = wanted ?? nextPatch(from);
  if (!VERSION.test(to)) throw new Error(`A release version is x.y.z, not "${to}".`);
  if (to === from) throw new Error(`The version is ${from} already.`);
  const tracked = execFileSync("git", ["ls-files"], { cwd: fileURLToPath(root), encoding: "utf8" }).split("\n").filter(Boolean);
  const files = releaseFiles(tracked);
  for (const path of files) {
    const text = read(path);
    const next = releasedText(text, from, to);
    if (next !== text) writeFileSync(new URL(path, root), next);
  }
  writeFileSync(new URL("package-lock.json", root), releasedLock(read("package-lock.json"), to));
  const left = files.filter((path) => {
    const text = read(path);
    return text.includes(from) || text.includes(spelled(from));
  });
  if (left.length > 0) throw new Error(`Still at ${from}: ${left.join(", ")}`);
  return to;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(release(new URL("../", import.meta.url), process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
