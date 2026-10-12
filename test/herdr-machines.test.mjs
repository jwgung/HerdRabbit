import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrMachines, MachineClient, clientSocketFor, machineSocketDirectory, readMachines, socketFromStatus,
  validMachineLabel, validMachineTarget,
} from "../src/herdr-machines.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";

const ID = "4c139ff50dfb4a0dcda27e728dc50ef9";
const OTHER = "0123456789abcdef0123456789abcdef";

test("reads Herdr's machines with their status, keeping only well-formed entries", async () => {
  const run = async (binary, args) => ({
    stdout: JSON.stringify(args[1] === "list"
      ? [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true },
        { id: OTHER, label: "", target: "spare", enabled: false },
        { id: "bad", target: "x" },
        { id: "fedcba9876543210fedcba9876543210", target: "-oProxyCommand=touch /tmp/x" }]
      : [{ id: ID, status: "reachable", error: null }, { id: OTHER, status: "unreachable", error: "timed out" }]),
  });
  assert.deepEqual(await readMachines({ run }), [
    { id: ID, label: "lab", target: "me@lab", session: "default", enabled: true, reachable: true, error: null },
    { id: OTHER, label: "spare", target: "spare", session: "default", enabled: false, reachable: false, error: "timed out" },
  ]);
});

test("finds the remote socket in `herdr status server` and names its attach socket", () => {
  assert.equal(socketFromStatus("status: running\nversion: 0.9.3\nsocket: /home/a/.config/herdr/herdr.sock\n"), "/home/a/.config/herdr/herdr.sock");
  assert.equal(socketFromStatus("status: stopped\n"), null);
  assert.equal(clientSocketFor("/home/a/.config/herdr/herdr.sock"), "/home/a/.config/herdr/herdr-client.sock");
  assert.equal(clientSocketFor("/run/x/4c139ff50dfb.sock"), "/run/x/4c139ff50dfb-client.sock");
});

test("accepts SSH targets and names only in the plain forms Herdr takes", () => {
  for (const target of ["me@lab", "lab", "me@lab.example.com", "my-host_2"]) assert.equal(validMachineTarget(target), true, target);
  for (const target of ["-oProxyCommand=x", "me@-oProxyCommand=x", "me@lab extra", "me@", "", "a\nb", "x".repeat(201)]) assert.equal(validMachineTarget(target), false, target);
  assert.equal(validMachineLabel("Lab desk"), true);
  for (const label of ["", " padded", "a\nb", "x".repeat(61)]) assert.equal(validMachineLabel(label), false);
});

test("without a runtime directory the temporary one holds the same private per-user directory, cleared the same way", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "herdr-tmp-"));
  const stale = await machineSocketDirectory({}, 999_999_999, temporary);
  const mine = await machineSocketDirectory({}, process.pid, temporary);
  assert.equal(join(mine, ".."), join(temporary, `herdrabbit-machines-${process.getuid()}`));
  assert.equal((await stat(mine)).mode & 0o777, 0o700);
  assert.equal((await stat(join(mine, ".."))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(mine, "..")), [String(process.pid)], `${stale} belonged to a process that is gone`);
});

test("refuses a runtime directory entry that is a link to somewhere else", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "herdr-machines-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "herdr-elsewhere-"));
  await mkdir(join(elsewhere, "12345"));
  await symlink(elsewhere, join(runtime, `herdrabbit-${process.getuid()}`));
  await assert.rejects(machineSocketDirectory({ XDG_RUNTIME_DIR: runtime }), /not a directory of this user's/);
  assert.deepEqual(await readdir(elsewhere), ["12345"], "nothing behind the link was touched");
});

test("each process keeps its sockets in its own private directory and clears what a stopped one left", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "herdr-machines-"));
  const stale = await machineSocketDirectory({ XDG_RUNTIME_DIR: runtime }, 999_999_999);
  const mine = await machineSocketDirectory({ XDG_RUNTIME_DIR: runtime }, process.pid);
  assert.equal((await stat(mine)).mode & 0o777, 0o700);
  assert.equal((await stat(join(mine, ".."))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(mine, "..")), [String(process.pid)], `${stale} belonged to a process that is gone`);
});

