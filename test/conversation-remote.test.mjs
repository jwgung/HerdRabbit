import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineFiles, shellQuote } from "../src/machine-files.mjs";
import { claudeProjectDir } from "../src/conversation/claude.mjs";
import { forgetCodexState } from "../src/conversation/codex.mjs";
import { forgetConversationState } from "../src/conversation/pages.mjs";
import { ConversationMonitor } from "../src/conversation/monitor.mjs";
import { ConversationService } from "../src/conversation/service.mjs";
import { REMOTE_LIMITS, machineTranscriptStore } from "../src/conversation/stores.mjs";

const SESSION = "0d3f6c1e-8a3b-4c55-9d2e-6f7a8b9c0d1e";
const SERVER = "machine-4c139ff50dfb";
const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

// Stands in for ssh, as in machine-files.test.mjs: the remote command runs in
// a local shell with the machine's home.
function fakeSsh(home, env = {}) {
  const commands = [];
  const spawnProcess = (binary, args, options) => {
    assert.equal(binary, "ssh");
    commands.push(args.at(-1));
    const child = spawn("sh", ["-c", args.at(-1)], { ...options, cwd: home, env: { ...process.env, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", HOME: home, ...env } });
    child.kill = () => { child.stdin?.destroy(); child.stdout?.destroy(); return true; };
    return child;
  };
  return { commands, spawnProcess };
}

const fakeLink = () => ({
  ssh: "ssh", state: "ready",
  sshArgs: (options, ...command) => ["-S", "/run/x.ctl", ...options, "--", "me@lab", ...command],
});

async function machine(context, env) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-remote-claude-")));
  context.after(() => rm(home, { recursive: true, force: true }));
  const ssh = fakeSsh(home, typeof env === "function" ? env(home) : env);
  const link = fakeLink();
  const files = new MachineFiles({ link: () => link, spawnProcess: ssh.spawnProcess });
  return { home, files, ...ssh };
}

async function transcriptIn(configDir, project, session = SESSION, text = jsonl([{ type: "user", message: { role: "user", content: "hello" } }])) {
  await mkdir(join(configDir, "projects", project), { recursive: true });
  const path = join(configDir, "projects", project, `${session}.jsonl`);
  await writeFile(path, text);
  return path;
}

test("finds a remote transcript by project, then by scanning, with every value quoted on its own", async (context) => {
  const { home, files, commands } = await machine(context);
  assert.equal(await files.locateClaudeTranscript(SESSION, [claudeProjectDir("/srv/app")]), null);
  const path = await transcriptIn(join(home, ".claude"), claudeProjectDir("/srv/app"));
  assert.equal(await files.locateClaudeTranscript(SESSION, [claudeProjectDir("/srv/app")]), path);
  const elsewhere = await transcriptIn(join(home, ".claude"), "-other", "11111111-1111-4111-8111-111111111111");
  assert.equal(await files.locateClaudeTranscript("11111111-1111-4111-8111-111111111111", ["-srv-app"]), elsewhere);
  const command = commands.at(-1);
  assert.ok(command.startsWith("sh -c '"));
  assert.ok(command.endsWith(` herdrabbit ${shellQuote("11111111-1111-4111-8111-111111111111")} ${shellQuote("-srv-app")}`));
});

test("uses the machine's CLAUDE_CONFIG_DIR when its SSH environment sets one", async (context) => {
  const { home, files } = await machine(context, (dir) => ({ CLAUDE_CONFIG_DIR: join(dir, "work-claude") }));
  await transcriptIn(join(home, ".claude"), "-srv-app");
  const path = await transcriptIn(join(home, "work-claude"), "-srv-app");
  assert.equal(await files.locateClaudeTranscript(SESSION, ["-srv-app"]), path);
});

test("refuses unsafe session ids, project names and paths before anything runs", async (context) => {
  const { files, commands } = await machine(context);
  await assert.rejects(files.locateClaudeTranscript("$(touch pwned)", []), { code: "invalid_path" });
  await assert.rejects(files.locateClaudeTranscript(SESSION, ["a;b"]), { code: "invalid_path" });
  await assert.rejects(files.locateClaudeTranscript(SESSION, ["-ok", "../up"]), { code: "invalid_path" });
  for (const path of ["relative.jsonl", "/tmp/x.txt", "/tmp/new\nline.jsonl", "/tmp/back\\slash.jsonl", "/tmp/nul\u0000.jsonl"]) {
    await assert.rejects(files.transcriptStat(path), { code: "invalid_path" });
    await assert.rejects(files.readTranscriptRange(path, 0, 10), { code: "invalid_path" });
  }
  await assert.rejects(files.readTranscriptRange("/tmp/x.jsonl", -1, 10), { code: "invalid_range" });
  assert.equal(commands.length, 0);
});

test("stats and reads byte ranges of a remote transcript, capped per read", async (context) => {
  const { home, files } = await machine(context);
  const path = await transcriptIn(join(home, ".claude"), "-srv-app", SESSION, "0123456789");
  const stat = await files.transcriptStat(path);
  assert.equal(stat.size, 10);
  assert.match(stat.identity, /^[0-9a-z]+-[0-9a-z]+$/u);
  assert.equal(typeof stat.mtimeMs, "number");
  assert.equal((await files.readTranscriptRange(path, 3, 4)).toString(), "3456");
  assert.equal((await files.readTranscriptRange(path, 8, 100)).toString(), "89");
  assert.equal(await files.transcriptStat(join(home, "gone.jsonl")), null);
  const big = await transcriptIn(join(home, ".claude"), "-big", SESSION, "x".repeat(5 * 1024 * 1024));
  assert.equal((await files.readTranscriptRange(big, 0, 5 * 1024 * 1024)).length, 4 * 1024 * 1024);
});

test("pages a herdr machine pane's conversation over SSH, a window at a time", async (context) => {
  forgetConversationState();
  const { home, files, commands } = await machine(context);
  await transcriptIn(join(home, ".claude"), claudeProjectDir("/srv/app"), SESSION, jsonl(Array.from({ length: 70 }, (_, n) => [
    { type: "user", message: { role: "user", content: `prompt ${n}` } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: "ls" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: `out ${n}` }] } },
  ]).flat()));
  const herdr = {
    async snapshot() {
      return { panes: [{ pane_id: `${SERVER}!w1:p1`, server_id: SERVER, agent: "claude", agent_session: { kind: "id", value: SESSION }, cwd: "/srv/app" }] };
    },
    fileClient: (serverId) => (serverId === SERVER ? files : null),
  };
  const service = new ConversationService({ herdr, localStore: { key: "local" } });
  const page = await service.page(`${SERVER}!w1:p1`);
  assert.equal(page.turns[0].parts[0].text, "prompt 20");
  assert.equal(page.turns.at(-1).parts[0].output, "out 69");
  const older = await service.page(`${SERVER}!w1:p1`, { before: page.cursor });
  assert.equal(older.turns[0].parts[0].text, "prompt 0");
  assert.deepEqual(await service.toolOutput(`${SERVER}!w1:p1`, "toolu_3"), { id: "toolu_3", output: "out 3", output_size: 5, truncated: false });
  // reads never ask for more than a remote window
  const lengths = commands.filter((command) => command.includes("tail -c")).map((command) => Number(command.match(/'(\d+)' 'follow'$/u)[1]));
  assert.ok(lengths.length > 0 && lengths.every((length) => length <= REMOTE_LIMITS.windowBytes));
});

