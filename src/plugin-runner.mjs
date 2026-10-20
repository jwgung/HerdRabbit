// HerdRabbit as a Herdr plugin: what the startup hook, the actions and the
// Connect pane do. Everything that touches the machine -- files, systemctl,
// the network, processes -- comes in through `deps`, so the decisions here are
// tested without starting or signalling anything.
//
// The plugin is the way to install HerdRabbit; an older systemd service
// (npm run install-service) still works. The plugin steps aside whenever that
// service, or any HerdRabbit at all, already answers on the configured address.
import { isAbsolute, join, resolve } from "node:path";
import { hostPort, parseHost, parsePort } from "./config.mjs";

// Both names: the current unit and the one older installers wrote.
export const SYSTEMD_UNITS = Object.freeze(["herdrabbit.service", "herdr-web-local.service"]);
export const START_TIMEOUT_MS = 15_000;
export const STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 300;

export const ENV_TEMPLATE = `# HerdRabbit settings for the Herdr plugin.
# One KEY=VALUE per line; lines starting with # are ignored.
# Only HERDR_WEB_* and HERDR_BIN are read. Restart after a change:
#   herdr plugin action invoke herdrabbit.restart
# No password goes here: set one with the HerdRabbit "password" pane
# (herdr plugin pane open --plugin herdrabbit --entrypoint password).

# Address the page listens on. Keep 127.0.0.1 behind Tailscale Serve.
# HERDR_WEB_HOST=127.0.0.1
# HERDR_WEB_PORT=38787

# Tailscale (or reverse proxy) host names allowed to reach the page,
# comma-separated. Left unset, this PC's tailnet name is added on start.
# HERDR_WEB_ALLOWED_HOSTS=my-pc.example-tailnet.ts.net

# Connect PC: let other PCs running HerdRabbit connect to this one. Set
# this PC's tailnet address to open the port, and name the PCs (tailnet
# addresses) or tailnet logins allowed in. See "Connect PC" in the README.
# HERDR_WEB_PEER_HOST=100.64.0.2
# HERDR_WEB_PEER_PORT=38788
# HERDR_WEB_PEER_ADDRESSES=100.64.0.3
# HERDR_WEB_PEER_LOGINS=me@example.com

# Largest single upload or download in megabytes (unset: no limit).
# HERDR_WEB_MAX_TRANSFER_MB=512

# Herdr executable. Left unset, the Herdr that runs this plugin is used.
# HERDR_BIN=/home/me/.local/bin/herdr
`;

// KEY=VALUE lines, # comments, an optional `export `, and one pair of matching
// quotes around a value. Nothing is expanded.
export function parseEnvFile(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quoted = /^(["'])(.*)\1$/u.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/u, "");
    values[match[1]] = value;
  }
  return values;
}

// The settings this plugin passes on to HerdRabbit.
export function pluginSettings(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => key.startsWith("HERDR_WEB_") || key === "HERDR_BIN"),
  );
}

// Where the plugin keeps things. Outside Herdr (running the script by hand)
// it falls back to per-user folders, never to the checkout.
export function pluginPaths(env, fallbackRoot) {
  const home = env.HOME || "";
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  const root = env.HERDR_PLUGIN_ROOT || fallbackRoot;
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR || join(configHome, "herdrabbit-plugin");
  const stateDir = env.HERDR_PLUGIN_STATE_DIR || join(stateHome, "herdrabbit-plugin");
  return {
    root,
    configDir,
    stateDir,
    envFile: join(configDir, ".env"),
    serverFile: join(stateDir, "server.json"),
    logFile: join(stateDir, "server.log"),
    entry: join(root, "src", "index.mjs"),
  };
}

// The .env file, written as a commented template the first time.
export async function loadSettings(deps, paths) {
  let text;
  let created = false;
  try {
    text = await deps.readFile(paths.envFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await deps.mkdir(paths.configDir);
    await deps.writeFile(paths.envFile, ENV_TEMPLATE);
    text = ENV_TEMPLATE;
    created = true;
  }
  const settings = pluginSettings(parseEnvFile(text));
  const host = parseHost(settings.HERDR_WEB_HOST);
  const port = parsePort(settings.HERDR_WEB_PORT);
  return { settings, host, port, created };
}

// HerdRabbit's /api/bootstrap names whether a password is required; with one
// set it refuses a request without a session as "authentication_required".
// Anything else answering there is not HerdRabbit; nothing answering at all is null.
export async function probeHerdRabbit(host, port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://${hostPort(host, port)}/api/bootstrap`, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {}
    if (response.status === 401 && body?.error?.code === "authentication_required") return { herdrabbit: true, authRequired: true };
    const herdrabbit = response.status === 200 && typeof body?.authRequired === "boolean" && Array.isArray(body?.allowedKeys);
    return herdrabbit ? { herdrabbit: true, authRequired: body.authRequired } : { herdrabbit: false };
  } catch {
    return null;
  }
}

