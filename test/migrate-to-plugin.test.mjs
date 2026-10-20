import test from "node:test";
import assert from "node:assert/strict";
import { ENV_TEMPLATE, parseEnvFile } from "../src/plugin-runner.mjs";
import { envValue, hasSettings, migrate, pluginEnvText } from "../scripts/migrate-to-plugin.mjs";

const HOME = "/home/me";
const INSTALL = "/home/me/.local/share/herd-rabbit";
const UNIT_FILE = "/home/me/.config/systemd/user/herdrabbit.service";
const CONFIG = "/home/me/.config/herdr/plugins/config/herdrabbit";
const UNIT_ENV = [
  "HERDR_WEB_PORT=38787", "HERDR_WEB_HOST=127.0.0.1", "HERDR_WEB_AUTH_FILE=/home/me/.config/herdr-bridge/auth.json",
  "HERDR_WEB_ALLOWED_HOSTS=pc.example.ts.net", "HERDR_WEB_PEER_HOST=100.64.0.2", "HERDR_WEB_PEER_PORT=38788",
  "HERDR_WEB_PEER_ADDRESSES=100.64.0.3", "\"HERDR_BIN=/opt/Herdr Tools/herdr\"",
].join(" ");

// A PC made of answers: which unit systemd has, what herdr and git say, and
// whether the page answers once the plugin starts. Nothing real runs.
function fakePc({
  unit = "herdrabbit.service", environment = UNIT_ENV, directory = INSTALL, file = UNIT_FILE, files = {},
  install = 0, start = 0, answers = true, origin = "https://github.com/ultivis-iot/HerdRabbit.git", dirty = "",
} = {}) {
  const pc = { calls: [], files: new Map(Object.entries(files)), removed: [], logs: [], serviceUp: true, pluginUp: false };
  let now = 0;
  pc.deps = {
    run: async (fileName, args) => {
      pc.calls.push([fileName, ...args].join(" "));
      if (fileName === "systemctl") {
        if (args[1] === "show") {
          if (args[2] !== unit) return { code: 0, stdout: "LoadState=not-found\n" };
          return { code: 0, stdout: `LoadState=loaded\nWorkingDirectory=${directory}\nFragmentPath=${file}\nEnvironment=${environment}\n` };
        }
        if (args[1] === "stop") pc.serviceUp = false;
        if (args[1] === "start") pc.serviceUp = true;
        return { code: 0, stdout: "" };
      }
      if (fileName === "git") {
        if (args.includes("get-url")) return { code: 0, stdout: `${origin}\n` };
        if (args.includes("status")) return { code: 0, stdout: dirty };
      }
      if (args[0] === "plugin") {
        if (args[1] === "install") return { code: install, stdout: "" };
        if (args[1] === "config-dir") return { code: 0, stdout: `${CONFIG}\n` };
        if (args[1] === "action") {
          if (start === 0 && answers) pc.pluginUp = true;
          return { code: start, stdout: "" };
        }
      }
      throw new Error(`unexpected ${fileName} ${args.join(" ")}`);
    },
    readFile: async (path) => {
      if (!pc.files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return pc.files.get(path);
    },
    writeFile: async (path, text) => { pc.files.set(path, text); },
    rm: async (path) => { pc.removed.push(path); },
    probe: async () => (pc.pluginUp || pc.serviceUp ? { herdrabbit: true, authRequired: true } : null),
    confirm: async () => true,
    log: (text) => pc.logs.push(text),
    now: () => now,
    sleep: async (ms) => { now += ms; },
    home: HOME,
    installDirectory: INSTALL,
  };
  return pc;
}

test("values are written as the plugin's .env reads them back", () => {
  assert.equal(envValue("100.64.0.2"), "100.64.0.2");
  assert.equal(envValue("/opt/Herdr Tools/herdr"), "\"/opt/Herdr Tools/herdr\"");
  assert.equal(envValue("a#b c"), "\"a#b c\"");
  assert.equal(envValue("say \"hi\""), null);
  const { text, skipped } = pluginEnvText(new Map([
    ["HERDR_WEB_PORT", "38787"], ["HERDR_WEB_FILES_DIR", "/data/My Files #1"], ["HERDR_WEB_ROLE", "hub"],
    ["HERDR_BIN", "/opt/herdr"], ["PATH", "/usr/bin"], ["HERDR_WEB_HUB", "x\"y"],
  ]), { unit: "herdrabbit.service", date: "2026-10-20" });
  assert.deepEqual(parseEnvFile(text), { HERDR_WEB_PORT: "38787", HERDR_WEB_FILES_DIR: "/data/My Files #1" });
  assert.deepEqual(skipped, ["HERDR_WEB_HUB"]);
  assert.ok(text.endsWith(ENV_TEMPLATE));
  assert.equal(hasSettings(ENV_TEMPLATE), false);
  assert.equal(hasSettings(text), true);
});

test("a service moves to the plugin, keeping its settings, and the old install goes", async () => {
  const pc = fakePc();
  assert.equal(await migrate(pc.deps), 0);
  const settings = parseEnvFile(pc.files.get(`${CONFIG}/.env`));
  assert.equal(settings.HERDR_WEB_PEER_HOST, "100.64.0.2");
  assert.equal(settings.HERDR_WEB_PEER_ADDRESSES, "100.64.0.3");
  assert.equal(settings.HERDR_WEB_AUTH_FILE, "/home/me/.config/herdr-bridge/auth.json");
  assert.equal(settings.HERDR_WEB_PORT, "38787");
  assert.equal("HERDR_BIN" in settings, false, "the plugin uses the Herdr that runs it");
  // The service's own Herdr installs the plugin, and the service stops before the plugin starts.
  const order = pc.calls.filter((call) => /plugin install|stop herdrabbit|action invoke|disable/u.test(call));
  assert.deepEqual(order, [
    "/opt/Herdr Tools/herdr plugin install ultivis-iot/HerdRabbit --yes",
    "systemctl --user stop herdrabbit.service",
    "/opt/Herdr Tools/herdr plugin action invoke herdrabbit.start",
    "systemctl --user disable herdrabbit.service",
  ]);
  assert.deepEqual(pc.removed, [UNIT_FILE, INSTALL]);
  assert.ok(pc.calls.includes("systemctl --user daemon-reload"));
});

test("a plugin that does not answer puts the service back and removes nothing", async () => {
  for (const pc of [fakePc({ start: 1 }), fakePc({ answers: false })]) {
    assert.equal(await migrate(pc.deps), 1);
    assert.equal(pc.serviceUp, true);
    assert.deepEqual(pc.removed, []);
    assert.equal(pc.calls.some((call) => call.includes("disable")), false);
  }
});

test("a failed plugin install leaves the service running and untouched", async () => {
  const pc = fakePc({ install: 1 });
  assert.equal(await migrate(pc.deps), 1);
  assert.equal(pc.calls.some((call) => call.includes("stop")), false);
  assert.equal(pc.files.size, 0);
});

test("a checkout someone works in, or a unit outside this user's folder, is kept", async () => {
  for (const options of [
    { directory: "/home/me/src/herdrabbit" },
    { dirty: " M src/index.mjs\n" },
    { dirty: "!! node_modules/\n!! tmp/\n" },
    { origin: "https://example.invalid/fork.git" },
  ]) {
    const pc = fakePc(options);
    assert.equal(await migrate(pc.deps), 0);
    assert.deepEqual(pc.removed, [UNIT_FILE], JSON.stringify(options));
  }
  const installed = fakePc({ dirty: "!! node_modules/\n" });
  assert.equal(await migrate(installed.deps), 0);
  assert.deepEqual(installed.removed, [UNIT_FILE, INSTALL], "its installed dependencies do not keep it");
  const system = fakePc({ file: "/etc/systemd/user/herdrabbit.service" });
  assert.equal(await migrate(system.deps), 0);
  assert.deepEqual(system.removed, [INSTALL]);
});

test("settings already in the plugin's .env are the user's and are kept", async () => {
  const pc = fakePc({ files: { [`${CONFIG}/.env`]: "HERDR_WEB_PORT=39000\n" } });
  assert.equal(await migrate(pc.deps), 0);
  assert.equal(pc.files.get(`${CONFIG}/.env`), "HERDR_WEB_PORT=39000\n");
});

test("nothing happens without a service, for a leaf, or when the user says no", async () => {
  const none = fakePc({ unit: "other.service" });
  assert.equal(await migrate(none.deps), 1);
  const leaf = fakePc({ environment: `${UNIT_ENV} HERDR_WEB_ROLE=leaf` });
  assert.equal(await migrate(leaf.deps), 1);
  const declined = fakePc();
  declined.deps.confirm = async () => false;
  assert.equal(await migrate(declined.deps), 1);
  for (const pc of [none, leaf, declined]) {
    assert.equal(pc.calls.some((call) => call.includes("plugin install") || call.includes("stop")), false);
  }
  // The older unit name is found too.
  const legacy = fakePc({ unit: "herdr-web-local.service" });
  assert.equal(await migrate(legacy.deps), 0);
});
