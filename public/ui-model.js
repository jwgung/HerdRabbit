import { AGENTS, MARK_PRIORITY } from "./agents.js?v=1.4.13";

export const HISTORY_PAGE_LINES = 200;
const AGENT_STATUS_ICONS = Object.freeze({
  blocked: "×",
  working: "◐",
  done: "✓",
  idle: "○",
  unknown: "·",
});
const KNOWN_AGENT_STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);

export function outputTextForUpdate(currentText, payload) {
  if (payload?.update === "replace") {
    return typeof payload.output === "string" ? payload.output : null;
  }
  if (
    payload?.update !== "delta" ||
    typeof currentText !== "string" ||
    !Array.isArray(payload.patches) ||
    payload.patches.length === 0 ||
    payload.patches.length > 8
  ) {
    return null;
  }

  let output = currentText;
  for (const patch of payload.patches) {
    if (
      !Number.isInteger(patch?.start) ||
      patch.start < 0 ||
      !Number.isInteger(patch.deleteCount) ||
      patch.deleteCount < 0 ||
      patch.start + patch.deleteCount > output.length ||
      typeof patch.text !== "string"
    ) {
      return null;
    }
    output = output.slice(0, patch.start) +
      patch.text +
      output.slice(patch.start + patch.deleteCount);
  }
  return output;
}

// Right after sending, the echo is what the reader is waiting for. Polling on
// the normal cadence leaves a gap of up to two seconds because the scheduler
// counts from the last request it started, not from the last answer.
const SUBMISSION_BURST_INTERVAL_MS = 300;

export function outputPollingDecision({
  baseIntervalMs = 1_000,
  previousStatus = "unknown",
  currentStatus = "unknown",
  recentSubmission = false,
  connection = null,
} = {}) {
  const base = Number.isFinite(baseIntervalMs) && baseIntervalMs > 0
    ? baseIntervalMs
    : 1_000;
  // Only back off when the connection says it is metered. Android rarely
  // reports connection.type, and treating "unknown" as cellular left Wi-Fi
  // five seconds behind.
  const conserveData = connection?.saveData === true || connection?.type === "cellular";
  return {
    intervalMs: recentSubmission
      ? Math.min(base, SUBMISSION_BURST_INTERVAL_MS)
      : currentStatus === "working" && conserveData
        ? Math.max(base, 5_000)
        : base,
    refreshNow:
      previousStatus === "working" &&
      ["done", "blocked", "idle"].includes(currentStatus),
  };
}

export function sidebarPresentation({ isDesktop, desktopCollapsed, mobileOpen }) {
  if (isDesktop) {
    return {
      collapsed: desktopCollapsed === true,
      open: true,
      navigatorInert: false,
      toggleExpanded: desktopCollapsed !== true,
      toggleLabel: desktopCollapsed ? "Expand sidebar" : "Collapse sidebar",
    };
  }

  return {
    collapsed: false,
    open: mobileOpen === true,
    navigatorInert: mobileOpen !== true,
    toggleExpanded: mobileOpen === true,
    toggleLabel: "Close sidebar",
  };
}

export function detectTouchInput({
  primaryTouch = false,
  anyCoarsePointer = false,
  anyHover = false,
  maxTouchPoints = 0,
  compactViewport = false,
} = {}) {
  if (primaryTouch === true) return true;
  if (anyCoarsePointer === true && anyHover !== true) return true;
  return Number(maxTouchPoints) > 0 && compactViewport === true;
}

// What Enter in the composer does: "submit", "newline" (inserted by the page,
// for Ctrl+Enter, which a textarea ignores) or "default" (the textarea's own
// newline). An input method's Enter (isComposing / keyCode 229) is never a
// send. On a touch device Shift+Enter is a newline and plain Enter
// follows `enterMode`: "send", "newline", or "auto", which sends once
// `physicalKeyboard` has been seen.
export function inputKeyAction({
  key,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
  isComposing = false,
  keyCode = 0,
  usesTouchInput = false,
  enterMode = "auto",
  physicalKeyboard = false,
}) {
  if (key !== "Enter" || isComposing || keyCode === 229) return "default";
  if (usesTouchInput) {
    if (shiftKey) return "default";
    if (ctrlKey || metaKey) return "submit";
    if (enterMode === "send") return "submit";
    if (enterMode === "newline") return "default";
    return physicalKeyboard ? "submit" : "default";
  }
  return ctrlKey ? "newline" : "submit";
}

