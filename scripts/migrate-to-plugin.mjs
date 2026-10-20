#!/usr/bin/env node
// Moves a PC from the systemd service (npm run install-service) to the Herdr
// plugin: installs the plugin, carries the unit's HERDR_WEB_* settings into the
// plugin's .env, stops the service and starts the plugin on the same address.
// Only once the plugin answers there are the unit and the old checkout
// removed; otherwise the service is started again and nothing else changes.
// The password, Passkeys, connected PCs and uploads live outside the checkout
// and stay where they are.
import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHost, parsePort } from "../src/config.mjs";
import { ENV_TEMPLATE, SYSTEMD_UNITS, parseEnvFile, pluginSettings, probeHerdRabbit, probeHost } from "../src/plugin-runner.mjs";
import { OFFICIAL_ORIGINS } from "../src/app-update.mjs";
import { parseSystemdEnvironment } from "./service-environment.mjs";
import { readVisibleLine } from "./password-prompt.mjs";

export const PLUGIN_SOURCE = "ultivis-iot/HerdRabbit";
export const PLUGIN_ID = "herdrabbit";
export const START_TIMEOUT_MS = 20_000;
const POLL_MS = 500;
// HERDR_WEB_ROLE belongs to a leaf, which is set up again first.
const NOT_CARRIED = new Set(["HERDR_WEB_ROLE"]);

function properties(text) {
  const values = {};
  for (const entry of String(text).split("\n")) {
    const at = entry.indexOf("=");
    if (at > 0) values[entry.slice(0, at)] = entry.slice(at + 1).trim();
  }
  return values;
}

