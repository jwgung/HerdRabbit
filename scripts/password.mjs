#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  defaultAuthFilePath,
  writePasswordConfiguration,
} from "../src/password-auth.mjs";
import { SYSTEMD_UNITS } from "../src/plugin-runner.mjs";
import { promptForNewPassword } from "./password-prompt.mjs";

const execFileAsync = promisify(execFile);

async function restartInstalledService() {
  for (const unit of SYSTEMD_UNITS) {
    try {
      await execFileAsync("systemctl", ["--user", "try-restart", unit]);
      return true;
    } catch {}
  }
  return false;
}

async function main() {
  const authFile = defaultAuthFilePath();
  const password = await promptForNewPassword();
  const result = await writePasswordConfiguration(authFile, password);
  const restarted = await restartInstalledService();
  console.log(
    result.required
      ? "비밀번호 인증을 활성화했습니다."
      : "비밀번호 인증을 비활성화했습니다.",
  );
  console.log(`설정 파일: ${authFile}`);
  if (restarted) console.log("HerdRabbit 서비스를 다시 시작했습니다.");
  else console.log("변경 사항을 적용하려면 HerdRabbit을 다시 시작하세요.");
}

main().catch((error) => {
  console.error(`비밀번호 설정 실패: ${error.message}`);
  process.exitCode = 1;
});