export function insertTextAtSelection(value, selectionStart, selectionEnd, text) {
  const start = Number.isInteger(selectionStart) ? selectionStart : value.length;
  const end = Number.isInteger(selectionEnd) ? selectionEnd : start;
  return {
    value: `${value.slice(0, start)}${text}${value.slice(end)}`,
    caret: start + text.length,
  };
}

export function insertNewlineAtSelection(value, selectionStart, selectionEnd) {
  return insertTextAtSelection(value, selectionStart, selectionEnd, "\n");
}

// A pasted path has to survive sitting next to whatever is already typed, so it
// carries its own separation instead of relying on the caret being in a
// sensible spot.
export function insertPathAtSelection(value, selectionStart, selectionEnd, path) {
  const start = Number.isInteger(selectionStart) ? selectionStart : value.length;
  const end = Number.isInteger(selectionEnd) ? selectionEnd : start;
  const before = /\s$/u.test(value.slice(0, start)) || start === 0 ? "" : " ";
  const after = /^\s/u.test(value.slice(end)) ? "" : " ";
  return insertTextAtSelection(value, start, end, `${before}${path}${after}`);
}

// The stored files, newest first by the time shown in each row; files stored
// at the same moment keep code point order of their names, as the server lists them.
export function sortUploads(files) {
  const time = (file) => {
    const value = Date.parse(file?.modifiedAt);
    return Number.isNaN(value) ? 0 : value;
  };
  const name = (file) => String(file?.name ?? "");
  return [...files].sort((a, b) => {
    const diff = time(b) - time(a);
    if (diff !== 0) return diff;
    return name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0;
  });
}

// What a batch of uploads says once it is done. Past one file a count reads
// faster than a list of names; a file that failed is always named, with why,
// because that is the one to do something about.
export function uploadSummary({ saved = [], failed = [], elsewhere = null } = {}) {
  const parts = [];
  if (saved.length > 0) {
    const what = saved.length === 1 ? saved[0] : `${saved.length} files`;
    parts.push(elsewhere
      ? `Uploaded ${what} to ${elsewhere}. ${saved.length === 1 ? "The path was" : "The paths were"} not inserted: this session runs elsewhere.`
      : `Uploaded ${what}.`);
  }
  if (failed.length > 0) {
    parts.push(`Could not upload ${failed.map(({ name, reason }) => `${name} (${reason})`).join(", ")}.`);
  }
  return parts.join(" ");
}

// The uploads folder only exists on the machine running HerdRabbit. A pane id carries
// a server prefix when it belongs to a connected PC, and a local path pasted into
// that pane would name a file the other PC does not have.
export function paneUsesLocalFiles(paneId) {
  return typeof paneId === "string" && paneId !== "" && !paneId.includes("!");
}

// Records from a connected PC carry a "<serverId>!" prefix on their ids, so the
// pane itself says which machine its files live on.
export function paneServerId(paneId) {
  if (typeof paneId !== "string" || paneId === "") return null;
  const separator = paneId.indexOf("!");
  return separator < 0 ? "local" : paneId.slice(0, separator);
}

// The pane record carries the directory the session runs in. foreground_cwd
// tracks the running process and cwd is where the session started; either beats
// falling back to the home directory. Remote panes report a path on the other
// PC, which does not exist on the machine serving these files, so they get no
// starting point at all.
export function paneStartDirectory(pane, { home = null } = {}) {
  if (!pane || !paneUsesLocalFiles(pane.pane_id ?? pane.id)) return home;
  for (const value of [pane.foreground_cwd, pane.cwd]) {
    if (typeof value === "string" && value.startsWith("/")) return value;
  }
  return home;
}

// A project's folder is whichever of its sessions reports one. Sessions in the
// same project normally share a directory, so the first answer is the project's.
export function workspaceStartDirectory(workspaceId, { tabs = [], panes = [] } = {}, options = {}) {
  const tabIds = new Set(
    tabs.filter((tab) => (tab?.workspace_id ?? tab?.workspaceId) === workspaceId)
      .map((tab) => tab?.tab_id ?? tab?.id),
  );
  for (const pane of panes) {
    const belongs = (pane?.workspace_id ?? pane?.workspaceId) === workspaceId ||
      tabIds.has(pane?.tab_id ?? pane?.tabId);
    if (!belongs) continue;
    const directory = paneStartDirectory(pane, { home: null });
    if (directory) return directory;
  }
  return options.home ?? null;
}