function fakeLinks() {
  const links = [];
  const createLink = (machine) => {
    const link = { machine, state: "connecting", error: null, socketPath: `/run/${machine.id.slice(0, 12)}.sock`, started: 0, stopped: false,
      start() { this.started += 1; }, async stop() { this.stopped = true; } };
    links.push(link);
    return link;
  };
  return { links, createLink };
}

test("keeps a connection for each enabled machine, and drops one that goes away, is turned off or moves", async () => {
  let machines = [
    { id: ID, label: "lab", target: "me@lab", session: "default", enabled: true },
    { id: OTHER, label: "spare", target: "spare", session: "default", enabled: false },
  ];
  const { links, createLink } = fakeLinks();
  const herdr = new HerdrMachines({ directory: "/run/x", read: async () => machines, createLink, createBridge: (link) => ({ link, snapshot: async () => "snapshot" }) });
  await herdr.refresh();
  assert.equal(links.length, 1);
  assert.equal(links[0].started, 1);
  assert.deepEqual(herdr.profiles(), [
    { id: "machine-4c139ff50dfb", name: "lab", transport: "machine", machineId: ID, address: "me@lab", enabled: true },
    { id: "machine-0123456789ab", name: "spare", transport: "machine", machineId: OTHER, address: "spare", enabled: false },
  ], "a machine that is turned off stays listed, without a connection");
  assert.equal(herdr.machineIdFor("machine-4c139ff50dfb"), ID);

  const client = herdr.client(herdr.profiles()[0]);
  await assert.rejects(client.snapshot(), { code: "machine_offline" }, "nothing goes through before the connection is up");
  links[0].state = "ready";
  assert.equal(await client.snapshot(), "snapshot");

  machines = [{ ...machines[0], target: "me@lab2" }];
  await herdr.refresh();
  assert.equal(links[0].stopped, true, "a machine that points elsewhere starts over");
  assert.equal(links.length, 2);
  machines = [];
  await herdr.refresh();
  assert.equal(links[1].stopped, true);
  assert.deepEqual(herdr.profiles(), []);
});

test("machine management runs `herdr machine` and reports a refusal in words to act on", async () => {
  const calls = [];
  let release;
  const run = async (binary, args) => {
    calls.push(args);
    if (args[1] === "add" && args[2] === "new@host") {
      throw Object.assign(new Error("failed"), { stderr: "Host key verification failed.\r\nWelcome to lab (banner)" });
    }
    if (args[1] === "add" && args[2] === "slow@host") await new Promise((resolve) => { release = resolve; });
    return { stdout: "" };
  };
  const herdr = new HerdrMachines({ directory: "/run/x", read: async () => [], createLink: () => ({}), createBridge: () => ({}), run });
  await herdr.add({ target: "me@lab", label: "Lab" });
  await herdr.rename(ID, "Desk");
  await herdr.disable(ID);
  await herdr.enable(ID);
  await herdr.remove(ID);
  assert.deepEqual(calls, [
    ["machine", "add", "me@lab", "--label", "Lab"],
    ["machine", "rename", ID, "--label", "Desk"],
    ["machine", "disable", ID],
    ["machine", "enable", ID],
    ["machine", "remove", ID],
  ]);
  await assert.rejects(herdr.add({ target: "new@host", label: "" }), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /host key/);
    assert.doesNotMatch(error.message, /banner/, "the remote's own words are not passed on");
    return true;
  });
  const slow = herdr.add({ target: "slow@host", label: "" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(herdr.rename(ID, "Busy"), { status: 409 }, "one change at a time");
  release();
  await slow;
});

