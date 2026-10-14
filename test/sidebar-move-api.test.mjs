import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient, HerdrCommandError, InputValidationError } from "../src/herdr-client.mjs";
import { HerdrBridgeClient, sessionIds } from "../src/herdr-bridge-client.mjs";
import { HerdrMachines } from "../src/herdr-machines.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";

// A Herdr socket that answers each JSON line with `answer(request)`.
async function fakeHerdrSocket(context, answer) {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-move-"));
  const socketPath = join(directory, "herdr.sock");
  const requests = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 1);
        requests.push({ method: request.method, params: request.params });
        socket.write(`${JSON.stringify({ id: request.id, ...answer(request) })}\n`);
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  context.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, requests };
}

function recordingRunner(responses) {
  const calls = [];
  const runner = async (binary, args) => {
    calls.push(args);
    const response = typeof responses === "function" ? responses(args) : responses.shift();
    if (response instanceof Error) throw response;
    return { stdout: typeof response === "string" ? response : JSON.stringify(response), stderr: "" };
  };
  return { calls, runner };
}

const sessionList = (socketPath, name = "default") => ({ sessions: [{ name, default: name === "default", running: true, socket_path: socketPath }] });

test("tab.move and workspace.move go to the session's socket, as Herdr's CLI has no command for them", async (context) => {
  const herdrSocket = await fakeHerdrSocket(context, (request) => ({ result: { type: request.method === "tab.move" ? "tab_list" : "workspace_list" } }));
  const fake = recordingRunner(() => sessionList(herdrSocket.socketPath, "review"));
  const client = new HerdrClient({ runner: fake.runner, sessionName: "review" });

  assert.deepEqual(await client.moveTab("w1:t3", 0), { type: "tab_list" });
  assert.deepEqual(await client.moveWorkspace("w2", 2), { type: "workspace_list" });
  assert.deepEqual(herdrSocket.requests, [
    { method: "tab.move", params: { tab_id: "w1:t3", insert_index: 0 } },
    { method: "workspace.move", params: { workspace_id: "w2", insert_index: 2 } },
  ]);
  assert.deepEqual(fake.calls[0], ["--session=review", "session", "list", "--json"]);
});

test("a machine's client moves over its forwarded socket without asking for the session list", async (context) => {
  const herdrSocket = await fakeHerdrSocket(context, () => ({ result: { type: "tab_list" } }));
  const fake = recordingRunner([]);
  const client = new HerdrClient({ runner: fake.runner, socketPath: herdrSocket.socketPath, sessionName: "default" });
  await client.moveTab("w1:t1", 1);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(herdrSocket.requests, [{ method: "tab.move", params: { tab_id: "w1:t1", insert_index: 1 } }]);
});

test("Herdr's refusal comes back with its own code and words", async (context) => {
  const herdrSocket = await fakeHerdrSocket(context, () => ({ error: { code: "tab_move_failed", message: "insert_index 9 is out of bounds" } }));
  const client = new HerdrClient({ runner: recordingRunner(() => sessionList(herdrSocket.socketPath)).runner });
  await assert.rejects(client.moveTab("w1:t1", 9), (error) =>
    error instanceof HerdrCommandError && error.code === "tab_move_failed" && error.message === "insert_index 9 is out of bounds");
});

test("a bad position or id is refused before Herdr is asked", async () => {
  const fake = recordingRunner([]);
  const client = new HerdrClient({ runner: fake.runner });
  for (const index of [-1, 1.5, "1", null, undefined, 10_001]) {
    await assert.rejects(client.moveTab("w1:t1", index), InputValidationError, String(index));
    await assert.rejects(client.moveWorkspace("w1", index), InputValidationError, String(index));
  }
  await assert.rejects(client.moveTab("--help", 0), InputValidationError);
  await assert.rejects(client.moveWorkspace("w1:t1", 0), InputValidationError);
  await assert.rejects(client.moveTabToWorkspace("w1:t1", "w2;x", 0), InputValidationError);
  assert.deepEqual(fake.calls, []);
});