// The tree is drawn from a flat list because only expanded folders have been
// fetched; a folder nobody opened has no children to recurse into.
export function flattenTree(path, loaded, expanded, depth = 0) {
  const listing = loaded.get(path);
  if (!listing) return [];
  const rows = [];
  for (const entry of listing.entries) {
    const open = expanded.has(entry.path);
    rows.push({ entry, depth, expanded: open });
    if (open && entry.kind === "directory") {
      rows.push(...flattenTree(entry.path, loaded, expanded, depth + 1));
    }
  }
  return rows;
}

export function browseDiffSummary(addedCount, removedCount) {
  const parts = [];
  if (addedCount > 0) parts.push(`${addedCount} added`);
  if (removedCount > 0) parts.push(`${removedCount} removed`);
  return parts.join(", ");
}

export function diffBrowseListing(oldListing, newListing) {
  if (!newListing) return { listing: null, added: [], removed: [] };
  if (!oldListing) {
    return {
      listing: newListing,
      added: [],
      removed: [],
    };
  }

  const previousNonRemoved = (oldListing.entries || []).filter((entry) => !entry.removed);
  const previousPaths = new Map(previousNonRemoved.map((entry) => [entry.path, entry]));
  const newPaths = new Map((newListing.entries || []).map((entry) => [entry.path, entry]));
  const previousRemoved = (oldListing.entries || []).filter((entry) => entry.removed);

  const added = [];
  for (const entry of newListing.entries || []) {
    if (!previousPaths.has(entry.path)) {
      added.push(entry);
    }
  }

  const newlyRemoved = [];
  for (const entry of previousNonRemoved) {
    if (!newPaths.has(entry.path)) {
      newlyRemoved.push({ ...entry, removed: true });
    }
  }

  const retainedRemoved = previousRemoved.filter((entry) => !newPaths.has(entry.path));

  const mergedEntries = [...(newListing.entries || []), ...newlyRemoved, ...retainedRemoved];
  mergedEntries.sort((first, second) => {
    if (first.kind !== second.kind) return first.kind === "directory" ? -1 : 1;
    return first.name < second.name ? -1 : (first.name > second.name ? 1 : 0);
  });

  return {
    listing: {
      ...newListing,
      entries: mergedEntries,
    },
    added,
    removed: newlyRemoved,
  };
}

export function parentDirectory(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "/") return null;
  const cut = trimmed.lastIndexOf("/");
  return cut === 0 ? "/" : trimmed.slice(0, cut);
}

// Breadcrumbs drop their middle on narrow screens: the root and the last few
// segments say where you are, and the elision stands in for the rest.
export function breadcrumbSegments(path, { maxSegments = 4 } = {}) {
  if (typeof path !== "string" || !path.startsWith("/")) return [];
  const names = path.split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
  let walked = "";
  for (const name of names) {
    walked += `/${name}`;
    crumbs.push({ label: name, path: walked });
  }
  if (crumbs.length <= maxSegments) return crumbs;
  const tail = Math.max(1, maxSegments - 2);
  return [crumbs[0], { label: "…", path: null }, ...crumbs.slice(-tail)];
}

export function isInsideDirectory(path, directory) {
  if (typeof path !== "string" || typeof directory !== "string" || directory === "") return false;
  const root = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  return path === root || path.startsWith(`${root}/`);
}

export function formatTransferSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function paneShortcutTarget({
  key,
  ctrlKey = false,
  shiftKey = false,
  altKey = false,
  metaKey = false,
  isComposing = false,
  paneIds = [],
  currentPaneId = null,
} = {}) {
  const ids = Array.isArray(paneIds) ? paneIds : [];
  if (
    !ctrlKey ||
    altKey ||
    metaKey ||
    isComposing ||
    ids.length === 0
  ) return null;

  if (key === "Tab") {
    const currentIndex = ids.indexOf(currentPaneId);
    if (shiftKey) {
      return ids[currentIndex <= 0 ? ids.length - 1 : currentIndex - 1];
    }
    return ids[currentIndex < 0 ? 0 : (currentIndex + 1) % ids.length];
  }

  if (!shiftKey && /^[1-9]$/u.test(key)) {
    return ids[Number(key) - 1] || null;
  }
  return null;
}

