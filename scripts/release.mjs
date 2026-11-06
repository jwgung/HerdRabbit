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

// `from` as it is written and as a regular expression spells it (1\.4\.43,
// in the release test), and only where no other digit continues it.
export function releasedText(text, from, to) {
  const plain = new RegExp(`(?<![\\d.])${escape(from)}(?![\\d])`, "gu");
  const spelled = escape(from).replace(/\\\./gu, "\\\\.");
  const asPattern = new RegExp(`(?<![\\d.])${spelled}(?![\\d])`, "gu");
  return text.replace(asPattern, to.replace(/\./gu, "\\.")).replace(plain, to);
}

// Where the version lives: the package, the lock file's own entry, the plugin
// manifest, the web app, and the test that holds them to one version.
export function releaseFiles(tracked) {
  return tracked.filter((path) =>
    ["package.json", "package-lock.json", "herdr-plugin.toml", "test/release-version.test.mjs"].includes(path) ||
    path.startsWith("public/"));
}

function release(root, wanted) {
  const read = (path) => readFileSync(new URL(path, root), "utf8");
  const from = JSON.parse(read("package.json")).version;
  const to = wanted ?? nextPatch(from);
  if (!VERSION.test(to)) throw new Error(`A release version is x.y.z, not "${to}".`);
  if (to === from) throw new Error(`The version is ${from} already.`);
  const tracked = execFileSync("git", ["ls-files"], { cwd: fileURLToPath(root), encoding: "utf8" }).split("\n").filter(Boolean);
  for (const path of releaseFiles(tracked)) {
    const text = read(path);
    if (!text.includes(from) && !text.includes(escape(from))) continue;
    const next = releasedText(text, from, to);
    if (next !== text) writeFileSync(new URL(path, root), next);
  }
  // The lock file's own version is the package's; a dependency that happens
  // to share the number is not touched above (only the root entries carry it
  // in practice), and this says so if that ever changes.
  const lock = JSON.parse(read("package-lock.json"));
  if (lock.version !== to || lock.packages?.[""]?.version !== to) {
    throw new Error("package-lock.json's own version did not change; look at it by hand.");
  }
  const left = releaseFiles(tracked).filter((path) => read(path).includes(from));
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
