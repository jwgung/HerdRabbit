#!/usr/bin/env node
// Entry point for herdr-plugin.toml: the startup hook, the actions and the
// panes. The decisions live in src/plugin-runner.mjs; this file only wires
// them to the machine.
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as runner from "../src/plugin-runner.mjs";

const execFileAsync = promisify(execFile);
const fallbackRoot = fileURLToPath(new URL("..", import.meta.url));

async function systemdActive(unit) {
  if (process.platform !== "linux") return false;
  try {
    await execFileAsync("systemctl", ["--user", "is-active", "--quiet", unit], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function processCommand(pid) {
  try {
    if (process.platform === "linux") {
      return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    }
    const { stdout } = await execFileAsync("ps", ["-o", "args=", "-p", String(pid)], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function spawnServer({ root, entry, env, logFile }) {
  const log = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

async function tailnetHostname() {
  const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 5_000 });
  const status = JSON.parse(stdout);
  return status.BackendState === "Running" ? String(status.Self?.DNSName || "").replace(/\.$/u, "") : "";
}

async function tailscaleServe() {
  const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], { timeout: 5_000 });
  return JSON.parse(stdout);
}

// Only when qrencode is installed; otherwise no code is shown.
async function qrCode(url) {
  const { stdout } = await execFileAsync("qrencode", ["-t", "UTF8", url], { timeout: 5_000 });
  return stdout;
}

const deps = {
  env: process.env,
  fallbackRoot,
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, text) => writeFile(path, text, { mode: 0o600 }),
  mkdir: (path) => mkdir(path, { recursive: true, mode: 0o700 }),
  rm: (path) => rm(path, { force: true }),
  systemdActive,
  probe: (host, port) => runner.probeHerdRabbit(host, port),
  processCommand,
  spawnServer,
  signal: (pid, name) => process.kill(pid, name),
  tailnetHostname,
  tailscaleServe,
  qrCode,
  readVersion: async (root) => JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function waitForKey(prompt = "아무 키나 누르면 닫힙니다.") {
  if (!process.stdin.isTTY) return Promise.resolve();
  process.stdout.write(`\n${prompt}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => process.stdin.once("data", () => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
    resolve();
  }));
}

// The password prompt with the plugin's settings applied, so it writes the
// file this plugin's server reads; a plugin-started server then restarts.
async function password() {
  const paths = runner.pluginPaths(deps.env, fallbackRoot);
  const { settings } = await runner.loadSettings(deps, paths);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(paths.root, "scripts", "password.mjs")], {
      cwd: paths.root,
      env: runner.serverEnvironment(process.env, settings),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) return { result: "failed", lines: [] };
  const { result } = await runner.status(deps);
  if (result !== "up") return { result: "done", lines: [] };
  return runner.restart(deps);
}

const commands = {
  startup: (d) => runner.start(d, { restartStale: true }),
  start: runner.start,
  stop: runner.stop,
  restart: runner.restart,
  status: runner.status,
  connect: runner.connect,
  password,
};

const name = process.argv[2];
const command = commands[name];
if (!command) {
  console.error(`사용법: node scripts/plugin.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
try {
  const { result, lines } = await command(deps);
  for (const line of lines) console.log(line);
  if (name === "connect" || name === "password") await waitForKey();
  process.exitCode = result === "failed" || result === "port-taken" ? 1 : 0;
} catch (error) {
  console.error(`HerdRabbit 플러그인 ${name} 실패: ${error.message}`);
  if (name === "connect" || name === "password") await waitForKey();
  process.exitCode = 1;
}