function moveResult({ from, to, tabId, created = false, label = null }) {
  return {
    id: "cli:pane:move",
    result: {
      type: "pane_move",
      move_result: {
        changed: true, previous_pane_id: from, focused_pane_id: to,
        pane: { pane_id: to, tab_id: tabId, workspace_id: to.split(":")[0] },
        ...(created ? { created_tab: { tab_id: tabId, label: label ?? "3", number: 3 } } : {}),
      },
    },
  };
}

const twoProjects = {
  workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "1" },
    { tab_id: "w1:t2", workspace_id: "w1", label: "Release" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "1" },
    { tab_id: "w2:t2", workspace_id: "w2", label: "2" },
  ],
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
    { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
    { pane_id: "w1:p5", tab_id: "w1:t2", workspace_id: "w1" },
    { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
    { pane_id: "w2:p2", tab_id: "w2:t2", workspace_id: "w2" },
  ],
};

test("a session with two panes moves to another project as one tab, keeps its name and lands where it was dropped", async (context) => {
  const herdrSocket = await fakeHerdrSocket(context, () => ({ result: { type: "tab_list" } }));
  const fake = recordingRunner((args) => {
    if (args[0] === "api") return { result: { snapshot: twoProjects } };
    if (args[0] === "session") return sessionList(herdrSocket.socketPath);
    if (args[2] === "w1:p2") return moveResult({ from: "w1:p2", to: "w2:p3", tabId: "w2:t3", created: true, label: "Release" });
    if (args[2] === "w1:p5") return moveResult({ from: "w1:p5", to: "w2:p4", tabId: "w2:t3" });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const client = new HerdrClient({ runner: fake.runner });

  const moved = await client.moveTabToWorkspace("w1:t2", "w2", 1);
  assert.deepEqual(moved, { tab_id: "w2:t3", panes: [{ from: "w1:p2", to: "w2:p3" }, { from: "w1:p5", to: "w2:p4" }] });
  assert.deepEqual(fake.calls.filter((args) => args[0] === "pane"), [
    ["pane", "move", "w1:p2", "--new-tab", "--workspace", "w2", "--label=Release", "--no-focus"],
    ["pane", "move", "w1:p5", "--tab", "w2:t3", "--split", "right", "--target-pane", "w2:p3", "--no-focus"],
  ]);
  // The new tab opened at the end, after w2's two; it goes to gap 1.
  assert.deepEqual(herdrSocket.requests, [{ method: "tab.move", params: { tab_id: "w2:t3", insert_index: 1 } }]);
});

test("an unnamed session keeps Herdr's numbering, and one dropped last needs no reordering", async () => {
  const fake = recordingRunner((args) => {
    if (args[0] === "api") return { result: { snapshot: twoProjects } };
    if (args[2] === "w1:p1") return moveResult({ from: "w1:p1", to: "w2:p3", tabId: "w2:t3", created: true });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const client = new HerdrClient({ runner: fake.runner });
  assert.deepEqual(await client.moveTabToWorkspace("w1:t1", "w2", 2), { tab_id: "w2:t3", panes: [{ from: "w1:p1", to: "w2:p3" }] });
  assert.deepEqual(fake.calls.slice(1), [["pane", "move", "w1:p1", "--new-tab", "--workspace", "w2", "--no-focus"]]);
});

test("moving to the project a session is already in only reorders it", async (context) => {
  const herdrSocket = await fakeHerdrSocket(context, () => ({ result: { type: "tab_list" } }));
  const fake = recordingRunner((args) => (args[0] === "api" ? { result: { snapshot: twoProjects } } : sessionList(herdrSocket.socketPath)));
  const client = new HerdrClient({ runner: fake.runner });
  assert.deepEqual(await client.moveTabToWorkspace("w1:t2", "w1", 0), { tab_id: "w1:t2", panes: [] });
  assert.equal(fake.calls.some((args) => args[0] === "pane"), false);
  assert.deepEqual(herdrSocket.requests, [{ method: "tab.move", params: { tab_id: "w1:t2", insert_index: 0 } }]);
});

test("a gone session or project is reported, not guessed at", async () => {
  const fake = recordingRunner(() => ({ result: { snapshot: twoProjects } }));
  const client = new HerdrClient({ runner: fake.runner });
  await assert.rejects(client.moveTabToWorkspace("w1:t9", "w2", 0), { code: "tab_not_found" });
  await assert.rejects(client.moveTabToWorkspace("w1:t1", "w9", 0), { code: "workspace_not_found" });
  assert.equal(fake.calls.some((args) => args[0] === "pane"), false);
});

test("the bridge moves within one Herdr session and gives the new ids back scoped", async () => {
  const fake = recordingRunner((args) => {
    if (args.includes("snapshot")) return { result: { snapshot: twoProjects } };
    if (args.includes("w1:p1")) return moveResult({ from: "w1:p1", to: "w2:p3", tabId: "w2:t3", created: true });
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const bridge = new HerdrBridgeClient({ runner: fake.runner });
  const scope = sessionIds.sessionIdForName("default");
  assert.deepEqual(await bridge.moveTabToWorkspace(`${scope}~w1:t1`, `${scope}~w2`, 2), {
    tab_id: `${scope}~w2:t3`, panes: [{ from: `${scope}~w1:p1`, to: `${scope}~w2:p3` }],
  });
  assert.deepEqual(fake.calls.at(-1), ["--session=default", "pane", "move", "w1:p1", "--new-tab", "--workspace", "w2", "--no-focus"]);
  const other = sessionIds.sessionIdForName("review");
  const before = fake.calls.length;
  await assert.rejects(bridge.moveTabToWorkspace(`${scope}~w1:t2`, `${other}~w2`, 1), InputValidationError);
  assert.equal(fake.calls.length, before);
});

function fakeLink(machine) {
  return { machine, state: "ready", error: null, socketPath: "/run/x.sock", start() {}, async stop() {} };
}

test("a session does not cross machines, and a machine's move comes back with its server prefix", async () => {
  const ID = "4c139ff50dfb4a0dcda27e728dc50ef9";
  const remoteCalls = [];
  const machines = new HerdrMachines({
    directory: "/run/x", createLink: fakeLink,
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }],
    createBridge: () => ({
      snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }),
      moveTab: async (...args) => { remoteCalls.push(["moveTab", ...args]); },
      moveWorkspace: async (...args) => { remoteCalls.push(["moveWorkspace", ...args]); },
      moveTabToWorkspace: async (...args) => {
        remoteCalls.push(["moveTabToWorkspace", ...args]);
        return { tab_id: "hs_x~w2:t3", panes: [{ from: "hs_x~w1:p2", to: "hs_x~w2:p3" }] };
      },
    }),
  });
  await machines.refresh();
  const localCalls = [];
  const local = {
    snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }),
    moveTab: async (...args) => { localCalls.push(["moveTab", ...args]); },
    moveTabToWorkspace: async (...args) => {
      localCalls.push(["moveTabToWorkspace", ...args]);
      return { tab_id: "hs_x~w2:t3", panes: [] };
    },
  };
  const herdr = new MultiServerClient({ local, machines });
  const server = "machine-4c139ff50dfb";

  await assert.rejects(herdr.moveTabToWorkspace("hs_x~w1:t2", `${server}!hs_x~w2`, 0), InputValidationError);
  await assert.rejects(herdr.moveTabToWorkspace(`${server}!hs_x~w1:t2`, "hs_x~w2", 0), InputValidationError);
  assert.deepEqual([localCalls, remoteCalls], [[], []]);

  assert.deepEqual(await herdr.moveTabToWorkspace(`${server}!hs_x~w1:t2`, `${server}!hs_x~w2`, 1), {
    tab_id: `${server}!hs_x~w2:t3`, panes: [{ from: `${server}!hs_x~w1:p2`, to: `${server}!hs_x~w2:p3` }],
  });
  await herdr.moveTab(`${server}!hs_x~w1:t2`, 0);
  await herdr.moveWorkspace(`${server}!hs_x~w2`, 3);
  assert.deepEqual(await herdr.moveTabToWorkspace("hs_x~w1:t2", "hs_x~w2", 0), { tab_id: "hs_x~w2:t3", panes: [] });
  assert.deepEqual(remoteCalls, [
    ["moveTabToWorkspace", "hs_x~w1:t2", "hs_x~w2", 1],
    ["moveTab", "hs_x~w1:t2", 0],
    ["moveWorkspace", "hs_x~w2", 3],
  ]);
  assert.deepEqual(localCalls, [["moveTabToWorkspace", "hs_x~w1:t2", "hs_x~w2", 0]]);
});