// A listener on every interface is still reached on loopback.
export function probeHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

export function pageUrl(host, port) {
  return `http://${hostPort(probeHost(host), port)}`;
}

// Herdr hands a plugin command its own pane, tab, workspace and plugin
// variables. HerdRabbit is a server for every session, not a program inside
// one pane, so none of them go on. HERDR_SOCKET_PATH goes too: every herdr
// CLI call HerdRabbit makes inherits its environment, and a socket pinned there
// would send `herdr --session=<other>` commands to the session that happened
// to run the hook -- the systemd service never has it either. HERDR_BIN_PATH
// becomes HERDR_BIN unless the settings name one, and HERDR_PLUGIN_ID becomes
// HERDR_WEB_PLUGIN_ID: the in-app update asks Herdr to update that plugin.
export function serverEnvironment(processEnv, settings, { tailnetHost = "" } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (key.startsWith("HERDR_") && !key.startsWith("HERDR_WEB_") && key !== "HERDR_BIN") continue;
    env[key] = value;
  }
  if (processEnv.HERDR_BIN_PATH && !settings.HERDR_BIN && !processEnv.HERDR_BIN) {
    env.HERDR_BIN = processEnv.HERDR_BIN_PATH;
  }
  Object.assign(env, settings);
  delete env.HERDR_WEB_PLUGIN_ID;
  if (processEnv.HERDR_PLUGIN_ID) env.HERDR_WEB_PLUGIN_ID = processEnv.HERDR_PLUGIN_ID;
  if (!settings.HERDR_WEB_ALLOWED_HOSTS && tailnetHost) env.HERDR_WEB_ALLOWED_HOSTS = tailnetHost;
  return env;
}

async function activeSystemdUnit(deps) {
  for (const unit of SYSTEMD_UNITS) {
    if (await deps.systemdActive(unit)) return unit;
  }
  return null;
}

async function readServerRecord(deps, paths) {
  try {
    const record = JSON.parse(await deps.readFile(paths.serverFile));
    return Number.isInteger(record?.pid) && record.pid > 0 && typeof record.root === "string" ? record : null;
  } catch {
    return null;
  }
}

// Ours only when that pid still runs HerdRabbit's entry point from the
// checkout we started it from. A recycled pid fails this and is left alone.
// `commandLine` is the argv array (Linux: /proc/<pid>/cmdline split on NUL) and
// must hold the entry path as one whole argument. A plain string (macOS
// `ps -o args=`) cannot be split reliably, so the entry path must be a whole
// space-delimited token: at the start or after a space, at the end or before one.
export function isOurServer(commandLine, record) {
  if (!record || typeof record.root !== "string" || !isAbsolute(record.root)) return false;
  const entry = join(resolve(record.root), "src", "index.mjs");
  if (Array.isArray(commandLine)) return commandLine.includes(entry);
  if (typeof commandLine !== "string") return false;
  return (` ${commandLine} `).includes(` ${entry} `);
}

// A path as one shell word, safe to copy even with spaces or quotes in it.
export function shellQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

async function ourServer(deps, paths) {
  const record = await readServerRecord(deps, paths);
  if (!record) return { record: null, running: false };
  const commandLine = await deps.processCommand(record.pid);
  return { record, running: isOurServer(commandLine, record) };
}

async function waitUntil(deps, timeoutMs, check) {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (deps.now() >= deadline) return null;
    await deps.sleep(POLL_MS);
  }
}

function staleRootNote(record, root) {
  if (!record || record.root === root) return [];
  return [
    `실행 중인 서버는 이전 체크아웃(${record.root})에서 돌고 있습니다. 플러그인이 업데이트됐으니 다시 시작하세요: herdr plugin action invoke herdrabbit.restart`,
  ];
}

