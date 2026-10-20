#!/usr/bin/env node
// What install.sh runs: HerdRabbit as a Herdr plugin, set up the way the
// service installer set up the service -- Herdr installed and new enough, a
// free port, the tailnet name allowed, a password, Claude's terminal mode and
// Tailscale Serve. A PC that still has the older systemd service is moved over
// instead (scripts/migrate-to-plugin.mjs).
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { parseHost, parsePort } from "../src/config.mjs";
import { defaultAuthFilePath, writePasswordConfiguration } from "../src/password-auth.mjs";
import { ENV_TEMPLATE, parseEnvFile, pluginSettings, probeHerdRabbit } from "../src/plugin-runner.mjs";
import { findAvailableServicePort, isLocalPortAvailable, PREFERRED_SERVICE_PORT } from "../src/port-selection.mjs";
import { configureClaude } from "./configure-claude.mjs";
import { ensureHerdrExecutable } from "./herdr-install.mjs";
import { reachesHerdRabbit, runInteractive, tailscaleDetails } from "./install-service.mjs";
import { PLUGIN, PLUGIN_SOURCE, defaultDeps, findUnit, hasSettings, migrate, waitForPage } from "./migrate-to-plugin.mjs";
import { promptForNewPassword } from "./password-prompt.mjs";

// The plugin's .env for a new install: where the page listens and the tailnet
// name allowed to reach it, then the commented template.
export function newEnvText({ port, hostname, date }) {
  const lines = [`# Written by install.sh on ${date}.`, "HERDR_WEB_HOST=127.0.0.1", `HERDR_WEB_PORT=${port}`];
  if (hostname) lines.push(`HERDR_WEB_ALLOWED_HOSTS=${hostname}`);
  return `${lines.join("\n")}\n\n${ENV_TEMPLATE}`;
}