test("a machine is a server next to this one, and its panes attach", async () => {
  const { links, createLink } = fakeLinks();
  const machines = new HerdrMachines({
    directory: "/run/x", createLink,
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }],
    createBridge: () => ({
      snapshot: async () => ({ herdr_sessions: [{ session_id: "hs_x", name: "default", running: true, available: true }], workspaces: [], tabs: [], agents: [],
        panes: [{ pane_id: "hs_x~w1:p1" }] }),
      terminalTarget: async (paneId) => ({ terminalId: `term for ${paneId}` }),
    }),
  });
  await machines.refresh();
  links[0].state = "ready";
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [] }, machines });
  herdr.syncEntries();
  await herdr.refresh(herdr.entries.get("machine-4c139ff50dfb"));
  const snapshot = await herdr.snapshot();
  assert.deepEqual(snapshot.servers.map((server) => [server.id, server.transport, server.available]), [["local", "local", true], ["machine-4c139ff50dfb", "machine", true]]);
  assert.deepEqual(snapshot.panes.map((pane) => pane.pane_id), ["machine-4c139ff50dfb!hs_x~w1:p1"]);
  assert.deepEqual(await herdr.terminalTarget("machine-4c139ff50dfb!hs_x~w1:p1"), { terminalId: "term for hs_x~w1:p1" });
  assert.equal(typeof herdr.fileClient("machine-4c139ff50dfb")?.listDirectory, "function", "files go over the SSH connection");
  assert.equal(herdr.aiAccountsClient("machine-4c139ff50dfb"), null, "accounts come in a later step");
  assert.ok(MachineClient.prototype.snapshot);
});

test("a machine that is turned off stays listed as off, with nothing to reach", async () => {
  const machines = new HerdrMachines({
    directory: "/run/x", createLink: () => { throw new Error("no connection for a machine that is off"); }, createBridge: () => ({}),
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: false }],
  });
  await machines.refresh();
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [] }, machines });
  herdr.syncEntries();
  await herdr.refresh(herdr.entries.get("machine-4c139ff50dfb"));
  const [, machine] = (await herdr.snapshot()).servers;
  assert.deepEqual([machine.enabled, machine.available, machine.status], [false, false, "Turned off"]);
  await assert.rejects(herdr.readPane("machine-4c139ff50dfb!hs_x~w1:p1", {}), { code: "machine_offline" });
});

test("a linked HerdRabbit server's panes still keep the screen-text view", async () => {
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [{ id: "link_00000000-0000-0000-0000-000000000000", name: "old", address: "http://x" }] },
    remoteFactory: () => ({ snapshot: async () => ({}), terminalTarget: async () => ({}) }) });
  assert.throws(() => herdr.terminalTarget("link_00000000-0000-0000-0000-000000000000!hs_x~w1:p1"), { code: "attach_unsupported" });
});

test("a machine without a connection refuses every call the same way, and does not stop other servers' statuses", async () => {
  const machines = new HerdrMachines({
    directory: "/run/x", createLink: (machine) => ({ machine, state: "connecting", error: null, start() {}, async stop() {} }), createBridge: () => ({}),
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }],
  });
  await machines.refresh();
  const statuses = [];
  const local = {
    snapshot: async () => ({ herdr_sessions: [{ session_id: "hs_x", name: "default", running: true }], workspaces: [], tabs: [], panes: [], agents: [] }),
    watchStatuses: async (ids, onStatus) => { statuses.push(ids); return () => {}; },
  };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [] }, machines });
  await assert.rejects(herdr.createWorkspace("new", "machine-4c139ff50dfb!hs_x"), { code: "machine_offline" });
  await assert.rejects(herdr.terminalTarget("machine-4c139ff50dfb!hs_x~w1:p1"), { code: "machine_offline" });
  const errors = [];
  await herdr.watchStatuses(["hs_x~w1:p1", "machine-4c139ff50dfb!hs_x~w1:p1"], () => {}, (error) => errors.push(error));
  assert.deepEqual(statuses, [["hs_x~w1:p1"]]);
  assert.deepEqual(errors, [], "an unconnected machine is skipped, not reported as a failure of all statuses");
});

