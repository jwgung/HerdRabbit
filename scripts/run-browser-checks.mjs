// Runs every browser check (scripts/check-*.mjs that loads Playwright) one
// after another, each in its own process. Every check serves the app on port 0
// and closes its own server, so no two share a port. Exits non-zero when any
// check fails.
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./", import.meta.url));
const TAIL_LINES = 40;
const TIMEOUT_MS = 5 * 60_000;

async function discover() {
  const names = (await readdir(directory)).filter((name) => /^check-.+\.mjs$/u.test(name)).sort();
  const found = [];
  for (const name of names) {
    if ((await readFile(new URL(name, import.meta.url), "utf8")).includes("PLAYWRIGHT_MODULE")) found.push(name);
  }
  return found;
}

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const lines = [];
    const child = spawn(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    const collect = (chunk) => {
      lines.push(...chunk.toString().split("\n"));
      if (lines.length > TAIL_LINES * 4) lines.splice(0, lines.length - TAIL_LINES * 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, code, signal, timedOut, ms: Date.now() - started, tail: lines.join("\n").trimEnd().split("\n").slice(-TAIL_LINES).join("\n") });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ name, ok: false, code: null, signal: null, timedOut: false, ms: Date.now() - started, tail: String(error) });
    });
  });
}

const checks = await discover();
if (!checks.length) {
  console.error("no browser checks found");
  process.exit(1);
}
const results = [];
for (const name of checks) {
  process.stdout.write(`running ${name} ...\n`);
  const result = await run(name);
  results.push(result);
  console.log(`${result.ok ? "ok  " : "FAIL"} ${name} (${(result.ms / 1000).toFixed(1)}s)`);
  if (!result.ok) console.log(`${result.timedOut ? `timed out after ${TIMEOUT_MS / 1000}s\n` : ""}${result.tail.replace(/^/gmu, "    | ")}`);
}
console.log("\nsummary");
for (const { ok, name, ms } of results) console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(36)} ${(ms / 1000).toFixed(1)}s`);
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${(results.reduce((sum, r) => sum + r.ms, 0) / 1000).toFixed(1)}s`);
process.exit(failed.length ? 1 : 0);
