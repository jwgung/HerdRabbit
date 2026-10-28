import test from "node:test";
import assert from "node:assert/strict";
import { ENV_TEMPLATE, parseEnvFile } from "../src/plugin-runner.mjs";
import { installPlugin, newEnvText } from "../scripts/install-plugin.mjs";

const CONFIG = "/home/me/.config/herdr/plugins/config/herdrabbit";
const HERDR = "/home/me/.local/bin/herdr";

// A PC made of answers: no systemd unit unless given, a Herdr that may or may
// not be running, and Tailscale as told. Nothing real runs.
function fakePc({
  unit = false, herdrRunning = true, answers = true, tailscale = { available: true, hostname: "pc.example.ts.net", usedHttpsPorts: new Set() },
  files = {}, authExists = false, confirm = false, platform = "linux", taken = null, serveFails = false,
} = {}) {
  const pc = { calls: [], files: new Map(Object.entries(files)), logs: [], passwords: [], serve: [], up: false, migrated: false };
  let now = 0;
  pc.deps = {
    platform,
    run: async (file, args) => {
      pc.calls.push([file, ...args].join(" "));
      if (file === "systemctl") {
        return { code: 0, stdout: unit && args[2] === "herdrabbit.service" ? "LoadState=loaded\nEnvironment=HERDR_WEB_PORT=38787\n" : "LoadState=not-found\n" };
      }
      if (args[1] === "install") return { code: 0, stdout: "" };
      if (args[1] === "config-dir") return { code: 0, stdout: `${CONFIG}\n` };
      if (args[1] === "action") {
        if (!herdrRunning) return { code: 1, stdout: "" };
        if (answers) pc.up = true;
        return { code: 0, stdout: "" };
      }
      throw new Error(`unexpected ${file} ${args.join(" ")}`);
    },
    migrate: async (herdr) => { pc.migrated = herdr; return 0; },
    ensureHerdr: async () => HERDR,
    tailscale: async () => tailscale,
    probe: async (_host, port) => (port === taken ? { herdrabbit: true } : pc.up ? { herdrabbit: true, authRequired: true } : null),
    findPort: async () => 38790,
    readFile: async (path) => {
      if (!pc.files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return pc.files.get(path);
    },
    writeFile: async (path, text) => { pc.files.set(path, text); },
    authExists: async () => authExists,
    confirm: async () => confirm,
    askPassword: async () => "secret",
    writePassword: async (password) => { pc.passwords.push(password); return { required: password !== "" }; },
    configureClaude: async () => ({ path: "/home/me/.claude/settings.json" }),
    registerServe: async (port) => { if (serveFails) throw new Error("sudo refused"); pc.serve.push(port); },
    reaches: async () => true,
    log: (text) => pc.logs.push(text),
    now: () => now,
    sleep: async (ms) => { now += ms; },
  };
  return pc;
}

test("a new PC gets the plugin on a free port, its tailnet name, a password and Tailscale Serve", async () => {
  const pc = fakePc();
  assert.equal(await installPlugin(pc.deps), 0);
  assert.ok(pc.calls.includes(`${HERDR} plugin install jwgung/HerdRabbit --yes`));
  const settings = parseEnvFile(pc.files.get(`${CONFIG}/.env`));
  assert.deepEqual(settings, { HERDR_WEB_HOST: "127.0.0.1", HERDR_WEB_PORT: "38790", HERDR_WEB_ALLOWED_HOSTS: "pc.example.ts.net" });
  assert.deepEqual(pc.passwords, ["secret"]);
  assert.ok(pc.calls.includes(`${HERDR} plugin action invoke herdrabbit.restart`));
  assert.deepEqual(pc.serve, [38790]);
  assert.ok(pc.logs.includes("휴대폰·다른 기기: https://pc.example.ts.net:38790"));
  assert.equal(pc.migrated, false);
});

test("a PC with the older systemd service is moved over instead", async () => {
  const pc = fakePc({ unit: true });
  assert.equal(await installPlugin(pc.deps), 0);
  assert.equal(pc.migrated, HERDR, "with the Herdr just checked, not the unit's");
  assert.equal(pc.calls.some((call) => call.includes("plugin install")), false);
  // Not on macOS, where there is no systemd to ask.
  const mac = fakePc({ unit: true, platform: "darwin" });
  assert.equal(await installPlugin(mac.deps), 0);
  assert.equal(mac.migrated, false);
  assert.equal(mac.calls.some((call) => call.startsWith("systemctl")), false);
});

test("Tailscale Serve is never pointed at a port something else answers on", async () => {
  const pc = fakePc({ herdrRunning: false, taken: 38790 });
  pc.deps.probe = async (_host, port) => (port === 38790 ? { herdrabbit: false } : null);
  assert.equal(await installPlugin(pc.deps), 0);
  assert.deepEqual(pc.serve, []);
  assert.ok(pc.logs.some((line) => line.includes("다른 프로그램이 응답해")));
});

test("run again, the settings, the port and the password stay unless asked", async () => {
  const text = "HERDR_WEB_PORT=39001\n";
  const pc = fakePc({ files: { [`${CONFIG}/.env`]: text }, authExists: true });
  assert.equal(await installPlugin(pc.deps), 0);
  assert.equal(pc.files.get(`${CONFIG}/.env`), text);
  assert.deepEqual(pc.passwords, [], "an existing password is not replaced, or turned off, without a yes");
  assert.deepEqual(pc.serve, [39001]);
  const asked = fakePc({ authExists: true, confirm: true });
  assert.equal(await installPlugin(asked.deps), 0);
  assert.deepEqual(asked.passwords, ["secret"]);
  // This user's plugin, started before on the usual port, keeps it.
  const earlier = fakePc({ taken: 38787, files: { [`${CONFIG}/.env`]: ENV_TEMPLATE } });
  assert.equal(await installPlugin(earlier.deps), 0);
  assert.equal(parseEnvFile(earlier.files.get(`${CONFIG}/.env`)).HERDR_WEB_PORT, "38787");
  // Whatever answers there without that is not taken for this user's.
  const foreign = fakePc({ taken: 38787 });
  assert.equal(await installPlugin(foreign.deps), 0);
  assert.equal(parseEnvFile(foreign.files.get(`${CONFIG}/.env`)).HERDR_WEB_PORT, "38790");
});

test("a failed plugin install or an unreadable kept .env stops with a reason", async () => {
  const pc = fakePc();
  const inner = pc.deps.run;
  pc.deps.run = async (file, args, options) => (args[1] === "install" ? { code: 1, stdout: "" } : inner(file, args, options));
  assert.equal(await installPlugin(pc.deps), 1);
  assert.equal(pc.passwords.length, 0);
  const bad = fakePc({ files: { [`${CONFIG}/.env`]: "HERDR_WEB_PORT=nope\n" } });
  assert.equal(await installPlugin(bad.deps), 1);
  assert.ok(bad.logs.some((line) => line.includes("플러그인 설정 파일을 읽을 수 없습니다")));
});

test("without Herdr running or Tailscale the install still completes and says what is left", async () => {
  const pc = fakePc({ herdrRunning: false, tailscale: { available: false, hostname: "", usedHttpsPorts: new Set() } });
  assert.equal(await installPlugin(pc.deps), 0);
  assert.ok(pc.logs.some((line) => line.includes("herdr를 실행하면 HerdRabbit도 함께 시작합니다")));
  assert.ok(pc.logs.some((line) => line.includes("HTTPS 등록을 건너뛰었습니다")));
  assert.equal("HERDR_WEB_ALLOWED_HOSTS" in parseEnvFile(pc.files.get(`${CONFIG}/.env`)), false);
  const refused = fakePc({ serveFails: true });
  assert.equal(await installPlugin(refused.deps), 0);
  assert.ok(refused.logs.some((line) => line.includes("sudo tailscale serve --bg --yes --https=38790")));
});

test("a plugin that never answers is a failed install", async () => {
  const pc = fakePc({ answers: false });
  assert.equal(await installPlugin(pc.deps), 1);
});

test("a new .env carries the template for reference", () => {
  const text = newEnvText({ port: 38787, hostname: "", date: "2026-10-20" });
  assert.ok(text.endsWith(ENV_TEMPLATE));
  assert.deepEqual(parseEnvFile(text), { HERDR_WEB_HOST: "127.0.0.1", HERDR_WEB_PORT: "38787" });
});
