import {
  HISTORY_PAGE_LINES,
  agentStatus,
  displayRecordLabel,
  displayTabLabel,
  outputPollingDecision,
  outputTextForUpdate,
  paneAgentKind,
  paneDisplayTitle,
  paneSelectionAfterSnapshot,
  paneServerId,
  reconcileLiveStatus,
  seenCompletions,
} from "../ui-model.js?v=1.4.51";
import { chatAgent } from "../lens-preference.js?v=1.4.51";
import { previewFor } from "../file-preview.js?v=1.4.51";
import { foldersOf, isFileName, isFolderPath, pathCandidates, trimTrailingSlashes } from "../path-links.js?v=1.4.51";
import { writePanePreference } from "../pane-preference.js?v=1.4.51";
import { createElement } from "./dom.js?v=1.4.51";
import { idOf } from "./snapshot.js?v=1.4.51";

// The selected pane: its heading, the file names in its terminal that open as
// links, choosing which pane to show after a snapshot, the live agent statuses,
// reading the snapshot, and drawing and writing to the pane's terminal.
// Nothing here runs until createSelection is called; app.js calls it where
// this code used to sit.
// `snapshotSettled`, `stopTarget`, `modifierPaneId` and `revealGeneration`
// stay app.js's own `let`s (other parts of the page read or assign them), and
// so does `shownPaneView`; they are read and assigned through accessors on
// `deps`. The terminal socket, the attached terminal, the Chat lens, the prompt
// dock, the terminal find and the Files tab's state are made after this and
// are read through getters on `deps`.
export function createSelection(deps) {
  const {
    state, elements, notificationNavigation, panePreferenceStorage, pageOpenedAt,
    PENDING_REMOTE_PANE_MS, OUTPUT_SUBMISSION_BURST_MS, OUTPUT_SUBMISSION_RETRY_MS,
    snapshotRecords, agentForPane, acknowledgePaneCompletion, pruneAcknowledgedCompletions,
    api, transferRequest, completeNotificationRelay, restoreNotificationTarget,
    resetInputHistoryNavigation, syncComposerDraft, syncAttachAvailability, clearKeyModifiers, syncSendButton,
    agentMark, viewFile, revealInFiles, refreshBrowseFolder, showTerminalView, syncTerminalFind,
    closeMobileSidebar, renameIsOpen, renderNavigation, setConnection, pruneViewSplit, renderPaneViews,
    renderTerminalStatus, setFeedback = () => {},
  } = deps;

  function renderPaneHeading(pane, tab, workspace) {
    syncAttachAvailability();
    if (deps.modifierPaneId !== state.selectedPaneId) clearKeyModifiers();
    if (!pane) {
      elements.paneContext.textContent = "Select a pane";
      elements.paneTitle.textContent = "Terminal";
      elements.paneTitle.removeAttribute("title");
      deps.stopTarget = { paneId: null, agent: null, status: null };
      deps.chatLens.select(null);
      deps.promptDock?.select(null);
      syncSendButton();
      return;
    }

    const paneId = idOf(pane, "pane_id", "id");
    const agent = agentForPane(paneId);
    deps.stopTarget = { paneId, agent: chatAgent(pane, agent), status: agentStatus(agent, pane) };
    deps.chatLens.select(paneId, { agent: chatAgent(pane, agent), status: agentStatus(agent, pane) });
    deps.promptDock?.select(paneId, { agent: chatAgent(pane, agent), status: agentStatus(agent, pane) });
    syncSendButton();
    const workspaceLabel = displayRecordLabel(workspace, "Workspace");
    const tabLabel = displayTabLabel(tab);

    const sessionName = typeof pane.herdr_session_name === "string"
      ? pane.herdr_session_name
      : "";
    const herdrSessions = snapshotRecords().herdrSessions;
    const showSessionName = herdrSessions.length > 1 ||
      (herdrSessions.length === 1 && herdrSessions[0].available !== true);
    // Each part is its own span, so a phone can keep only the last one: the
    // session's tab name, which tells sessions of one project apart.
    const parts = [
      snapshotRecords().servers.length > 1 ? pane.server_name : "",
      showSessionName ? sessionName : "",
      workspaceLabel,
      tabLabel,
    ].filter(Boolean);
    elements.paneContext.replaceChildren(...parts.flatMap((text, index) => {
      const node = createElement("span", { className: index === parts.length - 1 ? "pane-context-part is-kept" : "pane-context-part", text });
      if (index === 0) return [node];
      return [createElement("span", { className: "pane-context-sep", text: " / " }), node];
    }));
    // the program's mark says which agent it is; the title says which pane
    const title = paneDisplayTitle("", pane, tabLabel || "Terminal", agent);
    elements.paneTitle.replaceChildren(agentMark(paneAgentKind(pane, agent)), createElement("span", { className: "pane-title-text", text: title }));
    elements.paneTitle.title = displayRecordLabel(agent, displayRecordLabel(pane, "Terminal"));
  }

  // An agent names files as it works -- "wrote src/api.mjs", "see ./docs/plan.md"
  // -- and on a phone the only way to look at one was to go find it in the tree.
  // A named file that this app can show becomes a link that opens it; any other
  // name that ends in an extension becomes a link that shows it in the Files tab.
  // So does a folder written out in full (`/home/me/proj`, `./build`): it opens
  // in the Files tab.
  //
  // A relative name needs a folder to be found in: with none (a pane whose
  // directory is unknown) it is left as plain text rather than offered as a
  // link that fails when pressed. `~` is resolved by the machine that opens
  // it. Where a link then points is decided when it is pressed (locatePath).
  function resolveTerminalPath(raw) {
    if (raw.startsWith("/")) return raw;
    if (raw === "~" || raw.startsWith("~/")) return raw;
    if (raw.startsWith("~")) return null;
    const pane = selectedRecords().pane;
    const base = pane?.foreground_cwd || pane?.cwd;
    if (typeof base !== "string" || !base.startsWith("/")) return null;
    // `..` and `.` survive as they are: the machine that opens this resolves it.
    return `${trimTrailingSlashes(base)}/${raw.replace(/^\.\//u, "")}`;
  }

  // Whether the viewer is sure it can show a file of this name. A name it would
  // only try as text does not count, or any word in a terminal would be a link.
  const hasPreview = (name) => {
    const preview = previewFor(name);
    return preview !== null && !preview.probe;
  };

  function isLinkableTerminalPath(raw) {
    const name = raw.split("/").pop();
    return (hasPreview(name) || isFileName(name) || isFolderPath(raw)) && resolveTerminalPath(raw) !== null;
  }

  // Whether `path` on `server` lists as a folder. A file, or nothing there,
  // does not.
  async function listsAsFolder(server, path) {
    try {
      await transferRequest(`/api/browse?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`);
      return true;
    } catch {
      return false;
    }
  }

  // Where a pressed path is: the first of its candidates (path-links.js
  // pathCandidates) that is there on `server`, asked of the machine that has
  // it by listing its folder for that name. `context` is what a chat knows
  // about the writing: absolute paths before it (`near`) and the folder the
  // agent works in (`cwd`). Null when none is there.
  async function locatePath(raw, context, server) {
    const pane = selectedRecords().pane;
    const bases = [...foldersOf(context?.near ?? []), context?.cwd, pane?.foreground_cwd, pane?.cwd];
    const candidates = pathCandidates(raw, bases);
    for (const candidate of candidates) {
      const trimmed = trimTrailingSlashes(candidate) || "/";
      if (trimmed === "~") {
        const home = await listing(server, "~");
        if (home?.path) return { path: home.path, tried: candidates };
        continue;
      }
      const slash = trimmed.lastIndexOf("/");
      const folder = slash <= 0 ? (trimmed.startsWith("~") ? "~" : "/") : trimmed.slice(0, slash);
      const name = trimmed.slice(slash + 1);
      const found = await listing(server, folder, name);
      if (found?.entries?.some((entry) => entry.name === name)) {
        const path = `${found.path === "/" ? "" : found.path}/${name}`;
        return { path: candidate.endsWith("/") ? `${path}/` : path, tried: candidates };
      }
    }
    return { path: null, tried: candidates };
  }

  async function listing(server, folder, prefix = "") {
    try {
      const response = await transferRequest(`/api/browse?server=${encodeURIComponent(server)}&path=${encodeURIComponent(folder)}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`);
      return await response.json();
    } catch {
      return null;
    }
  }

  async function openTerminalPath(raw, context = {}) {
    if (!resolveTerminalPath(raw)) return;
    const server = paneServerId(state.selectedPaneId) || "local";
    // Anything picked meanwhile -- a folder, a machine, another link, another
    // pane -- wins over this one, while it is looked for or asked about.
    const generation = ++deps.revealGeneration;
    const paneId = state.selectedPaneId;
    const superseded = () => generation !== deps.revealGeneration || paneId !== state.selectedPaneId;
    // An absolute path is where it says, as before; the rest is looked for.
    const located = raw.startsWith("/") ? { path: raw, tried: [raw] } : await locatePath(raw, context, server);
    if (superseded()) return;
    if (!located.path) {
      setFeedback(located.tried.length
        ? `Couldn't find ${raw}. Looked in ${located.tried.map((path) => path.slice(0, path.length - raw.replace(/^(?:\.\/)+/u, "").length - 1) || "/").join(", ")}.`
        : `Couldn't find ${raw}.`, true);
      return;
    }
    const resolved = located.path;
    // a closing slash says "folder"; the name is the last one before it
    const trimmed = trimTrailingSlashes(resolved) || "/";
    const name = trimmed.split("/").pop();
    // A folder may well be called `docs.md`: one written out in full is asked
    // about before the viewer is opened on it.
    const viewable = trimmed === resolved && hasPreview(name)
      && !(isFolderPath(raw) && await listsAsFolder(server, trimmed));
    if (superseded()) return;
    if (viewable) void viewFile(resolved, name, server);
    else void revealInFiles(trimmed, name, server);
  }

  function showTerminalMessage(message) {
    elements.terminalMessage.textContent = message;
    showTerminalView(false);
    state.renderedPaneId = null;
    if (deps.terminalFind) syncTerminalFind();
  }

  function selectedRecords() {
    return selectedRecordsFor(state.selectedPaneId);
  }

  // The pane `paneId`, its tab and its project.
  function selectedRecordsFor(paneId) {
    const { workspaces, tabs, panes } = snapshotRecords();
    const pane = panes.find((item) => idOf(item, "pane_id", "id") === paneId);
    const tabId = idOf(pane, "tab_id", "tabId");
    const tab = tabs.find((item) => idOf(item, "tab_id", "id") === tabId);
    const workspaceId = idOf(tab, "workspace_id", "workspaceId") || idOf(pane, "workspace_id");
    const workspace = workspaces.find(
      (item) => idOf(item, "workspace_id", "id") === workspaceId,
    );
    return { pane, tab, workspace };
  }

  function selectedAgentStatus() {
    const { pane } = selectedRecords();
    return agentStatus(agentForPane(state.selectedPaneId), pane);
  }

  // ?pane= names the pane a link or notification opened; once it is used up (or
  // given up on), a reload must not open it again. `onlyIf` drops it only when
  // it still names that pane.
  function dropPaneFromAddress(onlyIf = null) {
    const currentUrl = new URL(window.location.href);
    if (onlyIf !== null && currentUrl.searchParams.get("pane") !== onlyIf) return;
    currentUrl.searchParams.delete("pane");
    window.history.replaceState(null, "", currentUrl);
  }

  // What to select is decided by paneSelectionAfterSnapshot (ui-model.js); this
  // carries it out.
  function choosePane() {
    const { herdrSessions, panes, servers } = snapshotRecords();
    const before = state.selectedPaneId;
    const plan = paneSelectionAfterSnapshot({
      panes,
      servers,
      herdrSessions,
      selectedPaneId: state.selectedPaneId,
      preferredPaneId: state.preferredPaneId,
      pendingPaneId: notificationNavigation.pendingPaneId,
      pendingSince: notificationNavigation.pendingSince,
      openedAt: pageOpenedAt,
      now: Date.now(),
      waitLimitMs: PENDING_REMOTE_PANE_MS,
    });
    if (plan.selectedPaneId !== before) resetInputHistoryNavigation();
    state.selectedPaneId = plan.selectedPaneId;
    state.preferredPaneId = plan.preferredPaneId;
    notificationNavigation.pendingPaneId = plan.pendingPaneId;
    if (plan.remember) writePanePreference(panePreferenceStorage, plan.remember);
    if (plan.adopted) {
      dropPaneFromAddress();
      closeMobileSidebar();
    }
    if (plan.giveUp) dropPaneFromAddress(plan.giveUp);
    // A pane being waited for, or kept while its server returns, leaves the
    // composer as it is unless a notification's pane has just taken its place.
    if (plan.adopted || !plan.stop) syncComposerDraft();
  }

  const liveStatusUpdates = new Map();
  let liveStatusSequence = 0;

  function applyLiveStatus(event) {
    const records = snapshotRecords();
    for (const record of [...records.panes, ...records.agents]) {
      if (idOf(record, "pane_id", "id") === event.pane_id) record.agent_status = event.agent_status;
    }
  }

  function receiveLiveStatus(event) {
    if (!["idle", "working", "blocked", "done", "unknown"].includes(event.agent_status)) return;
    if (!snapshotRecords().panes.some(pane => idOf(pane, "pane_id", "id") === event.pane_id)) return;
    liveStatusUpdates.set(event.pane_id, { ...event, sequence: ++liveStatusSequence });
    applyLiveStatus(event);
    pruneAcknowledgedCompletions();
    if (state.selectedPaneId) acknowledgePaneCompletion(state.selectedPaneId);
    if (!renameIsOpen()) renderNavigation();
    const selected = selectedRecords();
    renderPaneHeading(selected.pane, selected.tab, selected.workspace);
  }

  async function refreshSnapshot() {
    if (!state.authenticated) return;
    if (state.snapshotBusy || state.mutationBusy || document.hidden) return;
    state.snapshotBusy = true;
    let settle;
    deps.snapshotSettled = new Promise((resolve) => { settle = resolve; });
    const previousPaneId = state.selectedPaneId;
    const previousStatus = selectedAgentStatus();
    try {
      await restoreNotificationTarget();
      const statusAtRequest = liveStatusSequence;
      // when this snapshot was asked for: it shows the panes as they were then, or later
      const requestedAt = Date.now();
      const payload = await api("/api/snapshot");
      const held = snapshotRecords();
      const seen = seenCompletions({ panes: held.panes, agents: held.agents, acknowledged: state.acknowledgedCompletions });
      state.snapshot = payload.snapshot || {};
      // when the snapshot last arrived was asked for (one that failed or was skipped leaves it)
      state.snapshotAt = requestedAt;
      const records = snapshotRecords();
      const paneIds = records.panes.map(pane => idOf(pane, "pane_id", "id"));
      // What each status event received meanwhile does is reconcileLiveStatus's (ui-model.js):
      // a slow HTTP response must not undo a newer event.
      const reconciled = reconcileLiveStatus({
        pending: liveStatusUpdates, requestedAfter: statusAtRequest, panes: records.panes, agents: records.agents, seen,
      });
      for (const paneId of reconciled.drop) liveStatusUpdates.delete(paneId);
      for (const event of reconciled.apply) applyLiveStatus(event);
      for (const [paneId, identity] of reconciled.acknowledge) state.acknowledgedCompletions.set(paneId, identity);
      deps.terminalStream.watchStatuses(paneIds);
      pruneViewSplit(paneIds);
      choosePane();
      pruneAcknowledgedCompletions();
      if (state.selectedPaneId) acknowledgePaneCompletion(state.selectedPaneId);
      if (!renameIsOpen()) renderNavigation();
      const selected = selectedRecords();
      renderPaneHeading(selected.pane, selected.tab, selected.workspace);
      const gridBefore = deps.shownPaneView;
      if (renderPaneViews() !== gridBefore) void refreshTerminal();
      setConnection("online", "Connected");
      const polling = outputPollingDecision({
        baseIntervalMs: state.pollIntervalMs,
        previousStatus,
        currentStatus: selectedAgentStatus(),
      });
      if (previousPaneId !== state.selectedPaneId || polling.refreshNow || notificationNavigation.relayTarget) {
        void refreshTerminal();
      }
    } catch (error) {
      setConnection("error", error.message);
    } finally {
      state.snapshotBusy = false;
      settle();
    }
  }

  // Every pane is drawn by xterm. One that attaches gets herdr's own stream; one
  // that cannot (no node-pty on this server, or herdr refused the attach)
  // mirrors the screen the terminal socket polls instead: redrawn whole on each
  // update and read-only to keystrokes, while the composer and quick keys still
  // send to it.
  function refreshTerminal({ streamPayload = null } = {}) {
    const paneId = state.selectedPaneId;
    if (!state.authenticated || document.hidden) return;
    // A split tab shown as a grid: each cell attaches its own pane, and the
    // single terminal lets its pane go, so a hidden screen never sizes it.
    if (renderPaneViews()) {
      state.lastOutputRequestAt = Date.now();
      deps.attachedTerminal.show(null);
      deps.terminalStream.unwatch();
      // The page may open on a view split (a reload): the composer, the keys and
      // the statuses still go through the page's own socket.
      deps.terminalStream.hold();
      // The selected pane is in its cell: a notification for it is done once
      // that cell is on screen (another pane's zoom hides it until undone).
      state.renderedPaneId = paneId;
      state.renderedGrid = true;
      state.mirrored = null;
      // The strip describes the single terminal, which is not on screen, and
      // the terminal find works on it alone.
      renderTerminalStatus();
      if (deps.terminalFind) syncTerminalFind();
      void completeNotificationRelay();
      return;
    }
    // Back from the grid, the single terminal has yet to show the pane (or, the
    // pane gone, says so below).
    if (state.renderedGrid) {
      state.renderedGrid = false;
      if (paneId) state.renderedPaneId = null;
    }
    // Another pane may have its own reason, or none.
    if (paneId !== state.renderedPaneId) renderTerminalStatus();
    if (!paneId) {
      // The pane on screen went away and nothing took its place.
      if (state.renderedPaneId) {
        deps.attachedTerminal.show(null);
        showTerminalMessage("No open tabs.");
      }
      return;
    }
    // Long in the Chat lens, the terminal was let go: it attaches again on return.
    if (state.terminalParked !== null && state.terminalParked !== paneId) state.terminalParked = null;
    if (state.terminalParked === paneId) return;
    state.lastOutputRequestAt = Date.now();
    if (deps.attachedTerminal.show(paneId)) {
      deps.terminalStream.unwatch();
      state.mirrored = null;
      showTerminal(paneId);
      return;
    }
    deps.terminalStream.select(paneId, HISTORY_PAGE_LINES);
    const payload = streamPayload ?? deps.terminalStream.latest(paneId, HISTORY_PAGE_LINES);
    if (!payload || (!payload.update && payload.output === undefined)) return;
    const previous = state.mirrored?.paneId === paneId ? state.mirrored.output : null;
    const output = outputTextForUpdate(previous, payload.update ? payload : { ...payload, update: "replace" });
    if (output === null) return;
    state.mirrored = { paneId, output };
    deps.attachedTerminal.mirror(paneId, output);
    showTerminal(paneId);
  }

  function showTerminal(paneId) {
    showTerminalView(true);
    state.renderedPaneId = paneId;
    if (deps.terminalFind) syncTerminalFind();
    void completeNotificationRelay();
  }

  function refreshOutputOnSchedule() {
    const polling = outputPollingDecision({
      baseIntervalMs: state.pollIntervalMs,
      currentStatus: selectedAgentStatus(),
      recentSubmission: Date.now() < state.outputBurstUntil,
      connection: navigator.connection || navigator.mozConnection || navigator.webkitConnection,
    });
    if (Date.now() - state.lastOutputRequestAt < polling.intervalMs) return;
    void refreshTerminal();
  }

  async function sendText(text, paneId = state.selectedPaneId) {
    if (!paneId) throw new Error("Select a pane first.");
    return deps.terminalStream.send({ paneId, text, submit: true });
  }

  async function sendKeys(keys, paneId = state.selectedPaneId, { stop = false } = {}) {
    if (!paneId) throw new Error("Select a pane first.");
    await deps.terminalStream.send(stop ? { paneId, keys, stop: true } : { paneId, keys });
  }

  function refreshAfterSubmission() {
    state.outputBurstUntil = Date.now() + OUTPUT_SUBMISSION_BURST_MS;
    void refreshTerminal();
    window.setTimeout(() => void refreshTerminal(), OUTPUT_SUBMISSION_RETRY_MS);
    if (elements.filePanel && !elements.filePanel.hidden && deps.browseState.root && !deps.browseState.busy) {
      window.setTimeout(() => void refreshBrowseFolder({ silent: true }), OUTPUT_SUBMISSION_RETRY_MS);
    }
  }

  function streamPayloadIsCurrent(payload) {
    return payload.paneId === state.selectedPaneId && payload.requestedLines === HISTORY_PAGE_LINES;
  }

  // Stream updates can arrive faster than a large terminal renders. Draw only the
  // newest one per frame so keystrokes do not queue behind stale renders.
  let pendingStreamPayload = null;
  function scheduleStreamRender(payload) {
    const scheduled = pendingStreamPayload !== null;
    pendingStreamPayload = payload;
    if (scheduled) return;
    window.requestAnimationFrame(() => {
      const next = pendingStreamPayload;
      pendingStreamPayload = null;
      if (streamPayloadIsCurrent(next)) void refreshTerminal({ streamPayload: next });
    });
  }

  return {
    renderPaneHeading,
    isLinkableTerminalPath,
    openTerminalPath,
    showTerminalMessage,
    selectedRecords,
    selectedRecordsFor,
    choosePane,
    liveStatusUpdates,
    receiveLiveStatus,
    refreshSnapshot,
    refreshTerminal,
    refreshOutputOnSchedule,
    sendText,
    sendKeys,
    refreshAfterSubmission,
    streamPayloadIsCurrent,
    scheduleStreamRender,
  };
}
