import test from "node:test";
import assert from "node:assert/strict";
import {
  clampNavigatorWidth,
  readBrowsePath,
  readFileServer,
  readNavigatorTab,
  readNavigatorWidth,
  writeBrowsePath,
  writeFileServer,
  writeNavigatorTab,
  writeNavigatorWidth,
} from "../public/browse-preference.js";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test("restores the folder browsing last stopped at", () => {
  const store = storage();
  assert.equal(readBrowsePath(store), null);
  assert.equal(writeBrowsePath(store, "/home/me/project"), true);
  assert.equal(readBrowsePath(store), "/home/me/project");
});

test("ignores a stored path that could not be opened", () => {
  assert.equal(readBrowsePath(storage({ "herdrbridge-browse-path": "relative/path" })), null);
  assert.equal(readBrowsePath(storage({ "herdrbridge-browse-path": "" })), null);
  assert.equal(readBrowsePath(storage({ "herdrbridge-browse-path": `/tmp/${"a".repeat(5000)}` })), null);
  assert.equal(readBrowsePath(storage({ "herdrbridge-browse-path": "/tmp/with\u0000null" })), null);
  assert.equal(writeBrowsePath(storage(), "not-absolute"), false);
});

test("remembers the open sidebar tab and defaults to sessions", () => {
  const store = storage();
  assert.equal(readNavigatorTab(store), "sessions");
  assert.equal(writeNavigatorTab(store, "files"), true);
  assert.equal(readNavigatorTab(store), "files");
  assert.equal(writeNavigatorTab(store, "something-else"), false);
  assert.equal(readNavigatorTab(storage({ "herdrbridge-navigator-tab": "bogus" })), "sessions");
});

test("survives storage being unavailable", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.equal(readBrowsePath(broken), null);
  assert.equal(writeBrowsePath(broken, "/tmp"), false);
  assert.equal(readNavigatorTab(broken), "sessions");
  assert.equal(writeNavigatorTab(broken, "files"), false);
  assert.equal(readBrowsePath(null), null);
});

test("keeps the sidebar width inside usable bounds", () => {
  const store = storage();
  assert.equal(readNavigatorWidth(store), 310);
  assert.equal(writeNavigatorWidth(store, 480), true);
  assert.equal(readNavigatorWidth(store), 480);

  assert.equal(clampNavigatorWidth(50), 260, "too narrow to hold a tree");
  assert.equal(clampNavigatorWidth(5000), 720, "not wider than the terminal deserves");
  assert.equal(clampNavigatorWidth("420"), 420);
  assert.equal(clampNavigatorWidth("nonsense"), 310);
  assert.equal(readNavigatorWidth(storage({ "herdrbridge-navigator-width": "9999" })), 720);
  assert.equal(readNavigatorWidth(storage({ "herdrbridge-navigator-width": "" })), 310);
});

test("keeps a separate last folder for each server", () => {
  const store = storage();
  const remote = "machine-0123456789ab";

  assert.equal(writeBrowsePath(store, "/home/me", "local"), true);
  assert.equal(writeBrowsePath(store, "/srv/app", remote), true);
  assert.equal(readBrowsePath(store, "local"), "/home/me");
  assert.equal(readBrowsePath(store, remote), "/srv/app");
  assert.equal(readBrowsePath(store), "/home/me", "local is the default");

  // A server nobody visited has no folder yet.
  assert.equal(readBrowsePath(store, "machine-ffffffffffff"), null);
  assert.equal(writeBrowsePath(store, "/srv", "not-a-server"), false);
  // A PC connected with Connect PC keeps its own folder too.
  assert.equal(writeBrowsePath(store, "/srv", "link_0123abcd-0123-0123-0123-0123456789ab"), true);
  assert.equal(readBrowsePath(store, "link_0123abcd-0123-0123-0123-0123456789ab"), "/srv");
  assert.equal(writeBrowsePath(store, "/srv", "link_not-a-uuid"), false);
  assert.equal(readBrowsePath(store, "not-a-server"), null);
});

test("reads a path stored before servers existed as the local one", () => {
  const store = storage({ "herdrbridge-browse-path": "/home/me/project" });
  assert.equal(readBrowsePath(store, "local"), "/home/me/project");
  assert.equal(readBrowsePath(store, "machine-0123456789ab"), null);
});

test("remembers which machine files go to, and forgets on request", () => {
  // Unset means "follow the session being viewed", which is where an upload
  // used to go; a value means the choice was made deliberately.
  const store = storage();
  assert.equal(readFileServer(store), null);
  writeFileServer(store, "machine-0123456789ab");
  assert.equal(readFileServer(store), "machine-0123456789ab");
  writeFileServer(store, null);
  assert.equal(readFileServer(store), null);
});

test("ignores a stored file server that is not a server id", () => {
  const store = storage();
  store.setItem("herdrbridge-file-server", "../etc");
  assert.equal(readFileServer(store), null);
});