test("the same herdr machine pane resolves to one store, so the monitor does not re-stat after a re-resolve", async (context) => {
  forgetConversationState();
  const { home, files } = await machine(context);
  await transcriptIn(join(home, ".claude"), claudeProjectDir("/srv/app"));
  let stats = 0;
  const counted = {
    locateClaudeTranscript: (...args) => files.locateClaudeTranscript(...args),
    transcriptStat: (path) => { stats += 1; return files.transcriptStat(path); },
    readTranscriptRange: (...args) => files.readTranscriptRange(...args),
  };
  const herdr = {
    async snapshot() {
      return { panes: [{ pane_id: `${SERVER}!w1:p1`, server_id: SERVER, agent: "claude", agent_session: { kind: "id", value: SESSION }, cwd: "/srv/app" }] };
    },
    fileClient: (serverId) => (serverId === SERVER ? counted : null),
  };
  const service = new ConversationService({ herdr, localStore: { key: "local" } });
  const paneId = `${SERVER}!w1:p1`;
  assert.equal((await service.resolve(paneId)).store, (await service.resolve(paneId)).store);
  // finding the file stats it once; the counts below are the monitor's own
  const located = stats;
  let now = 0;
  const monitor = new ConversationMonitor({ resolve: (id) => service.resolve(id), statIntervalMs: 5, resolveIntervalMs: 20, now: () => now });
  context.after(() => monitor.stop());
  monitor.watch(paneId, () => {});
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stats - located, 1);
  // the pane is looked up again (20 ms on) well before the next remote stat (1.5 s): the target is the same one
  now += 30;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stats - located, 1);
});

test("a machine store's limits are the slower link's", () => {
  const store = machineTranscriptStore(SERVER, {});
  assert.equal(store.remote, true);
  assert.equal(store.key, SERVER);
  assert.ok(store.windowBytes <= 1024 * 1024);
});

