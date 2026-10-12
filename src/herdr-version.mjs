import { execFile } from "node:child_process";

// Terminal attach, pane scrolling and saved machines are what HerdRabbit
// builds on; Herdr has all of them from 0.9.0.
export const MIN_HERDR_VERSION = "0.9.0";

// "0.9.0-beta.1" keeps its prerelease tag: it comes before 0.9.0, so it must
// not pass as that release. Prereleases of one version order as semver does.
// Build metadata is allowed and ignored; anything else glued on is not a version.
const VERSION_PATTERN = /(?<![0-9A-Za-z.])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![0-9A-Za-z.+-])/u;

export function parseHerdrVersion(text) {
  const match = VERSION_PATTERN.exec(String(text ?? ""));
  return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.slice(1) ?? "", text: match[0] } : null;
}

// Semver 11.4: identifiers left to right, numbers below words, and a shorter
// list first when all before it are equal.
function comparePrerelease(left, right) {
  if (left === right) return 0;
  if (left === "") return 1;
  if (right === "") return -1;
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const numeric = [a[index], b[index]].map((part) => /^\d+$/u.test(part));
    if (numeric[0] && numeric[1]) {
      if (Number(a[index]) !== Number(b[index])) return Number(a[index]) - Number(b[index]);
    } else if (numeric[0] !== numeric[1]) {
      return numeric[0] ? -1 : 1;
    } else if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

export function herdrVersionSupported(version, minimum = MIN_HERDR_VERSION) {
  const actual = parseHerdrVersion(version);
  const required = parseHerdrVersion(minimum);
  if (!required) throw new Error(`${JSON.stringify(minimum)} is not a Herdr version`);
  if (!actual) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual.core[index] !== required.core[index]) return actual.core[index] > required.core[index];
  }
  return comparePrerelease(actual.prerelease, required.prerelease) >= 0;
}

// The installed CLI is what every command runs, so its version is the one that
// counts. A missing or silent binary reads as unknown rather than failing.
export function readHerdrVersion(binary = "herdr", { runner = execFile, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    runner(binary, ["--version"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseHerdrVersion(stdout)?.text ?? null);
    });
  });
}
