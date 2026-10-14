import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient, HerdrCommandError, InputValidationError, findScrollOffset } from "../src/herdr-client.mjs";
import { HerdrBridgeClient, sessionIds } from "../src/herdr-bridge-client.mjs";
import { HerdrMachines } from "../src/herdr-machines.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import {
  createTerminalFind, currentMatchCell, findCountText, findOccurrences, findRequestBody, isFindShortcut,
} from "../public/terminal-find.js";

// A Herdr socket that answers each JSON line with `answer(request)`.
async function fakeHerdrSocket(context, answer) {
  const directory = await mkdtemp(join(tmpdir(), "herdrabbit-find-"));
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

// The pane herdr's way, measured on herdr 0.9.3: 208 history rows, a 40-row
// view at the bottom, "needle" twice on rows 53, 104, 155 and 206.
function herdrPane({ offset = 0, revision = 382, staleGuard = false } = {}) {
  let scroll = { offset_from_bottom: offset, max_offset_from_bottom: 168, viewport_rows: 40 };
  const matches = [53, 104, 155, 206].flatMap((row) => [
    { start: { row, col: 0 }, end: { row, col: 5 } },
    { start: { row, col: 7 }, end: { row, col: 12 } },
  ]);
  return (request) => {
    const { method, params } = request;
    if (method === "pane.get") return { result: { type: "pane_info", pane: { pane_id: params.pane_id, scroll } } };
    if (method === "pane.copy_motion") {
      if (params.content_revision !== undefined && (staleGuard || params.content_revision !== revision)) {
        return { error: { code: "stale_content", message: "pane content changed" } };
      }
      return { result: { type: "pane_copy_motion", pane_id: params.pane_id, cursor: { row: params.cursor.row, col: 20 }, content_revision: revision } };
    }
    if (method === "pane.copy_search") {
      if (params.content_revision !== revision) return { error: { code: "stale_content", message: "pane content changed" } };
      const found = params.query === "zzz" ? [] : matches;
      const before = (point) => point.row < params.cursor.row || (point.row === params.cursor.row && point.col < params.cursor.col);
      let current = null;
      if (found.length) {
        if (params.direction === "backward") {
          const index = found.findLastIndex((match) => before(match.start));
          current = index < 0 ? found.length - 1 : index;
        } else {
          const index = found.findIndex((match) => !before(match.start) && !(params.previous && match.start.row === params.previous.start.row && match.start.col === params.previous.start.col));
          current = index < 0 ? 0 : index;
        }
      }
      return { result: { type: "pane_copy_search", pane_id: params.pane_id, content_revision: revision, matches: found, total: found.length, current, current_global: current } };
    }
    if (method === "pane.scroll") {
      scroll = { ...scroll, offset_from_bottom: params.offset_from_bottom };
      return { result: { type: "pane_info", pane: { pane_id: params.pane_id, scroll } } };
    }
    return { error: { code: "unknown_method", message: method } };
  };
}

const socketClient = (socketPath) => new HerdrClient({
  socketPath, sessionName: "default", runner: async () => { throw new Error("no CLI call expected"); },
});

test("a first find starts at the bottom of the view and moves nothing", async (context) => {
  const herdr = await fakeHerdrSocket(context, herdrPane());
  const answer = await socketClient(herdr.socketPath).paneFind("w1:p1", { query: "needle", direction: "backward" });
  assert.deepEqual(herdr.requests.map((request) => request.method), ["pane.get", "pane.copy_motion", "pane.copy_search"]);
  // The view's rows are 168..207; the search starts at the end of its last row.
  assert.deepEqual(herdr.requests[1].params, { pane_id: "w1:p1", cursor: { row: 207, col: 0 }, motion: "line_end" });
  assert.deepEqual(herdr.requests[2].params, {
    pane_id: "w1:p1", query: "needle", direction: "backward", cursor: { row: 207, col: 20 }, content_revision: 382,
  });
  assert.equal(answer.total, 8);
  assert.equal(answer.current, 8);
  assert.deepEqual(answer.match, { start: { row: 206, col: 7 }, end: { row: 206, col: 12 } });
  assert.equal(answer.content_revision, 382);
  assert.equal(answer.matches.length, 8);
  assert.deepEqual(answer.scroll, { offset_from_bottom: 0, max_offset_from_bottom: 168, viewport_rows: 40 });
});

test("stepping past the last match finds it without scrolling the shared view", async (context) => {
  const herdr = await fakeHerdrSocket(context, herdrPane());
  const client = socketClient(herdr.socketPath);
  const previous = { start: { row: 206, col: 0 }, end: { row: 206, col: 5 } };
  const answer = await client.paneFind("w1:p1", { query: "needle", direction: "backward", previous, contentRevision: 382 });
  const search = herdr.requests.find((request) => request.method === "pane.copy_search");
  assert.deepEqual(search.params, {
    pane_id: "w1:p1", query: "needle", direction: "backward", cursor: previous.start, content_revision: 382, previous,
  });
  assert.deepEqual(answer.match, { start: { row: 155, col: 7 }, end: { row: 155, col: 12 } });
  assert.equal(answer.current, 6);
  assert.equal(herdr.requests.some((request) => request.method === "pane.scroll"), false);
  assert.deepEqual(answer.scroll, { offset_from_bottom: 0, max_offset_from_bottom: 168, viewport_rows: 40 });
});

test("a reveal scrolls the shared view so the match sits a third of the way down, after the history guard", async (context) => {
  const herdr = await fakeHerdrSocket(context, herdrPane());
  const match = { start: { row: 155, col: 7 }, end: { row: 155, col: 12 } };
  const answer = await socketClient(herdr.socketPath).paneReveal("w1:p1", { match, contentRevision: 382 });
  assert.deepEqual(herdr.requests, [
    { method: "pane.get", params: { pane_id: "w1:p1" } },
    { method: "pane.copy_motion", params: { pane_id: "w1:p1", cursor: { row: 155, col: 7 }, motion: "line_end", content_revision: 382 } },
    // 168 - (155 - floor(40 / 3)) = 26
    { method: "pane.scroll", params: { pane_id: "w1:p1", offset_from_bottom: 26 } },
  ]);
  assert.deepEqual(answer, { scroll: { offset_from_bottom: 26, max_offset_from_bottom: 168, viewport_rows: 40 } });
});

test("a reveal leaves a match already on screen where it is", async (context) => {
  const herdr = await fakeHerdrSocket(context, herdrPane());
  const match = { start: { row: 206, col: 7 }, end: { row: 206, col: 12 } };
  const answer = await socketClient(herdr.socketPath).paneReveal("w1:p1", { match, contentRevision: 382 });
  assert.deepEqual(herdr.requests.map((request) => request.method), ["pane.get", "pane.copy_motion"], "checked, not scrolled");
  assert.deepEqual(answer, { scroll: { offset_from_bottom: 0, max_offset_from_bottom: 168, viewport_rows: 40 } });
});

test("a match already on screen whose history changed is stale_content too", async (context) => {
  const herdr = await fakeHerdrSocket(context, herdrPane({ revision: 400 }));
  const match = { start: { row: 206, col: 7 }, end: { row: 206, col: 12 } };
  await assert.rejects(socketClient(herdr.socketPath).paneReveal("w1:p1", { match, contentRevision: 382 }), { code: "stale_content" });
  assert.equal(herdr.requests.some((request) => request.method === "pane.scroll"), false);
});

test("a reveal of a history that changed is stale_content, and the view is not moved", async (context) => {
  const match = { start: { row: 155, col: 7 }, end: { row: 155, col: 12 } };
  const herdr = await fakeHerdrSocket(context, herdrPane({ revision: 400 }));
  await assert.rejects(socketClient(herdr.socketPath).paneReveal("w1:p1", { match, contentRevision: 382 }), { code: "stale_content" });
  assert.equal(herdr.requests.some((request) => request.method === "pane.scroll"), false);
  const guarded = await fakeHerdrSocket(context, herdrPane({ staleGuard: true }));
  await assert.rejects(socketClient(guarded.socketPath).paneReveal("w1:p1", { match, contentRevision: 382 }), { code: "stale_content" });
  assert.equal(guarded.requests.some((request) => request.method === "pane.scroll"), false);
});

test("a stale step is refused by a find too, and nothing is scrolled", async (context) => {
  const herdr = await fakeHerdrSocket(context, herdrPane({ revision: 400 }));
  const previous = { start: { row: 206, col: 0 }, end: { row: 206, col: 5 } };
  await assert.rejects(socketClient(herdr.socketPath).paneFind("w1:p1", { query: "needle", direction: "forward", previous, contentRevision: 382 }),
    { code: "stale_content" });
  assert.deepEqual(herdr.requests.map((request) => request.method), ["pane.get", "pane.copy_motion"]);
});

test("a bad reveal is refused before herdr is asked", async () => {
  const calls = [];
  const client = new HerdrClient({ runner: async (...args) => { calls.push(args); return { stdout: "{}" }; } });
  const point = { row: 1, col: 2 };
  for (const [paneId, request] of [
    ["--help", { match: { start: point, end: point }, contentRevision: 1 }],
    ["w1:p1", {}],
    ["w1:p1", { match: null, contentRevision: 1 }],
    ["w1:p1", { match: { start: point }, contentRevision: 1 }],
    ["w1:p1", { match: { start: point, end: { row: -1, col: 0 } }, contentRevision: 1 }],
    ["w1:p1", { match: { start: point, end: { row: 1, col: 70_000 } }, contentRevision: 1 }],
    ["w1:p1", { match: { start: point, end: point } }],
    ["w1:p1", { match: { start: point, end: point }, contentRevision: 1.5 }],
    ["w1:p1", { match: { start: point, end: point }, contentRevision: "1" }],
  ]) {
    await assert.rejects(client.paneReveal(paneId, request), InputValidationError, JSON.stringify(request).slice(0, 60));
  }
  assert.deepEqual(calls, []);
});

test("no match answers with no current and leaves the view alone", async (context) => {
  const herdr = await fakeHerdrSocket(context, herdrPane({ offset: 26 }));
  const answer = await socketClient(herdr.socketPath).paneFind("w1:p1", { query: "zzz", direction: "forward" });
  assert.deepEqual({ total: answer.total, current: answer.current, match: answer.match }, { total: 0, current: null, match: null });
  // A forward find starts at the top of the view: row 168 - 26.
  assert.deepEqual(herdr.requests.find((request) => request.method === "pane.copy_search").params.cursor, { row: 142, col: 0 });
  assert.equal(herdr.requests.some((request) => request.method === "pane.scroll"), false);
});

test("an answer herdr should not give is refused, not passed on", async (context) => {
  const herdr = await fakeHerdrSocket(context, (request) => {
    if (request.method === "pane.get") return { result: { pane: { scroll: null } } };
    if (request.method === "pane.copy_motion") return { result: { cursor: { row: 0, col: 3 }, content_revision: 1 } };
    return { result: { matches: [{ start: { row: -1, col: 0 }, end: "x" }], total: 1, current: 0 } };
  });
  await assert.rejects(socketClient(herdr.socketPath).paneFind("w1:p1", { query: "x", direction: "forward" }),
    { code: "invalid_herdr_response" });
});

test("a bad find is refused before herdr is asked", async () => {
  const calls = [];
  const client = new HerdrClient({ runner: async (...args) => { calls.push(args); return { stdout: "{}" }; } });
  const point = { row: 1, col: 2 };
  for (const [paneId, request] of [
    ["--help", { query: "x", direction: "forward" }],
    ["w1:p1", { query: "", direction: "forward" }],
    ["w1:p1", { query: "x".repeat(257), direction: "forward" }],
    ["w1:p1", { query: "a\nb", direction: "forward" }],
    ["w1:p1", { query: "a\u001b[2J", direction: "forward" }],
    ["w1:p1", { query: 7, direction: "forward" }],
    ["w1:p1", { query: "x", direction: "up" }],
    ["w1:p1", { query: "x", direction: "forward", previous: { start: point }, contentRevision: 1 }],
    ["w1:p1", { query: "x", direction: "forward", previous: { start: point, end: { row: -1, col: 0 } }, contentRevision: 1 }],
    ["w1:p1", { query: "x", direction: "forward", previous: { start: point, end: { row: 1, col: 70_000 } }, contentRevision: 1 }],
    ["w1:p1", { query: "x", direction: "forward", previous: { start: point, end: point } }],
    ["w1:p1", { query: "x", direction: "forward", contentRevision: 3 }],
  ]) {
    await assert.rejects(client.paneFind(paneId, request), InputValidationError, JSON.stringify(request).slice(0, 60));
  }
  assert.deepEqual(calls, []);
});

test("the view moves only as far as the history goes", () => {
  const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 168, viewport_rows: 40 };
  const at = (row) => ({ start: { row, col: 0 }, end: { row, col: 3 } });
  assert.equal(findScrollOffset(scroll, at(200)), 0, "on screen already");
  assert.equal(findScrollOffset(scroll, at(169)), 168 - (169 - 13), "on screen, but under the find bar");
  assert.equal(findScrollOffset({ ...scroll, offset_from_bottom: 168 }, at(1)), 168, "under the bar at the very top, as far as it goes");
  assert.equal(findScrollOffset(scroll, at(2)), 168, "the top of the history is as far as it goes");
  assert.equal(findScrollOffset(scroll, at(100)), 81);
  assert.equal(findScrollOffset({ ...scroll, offset_from_bottom: 168 }, at(10)), 168, "near the top, already showing");
  // A match wrapped onto the row below the view is brought in whole.
  assert.equal(findScrollOffset(scroll, { start: { row: 167, col: 110 }, end: { row: 168, col: 2 } }), 168 - (167 - 13));
});

