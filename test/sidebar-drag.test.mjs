import test from "node:test";
import assert from "node:assert/strict";
import {
  dropPreview,
  dropScope,
  dropSide,
  followMovedPane,
  gapIndex,
  isNoopGap,
  movedTabSnapshot,
  movedWorkspaceSnapshot,
  paneMoveRequest,
  tabMoveRequest,
  workspaceMoveRequest,
} from "../public/sidebar-drag.js";

const scope = { server_id: "local", herdr_session_id: "hs_ZGVmYXVsdA" };
const remote = { server_id: "laptop", herdr_session_id: "laptop!hs_ZGVmYXVsdA" };
const other = { server_id: "local", herdr_session_id: "hs_cmV2aWV3" };

function snapshot() {
  return {
    workspaces: [
      { workspace_id: "w1", label: "API", ...scope },
      { workspace_id: "w2", label: "Web", ...scope },
      { workspace_id: "w3", label: "Docs", ...scope },
      { workspace_id: "laptop!w1", label: "Laptop", ...remote },
      { workspace_id: "r1", label: "Review", ...other },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "server", ...scope },
      { tab_id: "w1:t2", workspace_id: "w1", label: "tests", ...scope },
      { tab_id: "w2:t1", workspace_id: "w2", label: "dev", ...scope },
      { tab_id: "w1:t3", workspace_id: "w1", label: "3", ...scope },
      { tab_id: "w2:t2", workspace_id: "w2", label: "lint", ...scope },
      { tab_id: "laptop!w1:t1", workspace_id: "laptop!w1", label: "1", ...remote },
      { tab_id: "r1:t1", workspace_id: "r1", label: "1", ...other },
    ],
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
      { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
      { pane_id: "w1:p4", tab_id: "w1:t2", workspace_id: "w1" },
      { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
    ],
  };
}

const order = (records, key, filter = () => true) => records.filter(filter).map((item) => item[key]);

test("the gap under the pointer counts the rows whose middle it has passed", () => {
  const middles = [20, 60, 100];
  assert.equal(gapIndex(middles, 5), 0);
  assert.equal(gapIndex(middles, 39), 1);
  assert.equal(gapIndex(middles, 99), 2);
  assert.equal(gapIndex(middles, 400), 3);
  assert.equal(gapIndex([], 50), 0);
});

test("dropping a row on either side of itself changes nothing", () => {
  assert.equal(isNoopGap(1, 1), true);
  assert.equal(isNoopGap(1, 2), true);
  assert.equal(isNoopGap(1, 0), false);
  assert.equal(isNoopGap(1, 3), false);
  assert.equal(isNoopGap(-1, 0), false);
});

test("a session reordered within its project asks for tab.move's gap", () => {
  const state = snapshot();
  // w1 holds t1, t2, t3: t1 dropped after t3
  assert.deepEqual(tabMoveRequest(state, { tabId: "w1:t1", workspaceId: "w1", gap: 3 }),
    { tabId: "w1:t1", body: { insertIndex: 3 } });
  assert.deepEqual(tabMoveRequest(state, { tabId: "w1:t3", workspaceId: "w1", gap: 0 }),
    { tabId: "w1:t3", body: { insertIndex: 0 } });
  assert.equal(tabMoveRequest(state, { tabId: "w1:t2", workspaceId: "w1", gap: 1 }), null);
  assert.equal(tabMoveRequest(state, { tabId: "w1:t2", workspaceId: "w1", gap: 2 }), null);
  assert.equal(tabMoveRequest(state, { tabId: "w1:t2", workspaceId: "w1", gap: 4 }), null, "past the end");
});

test("a session dropped on another project names that project and its place there", () => {
  const state = snapshot();
  assert.deepEqual(tabMoveRequest(state, { tabId: "w1:t1", workspaceId: "w2", gap: 1 }),
    { tabId: "w1:t1", body: { workspaceId: "w2", insertIndex: 1 } });
  assert.deepEqual(tabMoveRequest(state, { tabId: "w1:t3", workspaceId: "w3", gap: 0 }),
    { tabId: "w1:t3", body: { workspaceId: "w3", insertIndex: 0 } });
});

