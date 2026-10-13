import test from "node:test";
import assert from "node:assert/strict";
import {
  agentStatus,
  paneAgentKind,
  agentStatusIcon,
  agentStatusLabel,
  paneSubtitle,
  detectTouchInput,
  displayRecordLabel,
  displayTabLabel,
  browseDiffSummary,
  diffBrowseListing,
  flattenTree,
  formatTransferSize,
  isInsideDirectory,
  paneServerId,
  openRenames,
  clearedTabLabel,
  paneStartDirectory,
  workspaceStartDirectory,
  parentDirectory,
  inputKeyAction,
  insertPathAtSelection,
  insertTextAtSelection,
  paneUsesLocalFiles,
  insertNewlineAtSelection,
  loginMethodPresentation,
  nextInputHistory,
  outputPollingDecision,
  outputTextForUpdate,
  paneShortcutTarget,
  selectedPaneIdForSnapshot,
  sidebarPresentation,
  uploadSummary,
  waitsForRemotePane,
  keepsVanishedRemotePane,
  legacyServersNotice,
} from "../public/ui-model.js";

test("cycles through panes with Ctrl+Tab and Ctrl+Shift+Tab", () => {
  const paneIds = ["pane-1", "pane-2", "pane-3"];

  assert.equal(
    paneShortcutTarget({
      key: "Tab",
      ctrlKey: true,
      paneIds,
      currentPaneId: "pane-2",
    }),
    "pane-3",
  );
  assert.equal(
    paneShortcutTarget({
      key: "Tab",
      ctrlKey: true,
      shiftKey: true,
      paneIds,
      currentPaneId: "pane-1",
    }),
    "pane-3",
  );
  assert.equal(
    paneShortcutTarget({
      key: "Tab",
      ctrlKey: true,
      paneIds,
      currentPaneId: "pane-3",
    }),
    "pane-1",
  );
});

test("selects a numbered pane with Ctrl+1 through Ctrl+9", () => {
  const paneIds = ["pane-1", "pane-2", "pane-3"];

  assert.equal(
    paneShortcutTarget({ key: "1", ctrlKey: true, paneIds }),
    "pane-1",
  );
  assert.equal(
    paneShortcutTarget({ key: "3", ctrlKey: true, paneIds }),
    "pane-3",
  );
  assert.equal(
    paneShortcutTarget({ key: "4", ctrlKey: true, paneIds }),
    null,
  );
  assert.equal(
    paneShortcutTarget({ key: "2", paneIds }),
    null,
  );
  assert.equal(
    paneShortcutTarget({ key: "2", ctrlKey: true, altKey: true, paneIds }),
    null,
  );
});


test("applies terminal output replacements and ordered delta patches", () => {
  assert.equal(
    outputTextForUpdate("old", { update: "replace", output: "new" }),
    "new",
  );
  assert.equal(
    outputTextForUpdate("Working (30s)", {
      update: "delta",
      patches: [{ start: 10, deleteCount: 1, text: "1" }],
    }),
    "Working (31s)",
  );
  assert.equal(
    outputTextForUpdate("old\nalpha\nbeta", {
      update: "delta",
      patches: [
        { start: 14, deleteCount: 0, text: "\ngamma" },
        { start: 0, deleteCount: 4, text: "" },
      ],
    }),
    "alpha\nbeta\ngamma",
  );
  assert.equal(
    outputTextForUpdate("safe", {
      update: "delta",
      patches: [{ start: 99, deleteCount: 1, text: "broken" }],
    }),
    null,
  );
});

test("slows cellular working output polls and refreshes immediately when work stops", () => {
  assert.deepEqual(
    outputPollingDecision({
      baseIntervalMs: 1_000,
      currentStatus: "working",
      recentSubmission: true,
      connection: { type: "cellular" },
    }),
    { intervalMs: 300, refreshNow: false },
    "the echo after sending must not wait for the normal cadence",
  );
  assert.deepEqual(
    outputPollingDecision({
      baseIntervalMs: 1_000,
      previousStatus: "working",
      currentStatus: "working",
      connection: { type: "cellular" },
    }),
    { intervalMs: 5_000, refreshNow: false },
  );
  assert.deepEqual(
    outputPollingDecision({
      baseIntervalMs: 1_000,
      previousStatus: "working",
      currentStatus: "done",
    }),
    { intervalMs: 1_000, refreshNow: true },
  );
  assert.deepEqual(
    outputPollingDecision({
      baseIntervalMs: 1_000,
      previousStatus: "idle",
      currentStatus: "idle",
    }),
    { intervalMs: 1_000, refreshNow: false },
  );
});