test("a session's pane is found through its own session, and a machine's through its machine", async () => {
  const calls = [];
  const bridgeCalls = [];
  const bridge = new HerdrBridgeClient({ runner: async () => ({ stdout: "{}" }) });
  // The bridge hands the find to the client for the pane's session.
  const scope = sessionIds.sessionIdForName("default");
  const original = HerdrClient.prototype.paneFind;
  HerdrClient.prototype.paneFind = async function paneFind(paneId, request) {
    bridgeCalls.push([this.sessionName, paneId, request]);
    return { total: 0, current: null, match: null, matches: [], content_revision: 1, scroll: null };
  };
  const originalReveal = HerdrClient.prototype.paneReveal;
  const revealRequest = { match: { start: { row: 1, col: 0 }, end: { row: 1, col: 2 } }, contentRevision: 3 };
  HerdrClient.prototype.paneReveal = async function paneReveal(paneId, request) {
    bridgeCalls.push(["reveal", this.sessionName, paneId, request]);
    return { scroll: null };
  };
  try {
    await bridge.paneFind(`${scope}~w1:p2`, { query: "x", direction: "forward" });
    await assert.rejects(bridge.paneFind(`${sessionIds.sessionIdForName("review")}~w1:p2`, { query: "x", direction: "forward" }),
      InputValidationError, "a session that is not running");
    assert.deepEqual(await bridge.paneReveal(`${scope}~w1:p2`, revealRequest), { scroll: null });
    await assert.rejects(bridge.paneReveal(`${sessionIds.sessionIdForName("review")}~w1:p2`, revealRequest),
      InputValidationError, "a session that is not running");
  } finally {
    HerdrClient.prototype.paneFind = original;
    HerdrClient.prototype.paneReveal = originalReveal;
  }
  assert.deepEqual(bridgeCalls, [
    ["default", "w1:p2", { query: "x", direction: "forward" }],
    ["reveal", "default", "w1:p2", revealRequest],
  ]);

  const ID = "4c139ff50dfb4a0dcda27e728dc50ef9";
  const machines = new HerdrMachines({
    directory: "/run/x",
    createLink: (machine) => ({ machine, state: "ready", error: null, socketPath: "/run/x.sock", start() {}, async stop() {} }),
    read: async () => [{ id: ID, label: "lab", target: "me@lab", session: "default", enabled: true }],
    createBridge: () => ({
      snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }),
      paneFind: async (...args) => { calls.push(["remote", ...args]); return { total: 3, current: 1 }; },
      paneReveal: async (...args) => { calls.push(["remote reveal", ...args]); return { scroll: { remote: true } }; },
    }),
  });
  await machines.refresh();
  const herdr = new MultiServerClient({
    machines,
    local: {
      snapshot: async () => ({ herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }),
      paneFind: async (...args) => { calls.push(["local", ...args]); return { total: 1, current: 1 }; },
      paneReveal: async (...args) => { calls.push(["local reveal", ...args]); return { scroll: { remote: false } }; },
    },
  });
  const request = { query: "x", direction: "backward" };
  assert.deepEqual(await herdr.paneFind("machine-4c139ff50dfb!hs_x~w1:p2", request), { total: 3, current: 1 });
  assert.deepEqual(await herdr.paneFind("hs_x~w1:p2", request), { total: 1, current: 1 });
  assert.deepEqual(calls, [["remote", "hs_x~w1:p2", request], ["local", "hs_x~w1:p2", request]]);
  const reveal = { match: { start: { row: 1, col: 0 }, end: { row: 1, col: 2 } }, contentRevision: 3 };
  assert.deepEqual(await herdr.paneReveal("machine-4c139ff50dfb!hs_x~w1:p2", reveal), { scroll: { remote: true } });
  assert.deepEqual(await herdr.paneReveal("hs_x~w1:p2", reveal), { scroll: { remote: false } });
  assert.deepEqual(calls.slice(2), [["remote reveal", "hs_x~w1:p2", reveal], ["local reveal", "hs_x~w1:p2", reveal]]);
});

