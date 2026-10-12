import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSystemdEnvironment } from "../scripts/service-environment.mjs";

const run = promisify(execFile);

test("reads assignments the way systemctl prints them, quoted ones included", () => {
  const environment = parseSystemdEnvironment(
    'HERDR_WEB_PORT=38787 "HERDR_BIN=/opt/Herdr Tools/herdr" "HERDR_WEB_HUB=a\\"b\\\\c"\n',
  );
  assert.equal(environment.get("HERDR_WEB_PORT"), "38787");
  assert.equal(environment.get("HERDR_BIN"), "/opt/Herdr Tools/herdr");
  assert.equal(environment.get("HERDR_WEB_HUB"), 'a"b\\c');
  assert.equal(parseSystemdEnvironment("").size, 0);
});

test("prints one variable for a shell to read, and nothing when it is unset", async () => {
  const script = new URL("../scripts/service-environment.mjs", import.meta.url).pathname;
  const child = run(process.execPath, [script, "HERDR_BIN"]);
  child.child.stdin.end('"HERDR_BIN=/opt/Herdr Tools/herdr" HERDR_WEB_PORT=1');
  assert.equal((await child).stdout, "/opt/Herdr Tools/herdr\n");
  const missing = run(process.execPath, [script, "HERDR_BIN"]);
  missing.child.stdin.end("HERDR_WEB_PORT=1");
  assert.equal((await missing).stdout, "");
});