test("refreshes run one at a time, so an older listing never lands on a newer one", async () => {
  const answers = [];
  const machines = new HerdrMachines({
    directory: "/run/x", createLink: (machine) => ({ machine, state: "connecting", start() {}, async stop() {} }), createBridge: () => ({}),
    read: () => new Promise((resolve) => answers.push(resolve)),
  });
  const first = machines.refresh();
  const second = machines.refresh();
  assert.equal(answers.length, 1, "the second waits for the first");
  answers[0]([{ id: ID, label: "old", target: "me@lab", session: "default", enabled: true }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answers.length, 2, "and then runs once more");
  answers[1]([]);
  await Promise.all([first, second]);
  assert.deepEqual(machines.profiles(), [], "the listing asked for last is the one kept");
});

test("a forward that fails keeps its reason when the connection closes, and tries again later", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-link-"));
  const { MachineLink } = await import("../src/herdr-machines.mjs");
  const { EventEmitter } = await import("node:events");
  let child;
  const link = new MachineLink({ id: ID, label: "lab", target: "me@lab", session: "default" }, {
    directory,
    spawnProcess: () => {
      child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() { setImmediate(() => this.emit("exit", 255)); } });
      // The master's control socket appears once it is connected.
      writeFileSync(join(directory, `${ID.slice(0, 12)}.ctl`), "");
      return child;
    },
    // `herdr status server` there says nothing about a socket.
    run: async () => ({ stdout: "status: stopped\n" }),
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  link.start();
  // Real files are checked between steps: wait on the clock, not a number of turns.
  const deadline = performance.now() + 10_000;
  while (!(link.state === "offline" && link.retryTimer) && performance.now() < deadline) {
    context.mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(link.state, "offline");
  assert.equal(link.error, "Herdr is not running on this machine.");
  assert.ok(link.retryTimer, "another try is scheduled");
  await link.stop();
});

test("stopping while the list is being read starts no connection afterwards", async () => {
  let answer;
  const created = [];
  const machines = new HerdrMachines({
    directory: "/run/x", createBridge: () => ({}),
    createLink: (machine) => { created.push(machine.id); return { machine, start() {}, async stop() {} }; },
    read: () => new Promise((resolve) => { answer = resolve; }),
  });
  const refreshing = machines.refresh();
  const stopping = machines.stop();
  answer([{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }]);
  await Promise.all([refreshing, stopping]);
  assert.deepEqual(created, []);
});

test("two machines that share an id prefix are not offered", async () => {
  const logs = [];
  const machines = new HerdrMachines({
    directory: "/run/x", createBridge: () => ({}), log: (message) => logs.push(message),
    createLink: (machine) => ({ machine, start() {}, async stop() {} }),
    read: async () => [
      { id: `${ID.slice(0, 12)}${"0".repeat(20)}`, label: "a", target: "a", session: "default", enabled: true },
      { id: `${ID.slice(0, 12)}${"1".repeat(20)}`, label: "b", target: "b", session: "default", enabled: true },
      { id: OTHER, label: "c", target: "c", session: "default", enabled: true },
    ],
  });
  await machines.refresh();
  assert.deepEqual(machines.profiles().map((profile) => profile.name), ["c"]);
  assert.equal(machines.links.size, 1);
  assert.equal(logs.length, 2);
});

test("a machine whose connection comes up is asked again at once", async () => {
  let onChange;
  const machines = new HerdrMachines({
    directory: "/run/x",
    createLink: (machine, options) => { onChange = options.onChange; return { machine, state: "connecting", error: null, start() {}, async stop() {} }; },
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }],
    createBridge: () => ({ snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], agents: [], panes: [{ pane_id: "hs_x~w1:p1" }] }) }),
  });
  await machines.refresh();
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [] }, machines });
  herdr.syncEntries();
  const entry = herdr.entries.get("machine-4c139ff50dfb");
  await herdr.refresh(entry);
  assert.equal(entry.available, false, "still connecting");
  machines.links.get(ID).state = "ready";
  onChange();
  await entry.pending;
  assert.equal(entry.available, true, "available without waiting for the next poll");
});

