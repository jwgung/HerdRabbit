import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCommandSource, agentExecutable, parseClaudeCommands, parseCodexSlashCommands } from "../src/agent-commands.mjs";
const agentVersion = async (...args) => (await agentExecutable(...args))?.version ?? null;

async function temp(context) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "herdrabbit-agent-commands-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// The shape of codex-rs/tui/src/slash_command.rs.
const CODEX_SOURCE = `
pub enum SlashCommand {
    // DO NOT ALPHA-SORT! Enum order is presentation order in the popup.
    Model,
    #[strum(serialize = "setup-default-sandbox")]
    ElevateSandbox,
    #[strum(to_string = "approve")]
    AutoReview,
    Ide,
    Copy,
    App,
    Quit,
    Exit,
    Rollout,
    // Debugging commands.
    #[strum(serialize = "debug-m-drop")]
    MemoryDrop,
}

impl SlashCommand {
    /// User-visible description shown in the popup.
    pub fn description(self) -> &'static str {
        match self {
            SlashCommand::Model => "choose what model and reasoning effort to use",
            SlashCommand::ElevateSandbox => "set up elevated agent sandbox",
            SlashCommand::AutoReview => "approve one retry of a recent auto-review denial",
            SlashCommand::Ide => {
                "include current selection, open files, and other context from your IDE"
            }
            SlashCommand::Copy => "copy the last response or part of it",
            SlashCommand::App => "continue this session in the Desktop app",
            SlashCommand::Quit | SlashCommand::Exit => "exit Codex",
            SlashCommand::Rollout => "print the rollout file path",
            SlashCommand::MemoryDrop => "DO NOT USE",
        }
    }

    fn is_visible(self) -> bool {
        match self {
            SlashCommand::Copy => !cfg!(target_os = "android"),
            SlashCommand::App => cfg!(any(target_os = "macos", target_os = "windows")),
            SlashCommand::Rollout => cfg!(debug_assertions),
            _ => true,
        }
    }
}
`;

test("reads Codex's popup from its source: order, names, descriptions, and what a Linux build hides", () => {
  assert.deepEqual(parseCodexSlashCommands(CODEX_SOURCE), [
    { name: "model", description: "Choose what model and reasoning effort to use" },
    { name: "setup-default-sandbox", description: "Set up elevated agent sandbox" },
    { name: "approve", description: "Approve one retry of a recent auto-review denial" },
    { name: "ide", description: "Include current selection, open files, and other context from your IDE" },
    { name: "copy", description: "Copy the last response or part of it" },
    { name: "quit", description: "Exit Codex" },
    { name: "exit", description: "Exit Codex" },
  ]);
  assert.deepEqual(parseCodexSlashCommands("not rust"), []);
});

// A process whose executable is `target`, under a fake /proc.
async function process(procRoot, pid, target) {
  await mkdir(join(procRoot, String(pid)), { recursive: true });
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, "");
  await symlink(target, join(procRoot, String(pid), "exe"));
}

test("reads the version of the agent a pane runs from where its executable is installed", async (context) => {
  const root = await temp(context);
  const procRoot = join(root, "proc");
  await process(procRoot, 10, join(root, "codex", "packages", "standalone", "releases", "0.167.0-x86_64-unknown-linux-musl", "bin", "codex"));
  await process(procRoot, 11, join(root, "claude", "versions", "2.1.319"));
  await process(procRoot, 12, join(root, "usr", "bin", "bash"));
  const pids = (...list) => list.map((pid) => ({ pid }));
  assert.equal(await agentVersion("codex", pids(12, 10), { procRoot }), "0.167.0");
  assert.equal(await agentVersion("claude", pids(11), { procRoot }), "2.1.319");
  assert.equal(await agentVersion("codex", pids(12), { procRoot }), null, "a shell is no Codex");
  assert.equal(await agentVersion("claude", pids(10), { procRoot }), null, "Codex is no Claude");
  assert.equal(await agentVersion("codex", pids(99, -1), { procRoot }), null, "a process gone or no pid");
  assert.equal(await agentVersion("kiro", pids(10), { procRoot }), null);
  // an agent updated while it runs: its executable is gone, its link says so
  await mkdir(join(procRoot, "13"), { recursive: true });
  await symlink(join(root, "claude", "versions", "2.1.312 (deleted)"), join(procRoot, "13", "exe"));
  assert.equal(await agentVersion("claude", pids(13), { procRoot }), "2.1.312");
});

