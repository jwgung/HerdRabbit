import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
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
        { id: "bad", target: "x" }]
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
  for (const target of ["-oProxyCommand=x", "me@lab extra", "me@", "", "a\nb", "x".repeat(201)]) assert.equal(validMachineTarget(target), false, target);
  assert.equal(validMachineLabel("Lab desk"), true);
  for (const label of ["", " padded", "a\nb", "x".repeat(61)]) assert.equal(validMachineLabel(label), false);
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
  assert.deepEqual(herdr.profiles(), [{ id: "machine-4c139ff50dfb", name: "lab", transport: "machine", machineId: ID, address: "me@lab" }]);
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
  const herdr = new HerdrMachines({ directory: "/run/x", read: async () => [], createLink: () => ({}), createBridge: () => ({}) });
  herdr.run = async (binary, args) => {
    calls.push(args);
    if (args[1] === "add" && args[2] === "new@host") {
      throw Object.assign(new Error("failed"), { stderr: "Host key verification failed.\r\nWelcome to lab (banner)" });
    }
    return { stdout: "" };
  };
  await herdr.add({ target: "me@lab", label: "Lab" });
  await herdr.rename(ID, "Desk");
  await herdr.disable(ID);
  await herdr.remove(ID);
  assert.deepEqual(calls, [
    ["machine", "add", "me@lab", "--label", "Lab"],
    ["machine", "rename", ID, "--label", "Desk"],
    ["machine", "disable", ID],
    ["machine", "remove", ID],
  ]);
  await assert.rejects(herdr.add({ target: "new@host", label: "" }), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /host key/);
    assert.doesNotMatch(error.message, /banner/, "the remote's own words are not passed on");
    return true;
  });
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
  assert.equal(herdr.fileClient("machine-4c139ff50dfb"), null, "files come in a later step");
  assert.ok(MachineClient.prototype.snapshot);
});
