import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  ENV_TEMPLATE,
  SYSTEMD_UNITS,
  connect,
  isOurServer,
  parseEnvFile,
  pluginPaths,
  restart,
  serveUrls,
  serverEnvironment,
  start,
  status,
  stop,
} from "../src/plugin-runner.mjs";

const ROOT = "/plugins/herdrabbit/v2";
const ENV = {
  HOME: "/home/me",
  PATH: "/usr/bin",
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/run/herdr/default.sock",
  HERDR_BIN_PATH: "/home/me/.local/bin/herdr",
  HERDR_PLUGIN_ID: "herdrabbit",
  HERDR_PLUGIN_ROOT: ROOT,
  HERDR_PLUGIN_CONFIG_DIR: "/cfg",
  HERDR_PLUGIN_STATE_DIR: "/state",
  HERDR_PLUGIN_CONTEXT_JSON: "{}",
  HERDR_PANE_ID: "p1",
  HERDR_TAB_ID: "t1",
  HERDR_WORKSPACE_ID: "w1",
};

// A machine made of maps: files, processes by pid, which systemd units run
// and what answers on the network. Nothing real is started or signalled.
function fakeMachine({ files = {}, systemd = [], answer = null, processes = {}, afterSpawn = "up" } = {}) {
  const machine = {
    files: new Map(Object.entries(files)),
    processes: new Map(Object.entries(processes).map(([pid, cmd]) => [Number(pid), cmd])),
    answer,
    spawned: [],
    signals: [],
    clock: 0,
  };
  machine.deps = {
    env: ENV,
    fallbackRoot: "/unused",
    readFile: async (path) => {
      if (!machine.files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return machine.files.get(path);
    },
    writeFile: async (path, text) => { machine.files.set(path, text); },
    mkdir: async () => {},
    rm: async (path) => { machine.files.delete(path); },
    systemdActive: async (unit) => systemd.includes(unit),
    probe: async () => machine.answer,
    processCommand: async (pid) => machine.processes.get(pid) ?? null,
    spawnServer: async (options) => {
      machine.spawned.push(options);
      const pid = 4242;
      if (afterSpawn !== "exit") machine.processes.set(pid, `node ${options.entry}`);
      if (afterSpawn === "up") machine.answer = { herdrabbit: true, authRequired: true };
      return pid;
    },
    signal: (pid, name) => {
      machine.signals.push([pid, name]);
      machine.processes.delete(pid);
    },
    tailnetHostname: async () => "pc.example.ts.net",
    tailscaleServe: async () => null,
    qrCode: async () => null,
    readVersion: async () => "1.2.59",
    now: () => machine.clock,
    sleep: async (ms) => { machine.clock += ms; },
  };
  return machine;
}

const serverRecord = (root = ROOT, pid = 777) =>
  JSON.stringify({ pid, root, host: "127.0.0.1", port: 38787, startedAt: "2026-10-16T00:00:00.000Z" });

test("parses KEY=VALUE lines with comments, export and quotes", () => {
  assert.deepEqual(parseEnvFile([
    "# comment",
    "",
    "HERDR_WEB_PORT=39000",
    "export HERDR_WEB_HOST = 127.0.0.1  # trailing",
    "HERDR_BIN=\"/opt/herdr bin/herdr\"",
    "not a setting",
    "HERDR_WEB_ALLOWED_HOSTS='a.ts.net'",
  ].join("\n")), {
    HERDR_WEB_PORT: "39000",
    HERDR_WEB_HOST: "127.0.0.1",
    HERDR_BIN: "/opt/herdr bin/herdr",
    HERDR_WEB_ALLOWED_HOSTS: "a.ts.net",
  });
});

test("the settings template sets nothing and holds no secret", () => {
  assert.deepEqual(parseEnvFile(ENV_TEMPLATE), {});
  assert.doesNotMatch(ENV_TEMPLATE, /PASSWORD\s*=|AUTH_FILE/iu);
});

test("plugin paths use Herdr's folders and keep state out of the checkout", () => {
  const paths = pluginPaths(ENV, "/unused");
  assert.equal(paths.envFile, "/cfg/.env");
  assert.equal(paths.serverFile, "/state/server.json");
  assert.equal(paths.logFile, "/state/server.log");
  assert.equal(paths.entry, `${ROOT}/src/index.mjs`);
  const outside = pluginPaths({ HOME: "/home/me" }, "/repo");
  assert.equal(outside.root, "/repo");
  assert.equal(outside.envFile, "/home/me/.config/herdrabbit-plugin/.env");
  assert.equal(outside.stateDir, "/home/me/.local/state/herdrabbit-plugin");
});

test("the server gets no per-pane or socket variables, Herdr's binary and the settings", () => {
  const env = serverEnvironment(ENV, { HERDR_WEB_PORT: "39000" }, { tailnetHost: "pc.example.ts.net" });
  for (const key of Object.keys(env)) {
    assert.ok(!key.startsWith("HERDR_") || key.startsWith("HERDR_WEB_") || key === "HERDR_BIN", key);
  }
  assert.equal(env.HERDR_BIN, "/home/me/.local/bin/herdr");
  assert.equal(env.HERDR_WEB_PORT, "39000");
  assert.equal(env.HERDR_WEB_ALLOWED_HOSTS, "pc.example.ts.net");
  assert.equal(env.PATH, "/usr/bin");
  const own = serverEnvironment(ENV, { HERDR_BIN: "/x/herdr", HERDR_WEB_ALLOWED_HOSTS: "mine.ts.net" }, { tailnetHost: "pc.example.ts.net" });
  assert.equal(own.HERDR_BIN, "/x/herdr");
  assert.equal(own.HERDR_WEB_ALLOWED_HOSTS, "mine.ts.net");
});

test("the server learns its plugin id from Herdr, never from the settings", () => {
  assert.equal(serverEnvironment(ENV, { HERDR_WEB_PLUGIN_ID: "other" }).HERDR_WEB_PLUGIN_ID, "herdrabbit");
  const { HERDR_PLUGIN_ID: _, ...byHand } = ENV;
  assert.equal("HERDR_WEB_PLUGIN_ID" in serverEnvironment(byHand, { HERDR_WEB_PLUGIN_ID: "other" }), false);
});

test("start writes the settings template on first run", async () => {
  const machine = fakeMachine();
  const { result, lines } = await start(machine.deps);
  assert.equal(result, "started");
  assert.equal(machine.files.get("/cfg/.env"), ENV_TEMPLATE);
  assert.match(lines[0], /\/cfg\/\.env/u);
});

for (const unit of SYSTEMD_UNITS) {
  test(`start steps aside while ${unit} runs`, async () => {
    const machine = fakeMachine({ systemd: [unit] });
    const { result } = await start(machine.deps);
    assert.equal(result, "systemd");
    assert.equal(machine.spawned.length, 0);
  });
}

test("start does nothing when HerdRabbit already answers (a rerun after handoff)", async () => {
  const machine = fakeMachine({ answer: { herdrabbit: true, authRequired: false } });
  const { result } = await start(machine.deps);
  assert.equal(result, "running");
  assert.equal(machine.spawned.length, 0);
});

test("start refuses a port something else holds", async () => {
  const machine = fakeMachine({ answer: { herdrabbit: false } });
  const { result } = await start(machine.deps);
  assert.equal(result, "port-taken");
  assert.equal(machine.spawned.length, 0);
});

test("start spawns the checkout's server with the filtered environment and records it", async () => {
  const machine = fakeMachine({ files: { "/cfg/.env": "HERDR_WEB_PORT=39001\n" } });
  const { result, lines } = await start(machine.deps);
  assert.equal(result, "started");
  const [spawned] = machine.spawned;
  assert.equal(spawned.entry, `${ROOT}/src/index.mjs`);
  assert.equal(spawned.root, ROOT);
  assert.equal(spawned.logFile, "/state/server.log");
  assert.equal(spawned.env.HERDR_WEB_PORT, "39001");
  assert.equal(spawned.env.HERDR_SOCKET_PATH, undefined);
  assert.equal(spawned.env.HERDR_PANE_ID, undefined);
  assert.equal(spawned.env.HERDR_PLUGIN_ROOT, undefined);
  const record = JSON.parse(machine.files.get("/state/server.json"));
  assert.equal(record.pid, 4242);
  assert.equal(record.root, ROOT);
  assert.equal(record.port, 39001);
  assert.match(lines.at(-1), /127\.0\.0\.1:39001/u);
});

test("start reports a server that exits at once and forgets it", async () => {
  const machine = fakeMachine({ afterSpawn: "exit", files: { "/cfg/.env": "" } });
  const { result, lines } = await start(machine.deps);
  assert.equal(result, "failed");
  assert.equal(machine.files.has("/state/server.json"), false);
  assert.match(lines.at(-1), /server\.log/u);
});

test("start gives up after the timeout when the server never answers", async () => {
  const machine = fakeMachine({ afterSpawn: "silent", files: { "/cfg/.env": "" } });
  const { result } = await start(machine.deps);
  assert.equal(result, "failed");
  assert.ok(machine.clock >= 15_000);
});

test("a pid is ours only while it runs our entry point from the recorded checkout", () => {
  const record = { pid: 1, root: ROOT };
  assert.equal(isOurServer(`/usr/bin/node ${ROOT}/src/index.mjs`, record), true);
  assert.equal(isOurServer("/usr/bin/node /other/src/index.mjs", record), false);
  assert.equal(isOurServer("vim notes.txt", record), false);
  assert.equal(isOurServer(null, record), false);
});

test("stop never signals a pid that is not our server", async () => {
  const machine = fakeMachine({
    files: { "/cfg/.env": "", "/state/server.json": serverRecord() },
    processes: { 777: "bash" },
  });
  const { result } = await stop(machine.deps);
  assert.equal(result, "not-running");
  assert.deepEqual(machine.signals, []);
  assert.equal(machine.files.has("/state/server.json"), false);
});

test("stop leaves the systemd service alone", async () => {
  const machine = fakeMachine({ systemd: ["herdrabbit.service"], answer: { herdrabbit: true, authRequired: true } });
  const { result, lines } = await stop(machine.deps);
  assert.equal(result, "systemd");
  assert.deepEqual(machine.signals, []);
  assert.match(lines[0], /herdrabbit\.service/u);
});

test("stop sends SIGTERM to our server and removes its record", async () => {
  const machine = fakeMachine({
    files: { "/cfg/.env": "", "/state/server.json": serverRecord() },
    processes: { 777: `node ${ROOT}/src/index.mjs` },
  });
  const { result } = await stop(machine.deps);
  assert.equal(result, "stopped");
  assert.deepEqual(machine.signals, [[777, "SIGTERM"]]);
  assert.equal(machine.files.has("/state/server.json"), false);
});

test("restart stops our server and starts it again", async () => {
  const machine = fakeMachine({
    files: { "/cfg/.env": "", "/state/server.json": serverRecord() },
    processes: { 777: `node ${ROOT}/src/index.mjs` },
  });
  const { result } = await restart(machine.deps);
  assert.equal(result, "started");
  assert.deepEqual(machine.signals, [[777, "SIGTERM"]]);
  assert.equal(machine.spawned.length, 1);
});

test("status names the service, our pid, the address and an old checkout", async () => {
  const old = "/plugins/herdrabbit/v1";
  const machine = fakeMachine({
    files: { "/cfg/.env": "", "/state/server.json": serverRecord(old) },
    processes: { 777: `node ${old}/src/index.mjs` },
    answer: { herdrabbit: true, authRequired: true },
  });
  const { result, lines } = await status(machine.deps);
  const text = lines.join("\n");
  assert.equal(result, "up");
  assert.match(text, /1\.2\.59/u);
  assert.match(text, /systemd 서비스: 실행 중 아님/u);
  assert.match(text, /pid 777/u);
  assert.match(text, /http:\/\/127\.0\.0\.1:38787 응답함 \(비밀번호 설정됨\)/u);
  assert.match(text, /이전 체크아웃\(\/plugins\/herdrabbit\/v1\)/u);
  assert.match(text, /herdrabbit\.restart/u);
});

test("status of a stopped plugin says nothing answers", async () => {
  const machine = fakeMachine({ files: { "/cfg/.env": "" } });
  const { result, lines } = await status(machine.deps);
  assert.equal(result, "down");
  assert.match(lines.join("\n"), /응답 없음/u);
});

test("serve URLs are the Tailscale sites that proxy to this port", () => {
  const serve = {
    TCP: { 38787: { HTTPS: true }, 443: { HTTPS: true } },
    Web: {
      "pc.example.ts.net:38787": { Handlers: { "/": { Proxy: "http://127.0.0.1:38787" } } },
      "pc.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
    },
  };
  assert.deepEqual(serveUrls(serve, 38787), ["https://pc.example.ts.net:38787"]);
  assert.deepEqual(serveUrls({ Web: { "pc.example.ts.net:443": { Handlers: { "/": { Proxy: "localhost:38787" } } } } }, 38787), ["https://pc.example.ts.net"]);
  assert.deepEqual(serveUrls(null, 38787), []);
});

test("the connect pane shows the addresses, the password state and a QR code, never a secret", async () => {
  const secret = "{\"hash\":\"SECRET-HASH-VALUE\",\"secret\":\"SIGNING-KEY\"}";
  const machine = fakeMachine({
    files: { "/cfg/.env": "", "/home/me/.config/herdr-bridge/auth.json": secret },
    answer: { herdrabbit: true, authRequired: true },
  });
  const reads = [];
  const readFileOriginal = machine.deps.readFile;
  machine.deps.readFile = async (path) => { reads.push(path); return readFileOriginal(path); };
  machine.deps.tailscaleServe = async () => ({
    Web: { "pc.example.ts.net:38787": { Handlers: { "/": { Proxy: "http://127.0.0.1:38787" } } } },
  });
  machine.deps.qrCode = async (url) => `QR(${url})\n`;
  const { lines } = await connect(machine.deps);
  const text = lines.join("\n");
  assert.match(text, /http:\/\/127\.0\.0\.1:38787/u);
  assert.match(text, /https:\/\/pc\.example\.ts\.net:38787/u);
  assert.match(text, /비밀번호: 설정됨/u);
  assert.match(text, /--entrypoint password/u);
  assert.match(text, /npm run password/u);
  assert.match(text, /QR\(https:\/\/pc\.example\.ts\.net:38787\)/u);
  assert.doesNotMatch(text, /SECRET-HASH-VALUE|SIGNING-KEY|auth\.json/u);
  assert.ok(reads.every((path) => !path.includes("auth.json")), "the password file is never read");
});

test("the connect pane without Tailscale Serve or a running server says what to do and shows no QR", async () => {
  const machine = fakeMachine({ files: { "/cfg/.env": "" } });
  let asked = false;
  machine.deps.qrCode = async () => { asked = true; return "QR"; };
  const { lines } = await connect(machine.deps);
  const text = lines.join("\n");
  assert.match(text, /herdrabbit\.start/u);
  assert.match(text, /tailscale serve --bg --https=38787/u);
  assert.match(text, /확인할 수 없습니다/u);
  assert.equal(asked, false);
});

// A small TOML reader for what herdr-plugin.toml uses: comments, key = string,
// key = [strings], and [[tables]].
function readManifest(text) {
  const manifest = {};
  let target = manifest;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*#.*$/u, "").trim();
    if (line === "") continue;
    const table = /^\[\[([a-z_.]+)\]\]$/u.exec(line);
    if (table) {
      target = {};
      (manifest[table[1]] ??= []).push(target);
      continue;
    }
    const pair = /^([a-z_]+)\s*=\s*(.+)$/u.exec(line);
    assert.ok(pair, `unreadable line: ${raw}`);
    assert.equal(target[pair[1]], undefined, `duplicate key ${pair[1]}`);
    target[pair[1]] = JSON.parse(pair[2]);
  }
  return manifest;
}