export async function installPlugin(deps) {
  const say = deps.log;
  if (deps.platform === "linux" && await findUnit(deps)) {
    say("이 PC에는 이전 방식(systemd 서비스)의 HerdRabbit이 있어 플러그인으로 옮깁니다.");
    return deps.migrate();
  }

  const herdr = await deps.ensureHerdr();
  const tailscale = await deps.tailscale();

  say(`> herdr plugin install ${PLUGIN_SOURCE}`);
  if ((await deps.run(herdr, ["plugin", "install", PLUGIN_SOURCE, "--yes"], { inherit: true })).code !== 0) {
    say("플러그인 설치에 실패했습니다.");
    return 1;
  }
  const configDir = await deps.run(herdr, ["plugin", "config-dir", PLUGIN]);
  if (configDir.code !== 0 || !configDir.stdout.trim()) {
    say("플러그인 설정 폴더를 찾지 못했습니다.");
    return 1;
  }

  // Run again, the settings already there are kept, and so is the port.
  const envFile = join(configDir.stdout.trim(), ".env");
  const existing = await deps.readFile(envFile).catch(() => "");
  let host = "127.0.0.1";
  let port;
  if (hasSettings(existing)) {
    const kept = pluginSettings(parseEnvFile(existing));
    host = parseHost(kept.HERDR_WEB_HOST);
    port = parsePort(kept.HERDR_WEB_PORT);
    say(`플러그인 설정 파일을 그대로 씁니다: ${envFile}`);
  } else {
    // A HerdRabbit already on the usual port (an earlier plugin install) keeps it.
    port = (await deps.probe(host, PREFERRED_SERVICE_PORT))?.herdrabbit
      ? PREFERRED_SERVICE_PORT
      : await deps.findPort(tailscale.usedHttpsPorts);
    await deps.writeFile(envFile, newEnvText({ port, hostname: tailscale.hostname, date: new Date(deps.now()).toISOString().slice(0, 10) }));
    say(`설정 파일을 만들었습니다: ${envFile}`);
  }

  // An existing password is replaced only when asked: an empty answer would
  // otherwise turn it off and sign every device out.
  const hasPassword = await deps.authExists();
  if (!hasPassword || await deps.confirm("비밀번호가 이미 있습니다. 새로 정할까요? [y/N] ")) {
    const auth = await deps.writePassword(await deps.askPassword());
    say(auth.required ? "비밀번호를 설정했습니다." : "경고: 비밀번호가 없습니다. tailnet의 모든 기기가 이 화면을 열 수 있습니다.");
  }
  const claude = await deps.configureClaude();
  say(`Claude 일반 터미널 모드 설정: ${claude.path}`);

  // Herdr only queues the action; the page answering is what says it started.
  say(`> herdr plugin action invoke ${PLUGIN}.restart`);
  const invoked = await deps.run(herdr, ["plugin", "action", "invoke", `${PLUGIN}.restart`]);
  const started = invoked.code === 0 && await waitForPage(deps, host, port);
  if (invoked.code !== 0) {
    say("Herdr가 실행 중이 아니라 아직 시작하지 않았습니다. herdr를 실행하면 HerdRabbit도 함께 시작합니다.");
  } else if (!started) {
    say(`HerdRabbit이 ${host}:${port}에서 아직 응답하지 않습니다. 로그: herdr plugin log list --plugin ${PLUGIN}`);
  }

  say(`이 PC에서: http://${host}:${port}`);
  if (!tailscale.available) {
    say("Tailscale이 실행 중이 아니라 휴대폰용 HTTPS 등록을 건너뛰었습니다.");
  } else {
    const address = `https://${tailscale.hostname}:${port}`;
    say(`Tailscale HTTPS 포트 ${port}을 등록합니다…`);
    try {
      await deps.registerServe(port);
      if (started && await deps.reaches(address) === false) {
        say(`경고: ${address}에 다른 서비스가 응답합니다.`);
      }
      say(`휴대폰·다른 기기: ${address}`);
    } catch (error) {
      say(`Tailscale HTTPS 등록에 실패했습니다(${error.message}). 직접 실행하세요: sudo tailscale serve --bg --https=${port} http://127.0.0.1:${port}`);
    }
  }
  say("");
  say("업데이트는 화면의 ⚙ → Update나 herdr plugin update로 합니다. HerdRabbit은 Herdr가 시작할 때 함께 시작합니다.");
  return started || invoked.code !== 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error("사용법: node scripts/install-plugin.mjs");
    process.exit(2);
  }
  if (!process.stdin.isTTY) {
    console.error("설치에는 대화형 터미널이 필요합니다.");
    process.exit(1);
  }
  const base = defaultDeps();
  const authFile = defaultAuthFilePath();
  try {
    process.exitCode = await installPlugin({
      ...base,
      platform: process.platform,
      migrate: () => migrate(base),
      ensureHerdr: () => ensureHerdrExecutable(),
      tailscale: () => tailscaleDetails(),
      probe: (host, port) => probeHerdRabbit(host, port),
      findPort: (usedHttpsPorts) => findAvailableServicePort({
        preferred: PREFERRED_SERVICE_PORT,
        unavailablePorts: usedHttpsPorts,
        isAvailable: (candidate) => isLocalPortAvailable(candidate, "127.0.0.1"),
      }),
      authExists: () => access(authFile).then(() => true, () => false),
      askPassword: () => promptForNewPassword(),
      writePassword: (password) => writePasswordConfiguration(authFile, password),
      configureClaude: () => configureClaude(),
      registerServe: (port) => runInteractive("sudo", [
        "tailscale", "serve", "--bg", "--yes", `--https=${port}`, `http://127.0.0.1:${port}`,
      ]),
      reaches: (address) => reachesHerdRabbit(address),
      readFile: (path) => readFile(path, "utf8"),
    });
  } catch (error) {
    console.error(`설치 실패: ${error.message}`);
    process.exitCode = 1;
  }
}