test("a split session cannot be dropped on another project but can be reordered in its own", () => {
  const state = snapshot(); // w1:t2 has two panes
  assert.equal(tabMoveRequest(state, { tabId: "w1:t2", workspaceId: "w2", gap: 1 }), null);
  assert.deepEqual(tabMoveRequest(state, { tabId: "w1:t2", workspaceId: "w1", gap: 0 }),
    { tabId: "w1:t2", body: { insertIndex: 0 } });
  assert.deepEqual(tabMoveRequest(state, { tabId: "w1:t1", workspaceId: "w2", gap: 0 }),
    { tabId: "w1:t1", body: { workspaceId: "w2", insertIndex: 0 } }, "one pane still moves");
});

test("a session does not move to another machine or another Herdr session", () => {
  const state = snapshot();
  assert.equal(tabMoveRequest(state, { tabId: "w1:t2", workspaceId: "laptop!w1", gap: 0 }), null);
  assert.equal(tabMoveRequest(state, { tabId: "w1:t2", workspaceId: "r1", gap: 0 }), null);
  assert.equal(tabMoveRequest(state, { tabId: "w1:t9", workspaceId: "w1", gap: 0 }), null);
  assert.notEqual(dropScope(state.workspaces[0]), dropScope(state.workspaces[3]));
  assert.notEqual(dropScope(state.workspaces[0]), dropScope(state.workspaces[4]));
});

test("the page shows a reordered session in its new place at once", () => {
  const moved = movedTabSnapshot(snapshot(), { tabId: "w1:t1", workspaceId: "w1", gap: 3 });
  assert.deepEqual(order(moved.tabs, "tab_id", (tab) => tab.workspace_id === "w1"), ["w1:t2", "w1:t3", "w1:t1"]);
  const first = movedTabSnapshot(snapshot(), { tabId: "w1:t3", workspaceId: "w1", gap: 0 });
  assert.deepEqual(order(first.tabs, "tab_id", (tab) => tab.workspace_id === "w1"), ["w1:t3", "w1:t1", "w1:t2"]);
  const middle = movedTabSnapshot(snapshot(), { tabId: "w1:t1", workspaceId: "w1", gap: 2 });
  assert.deepEqual(order(middle.tabs, "tab_id", (tab) => tab.workspace_id === "w1"), ["w1:t2", "w1:t1", "w1:t3"]);
});

test("a session moved to another project is shown there with its panes", () => {
  const moved = movedTabSnapshot(snapshot(), { tabId: "w1:t2", workspaceId: "w2", gap: 1 });
  assert.deepEqual(order(moved.tabs, "tab_id", (tab) => tab.workspace_id === "w2"), ["w2:t1", "w1:t2", "w2:t2"]);
  assert.deepEqual(order(moved.tabs, "tab_id", (tab) => tab.workspace_id === "w1"), ["w1:t1", "w1:t3"]);
  assert.deepEqual(order(moved.panes, "pane_id", (pane) => pane.workspace_id === "w2"), ["w1:p2", "w1:p4", "w2:p1"]);
  const last = movedTabSnapshot(snapshot(), { tabId: "w1:t2", workspaceId: "w2", gap: 2 });
  assert.deepEqual(order(last.tabs, "tab_id", (tab) => tab.workspace_id === "w2"), ["w2:t1", "w2:t2", "w1:t2"]);
  // The one the page held is left as it was, for putting back.
  const before = snapshot();
  movedTabSnapshot(before, { tabId: "w1:t2", workspaceId: "w2", gap: 0 });
  assert.equal(before.tabs[1].workspace_id, "w1");
});

test("a project moves among the projects of its own Herdr session", () => {
  const state = snapshot();
  assert.deepEqual(workspaceMoveRequest(state, { workspaceId: "w1", gap: 3 }), { workspaceId: "w1", body: { insertIndex: 3 } });
  assert.deepEqual(workspaceMoveRequest(state, { workspaceId: "w3", gap: 0 }), { workspaceId: "w3", body: { insertIndex: 0 } });
  assert.equal(workspaceMoveRequest(state, { workspaceId: "w2", gap: 2 }), null);
  assert.equal(workspaceMoveRequest(state, { workspaceId: "w2", gap: 4 }), null, "past its session's projects");
  const moved = movedWorkspaceSnapshot(state, { workspaceId: "w1", gap: 3 });
  assert.deepEqual(order(moved.workspaces, "workspace_id"), ["w2", "w3", "w1", "laptop!w1", "r1"]);
  const first = movedWorkspaceSnapshot(state, { workspaceId: "w3", gap: 0 });
  assert.deepEqual(order(first.workspaces, "workspace_id"), ["w3", "w1", "w2", "laptop!w1", "r1"]);
});

