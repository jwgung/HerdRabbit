import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { MIN_HERDR_VERSION, herdrVersionSupported, readHerdrVersion } from "../src/herdr-version.mjs";

export const HERDR_INSTALL_URL = "https://herdr.dev/install.sh";

async function canExecute(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function executableOnPath(
  name,
  {
    path = process.env.PATH || "",
    isExecutable = canExecute,
  } = {},
) {
  for (const directory of String(path).split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function runInteractive(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

export async function installHerdrFromOfficialScript({
  installDir,
  fetchImpl = fetch,
} = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "herdr-install-"));
  const installerPath = join(temporaryDirectory, "install.sh");
  try {
    const response = await fetchImpl(HERDR_INSTALL_URL, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Herdr installer download returned HTTP ${response.status}`);
    }
    await writeFile(installerPath, await response.text(), { mode: 0o700 });
    await runInteractive("sh", [installerPath], {
      env: { ...process.env, HERDR_INSTALL_DIR: installDir },
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// --handoff keeps the panes of a running Herdr alive across the upgrade.
export function updateHerdr(executable) {
  return runInteractive(executable, ["update", "--handoff"]);
}

async function ensureSupportedVersion(executable, { readVersion, update, log }) {
  const version = await readVersion(executable);
  if (herdrVersionSupported(version)) return;
  log(`Herdr ${version || "(버전 알 수 없음)"}이 ${MIN_HERDR_VERSION}보다 낮아 업데이트합니다…`);
  await update(executable);
  const updated = await readVersion(executable);
  if (!herdrVersionSupported(updated)) {
    throw new Error(`Herdr ${updated || "(unknown version)"} at ${executable} is older than ${MIN_HERDR_VERSION}; update it and run the installer again`);
  }
  log(`Herdr 업데이트 완료: ${updated}`);
}

export async function ensureHerdrExecutable({
  path = process.env.PATH || "",
  installDir = process.env.HERDR_INSTALL_DIR || join(homedir(), ".local", "bin"),
  isExecutable = canExecute,
  install = installHerdrFromOfficialScript,
  readVersion = readHerdrVersion,
  update = updateHerdr,
  log = console.log,
} = {}) {
  const existing = await executableOnPath("herdr", { path, isExecutable });
  if (existing) {
    await ensureSupportedVersion(existing, { readVersion, update, log });
    return existing;
  }

  const absoluteInstallDir = resolve(installDir);
  log("Herdr를 찾을 수 없어 공식 설치 스크립트로 설치합니다…");
  await install({ installDir: absoluteInstallDir });

  const installed = join(absoluteInstallDir, "herdr");
  if (!(await isExecutable(installed))) {
    throw new Error(`Herdr installation finished but ${installed} is not executable`);
  }
  log(`Herdr 설치 완료: ${installed}`);
  return installed;
}