test("a link is ready only once both sockets are forwarded, each to its own pair", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-link-"));
  const { MachineLink } = await import("../src/herdr-machines.mjs");
  const { EventEmitter } = await import("node:events");
  const calls = [];
  let forwarded = 0;
  let release;
  const link = new MachineLink({ id: ID, label: "lab", target: "me@lab", session: "default" }, {
    directory,
    spawnProcess: () => {
      writeFileSync(join(directory, `${ID.slice(0, 12)}.ctl`), "");
      return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() { setImmediate(() => this.emit("exit", null, "SIGTERM")); } });
    },
    run: async (command, args) => {
      calls.push(args);
      if (args.includes("forward")) {
        forwarded += 1;
        if (forwarded === 2) await new Promise((resolve) => { release = resolve; });
        return { stdout: "" };
      }
      return { stdout: "status: running\nsocket: /home/me/.config/herdr/herdr.sock\n" };
    },
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  link.start();
  // The link checks real files between steps; wait for them on the clock,
  // not for a number of turns, which a busy machine can outrun.
  const deadline = performance.now() + 10_000;
  while (!release && performance.now() < deadline) {
    context.mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(link.state, "connecting", "not ready while the attach socket is still being forwarded");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(link.state, "ready");
  const forwards = calls.filter((args) => args.includes("forward")).map((args) => {
    const at = args.indexOf("-L");
    return [args[at + 1], args.slice(args.indexOf("--"))];
  });
  const local = join(directory, `${ID.slice(0, 12)}`);
  assert.deepEqual(forwards, [
    [`${local}.sock:/home/me/.config/herdr/herdr.sock`, ["--", "me@lab"]],
    [`${local}-client.sock:/home/me/.config/herdr/herdr-client.sock`, ["--", "me@lab"]],
  ]);
  const status = calls.find((args) => args.at(-1).includes("status server"));
  assert.deepEqual(status.slice(status.indexOf("--"), -1), ["--", "me@lab"], "the remote command follows the destination");
  await link.stop();
});

test("the first machine listing runs in the background, and the snapshot says it is pending until it is in", async () => {
  let answer;
  const machines = new HerdrMachines({
    directory: "/run/x", createBridge: () => ({}),
    createLink: (machine) => ({ machine, state: "connecting", error: null, start() {}, async stop() {} }),
    // `herdr machine list` hangs until told otherwise.
    read: () => new Promise((resolve) => { answer = resolve; }),
  });
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [] }, machines });
  assert.equal(machines.start(), undefined, "start does not wait for the listing");
  const before = await herdr.snapshot();
  assert.equal(before.servers_pending, true);
  assert.deepEqual(before.servers.map((server) => server.id), ["local"], "local answers while the listing hangs");
  answer([{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }]);
  await machines.refreshing;
  const after = await herdr.snapshot();
  assert.equal(after.servers_pending, false);
  await machines.stop();
});

test("only a machine still connecting is reported as connecting", async () => {
  const OFF = "9".repeat(32);
  const FAILED = "8".repeat(32);
  const links = new Map();
  const machines = new HerdrMachines({
    directory: "/run/x", createBridge: () => ({ snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) }),
    createLink: (machine) => {
      const link = { machine, state: machine.id === FAILED ? "offline" : "connecting", error: machine.id === FAILED ? "Host key changed" : null, start() {}, async stop() {} };
      links.set(machine.id, link);
      return link;
    },
    read: async () => [
      { id: ID, label: "lab", target: "me@lab", session: "default", enabled: true },
      { id: OFF, label: "off", target: "me@off", session: "default", enabled: false },
      { id: FAILED, label: "failed", target: "me@failed", session: "default", enabled: true },
    ],
  });
  await machines.refresh();
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [] }, machines });
  herdr.syncEntries();
  const connecting = async () => Object.fromEntries((await herdr.snapshot()).servers.map((server) => [server.id, server.connecting]));
  assert.equal(herdr.entries.get("machine-999999999999").connecting, true, "not asked yet: every server may still come");
  await Promise.all([...herdr.entries.values()].map((entry) => herdr.refresh(entry)));
  assert.deepEqual(await connecting(), {
    local: false, "machine-4c139ff50dfb": true, "machine-999999999999": false, "machine-888888888888": false,
  });
  links.get(ID).state = "ready";
  await herdr.refresh(herdr.entries.get("machine-4c139ff50dfb"));
  assert.equal((await connecting())["machine-4c139ff50dfb"], false, "connected");
});

test("a connection change while the machine is being asked is followed by one more request", async () => {
  let onChange;
  let failFirst;
  let calls = 0;
  const empty = { herdr_sessions: [], workspaces: [], tabs: [], panes: [{ pane_id: "hs_x~w1:p1" }], agents: [] };
  const machines = new HerdrMachines({
    directory: "/run/x",
    createLink: (machine, options) => { onChange = options.onChange; return { machine, state: "ready", error: null, start() {}, async stop() {} }; },
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }],
    // The first request is still out when the connection changes, and then fails.
    createBridge: () => ({
      snapshot: () => (++calls === 1 ? new Promise((resolve, reject) => { failFirst = reject; }) : Promise.resolve(empty)),
    }),
  });
  await machines.refresh();
  const local = { snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }) };
  const herdr = new MultiServerClient({ local, profiles: { list: () => [] }, machines });
  herdr.syncEntries();
  const entry = herdr.entries.get("machine-4c139ff50dfb");
  const first = herdr.refresh(entry);
  while (!failFirst) await new Promise((resolve) => setImmediate(resolve));
  onChange();
  failFirst(new Error("the old connection dropped"));
  await first;
  assert.equal(entry.available, false, "the request that was out failed");
  await entry.pending;
  assert.equal(calls, 2, "asked once more after it");
  assert.equal(entry.available, true);
});