test("polls quickly for a few seconds after sending, on any connection", () => {
  const burst = (connection) => outputPollingDecision({
    baseIntervalMs: 1_000,
    currentStatus: "working",
    recentSubmission: true,
    connection,
  }).intervalMs;
  assert.equal(burst({ type: "cellular" }), 300);
  assert.equal(burst({ saveData: true }), 300);
  assert.equal(burst(null), 300);
  // A slower base interval is still respected.
  assert.equal(
    outputPollingDecision({ baseIntervalMs: 200, recentSubmission: true }).intervalMs,
    200,
  );
});

test("slows working polls only on a connection that says it is metered", () => {
  const interval = (connection) => outputPollingDecision({
    currentStatus: "working", connection,
  }).intervalMs;
  assert.equal(interval({ type: "wifi" }), 1000);
  assert.equal(interval({ type: "ethernet" }), 1000);
  assert.equal(interval({ type: "cellular" }), 5000);
  assert.equal(interval({ type: "wifi", saveData: true }), 5000);
  // Android rarely reports connection.type. Assuming cellular there left Wi-Fi
  // five seconds behind on every phone.
  assert.equal(interval(null), 1000);
  assert.equal(interval({ effectiveType: "4g" }), 1000);
  const connection = { type: "cellular" };
  assert.equal(interval(connection), 5000);
  connection.type = "wifi";
  assert.equal(interval(connection), 1000);
});

test("makes Passkey the default login method while retaining password fallback", () => {
  assert.deepEqual(
    loginMethodPresentation({ passkeyAvailable: true, passkeySupported: true }),
    {
      passkeyVisible: true,
      passkeyPrimary: true,
      passwordPrimary: false,
      focusTarget: "passkey",
      instruction: "Sign in with a passkey or use your password.",
      passwordLabel: "Password",
    },
  );
  assert.deepEqual(
    loginMethodPresentation({ passkeyAvailable: true, passkeySupported: false }),
    {
      passkeyVisible: false,
      passkeyPrimary: false,
      passwordPrimary: true,
      focusTarget: "password",
      instruction: "Enter your password.",
      passwordLabel: "Password",
    },
  );
});

test("detects phones when the primary pointer media query is unreliable", () => {
  assert.equal(
    detectTouchInput({
      primaryTouch: false,
      anyCoarsePointer: true,
      anyHover: false,
      maxTouchPoints: 5,
      compactViewport: true,
    }),
    true,
  );
  assert.equal(
    detectTouchInput({
      primaryTouch: false,
      anyCoarsePointer: false,
      anyHover: false,
      maxTouchPoints: 5,
      compactViewport: true,
    }),
    true,
  );
  assert.equal(
    detectTouchInput({
      primaryTouch: false,
      anyCoarsePointer: false,
      anyHover: false,
      maxTouchPoints: 0,
      compactViewport: true,
    }),
    false,
  );
  assert.equal(
    detectTouchInput({
      primaryTouch: false,
      anyCoarsePointer: true,
      anyHover: true,
      maxTouchPoints: 10,
      compactViewport: false,
    }),
    false,
  );
  assert.equal(detectTouchInput({ primaryTouch: true }), true);
});

test("moves through sent input history and restores the current draft", () => {
  const history = ["첫 번째", "두 번째"];
  const previous = nextInputHistory({
    history,
    cursor: null,
    draft: "",
    currentValue: "작성 중",
    direction: "previous",
  });
  assert.deepEqual(previous, {
    handled: true,
    cursor: 1,
    draft: "작성 중",
    value: "두 번째",
  });

  const older = nextInputHistory({
    history,
    cursor: previous.cursor,
    draft: previous.draft,
    currentValue: previous.value,
    direction: "previous",
  });
  assert.equal(older.value, "첫 번째");
  assert.equal(older.cursor, 0);

  const newer = nextInputHistory({
    history,
    cursor: older.cursor,
    draft: older.draft,
    currentValue: older.value,
    direction: "next",
  });
  assert.equal(newer.value, "두 번째");
  assert.equal(newer.cursor, 1);

  const restored = nextInputHistory({
    history,
    cursor: newer.cursor,
    draft: newer.draft,
    currentValue: newer.value,
    direction: "next",
  });
  assert.deepEqual(restored, {
    handled: true,
    cursor: null,
    draft: "",
    value: "작성 중",
  });
});

