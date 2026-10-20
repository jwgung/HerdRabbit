#!/usr/bin/env node
import { execFile } from "node:child_process";
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
import { promptForNewPassword, readVisibleLine } from "./password-prompt.mjs";
import { DEFAULT_PEER_PORT } from "../src/link-protocol.mjs";
import { readTailnetPeers } from "../src/tailnet-peers.mjs";
import { ensureHerdrExecutable } from "./herdr-install.mjs";
import { configureClaude } from "./configure-claude.mjs";
import { reachesHerdRabbit, runInteractive, tailscaleDetails } from "./setup-helpers.mjs";

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
function unitSetting(source, name) {
  return source.match(new RegExp(`${name}=([^"\\s]*)`, "u"))?.[1] ?? "";
}

// The Connect PC settings a unit already has, or null when its port is
// closed. A leaf an older version wrote listened on its tailnet address for
// its hub; that is the same thing now, so a rerun offers to keep it.
function existingPeer(source, wasLeaf) {
  const host = unitSetting(source, "HERDR_WEB_PEER_HOST") ||
    (wasLeaf && !/^(127\.|::1$|0\.0\.0\.0$|::$)/u.test(unitSetting(source, "HERDR_WEB_HOST")) ? unitSetting(source, "HERDR_WEB_HOST") : "");
  if (!host) return null;
  const port = Number(unitSetting(source, "HERDR_WEB_PEER_PORT") || (wasLeaf ? unitSetting(source, "HERDR_WEB_PORT") : "")) || DEFAULT_PEER_PORT;
  const list = (name) => unitSetting(source, name).split(",").map((item) => item.trim()).filter(Boolean);
  return { host, port, addresses: list("HERDR_WEB_PEER_ADDRESSES"), logins: list("HERDR_WEB_PEER_LOGINS"), hub: unitSetting(source, "HERDR_WEB_HUB") || null };
}

export async function readExistingUnit(serviceFile) {
  try {
    const source = await readFile(serviceFile, "utf8");
    const port = Number(source.match(/HERDR_WEB_PORT=(\d+)/)?.[1]);
    const wasLeaf = /HERDR_WEB_ROLE=(?:")?leaf/u.test(source);
    return {
      port: isPortInServiceRange(port) ? port : null,
      // A leaf is written again as an ordinary unit with its own page.
      wasLeaf,
      peer: existingPeer(source, wasLeaf),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { port: null, wasLeaf: false, peer: null };
    throw error;
  }
}


// `peer`: the Connect PC port, { host, port, addresses, logins, hub }, or null
// to keep it closed. The page always stays on loopback behind Tailscale Serve.
export function serviceUnit({ nodeBin, herdrBin, authFile, port, hostname, peer = null }) {
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
  if (peer) {
    // Baked in at install time so the allowed list cannot change without the
    // unit changing. An empty list keeps the port shut to everyone.
    lines.push(
      `Environment=${quoteSystemd(`HERDR_WEB_PEER_HOST=${peer.host}`)}`,
      `Environment=${quoteSystemd(`HERDR_WEB_PEER_PORT=${peer.port}`)}`,
    );
    if (peer.addresses?.length) lines.push(`Environment=${quoteSystemd(`HERDR_WEB_PEER_ADDRESSES=${peer.addresses.join(",")}`)}`);
    if (peer.logins?.length) lines.push(`Environment=${quoteSystemd(`HERDR_WEB_PEER_LOGINS=${peer.logins.join(",")}`)}`);
    if (peer.hub) lines.push(`Environment=${quoteSystemd(`HERDR_WEB_HUB=${peer.hub}`)}`);
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



// Whether other PCs may connect to this one (Connect PC), and which. Nothing
// about the page or its password changes either way.
export function parsePeerChoice(answer, peers) {
  const picked = String(answer).split(",").map((item) => item.trim()).filter(Boolean);
  const addresses = [];
  for (const item of picked) {
    const peer = peers[Number(item) - 1];
    if (!/^\d+$/u.test(item) || !peer) throw new Error(`목록에 없는 번호입니다: ${item}`);
    if (!addresses.includes(peer.address)) addresses.push(peer.address);
  }
  return addresses;
}

export function peerPortBeside(wanted, pagePort, usedHttpsPorts = new Set()) {
  const taken = (candidate) => candidate === pagePort || usedHttpsPorts.has(candidate);
  if (!taken(wanted)) return wanted;
  for (let candidate = DEFAULT_PEER_PORT; candidate <= 65_535; candidate += 1) {
    if (!taken(candidate)) return candidate;
  }
  throw new Error("Connect PC 포트로 쓸 빈 포트를 찾지 못했습니다.");
}

async function chooseConnectPc(tailscale, existing) {
  if (!tailscale.available || !tailscale.address) return null;
  const wasOpen = existing.peer !== null;
  const answer = await readVisibleLine(
    `다른 PC가 이 PC에 붙을 수 있게 열까요? (Connect PC) [${wasOpen ? "Y/n" : "y/N"}]: `,
  );
  const open = answer === "" ? wasOpen : /^y(es)?$/iu.test(answer);
  if (!open) return null;

  const { peers } = await readTailnetPeers();
  if (peers.length === 0) {
    console.log("tailnet에 다른 PC가 없습니다. 허용 목록이 비어 있으면 아무 PC도 붙을 수 없습니다.");
  } else {
    console.log("이 PC에 붙을 수 있게 허용할 PC를 고르세요 (쉼표로 여러 개, 비우면 지금 설정 유지):");
    peers.forEach((peer, index) => {
      const mark = existing.peer?.addresses.includes(peer.address) ? " (허용됨)" : "";
      console.log(`  ${index + 1}. ${peer.name}  ${peer.address}${mark}`);
    });
  }
  const picked = peers.length === 0 ? "" : await readVisibleLine("번호: ");
  const addresses = picked === "" ? existing.peer?.addresses ?? [] : parsePeerChoice(picked, peers);
  const port = existing.peer?.host === tailscale.address ? existing.peer.port : DEFAULT_PEER_PORT;
  return {
    host: tailscale.address,
    port,
    addresses,
    logins: existing.peer?.logins ?? [],
    hub: existing.peer?.hub ?? null,
  };
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
    // A leaf had no page. Every PC has one now, on loopback with a password,
    // and the leaf's link becomes its Connect PC port.
    console.log("이 PC는 예전 leaf 설치입니다. 이제 이 PC에도 화면과 로그인이 생깁니다.");
  }
  const connectPc = await chooseConnectPc(tailscale, existing);
  // Tailscale Serve holds the page's port (and any other HTTPS port it serves)
  // on the tailnet address, which would hide a Connect PC port there. A former
  // leaf listened on the page's port; its hub finds it again with Find new address.
  if (connectPc) connectPc.port = peerPortBeside(connectPc.port, port, tailscale.usedHttpsPorts);
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
    peer: connectPc,
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
  if (connectPc) {
    console.log(`Connect PC 포트: http://${connectPc.host}:${connectPc.port}`);
    console.log(connectPc.addresses.length > 0
      ? `이 PC에 붙을 수 있는 PC: ${connectPc.addresses.join(", ")}`
      : "허용한 PC가 없어 아직 아무 PC도 붙을 수 없습니다. 다시 실행해 고르세요.");
    console.log("붙일 PC의 화면에서 사이드바 + → Connect PC로 이 PC를 고르세요.");
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