export function nextInputHistory({
  history,
  cursor = null,
  draft = "",
  currentValue = "",
  direction,
}) {
  const entries = Array.isArray(history) ? history : [];
  if (entries.length === 0 || (direction !== "previous" && direction !== "next")) {
    return { handled: false, cursor, draft, value: currentValue };
  }

  if (direction === "previous") {
    const nextCursor = cursor === null
      ? entries.length - 1
      : Math.max(0, cursor - 1);
    return {
      handled: true,
      cursor: nextCursor,
      draft: cursor === null ? currentValue : draft,
      value: entries[nextCursor],
    };
  }

  if (cursor === null) {
    return { handled: false, cursor, draft, value: currentValue };
  }
  if (cursor < entries.length - 1) {
    const nextCursor = cursor + 1;
    return {
      handled: true,
      cursor: nextCursor,
      draft,
      value: entries[nextCursor],
    };
  }
  return { handled: true, cursor: null, draft: "", value: draft };
}

export function shouldBrowseInputHistory({ key, value, selectionStart, selectionEnd }) {
  if (selectionStart !== selectionEnd) return false;
  if (key === "ArrowUp") return selectionStart === 0;
  if (key === "ArrowDown") return selectionEnd === value.length;
  return false;
}

export function preferredLoginMethod({ lastMethod, touchInput = false, passkeyAvailable = false }) {
  const preferred = lastMethod === "password" || lastMethod === "passkey"
    ? lastMethod : touchInput ? "passkey" : "password";
  return preferred === "passkey" && passkeyAvailable ? "passkey" : "password";
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function idOf(record, ...keys) {
  for (const key of keys) {
    if (typeof record?.[key] === "string") return record[key];
  }
  return "";
}

// A rename form holds text that exists nowhere else yet, so the redraw that
// would discard it has to know one is open. Every rename needs that, and the
// sidebar has three of them -- a check that names one by hand goes stale the
// day a fourth arrives, which is exactly how sessions came to lose what was
// typed into them.
//
// The record being renamed can also vanish underneath the form -- a session
// closed on the machine itself -- and a flag left pointing at something gone
// would stop the sidebar redrawing for good. So this drops those first and
// reports what is genuinely still open.
export function openRenames(editing, records) {
  const present = (list, id, ...keys) => array(list).some((record) => idOf(record, ...keys) === id);
  const workspaceId = editing?.workspaceId || null;
  const tabId = editing?.tabId || null;
  const serverId = editing?.serverId || null;
  const open = {
    workspaceId: workspaceId && present(records?.workspaces, workspaceId, "workspace_id", "id")
      ? workspaceId
      : null,
    tabId: tabId && present(records?.tabs, tabId, "tab_id", "id") ? tabId : null,
    // A snapshot always carries this machine, so an empty server list means no
    // snapshot has arrived rather than that the server went away.
    serverId: serverId && (array(records?.servers).length === 0 || present(records?.servers, serverId, "id"))
      ? serverId
      : null,
  };
  return { ...open, any: Boolean(open.workspaceId || open.tabId || open.serverId) };
}

// A pane on another server that is not in the snapshot yet is waited for, not
// replaced by some other pane, while that server is still connecting -- and
// only for so long. A server that failed to answer, or is not listed at all,
// has nothing coming.
export function waitsForRemotePane(paneId, panes, servers, waitedMs, limitMs) {
  if (!paneId?.includes("!") || waitedMs >= limitMs) return false;
  if (array(panes).some((pane) => idOf(pane, "pane_id", "id") === paneId)) return false;
  const serverId = paneId.split("!")[0];
  const server = array(servers).find((item) => item?.id === serverId);
  return server?.connecting === true;
}

// The pane on screen whose server dropped stays on screen while that server
// comes back.
export function keepsVanishedRemotePane(paneId, panes, servers) {
  if (!paneId?.includes("!")) return false;
  if (array(panes).some((pane) => idOf(pane, "pane_id", "id") === paneId)) return false;
  const serverId = paneId.split("!")[0];
  return array(servers).some((server) => server?.id === serverId && !server.available);
}

export function selectedPaneIdForSnapshot(
  panes,
  currentPaneId,
  defaultHerdrSessionId = null,
) {
  const paneIds = array(panes).map((pane) => idOf(pane, "pane_id", "id"));
  if (currentPaneId && paneIds.includes(currentPaneId)) return currentPaneId;
  if (
    currentPaneId &&
    defaultHerdrSessionId &&
    !currentPaneId.includes("~")
  ) {
    const migratedPaneId = `${defaultHerdrSessionId}~${currentPaneId}`;
    if (paneIds.includes(migratedPaneId)) return migratedPaneId;
  }
  return paneIds[0] || null;
}

// What a snapshot's arrival does to the pane on screen, decided from what the
// page holds and nothing else; the page then does what it says.
//   adopted    a notification's pane has arrived and was selected (the page
//              drops ?pane= from its address and closes the phone sidebar)
//   giveUp     a pane on another server that will not come: the page drops it
//              from ?pane= so a reload does not wait for it all over again
//   stop       "waiting": a pane on a connecting server is awaited, so no other
//              pane is opened in its place; "vanished": the pane on screen
//              stays while its server comes back. Either way nothing after
//              the notification step changes.
//   remember   the pane to keep as the one to open next time, or null
// The new selection, preference and pending notification pane come back in
// selectedPaneId, preferredPaneId and pendingPaneId.
export function paneSelectionAfterSnapshot({
  panes,
  servers,
  herdrSessions,
  selectedPaneId,
  preferredPaneId,
  pendingPaneId,
  pendingSince,
  openedAt,
  now,
  waitLimitMs,
}) {
  const present = (paneId) => array(panes).some((pane) => idOf(pane, "pane_id", "id") === paneId);
  let selected = selectedPaneId ?? null;
  let preferred = preferredPaneId ?? null;
  let pending = pendingPaneId ?? null;
  let adopted = false;
  if (pending && present(pending)) {
    selected = pending;
    pending = null;
    adopted = true;
  }
  const outcome = (stop, giveUp, next) => ({
    selectedPaneId: next === undefined ? selected : next,
    preferredPaneId: next ? next : preferred,
    pendingPaneId: pending,
    adopted,
    giveUp,
    stop,
    remember: next === undefined ? (adopted ? selected : null) : next,
  });

  // A pane of another server arrives before that server's panes have loaded;
  // the page opening on one (from its address or the last visit) waits the same way.
  const awaited = pending ?? (selected ? null : preferred);
  const awaitedSince = pending ? pendingSince : openedAt;
  if (waitsForRemotePane(awaited, panes, servers, now - awaitedSince, waitLimitMs)) {
    return outcome("waiting", null);
  }
  let giveUp = null;
  if (awaited?.includes("!") && !present(awaited)) {
    if (awaited === pending) pending = null;
    giveUp = awaited;
  }
  if (keepsVanishedRemotePane(selected, panes, servers)) return outcome("vanished", giveUp);

  const defaultHerdrSessionId = idOf(
    array(herdrSessions).find((session) => session.default === true),
    "session_id",
    "id",
  ) || null;
  const next = selectedPaneIdForSnapshot(panes, selected || preferred, defaultHerdrSessionId);
  return outcome(null, giveUp, next);
}

// How the page sees a machine's connection. This machine shows the page's own
// trouble reaching its server (`pageConnection`: { kind, text }); any other
// shows what the server says of it.
export function serverConnectionState(server, pageConnection) {
  if (server.id === "local" && pageConnection?.kind === "error") {
    return { online: false, error: true, text: pageConnection.text };
  }
  return { online: server.available === true, error: false, text: server.status };
}

// What the sidebar's tree is made of, decided from the snapshot and nothing
// else; the page draws it and keeps its own editing and dragging to itself.
//   servers    the machines, each with `children` (what stands under it)
//   children   what stands outside every machine
//   empty      nothing to show under the machines: no projects, and no
//              session headings to say why
// A node is { kind: "session" | "workspace", id, record, ... }:
//   session    status ("Running", "Connection failed", "Stopped"), tone
//              ("online", "error", "stopped"), emptyText, workspaces
//   workspace  tabs ({ id, record, panes }), hasCompletion, hasRequest
// A session heading earns its place only when there is something to tell
// apart: more than one session on a machine, or one that is not running.
// Without one the projects belong to a machine directly; a node of a machine
// that is not listed stands outside.
// `statusOfPane(paneId, pane)`: the status the sidebar shows for a pane.
export function navigationModel({
  servers,
  herdrSessions,
  workspaces,
  tabs,
  panes,
  statusOfPane,
  pageConnection = null,
}) {
  const sessions = array(herdrSessions);
  const sessionsPerServer = new Map();
  for (const session of sessions) {
    const id = session.server_id || "local";
    sessionsPerServer.set(id, (sessionsPerServer.get(id) || 0) + 1);
  }
  const showSessionGroups = [...sessionsPerServer.values()].some((count) => count > 1) ||
    sessions.some((session) => session.available !== true);

  const workspaceNode = (workspace) => {
    const id = idOf(workspace, "workspace_id", "id");
    const tabNodes = array(tabs)
      .filter((tab) => idOf(tab, "workspace_id", "workspaceId") === id)
      .map((tab) => {
        const tabId = idOf(tab, "tab_id", "id");
        return {
          id: tabId,
          record: tab,
          panes: array(panes).filter((pane) => idOf(pane, "tab_id", "tabId") === tabId),
        };
      });
    const anyPane = (status) => tabNodes.some((tab) => tab.panes.some(
      (pane) => statusOfPane(idOf(pane, "pane_id", "id"), pane) === status,
    ));
    return {
      kind: "workspace", id, record: workspace, tabs: tabNodes,
      hasCompletion: anyPane("done"), hasRequest: anyPane("blocked"),
    };
  };

  const sessionNode = (session) => {
    const id = idOf(session, "session_id", "id");
    const status = session.available === true ? "Running" : session.running === true ? "Connection failed" : "Stopped";
    return {
      kind: "session", id, record: session, status,
      tone: session.available === true ? "online" : session.running === true ? "error" : "stopped",
      emptyText: session.available === true ? "No open projects" : status,
      workspaces: array(workspaces)
        .filter((workspace) => idOf(workspace, "herdr_session_id", "herdrSessionId") === id)
        .map(workspaceNode),
    };
  };

  const serverNodes = array(servers).map((server) => ({
    id: server.id,
    record: server,
    connection: serverConnectionState(server, pageConnection),
    role: server.id === "local" ? "host"
      : !server.available ? (server.status === "Connecting" ? "connecting" : "offline") : null,
    emptyText: !server.available || !sessions.some((session) => session.server_id === server.id)
      ? (server.available ? "No Herdr sessions. Start Herdr on this server." : server.status)
      : null,
    children: [],
  }));
  const root = [];
  const placeIn = (serverId) => serverNodes.find((node) => node.id === serverId)?.children ?? root;
  if (showSessionGroups) {
    for (const session of sessions) placeIn(session.server_id).push(sessionNode(session));
  } else {
    for (const workspace of array(workspaces)) placeIn(workspace.server_id).push(workspaceNode(workspace));
  }
  return {
    servers: serverNodes,
    children: root,
    showSessionGroups,
    empty: !showSessionGroups && array(workspaces).length === 0,
  };
}

export function displayRecordLabel(record, fallback) {
  const values = [
    record?.label,
    record?.display_agent,
    record?.agent,
    record?.name,
    record?.terminal_title_stripped,
    record?.title,
  ];
  return values.find((value) => typeof value === "string" && value.trim() !== "") || fallback;
}

export function displayTabLabel(tab) {
  const label = displayRecordLabel(tab, "");
  return /^\d+$/.test(label.trim()) ? "" : label;
}

// Herdr has no way to unname a tab -- `tab rename` wants a label -- so clearing
// a session name means putting back the number it was born with, which is
// exactly what displayTabLabel hides. A tab that cannot say its number cannot
// be cleared, and the caller has to keep asking for a name.
export function clearedTabLabel(tab) {
  const number = tab?.number;
  return Number.isInteger(number) && number > 0 ? String(number) : null;
}

export function agentStatus(agent, pane) {
  const value =
    agent?.agent_status ||
    agent?.state ||
    pane?.agent_status ||
    pane?.agent_state;
  return KNOWN_AGENT_STATES.has(value) ? value : "unknown";
}

export function agentCompletionIdentity(agent, pane) {
  for (const record of [agent, pane]) {
    const sequence = record?.state_change_seq;
    if (Number.isSafeInteger(sequence) && sequence >= 0) {
      return `seq:${sequence}`;
    }
  }
  for (const record of [agent, pane]) {
    const revision = record?.revision;
    if (Number.isSafeInteger(revision) && revision >= 0) {
      return `revision:${revision}`;
    }
  }
  return null;
}

export function visibleAgentStatus(agent, pane, acknowledgedCompletion = null) {
  const status = agentStatus(agent, pane);
  if (
    status === "done" &&
    acknowledgedCompletion !== null &&
    agentCompletionIdentity(agent, pane) === acknowledgedCompletion
  ) {
    return "idle";
  }
  return status;
}

// Which program mark a session row wears, by the agent a snapshot names.
// "shell" is a pane with no agent (or a plain shell); "other" is any agent
// without a mark of its own.
const SHELL_NAMES = new Set(["", "shell", "terminal", "bash", "zsh", "sh", "fish", "pwsh", "powershell", "nu"]);

// The agents with a mark of their own, in the order a pane is tested for them,
// by the names their program goes by.
const MARKED_AGENTS = MARK_PRIORITY.map((name) => [name, AGENTS.find((agent) => agent.name === name).marks]);

// The marked agent a lower-case program name starts with, or null.
function markedAgentOf(name) {
  for (const [kind, prefixes] of MARKED_AGENTS) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) return kind;
  }
  return null;
}