// The startup hook (`restartStale`) also replaces a plugin-started server that
// still runs from a checkout the plugin update has moved away from.
// Idempotent otherwise: a Herdr restart or live handoff that runs it again
// changes nothing while HerdRabbit answers, and never starts a second server.
export async function start(deps, { restartStale = false } = {}) {
  const paths = pluginPaths(deps.env, deps.fallbackRoot);
  const { settings, host, port, created } = await loadSettings(deps, paths);
  const lines = created ? [`설정 파일을 만들었습니다: ${paths.envFile}`] : [];
  const url = pageUrl(host, port);

  const unit = await activeSystemdUnit(deps);
  if (unit) {
    lines.push(`systemd 서비스(${unit})가 실행 중이라 플러그인 시작을 건너뜁니다.`);
    return { result: "systemd", lines };
  }

  let answer = await deps.probe(probeHost(host), port);
  let { record: known, running: knownRunning } = await ourServer(deps, paths);
  if (answer?.herdrabbit) {
    if (restartStale && knownRunning && resolve(known.root) !== resolve(paths.root)) {
      lines.push(`플러그인이 업데이트돼 이전 체크아웃(${known.root})의 서버를 다시 시작합니다.`);
      const stopped = await stop(deps);
      lines.push(...stopped.lines);
      if (stopped.result === "stopping") return { result: "stopping", lines };
      answer = await deps.probe(probeHost(host), port);
      ({ record: known, running: knownRunning } = await ourServer(deps, paths));
    }
  }
  if (answer?.herdrabbit) {
    lines.push(`HerdRabbit이 이미 ${url}에서 응답합니다. 새로 시작하지 않습니다.`);
    if (knownRunning) lines.push(...staleRootNote(known, paths.root));
    return { result: "running", lines };
  }
  if (answer) {
    lines.push(`${url}에 HerdRabbit이 아닌 다른 프로그램이 응답합니다. ${paths.envFile}에서 HERDR_WEB_PORT를 바꾸세요.`);
    return { result: "port-taken", lines };
  }

  // Our own server is alive but not answering yet (a second startup during
  // a handoff): wait for it instead of starting another and overwriting its record.
  if (knownRunning) {
    const up = await waitUntil(deps, START_TIMEOUT_MS, async () => {
      if ((await deps.probe(probeHost(host), port))?.herdrabbit) return "up";
      if (!isOurServer(await deps.processCommand(known.pid), known)) return "exited";
      return null;
    });
    if (up === "up") {
      lines.push(`HerdRabbit(pid ${known.pid})이 이미 시작돼 ${url}에서 응답합니다. 새로 시작하지 않습니다.`);
      return { result: "running", lines };
    }
    if (up === "exited") {
      await deps.rm(paths.serverFile);
      lines.push(`먼저 시작된 HerdRabbit(pid ${known.pid})이 종료됐습니다. 로그를 확인하세요: ${paths.logFile}`);
    } else {
      lines.push(`먼저 시작된 HerdRabbit(pid ${known.pid})이 ${START_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다. 로그: ${paths.logFile}`);
    }
    return { result: "failed", lines };
  }

  const tailnetHost = await deps.tailnetHostname().catch(() => "");
  const env = serverEnvironment(deps.env, settings, { tailnetHost });
  await deps.mkdir(paths.stateDir);
  const pid = await deps.spawnServer({ root: paths.root, entry: paths.entry, env, logFile: paths.logFile });
  const record = { pid, root: resolve(paths.root), host, port, startedAt: new Date(deps.now()).toISOString() };
  await deps.writeFile(paths.serverFile, `${JSON.stringify(record, null, 2)}\n`);

  // Our pid must still run before an answer counts as ours: if it died (the
  // port was taken meanwhile) whatever answers is someone else's server.
  const outcome = await waitUntil(deps, START_TIMEOUT_MS, async () => {
    if (!isOurServer(await deps.processCommand(pid), record)) return "exited";
    if ((await deps.probe(probeHost(host), port))?.herdrabbit) return "up";
    return null;
  });
  if (outcome === "up") {
    lines.push(`HerdRabbit을 시작했습니다 (pid ${pid}): ${url}`);
    return { result: "started", lines };
  }
  if (outcome === "exited") {
    await deps.rm(paths.serverFile);
    lines.push(`HerdRabbit이 시작하자마자 종료됐습니다. 로그를 확인하세요: ${paths.logFile}`);
  } else {
    lines.push(`HerdRabbit(pid ${pid})이 ${START_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다. 로그: ${paths.logFile}`);
  }
  return { result: "failed", lines };
}

export async function stop(deps) {
  const paths = pluginPaths(deps.env, deps.fallbackRoot);
  const lines = [];
  const { record, running } = await ourServer(deps, paths);
  if (!record || !running) {
    if (record) await deps.rm(paths.serverFile);
    const unit = await activeSystemdUnit(deps);
    lines.push(unit
      ? `HerdRabbit은 systemd 서비스(${unit})로 실행 중입니다. 플러그인은 건드리지 않습니다: systemctl --user stop ${unit}`
      : "플러그인이 시작한 HerdRabbit이 없습니다.");
    return { result: unit ? "systemd" : "not-running", lines };
  }

  deps.signal(record.pid, "SIGTERM");
  const gone = await waitUntil(deps, STOP_TIMEOUT_MS, async () =>
    !isOurServer(await deps.processCommand(record.pid), record));
  if (!gone) {
    lines.push(`HerdRabbit(pid ${record.pid})에 종료를 요청했지만 아직 끝나지 않았습니다.`);
    return { result: "stopping", lines };
  }
  await deps.rm(paths.serverFile);
  lines.push(`HerdRabbit(pid ${record.pid})을 멈췄습니다.`);
  return { result: "stopped", lines };
}

