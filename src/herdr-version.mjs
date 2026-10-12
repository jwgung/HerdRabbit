import { execFile } from "node:child_process";

// Terminal attach, pane scrolling and saved machines are what HerdRabbit
// builds on; Herdr has all of them from 0.9.0.
export const MIN_HERDR_VERSION = "0.9.0";

export function parseHerdrVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? match.slice(1, 4).map(Number) : null;
}

export function herdrVersionSupported(version, minimum = MIN_HERDR_VERSION) {
  const actual = parseHerdrVersion(version);
  const required = parseHerdrVersion(minimum);
  if (!actual) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

// The installed CLI is what every command runs, so its version is the one that
// counts. A missing or silent binary reads as unknown rather than failing.
export function readHerdrVersion(binary = "herdr", { runner = execFile, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    runner(binary, ["--version"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      const version = error ? null : parseHerdrVersion(stdout);
      resolve(version ? version.join(".") : null);
    });
  });
}