test("does not consume arrow keys when no input history is available", () => {
  assert.deepEqual(
    nextInputHistory({
      history: [],
      cursor: null,
      draft: "",
      currentValue: "작성 중",
      direction: "previous",
    }),
    {
      handled: false,
      cursor: null,
      draft: "",
      value: "작성 중",
    },
  );
});

test("selects the first pane on initial load and preserves a current selection", () => {
  const panes = [{ pane_id: "w1:p1" }, { pane_id: "w2:p1" }, { pane_id: "w3:p1" }];
  assert.equal(selectedPaneIdForSnapshot(panes, null), "w1:p1");
  assert.equal(selectedPaneIdForSnapshot(panes, "w2:p1"), "w2:p1");
  assert.equal(selectedPaneIdForSnapshot(panes, "missing"), "w1:p1");
  assert.equal(selectedPaneIdForSnapshot([], null), null);
});

test("migrates a stored legacy pane id into the default Herdr session", () => {
  const panes = [
    { pane_id: "hs_ZGVmYXVsdA~w2:p1" },
    { pane_id: "hs_cmV2aWV3~w2:p1" },
  ];
  assert.equal(
    selectedPaneIdForSnapshot(panes, "w2:p1", "hs_ZGVmYXVsdA"),
    "hs_ZGVmYXVsdA~w2:p1",
  );
});

test("hides Herdr's numeric default tab label but keeps named tabs", () => {
  assert.equal(displayTabLabel({ number: 1, label: "1" }), "");
  assert.equal(displayTabLabel({ number: 2, label: "Release" }), "Release");
  assert.equal(displayTabLabel({ number: 3 }), "");
});

test("uses Enter by pointer type and supports external keyboards on touch devices", () => {
  assert.equal(inputKeyAction({ key: "Enter" }), "submit");
  assert.equal(inputKeyAction({ key: "Enter", ctrlKey: true }), "newline");
  assert.equal(
    inputKeyAction({ key: "Enter", usesTouchInput: true }),
    "default",
  );
  assert.equal(
    inputKeyAction({ key: "Enter", ctrlKey: true, usesTouchInput: true }),
    "submit",
  );
  assert.equal(
    inputKeyAction({ key: "Enter", metaKey: true, usesTouchInput: true }),
    "submit",
  );
  assert.equal(inputKeyAction({ key: "Enter", isComposing: true }), "default");
  assert.equal(inputKeyAction({ key: "a" }), "default");
});

test("inserts a Ctrl+Enter newline at the current textarea selection", () => {
  assert.deepEqual(
    insertNewlineAtSelection("첫째 줄둘째 줄", 4, 4),
    { value: "첫째 줄\n둘째 줄", caret: 5 },
  );
  assert.deepEqual(
    insertNewlineAtSelection("앞교체뒤", 1, 3),
    { value: "앞\n뒤", caret: 2 },
  );
});

test("uses real Herdr agent names without exposing internal pane ids", () => {
  assert.equal(
    displayRecordLabel({ agent: "codex", terminal_title_stripped: "working" }, "터미널"),
    "codex",
  );
  assert.equal(displayRecordLabel({}, "터미널"), "터미널");
});

test("uses Herdr agent_status", () => {
  assert.equal(agentStatus({ agent_status: "working", state: "done" }), "working");
  assert.equal(agentStatus(null, { agent_status: "blocked" }), "blocked");
  assert.equal(agentStatus({ agent_status: "unexpected" }), "unknown");
});

test("derives accessible desktop and mobile sidebar states", () => {
  assert.deepEqual(
    sidebarPresentation({
      isDesktop: true,
      desktopCollapsed: true,
      mobileOpen: false,
    }),
    {
      collapsed: true,
      open: true,
      navigatorInert: false,
      toggleExpanded: false,
      toggleLabel: "Expand sidebar",
    },
  );
  assert.deepEqual(
    sidebarPresentation({
      isDesktop: false,
      desktopCollapsed: true,
      mobileOpen: false,
    }),
    {
      collapsed: false,
      open: false,
      navigatorInert: true,
      toggleExpanded: false,
      toggleLabel: "Close sidebar",
    },
  );
});

