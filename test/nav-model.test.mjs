import test from "node:test";
import assert from "node:assert/strict";
import { navigationModel, serverConnectionState } from "../public/ui-model.js";

const server = (id, fields = {}) => ({ id, name: id, available: true, status: "Connected", ...fields });
const session = (id, serverId, fields = {}) => ({ session_id: id, name: id, server_id: serverId, running: true, available: true, ...fields });
const workspace = (id, fields = {}) => ({ workspace_id: id, label: id, ...fields });
const tab = (id, workspaceId) => ({ tab_id: id, workspace_id: workspaceId });
const pane = (id, tabId) => ({ pane_id: id, tab_id: tabId });

function model(overrides = {}) {
  return navigationModel({
    servers: [], herdrSessions: [], workspaces: [], tabs: [], panes: [],
    statusOfPane: () => "idle",
    ...overrides,
  });
}
const kinds = (children) => children.map((child) => `${child.kind}:${child.id}`);

test("with no machine listed the projects stand alone, in order", () => {
  const next = model({
    herdrSessions: [session("s1", "local")],
    workspaces: [workspace("w1", { server_id: "local" }), workspace("w2", { server_id: "local" })],
  });
  assert.deepEqual(next.servers, []);
  assert.equal(next.showSessionGroups, false);
  assert.equal(next.empty, false);
  assert.deepEqual(kinds(next.children), ["workspace:w1", "workspace:w2"]);
});

test("a machine holds the projects of its own, and a project of an unlisted machine stays outside", () => {
  const next = model({
    servers: [server("local"), server("link_a")],
    herdrSessions: [session("s1", "local"), session("s2", "link_a")],
    workspaces: [
      workspace("w1", { server_id: "local" }),
      workspace("w2", { server_id: "link_a" }),
      workspace("w3", { server_id: "link_gone" }),
      workspace("w4"),
    ],
  });
  assert.deepEqual(next.servers.map((item) => item.id), ["local", "link_a"]);
  assert.deepEqual(kinds(next.servers[0].children), ["workspace:w1"]);
  assert.deepEqual(kinds(next.servers[1].children), ["workspace:w2"]);
  assert.deepEqual(kinds(next.children), ["workspace:w3", "workspace:w4"]);
});

test("session headings appear only when a machine has more than one, or one is not running", () => {
  const one = model({ servers: [server("local")], herdrSessions: [session("s1", "local")] });
  assert.equal(one.showSessionGroups, false);
  const sameMachine = model({ servers: [server("local")], herdrSessions: [session("s1", "local"), session("s2", "local")] });
  assert.equal(sameMachine.showSessionGroups, true);
  const twoMachines = model({ servers: [server("local"), server("link_a")], herdrSessions: [session("s1", "local"), session("s2", "link_a")] });
  assert.equal(twoMachines.showSessionGroups, false, "one each is nothing to tell apart");
  const stopped = model({ servers: [server("local")], herdrSessions: [session("s1", "local", { running: false, available: false })] });
  assert.equal(stopped.showSessionGroups, true);
  const defaultMachine = model({ herdrSessions: [session("s1", undefined), session("s2", "local")] });
  assert.equal(defaultMachine.showSessionGroups, true, "a session with no machine counts as this one");
});

test("with session headings the projects go under their session, and the sessions under their machine", () => {
  const next = model({
    servers: [server("local")],
    herdrSessions: [session("s1", "local"), session("s2", "local"), session("s3", "link_gone")],
    workspaces: [
      workspace("w1", { herdr_session_id: "s1" }),
      workspace("w2", { herdrSessionId: "s2" }),
      workspace("w3", { herdr_session_id: "s1" }),
    ],
  });
  assert.equal(next.showSessionGroups, true);
  assert.deepEqual(kinds(next.servers[0].children), ["session:s1", "session:s2"]);
  assert.deepEqual(kinds(next.children), ["session:s3"], "a session of an unlisted machine stays outside");
  const [s1, s2] = next.servers[0].children;
  assert.deepEqual(s1.workspaces.map((item) => item.id), ["w1", "w3"]);
  assert.deepEqual(s2.workspaces.map((item) => item.id), ["w2"]);
  assert.equal(next.empty, false);
});

test("a session says whether it is running, failed to connect, or stopped, and what an empty one shows", () => {
  const next = model({
    herdrSessions: [
      session("up", "local"),
      session("failed", "local", { available: false, running: true }),
      session("down", "local", { available: false, running: false }),
    ],
  });
  const [up, failed, down] = next.children;
  assert.deepEqual([up.status, up.tone, up.emptyText], ["Running", "online", "No open projects"]);
  assert.deepEqual([failed.status, failed.tone, failed.emptyText], ["Connection failed", "error", "Connection failed"]);
  assert.deepEqual([down.status, down.tone, down.emptyText], ["Stopped", "stopped", "Stopped"]);
});

test("nothing open is empty only when there are no session headings to show instead", () => {
  assert.equal(model({ servers: [server("local")], herdrSessions: [session("s1", "local")] }).empty, true);
  assert.equal(model().empty, true);
  assert.equal(model({ herdrSessions: [session("s1", "local", { available: false, running: false })] }).empty, false);
  assert.equal(model({ herdrSessions: [session("s1", "local"), session("s2", "local")] }).empty, false);
});

