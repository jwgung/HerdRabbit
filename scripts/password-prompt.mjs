import readline from "node:readline";

export function readHiddenLine(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("비밀번호 설정에는 대화형 터미널이 필요합니다.");
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const previousRawMode = input.isRaw;
    let value = "";

    function cleanup() {
      input.off("keypress", onKeypress);
      input.setRawMode(previousRawMode === true);
      input.pause();
    }

    function onKeypress(character, key = {}) {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        reject(new Error("비밀번호 설정을 취소했습니다."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (typeof character === "string" && !key.ctrl && !key.meta) {
        value += character;
      }
    }

    readline.emitKeypressEvents(input);
    output.write(label);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
  });
}

export async function promptForNewPassword() {
  const password = await readHiddenLine(
    "HerdRabbit 비밀번호 (비워 두면 사용 안 함): ",
  );
  if (password === "") return "";
  if (password.length > 256) {
    throw new Error("비밀번호는 256자 이하여야 합니다.");
  }
  const confirmation = await readHiddenLine("비밀번호 확인: ");
  if (password !== confirmation) {
    throw new Error("비밀번호가 일치하지 않습니다.");
  }
  return password;
}