// ---------------------------------------------------------------------------
// Codex on a Herdr machine.

const THREAD = "019da5c2-66fd-7021-b565-5e94406b028e";

async function rolloutIn(codexHome, thread = THREAD, text = jsonl([
  { type: "session_meta", payload: { id: thread, cwd: "/srv/app", source: "cli" } },
  { type: "event_msg", payload: { type: "task_started" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } },
  { type: "response_item", payload: { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "a b" } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "hi" }] } },
]), day = "2026/09/22") {
  const folder = join(codexHome, "sessions", ...day.split("/"));
  await mkdir(folder, { recursive: true });
  const path = join(folder, `rollout-2026-09-22T01-00-00-${thread}.jsonl`);
  await writeFile(path, text);
  return path;
}

test("finds a remote Codex rollout by its thread, in the machine's CODEX_HOME", async (context) => {
  const { home, files, commands } = await machine(context);
  assert.equal(await files.locateCodexRollout(THREAD), null);
  await rolloutIn(join(home, ".codex"), THREAD, undefined, "2026/09/01");
  const newest = await rolloutIn(join(home, ".codex"), THREAD, undefined, "2026/10/01");
  assert.equal(await files.locateCodexRollout(THREAD), newest);
  assert.ok(commands.at(-1).endsWith(` herdrabbit ${shellQuote(THREAD)}`));
  const elsewhere = await machine(context, (dir) => ({ CODEX_HOME: join(dir, "work-codex") }));
  await rolloutIn(join(elsewhere.home, ".codex"));
  const configured = await rolloutIn(join(elsewhere.home, "work-codex"));
  assert.equal(await elsewhere.files.locateCodexRollout(THREAD), configured);
  await assert.rejects(files.locateCodexRollout("$(touch pwned)"), { code: "invalid_path" });
});

test("takes a reported remote rollout only inside the machine's Codex sessions", async (context) => {
  const { home, files, commands } = await machine(context);
  const path = await rolloutIn(join(home, ".codex"));
  assert.equal(await files.codexRollout(path), path);
  assert.equal(await files.codexRollout(`${home}/.codex/sessions/2026/../2026/09/22/${path.split("/").at(-1)}`), path);
  const outside = join(home, "elsewhere.jsonl");
  await writeFile(outside, "{}\n");
  assert.equal(await files.codexRollout(outside), null);
  await symlink(outside, join(home, ".codex", "sessions", "2026", "09", "22", "link.jsonl"));
  assert.equal(await files.codexRollout(join(home, ".codex", "sessions", "2026", "09", "22", "link.jsonl")), null);
  const before = commands.length;
  for (const value of ["relative.jsonl", "/tmp/new\nline.jsonl", "/tmp/x.txt", 42]) assert.equal(await files.codexRollout(value), null);
  assert.equal(commands.length, before);
});

test("pages a herdr machine's Codex pane over SSH, by the thread or the path herdr reports", async (context) => {
  forgetConversationState();
  forgetCodexState();
  const { home, files } = await machine(context);
  const path = await rolloutIn(join(home, ".codex"));
  const panes = [
    { pane_id: `${SERVER}!w1:p1`, server_id: SERVER, agent: "codex", agent_session: { agent: "codex", kind: "id", value: THREAD }, cwd: "/srv/app" },
    { pane_id: `${SERVER}!w1:p2`, server_id: SERVER, agent: "codex", agent_session: { agent: "codex", kind: "path", value: path }, cwd: "/srv/app" },
    { pane_id: `${SERVER}!w1:p3`, server_id: SERVER, agent: "codex", agent_session: { agent: "codex", kind: "path", value: "/etc/passwd.jsonl" }, cwd: "/srv/app" },
  ];
  const herdr = { async snapshot() { return { panes }; }, fileClient: (serverId) => (serverId === SERVER ? files : null) };
  const service = new ConversationService({ herdr, localStore: { key: "local" } });
  for (const paneId of [`${SERVER}!w1:p1`, `${SERVER}!w1:p2`]) {
    const page = await service.page(paneId);
    assert.equal(page.source, "codex-transcript");
    assert.deepEqual(page.turns.map((turn) => turn.parts.map((part) => part.text ?? part.summary)), [["hello codex"], ["ls", "hi"]]);
  }
  assert.deepEqual(await service.toolOutput(`${SERVER}!w1:p1`, "call_1"), { id: "call_1", output: "a b", output_size: 3, truncated: false });
  await assert.rejects(service.page(`${SERVER}!w1:p3`), (error) => error.reason === "transcript_missing");
});