test("this machine gets its row even when it is the only one", () => {
  const next = model({ servers: [server("local")], herdrSessions: [session("s1", "local")] });
  assert.deepEqual(next.servers.map((item) => item.id), ["local"]);
  assert.equal(next.servers[0].role, "host");
});

test("a machine says what it is and why it is empty", () => {
  const next = model({
    servers: [
      server("local"),
      server("link_ok"),
      server("link_connecting", { available: false, status: "Connecting" }),
      server("link_down", { available: false, status: "Unreachable" }),
    ],
    herdrSessions: [session("s1", "local")],
  });
  const byId = Object.fromEntries(next.servers.map((item) => [item.id, item]));
  assert.equal(byId.local.role, "host");
  assert.equal(byId.local.emptyText, null);
  assert.equal(byId.link_ok.role, null);
  assert.equal(byId.link_ok.emptyText, "No Herdr sessions. Start Herdr on this server.");
  assert.equal(byId.link_connecting.role, "connecting");
  assert.equal(byId.link_connecting.emptyText, "Connecting");
  assert.equal(byId.link_down.role, "offline");
  assert.equal(byId.link_down.emptyText, "Unreachable");
});

test("a machine carries its connection as the page sees it", () => {
  const down = { kind: "error", text: "Lost the server" };
  const next = model({ servers: [server("local"), server("link_a")], pageConnection: down });
  assert.deepEqual(next.servers[0].connection, { online: false, error: true, text: "Lost the server" });
  assert.deepEqual(next.servers[1].connection, { online: true, error: false, text: "Connected" });
});

test("sessions and tabs and panes are grouped under their project, by either spelling of the ids", () => {
  const next = model({
    herdrSessions: [session("s1", "local")],
    workspaces: [workspace("w1"), workspace("w2")],
    tabs: [tab("t1", "w1"), { id: "t2", workspaceId: "w1" }, tab("t3", "w2")],
    panes: [pane("p1", "t1"), { id: "p2", tabId: "t1" }, pane("p3", "t2"), pane("p4", "t3"), pane("p5", "t9")],
  });
  const [w1, w2] = next.children;
  assert.deepEqual(w1.tabs.map((item) => item.id), ["t1", "t2"]);
  assert.deepEqual(w1.tabs[0].panes.map((item) => item.pane_id ?? item.id), ["p1", "p2"]);
  assert.deepEqual(w1.tabs[1].panes.map((item) => item.pane_id), ["p3"]);
  assert.deepEqual(w2.tabs.map((item) => item.id), ["t3"]);
  assert.equal(w1.record.workspace_id, "w1");
});

test("a project shows a mark for a finished pane and for one waiting on an answer", () => {
  const status = { p1: "idle", p2: "done", p3: "blocked", p4: "working" };
  const base = {
    herdrSessions: [session("s1", "local")],
    workspaces: [workspace("w1"), workspace("w2"), workspace("w3")],
    tabs: [tab("t1", "w1"), tab("t2", "w2"), tab("t3", "w3")],
    panes: [pane("p1", "t1"), pane("p2", "t1"), pane("p3", "t2"), pane("p4", "t3")],
    statusOfPane: (paneId) => status[paneId],
  };
  const [w1, w2, w3] = model(base).children;
  assert.deepEqual([w1.hasCompletion, w1.hasRequest], [true, false]);
  assert.deepEqual([w2.hasCompletion, w2.hasRequest], [false, true]);
  assert.deepEqual([w3.hasCompletion, w3.hasRequest], [false, false]);
});

test("the status of a pane is asked with its id and its record", () => {
  const asked = [];
  const record = pane("p1", "t1");
  model({
    herdrSessions: [session("s1", "local")],
    workspaces: [workspace("w1")], tabs: [tab("t1", "w1")], panes: [record],
    statusOfPane: (...args) => { asked.push(args); return "idle"; },
  });
  assert.ok(asked.length > 0);
  assert.deepEqual(asked[0], ["p1", record]);
});

test("building the model does not change what it was given", () => {
  const input = {
    servers: Object.freeze([Object.freeze(server("local"))]),
    herdrSessions: Object.freeze([Object.freeze(session("s1", "local"))]),
    workspaces: Object.freeze([Object.freeze(workspace("w1", { server_id: "local" }))]),
    tabs: Object.freeze([Object.freeze(tab("t1", "w1"))]),
    panes: Object.freeze([Object.freeze(pane("p1", "t1"))]),
  };
  assert.doesNotThrow(() => model(input));
});

test("this machine shows the page's own trouble, any other shows what it reports", () => {
  const trouble = { kind: "error", text: "Could not reach the server" };
  const fine = { kind: "online", text: "Connected" };
  assert.deepEqual(serverConnectionState(server("local"), trouble), { online: false, error: true, text: "Could not reach the server" });
  assert.deepEqual(serverConnectionState(server("local"), fine), { online: true, error: false, text: "Connected" });
  assert.deepEqual(serverConnectionState(server("link_a"), trouble), { online: true, error: false, text: "Connected" });
  assert.deepEqual(serverConnectionState(server("link_a", { available: false, status: "Offline" }), fine), { online: false, error: false, text: "Offline" });
  assert.deepEqual(serverConnectionState(server("local"), undefined), { online: true, error: false, text: "Connected" });
});
