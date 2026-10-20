// Chat for a PC added with Connect PC: that PC (B) reads its own transcripts
// and answers pages, tool output, a change signature and the plan or question
// a prompt card shows over its Connect PC port; this PC (A) only relays. Both
// run here on loopback, B with a fake Herdr and a Claude transcript in a
// temporary folder.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { claudeProjectDir } from "../src/conversation/claude.mjs";
import { ConversationUnavailable, forgetConversationState } from "../src/conversation/pages.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { localTranscriptStore } from "../src/conversation/stores.mjs";
import { HttpError } from "../src/http-basics.mjs";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { linkRoutes } from "../src/link-server.mjs";
import { MultiServerClient } from "../src/multi-server-client.mjs";
import { PeerIdentity } from "../src/peer-identity.mjs";
import { opencodeDb } from "./fixtures/opencode-db.mjs";
import { createPeerServer } from "../src/peer-server.mjs";

const VERSION = "1.2.78";
const SESSION = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const PANE = "hs_ZGVmYXVsdA~w1:p1";
const LINKED = `link_1!${PANE}`;
const CODEX_PANE = "hs_ZGVmYXVsdA~w1:p3";
const OPENCODE_PANE = "hs_ZGVmYXVsdA~w1:p4";
const OPENCODE_SESSION = "ses_0001AAAAAAAAAAAAAAAAAAAAAA";
const THREAD = "019da5c2-66fd-7021-b565-5e94406b028e";
const codexTask = (n) => [
  { type: "event_msg", payload: { type: "task_started", turn_id: `t${n}` } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `codex prompt ${n}` }] } },
  { type: "event_msg", payload: { type: "user_message", message: `codex prompt ${n}` } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `codex answer ${n}` }], phase: "final_answer" } },
  { type: "event_msg", payload: { type: "task_complete" } },
];
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const turn = (n) => [
  { type: "user", message: { role: "user", content: `prompt ${n}` } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] } },
];
const PLAN = `# Move the cache\n\n${Array.from({ length: 60 }, (_, n) => `- step ${n + 1}`).join("\n")}\n\nThe last line of the plan.`;
// What B's pane shows of the plan: its start scrolled away.
const planScreen = `
- step 59
- step 60

The last line of the plan.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. Tell Claude what to change
     shift+tab to approve with this feedback
`;