export function paneAgentKind(pane, agent) {
  const names = [agent?.agent, agent?.display_agent, pane?.agent, pane?.display_agent, pane?.agent_session?.agent]
    .filter((name) => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim().toLowerCase());
  if (names.length === 0) return "shell";
  for (const [kind] of MARKED_AGENTS) {
    if (names.some((name) => markedAgentOf(name) === kind)) return kind;
  }
  return names.every((name) => SHELL_NAMES.has(name)) ? "shell" : "other";
}

// What sits left of a session row's menu: Herdr's own symbol for the status.
// `agentStatusLabel` is the same status in words, for the row's label.
export function agentStatusIcon(status) {
  return AGENT_STATUS_ICONS[status] || AGENT_STATUS_ICONS.unknown;
}

export function agentStatusLabel(status) {
  return status === "blocked" ? "Needs your answer" : status === "done" ? "Done" : status === "working" ? "Working" : status;
}

// Most urgent first: an answer waited for, then work going on, then work
// finished and not yet seen, then a pane at rest.
const STATUS_URGENCY = ["blocked", "working", "done", "idle", "unknown"];

// The status a split session's one row shows: the most urgent of its panes'.
export function mostUrgentStatus(statuses) {
  let best = STATUS_URGENCY.length - 1;
  for (const status of statuses) {
    const rank = STATUS_URGENCY.indexOf(status);
    if (rank !== -1 && rank < best) best = rank;
  }
  return STATUS_URGENCY[best];
}

