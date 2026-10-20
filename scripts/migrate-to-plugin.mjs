#!/usr/bin/env node
// Moves a PC from the systemd service (npm run install-service) to the Herdr
// plugin: installs the plugin, carries the unit's HERDR_WEB_* settings into the
// plugin's .env, stops the service and starts the plugin on the same address.
// Only once the plugin answers there are the unit and the old checkout
// removed; otherwise the service is started again and nothing else changes.
// The password, Passkeys, connected PCs and uploads live outside the checkout
// and stay where they are.
import { execFile, spawn } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHost, parsePort, readConfig } from "../src/config.mjs";
import { ENV_TEMPLATE, SYSTEMD_UNITS, parseEnvFile, pluginSettings, probeHerdRabbit, probeHost } from "../src/plugin-runner.mjs";
import { OFFICIAL_ORIGINS, properties } from "../src/app-update.mjs";
import { parseSystemdEnvironment } from "./service-environment.mjs";
import { readVisibleLine } from "./password-prompt.mjs";

export const PLUGIN_SOURCE = "ultivis-iot/HerdRabbit";
export const PLUGIN = "herdrabbit";
// The plugin's start action waits up to 15 s itself; Herdr runs it queued.
export const PAGE_WAIT_MS = 20_000;
// The queued stop action's own wait for the server to end.
const STOP_WAIT_MS = 6_000;
const POLL_MS = 500;
// HERDR_WEB_ROLE belongs to a leaf, which is set up again first.
const NOT_CARRIED = new Set(["HERDR_WEB_ROLE"]);

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

// The unit's data paths written out: the service found them from the user
// manager's environment, the plugin from Herdr's, and an XDG folder set in one
// but not the other would otherwise move the uploads and push subscriptions.
// The password file is pinned the same way.
export function pinnedPaths(environment, managerEnvironment) {
  const pinned = new Map(environment);
  try {
    const config = readConfig({ ...managerEnvironment, ...Object.fromEntries(environment) });
    if (!pinned.has("HERDR_WEB_AUTH_FILE")) pinned.set("HERDR_WEB_AUTH_FILE", config.authFile);
    if (!pinned.has("HERDR_WEB_FILES_DIR")) pinned.set("HERDR_WEB_FILES_DIR", config.filesDir);
    if (!pinned.has("HERDR_WEB_PUSH_FILE")) pinned.set("HERDR_WEB_PUSH_FILE", config.pushFile);
  } catch {
    // A unit config.mjs rejects would not have run either; carried as it is.
  }
  return pinned;
}

