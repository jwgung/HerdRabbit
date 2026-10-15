import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLAPSED_WORKSPACES_STORAGE_KEY,
  readCollapsedWorkspaceIds,
  writeCollapsedWorkspaceIds,
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

test("keeps a Herdr machine's and a connected PC's workspaces folded, and drops ids of neither", () => {
  const storage = memoryStorage({
    [COLLAPSED_WORKSPACES_STORAGE_KEY]: JSON.stringify([
      "machine-4c139ff50dfb!hs_x~w1",
      "link_00000000-0000-0000-0000-000000000000!hs_x~w1",
      "ssh_00000000-0000-0000-0000-000000000000!hs_x~w1",
    ]),
  });
  assert.deepEqual([...readCollapsedWorkspaceIds(storage)], [
    "machine-4c139ff50dfb!hs_x~w1",
    "link_00000000-0000-0000-0000-000000000000!hs_x~w1",
  ]);
});