test("inserts text at the caret and keeps the caret after it", () => {
  assert.deepEqual(insertTextAtSelection("ab", 1, 1, "XY"), { value: "aXYb", caret: 3 });
  assert.deepEqual(insertTextAtSelection("abc", 1, 3, "-"), { value: "a-", caret: 2 });
  assert.deepEqual(insertTextAtSelection("ab", null, null, "!"), { value: "ab!", caret: 3 });
  assert.deepEqual(insertNewlineAtSelection("ab", 1, 1), { value: "a\nb", caret: 2 });
});

test("spaces a pasted path away from surrounding text", () => {
  const path = "/home/user/report.log";
  assert.deepEqual(insertPathAtSelection("", 0, 0, path), { value: `${path} `, caret: path.length + 1 });
  assert.deepEqual(
    insertPathAtSelection("cat ", 4, 4, path),
    { value: `cat ${path} `, caret: 4 + path.length + 1 },
  );
  assert.deepEqual(
    insertPathAtSelection("cat", 3, 3, path),
    { value: `cat ${path} `, caret: 4 + path.length + 1 },
  );
  assert.equal(insertPathAtSelection("cat  tail", 4, 4, path).value, `cat ${path} tail`);
});

test("sums up a batch of uploads, naming what failed and why", () => {
  assert.equal(uploadSummary({ saved: ["a.png"] }), "Uploaded a.png.");
  assert.equal(uploadSummary({ saved: ["a.png", "b.txt"] }), "Uploaded 2 files.");
  assert.equal(
    uploadSummary({ saved: ["a.png"], elsewhere: "Laptop" }),
    "Uploaded a.png to Laptop. The path was not inserted: this session runs elsewhere.",
  );
  assert.equal(
    uploadSummary({ saved: ["a.png", "b.txt"], elsewhere: "Laptop" }),
    "Uploaded 2 files to Laptop. The paths were not inserted: this session runs elsewhere.",
  );
  assert.equal(
    uploadSummary({ saved: ["a.png"], failed: [{ name: "big.mov", reason: "larger than 50 MB" }] }),
    "Uploaded a.png. Could not upload big.mov (larger than 50 MB).",
  );
  assert.equal(
    uploadSummary({ failed: [{ name: "x", reason: "one" }, { name: "y", reason: "two" }] }),
    "Could not upload x (one), y (two).",
  );
});

test("offers the uploads folder only for panes on this machine", () => {
  assert.equal(paneUsesLocalFiles("workspace1.tab2.pane3"), true);
  assert.equal(paneUsesLocalFiles("ssh_abc!workspace1.tab2.pane3"), false);
  assert.equal(paneUsesLocalFiles(""), false);
  assert.equal(paneUsesLocalFiles(null), false);
});

test("states transfer sizes in units a person reads", () => {
  assert.equal(formatTransferSize(0), "0 B");
  assert.equal(formatTransferSize(512), "512 B");
  assert.equal(formatTransferSize(1536), "1.5 KB");
  assert.equal(formatTransferSize(52_428_800), "50 MB");
  assert.equal(formatTransferSize(2 * 1024 ** 3), "2.0 GB");
  assert.equal(formatTransferSize(-1), "");
});

test("starts browsing where the session runs, and nowhere for remote panes", () => {
  const local = { pane_id: "w1:p1", cwd: "/home/me/project", foreground_cwd: "/home/me/project/src" };
  assert.equal(paneStartDirectory(local, { home: "/home/me" }), "/home/me/project/src");
  assert.equal(
    paneStartDirectory({ pane_id: "w1:p1", cwd: "/home/me/project" }, { home: "/home/me" }),
    "/home/me/project",
  );
  // A remote pane reports a path on the SSH host, which is not this filesystem.
  assert.equal(
    paneStartDirectory({ pane_id: "ssh_a!w1:p1", cwd: "/srv/app" }, { home: "/home/me" }),
    "/home/me",
  );
  assert.equal(paneStartDirectory(null, { home: "/home/me" }), "/home/me");
  assert.equal(paneStartDirectory({ pane_id: "w1:p1" }, { home: "/home/me" }), "/home/me");
  assert.equal(paneStartDirectory({ pane_id: "w1:p1", cwd: "relative" }), null);
});

