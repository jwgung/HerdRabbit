import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseSystemdEnvironment } from "../scripts/service-environment.mjs";

test("reads assignments the way systemctl prints them, quoted ones included", () => {
  const environment = parseSystemdEnvironment(
    'HERDR_WEB_PORT=38787 "HERDR_BIN=/opt/Herdr Tools/herdr" "HERDR_WEB_HUB=a\\"b\\\\c"\n',
  );
  assert.equal(environment.get("HERDR_WEB_PORT"), "38787");
  assert.equal(environment.get("HERDR_BIN"), "/opt/Herdr Tools/herdr");
  assert.equal(environment.get("HERDR_WEB_HUB"), 'a"b\\c');
  assert.equal(parseSystemdEnvironment("").size, 0);
});

test("prints one variable for a shell to read, and nothing when it is unset", () => {
  const script = new URL("../scripts/service-environment.mjs", import.meta.url).pathname;
  const read = (input) => spawnSync(process.execPath, [script, "HERDR_BIN"], { input, encoding: "utf8" }).stdout;
  assert.equal(read('"HERDR_BIN=/opt/Herdr Tools/herdr" HERDR_WEB_PORT=1'), "/opt/Herdr Tools/herdr\n");
  assert.equal(read("HERDR_WEB_PORT=1"), "");
});