// The folder a pane works in, by its last name; "" when unknown.
export function paneFolder(pane) {
  const cwd = [pane?.foreground_cwd, pane?.cwd].find((value) => typeof value === "string" && value.trim() !== "");
  if (!cwd) return "";
  return cwd.trim().replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() ?? "";
}

// A title that is only a program's name, maybe with "code", "cli" or a
// version after it ("Claude Code 2.0", "codex v0.4"). A conversation title
// that merely starts with an agent's name ("claude-config-fix") is not one.
function namesOnlyItsProgram(title) {
  const lower = title.toLowerCase();
  if (SHELL_NAMES.has(lower)) return true;
  const [first, ...rest] = lower.split(/\s+/u);
  const agent = markedAgentOf(first);
  if (!agent || !MARKED_AGENTS.find(([kind]) => kind === agent)[1].includes(first)) return false;
  return rest.every((word) => word === "code" || word === "cli" || /^v?\d[\w.-]*$/u.test(word));
}

// The title the pane's agent gave its terminal (Claude names it after the
// conversation), with Herdr's spinner already stripped; "" when it only names
// the program, the user or the folder, and for a plain shell, whose title
// changes with every command it runs.
// `agent` is the snapshot's agent record for the pane, when it has one apart.
export function paneTerminalTitle(pane, agent) {
  if (paneAgentKind(pane, agent) === "shell") return "";
  const value = [
    pane?.terminal_title_stripped,
    agent?.terminal_title_stripped,
    pane?.terminal_title,
    agent?.terminal_title,
  ].find(
    (title) => typeof title === "string" && title.trim() !== "",
  );
  if (!value) return "";
  const title = value.trim();
  if (namesOnlyItsProgram(title)) return "";
  if (/^[^\s@]+@[^\s:]+(:|$)/u.test(title)) return "";
  if (/^[~/]|^[A-Za-z]:[\\/]|^\\\\/u.test(title)) return "";
  return title;
}