test("walks up to the root and stops there", () => {
  assert.equal(parentDirectory("/home/me/project"), "/home/me");
  assert.equal(parentDirectory("/home/me"), "/home");
  assert.equal(parentDirectory("/home"), "/");
  assert.equal(parentDirectory("/"), null);
  assert.equal(parentDirectory("/home/me/"), "/home");
  assert.equal(parentDirectory("relative"), null);
});

test("recognises when a path sits inside the uploads folder", () => {
  assert.equal(isInsideDirectory("/data/files", "/data/files"), true);
  assert.equal(isInsideDirectory("/data/files/sub", "/data/files"), true);
  assert.equal(isInsideDirectory("/data/files/sub", "/data/files/"), true);
  assert.equal(isInsideDirectory("/data/files-other", "/data/files"), false);
  assert.equal(isInsideDirectory("/data", "/data/files"), false);
  assert.equal(isInsideDirectory("/data/files", ""), false);
  assert.equal(isInsideDirectory("/data/files", null), false);
});

test("takes a project's folder from whichever session reports one", () => {
  const records = {
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }, { tab_id: "w2:t1", workspace_id: "w2" }],
    panes: [
      { pane_id: "w2:p1", tab_id: "w2:t1", cwd: "/home/me/other" },
      { pane_id: "w1:p1", tab_id: "w1:t1", cwd: "/home/me/project" },
    ],
  };
  assert.equal(workspaceStartDirectory("w1", records), "/home/me/project");
  assert.equal(workspaceStartDirectory("w2", records), "/home/me/other");
  assert.equal(workspaceStartDirectory("w9", records), null);
  assert.equal(workspaceStartDirectory("w9", records, { home: "/home/me" }), "/home/me");

  // An SSH project reports a path on the remote host, so there is nothing local.
  const remote = {
    tabs: [{ tab_id: "ssh_a!w1:t1", workspace_id: "ssh_a!w1" }],
    panes: [{ pane_id: "ssh_a!w1:p1", tab_id: "ssh_a!w1:t1", cwd: "/srv/app" }],
  };
  assert.equal(workspaceStartDirectory("ssh_a!w1", remote), null);
});

test("flattens only the folders that were opened", () => {
  const loaded = new Map([
    ["/root", { entries: [
      { name: "src", path: "/root/src", kind: "directory" },
      { name: "a.txt", path: "/root/a.txt", kind: "file" },
    ] }],
    ["/root/src", { entries: [
      { name: "deep", path: "/root/src/deep", kind: "directory" },
      { name: "index.js", path: "/root/src/index.js", kind: "file" },
    ] }],
  ]);

  const collapsed = flattenTree("/root", loaded, new Set());
  assert.deepEqual(collapsed.map((row) => [row.entry.name, row.depth]), [["src", 0], ["a.txt", 0]]);

  const opened = flattenTree("/root", loaded, new Set(["/root/src"]));
  assert.deepEqual(opened.map((row) => [row.entry.name, row.depth]), [
    ["src", 0], ["deep", 1], ["index.js", 1], ["a.txt", 0],
  ]);
  assert.equal(opened[0].expanded, true);

  // A folder marked open but never fetched contributes no children.
  const unfetched = flattenTree("/root", loaded, new Set(["/root/src", "/root/src/deep"]));
  assert.equal(unfetched.length, 4);
  assert.deepEqual(flattenTree("/missing", loaded, new Set()), []);
});

test("reads the server a pane belongs to from its id", () => {
  assert.equal(paneServerId("w1:p1"), "local");
  assert.equal(paneServerId("ssh_0123abcd-0123-0123-0123-0123456789ab!w1:p1"), "ssh_0123abcd-0123-0123-0123-0123456789ab");
  assert.equal(paneServerId(""), null);
  assert.equal(paneServerId(null), null);
});