test("herdr-plugin.toml declares the plugin, its build, startup, actions and panes", async () => {
  const manifest = readManifest(await readFile(new URL("../herdr-plugin.toml", import.meta.url), "utf8"));
  assert.equal(manifest.id, "herdrabbit");
  assert.match(manifest.id, /^[A-Za-z0-9.:_-]+$/u);
  assert.equal(manifest.name, "HerdRabbit");
  assert.match(manifest.min_herdr_version, /^\d+\.\d+\.\d+$/u);
  assert.deepEqual(manifest.platforms, ["linux", "macos"]);
  assert.deepEqual(manifest.build.map((entry) => entry.command), [["npm", "ci", "--omit=dev"]]);
  assert.deepEqual(manifest.startup.map((entry) => entry.command), [["node", "scripts/plugin.mjs", "startup"]]);
  assert.deepEqual(manifest.actions.map((entry) => entry.id), ["start", "stop", "status", "restart"]);
  assert.deepEqual(manifest.panes.map((entry) => entry.id), ["connect", "password"]);
  for (const entry of [...manifest.actions, ...manifest.panes]) {
    assert.doesNotMatch(entry.id, /\./u);
    assert.equal(typeof entry.title, "string");
    assert.deepEqual(entry.command, ["node", "scripts/plugin.mjs", entry.id]);
  }
});

