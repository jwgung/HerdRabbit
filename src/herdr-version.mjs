import { execFile } from "node:child_process";

// Terminal attach, pane scrolling and saved machines are what HerdRabbit
// builds on; Herdr has all of them from 0.9.0.
export const MIN_HERDR_VERSION = "0.9.0";

// "0.9.0-beta.1" keeps its prerelease tag: it comes before 0.9.0, so it must
// not pass as that release.
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/u;

export function parseHerdrVersion(text) {
  const match = VERSION_PATTERN.exec(String(text ?? ""));
  return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4] ?? "", text: match[0] } : null;
}

export function herdrVersionSupported(version, minimum = MIN_HERDR_VERSION) {
  const actual = parseHerdrVersion(version);
  const required = parseHerdrVersion(minimum);
  if (!actual) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual.core[index] !== required.core[index]) return actual.core[index] > required.core[index];
  }
  return actual.prerelease === "" || required.prerelease !== "";
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
