import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter, codexAdapter } from "../src/ai-account-adapters.mjs";
import { MachineAiAccounts, NO_NODE_REASON, shippedProgram } from "../src/machine-ai-accounts.mjs";
import { HerdrMachines, machineOffline } from "../src/herdr-machines.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { SECRET, stagedLocation, stagingDirectoryOf, writeClaude, writeCodex } from "./fixtures/ai-accounts.mjs";

const ID = "4c139ff50dfb4a0dcda27e728dc50ef9";
const SERVER = "machine-4c139ff50dfb";
const SESSION = "hs_ZGVmYXVsdA";
const MISSING_ACCOUNT = "acct_00000000-0000-0000-0000-000000000000";

// Stands in for ssh: the remote command runs in a local shell under the
// machine's (temporary) home, as the remote login shell would run it, with
// the program arriving on stdin. Nothing of this machine's own environment
// that could point the CLIs elsewhere is passed on.
function fakeSsh(home, { path = process.env.PATH } = {}) {
  const commands = [];
  const inputs = [];
  const spawnProcess = (binary, args, options) => {
    assert.equal(binary, "ssh");
    commands.push(args);
    const child = spawn("/bin/sh", ["-c", args.at(-1)], { ...options, cwd: home, env: { HOME: home, PATH: path } });
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (data) => { inputs.push(String(data)); return end(data); };
    return child;
  };
  return { commands, inputs, spawnProcess };
}

const fakeLink = () => ({
  ssh: "ssh", state: "ready",
  sshArgs: (options, ...command) => ["-S", "/run/x.ctl", ...options, "--", "me@lab", ...command],
});

// A remote home with Claude and Codex both signed in to account A.
async function remoteHome(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-machine-accounts-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  const claude = claudeAdapter.locate(env);
  const codex = codexAdapter.locate(env);
  await writeClaude(claude, { uuid: "uuid-a", email: "a@example.com", token: "a1" });
  await writeCodex(codex, { accountId: "codex-a", email: "a@example.com", token: "a1" });
  return { home, claude, codex, store: join(home, ".config", "herdr-bridge", "ai-accounts") };
}

async function setup(t, { running = [], path, systemNodeDirs } = {}) {
  const remote = await remoteHome(t);
  const ssh = fakeSsh(remote.home, { path });
  const link = fakeLink();
  const accounts = new MachineAiAccounts({ link: () => link, spawnProcess: ssh.spawnProcess, runningAgents: async () => running, systemNodeDirs });
  return { ...remote, ...ssh, accounts };
}

// Every answer the caller got, in one string to look for token bytes in.
function seenBy(values) {
  return JSON.stringify(values);
}

