#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const statePath = process.env.HERDR_FAKE_STATE;

function fail(message, code = "fake_error") {
  process.stderr.write(JSON.stringify({ error: { code, message } }));
  process.exit(1);
}

if (!statePath) {
  fail("HERDR_FAKE_STATE is required", "missing_fake_state");
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    fail("Fake Herdr state is unavailable", "fake_state_unavailable");
  }
}

async function saveState(state) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function success(result) {
  process.stdout.write(JSON.stringify({ id: "fake:herdr", result }));
}

const args = process.argv.slice(2);
const state = await loadState();

for (const [paneId, output] of Object.entries(state.outputs || {})) {
  if (output && typeof output === "object") {
    const filler = Array.from(
      { length: output.fillerLines || 0 },
      (_, index) => `이전 작업 기록 ${String(index + 1).padStart(3, "0")}`,
    );
    state.outputs[paneId] = [output.historyPrefix, ...filler, output.tail]
      .filter(Boolean)
      .join("\n");
  }
}

if (args[0] === "--version") {
  process.stdout.write("herdr 0.9.3\n");
  process.exit(0);
}

if (args[0] === "api" && args[1] === "snapshot") {
  success({ snapshot: state.snapshot });
  process.exit(0);
}

if (args[0] === "workspace" && args[1] === "rename") {
  const workspaceId = args[2];
  const label = args[3];
  const workspace = state.snapshot.workspaces.find(
    (item) => item.workspace_id === workspaceId,
  );
  if (!workspace) {
    fail("Workspace not found", "workspace_not_found");
  }
  workspace.label = label;
  await saveState(state);
  success({ workspace });
  process.exit(0);
}

if (args[0] === "workspace" && args[1] === "create") {
  const labelIndex = args.indexOf("--label");
  const label = labelIndex >= 0 ? args[labelIndex + 1] : "Workspace";
  const nextNumber = Math.max(
    0,
    ...state.snapshot.workspaces.map((item) => Number(item.workspace_id.slice(1)) || 0),
  ) + 1;
  const workspaceId = `w${nextNumber}`;
  const tabId = `${workspaceId}:t1`;
  const paneId = `${workspaceId}:p1`;
  state.snapshot.workspaces.push({ workspace_id: workspaceId, label });
  state.snapshot.tabs.push({ tab_id: tabId, workspace_id: workspaceId, label: "1" });
  state.snapshot.panes.push({ pane_id: paneId, tab_id: tabId, workspace_id: workspaceId, label: "Shell" });
  state.outputs[paneId] = "$ ";
  await saveState(state);
  success({ workspace_id: workspaceId, tab_id: tabId, pane_id: paneId });
  process.exit(0);
}

if (args[0] === "workspace" && args[1] === "close") {
  const workspaceId = args[2];
  const paneIds = state.snapshot.panes
    .filter((item) => item.workspace_id === workspaceId)
    .map((item) => item.pane_id);
  state.snapshot.workspaces = state.snapshot.workspaces.filter(
    (item) => item.workspace_id !== workspaceId,
  );
  state.snapshot.tabs = state.snapshot.tabs.filter(
    (item) => item.workspace_id !== workspaceId,
  );
  state.snapshot.panes = state.snapshot.panes.filter(
    (item) => item.workspace_id !== workspaceId,
  );
  state.snapshot.agents = state.snapshot.agents.filter(
    (item) => item.workspace_id !== workspaceId && !paneIds.includes(item.pane_id),
  );
  for (const paneId of paneIds) delete state.outputs[paneId];
  await saveState(state);
  success({ ok: true });
  process.exit(0);
}