test("fetches a Codex version's commands once, keeps them on disk, and says nothing when it cannot", async (context) => {
  const root = await temp(context);
  const cacheDir = join(root, "cache");
  const asked = [];
  let answer = () => new Response(CODEX_SOURCE);
  const fetch = async (url) => { asked.push(url); return answer(); };
  const source = new AgentCommandSource({ cacheDir, fetch });
  const commands = await source.builtIn("codex", "0.167.0");
  assert.deepEqual(commands.map((command) => command.name), ["model", "setup-default-sandbox", "approve", "ide", "copy", "quit", "exit"]);
  assert.ok(commands.every((command) => command.source === "built-in"));
  assert.deepEqual(asked, ["https://raw.githubusercontent.com/openai/codex/rust-v0.167.0/codex-rs/tui/src/slash_command.rs"]);
  await source.builtIn("codex", "0.167.0");
  assert.equal(asked.length, 1, "kept in memory");
  // a server started later reads what was kept, without asking again
  const later = new AgentCommandSource({ cacheDir, fetch });
  assert.deepEqual(await later.builtIn("codex", "0.167.0"), commands);
  assert.equal(asked.length, 1);
  assert.deepEqual(await readdir(cacheDir), ["codex-0.167.0.json"]);

  // a version the source cannot be had for: nothing, and not asked again for a while
  answer = () => new Response("", { status: 404 });
  let now = 0;
  const failing = new AgentCommandSource({ cacheDir, fetch, now: () => now });
  assert.equal(await failing.builtIn("codex", "0.168.0"), null);
  assert.equal(await failing.builtIn("codex", "0.168.0"), null);
  assert.equal(asked.length, 2);
  now = 2 * 60 * 60 * 1000;
  answer = () => new Response(CODEX_SOURCE);
  assert.equal((await failing.builtIn("codex", "0.168.0")).length, 7, "asked again after a while");

  // no version, an agent it has no source for, a version that is not one
  assert.equal(await source.builtIn("codex", null), null);
  assert.equal(await source.builtIn("kiro", "2.35.1"), null);
  assert.equal(await source.builtIn("codex", "../../etc"), null);
  assert.equal(asked.length, 3);
});

// What Claude Code answers an initialize request with, among its other lines.
const claudeAnswer = (commands) => [
  JSON.stringify({ type: "system", subtype: "ui_invalidate" }),
  "not json",
  JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "herdrabbit-commands", response: { commands, claude_code_version: "2.1.400" } } }),
].join("\n");

test("reads Claude Code's own commands from its initialize answer, less the hidden and the user's", () => {
  const command = (name, description, extra = {}) => ({ name, description, argumentHint: "", builtin: true, ...extra });
  assert.deepEqual(parseClaudeCommands(claudeAnswer([
    command("compact", "Free up context by summarizing the conversation so far"),
    command("brand-new", `Only in a later version\n\twith  a long tail ${"x".repeat(300)}`),
    command("__remote-workflow", "internal"),
    command("extra-usage", "Renamed to /usage-credits"),
    command("my-skill", "Mine (user)", { builtin: false }),
    command("Bad Name", "not a command name"),
    command("compact", "twice"),
  ])), [
    { name: "compact", description: "Free up context by summarizing the conversation so far" },
    { name: "brand-new", description: `Only in a later version with a long tail ${"x".repeat(158)}…` },
  ]);
  assert.deepEqual(parseClaudeCommands("nothing it said"), []);
});

test("asks the pane's own Claude Code build for its commands, without its settings, hooks or MCP servers", async (context) => {
  const root = await temp(context);
  const runs = [];
  const source = new AgentCommandSource({
    cacheDir: join(root, "cache"),
    runClaude: async (executable, args) => { runs.push([executable, args]); return claudeAnswer([{ name: "compact", description: "Compact", builtin: true }]); },
  });
  assert.equal(await source.builtIn("claude", "2.1.400"), null, "with no executable to ask, nothing");
  const commands = await source.builtIn("claude", "2.1.400", { executable: "/opt/claude/versions/2.1.400" });
  assert.deepEqual(commands, [{ name: "compact", description: "Compact", source: "built-in" }]);
  assert.deepEqual(runs, [["/opt/claude/versions/2.1.400", [
    "-p", "--setting-sources", "", "--strict-mcp-config", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  ]]]);
  await new AgentCommandSource({ cacheDir: join(root, "cache"), runClaude: async () => { throw new Error("asked again"); } })
    .builtIn("claude", "2.1.400", { executable: "/x" })
    .then((kept) => assert.deepEqual(kept, commands));
});

