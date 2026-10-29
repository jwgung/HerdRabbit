import test from "node:test";
import assert from "node:assert/strict";
import {
  HerdrBridgeClient,
  sessionIds,
} from "../src/herdr-bridge-client.mjs";
import { InputValidationError } from "../src/herdr-client.mjs";

function recordingRunner(responses) {
  const calls = [];
  const runner = async (binary, args) => {
    calls.push({ binary, args });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, runner };
}

function snapshot(label) {
  return {
    protocol: 1,
    version: "0.8.2",
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    workspaces: [{ workspace_id: "w1", active_tab_id: "w1:t1", label }],
    tabs: [{ workspace_id: "w1", tab_id: "w1:t1", label: "1" }],
    panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" }],
    agents: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" }],
  };
}

test("aggregates running Herdr sessions with globally unique record ids", async () => {
  const sessions = [
    { name: "review", default: false, running: true },
    { name: "sleeping", default: false, running: false },
    { name: "default", default: true, running: true },
  ];
  const fake = recordingRunner([
    { stdout: JSON.stringify({ sessions }), stderr: "" },
    { stdout: JSON.stringify({ result: { snapshot: snapshot("기본") } }), stderr: "" },
    { stdout: JSON.stringify({ result: { snapshot: snapshot("리뷰") } }), stderr: "" },
  ]);
  const client = new HerdrBridgeClient({ binary: "/opt/herdr", runner: fake.runner });

  const result = await client.snapshot();
  const defaultSessionId = sessionIds.sessionIdForName("default");
  const reviewSessionId = sessionIds.sessionIdForName("review");

  assert.deepEqual(
    result.herdr_sessions.map(({ name, running, available }) => ({ name, running, available })),
    [
      { name: "default", running: true, available: true },
      { name: "review", running: true, available: true },
      { name: "sleeping", running: false, available: false },
    ],
  );
  assert.deepEqual(
    result.workspaces.map(({ workspace_id, herdr_session_id }) => ({
      workspace_id,
      herdr_session_id,
    })),
    [
      { workspace_id: `${defaultSessionId}~w1`, herdr_session_id: defaultSessionId },
      { workspace_id: `${reviewSessionId}~w1`, herdr_session_id: reviewSessionId },
    ],
  );
  assert.deepEqual(result.panes.map((pane) => pane.pane_id), [
    `${defaultSessionId}~w1:p1`,
    `${reviewSessionId}~w1:p1`,
  ]);
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["session", "list", "--json"],
    ["--session=default", "api", "snapshot"],
    ["--session=review", "api", "snapshot"],
  ]);
});

test("routes scoped workspace, tab and pane operations to their Herdr session", async () => {
  const ok = { stdout: "", stderr: "" };
  const renamed = { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
  const fake = recordingRunner([
    {
      stdout: JSON.stringify({
        sessions: [{ name: "review", default: false, running: true }],
      }),
      stderr: "",
    },
    {
      stdout: JSON.stringify({ result: { snapshot: snapshot("리뷰") } }),
      stderr: "",
    },
    ok,
    renamed,
    ok,
    renamed,
    ok,
    ok,
    { stdout: JSON.stringify({ result: { process_info: { foreground_processes: [] } } }), stderr: "" },
    ok,
    ok,
  ]);
  const client = new HerdrBridgeClient({ runner: fake.runner });
  const sessionId = sessionIds.sessionIdForName("review");

  await client.snapshot();
  await client.createWorkspace("새 프로젝트", sessionId);
  await client.renameWorkspace(`${sessionId}~w2`, "이름 변경");
  await client.createTab(`${sessionId}~w2`);
  await client.renameTab(`${sessionId}~w2:t3`, "배포 확인");
  await client.closeTab(`${sessionId}~w2:t3`);
  await client.readPane(`${sessionId}~w2:p3`, { lines: 20 });
  await client.paneProcessInfo(`${sessionId}~w2:p3`);
  await client.sendText(`${sessionId}~w2:p3`, "hello", { submit: true });
  await client.sendKeys(`${sessionId}~w2:p3`, ["ctrl+c"]);

  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["session", "list", "--json"],
    ["--session=review", "api", "snapshot"],
    ["--session=review", "workspace", "create", "--label", "새 프로젝트", "--no-focus"],
    ["--session=review", "workspace", "rename", "w2", "이름 변경"],
    ["--session=review", "tab", "create", "--workspace", "w2", "--no-focus"],
    ["--session=review", "tab", "rename", "w2:t3", "배포 확인"],
    ["--session=review", "tab", "close", "w2:t3"],
    ["--session=review", "pane", "read", "w2:p3", "--source", "recent-unwrapped", "--lines", "20", "--format", "ansi"],
    ["--session=review", "pane", "process-info", "--pane", "w2:p3"],
    ["--session=review", "pane", "run", "w2:p3", "hello"],
    ["--session=review", "pane", "send-keys", "w2:p3", "ctrl+c"],
  ]);
});