test("a stopped connection waits for its SSH process to end, and kills one that will not", async (context) => {
  const { endProcess } = await import("../src/herdr-machines.mjs");
  const { EventEmitter } = await import("node:events");
  const signals = [];
  const slow = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill(signal = "SIGTERM") { signals.push(signal); } });
  let ended = false;
  const ending = endProcess(slow, 3_000).then(() => { ended = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false, "still running");
  slow.emit("exit", null, "SIGTERM");
  await ending;
  assert.deepEqual(signals, ["SIGTERM"]);

  context.mock.timers.enable({ apis: ["setTimeout"] });
  const stuck = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill(signal = "SIGTERM") { signals.push(signal); } });
  let killed = false;
  const waiting = endProcess(stuck, 3_000).then(() => { killed = true; });
  context.mock.timers.tick(3_000);
  assert.deepEqual(signals, ["SIGTERM", "SIGTERM", "SIGKILL"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(killed, false, "waits for the killed process to be gone");
  stuck.emit("exit", null, "SIGKILL");
  await waiting;
  await endProcess(Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill() { throw new Error("already gone"); } }));
  await endProcess(Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { throw new Error("cannot signal"); } }), 3_000);
});

test("stopping does not wait for ever on a machine listing that hangs, and starts no connection after", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let answer;
  const created = [];
  const machines = new HerdrMachines({
    directory: await mkdtemp(join(tmpdir(), "herdr-stop-")), createBridge: () => ({}),
    createLink: (machine) => { created.push(machine.id); return { machine, state: "connecting", error: null, start() {}, async stop() {} }; },
    read: () => new Promise((resolve) => { answer = resolve; }),
  });
  machines.start();
  const stopping = machines.stop();
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(3_000);
  await stopping;
  answer([{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }]);
  await machines.refreshing;
  assert.deepEqual(created, [], "nothing starts once stopping has begun");
});

test("a link stopped while it waits for its SSH connection gives up at once", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-link-"));
  const { MachineLink } = await import("../src/herdr-machines.mjs");
  const { EventEmitter } = await import("node:events");
  const calls = [];
  const link = new MachineLink({ id: ID, label: "lab", target: "me@lab", session: "default" }, {
    directory,
    // The control socket never appears.
    spawnProcess: () => Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() { setImmediate(() => this.emit("exit", null, "SIGTERM")); } }),
    run: async (command, args) => { calls.push(args); return { stdout: "" }; },
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  link.start();
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(100);
  await link.stop();
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    context.mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
    if (calls.length) break;
  }
  assert.deepEqual(calls, [], "no remote command after stopping");
  assert.notEqual(link.state, "ready");
});

