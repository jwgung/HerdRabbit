// AI CLI accounts on a Herdr SSH machine, which has no HerdRabbit of its own.
// Each call ships the same account manager this machine runs (ai-accounts.mjs
// and ai-account-adapters.mjs, unchanged) to the machine's Node.js over the
// existing SSH master connection and runs it there, against that machine's
// own CLI sign-ins and its own saved-accounts folder.
//
// Credentials never travel: saving, switching and signing in copy files
// within the machine, and what comes back is the same who-is-this metadata
// the local routes return, re-checked field by field here before it is used.
// The program text is constant; what a request chooses (operation, CLI,
// account or sign-in id) is checked against fixed patterns and goes as its
// own quoted argument, never into the program.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { AiAccountError, LOGIN_ID_PATTERN, SLOT_ID_PATTERN } from "./ai-accounts.mjs";
import { DEFAULT_ADAPTERS } from "./ai-account-adapters.mjs";
import { InputValidationError } from "./herdr-client.mjs";
import { remoteCommand } from "./machine-files.mjs";

const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 256 * 1024;
const MIN_NODE_MAJOR = 18;
const EXIT_NO_NODE = 72;
// As machine-files.mjs: a missing master fails at once instead of opening a login.
const SSH_OPTIONS = ["-T", "-o", "ControlMaster=no", "-o", "ProxyCommand=false"];

export const NO_NODE_REASON =
  `Switching accounts on this machine needs Node.js ${MIN_NODE_MAJOR} or newer there, on the PATH an SSH command gets.`;

// Node is often installed per user, out of a non-login shell's PATH; nvm and
// fnm keep it under the home folder. The first one new enough is used. The
// system folders are this code's own constants (a test swaps them).
const SYSTEM_NODE_DIRS = ["/usr/local/bin", "/opt/homebrew/bin"];
const launchScript = (systemDirs) => `PATH="$HOME/.local/bin:$HOME/.volta/bin:${systemDirs.map((dir) => `${dir}:`).join("")}$PATH"; export PATH
fits() { m=$("$1" -p 'process.versions.node.split(".")[0]' </dev/null 2>/dev/null) && [ "$m" -ge ${MIN_NODE_MAJOR} ] 2>/dev/null; }
n=
if command -v node >/dev/null 2>&1 && fits node; then n=node
else
  for c in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node; do
    if [ -x "$c" ] && fits "$c"; then n=$c; break; fi
  done
fi
[ -n "$n" ] || exit ${EXIT_NO_NODE}
umask 077
exec "$n" --input-type=module - "$@"
`;

// The remote copies import each other by data: URL, which may import Node's
// built-ins but nothing relative; both relative imports are swapped for one.
// A refactor that adds another import breaks loading here, not on a machine.
const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const ERRORS_MODULE = `export class InputValidationError extends Error {
  constructor(message) { super(message); this.name = "InputValidationError"; }
}
`;