test("keeps a redraw from throwing away a name being typed", () => {
  // Every rename form holds text that exists nowhere else yet. The sidebar has
  // three of them, and a check that names one by hand goes stale the day a
  // fourth arrives -- which is how sessions came to lose what was typed.
  const records = {
    workspaces: [{ workspace_id: "w1" }],
    tabs: [{ tab_id: "w1:t1" }],
    servers: [{ id: "local" }, { id: "link_1" }],
  };
  assert.equal(openRenames({ workspaceId: "w1" }, records).any, true);
  assert.equal(openRenames({ tabId: "w1:t1" }, records).any, true);
  assert.equal(openRenames({ serverId: "link_1" }, records).any, true);
  assert.equal(openRenames({}, records).any, false);
});

test("drops a rename whose record is gone", () => {
  // A session closed on the machine itself leaves a form pointing at nothing.
  // Left set, the flag would stop the sidebar redrawing for good.
  const records = {
    workspaces: [{ workspace_id: "w1" }],
    tabs: [{ tab_id: "w1:t1" }],
    servers: [{ id: "local" }],
  };
  assert.deepEqual(
    openRenames({ workspaceId: "w9", tabId: "w9:t1", serverId: "link_9" }, records),
    { workspaceId: null, tabId: null, serverId: null, any: false },
  );
  assert.equal(openRenames({ workspaceId: "w1", tabId: "w9:t1" }, records).workspaceId, "w1");
});

test("waits for a snapshot before deciding a server is gone", () => {
  // A snapshot always carries this machine, so an empty list means none has
  // arrived -- and a rename opened before the first refresh must survive it.
  const empty = { workspaces: [], tabs: [], servers: [] };
  assert.equal(openRenames({ serverId: "link_1" }, empty).serverId, "link_1");
  assert.equal(openRenames({ serverId: "link_1" }, { servers: [{ id: "local" }] }).serverId, null);
});

test("survives a snapshot that is missing collections entirely", () => {
  assert.equal(openRenames({ workspaceId: "w1" }, {}).any, false);
  assert.equal(openRenames(null, null).any, false);
});

test("clearing a session name puts back a label the sidebar hides", () => {
  // Herdr's `tab rename` insists on a label, so "no name" has to be spelled as
  // the tab's own number -- and the point of choosing that one is that the
  // sidebar shows nothing for it, which is the whole round trip.
  const tab = { tab_id: "w1:t3", number: 3, label: "배포 확인" };
  const cleared = clearedTabLabel(tab);
  assert.equal(cleared, "3");
  assert.equal(displayTabLabel({ ...tab, label: cleared }), "");
});

test("refuses to clear a session that cannot say its number", () => {
  // Without a number there is no label to fall back to, and sending an empty
  // one would be rejected by the machine that owns the session.
  assert.equal(clearedTabLabel({ tab_id: "w1:t1" }), null);
  assert.equal(clearedTabLabel({ number: 0 }), null);
  assert.equal(clearedTabLabel({ number: "2" }), null);
  assert.equal(clearedTabLabel(null), null);
});

test("formats browse diff summary messages concisely", () => {
  assert.equal(browseDiffSummary(0, 0), "");
  assert.equal(browseDiffSummary(1, 0), "1 added");
  assert.equal(browseDiffSummary(0, 1), "1 removed");
  assert.equal(browseDiffSummary(2, 3), "2 added, 3 removed");
});

