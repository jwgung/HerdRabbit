// Herdr's own SSH machines (`herdr machine add`), reached from here without
// installing anything there: one SSH connection per enabled machine forwards
// that machine's Herdr sockets to this one, and the usual Herdr commands,
// status events and terminal attaches run against the forwarded sockets.
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./http-basics.mjs";

const execFileAsync = promisify(execFile);
const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/u;
// Herdr is often installed per user, out of a non-login shell's PATH.
const REMOTE_PATH = 'PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"';
const RECONNECT_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

// Machines as `herdr machine list --json` and `status --json` describe them.
export async function readMachines({ binary = "herdr", run = execFileAsync } = {}) {
  const json = async (args) => JSON.parse((await run(binary, args, { encoding: "utf8", timeout: 10_000 })).stdout);
  const [list, status] = await Promise.all([
    json(["machine", "list", "--json"]),
    json(["machine", "status", "--json"]).catch(() => []),
  ]);
  return (Array.isArray(list) ? list : []).filter((machine) => MACHINE_ID_PATTERN.test(machine?.id) && typeof machine.target === "string")
    .map((machine) => {
      const state = (Array.isArray(status) ? status : []).find((item) => item?.id === machine.id);
      return {
        id: machine.id,
        label: typeof machine.label === "string" && machine.label ? machine.label : machine.target,
        target: machine.target,
        session: typeof machine.session === "string" && machine.session ? machine.session : "default",
        enabled: machine.enabled !== false,
        reachable: state ? state.status === "reachable" : null,
        error: typeof state?.error === "string" ? state.error : null,
      };
    });
}

// The socket line of `herdr status server`.
export function socketFromStatus(output) {
  return /^socket:\s*(\S.*)$/mu.exec(String(output))?.[1].trim() ?? null;
}

// Herdr names the attach socket after the API socket: herdr.sock beside herdr-client.sock.
export function clientSocketFor(socketPath) {
  return socketPath.replace(/(\.sock)?$/u, "-client.sock");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// One machine's connection: an SSH master that also carries the forwards.
// `ready` is the local API socket once both forwards are up.
export class MachineLink {
  constructor(machine, { directory, ssh = "ssh", spawnProcess = spawn, run = execFileAsync, log = () => {}, onChange = () => {} }) {
    this.machine = machine;
    this.ssh = ssh;
    this.spawnProcess = spawnProcess;
    this.run = run;
    this.log = log;
    this.onChange = onChange;
    // Short names: a Unix socket path has to fit in about a hundred bytes.
    const name = machine.id.slice(0, 12);
    this.control = join(directory, `${name}.ctl`);
    this.socketPath = join(directory, `${name}.sock`);
    this.state = "connecting";
    this.error = null;
    this.attempt = 0;
    this.stopped = false;
  }

  sshArgs(...rest) {
    return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-S", this.control, ...rest];
  }

  // A command on the machine, over the master connection.
  async remote(command, { timeoutMs = 15_000 } = {}) {
    const { stdout } = await this.run(this.ssh, [...this.sshArgs(), this.machine.target, command], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return stdout;
  }

  start() {
    if (this.stopped || this.master) return;
    this.#set("connecting", null);
    const master = this.spawnProcess(this.ssh, this.sshArgs("-M", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes", this.machine.target), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.master = master;
    let stderr = "";
    master.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    master.on("exit", () => {
      if (this.master !== master) return;
      this.master = null;
      this.#set("offline", sshProblem(stderr));
      this.#retry();
    });
    master.on("error", (error) => {
      if (this.master !== master) return;
      this.master = null;
      this.#set("offline", error.message);
      this.#retry();
    });
    void this.#forward(master);
  }

  async #forward(master) {
    try {
      await waitFor(() => stat(this.control).then(() => true, () => false), 15_000, () => this.master !== master);
      const session = this.machine.session === "default" ? "" : ` --session=${shellQuote(this.machine.session)}`;
      const remoteSocket = socketFromStatus(await this.remote(`${REMOTE_PATH}; herdr${session} status server`));
      if (!remoteSocket) throw new Error("Herdr is not running on this machine");
      await rm(this.socketPath, { force: true });
      await rm(clientSocketFor(this.socketPath), { force: true });
      for (const [local, remote] of [[this.socketPath, remoteSocket], [clientSocketFor(this.socketPath), clientSocketFor(remoteSocket)]]) {
        await this.run(this.ssh, [...this.sshArgs("-O", "forward", "-L", `${local}:${remote}`), this.machine.target], { timeout: 10_000 });
      }
      if (this.master !== master) return;
      this.attempt = 0;
      this.#set("ready", null);
    } catch (error) {
      if (this.master !== master) return;
      this.log(`machine ${this.machine.label}: ${error.message}`);
      this.#set("offline", sshProblem(error.stderr) ?? error.message);
      master.kill();
    }
  }

  #retry() {
    if (this.stopped) return;
    const wait = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)];
    this.attempt += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), wait);
    this.retryTimer.unref?.();
  }

  #set(state, error) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.onChange(this);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const master = this.master;
    this.master = null;
    master?.kill();
    await rm(this.socketPath, { force: true }).catch(() => {});
    await rm(clientSocketFor(this.socketPath), { force: true }).catch(() => {});
  }
}

