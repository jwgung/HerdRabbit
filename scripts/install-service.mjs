#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  defaultAuthFilePath,
  writePasswordConfiguration,
} from "../src/password-auth.mjs";
import {
  findAvailableServicePort,
  isLocalPortAvailable,
  isPortInServiceRange,
  PREFERRED_SERVICE_PORT,
} from "../src/port-selection.mjs";
import { promptForNewPassword } from "./password-prompt.mjs";
import { ensureHerdrExecutable } from "./herdr-install.mjs";
import { configureClaude } from "./configure-claude.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const serviceName = "herdrabbit.service";
const legacyServiceName = "herdr-web-local.service";

function quoteSystemd(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Re-running the installer on a machine that is already set up should carry
// its answers forward, so the prompts default to what it is rather than to what
// a fresh install would be.
export async function readExistingUnit(serviceFile) {
  try {
    const source = await readFile(serviceFile, "utf8");
    const port = Number(source.match(/HERDR_WEB_PORT=(\d+)/)?.[1]);
    return {
      port: isPortInServiceRange(port) ? port : null,
      // Leaf mode is gone; a rerun on a former leaf writes a normal unit and
      // says what changed.
      wasLeaf: /HERDR_WEB_ROLE=(?:")?leaf/u.test(source),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { port: null, wasLeaf: false };
    throw error;
  }
}

async function tailscaleDetails() {
  try {
    const { stdout: statusSource } = await execFileAsync(
      "tailscale",
      ["status", "--json"],
    );
    const status = JSON.parse(statusSource);
    let serve = {};
    try {
      const { stdout: serveSource } = await execFileAsync(
        "tailscale",
        ["serve", "status", "--json"],
      );
      serve = JSON.parse(serveSource);
    } catch {}
    const hostname = String(status.Self?.DNSName || "").replace(/\.$/, "");
    const usedHttpsPorts = new Set(
      Object.entries(serve.TCP || {})
        .filter(([, value]) => value?.HTTPS === true)
        .map(([port]) => Number(port))
        .filter(Number.isInteger),
    );
    return {
      available: status.BackendState === "Running" && hostname !== "",
      hostname,
      usedHttpsPorts,
    };
  } catch {
    return { available: false, hostname: "", usedHttpsPorts: new Set() };
  }
}

export function serviceUnit({ nodeBin, herdrBin, authFile, port, hostname }) {
  const lines = [
    "[Unit]",
    "Description=HerdRabbit",
    `Documentation=${quoteSystemd(`file://${repositoryRoot}README.md`)}`,
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repositoryRoot}`,
    `Environment=${quoteSystemd(`HERDR_WEB_PORT=${port}`)}`,
    `Environment=${quoteSystemd("HERDR_WEB_HOST=127.0.0.1")}`,
    `Environment=${quoteSystemd(`HERDR_WEB_AUTH_FILE=${authFile}`)}`,
  ];
  if (hostname) {
    lines.push(`Environment=${quoteSystemd(`HERDR_WEB_ALLOWED_HOSTS=${hostname}`)}`);
  }
  lines.push(
    `Environment=${quoteSystemd(`HERDR_BIN=${herdrBin}`)}`,
    `ExecStart=${quoteSystemd(nodeBin)} ${quoteSystemd(join(repositoryRoot, "src/index.mjs"))}`,
    "Restart=on-failure",
    "RestartSec=2s",
    "NoNewPrivileges=true",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

async function removeLegacyService(unitDirectory) {
  const legacyFile = join(unitDirectory, legacyServiceName);
  try {
    await stat(legacyFile);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  for (const verb of ["stop", "disable"]) {
    try {
      await execFileAsync("systemctl", ["--user", verb, legacyServiceName]);
    } catch {}
  }
  await rm(legacyFile, { force: true });
  await rm(join(unitDirectory, "default.target.wants", legacyServiceName), {
    force: true,
  });
  return true;
}

// true when HerdRabbit answered, false when something else did, null when the
// address could not be reached at all.
async function reachesHerdRabbit(address) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(address, { redirect: "manual" });
      // Every HerdRabbit response carries the launch-token header name in its
      // allowed set; the login page is served even before authentication.
      const body = response.status < 400 ? await response.text() : "";
      return body.includes("HerdRabbit") ? true : false;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
}

function runInteractive(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}


async function main() {
  const userConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const unitDirectory = join(userConfigHome, "systemd", "user");
  const serviceFile = join(unitDirectory, serviceName);
  const authFile = defaultAuthFilePath();
  const [existing, legacy, tailscale, herdrBin] = await Promise.all([
    readExistingUnit(serviceFile),
    readExistingUnit(join(unitDirectory, legacyServiceName)),
    tailscaleDetails(),
    ensureHerdrExecutable(),
  ]);
  const port = existing.port || legacy.port || await findAvailableServicePort({
    preferred: PREFERRED_SERVICE_PORT,
    unavailablePorts: tailscale.usedHttpsPorts,
    isAvailable: (candidate) => isLocalPortAvailable(candidate, "127.0.0.1"),
  });

  if (existing.wasLeaf) {
    // A leaf listened on its tailnet address with no password. Leaf mode is
    // gone: this becomes a normal HerdRabbit on loopback, with a password.
    console.log("이 PC는 예전 leaf 설치입니다. 일반 HerdRabbit으로 다시 설치합니다.");
    console.log("다른 PC의 HerdRabbit에서 이 PC를 보려면 그쪽에서 herdr machine으로 다시 추가하세요.");
  }
  const password = await promptForNewPassword();
  const claude = await configureClaude();
  console.log(`Claude 일반 터미널 모드 설정: ${claude.path}`);
  const auth = await writePasswordConfiguration(authFile, password);
  await mkdir(dirname(serviceFile), { recursive: true });
  const migrated = await removeLegacyService(unitDirectory);
  await writeFile(serviceFile, serviceUnit({
    nodeBin: process.execPath,
    herdrBin,
    authFile,
    port,
    hostname: tailscale.hostname,
  }), { mode: 0o600 });

  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", serviceName]);
  await execFileAsync("systemctl", ["--user", "restart", serviceName]);

  if (migrated) {
    console.log(`이전 ${legacyServiceName}을 제거하고 ${serviceName}으로 옮겼습니다.`);
  }
  console.log(`HerdRabbit 서비스를 127.0.0.1:${port}에 설치했습니다.`);
  console.log(
    auth.required
      ? "비밀번호 인증을 활성화했습니다."
      : "비밀번호 인증을 비활성화했습니다.",
  );
  if (!auth.required) {
    // Without a password the API is open to the tailnet while everything
    // still looks like it is working.
    console.warn("경고: 비밀번호가 없습니다. 이 API는 tailnet의 모든 기기에 열려 있습니다.");
  }

  if (!tailscale.available) {
    console.log("Tailscale이 실행 중이 아니므로 HTTPS 등록을 건너뛰었습니다.");
    return;
  }

  console.log(`Tailscale HTTPS 포트 ${port}을 등록합니다…`);
  try {
    await runInteractive("sudo", [
      "tailscale",
      "serve",
      "--bg",
      "--yes",
      `--https=${port}`,
      `http://127.0.0.1:${port}`,
    ]);
  } catch (error) {
    throw new Error(
      `서비스 설치는 완료했지만 Tailscale HTTPS 등록에 실패했습니다: ${error.message}`,
      { cause: error },
    );
  }
  // Tailscale only owns the port inside its own listener. Another process that
  // already holds 0.0.0.0:<port> shadows it, and `serve status` still reports
  // the registration -- so the only honest check is to ask the address and see
  // who answers.
  const address = `https://${tailscale.hostname}:${port}`;
  const reached = await reachesHerdRabbit(address);
  if (reached === true) {
    console.log(`HerdRabbit 주소: ${address}`);
    return;
  }
  console.warn(
    reached === false
      ? `경고: ${address}에 다른 서비스가 응답합니다. 이 포트를 선점한 프로세스가 있는지 확인하세요 (ss -tlnp | grep ${port}).`
      : `경고: ${address}에 아직 연결되지 않습니다. 서비스가 뜬 뒤 다시 확인하세요.`,
  );
  console.log(`HerdRabbit 주소: ${address}`);
}

// Running only when invoked as a script keeps the unit builders importable by
// tests, which would otherwise trigger the install prompts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`설치 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