test("diffs browse folder listings to track added and removed entries", () => {
  const oldListing = {
    path: "/project",
    total: 3,
    truncated: false,
    entries: [
      { name: "docs", path: "/project/docs", kind: "directory" },
      { name: "build.log", path: "/project/build.log", kind: "file", size: 100 },
      { name: "notes.txt", path: "/project/notes.txt", kind: "file", size: 50 },
    ],
  };

  const newListing = {
    path: "/project",
    total: 3,
    truncated: false,
    entries: [
      { name: "docs", path: "/project/docs", kind: "directory" },
      { name: "dist", path: "/project/dist", kind: "directory" },
      { name: "notes.txt", path: "/project/notes.txt", kind: "file", size: 60 },
    ],
  };

  const { listing, added, removed } = diffBrowseListing(oldListing, newListing);

  assert.equal(added.length, 1);
  assert.equal(added[0].name, "dist");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].name, "build.log");
  assert.equal(removed[0].removed, true);

  // Directories come first, then files alphabetically
  assert.deepEqual(
    listing.entries.map((e) => [e.name, e.kind, Boolean(e.removed)]),
    [
      ["dist", "directory", false],
      ["docs", "directory", false],
      ["build.log", "file", true],
      ["notes.txt", "file", false],
    ],
  );

  // Retains previously removed entries until purged
  const secondDiff = diffBrowseListing(listing, {
    path: "/project",
    total: 3,
    truncated: false,
    entries: [
      { name: "dist", path: "/project/dist", kind: "directory" },
      { name: "docs", path: "/project/docs", kind: "directory" },
      { name: "notes.txt", path: "/project/notes.txt", kind: "file", size: 60 },
    ],
  });

  assert.equal(secondDiff.added.length, 0);
  assert.equal(secondDiff.removed.length, 0);
  assert.ok(secondDiff.listing.entries.some((e) => e.name === "build.log" && e.removed));

  // Re-adding a file removes its removed marker
  const thirdDiff = diffBrowseListing(secondDiff.listing, {
    path: "/project",
    total: 4,
    truncated: false,
    entries: [
      { name: "dist", path: "/project/dist", kind: "directory" },
      { name: "docs", path: "/project/docs", kind: "directory" },
      { name: "build.log", path: "/project/build.log", kind: "file", size: 200 },
      { name: "notes.txt", path: "/project/notes.txt", kind: "file", size: 60 },
    ],
  });

  assert.equal(thirdDiff.added.length, 1);
  assert.equal(thirdDiff.added[0].name, "build.log");
  const restored = thirdDiff.listing.entries.find((e) => e.name === "build.log");
  assert.equal(restored?.removed, undefined);
  assert.equal(restored?.size, 200);
});

test("a page waits for another server's pane only while that server is still connecting", () => {
  const pane = "machine-4c139ff50dfb!hs_x~w1:p1";
  const server = (fields) => [{ id: "local", available: true, connecting: false }, { id: "machine-4c139ff50dfb", ...fields }];
  const LIMIT = 20_000;
  assert.equal(waitsForRemotePane(pane, [], server({ available: false, connecting: true }), 1_000, LIMIT), true, "connecting");
  assert.equal(waitsForRemotePane(pane, [], server({ available: false, connecting: true }), LIMIT, LIMIT), false, "waited long enough");
  assert.equal(waitsForRemotePane(pane, [], server({ available: false, connecting: false, enabled: false }), 1_000, LIMIT), false, "turned off");
  assert.equal(waitsForRemotePane(pane, [], server({ available: false, connecting: false }), 1_000, LIMIT), false, "failed to answer");
  assert.equal(waitsForRemotePane(pane, [], server({ available: true, connecting: false }), 1_000, LIMIT), false, "connected, and the pane is gone");
  assert.equal(waitsForRemotePane(pane, [{ pane_id: pane }], server({ available: true, connecting: false }), 1_000, LIMIT), false, "already here");
  assert.equal(waitsForRemotePane(pane, [], [{ id: "local" }], 1_000, LIMIT, true), true, "not listed yet while the list is pending");
  assert.equal(waitsForRemotePane(pane, [], [{ id: "local" }], 1_000, LIMIT, false), false, "not listed once the list is in");
  assert.equal(waitsForRemotePane("hs_x~w1:p1", [], [{ id: "local" }], 1_000, LIMIT, true), false, "a local pane is never waited for");
});

test("the pane on screen stays while its server comes back, and gives way once its machine is turned off", () => {
  const pane = "machine-4c139ff50dfb!hs_x~w1:p1";
  const with_ = (fields) => [{ id: "machine-4c139ff50dfb", ...fields }];
  assert.equal(keepsVanishedRemotePane(pane, [], with_({ available: false, enabled: true })), true, "reconnecting");
  assert.equal(keepsVanishedRemotePane(pane, [], with_({ available: false })), true, "a linked server reconnecting");
  assert.equal(keepsVanishedRemotePane(pane, [], with_({ available: false, enabled: false })), false, "turned off");
  assert.equal(keepsVanishedRemotePane(pane, [], with_({ available: true, enabled: true })), false, "connected, and the pane is gone");
  assert.equal(keepsVanishedRemotePane(pane, [{ pane_id: pane }], with_({ available: false })), false, "still listed");
  assert.equal(keepsVanishedRemotePane("hs_x~w1:p1", [], []), false, "a local pane");
});

