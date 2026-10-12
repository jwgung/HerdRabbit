import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineFiles, shellQuote } from "../src/machine-files.mjs";
import { claudeProjectDir, forgetConversationState } from "../src/conversation/claude.mjs";
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
    const child = spawn("sh", ["-c", args.at(-1)], { ...options, cwd: home, env: { ...process.env, CLAUDE_CONFIG_DIR: "", HOME: home, ...env } });
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

test("a machine store's limits are the slower link's", () => {
  const store = machineTranscriptStore(SERVER, {});
  assert.equal(store.remote, true);
  assert.equal(store.key, SERVER);
  assert.ok(store.windowBytes <= 1024 * 1024);
});