// `systemctl --user show-environment`: one KEY=VALUE per line.
function managerVariables(text) {
  const values = {};
  for (const entry of String(text).split("\n")) {
    const at = entry.indexOf("=");
    if (at > 0) values[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return values;
}

// Whether a .env already says anything: then it is the user's and is kept.
export function hasSettings(text) {
  return Object.keys(pluginSettings(parseEnvFile(text))).length > 0;
}

// The service unit this PC runs HerdRabbit from, or null.
export async function findUnit(deps) {
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

export async function waitForPage(deps, host, port) {
  const deadline = deps.now() + PAGE_WAIT_MS;
  for (;;) {
    if ((await deps.probe(probeHost(host), port))?.herdrabbit) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(POLL_MS);
  }
}

// The old checkout goes only where the installer put it, untouched, and from
// the official repository: a checkout someone works in is never removed. Of
// what git ignores, only the installed dependencies may be there.
async function removableCheckout(deps, directory) {
  if (!directory || resolve(directory) !== resolve(deps.installDirectory)) return false;
  const origin = await deps.run("git", ["-C", directory, "remote", "get-url", "origin"]);
  if (origin.code !== 0 || !OFFICIAL_ORIGINS.has(origin.stdout.trim())) return false;
  const status = await deps.run("git", ["-C", directory, "status", "--porcelain", "--ignored"]);
  if (status.code !== 0) return false;
  return status.stdout.split("\n").filter(Boolean).every((entry) => entry === "!! node_modules/");
}

// `herdr`: the Herdr the installer checked (install-plugin.mjs); otherwise
// the service's own.
export async function migrate(deps, { yes = false, herdr: checkedHerdr = null } = {}) {
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
  const herdr = checkedHerdr || environment.get("HERDR_BIN") || "herdr";
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
  const configDir = await deps.run(herdr, ["plugin", "config-dir", PLUGIN]);
  if (configDir.code !== 0 || !configDir.stdout.trim()) {
    say("플러그인 설정 폴더를 찾지 못했습니다. 서비스는 그대로 실행 중입니다.");
    return 1;
  }
  const envFile = join(configDir.stdout.trim(), ".env");
  const existing = await deps.readFile(envFile).catch(() => "");
  if (hasSettings(existing)) {
    // Kept as the user's, but the plugin must come up where the service was:
    // the Tailscale Serve address, the PWA and other PCs point there.
    const kept = pluginSettings(parseEnvFile(existing));
    let keptHost;
    let keptPort;
    try {
      keptHost = parseHost(kept.HERDR_WEB_HOST);
      keptPort = parsePort(kept.HERDR_WEB_PORT);
    } catch (error) {
      say(`플러그인 설정 파일을 읽을 수 없습니다(${error.message}): ${envFile}. 고치거나 지운 뒤 다시 실행하세요. 서비스는 그대로 실행 중입니다.`);
      return 1;
    }
    if (keptHost !== host || keptPort !== port) {
      say(`플러그인 설정 파일의 주소(${keptHost}:${keptPort})가 서비스 주소(${host}:${port})와 다릅니다: ${envFile}`);
      say("그 파일을 지우거나 주소를 맞춘 뒤 다시 실행하세요. 서비스는 그대로 실행 중입니다.");
      return 1;
    }
    say(`플러그인 설정 파일에 이미 설정이 있어 서비스 설정을 옮기지 않고 그대로 둡니다: ${envFile}`);
  } else {
    const manager = await deps.run("systemctl", ["--user", "show-environment"]);
    const carried = pinnedPaths(environment, manager.code === 0 ? managerVariables(manager.stdout) : {});
    const { text, skipped } = pluginEnvText(carried, { unit, date: new Date(deps.now()).toISOString().slice(0, 10) });
    await deps.writeFile(envFile, text);
    say(`서비스 설정을 옮겼습니다: ${envFile}`);
    for (const key of skipped) say(`  ${key}는 값에 따옴표나 줄바꿈이 있어 옮기지 못했습니다. 직접 적으세요.`);
  }

  say(`> systemctl --user disable --now ${unit}`);
  if ((await deps.run("systemctl", ["--user", "disable", "--now", unit])).code !== 0) {
    // disable can fail if the unit was never enabled; fall back to stop alone.
    if ((await deps.run("systemctl", ["--user", "stop", unit])).code !== 0) {
      say(`서비스를 멈추지 못했습니다. 플러그인은 설치됐지만 서비스가 계속 실행 중입니다: systemctl --user status ${unit}`);
      return 1;
    }
  }
  // Restart, not start: a plugin server already up (installed earlier, its
  // hook run while the service was down) picks up the settings just written.
  // Herdr only queues the action and answers in JSON; whether it worked is
  // whether the page answers.
  say(`> herdr plugin action invoke ${PLUGIN}.restart`);
  const started = await deps.run(herdr, ["plugin", "action", "invoke", `${PLUGIN}.restart`]);
  let up = started.code === 0 && (await waitForPage(deps, host, port));
  if (!up && started.code === 0) {
    // The plugin server can take longer than 15 s on a cold start (npm ci
    // just ran); one retry before giving up.
    say("플러그인이 아직 응답하지 않습니다. 10초 후 다시 시도합니다…");
    await deps.sleep(10_000);
    up = (await waitForPage(deps, host, port));
  }
  if (!up) {
    // A plugin server that came up late, or elsewhere, would hold the port
    // the service needs. Stop only ever ends the plugin's own server.
    await deps.run(herdr, ["plugin", "action", "invoke", `${PLUGIN}.stop`]);
    await deps.sleep(STOP_WAIT_MS);
    say(started.code !== 0
      ? "플러그인을 시작하지 못했습니다. Herdr가 실행 중일 때 다시 실행하세요."
      : `플러그인이 ${host}:${port}에서 응답하지 않습니다. 로그: herdr plugin log list --plugin ${PLUGIN}`);
    return 1;
  }
  say(`플러그인이 ${host}:${port}에서 응답합니다.`);
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
  say("이제 HerdRabbit은 로그인할 때가 아니라 Herdr가 시작할 때 함께 시작합니다.");
  return 0;
}

export function run(file, args, { inherit = false } = {}) {
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

// The machine as migrate() uses it.
export function defaultDeps() {
  const home = process.env.HOME || homedir();
  return {
    run,
    readFile: (path) => readFile(path, "utf8"),
    // A file Herdr made first keeps its mode on a write; the settings are private.
    writeFile: async (path, text) => {
      await writeFile(path, text, { mode: 0o600 });
      await chmod(path, 0o600);
    },
    rm: (path, { recursive = false } = {}) => rm(path, { recursive, force: true }),
    probe: (host, port) => probeHerdRabbit(host, port),
    confirm: async (label) => /^y(es)?$/iu.test((await readVisibleLine(label)).trim()),
    log: (text) => console.log(text),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    home,
    installDirectory: process.env.HERD_RABBIT_INSTALL_DIR || join(home, ".local", "share", "herd-rabbit"),
  };
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
    console.error("확인할 터미널이 없습니다. --yes를 붙여 실행하세요 (curl로 받았다면 ... | sh -s -- --yes).");
    process.exit(1);
  }
  process.exitCode = await migrate(defaultDeps(), { yes });
}