async function listen(context, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

// B: its own Herdr (a fake), its own transcripts, its Connect PC port.
// `link` wraps its routes, for a PC that answers differently.
async function startDesk(context, { link = (routes) => routes } = {}) {
  forgetConversationState();
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-link-conversation-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "claude");
  const project = join(configDir, "projects", claudeProjectDir("/work/desk"));
  await mkdir(project, { recursive: true });
  const transcript = join(project, `${SESSION}.jsonl`);
  await writeFile(transcript, jsonl([
    ...Array.from({ length: 60 }, (_, n) => turn(n)).flat(),
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_big", name: "Bash", input: { command: "seq 1 100000" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_big", content: "1\n".repeat(600_000) }] } },
  ]));
  // A Codex rollout, as Codex names it, reported by its thread id.
  const rolloutFolder = join(root, "codex", "sessions", "2026", "09", "22");
  await mkdir(rolloutFolder, { recursive: true });
  await writeFile(join(rolloutFolder, `rollout-2026-09-22T01-00-00-${THREAD}.jsonl`), jsonl([
    { type: "session_meta", payload: { id: THREAD, cwd: "/work/desk", source: "cli" } },
    ...codexTask(1), ...codexTask(2),
  ]));
  // An OpenCode database, its session reported by herdr's OpenCode plugin.
  const opencode = opencodeDb(join(root, "opencode.db"));
  context.after(() => opencode.close());
  opencode.session(OPENCODE_SESSION, { directory: "/work/desk", version: "1.18.34" });
  opencode.exchange(OPENCODE_SESSION, 1, [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a\nb" } }]);
  const reads = [];
  const panes = [
    { pane_id: OPENCODE_PANE, agent: "opencode", agent_status: "idle", cwd: "/work/desk",
      agent_session: { agent: "opencode", kind: "id", source: "herdr:opencode", value: OPENCODE_SESSION } },
    { pane_id: CODEX_PANE, agent: "codex", agent_status: "idle", cwd: "/work/desk", agent_session: { agent: "codex", kind: "id", value: THREAD } },
    { pane_id: PANE, agent: "claude", agent_status: "blocked", cwd: "/work/desk", agent_session: { agent: "claude", kind: "id", value: SESSION } },
    { pane_id: "hs_ZGVmYXVsdA~w1:p2", agent: null, cwd: "/work/desk" },
  ];
  const herdr = {
    reads,
    async snapshot() {
      return {
        herdr_sessions: [{ session_id: "hs_ZGVmYXVsdA", name: "default", running: true, available: true, default: true }],
        workspaces: [], tabs: [], panes: structuredClone(panes), agents: [],
      };
    },
    async readPane(paneId, options) { reads.push([paneId, options]); return planScreen; },
  };
  const conversations = new ConversationService({ herdr, localStore: localTranscriptStore({ configDir, codexHome: join(root, "codex"), opencodeDb: join(root, "opencode.db") }) });
  // B's own `/` command list, as a fake that says what it was asked.
  const commandsAsked = [];
  const slashCommands = {
    async list(query) {
      commandsAsked.push(query);
      return { agent: query.agent ?? null, commands: query.agent === "claude" ? [{ name: "desk-skill", description: "On the desk", source: "user" }] : [] };
    },
  };
  const server = createPeerServer({
    peer: new PeerIdentity({ addresses: ["127.0.0.1"] }),
    link: link(linkRoutes({ client: herdr, conversations, slashCommands, version: VERSION, serverName: "desk" })),
    logger: { error() {} },
  });
  return { address: await listen(context, server), herdr, transcript, project, commandsAsked, opencode };
}

// A: the page, with B connected, read through its own browser API.
async function startHub(context, deskAddress) {
  const local = { async snapshot() { return { herdr_sessions: [], workspaces: [], tabs: [], panes: [], agents: [] }; } };
  const herdr = new MultiServerClient({
    local, hubVersion: VERSION,
    profiles: { list: () => [{ id: "link_1", name: "desk", address: deskAddress }] },
  });
  context.after(() => { herdr.stopped = true; herdr.close(); });
  herdr.syncEntries();
  await herdr.refresh(herdr.entries.get("link_1"));
  const conversations = new ConversationService({ herdr });
  const app = createHerdrHttpServer({
    herdr, conversations,
    csrfToken: "csrf",
    logger: { error() {} },
    auth: {
      required: true,
      hasValidSession: (cookie) => cookie === "session=valid",
      hasValidLaunchToken: (token) => token === "launch",
      onSessionsEnded: () => () => {},
    },
  });
  const origin = await listen(context, app.server);
  const headers = { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" };
  const get = (path, extra = {}) => fetch(`${origin}${path}`, { headers: { ...headers, ...extra } });
  return { app, origin, get, herdr, conversations };
}

const pane = (rest = "") => `/api/panes/${encodeURIComponent(LINKED)}${rest}`;

test("A reads a connected PC's pane as pages B read: ETag and 304, before and since, 409 for another transcript", async (context) => {
  const desk = await startDesk(context);
  const { get } = await startHub(context, desk.address);
  const response = await get(pane("/conversation"));
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(response.headers.get("etag"), `"${page.version}"`);
  assert.equal(page.source, "claude-transcript");
  assert.equal(page.turns[0].parts[0].text, "prompt 10");
  assert.equal(JSON.stringify(page).includes(desk.project), false, "no path of B's crosses the link");
  assert.equal((await get(pane("/conversation"), { "If-None-Match": `"${page.version}"` })).status, 304);
  const unchanged = await get(pane("/conversation"), { "If-None-Match": `"${page.version}"` });
  assert.equal(unchanged.headers.get("etag"), `"${page.version}"`);
  assert.equal((await get(pane("/conversation"), { "If-None-Match": "*" })).status, 304);
  const older = await (await get(pane(`/conversation?before=${encodeURIComponent(page.cursor)}`))).json();
  assert.equal(older.turns[0].parts[0].text, "prompt 0");
  await appendFile(desk.transcript, jsonl(turn(60)));
  const changed = await get(pane("/conversation"), { "If-None-Match": `"${page.version}"` });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).turns.at(-1).parts[0].text, "answer 60");
  const since = await (await get(pane(`/conversation?since=${encodeURIComponent(page.cursor)}`))).json();
  assert.equal(since.turns[0].parts[0].text, "prompt 11");
  const stale = await get(pane("/conversation?before=somewhere-else%3A10"));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "history_changed");
  assert.equal((await get(pane(`/conversation?before=${"x".repeat(201)}`))).status, 400);
});