async function startServer(context, herdr) {
  const { server } = createHerdrHttpServer({ herdr, csrfToken: "fixed-test-token", logger: { error() {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("the find route needs the write token, checks what it is given and answers with herdr's find", async (context) => {
  const calls = [];
  let stale = false;
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [] }; },
    async paneFind(...args) {
      calls.push(args);
      if (stale) {
        throw new HerdrCommandError("The terminal changed while searching. Search again.", { code: "stale_content" });
      }
      return {
        total: 17, current: 3, match: { start: { row: 9, col: 1 }, end: { row: 9, col: 4 } }, matches: [],
        content_revision: 5, scroll: { offset_from_bottom: 4, max_offset_from_bottom: 30, viewport_rows: 20 },
      };
    },
  };
  const baseUrl = await startServer(context, herdr);
  const post = (body, headers = {}, path = "/api/panes/hs_x~w1%3Ap2/find") => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, "X-Herdr-CSRF": "fixed-test-token", ...headers },
    body: JSON.stringify(body),
  });

  assert.equal((await post({ query: "x", direction: "forward" }, { "X-Herdr-CSRF": "wrong" })).status, 403);
  assert.equal((await post({ query: "x", direction: "forward" }, { Origin: "https://evil.example" })).status, 403);
  const point = { row: 1, col: 1 };
  for (const body of [
    {}, { query: "", direction: "forward" }, { query: "x".repeat(257), direction: "forward" },
    { query: "a\tb", direction: "forward" }, { query: "x", direction: "sideways" },
    { query: "x", direction: "forward", previous: { start: point } , contentRevision: 1 },
    { query: "x", direction: "forward", previous: { start: point, end: point } },
    { query: "x", direction: "forward", contentRevision: 1 },
    { query: "x", direction: "forward", previous: { start: point, end: { row: 1.5, col: 0 } }, contentRevision: 1 },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);

  const previous = { start: { row: 9, col: 1 }, end: { row: 9, col: 4 }, extra: "dropped" };
  const response = await post({ query: "한글 x", direction: "backward", previous, contentRevision: 4 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual([body.total, body.current, body.content_revision], [17, 3, 5]);
  assert.deepEqual(body.scroll, { offset_from_bottom: 4, max_offset_from_bottom: 30, viewport_rows: 20 });
  assert.deepEqual(calls, [["hs_x~w1:p2", {
    query: "한글 x", direction: "backward",
    previous: { start: { row: 9, col: 1 }, end: { row: 9, col: 4 } }, contentRevision: 4,
  }]]);

  stale = true;
  const conflict = await post({ query: "x", direction: "forward" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "stale_content");
});

test("the reveal route needs the write token, checks what it is given and moves the view through herdr", async (context) => {
  const calls = [];
  let stale = false;
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [] }; },
    async paneReveal(...args) {
      calls.push(args);
      if (stale) throw new HerdrCommandError("The terminal changed while searching. Search again.", { code: "stale_content" });
      return { scroll: { offset_from_bottom: 4, max_offset_from_bottom: 30, viewport_rows: 20 } };
    },
  };
  const baseUrl = await startServer(context, herdr);
  const post = (body, headers = {}) => fetch(`${baseUrl}/api/panes/hs_x~w1%3Ap2/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, "X-Herdr-CSRF": "fixed-test-token", ...headers },
    body: JSON.stringify(body),
  });
  const match = { start: { row: 9, col: 1 }, end: { row: 9, col: 4 } };
  assert.equal((await post({ match, contentRevision: 4 }, { "X-Herdr-CSRF": "wrong" })).status, 403);
  assert.equal((await post({ match, contentRevision: 4 }, { Origin: "https://evil.example" })).status, 403);
  for (const body of [
    {}, { match }, { contentRevision: 4 }, { match: null, contentRevision: 4 },
    { match: { start: match.start }, contentRevision: 4 },
    { match: { start: match.start, end: { row: 1.5, col: 0 } }, contentRevision: 4 },
    { match, contentRevision: "4" }, { match, contentRevision: -1 },
  ]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);

  const response = await post({ match: { ...match, extra: "dropped" }, contentRevision: 4 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scroll: { offset_from_bottom: 4, max_offset_from_bottom: 30, viewport_rows: 20 } });
  assert.deepEqual(calls, [["hs_x~w1:p2", { match, contentRevision: 4 }]]);

  stale = true;
  const conflict = await post({ match, contentRevision: 4 });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "stale_content");
});

// Screen rows as xterm-terminal.js reads them; a Hangul syllable takes two cells.
function rowOf(text) {
  const cells = [];
  let x = 0;
  for (const char of text) {
    cells.push(x);
    x += /[ᄀ-ᇿ가-힣]/u.test(char) ? 2 : 1;
  }
  cells.push(x);
  return { text, cells };
}

test("the query is marked where it shows, in cells, in herdr's smart case", () => {
  const rows = ["needle Needle 50", "no match here", "한글 needle"].map(rowOf);
  assert.deepEqual(findOccurrences(rows, "needle"), [
    { row: 0, start: 0, end: 6, current: false },
    { row: 0, start: 7, end: 13, current: false },
    { row: 2, start: 5, end: 11, current: false },
  ]);
  assert.deepEqual(findOccurrences(rows, "Needle").map((found) => [found.row, found.start]), [[0, 7]], "a capital matches exactly");
  assert.deepEqual(findOccurrences(rows, "한글"), [{ row: 2, start: 0, end: 4, current: false }]);
  assert.deepEqual(findOccurrences(rows, "needle", { row: 0, col: 7 }).map((found) => found.current), [false, true, false]);
  assert.deepEqual(findOccurrences(rows, ""), []);
  assert.deepEqual(findOccurrences([rowOf("aaaa")], "aa").map((found) => found.start), [0, 2], "no overlaps");
  assert.deepEqual(findOccurrences([rowOf("İ NEEDLE")], "needle").map((found) => found.start), [2],
    "a letter whose lower case is longer does not unfold the rest of the row");
});

test("the current match's screen cell comes from herdr's view, and only when it is on screen", () => {
  const scroll = { offset_from_bottom: 26, max_offset_from_bottom: 168, viewport_rows: 40 };
  assert.deepEqual(currentMatchCell({ match: { start: { row: 155, col: 7 } }, scroll }), { row: 13, col: 7 });
  assert.equal(currentMatchCell({ match: { start: { row: 100, col: 0 } }, scroll }), null);
  assert.equal(currentMatchCell({ match: { start: { row: 182, col: 0 } }, scroll }), null);
  assert.equal(currentMatchCell({ match: null, scroll }), null);
  assert.equal(currentMatchCell({ match: { start: { row: 155, col: 7 } }, scroll: null }), null);
});

test("the count reads 3/17, and a step goes on from the last match of the same query", () => {
  assert.equal(findCountText({ result: { total: 17, current: 3 } }), "3/17");
  assert.equal(findCountText({ result: { total: 0, current: null } }), "No matches");
  assert.equal(findCountText({ busy: true }), "…");
  assert.equal(findCountText({ busy: true, result: { total: 17, current: 3 } }), "3/17");
  assert.equal(findCountText({ error: "boom" }), "Search failed");
  assert.equal(findCountText({}), "");

  const match = { start: { row: 1, col: 2 }, end: { row: 1, col: 4 } };
  const result = { query: "abc", match, content_revision: 9 };
  assert.deepEqual(findRequestBody("abc", result, "forward"), { query: "abc", direction: "forward", previous: match, contentRevision: 9 });
  assert.deepEqual(findRequestBody("abcd", result, "backward"), { query: "abcd", direction: "backward" });
  assert.deepEqual(findRequestBody("abc", { ...result, match: null }, "backward"), { query: "abc", direction: "backward" });
  assert.deepEqual(findRequestBody("abc", null, "backward"), { query: "abc", direction: "backward" });
});

test("Ctrl+F finds, and Cmd+F on a Mac, where Ctrl+F stays the terminal's", () => {
  const key = (options) => ({ key: "f", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...options });
  assert.equal(isFindShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(isFindShortcut(key({ ctrlKey: true, key: "F" }), false), true);
  assert.equal(isFindShortcut(key({ metaKey: true }), false), false);
  assert.equal(isFindShortcut(key({ metaKey: true }), true), true);
  assert.equal(isFindShortcut(key({ ctrlKey: true }), true), false);
  assert.equal(isFindShortcut(key({ ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(isFindShortcut(key({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(isFindShortcut(key({ ctrlKey: true, isComposing: true }), false), false);
  assert.equal(isFindShortcut(key({ ctrlKey: true, key: "g" }), false), false);
});

// The bar's elements, as far as terminal-find.js touches them.
class FakeElement extends EventTarget {
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  title = "";
  dataset = {};
  focused = false;
  focus() { this.focused = true; }
  select() {}
}

function keydown(target, key, options = {}) {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key, shiftKey: false, isComposing: false, keyCode: 0, ...options });
  target.dispatchEvent(event);
  return event;
}

function findBar({ answer }) {
  const elements = {
    form: new FakeElement(), input: new FakeElement(), count: new FakeElement(),
    olderButton: new FakeElement(), newerButton: new FakeElement(), closeButton: new FakeElement(),
  };
  const requests = [];
  const highlights = [];
  const timers = [];
  let closed = 0;
  const find = createTerminalFind({
    ...elements,
    search: async (paneId, body) => {
      requests.push([paneId, body]);
      return answer(body, requests.length);
    },
    onHighlight: (marks) => highlights.push(marks),
    onClose: () => { closed += 1; },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  const type = (text) => {
    elements.input.value = text;
    elements.input.dispatchEvent(new Event("input"));
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { elements, find, requests, highlights, timers, type, settle, closed: () => closed };
}

const SCROLL = { offset_from_bottom: 26, max_offset_from_bottom: 168, viewport_rows: 40 };
const matchAt = (row, col) => ({ start: { row, col }, end: { row, col: col + 5 } });

test("the bar searches once typing pauses, then steps older on Enter and newer on Shift+Enter", async () => {
  const bar = findBar({
    answer: (body, n) => ({ total: 17, current: 18 - n, match: matchAt(160 - n, 2), matches: [], content_revision: 7, scroll: SCROLL }),
  });
  assert.equal(bar.elements.form.hidden, true);
  bar.find.show("w1:p1");
  assert.equal(bar.elements.form.hidden, false);
  assert.equal(bar.elements.input.focused, true);
  assert.equal(bar.elements.olderButton.disabled, true, "nothing to step through yet");

  bar.type("needle");
  assert.equal(bar.requests.length, 0, "waits for the pause");
  assert.equal(bar.elements.olderButton.disabled, false);
  bar.timers.at(-1)();
  await bar.settle();
  assert.deepEqual(bar.requests[0], ["w1:p1", { query: "needle", direction: "backward" }]);
  assert.equal(bar.elements.count.textContent, "17/17");
  assert.deepEqual(bar.highlights.at(-1), { query: "needle", current: { row: 159 - 142, col: 2 } });

  keydown(bar.elements.input, "Enter");
  await bar.settle();
  assert.deepEqual(bar.requests[1], ["w1:p1", { query: "needle", direction: "backward", previous: matchAt(159, 2), contentRevision: 7 }]);
  assert.equal(bar.elements.count.textContent, "16/17");

  keydown(bar.elements.input, "Enter", { shiftKey: true });
  await bar.settle();
  assert.deepEqual(bar.requests[2], ["w1:p1", { query: "needle", direction: "forward", previous: matchAt(158, 2), contentRevision: 7 }]);
  assert.equal(bar.elements.count.textContent, "15/17");

  // The reader scrolled: the marks stay, the current one's place is no longer known.
  bar.find.forgetPlace();
  assert.deepEqual(bar.highlights.at(-1), { query: "needle", current: null });

  // Enter mid-composition belongs to the IME.
  keydown(bar.elements.input, "Enter", { isComposing: true });
  await bar.settle();
  assert.equal(bar.requests.length, 3);

  keydown(bar.elements.input, "Escape");
  assert.equal(bar.elements.form.hidden, true);
  assert.equal(bar.highlights.at(-1), null);
  assert.equal(bar.closed(), 1);
});

test("a changed history finds again from the view, a failure says so, and another pane closes the bar", async () => {
  let fail = null;
  const bar = findBar({
    answer: (body) => {
      if (fail) throw fail;
      if (body.previous) throw Object.assign(new Error("The terminal changed while searching. Search again."), { code: "stale_content" });
      return { total: 2, current: 1, match: matchAt(150, 0), matches: [], content_revision: 8, scroll: SCROLL };
    },
  });
  bar.find.show("w1:p1");
  bar.type("x");
  keydown(bar.elements.input, "Enter");
  await bar.settle();
  assert.equal(bar.requests.length, 1, "Enter searched at once, without waiting for the pause");
  assert.equal(bar.elements.count.textContent, "1/2");

  keydown(bar.elements.input, "Enter");
  await bar.settle();
  assert.deepEqual(bar.requests.slice(1).map(([, body]) => Boolean(body.previous)), [true, false]);
  assert.equal(bar.elements.count.textContent, "1/2");

  fail = Object.assign(new Error("Herdr command timed out"), { code: "herdr_timeout" });
  keydown(bar.elements.input, "Enter");
  await bar.settle();
  assert.equal(bar.elements.count.textContent, "Search failed");
  assert.equal(bar.elements.count.title, "Herdr command timed out");
  assert.equal(bar.elements.count.dataset.error, "true");

  bar.find.setPane("w1:p2");
  assert.equal(bar.elements.form.hidden, true);
  assert.equal(bar.find.open, false);
});

test("a query typed while a find is out is searched after it, and the late answer is not shown for it", async () => {
  const pending = [];
  const elements = {
    form: new FakeElement(), input: new FakeElement(), count: new FakeElement(),
    olderButton: new FakeElement(), newerButton: new FakeElement(), closeButton: new FakeElement(),
  };
  const bodies = [];
  const find = createTerminalFind({
    ...elements,
    search: (paneId, body) => { bodies.push(body); return new Promise((resolve) => pending.push(resolve)); },
    setTimer: (callback) => { callback(); return 1; },
    clearTimer: () => {},
  });
  find.show("w1:p1");
  elements.input.value = "ab";
  elements.input.dispatchEvent(new Event("input"));
  elements.input.value = "abc";
  elements.input.dispatchEvent(new Event("input"));
  assert.equal(bodies.length, 1);
  pending.shift()({ total: 1, current: 1, match: matchAt(1, 0), matches: [], content_revision: 1, scroll: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bodies[1], { query: "abc", direction: "backward" });
  assert.equal(elements.count.textContent, "…", "the answer for ab is not shown for abc");
  pending.shift()({ total: 4, current: 2, match: matchAt(2, 0), matches: [], content_revision: 1, scroll: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.count.textContent, "2/4");
});

test("a stale step for a query since changed is not retried for the old words", async () => {
  const pending = [];
  const elements = {
    form: new FakeElement(), input: new FakeElement(), count: new FakeElement(),
    olderButton: new FakeElement(), newerButton: new FakeElement(), closeButton: new FakeElement(),
  };
  const bodies = [];
  const find = createTerminalFind({
    ...elements,
    search: (paneId, body) => { bodies.push(body); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    setTimer: (callback) => { queueMicrotask(callback); return 1; },
    clearTimer: () => {},
  });
  find.show("w1:p1");
  elements.input.value = "ab";
  elements.input.dispatchEvent(new Event("input"));
  await new Promise((resolve) => setImmediate(resolve));
  pending.shift().resolve({ total: 3, current: 1, match: matchAt(1, 0), matches: [], content_revision: 1, scroll: null });
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  keydown(elements.input, "Enter");
  assert.ok(bodies[1]?.previous, `a step from the last match: ${JSON.stringify(bodies)}`);
  elements.input.value = "abc";
  elements.input.dispatchEvent(new Event("input"));
  await new Promise((resolve) => setImmediate(resolve));
  pending.shift().reject(Object.assign(new Error("changed"), { code: "stale_content" }));
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodies.filter((body) => body.query === "ab").length, 2, "no retry for ab");
  assert.equal(bodies.at(-1).query, "abc", "the new words are searched instead");
});

// A bar whose server answers when the test says, to change things mid-flight.
function slowBar() {
  const elements = {
    form: new FakeElement(), input: new FakeElement(), count: new FakeElement(),
    olderButton: new FakeElement(), newerButton: new FakeElement(), closeButton: new FakeElement(),
  };
  const searches = [];
  const reveals = [];
  const highlights = [];
  const find = createTerminalFind({
    ...elements,
    search: (paneId, body) => new Promise((resolve, reject) => searches.push({ paneId, body, resolve, reject })),
    reveal: (paneId, body) => new Promise((resolve, reject) => reveals.push({ paneId, body, resolve, reject })),
    onHighlight: (marks) => highlights.push(marks),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const type = (text) => {
    elements.input.value = text;
    elements.input.dispatchEvent(new Event("input"));
  };
  const answer = (extra = {}) => ({ total: 4, current: 2, match: matchAt(10, 0), matches: [], content_revision: 5, scroll: null, ...extra });
  return { elements, find, searches, reveals, highlights, settle, type, answer };
}

test("a found match is revealed, and the view it ends in marks the match", async () => {
  const bar = slowBar();
  bar.find.show("w1:p1");
  bar.type("x");
  keydown(bar.elements.input, "Enter");
  await bar.settle();
  bar.searches[0].resolve(bar.answer());
  await bar.settle();
  assert.equal(bar.reveals.length, 1);
  assert.deepEqual([bar.reveals[0].paneId, bar.reveals[0].body], ["w1:p1", { match: matchAt(10, 0), contentRevision: 5 }]);
  assert.equal(bar.elements.count.textContent, "…", "still working until the view has moved");
  bar.reveals[0].resolve({ scroll: { offset_from_bottom: 15, max_offset_from_bottom: 20, viewport_rows: 12 } });
  await bar.settle();
  assert.equal(bar.elements.count.textContent, "2/4");
  // The view's top is history row 20 - 15 = 5: the match on row 10 is its sixth.
  assert.deepEqual(bar.highlights.at(-1), { query: "x", current: { row: 5, col: 0 } });
});

test("no match, nothing to reveal", async () => {
  const bar = slowBar();
  bar.find.show("w1:p1");
  bar.type("x");
  keydown(bar.elements.input, "Enter");
  await bar.settle();
  bar.searches[0].resolve(bar.answer({ total: 0, current: null, match: null }));
  await bar.settle();
  assert.equal(bar.reveals.length, 0);
  assert.equal(bar.elements.count.textContent, "No matches");
});

test("words changed, a closed bar or another pane while the find was out: the view is not scrolled", async () => {
  for (const change of [
    (bar) => bar.type("xy"),
    (bar) => bar.type(""),
    (bar) => keydown(bar.elements.input, "Escape"),
    (bar) => bar.find.setPane("w1:p2"),
  ]) {
    const bar = slowBar();
    bar.find.show("w1:p1");
    bar.type("x");
    keydown(bar.elements.input, "Enter");
    await bar.settle();
    change(bar);
    bar.searches[0].resolve(bar.answer());
    await bar.settle();
    assert.equal(bar.reveals.length, 0, String(change));
  }
});

test("things changing while the view is moving drop that answer", async () => {
  const bar = slowBar();
  bar.find.show("w1:p1");
  bar.type("x");
  keydown(bar.elements.input, "Enter");
  await bar.settle();
  bar.searches[0].resolve(bar.answer());
  await bar.settle();
  bar.type("xy");
  bar.reveals[0].resolve({ scroll: { offset_from_bottom: 0, max_offset_from_bottom: 20, viewport_rows: 12 } });
  await bar.settle();
  assert.equal(bar.elements.count.textContent, "", "the answer for x is not shown for xy");
  assert.deepEqual(bar.highlights.at(-1), { query: "xy", current: null });
});

test("a reveal that finds the history changed searches the words once more, then reveals that", async () => {
  const bar = slowBar();
  bar.find.show("w1:p1");
  bar.type("x");
  keydown(bar.elements.input, "Enter");
  await bar.settle();
  bar.searches[0].resolve(bar.answer());
  await bar.settle();
  bar.reveals[0].reject(Object.assign(new Error("changed"), { code: "stale_content" }));
  await bar.settle();
  assert.equal(bar.searches.length, 2);
  assert.deepEqual(bar.searches[1].body, { query: "x", direction: "backward" });
  bar.searches[1].resolve(bar.answer({ content_revision: 6, match: matchAt(12, 0) }));
  await bar.settle();
  assert.deepEqual(bar.reveals[1].body, { match: matchAt(12, 0), contentRevision: 6 });
  bar.reveals[1].resolve({ scroll: null });
  await bar.settle();
  assert.equal(bar.elements.count.textContent, "2/4");

  // A second stale in a row is a failure the bar shows, not a loop.
  keydown(bar.elements.input, "Enter");
  await bar.settle();
  bar.searches[2].resolve(bar.answer());
  await bar.settle();
  bar.reveals[2].reject(Object.assign(new Error("changed"), { code: "stale_content" }));
  await bar.settle();
  bar.searches[3].resolve(bar.answer());
  await bar.settle();
  bar.reveals[3].reject(Object.assign(new Error("changed again"), { code: "stale_content" }));
  await bar.settle();
  assert.equal(bar.searches.length, 4);
  assert.equal(bar.elements.count.textContent, "Search failed");
});