test("when the second forward fails the connection closes, both sockets go, and the next try forwards both again", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-link-"));
  const { MachineLink } = await import("../src/herdr-machines.mjs");
  const { EventEmitter } = await import("node:events");
  const { existsSync } = await import("node:fs");
  const local = join(directory, ID.slice(0, 12));
  const forwards = [];
  let masters = 0;
  let failSecond = true;
  const link = new MachineLink({ id: ID, label: "lab", target: "me@lab", session: "default" }, {
    directory,
    spawnProcess: () => {
      masters += 1;
      writeFileSync(`${local}.ctl`, "");
      return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() { setImmediate(() => this.emit("exit", 255)); } });
    },
    run: async (command, args) => {
      if (!args.includes("forward")) return { stdout: "socket: /home/me/.config/herdr/herdr.sock\n" };
      const target = args[args.indexOf("-L") + 1].split(":")[0];
      forwards.push(target);
      if (target.endsWith("-client.sock") && failSecond) {
        failSecond = false;
        throw Object.assign(new Error("forward failed"), { stderr: "mux_client_forward: forwarding request failed" });
      }
      writeFileSync(target, "");
      return { stdout: "" };
    },
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  link.start();
  const settle = async (done) => {
    const deadline = performance.now() + 10_000;
    while (!done() && performance.now() < deadline) {
      context.mock.timers.tick(100);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await settle(() => link.state === "offline" && link.retryTimer);
  assert.equal(link.state, "offline");
  assert.equal(existsSync(`${local}.sock`), true, "the first forward was made");
  // The retry clears what the failed try left, then forwards both again.
  await settle(() => link.state === "ready");
  assert.equal(link.state, "ready");
  assert.equal(masters, 2, "a new connection for the retry");
  assert.deepEqual(forwards, [`${local}.sock`, `${local}-client.sock`, `${local}.sock`, `${local}-client.sock`]);
  await link.stop();
  assert.equal(existsSync(`${local}.sock`), false, "stopping removes the sockets");
  assert.equal(existsSync(`${local}-client.sock`), false);
});

test("a machine client offers every call the local bridge does", async () => {
  const { HerdrBridgeClient } = await import("../src/herdr-bridge-client.mjs");
  const calls = (type) => Object.getOwnPropertyNames(type.prototype).filter((name) => name !== "constructor");
  const missing = calls(HerdrBridgeClient).filter((name) => typeof MachineClient.prototype[name] !== "function");
  assert.deepEqual(missing, [], "a call added to the bridge needs its machine counterpart");
});

test("no machine change starts once stopping has begun", async () => {
  const ran = [];
  const machines = new HerdrMachines({
    directory: await mkdtemp(join(tmpdir(), "herdr-stop-")), createBridge: () => ({}), createLink: () => ({}),
    read: async () => [], run: async (binary, args) => { ran.push(args); return { stdout: "" }; },
  });
  await machines.stop();
  await assert.rejects(machines.add({ target: "me@lab", label: "Lab" }), { status: 503 });
  await assert.rejects(machines.remove(ID), { status: 503 });
  assert.deepEqual(ran, []);
});

test("a link stopped between its two forwards makes no second one and leaves no socket", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-link-"));
  const { MachineLink } = await import("../src/herdr-machines.mjs");
  const { EventEmitter } = await import("node:events");
  const { existsSync } = await import("node:fs");
  const local = join(directory, ID.slice(0, 12));
  const forwards = [];
  let firstDone;
  const link = new MachineLink({ id: ID, label: "lab", target: "me@lab", session: "default" }, {
    directory,
    spawnProcess: () => {
      writeFileSync(`${local}.ctl`, "");
      return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() { setImmediate(() => this.emit("exit", null, "SIGTERM")); } });
    },
    run: async (command, args) => {
      if (!args.includes("forward")) return { stdout: "socket: /home/me/.config/herdr/herdr.sock\n" };
      const target = args[args.indexOf("-L") + 1].split(":")[0];
      forwards.push(target);
      writeFileSync(target, "");
      // The first forward is still finishing when the link is stopped.
      await new Promise((resolve) => { firstDone = resolve; });
      return { stdout: "" };
    },
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  link.start();
  const deadline = performance.now() + 10_000;
  while (!firstDone && performance.now() < deadline) {
    context.mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const stopping = link.stop();
  firstDone();
  await stopping;
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forwards, [`${local}.sock`], "no second forward");
  assert.equal(existsSync(`${local}.sock`), false);
  assert.equal(existsSync(`${local}-client.sock`), false);
  assert.notEqual(link.state, "ready");
});

test("a machine listing that fails leaves the list pending until one comes through", async () => {
  let fail = true;
  const machines = new HerdrMachines({
    directory: "/run/x", createBridge: () => ({}), log: () => {},
    createLink: (machine) => ({ machine, state: "connecting", error: null, start() {}, async stop() {} }),
    read: async () => { if (fail) throw new Error("herdr is restarting"); return []; },
  });
  await machines.refresh();
  assert.equal(machines.listed, false, "a failed listing is not a listing");
  fail = false;
  await machines.refresh();
  assert.equal(machines.listed, true);
});