// What a pane is called where its program's mark already says which agent it
// is: its session's name, else the title its program gave it, else its folder,
// else `fallback`. The agent's name would only repeat the mark.
export function paneDisplayTitle(named, pane, fallback = "Terminal", agent = null) {
  return named || paneTerminalTitle(pane, agent) || paneFolder(pane) || fallback;
}

// The line under a session's name: the folder it runs in, unless that only
// repeats the name or is unknown.
export function paneSubtitle(title, pane) {
  const name = paneFolder(pane);
  if (name === "") return "";
  return name.toLowerCase() === String(title ?? "").trim().toLowerCase() ? "" : name;
}

// The server names sign-in projects with this prefix (src/http-server.mjs).
export const AI_LOGIN_LABEL_PREFIX = "AI login: ";

export function isAiLoginWorkspace(workspace) {
  return typeof workspace?.label === "string" && workspace.label.startsWith(AI_LOGIN_LABEL_PREFIX);
}

// What is typed into a sign-in terminal can be a one-time code, so it is not
// kept in the prompt history the browser stores.
export function paneKeepsInputHistory(paneId, { panes = [], workspaces = [] } = {}) {
  const pane = panes.find((item) => item.pane_id === paneId);
  const workspace = pane && workspaces.find((item) => item.workspace_id === pane.workspace_id);
  return !isAiLoginWorkspace(workspace);
}