// What SSH said, in the words a person acts on; never the raw output, which
// can carry a remote banner.
function sshProblem(stderr) {
  const text = String(stderr ?? "");
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(text)) {
    return "The machine's SSH host key is not trusted yet. Run `herdr machine reconnect` for it in a terminal.";
  }
  if (/Permission denied|password|passphrase/iu.test(text)) {
    return "SSH needs a password or key here. Run `herdr machine reconnect` for it in a terminal.";
  }
  if (/Could not resolve|No route|Connection refused|timed out|Network is unreachable/iu.test(text)) {
    return "The machine cannot be reached over SSH.";
  }
  return text ? "The SSH connection to this machine stopped." : null;
}

async function waitFor(check, timeoutMs, cancelled) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (cancelled()) throw new Error("cancelled");
    if (Date.now() > deadline) throw new Error("The SSH connection did not come up");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function processRuns(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// A private directory for the sockets: they open the machines' Herdr to
// whoever can reach them. Each HerdRabbit process has its own, so two running
// side by side (a service and a test copy) never take over each other's.
export async function machineSocketDirectory(environment = process.env, pid = process.pid) {
  const base = join(environment.XDG_RUNTIME_DIR || tmpdir(), `herdrabbit-${process.getuid?.() ?? "user"}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  // A process that stopped without cleaning up left its sockets behind.
  for (const name of await readdir(base).catch(() => [])) {
    if (!/^\d+$/u.test(name) || Number(name) === pid || processRuns(Number(name))) continue;
    await rm(join(base, name), { recursive: true, force: true }).catch(() => {});
  }
  const directory = join(base, String(pid));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

// What a machine's commands are refused with while its connection is not up.
function offline(link) {
  return Object.assign(new Error(link?.error ?? "Connecting to this machine…"), { code: "machine_offline" });
}

// A server entry's client for one machine: the local Herdr client, pointed at
// the machine's forwarded socket once the connection is up.
export class MachineClient {
  constructor({ link, createBridge }) {
    this.link = link;
    this.bridge = createBridge(link);
  }

  info() { return { version: null, herdrVersion: null }; }

  close() {}
}

for (const method of ["snapshot", "readPane", "sendText", "sendKeys", "watchStatuses", "terminalTarget",
  "createWorkspace", "renameWorkspace", "closeWorkspace", "createTab", "renameTab", "closeTab"]) {
  MachineClient.prototype[method] = async function forward(...args) {
    if (this.link.state !== "ready") throw offline(this.link);
    return this.bridge[method](...args);
  };
}

export const MACHINE_SERVER_PREFIX = "machine-";

// Every enabled Herdr machine, kept connected while it stays in Herdr's list.
export class HerdrMachines {
  constructor({ binary = "herdr", directory, createBridge, read = (options) => readMachines(options),
    createLink = (machine, options) => new MachineLink(machine, options), log = () => {}, refreshMs = 30_000 }) {
    this.binary = binary;
    this.directory = directory;
    this.createBridge = createBridge;
    this.read = read;
    this.createLink = createLink;
    this.log = log;
    this.refreshMs = refreshMs;
    this.machines = [];
    this.links = new Map();
    this.clients = new Map();
  }

  async start() {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.refreshMs);
    this.timer.unref?.();
  }

  async refresh() {
    try {
      this.machines = await this.read({ binary: this.binary });
    } catch (error) {
      this.log(`herdr machine list failed: ${error.message}`);
      return;
    }
    const wanted = new Set(this.machines.filter((machine) => machine.enabled).map((machine) => machine.id));
    for (const [id, link] of this.links) {
      const machine = this.machines.find((item) => item.id === id);
      // A machine that went away, was turned off, or now points elsewhere starts over.
      if (wanted.has(id) && machine.target === link.machine.target && machine.session === link.machine.session) {
        link.machine = machine;
        continue;
      }
      this.links.delete(id);
      this.clients.delete(id);
      await link.stop();
    }
    for (const machine of this.machines) {
      if (!wanted.has(machine.id) || this.links.has(machine.id)) continue;
      const link = this.createLink(machine, { directory: this.directory, log: this.log });
      this.links.set(machine.id, link);
      link.start();
    }
  }

  // Server profiles for the sidebar: enabled machines only.
  profiles() {
    return this.machines.filter((machine) => machine.enabled).map((machine) => ({
      id: `${MACHINE_SERVER_PREFIX}${machine.id.slice(0, 12)}`,
      name: machine.label,
      transport: "machine",
      machineId: machine.id,
      address: machine.target,
    }));
  }

  client(profile) {
    const link = this.links.get(profile.machineId);
    if (!link) return null;
    let client = this.clients.get(profile.machineId);
    if (!client || client.link !== link) {
      client = new MachineClient({ link, createBridge: this.createBridge });
      this.clients.set(profile.machineId, client);
    }
    return client;
  }

  async stop() {
    clearInterval(this.timer);
    await Promise.all([...this.links.values()].map((link) => link.stop()));
    this.links.clear();
    await rm(this.directory, { recursive: true, force: true }).catch(() => {});
  }
}

const TARGET_PATTERN = /^(?!-)[A-Za-z0-9._+-]+(?:@[A-Za-z0-9._-]+)?$/u;
const LABEL_PATTERN = /^[^\u0000-\u001f\u007f]{1,60}$/u;

export function validMachineTarget(value) {
  return typeof value === "string" && value.length <= 200 && TARGET_PATTERN.test(value);
}

export function validMachineLabel(value) {
  return typeof value === "string" && LABEL_PATTERN.test(value.trim()) && value.trim() === value;
}

// What `herdr machine` refused with, in words that say what to do: its own
// output can carry the remote's banner, so it is not passed on.
function machineCommandError(error, fallback) {
  const text = `${error?.stderr ?? ""}`;
  const message = /Host key verification failed|authenticity of host/iu.test(text)
    ? "SSH does not trust this machine's host key yet. Run `herdr machine add` for it once in a terminal."
    : /Permission denied|password|passphrase/iu.test(text)
      ? "SSH needs a password or key for this machine. Set up key sign-in, or run `herdr machine add` for it in a terminal."
      : /Could not resolve|No route|Connection refused|timed out|unreachable/iu.test(text)
        ? "This machine cannot be reached over SSH."
        : fallback;
  return new HttpError(400, "machine_command_failed", message);
}

Object.assign(HerdrMachines.prototype, {
  machineIdFor(serverId) {
    return this.profiles().find((profile) => profile.id === serverId)?.machineId ?? null;
  },

  async command(args, { timeoutMs = 30_000, fallback }) {
    const run = this.run ?? execFileAsync;
    try {
      await run(this.binary, ["machine", ...args], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      throw machineCommandError(error, fallback);
    }
    await this.refresh();
  },

  // Prepares Herdr on the machine and saves it; nothing is asked for here, so
  // a machine that needs a password or a new host key is set up in a terminal.
  add({ target, label }) {
    return this.command(["add", target, ...(label ? ["--label", label] : [])], {
      timeoutMs: 180_000, fallback: "Herdr could not set up this machine. Run `herdr machine add` for it in a terminal to see why.",
    });
  },

  rename(machineId, label) {
    // The id comes first: Herdr 0.9.3 refuses `rename --label <label> <id>` despite its help.
    return this.command(["rename", machineId, "--label", label], { fallback: "Herdr could not rename this machine." });
  },

  disable(machineId) {
    return this.command(["disable", machineId], { fallback: "Herdr could not turn this machine off." });
  },

  remove(machineId) {
    return this.command(["remove", machineId], { fallback: "Herdr could not remove this machine." });
  },
});
