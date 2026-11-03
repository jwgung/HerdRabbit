import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AGENT_COMMANDS, InstalledAgents } from "../src/agent-launch.mjs";
import { AGENTS } from "../public/agents.js";

async function binFolder(names, { mode = 0o755 } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "herdrabbit-agents-"));
  for (const name of names) {
    await writeFile(join(folder, name), "#!/bin/sh\n");
    await chmod(join(folder, name), mode);
  }
  return folder;
}

test("every agent the page knows has the command that starts it, and nothing else does", () => {
  assert.deepEqual(Object.keys(AGENT_COMMANDS), AGENTS.map((agent) => agent.name));
  for (const command of Object.values(AGENT_COMMANDS)) assert.match(command, /^[a-z][a-z0-9-]*$/u);
});

test("lists the agents whose command is an executable file on PATH, in the table's order", async () => {
  const one = await binFolder(["codex", "claude"]);
  const two = await binFolder(["kiro-cli", "cursor-agent"]);
  const notRunnable = await binFolder(["opencode"], { mode: 0o644 });
  const folderNamedAgy = await mkdtemp(join(tmpdir(), "herdrabbit-agents-"));
  await mkdir(join(folderNamedAgy, "agy"));
  const agents = new InstalledAgents({
    searchPath: () => ["", "relative/bin", notRunnable, folderNamedAgy, one, two, one].join(delimiter),
  });
  assert.deepEqual(await agents.list(), ["claude", "codex", "kiro", "cursor"]);
});

test("an empty or missing PATH has no agents", async () => {
  assert.deepEqual(await new InstalledAgents({ searchPath: () => undefined }).list(), []);
  assert.deepEqual(await new InstalledAgents({ searchPath: () => "" }).list(), []);
});

test("looks at the disk once in a while, not on every question, and never runs anything", async () => {
  const looked = [];
  let clock = 1_000;
  const agents = new InstalledAgents({
    searchPath: () => "/opt/bin",
    isExecutable: async (path) => { looked.push(path); return path === "/opt/bin/claude"; },
    now: () => clock,
    ttlMs: 10_000,
  });
  const [first, second] = await Promise.all([agents.list(), agents.list()]);
  assert.deepEqual(first, ["claude"]);
  assert.deepEqual(second, ["claude"]);
  assert.equal(looked.length, Object.keys(AGENT_COMMANDS).length, "two questions at once share one look");
  clock += 9_999;
  await agents.list();
  assert.equal(looked.length, Object.keys(AGENT_COMMANDS).length);
  clock += 2;
  await agents.list();
  assert.equal(looked.length, 2 * Object.keys(AGENT_COMMANDS).length, "an old answer is looked up again");
});

test("a look that fails is not kept", async () => {
  let fail = true;
  const agents = new InstalledAgents({
    searchPath: () => "/opt/bin",
    isExecutable: async () => { if (fail) throw new Error("disk"); return true; },
  });
  await assert.rejects(agents.list(), /disk/u);
  fail = false;
  assert.equal((await agents.list()).length, Object.keys(AGENT_COMMANDS).length);
});