test("the pane on screen is followed to its new id, and others stay as they are", () => {
  const moves = [{ from: "w1:p2", to: "w2:p3" }, { from: "w1:p4", to: "w2:p4" }];
  assert.equal(followMovedPane("w1:p4", moves), "w2:p4");
  assert.equal(followMovedPane("w1:p1", moves), "w1:p1");
  assert.equal(followMovedPane("w1:p1", undefined), "w1:p1");
});

test("a pointer near a pane's edge picks that side and the middle picks none", () => {
  const box = { left: 100, top: 50, right: 300, bottom: 250, width: 200, height: 200 };
  assert.equal(dropSide(box, 110, 150), "left");
  assert.equal(dropSide(box, 290, 150), "right");
  assert.equal(dropSide(box, 200, 60), "up");
  assert.equal(dropSide(box, 200, 240), "down");
  assert.equal(dropSide(box, 200, 150), null);
  assert.equal(dropSide(box, 50, 150), null);
  assert.equal(dropSide({ ...box, width: 0 }, 110, 150), null);
});

test("the drop preview is the half of the pane on the chosen side", () => {
  const box = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepEqual(dropPreview(box, "left"), { left: 100, top: 50, width: 100, height: 100 });
  assert.deepEqual(dropPreview(box, "right"), { left: 200, top: 50, width: 100, height: 100 });
  assert.deepEqual(dropPreview(box, "up"), { left: 100, top: 50, width: 200, height: 50 });
  assert.deepEqual(dropPreview(box, "down"), { left: 100, top: 100, width: 200, height: 50 });
});

test("only a one-pane session of the same Herdr session joins another pane", () => {
  const snap = {
    workspaces: [{ workspace_id: "w1", ...scope }, { workspace_id: "w2", ...other }],
    tabs: [
      { tab_id: "t1", workspace_id: "w1", ...scope },
      { tab_id: "t2", workspace_id: "w1", ...scope },
      { tab_id: "t3", workspace_id: "w1", ...scope },
      { tab_id: "t4", workspace_id: "w2", ...other },
    ],
    panes: [
      { pane_id: "p1", tab_id: "t1" },
      { pane_id: "p2", tab_id: "t2" },
      { pane_id: "p3", tab_id: "t3" },
      { pane_id: "p3b", tab_id: "t3" },
      { pane_id: "p4", tab_id: "t4" },
    ],
  };
  assert.deepEqual(paneMoveRequest(snap, { tabId: "t1", targetPaneId: "p2", side: "left" }),
    { paneId: "p1", body: { targetPaneId: "p2", side: "left" } });
  assert.equal(paneMoveRequest(snap, { tabId: "t3", targetPaneId: "p2", side: "right" }), null, "a split session cannot join");
  assert.equal(paneMoveRequest(snap, { tabId: "t1", targetPaneId: "p4", side: "right" }), null, "another Herdr session");
  assert.equal(paneMoveRequest(snap, { tabId: "t3", targetPaneId: "p3", side: "up" }), null, "its own tab");
  assert.equal(paneMoveRequest(snap, { tabId: "t1", targetPaneId: "p2", side: "middle" }), null, "an unknown side");
});

test("a connected PC's sessions do not join its panes from here", () => {
  const snap = {
    workspaces: [{ workspace_id: "r1", ...remote }],
    tabs: [{ tab_id: "rt1", workspace_id: "r1", ...remote }, { tab_id: "rt2", workspace_id: "r1", ...remote }],
    panes: [{ pane_id: "rp1", tab_id: "rt1", ...remote }, { pane_id: "rp2", tab_id: "rt2", ...remote }],
  };
  assert.equal(paneMoveRequest(snap, { tabId: "rt1", targetPaneId: "rp2", side: "right" }), null);
});
