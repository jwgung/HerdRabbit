// When a pane's agent process started, from Linux's /proc: what a guessed
// session (the folder's newest) is checked against, so a conversation recorded
// before the agent started is never shown as its new one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartedAt } from "../src/conversation/process-start.mjs";

async function fakeProc(context, { btime = 1_800_000_000, processes = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "herdrabbit-proc-start-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "stat"), `cpu  1 2 3 4\nbtime ${btime}\nprocesses 9\n`);
  for (const [pid, { comm = "agent", ticks }] of Object.entries(processes)) {
    await mkdir(join(root, pid), { recursive: true });
    // fields 3..21 before starttime (field 22); the name may hold spaces and parens
    const before = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1))];
    await writeFile(join(root, pid, "stat"), `${pid} (${comm}) ${[...before, String(ticks), "0", "0"].join(" ")}\n`);
  }
  return root;
}

test("the earliest start of the pane's processes, in ms since the epoch", async (context) => {
  const procRoot = await fakeProc(context, { processes: { 100: { ticks: 5_000 }, 101: { comm: "a (b) c", ticks: 4_000 } } });
  const startedAt = processStartedAt({ procRoot, ticksPerSecond: 100 });
  assert.equal(await startedAt([100, 101]), 1_800_000_000_000 + 40_000);
  assert.equal(await startedAt([100]), 1_800_000_000_000 + 50_000);
});

test("no start where nothing can be read: no pids, a gone process, or no /proc", async (context) => {
  const procRoot = await fakeProc(context, { processes: { 100: { ticks: 5_000 } } });
  const startedAt = processStartedAt({ procRoot, ticksPerSecond: 100 });
  assert.equal(await startedAt([]), null);
  assert.equal(await startedAt([999]), null);
  assert.equal(await startedAt([999, 100]), 1_800_000_000_000 + 50_000);
  assert.equal(await startedAt(["x", -1, 1.5]), null);
  assert.equal(await processStartedAt({ procRoot: join(procRoot, "missing") })([100]), null);
});