function shipped(file, replacements) {
  let text = readFileSync(new URL(file, import.meta.url), "utf8");
  for (const [specifier, url] of replacements) {
    const quoted = `"${specifier}"`;
    if (text.split(quoted).length !== 2) throw new Error(`${file} must import ${specifier} exactly once`);
    text = text.replace(quoted, JSON.stringify(url));
  }
  if (/\bfrom\s+["']\./u.test(text) || /\bimport\(/u.test(text)) throw new Error(`${file} has an import the remote copy cannot load`);
  return text;
}

// Built on first use, so a source the shipper cannot handle fails that call,
// not the server's start.
let remoteProgram = null;
export function shippedProgram() {
  if (remoteProgram) return remoteProgram;
  const ADAPTERS_URL = dataUrl(shipped("./ai-account-adapters.mjs", []));
  const ERRORS_URL = dataUrl(ERRORS_MODULE);
  const ACCOUNTS_URL = dataUrl(shipped("./ai-accounts.mjs", [
    ["./ai-account-adapters.mjs", ADAPTERS_URL],
    ["./herdr-client.mjs", ERRORS_URL],
  ]));

  // What runs on the machine. The saved accounts sit where HerdRabbit would keep
  // them there (config.mjs), so a HerdRabbit installed there later finds them.
  // Running agents are checked here, against the machine's panes, before a switch
  // is sent. Only refusals the account manager words itself come back as words.
  remoteProgram = `const { AiAccounts, AiAccountError } = await import(${JSON.stringify(ACCOUNTS_URL)});
const { InputValidationError } = await import(${JSON.stringify(ERRORS_URL)});
const { homedir } = await import("node:os");
const { isAbsolute, join } = await import("node:path");
const [operation, cli, id] = process.argv.slice(2);
const home = process.env.HOME || homedir();
const configHome = isAbsolute(process.env.XDG_CONFIG_HOME || "") ? process.env.XDG_CONFIG_HOME : join(home, ".config");
const directory = join(configHome, "herdr-bridge", "ai-accounts");
const accounts = new AiAccounts({ directory });
const { mkdir, rmdir, stat } = await import("node:fs/promises");
// One change at a time on this machine, across processes: a run cut off by a
// timeout on the other side may still be going here. A lock older than a
// minute was left by a run that died.
const LOCK = join(directory, ".change-lock");
async function locked(run) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const deadline = Date.now() + 15000; ;) {
    try { await mkdir(LOCK, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const held = await stat(LOCK).catch(() => null);
      if (held && Date.now() - held.mtimeMs > 60000) { await rmdir(LOCK).catch(() => {}); continue; }
      if (Date.now() > deadline) throw new AiAccountError("machine_accounts_busy", "Another account change is still running on that machine. Try again shortly.", { status: 409 });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try { return await run(); } finally { await rmdir(LOCK).catch(() => {}); }
}
const operations = {
  list: () => accounts.list(),
  save: () => accounts.saveCurrent(cli),
  start: () => accounts.startLogin(cli),
  finish: () => accounts.finishLogin(cli, id),
  cancel: () => accounts.cancelLogin(cli, id),
  switch: () => accounts.switch(cli, id, { confirmRunning: true }),
  remove: () => accounts.remove(cli, id),
};
let reply;
try {
  if (!Object.hasOwn(operations, operation)) throw new InputValidationError("Unknown operation");
  reply = { ok: true, result: await (operation === "list" ? operations.list() : locked(operations[operation])) };
} catch (error) {
  if (error instanceof AiAccountError) reply = { ok: false, kind: "account", code: error.code, status: error.status, message: error.message };
  else if (error instanceof InputValidationError) reply = { ok: false, kind: "input", message: error.message };
  else reply = { ok: false, kind: "failed" };
}
process.stdout.write(JSON.stringify(reply) + "\\n");
`;
  return remoteProgram;
}

const ADAPTERS = new Map(DEFAULT_ADAPTERS.map((adapter) => [adapter.id, adapter]));
const OPERATIONS = new Set(["list", "save", "start", "finish", "cancel", "switch", "remove"]);

const failed = () => new AiAccountError("machine_accounts_failed", "That machine could not do this. Try again.", { status: 502 });

// Only plain one-line text of a sane length comes back from the machine.
function line(value, max = 320) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function slotId(value) {
  return typeof value === "string" && SLOT_ID_PATTERN.test(value) ? value : null;
}

// A saved account names its slot; an answer without one is not a save.
function savedAccount(value) {
  const result = account(value);
  if (!result.id) throw failed();
  return result;
}

function account(value) {
  if (!value || typeof value !== "object") throw failed();
  return {
    id: slotId(value.id),
    email: line(value.email),
    organization: line(value.organization),
    plan: line(value.plan, 64),
    refreshExpiresAt: Number.isFinite(value.refreshExpiresAt) ? value.refreshExpiresAt : null,
    active: value.active === true,
  };
}

function listing(value) {
  const clis = Array.isArray(value?.clis) ? value.clis : [];
  return {
    clis: [...ADAPTERS.values()].map((adapter) => {
      const cli = clis.find((item) => item?.id === adapter.id);
      if (!cli) return { id: adapter.id, label: adapter.label, supported: false, reason: "Not available on that machine", current: null, accounts: [], logins: [] };
      return {
        id: adapter.id,
        label: adapter.label,
        supported: cli.supported === true,
        reason: line(cli.reason),
        current: cli.current ? account(cli.current) : null,
        accounts: (Array.isArray(cli.accounts) ? cli.accounts : []).map(account).filter((item) => item.id),
        logins: (Array.isArray(cli.logins) ? cli.logins : []).filter((id) => typeof id === "string" && LOGIN_ID_PATTERN.test(id)),
      };
    }),
  };
}

function unsupportedListing(reason) {
  return {
    clis: [...ADAPTERS.values()].map((adapter) => ({
      id: adapter.id, label: adapter.label, supported: false, reason, current: null, accounts: [], logins: [],
    })),
  };
}

// The sign-in command is typed into a terminal on the machine, so it has to
// be exactly the one ai-accounts.mjs builds: the CLI's own command, pointed at
// a sign-in directory named for this sign-in.
function loginCommand(adapter, loginId, command) {
  const pattern = new RegExp(`^env ${adapter.homeEnv}='(/[^'\\\\\\u0000-\\u001f\\u007f]*)' ${adapter.loginCommand.join(" ")}$`, "u");
  const directory = typeof command === "string" ? pattern.exec(command)?.[1] : null;
  if (!directory?.endsWith(`/staging/${adapter.id}/${loginId}`)) throw failed();
  return command;
}

export class MachineAiAccounts {
  // `link` returns the machine's connection once it is up, and throws the
  // machine's own "offline" error until then. `runningAgents` reads the
  // machine's panes, as Herdr there sees them.
  constructor({ link, runningAgents = async () => [], spawnProcess = spawn, timeoutMs = COMMAND_TIMEOUT_MS, systemNodeDirs = SYSTEM_NODE_DIRS }) {
    this.launchScript = launchScript(systemNodeDirs);
    this.link = link;
    this.runningAgents = runningAgents;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.pending = Promise.resolve();
  }

  // One at a time per machine, as AiAccounts is on this one: two switches
  // interleaved there could save one account's tokens under another's name.
  #serial(operation) {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }

  #ready() {
    try {
      return this.link();
    } catch (error) {
      if (error?.code !== "machine_offline") throw error;
      throw new AiAccountError("machine_offline", error.message, { status: 503 });
    }
  }

  #adapter(cli) {
    const adapter = typeof cli === "string" ? ADAPTERS.get(cli) : undefined;
    if (!adapter) throw new InputValidationError("Unknown CLI");
    return adapter;
  }

  // The machine's answer, or the refusal it gave. Nothing ssh or Node wrote to
  // stderr is kept: it is no one's business here.
  async #run(operation, args = []) {
    if (!OPERATIONS.has(operation)) throw new InputValidationError("Unknown operation");
    const link = this.#ready();
    const child = this.spawnProcess(link.ssh, link.sshArgs(SSH_OPTIONS, remoteCommand(this.launchScript, [operation, ...args])), {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const { code, stdout } = await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let problem = null;
      const stop = (error) => {
        if (problem) return;
        problem = error;
        try { child.kill("SIGKILL"); } catch {}
      };
      const timer = setTimeout(() => stop(new AiAccountError("machine_timeout", "That machine did not answer in time.", { status: 504 })), this.timeoutMs);
      timer.unref?.();
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) stop(failed());
        else chunks.push(chunk);
      });
      let settled = false;
      const settle = (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (problem || exitCode === undefined) reject(problem ?? failed());
        else resolve({ code: exitCode, stdout: Buffer.concat(chunks).toString("utf8") });
      };
      child.once("error", () => settle(undefined));
      child.once("close", (exitCode) => settle(exitCode));
      // A launcher that exits before reading the program closes stdin early.
      child.stdin.on("error", () => {});
      child.stdin.end(shippedProgram());
    });
    if (code === EXIT_NO_NODE) throw new AiAccountError("machine_node_missing", NO_NODE_REASON, { status: 501 });
    if (code === 255) throw new AiAccountError("machine_offline", "The SSH connection to this machine stopped.", { status: 503 });
    let reply;
    try { reply = JSON.parse(stdout); } catch { throw failed(); }
    if (code !== 0 || !reply || typeof reply !== "object") throw failed();
    if (reply.ok === true) return reply.result;
    if (reply.kind === "input") throw new InputValidationError(line(reply.message) ?? "Invalid input");
    if (reply.kind === "account" && typeof reply.code === "string" && /^[a-z_]{1,64}$/u.test(reply.code)) {
      const status = Number.isInteger(reply.status) && reply.status >= 400 && reply.status < 600 ? reply.status : 409;
      throw new AiAccountError(reply.code, line(reply.message) ?? "That machine refused this change.", { status });
    }
    throw failed();
  }

  list() {
    return this.#serial(async () => {
      try {
        return listing(await this.#run("list"));
      } catch (error) {
        // Shown in place of each CLI's accounts, so the reason is read where
        // the switching would have been.
        if (error?.code === "machine_node_missing") return unsupportedListing(NO_NODE_REASON);
        throw error;
      }
    });
  }

  async saveCurrent(cli) {
    const adapter = this.#adapter(cli);
    return this.#serial(async () => {
      const result = await this.#run("save", [adapter.id]);
      return { cli: adapter.id, account: savedAccount(result?.account) };
    });
  }

  async startLogin(cli) {
    const adapter = this.#adapter(cli);
    return this.#serial(async () => {
      const result = await this.#run("start", [adapter.id]);
      const loginId = typeof result?.loginId === "string" && LOGIN_ID_PATTERN.test(result.loginId) ? result.loginId : null;
      if (!loginId) throw failed();
      return { cli: adapter.id, label: adapter.label, loginId, command: loginCommand(adapter, loginId, result.command) };
    });
  }

  async finishLogin(cli, loginId) {
    const adapter = this.#adapter(cli);
    if (typeof loginId !== "string" || !LOGIN_ID_PATTERN.test(loginId)) throw new InputValidationError("Invalid sign-in id");
    return this.#serial(async () => {
      const result = await this.#run("finish", [adapter.id, loginId]);
      return { cli: adapter.id, account: savedAccount(result?.account) };
    });
  }

  async cancelLogin(cli, loginId) {
    const adapter = this.#adapter(cli);
    if (typeof loginId !== "string" || !LOGIN_ID_PATTERN.test(loginId)) throw new InputValidationError("Invalid sign-in id");
    return this.#serial(async () => {
      await this.#run("cancel", [adapter.id, loginId]);
      return { cli: adapter.id, loginId };
    });
  }

  // Agents are looked for in the machine's own panes; the switch itself runs
  // there only once nothing is running or the person said to go ahead.
  async switch(cli, accountId, { confirmRunning = false } = {}) {
    const adapter = this.#adapter(cli);
    if (!slotId(accountId)) throw new InputValidationError("Invalid account id");
    return this.#serial(async () => {
      this.#ready();
      if (!confirmRunning) {
        const agents = await this.runningAgents().catch((error) => {
          if (error?.code !== "machine_offline") throw error;
          throw new AiAccountError("machine_offline", error.message, { status: 503 });
        });
        const running = agents.filter((agent) => agent.agent === adapter.id);
        if (running.length > 0) {
          throw new AiAccountError("agents_running", `${adapter.label} is running in ${running.length} pane(s)`, {
            details: { panes: running.map(({ paneId, label }) => ({ paneId, label: label ?? null })) },
          });
        }
      }
      const result = await this.#run("switch", [adapter.id, accountId]);
      return { cli: adapter.id, account: savedAccount(result?.account), changed: result?.changed === true };
    });
  }

  async remove(cli, accountId) {
    const adapter = this.#adapter(cli);
    if (!slotId(accountId)) throw new InputValidationError("Invalid account id");
    return this.#serial(async () => {
      await this.#run("remove", [adapter.id, accountId]);
      return { cli: adapter.id, id: accountId };
    });
  }
}