// One value as the plugin's .env reads it back (parseEnvFile): bare when it
// is plain, in double quotes otherwise, and null when it cannot be written.
export function envValue(value) {
  if (/^[A-Za-z0-9._/:@,+=-]*$/u.test(value)) return value;
  if (/["\r\n]/u.test(value)) return null;
  return `"${value}"`;
}

// The plugin's .env for a unit's environment: its HERDR_WEB_* settings, then
// the commented template for reference. `skipped` names any it could not carry.
export function pluginEnvText(environment, { unit, date }) {
  const lines = [`# Moved from ${unit} on ${date}.`];
  const skipped = [];
  for (const [key, value] of environment) {
    if (!key.startsWith("HERDR_WEB_") || NOT_CARRIED.has(key)) continue;
    const written = envValue(value);
    if (written === null) skipped.push(key);
    else lines.push(`${key}=${written}`);
  }
  return { text: `${lines.join("\n")}\n\n${ENV_TEMPLATE}`, skipped };
}

// Whether a .env already says anything: then it is the user's and is kept.
export function hasSettings(text) {
  return Object.keys(pluginSettings(parseEnvFile(text))).length > 0;
}

// The service unit this PC runs HerdRabbit from, or null.
async function findUnit(deps) {
  for (const unit of SYSTEMD_UNITS) {
    const { code, stdout } = await deps.run("systemctl", [
      "--user", "show", unit,
      "--property=LoadState", "--property=WorkingDirectory", "--property=FragmentPath", "--property=Environment",
    ]);
    if (code !== 0) continue;
    const values = properties(stdout);
    if (values.LoadState !== "loaded") continue;
    return {
      unit,
      directory: values.WorkingDirectory || null,
      file: values.FragmentPath || null,
      environment: parseSystemdEnvironment(values.Environment ?? ""),
    };
  }
  return null;
}

async function waitForPage(deps, host, port) {
  const deadline = deps.now() + START_TIMEOUT_MS;
  for (;;) {
    if ((await deps.probe(probeHost(host), port))?.herdrabbit) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(POLL_MS);
  }
}

// The old checkout goes only where the installer put it, untouched, and from
// the official repository: a checkout someone works in is never removed.
async function removableCheckout(deps, directory) {
  if (!directory || resolve(directory) !== resolve(deps.installDirectory)) return false;
  const origin = await deps.run("git", ["-C", directory, "remote", "get-url", "origin"]);
  if (origin.code !== 0 || !OFFICIAL_ORIGINS.has(origin.stdout.trim())) return false;
  const status = await deps.run("git", ["-C", directory, "status", "--porcelain"]);
  return status.code === 0 && status.stdout.trim() === "";
}

export async function migrate(deps, { yes = false } = {}) {
  const say = deps.log;
  const found = await findUnit(deps);
  if (!found) {
    say(`이 PC에는 HerdRabbit systemd 서비스가 없습니다. 플러그인으로 설치하려면: herdr plugin install ${PLUGIN_SOURCE}`);
    return 1;
  }
  const { unit, directory, file, environment } = found;
  if (environment.get("HERDR_WEB_ROLE") === "leaf") {
    say("이 PC는 이전 버전에서 leaf로 설치됐습니다. 먼저 그 폴더에서 npm run install-service를 실행해 일반 설치로 바꾼 뒤 다시 실행하세요.");
    return 1;
  }
  const herdr = environment.get("HERDR_BIN") || "herdr";
  const host = parseHost(environment.get("HERDR_WEB_HOST"));
  const port = parsePort(environment.get("HERDR_WEB_PORT"));

  say(`systemd 서비스 ${unit}(${directory ?? "폴더 모름"})를 Herdr 플러그인으로 옮깁니다.`);
  say("  1. Herdr 플러그인 설치 (herdr plugin install)");
  say("  2. 서비스 설정을 플러그인 설정 파일로 옮기기");
  say(`  3. 서비스를 멈추고 플러그인으로 같은 주소(${host}:${port})에서 시작`);
  say("  4. 플러그인이 응답하면 서비스와 이전 설치 폴더 제거 (응답하지 않으면 서비스를 다시 켬)");
  say("비밀번호, Passkey, 붙인 PC, 업로드 파일은 그대로 둡니다.");
  if (!yes && !(await deps.confirm("계속할까요? [y/N] "))) {
    say("취소했습니다.");
    return 1;
  }

  say(`> herdr plugin install ${PLUGIN_SOURCE}`);
  if ((await deps.run(herdr, ["plugin", "install", PLUGIN_SOURCE, "--yes"], { inherit: true })).code !== 0) {
    say("플러그인 설치에 실패했습니다. 서비스는 그대로 실행 중입니다.");
    return 1;
  }
  const configDir = await deps.run(herdr, ["plugin", "config-dir", PLUGIN_ID]);
  if (configDir.code !== 0 || !configDir.stdout.trim()) {
    say("플러그인 설정 폴더를 찾지 못했습니다. 서비스는 그대로 실행 중입니다.");
    return 1;
  }
  const envFile = join(configDir.stdout.trim(), ".env");
  const existing = await deps.readFile(envFile).catch(() => "");
  if (hasSettings(existing)) {
    say(`플러그인 설정 파일에 이미 설정이 있어 그대로 둡니다: ${envFile}`);
  } else {
    const { text, skipped } = pluginEnvText(environment, { unit, date: new Date(deps.now()).toISOString().slice(0, 10) });
    await deps.writeFile(envFile, text);
    say(`서비스 설정을 옮겼습니다: ${envFile}`);
    for (const key of skipped) say(`  ${key}는 값에 따옴표나 줄바꿈이 있어 옮기지 못했습니다. 직접 적으세요.`);
  }

  say(`> systemctl --user stop ${unit}`);
  if ((await deps.run("systemctl", ["--user", "stop", unit])).code !== 0) {
    say(`서비스를 멈추지 못했습니다. 플러그인은 설치됐지만 서비스가 계속 실행 중입니다: systemctl --user status ${unit}`);
    return 1;
  }
  say(`> herdr plugin action invoke ${PLUGIN_ID}.start`);
  // Herdr only queues the action and answers in JSON; whether it worked is
  // whether the page answers.
  const started = await deps.run(herdr, ["plugin", "action", "invoke", `${PLUGIN_ID}.start`]);
  if (started.code !== 0 || !(await waitForPage(deps, host, port))) {
    await deps.run("systemctl", ["--user", "start", unit]);
    say(started.code !== 0
      ? "플러그인을 시작하지 못했습니다. Herdr가 실행 중일 때 다시 실행하세요. 서비스를 다시 켰습니다."
      : `플러그인이 ${host}:${port}에서 응답하지 않습니다. 서비스를 다시 켰습니다. 로그: herdr plugin log list --plugin ${PLUGIN_ID}`);
    return 1;
  }
  say(`플러그인이 ${host}:${port}에서 응답합니다.`);

  await deps.run("systemctl", ["--user", "disable", unit]);
  // Only a unit the installer wrote for this user; never one under /etc.
  const userUnits = join(deps.home, ".config", "systemd", "user");
  if (file && resolve(file).startsWith(`${userUnits}/`)) {
    await deps.rm(file);
    await deps.run("systemctl", ["--user", "daemon-reload"]);
    say(`서비스를 제거했습니다: ${file}`);
  } else {
    say(`서비스를 끄고 자동 시작을 해제했습니다. 유닛 파일은 그대로 둡니다: ${file ?? unit}`);
  }
  if (await removableCheckout(deps, directory)) {
    await deps.rm(directory, { recursive: true });
    say(`이전 설치 폴더를 지웠습니다: ${directory}`);
  } else if (directory) {
    say(`이전 설치 폴더는 그대로 둡니다: ${directory}`);
  }
  say("");
  say("끝났습니다. 앞으로 업데이트는 화면의 ⚙ → Update나 herdr plugin update로 합니다.");
  say("Herdr를 시작할 때 HerdRabbit도 함께 시작합니다.");
  return 0;
}

function run(file, args, { inherit = false } = {}) {
  return new Promise((resolve) => {
    if (inherit) {
      const child = spawn(file, args, { stdio: "inherit" });
      child.once("error", () => resolve({ code: -1, stdout: "" }));
      child.once("close", (code) => resolve({ code: Number.isInteger(code) ? code : -1, stdout: "" }));
      return;
    }
    execFile(file, args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : -1) : 0, stdout: String(stdout ?? "") });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--yes")) {
    console.error("사용법: node scripts/migrate-to-plugin.mjs [--yes]");
    process.exit(2);
  }
  if (process.platform !== "linux") {
    console.error("systemd 서비스는 Linux에만 있습니다. 이 PC는 herdr plugin install ultivis-iot/HerdRabbit로 설치하세요.");
    process.exit(1);
  }
  const yes = args.includes("--yes");
  if (!yes && !process.stdin.isTTY) {
    console.error("확인할 터미널이 없습니다. --yes를 붙여 실행하세요.");
    process.exit(1);
  }
  const home = process.env.HOME || homedir();
  process.exitCode = await migrate({
    run,
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text, { mode: 0o600 }),
    rm: (path, { recursive = false } = {}) => rm(path, { recursive, force: true }),
    probe: (host, port) => probeHerdRabbit(host, port),
    confirm: async (label) => /^y(es)?$/iu.test((await readVisibleLine(label)).trim()),
    log: (text) => console.log(text),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    home,
    installDirectory: process.env.HERD_RABBIT_INSTALL_DIR || join(home, ".local", "share", "herd-rabbit"),
  }, { yes });
}