test("rejects forged or malformed scoped ids before invoking Herdr", async () => {
  const fake = recordingRunner([]);
  const client = new HerdrBridgeClient({ runner: fake.runner });

  await assert.rejects(
    () => client.readPane("w1:p1"),
    InputValidationError,
  );
  await assert.rejects(
    () => client.closeWorkspace("hs_%%%~w1"),
    InputValidationError,
  );
  await assert.rejects(
    () => client.closeWorkspace(`${sessionIds.sessionIdForName("unknown")}~w1`),
    InputValidationError,
  );
  assert.equal(fake.calls.length, 0);
});

test("pane splits are scoped to one Herdr session and come back with scoped ids", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const fake = recordingRunner([
    { stdout: JSON.stringify({ sessions: [{ name: "review", default: false, running: true }] }), stderr: "" },
    json({ snapshot: snapshot("리뷰") }),
    json({ pane: { pane_id: "w2:p3", cwd: "/x" } }),
    json({ pane: { pane_id: "w2:p4" } }),
  ]);
  const client = new HerdrBridgeClient({ runner: fake.runner });
  const sessionId = sessionIds.sessionIdForName("review");
  await client.snapshot();
  const result = await client.splitPane(`${sessionId}~w2:p3`, "down");
  assert.deepEqual(result, { pane_id: `${sessionId}~w2:p4` });
  assert.deepEqual(fake.calls[3].args.slice(0, 3), ["--session=review", "pane", "split"]);
  await assert.rejects(
    client.movePaneSplit(`${sessionId}~w2:p3`, `${sessionIds.sessionIdForName("other")}~w1:p1`, "left"),
    InputValidationError,
  );
});

test("a dropped pane that could not be swapped into place still comes back under its scoped id", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const refused = Object.assign(new Error("failed"), { stderr: JSON.stringify({ error: { code: "pane_swap_failed", message: "no swap" } }) });
  const fake = recordingRunner([
    { stdout: JSON.stringify({ sessions: [{ name: "review", default: false, running: true }] }), stderr: "" },
    json({ snapshot: snapshot("리뷰") }),
    json({ pane: { pane_id: "w2:p5", tab_id: "w2:t2" } }),
    json({ pane: { pane_id: "w2:p3", tab_id: "w2:t1" } }),
    json({ layout: { panes: [{ pane_id: "w2:p5", rect: { x: 0, y: 0, width: 5, height: 5 } }] } }),
    json({ pane: { pane_id: "w2:p6", tab_id: "w2:t1" } }),
    refused,
  ]);
  const client = new HerdrBridgeClient({ runner: fake.runner });
  const sessionId = sessionIds.sessionIdForName("review");
  await client.snapshot();
  assert.deepEqual(await client.movePaneSplit(`${sessionId}~w2:p5`, `${sessionId}~w2:p3`, "left"),
    { pane_id: `${sessionId}~w2:p6`, placed: false, message: "no swap" });
});

test("a pane layout names its panes by scoped id", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const fake = recordingRunner([
    { stdout: JSON.stringify({ sessions: [{ name: "review", default: false, running: true }] }), stderr: "" },
    json({ snapshot: snapshot("리뷰") }),
    json({ layout: { tab_id: "w2:t1", workspace_id: "w2", focused_pane_id: "w2:p3", zoomed: false, panes: [{ pane_id: "w2:p3", rect: { x: 0, y: 0, width: 5, height: 5 } }] } }),
  ]);
  const client = new HerdrBridgeClient({ runner: fake.runner });
  const sessionId = sessionIds.sessionIdForName("review");
  await client.snapshot();
  const { layout } = await client.paneLayout(`${sessionId}~w2:p3`);
  assert.equal(layout.panes[0].pane_id, `${sessionId}~w2:p3`);
  assert.equal(layout.focused_pane_id, `${sessionId}~w2:p3`);
  assert.equal(layout.tab_id, `${sessionId}~w2:t1`);
  assert.equal(layout.zoomed, false);
});

