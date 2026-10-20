import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HEADLESS_COLS,
  DEFAULT_HEADLESS_ROWS,
  parseHeadlessConfig,
  readHeadlessSize,
  staleSoloPanes,
  repairablePanes,
  repairPane,
} from "../src/headless-fit.mjs";
import { InputValidationError } from "../src/herdr-client.mjs";

test("headless size defaults to 120x40 when the config is missing or silent", async () => {
  assert.deepEqual(parseHeadlessConfig(""), { cols: 120, rows: 40 });
  assert.deepEqual(
    parseHeadlessConfig("[ui]\nagent_panel_sort = \"spaces\"\n"),
    { cols: DEFAULT_HEADLESS_COLS, rows: DEFAULT_HEADLESS_ROWS },
  );
  assert.deepEqual(
    await readHeadlessSize({ path: "/nonexistent/herdr/config.toml" }),
    { cols: DEFAULT_HEADLESS_COLS, rows: DEFAULT_HEADLESS_ROWS },
  );
});

test("headless size reads the [server] table only and ignores invalid values", () => {
  const text = [
    "[terminal]",
    "headless_cols = 999",
    "[server]",
    "# headless_cols = 120",
    "headless_rows = 71",
    "headless_cols = 160 # wide",
    "headless_rows = -5",
    "[ui]",
    "headless_cols = 5",
  ].join("\n");
  assert.deepEqual(parseHeadlessConfig(text), { cols: 160, rows: 71 });
});

function snapshotWith(panes, tabs = panes.map(({ tab_id }, index) => ({
  tab_id,
  pane_count: 1,
}))) {
  return { panes, tabs };
}

const staleSnapshot = snapshotWith([
  { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", scroll: { viewport_rows: 39 }, agent: "opencode" },
  { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", scroll: { viewport_rows: 40 } },
  { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", scroll: { viewport_rows: 39 }, agent: "claude" },
], [
  { tab_id: "w1:t1", pane_count: 1 },
  { tab_id: "w1:t2", pane_count: 1 },
  { tab_id: "w2:t1", pane_count: 1 },
]);

test("a solo pane that no longer matches the headless height is stale, others are not", () => {
  const stale = staleSoloPanes(staleSnapshot, { cols: 120, rows: 40 });
  assert.deepEqual(stale.map(({ paneId, viewportRows, agent }) => [paneId, viewportRows, agent]), [
    ["w1:p1", 39, "opencode"],
    ["w2:p1", 39, "claude"],
  ]);
});

test("split tabs never count as stale, whatever their height", () => {
  const split = snapshotWith(
    [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", scroll: { viewport_rows: 20 } },
      { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", scroll: { viewport_rows: 20 } },
    ],
    [{ tab_id: "w1:t1", pane_count: 2 }],
  );
  assert.deepEqual(staleSoloPanes(split, { cols: 120, rows: 40 }), []);
});

test("only agent-free panes may be replaced automatically", () => {
  const stale = staleSoloPanes(staleSnapshot, { cols: 120, rows: 40 });
  const repairable = repairablePanes(stale);
  assert.deepEqual(repairable.map(({ paneId }) => paneId), []);
  const free = staleSoloPanes(snapshotWith([
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", scroll: { viewport_rows: 39 } },
  ]), { cols: 120, rows: 40 });
  assert.deepEqual(repairablePanes(free).map(({ paneId }) => paneId), ["w1:p1"]);
});

test("repairing replaces the pane's tab with a fresh one in the same workspace", async () => {
  const calls = [];
  const client = {
    async closeTab(tabId) { calls.push(["closeTab", tabId]); },
    async createTab(workspaceId) { calls.push(["createTab", workspaceId]); },
  };
  const pane = { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" };
  assert.equal(await repairPane(client, pane), "w1:p1");
  assert.deepEqual(calls, [["closeTab", "w1:t1"], ["createTab", "w1"]]);
});

test("repairing refuses a pane with no tab or workspace to rebuild from", async () => {
  const client = { async closeTab() {}, async createTab() {} };
  await assert.rejects(
    () => repairPane(client, { paneId: "w1:p1", tabId: "", workspaceId: "w1" }),
    InputValidationError,
  );
});