test("a second startup waits for our live server instead of spawning another", async () => {
  const machine = fakeMachine({
    files: { "/cfg/.env": "", "/state/server.json": serverRecord() },
    processes: { 777: `node ${ROOT}/src/index.mjs` },
  });
  let probes = 0;
  machine.deps.probe = async () => (++probes > 3 ? { herdrabbit: true, authRequired: true } : null);
  const before = machine.files.get("/state/server.json");
  const { result } = await start(machine.deps);
  assert.equal(result, "running");
  assert.equal(machine.spawned.length, 0);
  assert.equal(machine.files.get("/state/server.json"), before);
});

test("an answer from someone else is not recorded when our spawned pid died", async () => {
  const machine = fakeMachine({ afterSpawn: "exit", files: { "/cfg/.env": "" } });
  machine.deps.spawnServer = async (options) => {
    machine.spawned.push(options);
    machine.answer = { herdrabbit: true, authRequired: true };
    return 4242;
  };
  const { result, lines } = await start(machine.deps);
  assert.equal(result, "failed");
  assert.equal(machine.files.has("/state/server.json"), false);
  assert.match(lines.at(-1), /server\.log/u);
});

test("the startup hook restarts our server running from an old checkout", async () => {
  const old = "/plugins/herdrabbit/v1";
  const machine = fakeMachine({
    files: { "/cfg/.env": "", "/state/server.json": serverRecord(old) },
    processes: { 777: ["node", `${old}/src/index.mjs`] },
    answer: { herdrabbit: true, authRequired: true },
  });
  machine.deps.signal = (pid, name) => {
    machine.signals.push([pid, name]);
    machine.processes.delete(pid);
    machine.answer = null;
  };
  const { result } = await start(machine.deps, { restartStale: true });
  assert.equal(result, "started");
  assert.deepEqual(machine.signals, [[777, "SIGTERM"]]);
  assert.equal(machine.spawned.length, 1);
  assert.equal(JSON.parse(machine.files.get("/state/server.json")).root, ROOT);
});

