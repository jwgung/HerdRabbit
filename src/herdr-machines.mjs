// Herdr's own SSH machines (`herdr machine add`), reached from here without
// installing anything there: one SSH connection per enabled machine forwards
// that machine's Herdr sockets to this one, and the usual Herdr commands,
// status events and terminal attaches run against the forwarded sockets.
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./http-basics.mjs";

const execFileAsync = promisify(execFile);
const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/u;
// Herdr is often installed per user, out of a non-login shell's PATH.
const REMOTE_PATH = 'PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"';
const RECONNECT_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
// A user, then a host; neither may start with "-", where SSH would read an option.
const TARGET_PATTERN = /^(?!-)[A-Za-z0-9._+-]+(?:@(?!-)[A-Za-z0-9._-]+)?$/u;
const LABEL_PATTERN = /^[^\u0000-\u001f\u007f]{1,60}$/u;
export const MACHINE_SERVER_PREFIX = "machine-";

export function validMachineTarget(value) {
  return typeof value === "string" && value.length <= 200 && TARGET_PATTERN.test(value);
}

export function validMachineLabel(value) {
  return typeof value === "string" && LABEL_PATTERN.test(value.trim()) && value.trim() === value;
}

// Machines as `herdr machine list --json` and `status --json` describe them.
// Only the ones this module can reach safely are kept: a target SSH could read
// as an option is skipped, even though it came from Herdr's own settings.
export async function readMachines({ binary = "herdr", run = execFileAsync } = {}) {
  const json = async (args) => JSON.parse((await run(binary, args, { encoding: "utf8", timeout: 10_000 })).stdout);
  const [list, status] = await Promise.all([
    json(["machine", "list", "--json"]),
    json(["machine", "status", "--json"]).catch(() => []),
  ]);
  const states = Array.isArray(status) ? status : [];
  return (Array.isArray(list) ? list : [])
    .filter((machine) => MACHINE_ID_PATTERN.test(machine?.id) && validMachineTarget(machine.target))
    .map((machine) => {
      const state = states.find((item) => item?.id === machine.id);
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

// What SSH said, in the words a person acts on; never the raw output (it can
// carry a remote banner) nor the command line (local paths).
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
  return "The SSH connection to this machine stopped.";
}

// What `herdr machine` refused with, the same way.
function machineCommandError(error, fallback) {
  const text = `${error?.stderr ?? ""}`;
  const message = /Host key verification failed|authenticity of host/iu.test(text)
    ? "SSH does not trust this machine's host key yet. Run `herdr machine add` (or `herdr machine reconnect`) for it once in a terminal."
    : /Permission denied|password|passphrase/iu.test(text)
      ? "SSH needs a password or key for this machine. Set up key sign-in, or run `herdr machine add` for it in a terminal."
      : /Could not resolve|No route|Connection refused|timed out|unreachable/iu.test(text)
        ? "This machine cannot be reached over SSH."
        : fallback;
  return new HttpError(400, "machine_command_failed", message);
}

// What a machine's commands are refused with while it has no connection.
export function machineOffline(message = "Connecting to this machine…") {
  return Object.assign(new Error(message), { code: "machine_offline" });
}

async function waitFor(check, timeoutMs, cancelled) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (cancelled()) throw new Error("cancelled");
    if (Date.now() > deadline) throw new Error("The SSH connection did not come up");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// One machine's connection: an SSH master that also carries the forwards.
// `state` is "ready" once both forwards are up.
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

  // "--" ends the options: the target is only ever the destination.
  sshArgs(options, ...command) {
    return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-S", this.control, ...options, "--", this.machine.target, ...command];
  }

  // A command on the machine, over the master connection.
  async remote(command, { timeoutMs = 15_000 } = {}) {
    const { stdout } = await this.run(this.ssh, this.sshArgs([], command), { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return stdout;
  }

  start() {
    if (this.stopped || this.master) return;
    this.#set("connecting", null);
    const master = this.spawnProcess(this.ssh, this.sshArgs(["-M", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes"]), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.master = master;
    let stderr = "";
    master.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    const ended = (detail) => {
      if (this.master !== master) return;
      this.master = null;
      if (detail) this.log(`machine ${this.machine.label}: ${detail}`);
      this.#set("offline", sshProblem(stderr));
      this.#retry();
    };
    master.on("exit", () => ended(null));
    master.on("error", (error) => ended(error.message));
    void this.#forward(master);
  }

  async #forward(master) {
    try {
      await waitFor(() => stat(this.control).then(() => true, () => false), 15_000, () => this.master !== master);
      const session = this.machine.session === "default" ? "" : ` --session=${shellQuote(this.machine.session)}`;
      const remoteSocket = socketFromStatus(await this.remote(`${REMOTE_PATH}; herdr${session} status server`));
      if (!remoteSocket) throw Object.assign(new Error("Herdr is not running there"), { stderr: "" });
      await this.#removeSockets();
      for (const [local, remote] of [[this.socketPath, remoteSocket], [clientSocketFor(this.socketPath), clientSocketFor(remoteSocket)]]) {
        await this.run(this.ssh, this.sshArgs(["-O", "forward", "-L", `${local}:${remote}`]), { timeout: 10_000 });
      }
      if (this.master !== master) return;
      this.attempt = 0;
      this.#set("ready", null);
    } catch (error) {
      if (this.master !== master) return;
      // The details stay in the log: they name local paths and commands.
      this.log(`machine ${this.machine.label}: ${error.message}`);
      this.#set("offline", error.message === "Herdr is not running there"
        ? "Herdr is not running on this machine." : sshProblem(error.stderr));
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

  async #removeSockets() {
    await rm(this.socketPath, { force: true }).catch(() => {});
    await rm(clientSocketFor(this.socketPath), { force: true }).catch(() => {});
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const master = this.master;
    this.master = null;
    master?.kill();
    await this.#removeSockets();
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

// A directory this user alone owns, and not a link to one somewhere else.
async function ownPrivateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`${path} is not a directory of this user's`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700);
}

// A private directory for the forwarded sockets: they open the machines' Herdr
// to whoever can reach them. Each HerdRabbit process has its own, so two
// running side by side (a service and a test copy) never take over each
// other's. Without a runtime directory, a fresh one is made in the temp
// directory, under a name nobody can have prepared.
export async function machineSocketDirectory(environment = process.env, pid = process.pid) {
  if (!environment.XDG_RUNTIME_DIR) return mkdtemp(join(tmpdir(), "herdrabbit-machines-"));
  const base = join(environment.XDG_RUNTIME_DIR, `herdrabbit-${process.getuid?.() ?? "user"}`);
  await mkdir(base, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  await ownPrivateDirectory(base);
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

// A server entry's client for one machine: the local Herdr client, pointed at
// the machine's forwarded socket once the connection is up.
export class MachineClient {
  constructor({ link, createBridge }) {
    this.link = link;
    this.bridge = createBridge(link);
  }

  #ready() {
    if (this.link.state !== "ready") throw machineOffline(this.link.error ?? undefined);
    return this.bridge;
  }

  info() { return { version: null, herdrVersion: null }; }
  close() {}
  async snapshot() { return this.#ready().snapshot(); }
  async readPane(...args) { return this.#ready().readPane(...args); }
  async sendText(...args) { return this.#ready().sendText(...args); }
  async sendKeys(...args) { return this.#ready().sendKeys(...args); }
  async watchStatuses(...args) { return this.#ready().watchStatuses(...args); }
  async terminalTarget(...args) { return this.#ready().terminalTarget(...args); }
  async createWorkspace(...args) { return this.#ready().createWorkspace(...args); }
  async renameWorkspace(...args) { return this.#ready().renameWorkspace(...args); }
  async closeWorkspace(...args) { return this.#ready().closeWorkspace(...args); }
  async createTab(...args) { return this.#ready().createTab(...args); }
  async renameTab(...args) { return this.#ready().renameTab(...args); }
  async closeTab(...args) { return this.#ready().closeTab(...args); }
}

// Every machine in Herdr's list; the enabled ones kept connected.
export class HerdrMachines {
  constructor({ binary = "herdr", directory, createBridge, read = (options) => readMachines(options),
    createLink = (machine, options) => new MachineLink(machine, options), run = execFileAsync, log = () => {}, refreshMs = 30_000 }) {
    this.binary = binary;
    this.directory = directory;
    this.createBridge = createBridge;
    this.read = read;
    this.createLink = createLink;
    this.run = run;
    this.log = log;
    this.refreshMs = refreshMs;
    this.machines = [];
    this.links = new Map();
    this.clients = new Map();
    // One `herdr machine` change at a time, and the one running can be cut short.
    this.changing = null;
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

  // Server profiles for the sidebar. A machine that is turned off stays
  // listed, so it can be turned on again from here.
  profiles() {
    return this.machines.map((machine) => ({
      id: `${MACHINE_SERVER_PREFIX}${machine.id.slice(0, 12)}`,
      name: machine.label,
      transport: "machine",
      machineId: machine.id,
      address: machine.target,
      enabled: machine.enabled,
    }));
  }

  machineIdFor(serverId) {
    return this.profiles().find((profile) => profile.id === serverId)?.machineId ?? null;
  }

  // Null while the machine has no connection (turned off, or not started yet).
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

  async #command(args, { timeoutMs = 30_000, fallback }) {
    if (this.changing) throw new HttpError(409, "machine_busy", "Another machine change is still running. Try again when it finishes.");
    const abort = new AbortController();
    this.changing = abort;
    try {
      await this.run(this.binary, ["machine", ...args], { encoding: "utf8", timeout: timeoutMs, signal: abort.signal });
    } catch (error) {
      throw machineCommandError(error, fallback);
    } finally {
      this.changing = null;
    }
    await this.refresh();
  }

  // Prepares Herdr on the machine and saves it; nothing is asked for here, so
  // a machine that needs a password or a new host key is set up in a terminal.
  add({ target, label }) {
    return this.#command(["add", target, ...(label ? ["--label", label] : [])], {
      timeoutMs: 180_000, fallback: "Herdr could not set up this machine. Run `herdr machine add` for it in a terminal to see why.",
    });
  }

  rename(machineId, label) {
    // The id comes first: Herdr 0.9.3 refuses `rename --label <label> <id>` despite its help.
    return this.#command(["rename", machineId, "--label", label], { fallback: "Herdr could not rename this machine." });
  }

  disable(machineId) {
    return this.#command(["disable", machineId], { fallback: "Herdr could not turn this machine off." });
  }

  enable(machineId) {
    return this.#command(["enable", machineId], { fallback: "Herdr could not turn this machine on." });
  }

  remove(machineId) {
    return this.#command(["remove", machineId], { fallback: "Herdr could not remove this machine." });
  }

  async stop() {
    clearInterval(this.timer);
    this.changing?.abort();
    await Promise.all([...this.links.values()].map((link) => link.stop()));
    this.links.clear();
    await rm(this.directory, { recursive: true, force: true }).catch(() => {});
  }
}