if (args[0] === "tab" && args[1] === "create") {
  const workspaceIndex = args.indexOf("--workspace");
  const workspaceId = workspaceIndex >= 0 ? args[workspaceIndex + 1] : "";
  if (!state.snapshot.workspaces.some((item) => item.workspace_id === workspaceId)) {
    fail("Workspace not found", "workspace_not_found");
  }
  const workspaceTabs = state.snapshot.tabs.filter(
    (item) => item.workspace_id === workspaceId,
  );
  const nextTabNumber = Math.max(
    0,
    ...workspaceTabs.map((item) => Number(item.tab_id.split(":t")[1]) || 0),
  ) + 1;
  const workspacePanes = state.snapshot.panes.filter(
    (item) => item.workspace_id === workspaceId,
  );
  const nextPaneNumber = Math.max(
    0,
    ...workspacePanes.map((item) => Number(item.pane_id.split(":p")[1]) || 0),
  ) + 1;
  const tabId = `${workspaceId}:t${nextTabNumber}`;
  const paneId = `${workspaceId}:p${nextPaneNumber}`;
  state.snapshot.tabs.push({ tab_id: tabId, workspace_id: workspaceId, label: String(nextTabNumber) });
  state.snapshot.panes.push({ pane_id: paneId, tab_id: tabId, workspace_id: workspaceId, label: "Shell" });
  state.outputs[paneId] = "$ ";
  await saveState(state);
  success({ tab_id: tabId, pane_id: paneId });
  process.exit(0);
}

if (args[0] === "tab" && args[1] === "close") {
  const tabId = args[2];
  const paneIds = state.snapshot.panes
    .filter((item) => item.tab_id === tabId)
    .map((item) => item.pane_id);
  state.snapshot.tabs = state.snapshot.tabs.filter((item) => item.tab_id !== tabId);
  state.snapshot.panes = state.snapshot.panes.filter((item) => item.tab_id !== tabId);
  state.snapshot.agents = state.snapshot.agents.filter(
    (item) => item.tab_id !== tabId && !paneIds.includes(item.pane_id),
  );
  for (const paneId of paneIds) delete state.outputs[paneId];
  await saveState(state);
  success({ ok: true });
  process.exit(0);
}

if (args[0] === "pane" && args[1] === "read") {
  const paneId = args[2];
  if (state.failReadFor?.includes(paneId)) {
    fail("Terminal output is temporarily unavailable", "temporary_read_failure");
  }
  const linesIndex = args.indexOf("--lines");
  const lineLimit = linesIndex >= 0 ? Number(args[linesIndex + 1]) : 80;
  const output = state.outputs?.[paneId] || "";
  process.stdout.write(output.split("\n").slice(-lineLimit).join("\n"));
  process.exit(0);
}

if (args[0] === "pane" && args[1] === "send-text") {
  const paneId = args[2];
  const separatorIndex = args.indexOf("--");
  const text = separatorIndex >= 0 ? args[separatorIndex + 1] : args[3];
  state.pendingInput = { paneId, text };
  state.outputs[paneId] = `${state.outputs[paneId] || ""}\n\n> 사용자: ${text}`;
  await saveState(state);
  success({ ok: true });
  process.exit(0);
}

if (args[0] === "pane" && args[1] === "run") {
  const paneId = args[2];
  const text = args.slice(3).join(" ");
  state.outputs[paneId] = `${state.outputs[paneId] || ""}\n\n> 사용자: ${text}\n✓ 응답을 전달했습니다.`;
  const agent = state.snapshot.agents.find((item) => item.pane_id === paneId);
  if (agent) {
    if ("agent_status" in agent) agent.agent_status = "idle";
    else agent.state = "idle";
  }
  delete state.pendingInput;
  await saveState(state);
  success({ ok: true });
  process.exit(0);
}

if (args[0] === "pane" && args[1] === "send-keys") {
  const paneId = args[2];
  const keys = args.slice(3);
  if (keys.includes("enter") && state.pendingInput?.paneId === paneId) {
    state.outputs[paneId] = `${state.outputs[paneId]}\n✓ 응답을 전달했습니다.`;
    const agent = state.snapshot.agents.find((item) => item.pane_id === paneId);
    if (agent) agent.state = "idle";
    delete state.pendingInput;
  } else {
    state.outputs[paneId] = `${state.outputs[paneId] || ""}\n[keys: ${keys.join(" ")}]`;
  }
  await saveState(state);
  success({ ok: true });
  process.exit(0);
}

fail("Unsupported fake Herdr command", "unsupported_fake_command");