async function startServer(context, herdr) {
  const { server } = createHerdrHttpServer({ herdr, csrfToken: "fixed-test-token", logger: { error() {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("the move routes need the write token and pass the drop on to Herdr", async (context) => {
  const calls = [];
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [] }; },
    async moveTab(...args) { calls.push(["moveTab", ...args]); },
    async moveWorkspace(...args) { calls.push(["moveWorkspace", ...args]); },
    async moveTabToWorkspace(...args) {
      calls.push(["moveTabToWorkspace", ...args]);
      return { tab_id: "hs_x~w2:t3", panes: [{ from: "hs_x~w1:p2", to: "hs_x~w2:p3" }] };
    },
  };
  const baseUrl = await startServer(context, herdr);
  const post = (path, body, headers = {}) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, "X-Herdr-CSRF": "fixed-test-token", ...headers },
    body: JSON.stringify(body),
  });

  for (const path of ["/api/tabs/hs_x~w1%3At2/move", "/api/workspaces/hs_x~w1/move"]) {
    const rejected = await post(path, { insertIndex: 0 }, { "X-Herdr-CSRF": "wrong" });
    assert.equal(rejected.status, 403, path);
    const foreign = await post(path, { insertIndex: 0 }, { Origin: "https://evil.example" });
    assert.equal(foreign.status, 403, path);
  }
  assert.deepEqual(calls, []);

  const within = await post("/api/tabs/hs_x~w1%3At2/move", { insertIndex: 0 });
  assert.equal(within.status, 200);
  assert.deepEqual((await within.json()).moved, { tab_id: "hs_x~w1:t2", panes: [] });
  const across = await post("/api/tabs/hs_x~w1%3At2/move", { workspaceId: "hs_x~w2", insertIndex: 1 });
  assert.equal(across.status, 200);
  const acrossBody = await across.json();
  assert.deepEqual(acrossBody.moved.panes, [{ from: "hs_x~w1:p2", to: "hs_x~w2:p3" }]);
  assert.ok(acrossBody.snapshot, "the page gets the snapshot after the move");
  const project = await post("/api/workspaces/hs_x~w2/move", { insertIndex: 0 });
  assert.equal(project.status, 200);
  const badWorkspace = await post("/api/tabs/hs_x~w1%3At2/move", { workspaceId: 7, insertIndex: 1 });
  assert.equal(badWorkspace.status, 400);
  assert.deepEqual(calls, [
    ["moveTab", "hs_x~w1:t2", 0],
    ["moveTabToWorkspace", "hs_x~w1:t2", "hs_x~w2", 1],
    ["moveWorkspace", "hs_x~w2", 0],
  ]);
});