export async function restart(deps) {
  const stopped = await stop(deps);
  if (stopped.result === "stopping") return stopped;
  const started = await start(deps);
  return { result: started.result, lines: [...stopped.lines, ...started.lines] };
}

export async function status(deps) {
  const paths = pluginPaths(deps.env, deps.fallbackRoot);
  const { host, port } = await loadSettings(deps, paths);
  const url = pageUrl(host, port);
  const version = await deps.readVersion(paths.root).catch(() => "알 수 없음");
  const unit = await activeSystemdUnit(deps);
  const { record, running } = await ourServer(deps, paths);
  const answer = await deps.probe(probeHost(host), port);

  const lines = [`HerdRabbit 플러그인 ${version} (${paths.root})`];
  lines.push(unit ? `systemd 서비스: ${unit} 실행 중` : "systemd 서비스: 실행 중 아님");
  lines.push(running
    ? `플러그인 서버: pid ${record.pid}, ${record.startedAt}부터 실행 중`
    : "플러그인 서버: 실행 중 아님");
  lines.push(answer?.herdrabbit
    ? `주소: ${url} 응답함 (비밀번호 ${answer.authRequired ? "설정됨" : "없음"})`
    : answer
      ? `주소: ${url}에 HerdRabbit이 아닌 다른 프로그램이 응답함`
      : `주소: ${url} 응답 없음`);
  if (running) lines.push(...staleRootNote(record, paths.root));
  lines.push(`설정 파일: ${paths.envFile}`);
  return { result: answer?.herdrabbit ? "up" : "down", lines };
}

// The Tailscale Serve addresses that forward to this port on loopback.
export function serveUrls(serveStatus, port) {
  const targets = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const urls = [];
  for (const [site, config] of Object.entries(serveStatus?.Web ?? {})) {
    const proxies = Object.values(config?.Handlers ?? {}).map((handler) => String(handler?.Proxy ?? ""));
    const matches = proxies.some((proxy) => {
      try {
        const target = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
        return targets.has(target.host);
      } catch {
        return false;
      }
    });
    if (matches) urls.push(`https://${site.replace(/:443$/u, "")}`);
  }
  return urls;
}

// The Connect pane: where to open the page, whether a password is set, and
// how to set one. It never reads the password file; the running server says
// whether one is required.
export async function connect(deps) {
  const paths = pluginPaths(deps.env, deps.fallbackRoot);
  const { host, port } = await loadSettings(deps, paths);
  const local = pageUrl(host, port);
  const answer = await deps.probe(probeHost(host), port);
  const serve = await deps.tailscaleServe().catch(() => null);
  const remote = serveUrls(serve, port);

  const lines = ["HerdRabbit", ""];
  if (!answer?.herdrabbit) {
    lines.push(`${local}에서 HerdRabbit이 응답하지 않습니다.`);
    lines.push("시작: herdr plugin action invoke herdrabbit.start");
    lines.push("");
  }
  lines.push(`이 PC에서: ${local}`);
  for (const url of remote) lines.push(`휴대폰·다른 기기 (Tailscale): ${url}`);
  if (remote.length === 0) {
    lines.push(`휴대폰에서 열려면 Tailscale Serve를 등록하세요: sudo tailscale serve --bg --https=${port} http://127.0.0.1:${port}`);
  }
  lines.push("");
  if (answer?.herdrabbit) {
    lines.push(answer.authRequired ? "비밀번호: 설정됨" : "비밀번호: 없음 -- tailnet의 모든 기기가 열 수 있습니다.");
  } else {
    lines.push("비밀번호: 서버가 응답하지 않아 확인할 수 없습니다.");
  }
  lines.push("비밀번호 설정: herdr plugin pane open --plugin herdrabbit --entrypoint password");
  lines.push(`  또는 터미널에서: cd ${shellQuote(paths.root)} && npm run password`);

  const qr = [];
  const qrUrl = remote[0];
  if (qrUrl) {
    const code = await deps.qrCode(qrUrl).catch(() => null);
    if (code) qr.push("", code.trimEnd());
  }
  return { result: answer?.herdrabbit ? "up" : "down", lines: [...lines, ...qr] };
}
