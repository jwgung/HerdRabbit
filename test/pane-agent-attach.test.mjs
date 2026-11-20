import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachedClaudePanes, attachedJobShort } from "../src/pane-attach.mjs";

const SHORT = "c802cce8";
const SESSION = "c802cce8-aba6-4132-b5b6-73e4462a3906";
const VERSIONED = "/mnt/data/dev/local/share/claude/versions/2.1.329";

async function config(state = { state: "blocked", sessionId: SESSION, daemonShort: SHORT, cwd: "/work/repo", forkParentSessionId: "11111111-2222-4333-8444-555555555555" }) {
  const dir = await mkdtemp(join(tmpdir(), "attach-"));
  await mkdir(join(dir, "jobs", SHORT), { recursive: true });
  await writeFile(join(dir, "jobs", SHORT, "state.json"), JSON.stringify(state));
  return dir;
}

function fakeHerdr(table) {
  const calls = [];
  return { calls, async paneProcessInfo(id) { calls.push(id); return { process_info: { foreground_processes: table[id] ?? [] } }; } };
}

const attach = (argv) => [{ pid: 7, name: "x", argv }];
const pane = (id, extra = {}) => ({ pane_id: id, terminal_id: `t-${id}`, agent_status: "unknown", ...extra });

test("an attach client becomes a Claude pane on the job's session", async () => {
  const dir = await config();
  const herdr = fakeHerdr({ "w1:p1": attach([VERSIONED, "attach", SHORT]) });
  const snapshot = { panes: [pane("w1:p1")] };
  await new AttachedClaudePanes({ configDir: dir }).enrich(snapshot, herdr);
  assert.equal(snapshot.panes[0].agent, "claude");
  assert.deepEqual(snapshot.panes[0].agent_session, { agent: "claude", kind: "id", source: "herdrabbit:attach", value: SESSION });
  assert.equal(snapshot.panes[0].agent_status, "blocked");
  await rm(dir, { recursive: true });
});

test("a plain claude executable counts, other programs and shapes do not", () => {
  assert.equal(attachedJobShort({ argv: ["/usr/bin/claude", "attach", SHORT] }), SHORT);
  assert.equal(attachedJobShort({ argv: ["/usr/bin/vim", "attach", SHORT] }), null);
  assert.equal(attachedJobShort({ argv: [VERSIONED, "resume", SHORT] }), null);
  assert.equal(attachedJobShort({ argv: [VERSIONED, "attach", "zzz"] }), null);
  assert.equal(attachedJobShort({ argv: [VERSIONED, "attach"] }), null);
});

test("an unknown job, or a state without this job's session, leaves the pane alone", async () => {
  const dir = await config({ state: "idle", sessionId: "99999999-aba6-4132-b5b6-73e4462a3906" });
  const herdr = fakeHerdr({ "w1:p1": attach([VERSIONED, "attach", SHORT]), "w1:p2": attach([VERSIONED, "attach", "deadbeef"]) });
  const snapshot = { panes: [pane("w1:p1"), pane("w1:p2")] };
  await new AttachedClaudePanes({ configDir: dir }).enrich(snapshot, herdr);
  for (const item of snapshot.panes) assert.equal(item.agent, undefined);
  await rm(dir, { recursive: true });
});

test("a pane herdr already names an agent for is never looked at or changed", async () => {
  const dir = await config();
  const herdr = fakeHerdr({ "w1:p1": attach([VERSIONED, "attach", SHORT]) });
  const own = { pane_id: "w1:p1", agent: "codex", agent_status: "working", agent_session: { agent: "codex", kind: "id", value: "abc" } };
  const viaSession = { pane_id: "w1:p2", agent_session: { agent: "claude", kind: "id", value: "x" } };
  const snapshot = { panes: [own, viaSession] };
  const before = JSON.stringify(snapshot);
  await new AttachedClaudePanes({ configDir: dir }).enrich(snapshot, herdr);
  assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(herdr.calls, []);
  await rm(dir, { recursive: true });
});

test("a pane's process is asked once inside the TTL, then again in the background", async () => {
  const dir = await config();
  const herdr = fakeHerdr({ "w1:p1": attach([VERSIONED, "attach", SHORT]), "w1:p2": [] });
  let clock = 0;
  const enricher = new AttachedClaudePanes({ configDir: dir, now: () => clock });
  for (let i = 0; i < 3; i++) await enricher.enrich({ panes: [pane("w1:p1"), pane("w1:p2")] }, herdr);
  assert.equal(herdr.calls.length, 2);
  clock = 60_000;
  const snapshot = { panes: [pane("w1:p1")] };
  await enricher.enrich(snapshot, herdr);
  assert.equal(snapshot.panes[0].agent, "claude", "the stale answer still serves");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(herdr.calls.length, 3);
  await rm(dir, { recursive: true });
});

test("a herdr that cannot tell leaves panes alone", async () => {
  const snapshot = { panes: [pane("w1:p1")] };
  await new AttachedClaudePanes({ configDir: "/nonexistent" }).enrich(snapshot, {});
  assert.equal(snapshot.panes[0].agent, undefined);
});