test("the program shipped to a machine is constant text built from the account manager itself", async () => {
  assert.ok(shippedProgram().includes("new AiAccounts("));
  assert.ok(!shippedProgram().includes(SECRET));
  // The shipped modules are this machine's own files, base64 in data: URLs,
  // with only their two relative imports pointed at each other.
  const decode = (text) => [...text.matchAll(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/gu)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf8"));
  const [accounts] = decode(shippedProgram());
  const [adapters] = decode(accounts);
  assert.equal(adapters, await readFile(new URL("../src/ai-account-adapters.mjs", import.meta.url), "utf8"));
  const original = await readFile(new URL("../src/ai-accounts.mjs", import.meta.url), "utf8");
  assert.equal(accounts.replace(/"data:[^"]+"/gu, "X"), original.replace(/"\.\/(ai-account-adapters|herdr-client)\.mjs"/gu, "X"));
});

test("lists, saves, signs in, switches and removes accounts on the machine, with no token coming back", async (t) => {
  const machine = await setup(t);
  const answers = [];
  const keep = (value) => { answers.push(value); return value; };

  const first = keep(await machine.accounts.list());
  assert.deepEqual(first.clis.map((cli) => [cli.id, cli.supported, cli.current?.email, cli.current?.id]),
    [["claude", true, "a@example.com", null], ["codex", true, "a@example.com", null]]);

  const saved = keep(await machine.accounts.saveCurrent("claude"));
  assert.match(saved.account.id, /^acct_/u);
  assert.equal(saved.account.active, true);
  // Saved under the machine's own home, private as on this machine.
  const slot = join(machine.store, "claude", saved.account.id);
  assert.equal((await stat(machine.store)).mode & 0o777, 0o700);
  assert.equal((await stat(slot)).mode & 0o777, 0o700);
  assert.equal((await stat(join(slot, "credentials.json"))).mode & 0o777, 0o600);
  assert.match(await readFile(join(slot, "credentials.json"), "utf8"), /refresh-a1/u);

  // A second account signs in on the machine, in a directory of its own there.
  const login = keep(await machine.accounts.startLogin("claude"));
  assert.equal(login.label, "Claude Code");
  const staging = stagingDirectoryOf(login.command);
  assert.ok(staging.startsWith(`${machine.store}/staging/claude/`), "the sign-in directory is on the machine");
  assert.match(login.command, /^env CLAUDE_CONFIG_DIR='[^']+' claude auth login$/u);
  assert.ok((keep(await machine.accounts.list())).clis[0].logins.includes(login.loginId), "a reload finds the open sign-in");
  await writeClaude(stagedLocation("claude", staging), { uuid: "uuid-b", email: "b@example.com", token: "b1" });
  const finished = keep(await machine.accounts.finishLogin("claude", login.loginId));
  assert.equal(finished.account.email, "b@example.com");
  assert.equal(finished.account.active, false);
  assert.equal(existsSync(staging), false);

  const switched = keep(await machine.accounts.switch("claude", finished.account.id));
  assert.equal(switched.changed, true);
  assert.match(await readFile(machine.claude.credentials, "utf8"), /refresh-b1/u);
  assert.equal(JSON.parse(await readFile(machine.claude.global, "utf8")).oauthAccount.emailAddress, "b@example.com");

  const listed = keep(await machine.accounts.list());
  assert.deepEqual(listed.clis[0].accounts.map((item) => [item.email, item.active]).sort(),
    [["a@example.com", false], ["b@example.com", true]]);

  await assert.rejects(machine.accounts.remove("claude", finished.account.id), { status: 409, code: "account_active" });
  keep(await machine.accounts.remove("claude", saved.account.id));
  assert.equal(existsSync(slot), false);
  await assert.rejects(machine.accounts.switch("claude", MISSING_ACCOUNT), { status: 404, code: "account_not_found" });

  // Cancelling a sign-in clears its directory on the machine.
  const other = keep(await machine.accounts.startLogin("codex"));
  keep(await machine.accounts.cancelLogin("codex", other.loginId));
  assert.equal(existsSync(stagingDirectoryOf(other.command)), false);

  assert.ok(!seenBy(answers).includes(SECRET), "no token in any answer");
  // Nothing on any command line but fixed words and checked ids, and the
  // same constant program each time.
  assert.ok(!seenBy(machine.commands).includes(SECRET));
  assert.ok(machine.inputs.every((input) => input === shippedProgram()));
  for (const args of machine.commands) {
    assert.deepEqual(args.slice(0, 9), ["-S", "/run/x.ctl", "-T", "-o", "ControlMaster=no", "-o", "ProxyCommand=false", "--", "me@lab"]);
  }
});

test("a switch looks for agents in the machine's panes and goes ahead only when told to", async (t) => {
  const machine = await setup(t, { running: [{ paneId: "w1:p1", agent: "claude", label: "main" }, { paneId: "w1:p2", agent: "codex", label: "main" }] });
  await machine.accounts.saveCurrent("claude");
  const login = await machine.accounts.startLogin("claude");
  await writeClaude(stagedLocation("claude", stagingDirectoryOf(login.command)), { uuid: "uuid-b", email: "b@example.com", token: "b1" });
  const finished = await machine.accounts.finishLogin("claude", login.loginId);

  const runs = machine.commands.length;
  await assert.rejects(machine.accounts.switch("claude", finished.account.id), (error) => {
    assert.equal(error.code, "agents_running");
    assert.deepEqual(error.details, { panes: [{ paneId: "w1:p1", label: "main" }] });
    return true;
  });
  assert.equal(machine.commands.length, runs, "nothing ran on the machine");
  assert.doesNotMatch(await readFile(machine.claude.credentials, "utf8"), /refresh-b1/u);

  const switched = await machine.accounts.switch("claude", finished.account.id, { confirmRunning: true });
  assert.equal(switched.changed, true);
  assert.match(await readFile(machine.claude.credentials, "utf8"), /refresh-b1/u);
});

test("a machine without Node.js 22 or newer shows why and refuses every change", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "herdrabbit-no-node-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  // A shell and the tools the launcher locks with, and no node anywhere on the
  // PATH or in the system folders it adds (stood in for by an empty one, so a
  // Node installed on this machine does not count).
  const { execFileSync } = await import("node:child_process");
  for (const tool of ["sh", "mkdir", "chmod", "flock"]) {
    await symlink(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  }
  const missing = await setup(t, { path: bin, systemNodeDirs: [join(bin, "system")] });
  const listing = await missing.accounts.list();
  assert.deepEqual(listing.clis.map((cli) => [cli.id, cli.supported, cli.reason]),
    [["claude", false, NO_NODE_REASON], ["codex", false, NO_NODE_REASON]]);
  await assert.rejects(missing.accounts.saveCurrent("claude"), { status: 501, code: "machine_node_missing", message: NO_NODE_REASON });
  await assert.rejects(missing.accounts.startLogin("codex"), { code: "machine_node_missing" });

  // One that is there but too old counts the same.
  await writeFile(join(bin, "node"), "#!/bin/sh\necho 20\n");
  await chmod(join(bin, "node"), 0o755);
  await assert.rejects(missing.accounts.saveCurrent("claude"), { code: "machine_node_missing" });
  assert.equal(existsSync(missing.store), false, "nothing was written there");

  // An old one first on the PATH does not hide a newer one after it.
  const later = join(bin, "later");
  await mkdir(later);
  await symlink(process.execPath, join(later, "node"));
  const shadowed = new MachineAiAccounts({
    link: fakeLink, systemNodeDirs: [join(bin, "system")],
    spawnProcess: fakeSsh(missing.home, { path: `${bin}:${later}` }).spawnProcess,
  });
  assert.equal((await shadowed.saveCurrent("claude")).account.email, "a@example.com");
  await rm(later, { recursive: true });
  await rm(missing.store, { recursive: true, force: true });

  // A Node that nvm keeps under the home folder is found without the PATH.
  const nvm = join(missing.home, ".nvm", "versions", "node", "v99.0.0", "bin");
  await mkdir(nvm, { recursive: true });
  await symlink(process.execPath, join(nvm, "node"));
  assert.equal((await missing.accounts.saveCurrent("claude")).account.email, "a@example.com");
});

test("a machine that is off or not connected refuses account calls without running anything", async () => {
  const accounts = new MachineAiAccounts({
    link: () => { throw machineOffline("Turned off"); },
    spawnProcess: () => assert.fail("nothing runs"),
    runningAgents: () => assert.fail("no panes to read"),
  });
  await assert.rejects(accounts.list(), { status: 503, code: "machine_offline", message: "Turned off" });
  await assert.rejects(accounts.switch("claude", MISSING_ACCOUNT), { status: 503, code: "machine_offline" });

  const dropped = new MachineAiAccounts({
    link: fakeLink,
    spawnProcess: () => spawn("sh", ["-c", "cat >/dev/null; exit 255"], { stdio: ["pipe", "pipe", "ignore"] }),
  });
  await assert.rejects(dropped.saveCurrent("claude"), { status: 503, code: "machine_offline" });
});

test("ids and CLI names are checked here, before anything runs, and again on the machine", async (t) => {
  const machine = await setup(t);
  const attempts = [
    () => machine.accounts.saveCurrent("claude'; touch pwned; '"),
    () => machine.accounts.startLogin("../claude"),
    () => machine.accounts.switch("claude", "acct_$(touch pwned)"),
    () => machine.accounts.switch("claude", "../../.ssh"),
    () => machine.accounts.remove("codex", `${MISSING_ACCOUNT}\nid`),
    () => machine.accounts.finishLogin("claude", "login_x' 'y"),
    () => machine.accounts.cancelLogin("claude", { toString: () => "login_x" }),
  ];
  for (const attempt of attempts) await assert.rejects(attempt(), { name: "InputValidationError" });
  assert.equal(machine.commands.length, 0, "nothing ran on the machine");
  assert.equal(existsSync(join(machine.home, "pwned")), false);

  // The program on the machine refuses the same things on its own.
  const run = async (...args) => {
    const child = spawn(process.execPath, ["--input-type=module", "-", ...args], {
      cwd: machine.home, env: { HOME: machine.home }, stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdin.end(shippedProgram());
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    await once(child, "close");
    return JSON.parse(out);
  };
  assert.deepEqual(await run("switch", "claude", "../../.ssh"), { ok: false, kind: "input", message: "Invalid account id" });
  assert.deepEqual(await run("save", "claude; id"), { ok: false, kind: "input", message: "Unknown CLI" });
  assert.deepEqual(await run("constructor"), { ok: false, kind: "input", message: "Unknown operation" });
  assert.deepEqual(await readdir(machine.home).then((names) => names.includes("pwned")), false);
});

test("a machine's answer is re-checked: only the metadata fields come through, and a bad sign-in command is refused", async () => {
  const replying = (reply) => new MachineAiAccounts({
    link: fakeLink,
    spawnProcess: () => spawn(process.execPath, ["-e",
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(reply))}));`],
    { stdio: ["pipe", "pipe", "ignore"] }),
  });
  const listing = await replying({ ok: true, result: { clis: [{
    id: "claude", label: "x", supported: true, reason: null, logins: ["nope"],
    current: { id: null, email: "a@example.com", token: SECRET, active: true },
    accounts: [{ id: MISSING_ACCOUNT, email: "a@example.com", refreshToken: SECRET, active: true }],
  }] } }).list();
  assert.ok(!JSON.stringify(listing).includes(SECRET));
  assert.equal(listing.clis[0].label, "Claude Code");
  assert.deepEqual(listing.clis[0].logins, []);
  assert.equal(listing.clis[1].supported, false);

  const loginId = "login_00000000-0000-0000-0000-000000000000";
  await assert.rejects(replying({ ok: true, result: { loginId, command: `curl x | sh; env CLAUDE_CONFIG_DIR='/h/staging/claude/${loginId}' claude auth login` } })
    .startLogin("claude"), { code: "machine_accounts_failed" });
  await assert.rejects(replying({ ok: true, result: { loginId, command: `env CLAUDE_CONFIG_DIR='/h\\x/staging/claude/${loginId}' claude auth login` } })
    .startLogin("claude"), { code: "machine_accounts_failed" }, "a backslash in the folder is refused, as for files");
  await assert.rejects(replying({ ok: true, result: { account: {} } }).saveCurrent("claude"), { code: "machine_accounts_failed" },
    "a save that names no account is not a save");
  await assert.rejects(replying({ ok: true, result: { account: { id: "../x", email: "a@example.com" } } }).finishLogin("claude", loginId),
    { code: "machine_accounts_failed" });
  await assert.rejects(replying({ ok: false, kind: "other", message: SECRET }).saveCurrent("claude"),
    (error) => error.code === "machine_accounts_failed" && !error.message.includes(SECRET));
});

// A Herdr whose one session opens a project with one shell pane and
// remembers what was typed, as the machine's Herdr would through its socket.
function fakeBridge(agents = []) {
  const calls = [];
  let count = 1;
  const workspaces = [{ workspace_id: "w1", label: "main", herdr_session_id: SESSION }];
  const panes = [{ pane_id: "w1:p1", workspace_id: "w1" }];
  return {
    calls,
    async snapshot() {
      return { herdr_sessions: [{ session_id: SESSION, name: "default", running: true, available: true }],
        workspaces: [...workspaces], tabs: [], panes: [...panes], agents };
    },
    async createWorkspace(label, sessionId) {
      calls.push(["createWorkspace", label, sessionId]);
      count += 1;
      workspaces.push({ workspace_id: `w${count}`, label, herdr_session_id: SESSION });
      panes.push({ pane_id: `w${count}:p1`, workspace_id: `w${count}` });
    },
    async closeWorkspace(id) { calls.push(["closeWorkspace", id]); },
    async sendText(id, text, options) { calls.push(["sendText", id, text, options]); },
  };
}

test("the account routes reach a machine with server=, sign in on the machine and check its panes", async (t) => {
  const remote = await remoteHome(t);
  const ssh = fakeSsh(remote.home);
  const bridge = fakeBridge([{ pane_id: "w1:p1", agent: "claude", workspace_id: "w1" }]);
  const machines = new HerdrMachines({
    directory: "/run/x", createBridge: () => bridge,
    createLink: (machine) => ({ machine, ...fakeLink(), error: null, start() {}, async stop() {} }),
    createAccounts: (options) => new MachineAiAccounts({ ...options, spawnProcess: ssh.spawnProcess }),
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }],
  });
  await machines.refresh();
  const localCalls = [];
  const local = {
    snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }),
    createWorkspace: async (...args) => { localCalls.push(args); },
    sendText: async (...args) => { localCalls.push(args); },
  };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [] }, machines });
  await herdr.snapshot();
  const localAccounts = new Proxy({}, { get: () => () => assert.fail("not this machine's accounts") });
  const created = createHerdrHttpServer({ herdr, aiAccounts: localAccounts, csrfToken: "fixed-test-token", logger: { error() {} } });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  t.after(() => new Promise((resolve) => created.server.close(resolve)));
  const base = `http://127.0.0.1:${created.server.address().port}`;
  const seen = [];
  const request = async (path, { method = "POST", body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-herdr-csrf": "fixed-test-token", origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    seen.push(text);
    return { status: response.status, body: JSON.parse(text) };
  };

  const listed = await request(`/api/ai-accounts?server=${SERVER}`, { method: "GET" });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.server, SERVER);
  assert.equal(listed.body.clis[0].current.email, "a@example.com");
  const saved = await request("/api/ai-accounts/current", { body: { server: SERVER, cli: "claude" } });
  assert.equal(saved.status, 200);

  const started = await request("/api/ai-accounts/logins", {
    body: { server: SERVER, cli: "claude", herdrSessionId: `${SERVER}!${SESSION}` },
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.paneId, `${SERVER}!w2:p1`);
  assert.deepEqual(localCalls, [], "nothing opened on this machine");
  const [, label, session] = bridge.calls.find(([name]) => name === "createWorkspace");
  assert.match(label, /^AI login: Claude Code/u);
  assert.equal(session, SESSION);
  const [, paneId, command] = bridge.calls.find(([name]) => name === "sendText");
  assert.equal(paneId, "w2:p1");
  assert.ok(stagingDirectoryOf(command).startsWith(`${remote.store}/staging/claude/`), "the machine signs in to its own directory");
  await writeClaude(stagedLocation("claude", stagingDirectoryOf(command)), { uuid: "uuid-b", email: "b@example.com", token: "b1" });
  const finished = await request(`/api/ai-accounts/logins/${started.body.loginId}/finish`, {
    body: { server: SERVER, cli: "claude", workspaceId: started.body.workspaceId },
  });
  assert.equal(finished.status, 200);
  assert.ok(bridge.calls.some(([name, id]) => name === "closeWorkspace" && id === "w2"));

  // Claude runs in one of the machine's panes, so the switch asks first.
  const asked = await request("/api/ai-accounts/switch", { body: { server: SERVER, cli: "claude", account: finished.body.account.id } });
  assert.equal(asked.status, 409);
  assert.equal(asked.body.error.code, "agents_running");
  assert.deepEqual(asked.body.error.details.panes, [{ paneId: "w1:p1", label: "main" }]);
  const switched = await request("/api/ai-accounts/switch", {
    body: { server: SERVER, cli: "claude", account: finished.body.account.id, confirmRunning: true },
  });
  assert.equal(switched.status, 200);
  assert.match(await readFile(remote.claude.credentials, "utf8"), /refresh-b1/u);

  const bad = await request("/api/ai-accounts/switch", { body: { server: SERVER, cli: "claude", account: "x'; id" } });
  assert.equal(bad.status, 400);
  assert.ok(!seen.join("\n").includes(SECRET), "no token in any response");
});

test("an unknown machine id is not a server here", async () => {
  const machines = new HerdrMachines({ directory: "/run/x", createBridge: () => ({}), createLink: () => ({}), read: async () => [] });
  await machines.refresh();
  const herdr = new MultiServerClient({ local: {}, profiles: { list: () => [] }, machines });
  assert.equal(herdr.aiAccountsClient("machine-000000000000"), null);
  assert.equal(herdr.aiAccountsClient("local"), null);
});

test("the store on the machine stays private when the folder above it is not", async (t) => {
  const machine = await setup(t);
  await mkdir(join(machine.home, ".config"), { mode: 0o755 });
  await machine.accounts.saveCurrent("codex");
  for (const path of [machine.store, join(machine.store, "codex")]) assert.equal((await stat(path)).mode & 0o777, 0o700);
});



test("a machine that hangs, floods its answer or cannot be reached fails cleanly", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const fake = (behave) => () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: [] });
    child.kill = (signal) => { child.killed.push(signal); setImmediate(() => child.emit("close", null)); return true; };
    setImmediate(() => behave(child));
    fake.last = child;
    return child;
  };
  // The timeout's timer does not hold the process open; this does, meanwhile.
  const awake = setInterval(() => {}, 1_000);
  const hangs = new MachineAiAccounts({ link: fakeLink, spawnProcess: fake(() => {}), timeoutMs: 50 });
  await assert.rejects(hangs.saveCurrent("claude"), { code: "machine_timeout", status: 504 }).finally(() => clearInterval(awake));
  assert.deepEqual(fake.last.killed, ["SIGKILL"]);

  const floods = new MachineAiAccounts({ link: fakeLink, spawnProcess: fake((child) => child.stdout.write(Buffer.alloc(300 * 1024, 120))) });
  await assert.rejects(floods.list(), { code: "machine_accounts_failed" });
  assert.deepEqual(fake.last.killed, ["SIGKILL"], "a flood is cut off");

  const broken = new MachineAiAccounts({ link: fakeLink, spawnProcess: fake((child) => child.emit("error", new Error("spawn ssh ENOENT"))) });
  await assert.rejects(broken.saveCurrent("claude"), (error) => error.code === "machine_accounts_failed" && !error.message.includes("ENOENT"));
});

test("two processes changing the same machine at once both get through, one after the other", async (t) => {
  const remote = await remoteHome(t);
  const ssh = fakeSsh(remote.home);
  // Two HerdRabbits reaching the same machine: nothing shared on this side.
  const one = new MachineAiAccounts({ link: fakeLink, spawnProcess: ssh.spawnProcess });
  const two = new MachineAiAccounts({ link: fakeLink, spawnProcess: ssh.spawnProcess });
  const [a, b] = await Promise.all([one.saveCurrent("claude"), two.saveCurrent("codex")]);
  assert.equal(a.account.email, "a@example.com");
  assert.equal(b.account.email, "a@example.com");
});

test("a change waits for one still running there, and a run that died holds nothing", async (t) => {
  const remote = await remoteHome(t);
  const ssh = fakeSsh(remote.home);
  const accounts = new MachineAiAccounts({ link: fakeLink, spawnProcess: ssh.spawnProcess, timeoutMs: 1_500 });
  await mkdir(remote.store, { recursive: true });
  const lock = join(remote.store, ".change-lock");
  // Another run on the machine holds the kernel lock.
  // Its own process group, so ending it ends the sleep that inherits the lock.
  const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore", detached: true });
  const end = () => { try { process.kill(-holder.pid, "SIGKILL"); } catch {} };
  t.after(end);
  for (let i = 0; i < 50 && !existsSync(lock); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(accounts.saveCurrent("claude"), { code: "machine_timeout" }, "waits rather than going ahead");
  // It dies without cleaning up; the lock went with it, the file stays.
  end();
  await once(holder, "exit");
  assert.equal(existsSync(lock), true);
  const saved = await accounts.saveCurrent("claude");
  assert.equal(saved.account.email, "a@example.com");
  const listed = await accounts.list();
  assert.equal(listed.clis.find((cli) => cli.id === "claude").accounts.length, 1, "the lock file is not an account");
});

test("a machine without flock refuses changes and says why", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "herdrabbit-no-flock-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const tool of ["sh", "mkdir", "chmod"]) {
    const { execFileSync } = await import("node:child_process");
    await symlink(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  }
  await symlink(process.execPath, join(bin, "node"));
  const machine = await setup(t, { path: bin, systemNodeDirs: [join(bin, "system")] });
  await assert.rejects(machine.accounts.saveCurrent("claude"), { code: "machine_tools_missing", status: 501 });
  assert.ok((await machine.accounts.list()).clis.length > 0, "the list needs no lock");
});