test("A relays a tool's whole output, and B's reasons a pane has none", async (context) => {
  const desk = await startDesk(context);
  const { get } = await startHub(context, desk.address);
  const tool = await (await get(pane("/conversation/tools/toolu_big"))).json();
  assert.deepEqual([tool.id, tool.output.length, tool.output_size, tool.truncated], ["toolu_big", 1_000_000, 1_200_000, true]);
  const missing = await get(pane("/conversation/tools/toolu_none"));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "tool_output_not_found");
  assert.equal((await get(pane("/conversation/tools/bad%2E%2E"))).status, 400);
  for (const [id, reason] of [["link_1!hs_ZGVmYXVsdA~w1:p2", "not_supported_agent"], ["link_1!hs_ZGVmYXVsdA~w9:p9", "pane_not_found"]]) {
    const response = await get(`/api/panes/${encodeURIComponent(id)}/conversation`);
    assert.equal(response.status, 404);
    assert.deepEqual((await response.json()).error.details, { reason });
  }
});

test("A relays a connected PC's OpenCode pane, read from B's own database", async (context) => {
  const desk = await startDesk(context);
  const { get } = await startHub(context, desk.address);
  const linked = `/api/panes/${encodeURIComponent(`link_1!${OPENCODE_PANE}`)}`;
  const response = await get(`${linked}/conversation`);
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.source, "opencode-session");
  assert.deepEqual(page.turns.map((turn) => turn.role), ["user", "assistant"]);
  const tool = page.turns[1].parts.find((part) => part.kind === "tool");
  assert.equal(tool.summary, "ls");
  assert.deepEqual(await (await get(`${linked}/conversation/tools/${tool.id}`)).json(), { id: tool.id, output: "a\nb", output_size: 3, truncated: false });
  assert.equal((await get(`${linked}/conversation`, { "If-None-Match": `"${page.version}"` })).status, 304);
  const signature = async () => (await (await fetch(`${desk.address}/api/link/panes/${encodeURIComponent(OPENCODE_PANE)}/conversation/signature`)).json()).signature;
  const before = await signature();
  desk.opencode.exchange(OPENCODE_SESSION, 2);
  assert.notEqual(await signature(), before);
  const grown = await (await get(`${linked}/conversation`)).json();
  assert.equal(grown.turns.at(-1).parts.at(-1).text, "answer 2");
});