test("a bad position through the real clients is a 400 and reaches no Herdr command", async (context) => {
  const fake = recordingRunner(() => ({ sessions: [] }));
  const baseUrl = await startServer(context, new MultiServerClient({ local: new HerdrBridgeClient({ runner: fake.runner }) }));
  const scope = sessionIds.sessionIdForName("default");
  const post = (path, body) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, "X-Herdr-CSRF": "fixed-test-token" },
    body: JSON.stringify(body),
  });
  for (const [path, body] of [
    [`/api/tabs/${scope}~w1%3At2/move`, { insertIndex: -1 }],
    [`/api/tabs/${scope}~w1%3At2/move`, { insertIndex: "2" }],
    [`/api/tabs/${scope}~w1%3At2/move`, {}],
    [`/api/tabs/${scope}~w1%3At2/move`, { workspaceId: `${scope}~w2`, insertIndex: 0.5 }],
    [`/api/tabs/${scope}~--help/move`, { insertIndex: 0 }],
    [`/api/workspaces/${scope}~w1/move`, { insertIndex: 99_999 }],
    [`/api/workspaces/${scope}~w1%3At1/move`, { insertIndex: 0 }],
  ]) {
    const response = await post(path, body);
    assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(fake.calls.filter((args) => args[0] !== "session" && !(args[0] === "api")), []);
});