test("tells once that old leaf links have to be added again with herdr machine", () => {
  assert.equal(legacyServersNotice({ count: 0 }), null);
  assert.equal(legacyServersNotice({}), null);
  assert.equal(legacyServersNotice({ count: 2, seen: true }), null, "shown once per browser");
  assert.equal(legacyServersNotice({ count: "2" }), null);
  const one = legacyServersNotice({ count: 1 });
  assert.match(one, /^1 computer was connected/u);
  assert.match(one, /Re-add each PC with Add SSH machine \(herdr machine\)/u);
  assert.match(legacyServersNotice({ count: 3 }), /^3 computers were connected/u);
});

test("picks a program mark from the agent a pane names", () => {
  assert.equal(paneAgentKind({}, { agent: "claude" }), "claude");
  assert.equal(paneAgentKind({ agent: "Claude" }, undefined), "claude");
  assert.equal(paneAgentKind({ agent_session: { agent: "claude" } }, null), "claude");
  assert.equal(paneAgentKind({ agent: "codex" }, null), "codex");
  assert.equal(paneAgentKind({}, { agent: "gemini" }), "other");
  assert.equal(paneAgentKind({ agent: "agy" }, null), "agy");
  assert.equal(paneAgentKind({}, { agent: "Antigravity" }), "agy");
  assert.equal(paneAgentKind({ agent: "opencode" }, null), "opencode");
  assert.equal(paneAgentKind({}, { agent: "OpenCode" }), "opencode");
  assert.equal(paneAgentKind({}, null), "shell");
  assert.equal(paneAgentKind({ agent: "bash" }, { name: "builder" }), "shell");
  assert.equal(paneAgentKind({ agent: "  " }, { agent: "" }), "shell");
});

test("chooses the status indicator at a row's far right", () => {
  assert.equal(agentStatusIcon("blocked"), "×");
  assert.equal(agentStatusIcon("working"), "◐");
  assert.equal(agentStatusIcon("done"), "✓");
  assert.equal(agentStatusIcon("idle"), "○");
  assert.equal(agentStatusIcon("unknown"), "·");
  assert.equal(agentStatusIcon(undefined), "·");
  assert.equal(agentStatusLabel("blocked"), "Needs your answer");
  assert.equal(agentStatusLabel("idle"), "idle");
});

test("a session's second line is its folder, unless unknown or the same as the name", () => {
  assert.equal(paneSubtitle("tests", { cwd: "/work/checkout-api" }), "checkout-api");
  assert.equal(paneSubtitle("tests", { cwd: "/work/old", foreground_cwd: "/work/new/" }), "new");
  assert.equal(paneSubtitle("Checkout-API", { cwd: "/work/checkout-api" }), "");
  assert.equal(paneSubtitle("tests", {}), "");
  assert.equal(paneSubtitle("tests", { cwd: "/" }), "");
  assert.equal(paneSubtitle("tests", null), "");
});

test("a pane is titled by its session's name, else its folder, never by the agent its mark already shows", async () => {
  const { paneDisplayTitle, paneFolder } = await import("../public/ui-model.js");
  assert.equal(paneFolder({ cwd: "/home/me/work/api/" }), "api");
  assert.equal(paneFolder({ foreground_cwd: "/srv/web", cwd: "/home/me" }), "web");
  assert.equal(paneFolder({}), "");
  assert.equal(paneDisplayTitle("Release", { cwd: "/w/api" }), "Release");
  assert.equal(paneDisplayTitle("", { cwd: "/w/api", agent: "claude" }), "api");
  assert.equal(paneDisplayTitle("", { agent: "claude" }, "Build"), "Build");
  assert.equal(paneDisplayTitle("", { agent: "claude" }), "Terminal");
  assert.equal(
    paneDisplayTitle("", { cwd: "/w/api", terminal_title: "✳ fix-login", terminal_title_stripped: "fix-login" }),
    "fix-login",
  );
  assert.equal(paneDisplayTitle("Release", { cwd: "/w/api", terminal_title_stripped: "fix-login" }), "Release");
  for (const title of ["claude", "Claude Code", "codex", "bash", "isaac@box: ~/w/api", "isaac@box", "~/w/api", "/w/api", "C:\\work\\api", "C:/work/api", "\\\\server\\share\\api", "  "]) {
    assert.equal(paneDisplayTitle("", { cwd: "/w/api", terminal_title_stripped: title }), "api", title);
  }
});