test("B answers only for its own panes, never for a server it reaches itself", async (context) => {
  const desk = await startDesk(context);
  for (const path of ["conversation", "conversation/signature", "conversation/tools/toolu_big", "pending-ask", "agent-version"]) {
    const response = await fetch(`${desk.address}/api/link/panes/${encodeURIComponent(`other!${PANE}`)}/${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual((await response.json()).error.details, { reason: "pane_not_found" }, path);
  }
  // nothing a browser sends gets in
  const browser = await fetch(`${desk.address}/api/link/panes/${encodeURIComponent(PANE)}/conversation`, { headers: { Origin: "http://evil.example" } });
  assert.equal(browser.status, 403);
});

async function socket(origin) {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/api/terminal`, { origin, headers: { Cookie: "session=valid" } });
  const messages = [];
  ws.on("error", () => {});
  ws.on("message", (bytes) => messages.push(JSON.parse(bytes.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", csrf: "csrf", launchToken: "launch" }));
  const wait = async (predicate, after = 0, ms = 5_000) => {
    for (const started = Date.now(); Date.now() - started < ms;) {
      const found = messages.slice(after).find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Missing socket message");
  };
  return { ws, messages, wait, send: (message) => ws.send(JSON.stringify(message)) };
}

test("a change on B reaches A's watching page through the signature A polls", async (context) => {
  const desk = await startDesk(context);
  const { origin, app } = await startHub(context, desk.address);
  const client = await socket(origin);
  context.after(() => client.ws.terminate());
  await client.wait((message) => message.type === "ready");
  client.send({ type: "watch-conversation", paneId: LINKED });
  const first = await client.wait((message) => message.type === "conversation-changed");
  assert.equal(first.pane_id, LINKED);
  const seen = client.messages.length;
  await appendFile(desk.transcript, jsonl(turn(61)));
  // A asks B every 1.5 s, as for a Herdr machine
  const next = await client.wait((message) => message.type === "conversation-changed", seen);
  assert.notEqual(next.signature, first.signature);
  client.send({ type: "unwatch-conversation", paneId: LINKED });
  for (let tries = 0; tries < 50 && app.conversationMonitor.running; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.conversationMonitor.running, false);
});

test("B's signature changes with the file and says nothing of it", async (context) => {
  const desk = await startDesk(context);
  const ask = async () => (await (await fetch(`${desk.address}/api/link/panes/${encodeURIComponent(PANE)}/conversation/signature`)).json()).signature;
  const before = await ask();
  assert.match(before, /^[A-Za-z0-9_-]{22}$/u);
  assert.equal(await ask(), before);
  await appendFile(desk.transcript, jsonl(turn(62)));
  assert.notEqual(await ask(), before);
  const other = await (await fetch(`${desk.address}/api/link/panes/${encodeURIComponent("hs_ZGVmYXVsdA~w1:p2")}/conversation/signature`)).json();
  assert.match(other.signature, /^[A-Za-z0-9_-]{22}$/u);
});

test("a plan card for a connected PC's pane shows the whole plan from B's transcript, read from the screen region cards use", async (context) => {
  const desk = await startDesk(context);
  await writeFile(desk.transcript, jsonl([
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ExitPlanMode", input: { plan: PLAN } }] } },
  ]));
  const { get, conversations } = await startHub(context, desk.address);
  const { card } = await (await get(pane("/prompt"))).json();
  assert.equal(card.kind, "plan");
  assert.equal(card.body, PLAN);
  // B's screen was read as a card on B reads it
  const [readId, options] = desk.herdr.reads.at(-1);
  assert.equal(readId, PANE);
  assert.deepEqual([options.format, options.source], ["text", "detection"]);
  assert.deepEqual(await conversations.pendingAsk(LINKED), { name: "ExitPlanMode", input: { plan: PLAN } });
  // a source that is not one is refused on B, as the page refuses it
  const bad = await fetch(`${desk.address}/api/link/panes/${encodeURIComponent(PANE)}/output?lines=10&format=text&source=everything`);
  assert.equal(bad.status, 400);
});

test("A's composer lists a connected PC's pane's / commands as B builds them", async (context) => {
  const desk = await startDesk(context);
  const { get } = await startHub(context, desk.address);
  const answer = await (await get(pane("/commands"))).json();
  assert.deepEqual(answer, { agent: "claude", commands: [{ name: "desk-skill", description: "On the desk", source: "user" }], remote: true });
  // B decided the agent and folder from its own snapshot, for its own pane id
  assert.deepEqual(desk.commandsAsked, [{ agent: "claude", cwd: "/work/desk" }]);
  // a pane with no agent there asks nothing
  const shell = await (await get(`/api/panes/${encodeURIComponent("link_1!hs_ZGVmYXVsdA~w1:p2")}/commands`)).json();
  assert.deepEqual(shell, { agent: null, commands: [] });
  assert.equal(desk.commandsAsked.length, 1);
});

test("a connected PC from before this says to update it", async (context) => {
  // An older HerdRabbit names no features in its hello and has none of the
  // conversation routes (every one is its 404 not_found).
  const asked = [];
  const desk = await startDesk(context, {
    link: (routes) => async (request, response, url, method) => {
      asked.push(url.pathname);
      if (/\/(conversation|pending-ask|scroll-bottom)/u.test(url.pathname)) throw new HttpError(404, "not_found", "Not found");
      const end = response.end.bind(response);
      response.end = (body, ...rest) => {
        if (typeof body === "string" && body.includes('"features"')) {
          body = body.replace(/,"features":\[[^\]]*\]/u, "");
          response.setHeader("Content-Length", Buffer.byteLength(body));
        }
        return end(body, ...rest);
      };
      return routes(request, response, url, method);
    },
  });
  const { get, herdr, conversations, origin } = await startHub(context, desk.address);
  // the terminal's jump to the newest output is not asked of it at all
  assert.deepEqual(await herdr.paneScrollToBottom(LINKED), { scroll: null });
  assert.ok(!asked.some((path) => path.endsWith("/scroll-bottom")), "an older PC was asked to scroll");
  // nor its / commands: the composer lists the agent's own
  const commands = await (await get(pane("/commands"))).json();
  assert.equal(commands.agent, "claude");
  assert.ok(commands.commands.length > 0 && commands.commands.every((command) => command.source === "built-in"));
  assert.ok(!asked.some((path) => path.endsWith("/commands")), "an older PC was asked for its commands");
  assert.deepEqual(desk.commandsAsked, []);
  const response = await get(pane("/conversation"));
  assert.equal(response.status, 404);
  assert.deepEqual((await response.json()).error.details, { reason: "linked_pc_old" });
  await assert.rejects(conversations.toolOutput(LINKED, "toolu_big"), (error) => error instanceof ConversationUnavailable && error.reason === "linked_pc_old");
  assert.equal(await conversations.pendingAsk(LINKED), null);
  // its card keeps the screen's words
  const { card } = await (await get(pane("/prompt"))).json();
  assert.match(card.body, /step 59/u);
  // and a watching page is told once, then nothing more
  const client = await socket(origin);
  context.after(() => client.ws.terminate());
  await client.wait((message) => message.type === "ready");
  client.send({ type: "watch-conversation", paneId: LINKED });
  assert.equal((await client.wait((message) => message.type === "conversation-changed")).pane_id, LINKED);
});

test("a connected PC that cannot be reached reads as a machine that is not connected", async (context) => {
  const desk = await startDesk(context);
  const { get, herdr } = await startHub(context, desk.address);
  // B goes away
  herdr.entries.get("link_1").client.address = "http://127.0.0.1:9";
  const response = await get(pane("/conversation"));
  assert.equal(response.status, 404);
  assert.deepEqual((await response.json()).error.details, { reason: "server_unavailable" });
});

test("a connected PC's Codex pane reads as a chat too, found there by its thread", async (context) => {
  const desk = await startDesk(context);
  const { get } = await startHub(context, desk.address);
  const response = await get(`/api/panes/${encodeURIComponent(`link_1!${CODEX_PANE}`)}/conversation`);
  assert.equal(response.status, 200, await response.clone().text());
  const page = await response.json();
  const words = JSON.stringify(page.turns);
  assert.match(words, /codex prompt 1/u);
  assert.match(words, /codex answer 2/u);
  assert.doesNotMatch(words, /rollout-2026/u, "B's file path stays on B");
});

test("a connected PC's OpenCode version is read there, where its screen and database are; a PC from before this tells none", async (context) => {
  const desk = await startDesk(context);
  const { conversations } = await startHub(context, desk.address);
  assert.equal(await conversations.agentVersion(`link_1!${OPENCODE_PANE}`), "1.18.34");
  assert.equal(await conversations.agentVersion(`link_1!${PANE}`), null, "a Claude pane has none");
  const old = await startDesk(context, {
    link: (routes) => async (request, response, url, method) => {
      if (url.pathname.endsWith("/agent-version")) throw new HttpError(404, "not_found", "Not found");
      return routes(request, response, url, method);
    },
  });
  const hub = await startHub(context, old.address);
  assert.equal(await hub.conversations.agentVersion(`link_1!${OPENCODE_PANE}`), null);
});

test("a connected PC that does not know OpenCode says to update it, not that chat is unsupported", async (context) => {
  // An older HerdRabbit has the conversation routes but answers an agent it
  // does not know as not_supported_agent.
  const desk = await startDesk(context, {
    link: (routes) => async (request, response, url, method) => {
      if (/\/(conversation|pending-ask)/u.test(url.pathname) && url.pathname.includes(encodeURIComponent(OPENCODE_PANE))) {
        throw new ConversationUnavailable("not_supported_agent");
      }
      return routes(request, response, url, method);
    },
  });
  const { get, conversations } = await startHub(context, desk.address);
  const opencode = `/api/panes/${encodeURIComponent(`link_1!${OPENCODE_PANE}`)}`;
  const response = await get(`${opencode}/conversation`);
  assert.equal(response.status, 404);
  assert.deepEqual((await response.json()).error.details, { reason: "linked_pc_old" });
  await assert.rejects(conversations.toolOutput(`link_1!${OPENCODE_PANE}`, "toolu_big"), (error) => error.reason === "linked_pc_old");
  // a pane whose agent this hub does not support keeps the PC's own answer
  const shell = await (await get(`/api/panes/${encodeURIComponent("link_1!hs_ZGVmYXVsdA~w1:p2")}/conversation`)).json();
  assert.equal(shell.error.details.reason, "not_supported_agent");
});
