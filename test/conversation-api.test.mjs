import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { claudeProjectDir, forgetConversationState } from "../src/conversation/claude.mjs";
import { ConversationMonitor } from "../src/conversation/monitor.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";

const SESSION = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const UNWRITTEN = "22222222-2222-4222-8222-222222222222";
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const turn = (n) => [
  { type: "user", message: { role: "user", content: `prompt ${n}` } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] } },
];

async function fixture(context) {
  forgetConversationState();
  const root = await mkdtemp(join(tmpdir(), "herdrabbit-conversation-api-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "claude");
  const project = join(configDir, "projects", claudeProjectDir("/work/app"));
  await mkdir(project, { recursive: true });
  const transcript = join(project, `${SESSION}.jsonl`);
  await writeFile(transcript, jsonl([
    ...Array.from({ length: 60 }, (_, n) => turn(n)).flat(),
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_big", name: "Bash", input: { command: "seq 1 100000" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_big", content: "1\n".repeat(600_000) }] } },
  ]));
  const panes = [
    { pane_id: "w1:p1", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: SESSION }, cwd: "/work/app" },
    { pane_id: "w1:p2", agent: null, cwd: "/work/app" },
    { pane_id: "w1:p3", agent: "claude", agent_session: null, cwd: "/work/app" },
    { pane_id: "w1:p4", agent: "claude", agent_session: { kind: "id", value: UNWRITTEN }, cwd: "/work/app" },
  ];
  const herdr = { async snapshot() { return { workspaces: [], tabs: [], panes, agents: [] }; } };
  let authenticated = true;
  const app = createHerdrHttpServer({
    herdr,
    csrfToken: "csrf",
    logger: { error() {} },
    auth: {
      required: true,
      hasValidSession: (cookie) => authenticated && cookie === "session=valid",
      hasValidLaunchToken: (token) => authenticated && token === "launch",
      onSessionsEnded: () => () => {},
    },
    conversations: new ConversationService({ herdr, localStore: localTranscriptStore({ configDir }) }),
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" };
  const get = (path, extra = {}) => fetch(`${origin}${path}`, { headers: { ...headers, ...extra } });
  return { app, origin, get, transcript, logout: () => { authenticated = false; } };
}

test("the conversation routes sit behind the sign-in", async (context) => {
  const { origin } = await fixture(context);
  for (const path of ["/api/panes/w1%3Ap1/conversation", "/api/panes/w1%3Ap1/conversation/tools/toolu_big"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "authentication_required");
  }
});

test("answers a page of turns with an ETag, 304 when unchanged, and a new page after an append", async (context) => {
  const { get, transcript } = await fixture(context);
  const response = await get("/api/panes/w1%3Ap1/conversation");
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(response.headers.get("etag"), `"${page.version}"`);
  assert.equal(page.source, "claude-transcript");
  assert.equal(page.turns[0].parts[0].text, "prompt 10");
  const tool = page.turns.at(-1).parts.at(-1);
  assert.equal(tool.output_truncated, true);
  assert.equal(tool.output_size, 1_200_000);
  assert.equal((await get("/api/panes/w1%3Ap1/conversation", { "If-None-Match": `"${page.version}"` })).status, 304);
  const older = await (await get(`/api/panes/w1%3Ap1/conversation?before=${encodeURIComponent(page.cursor)}`)).json();
  assert.equal(older.turns[0].parts[0].text, "prompt 0");
  assert.equal(older.cursor, null);
  await appendFile(transcript, jsonl(turn(60)));
  const changed = await get("/api/panes/w1%3Ap1/conversation", { "If-None-Match": `W/"${page.version}"` });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).turns.at(-1).parts[0].text, "answer 60");
  // the held start slid out of the newest page: the newest page comes back, the gap is asked for with before+since
  const since = await (await get(`/api/panes/w1%3Ap1/conversation?since=${encodeURIComponent(page.cursor)}`)).json();
  assert.equal(since.turns[0].parts[0].text, "prompt 11");
  const gap = await (await get(`/api/panes/w1%3Ap1/conversation?before=${encodeURIComponent(since.cursor)}&since=${encodeURIComponent(page.cursor)}`)).json();
  assert.deepEqual(gap.turns.map((item) => item.parts[0].text), ["prompt 10", "answer 10"]);
});

test("If-None-Match: * is 304 for a conversation that exists, and not for one that does not", async (context) => {
  const { get } = await fixture(context);
  assert.equal((await get("/api/panes/w1%3Ap1/conversation", { "If-None-Match": "*" })).status, 304);
  assert.equal((await get("/api/panes/w1%3Ap4/conversation", { "If-None-Match": "*" })).status, 304);
  // no Claude conversation there: * has nothing to match
  assert.equal((await get("/api/panes/w1%3Ap2/conversation", { "If-None-Match": "*" })).status, 404);
});

test("409 history_changed for a cursor that no longer names this transcript", async (context) => {
  const { get } = await fixture(context);
  for (const cursor of ["somewhere-else:10", "nonsense"]) {
    const response = await get(`/api/panes/w1%3Ap1/conversation?before=${encodeURIComponent(cursor)}`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "history_changed");
  }
});

