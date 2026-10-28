import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLAPSED_WORKSPACES_STORAGE_KEY,
  EXPANDED_SPLIT_TABS_STORAGE_KEY,
  readCollapsedWorkspaceIds,
  readExpandedSplitTabIds,
  writeCollapsedWorkspaceIds,
  writeExpandedSplitTabIds,
} from "../public/workspace-preference.js";

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("restores and stores collapsed workspace ids", () => {
  const storage = memoryStorage({
    [COLLAPSED_WORKSPACES_STORAGE_KEY]: JSON.stringify(["w1", "w3", "bad"]),
  });

  assert.deepEqual([...readCollapsedWorkspaceIds(storage)], ["w1", "w3"]);
  assert.equal(writeCollapsedWorkspaceIds(storage, new Set(["w2", "w4"])), true);
  assert.deepEqual([...readCollapsedWorkspaceIds(storage)], ["w2", "w4"]);
});

test("falls back safely when collapse storage is unavailable", () => {
  const storage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };

  assert.deepEqual([...readCollapsedWorkspaceIds(storage)], []);
  assert.equal(writeCollapsedWorkspaceIds(storage, new Set(["w1"])), false);
});

test("keeps a connected PC's workspaces folded, and drops ids of anything else", () => {
  const storage = memoryStorage({
    [COLLAPSED_WORKSPACES_STORAGE_KEY]: JSON.stringify([
      "machine-4c139ff50dfb!hs_x~w1",
      "link_00000000-0000-0000-0000-000000000000!hs_x~w1",
      "ssh_00000000-0000-0000-0000-000000000000!hs_x~w1",
    ]),
  });
  assert.deepEqual([...readCollapsedWorkspaceIds(storage)], [
    "link_00000000-0000-0000-0000-000000000000!hs_x~w1",
  ], "a removed Herdr SSH machine's id is dropped");
});

test("remembers which split sessions have their pane list open", () => {
  const storage = memoryStorage({
    [EXPANDED_SPLIT_TABS_STORAGE_KEY]: JSON.stringify(["w1:t1", "", 7, "bad\u0000id", "w1:t1"]),
  });
  assert.deepEqual([...readExpandedSplitTabIds(storage)], ["w1:t1"]);
  assert.equal(writeExpandedSplitTabIds(storage, new Set(["w2:t3"])), true);
  assert.deepEqual([...readExpandedSplitTabIds(storage)], ["w2:t3"]);
  assert.deepEqual([...readExpandedSplitTabIds(memoryStorage({ [EXPANDED_SPLIT_TABS_STORAGE_KEY]: "{" }))], []);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual([...readExpandedSplitTabIds(blocked)], []);
  assert.equal(writeExpandedSplitTabIds(blocked, new Set(["w1:t1"])), false);
  assert.equal(writeExpandedSplitTabIds(null, new Set()), false);
});