test("names the executable to ask: its path, or the process's own link to it once it was updated away", async (context) => {
  const root = await temp(context);
  const procRoot = join(root, "proc");
  const installed = join(root, "claude", "versions", "2.1.319");
  await process(procRoot, 20, installed);
  await mkdir(join(procRoot, "21"), { recursive: true });
  await symlink(join(root, "claude", "versions", "2.1.312 (deleted)"), join(procRoot, "21", "exe"));
  assert.deepEqual(await agentExecutable("claude", [{ pid: 20 }], { procRoot }), { version: "2.1.319", path: installed });
  assert.deepEqual(await agentExecutable("claude", [{ pid: 21 }], { procRoot }), { version: "2.1.312", path: join(procRoot, "21", "exe") });
  assert.equal(await agentExecutable("claude", [{ pid: 22 }], { procRoot }), null);
});

test("holds every source to command names a typed /name can be, and one-line descriptions", async (context) => {
  const root = await temp(context);
  const cacheDir = join(root, "cache");
  await mkdir(cacheDir, { recursive: true });
  // a kept file someone else wrote: only what a list here could be is taken from it
  await writeFile(join(cacheDir, "codex-0.200.0.json"), JSON.stringify([
    { name: "model", description: "Pick\none\u0007" },
    { name: "bad\nname", description: "x" },
    { name: "a b", description: "x" },
    { name: "model", description: "twice" },
    { name: 3 },
  ]));
  const source = new AgentCommandSource({ cacheDir, fetch: async () => { throw new Error("not asked"); } });
  assert.deepEqual(await source.builtIn("codex", "0.200.0"), [{ name: "model", description: "Pick one", source: "built-in" }]);
  // a release source naming a command no /name can be
  const odd = CODEX_SOURCE.replace('#[strum(to_string = "approve")]', '#[strum(to_string = "ap prove")]');
  assert.deepEqual(parseCodexSlashCommands(odd).map((command) => command.name), ["model", "setup-default-sandbox", "ide", "copy", "quit", "exit"]);
});

test("refuses a release source larger than any slash_command.rs, without reading it whole", async (context) => {
  const root = await temp(context);
  let read = 0;
  const huge = new ReadableStream({
    pull(controller) {
      read += 1;
      if (read > 100) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const source = new AgentCommandSource({ cacheDir: join(root, "cache"), fetch: async () => new Response(huge) });
  assert.equal(await source.builtIn("codex", "0.300.0"), null);
  assert.ok(read < 20, `read ${read} chunks`);
  // a source that would read well, said to be far larger than one: refused for what it says
  const declared = new AgentCommandSource({
    cacheDir: join(root, "cache"),
    fetch: async () => new Response(CODEX_SOURCE, { headers: { "content-length": String(10 * 1024 * 1024) } }),
  });
  assert.equal(await declared.builtIn("codex", "0.300.1"), null);
  // and one that cannot be read a piece at a time is not read at all
  const whole = new AgentCommandSource({
    cacheDir: join(root, "cache"),
    fetch: async () => ({ ok: true, headers: new Headers(), body: null, text: async () => CODEX_SOURCE }),
  });
  assert.equal(await whole.builtIn("codex", "0.300.2"), null);
  // the same source, as a release serves it, reads
  const served = new AgentCommandSource({ cacheDir: join(root, "cache"), fetch: async () => new Response(CODEX_SOURCE) });
  assert.equal((await served.builtIn("codex", "0.300.3")).length, 7);
});

test("keeps a version's list where only this user can read it, never writing through what is already there", async (context) => {
  const root = await temp(context);
  const cacheDir = join(root, "cache");
  await mkdir(cacheDir, { recursive: true, mode: 0o755 });
  // something put in the list's place, pointing elsewhere: replaced, not written through
  const elsewhere = join(root, "elsewhere.json");
  await writeFile(elsewhere, "untouched");
  await symlink(elsewhere, join(cacheDir, "codex-0.167.0.json"));
  const source = new AgentCommandSource({ cacheDir, fetch: async () => new Response(CODEX_SOURCE) });
  assert.equal((await source.builtIn("codex", "0.167.0")).length, 7);
  assert.equal(await readFile(elsewhere, "utf8"), "untouched");
  const kept = await lstat(join(cacheDir, "codex-0.167.0.json"));
  assert.ok(kept.isFile());
  assert.equal(kept.mode & 0o777, 0o600);
  assert.equal((await stat(cacheDir)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(cacheDir), ["codex-0.167.0.json"], "no partial file left behind");
});