test("a pane that is not Claude, or has no session, is conversation_unavailable with a reason", async (context) => {
  const { get } = await fixture(context);
  for (const [pane, reason] of [["w1:p2", "not_claude"], ["w1:p3", "no_session_id"], ["w9:p9", "pane_not_found"]]) {
    const response = await get(`/api/panes/${encodeURIComponent(pane)}/conversation`);
    assert.equal(response.status, 404);
    assert.deepEqual((await response.json()).error.details, { reason });
  }
  // a session that has written nothing yet is an empty conversation
  const empty = await (await get("/api/panes/w1%3Ap4/conversation")).json();
  assert.deepEqual([empty.turns, empty.cursor, empty.history_id], [[], null, `unwritten-${UNWRITTEN}`]);
  assert.equal((await get("/api/panes/w1%3Ap4/conversation?before=x:1")).status, 409);
});

test("answers one tool's whole output, capped, and 404 for an unknown id", async (context) => {
  const { get } = await fixture(context);
  const tool = await (await get("/api/panes/w1%3Ap1/conversation/tools/toolu_big")).json();
  assert.equal(tool.output.length, 1_000_000);
  assert.equal(tool.output_size, 1_200_000);
  assert.equal(tool.truncated, true);
  const missing = await get("/api/panes/w1%3Ap1/conversation/tools/toolu_none");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "tool_output_not_found");
  assert.equal((await get("/api/panes/w1%3Ap1/conversation/tools/bad%2E%2E")).status, 400);
});

async function socket(origin) {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/api/terminal`, { origin, headers: { Cookie: "session=valid" } });
  const messages = [];
  const waiting = [];
  ws.on("error", () => {});
  ws.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    messages.push(message);
    for (const waiter of [...waiting]) {
      if (waiter.predicate(message)) {
        waiting.splice(waiting.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", csrf: "csrf", launchToken: "launch" }));
  const wait = (predicate, after = 0) => {
    const existing = messages.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      waiting.push({ predicate, resolve, timer: setTimeout(() => reject(new Error("Missing socket message")), 3000) });
    });
  };
  return { ws, messages, wait, send: (message) => ws.send(JSON.stringify(message)) };
}

test("a watched conversation announces an append over the terminal socket; unwatching stops the timer", async (context) => {
  const { app, origin, transcript } = await fixture(context);
  const client = await socket(origin);
  context.after(() => client.ws.terminate());
  await client.wait((message) => message.type === "ready");
  client.send({ type: "watch-conversation", paneId: "w1:p1" });
  const first = await client.wait((message) => message.type === "conversation-changed");
  assert.deepEqual(Object.keys(first).sort(), ["pane_id", "signature", "type"]);
  assert.equal(first.pane_id, "w1:p1");
  assert.equal(app.conversationMonitor.running, true);
  const seen = client.messages.length;
  await appendFile(transcript, jsonl(turn(61)));
  const next = await client.wait((message) => message.type === "conversation-changed", seen);
  assert.notEqual(next.signature, first.signature);
  client.send({ type: "unwatch-conversation", paneId: "w1:p1" });
  for (let tries = 0; tries < 50 && app.conversationMonitor.running; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.conversationMonitor.running, false);
  assert.equal(app.conversationMonitor.size, 0);
  // closing the socket releases what it watched
  client.send({ type: "watch-conversation", paneId: "w1:p1" });
  for (let tries = 0; tries < 50 && !app.conversationMonitor.running; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  client.ws.close();
  for (let tries = 0; tries < 50 && app.conversationMonitor.running; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.conversationMonitor.running, false);
});

test("a socket watches at most four conversations", async (context) => {
  const { origin } = await fixture(context);
  const client = await socket(origin);
  context.after(() => client.ws.terminate());
  await client.wait((message) => message.type === "ready");
  for (const pane of ["a", "b", "c", "d", "e"]) client.send({ type: "watch-conversation", paneId: pane });
  const refused = await client.wait((message) => message.type === "conversation-unavailable");
  assert.deepEqual(refused, { type: "conversation-unavailable", pane_id: "e", code: "busy" });
});

test("the monitor stats remote files more slowly, reports unavailability, and runs no timer unwatched", async () => {
  let now = 0;
  const stats = [];
  const remote = { remote: true, stat: async (path) => { stats.push(path); return { identity: "1-2", size: stats.length, mtimeMs: 1 }; } };
  const monitor = new ConversationMonitor({
    resolve: async (paneId) => {
      if (paneId === "gone") { const { ConversationUnavailable } = await import("../src/conversation/claude.mjs"); throw new ConversationUnavailable("not_claude"); }
      return { serverId: "machine-1", store: remote, session: SESSION, path: "/h/.claude/projects/-w/x.jsonl" };
    },
    statIntervalMs: 5,
    now: () => now,
  });
  const heard = [];
  const stop = monitor.watch("machine-1!w1:p1", (signature) => heard.push(signature));
  const stopGone = monitor.watch("gone", (signature) => heard.push(`gone:${signature}`));
  await new Promise((resolve) => setTimeout(resolve, 60));
  // the clock has not moved: one stat, however many ticks
  assert.equal(stats.length, 1);
  assert.ok(heard.some((item) => item.startsWith("gone:")));
  now += 1_500;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stats.length, 2);
  stop();
  stopGone();
  assert.equal(monitor.running, false);
  monitor.stop();
});