test("start without the startup hook, or for a server that is not ours, never restarts", async () => {
  const old = "/plugins/herdrabbit/v1";
  const answering = { herdrabbit: true, authRequired: true };
  const plain = fakeMachine({
    files: { "/cfg/.env": "", "/state/server.json": serverRecord(old) },
    processes: { 777: ["node", `${old}/src/index.mjs`] },
    answer: answering,
  });
  assert.equal((await start(plain.deps)).result, "running");
  assert.deepEqual(plain.signals, []);
  const foreign = fakeMachine({
    files: { "/cfg/.env": "", "/state/server.json": serverRecord(old) },
    processes: { 777: ["bash"] },
    answer: answering,
  });
  assert.equal((await start(foreign.deps, { restartStale: true })).result, "running");
  assert.deepEqual(foreign.signals, []);
  assert.equal(foreign.spawned.length, 0);
});

test("a pid whose other argument merely contains the entry path is not ours", () => {
  const record = { pid: 1, root: ROOT };
  const entry = `${ROOT}/src/index.mjs`;
  assert.equal(isOurServer(["node", entry], record), true);
  assert.equal(isOurServer(["node", `${entry}.bak`], record), false);
  assert.equal(isOurServer(["vim", `/tmp${entry}`], record), false);
  assert.equal(isOurServer(["sh", "-c", `node ${entry}`], record), false);
  assert.equal(isOurServer(`node ${entry}`, record), true);
  assert.equal(isOurServer(`node ${entry} --x`, record), true);
  assert.equal(isOurServer(`node /tmp${entry}`, record), false);
  assert.equal(isOurServer(`vim ${entry}.bak`, record), false);
  assert.equal(isOurServer(["node", entry], { pid: 1, root: "relative" }), false);
});

test("the connect pane quotes the checkout path in the cd command", async () => {
  const machine = fakeMachine({ files: { "/cfg/.env": "" } });
  machine.deps.env = { ...ENV, HERDR_PLUGIN_ROOT: "/my plugins/it's here" };
  const { lines } = await connect(machine.deps);
  assert.ok(lines.includes(`  또는 터미널에서: cd '/my plugins/it'\\''s here' && npm run password`));
});