test("panes are swapped and relocated within one Herdr session, answered under scoped ids", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const layout = json({ layout: { tab_id: "w2:t1", workspace_id: "w2", zoomed: false,
    panes: [{ pane_id: "w2:p3", rect: { x: 0, y: 0, width: 5, height: 5 } }, { pane_id: "w2:p4", rect: { x: 5, y: 0, width: 5, height: 5 } }] } });
  const full = Object.assign(new Error("failed"), { stderr: JSON.stringify({ error: { code: "pane_split_failed", message: "no room" } }) });
  const fake = recordingRunner([
    { stdout: JSON.stringify({ sessions: [{ name: "review", default: false, running: true }] }), stderr: "" },
    json({ snapshot: snapshot("리뷰") }),
    layout, { stdout: "", stderr: "" },
    layout, json({ move_result: { pane: { pane_id: "w2:p3", tab_id: "w2:t9" }, created_tab: { tab_id: "w2:t9" } } }), full, full, full,
  ]);
  const client = new HerdrBridgeClient({ runner: fake.runner });
  const sessionId = sessionIds.sessionIdForName("review");
  await client.snapshot();
  assert.deepEqual(await client.swapPanes(`${sessionId}~w2:p3`, `${sessionId}~w2:p4`), { pane_id: `${sessionId}~w2:p3` });
  assert.deepEqual(fake.calls[3].args, ["--session=review", "pane", "swap", "--source-pane", "w2:p3", "--target-pane", "w2:p4"]);
  // Left in a session of its own: its pane and that session come back scoped.
  assert.deepEqual(await client.relocatePane(`${sessionId}~w2:p3`, `${sessionId}~w2:p4`, "right"), {
    pane_id: `${sessionId}~w2:p3`, placed: false, restored: false, tab_id: `${sessionId}~w2:t9`,
    message: "no room. The pane is in a session of its own now.",
  });
  const other = `${sessionIds.sessionIdForName("other")}~w1:p1`;
  await assert.rejects(client.swapPanes(`${sessionId}~w2:p3`, other), InputValidationError);
  await assert.rejects(client.relocatePane(`${sessionId}~w2:p3`, other, "left"), InputValidationError);
  assert.equal(fake.calls.length, 9, "nothing is asked across sessions");
});

test("a split tab is evened out within its Herdr session, answered under its scoped id", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const layout = (at) => json({ layout: { area: { x: 0, y: 0, width: 120, height: 40 }, zoomed: false, panes: [
    { pane_id: "w2:p3", rect: { x: 0, y: 0, width: at, height: 40 } }, { pane_id: "w2:p4", rect: { x: at, y: 0, width: 120 - at, height: 40 } }] } });
  const fake = recordingRunner([
    { stdout: JSON.stringify({ sessions: [{ name: "review", default: false, running: true }] }), stderr: "" },
    json({ snapshot: snapshot("리뷰") }),
    layout(30), { stdout: "", stderr: "" }, layout(60),
  ]);
  const client = new HerdrBridgeClient({ runner: fake.runner });
  const sessionId = sessionIds.sessionIdForName("review");
  await client.snapshot();
  assert.deepEqual(await client.evenLayout(`${sessionId}~w2:p4`), { pane_id: `${sessionId}~w2:p4`, changed: true, steps: 1, even: true });
  assert.deepEqual(fake.calls[3].args, ["--session=review", "pane", "resize", "--pane", "w2:p3", "--direction", "right", "--amount", "0.2500"]);
  await assert.rejects(client.evenLayout("w2:p4"), InputValidationError);
});

test("a pane moved out comes back under scoped pane and tab ids of its Herdr session", async () => {
  const json = (result) => ({ stdout: JSON.stringify({ result }), stderr: "" });
  const fake = recordingRunner([
    { stdout: JSON.stringify({ sessions: [{ name: "review", default: false, running: true }] }), stderr: "" },
    json({ snapshot: snapshot("리뷰") }),
    json({ layout: { panes: [{ pane_id: "w2:p3", rect: { x: 0, y: 0, width: 5, height: 5 } }, { pane_id: "w2:p4", rect: { x: 5, y: 0, width: 5, height: 5 } }] } }),
    json({ move_result: { pane: { pane_id: "w2:p4", tab_id: "w2:t7" }, created_tab: { tab_id: "w2:t7" } } }),
  ]);
  const client = new HerdrBridgeClient({ runner: fake.runner });
  const sessionId = sessionIds.sessionIdForName("review");
  await client.snapshot();
  assert.deepEqual(await client.movePaneOut(`${sessionId}~w2:p4`), { pane_id: `${sessionId}~w2:p4`, tab_id: `${sessionId}~w2:t7` });
  assert.deepEqual(fake.calls.at(-1).args, ["--session=review", "pane", "move", "w2:p4", "--new-tab", "--no-focus"]);
});