const DAY_MS = 86_400_000;

// A to Z by email, the one in use included, so an account keeps its place
// when another is switched to. One whose email is unknown goes last.
export function sortAiAccounts(accounts) {
  return [...accounts].sort((left, right) => {
    if (!left.email || !right.email) return Number(!left.email) - Number(!right.email);
    return left.email.localeCompare(right.email, undefined, { sensitivity: "base" });
  });
}

// One line under a passkey's name. Passkeys registered before dates were kept
// have none, and say nothing about use rather than claim they were never used.
export function passkeyDetails(passkey, formatDate) {
  const details = [];
  if (passkey?.createdAt) details.push(`Added ${formatDate(passkey.createdAt)}`);
  if (passkey?.lastUsedAt) details.push(`Last used ${formatDate(passkey.lastUsedAt)}`);
  else if (passkey?.createdAt) details.push("Not used yet");
  if (passkey?.backedUp) details.push("Synced");
  return details.join(" · ");
}

// The list shows an email and nothing else until a new sign-in is close; a date
// weeks away is not worth a line.
export function aiAccountNotice(account, { now = Date.now() } = {}) {
  const expiresAt = account?.refreshExpiresAt;
  if (!Number.isFinite(expiresAt)) return null;
  if (expiresAt <= now) return "Sign-in expired";
  return expiresAt - now < 7 * DAY_MS ? "Sign in again soon" : null;
}

// Opening the list saves whatever is signed in now, so no account is ever
// shown as in use but not saved.
export function aiAccountsToSave(clis = []) {
  return clis.filter((cli) => cli.supported && cli.current && !cli.current.id).map((cli) => cli.id);
}

// A sign-in terminal opens in a running Herdr session of the server it is for.
export function aiLoginSessionId(serverId, herdrSessions = []) {
  const session = herdrSessions.find((item) =>
    (item.server_id ?? "local") === serverId && item.running && item.available !== false);
  return session?.session_id ?? null;
}

export function aiRestartHint(cli) {
  return cli === "codex" ? "codex resume" : "claude --continue";
}

export function loginMethodPresentation({
  passkeyAvailable = false,
  passkeySupported = false,
} = {}) {
  const passkeyVisible = passkeyAvailable && passkeySupported;
  return passkeyVisible
    ? {
        passkeyVisible: true,
        passkeyPrimary: true,
        passwordPrimary: false,
        focusTarget: "passkey",
        instruction: "Sign in with a passkey or use your password.",
        passwordLabel: "Password",
      }
    : {
        passkeyVisible: false,
        passkeyPrimary: false,
        passwordPrimary: true,
        focusTarget: "password",
        instruction: "Enter your password.",
        passwordLabel: "Password",
      };
}

// Herdr's own SSH machines (`herdr machine`) are not shown any more; remote
// PCs run HerdRabbit and are added with Connect PC. The page says so once
// when Herdr still lists some, and leaves Herdr's list as it is.
export function legacyMachinesNotice({ count = 0, seen = false } = {}) {
  if (seen || !Number.isInteger(count) || count < 1) return null;
  return "Herdr SSH machines are no longer shown here. " +
    "Install HerdRabbit on that PC and add it with + → Connect PC.";
}
