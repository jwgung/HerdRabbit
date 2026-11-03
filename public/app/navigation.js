import { clearedTabLabel, displayRecordLabel, displayTabLabel, navigationModel, openRenames } from "../ui-model.js?v=1.4.23";
import { writePanePreference } from "../pane-preference.js?v=1.4.23";
import { writeAcknowledgedCompletions } from "../completion-preference.js?v=1.4.23";
import { dropScope, followMovedPane } from "../sidebar-drag.js?v=1.4.23";
import { renameTiles } from "../view-split.js?v=1.4.23";
import { renamePaneKeys } from "../pane-rename.js?v=1.4.23";
import { renamePaneLenses } from "../lens-preference.js?v=1.4.23";
import { writeInputHistories } from "../input-history-preference.js?v=1.4.23";
import { array, createElement, createIcon } from "./dom.js?v=1.4.23";
import { idOf } from "./snapshot.js?v=1.4.23";

// The sidebar's tree of machines, projects and sessions, its per-machine and
// per-session menus, renaming a session, and moving a row with what the page
// keeps under a pane's id. Nothing here runs until createNavigation is called;
// app.js calls it where this code used to sit.
// `navigationRedrawHeld` (read by the sidebar drag's onEnd) and `draftPaneId`
// (the composer's) stay in app.js and are read and set through accessors on
// `deps`. `chatLens`, EVEN_ICON and SEPARATE_ICON are made further down app.js
// and are read through getters.
export function createNavigation(deps) {
  const {
    state, elements, sidebarDrag, panePreferenceStorage, composerDrafts, draftBlocked, draftHeld, viewSplit,
    api, refreshSnapshot, setFeedback, snapshotRecords, selectedRecords, renderPaneHeading,
    agentForPane, visibleStatusForPane, adoptMutationSnapshot, saveComposerDraft, setViewSplit,
    showServerDetails, showAiAccounts, openConnectPc, sidebarActionMenu, renameForm, serverRenameForm, attachGroupCollapse,
    workspaceHeading, paneButton, closeSession, isLocalRecord, splitSessionName, splitPaneRow,
    splitDisclosureButton, splitSessionButton, evenOutLayout, separateSplitSession,
  } = deps;

  function serverActionMenu(server) {
    const actions = [
      {
        label: "Details",
        paths: ["M12 8h.01", "M11 12h1v4h1", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"],
        onSelect: () => showServerDetails(server),
      },
      // This PC's accounts, or a connected PC's, switched on that PC.
      {
        label: "AI accounts",
        paths: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 20a8 8 0 0 1 16 0"],
        onSelect: () => showAiAccounts(server),
      },
    ];
    // This machine is not a connection: there is nothing to rename or drop.
    // It is where other PCs are connected from, when this page may connect them.
    if (server.id === "local") {
      if (state.connectPcAvailable) {
        actions.push({
          label: "Connect PC…",
          paths: ["M4 5h16v11H4z", "M9 20h6", "M12 16v4", "M12 8v5M9.5 10.5h5"],
          onSelect: () => openConnectPc(),
        });
      }
      return sidebarActionMenu({
        id: `server-${server.id}`,
        label: `More actions for ${server.name}`,
        className: "server-action-menu",
        actions,
      });
    }
    // A PC connected with Connect PC: renamed and dropped here, and found again
    // when it moved to another port.
    return linkActionMenu(server, actions);
  }

  function linkActionMenu(server, actions) {
    // A PC that moved to another port leaves its entry pointing at the old one,
    // offline for good. Its tailnet address says it is the same PC.
    if (!server.available) {
      actions.push({
        label: "Find new address",
        paths: ["M20 12a8 8 0 1 1-2.3-5.6", "M20 4v5h-5"],
        onSelect: () => void (async () => {
          try {
            setFeedback(`Looking for ${server.name}…`);
            const found = await api("/api/servers/discover", { method: "POST", body: {} });
            const host = new URL(server.address).hostname;
            const moved = array(found.candidates).find((candidate) =>
              candidate.state === "ready" && candidate.address !== server.address &&
              new URL(candidate.address).hostname === host);
            if (!moved) {
              setFeedback(`${server.name} is not answering anywhere on ${host}.`, true);
              return;
            }
            await api(`/api/servers/${server.id}`, {
              method: "PUT", body: { name: server.name, address: moved.address },
            });
            await refreshSnapshot();
            setFeedback(`${server.name} now points at ${moved.address}.`);
          } catch (error) {
            setFeedback(error.message, true);
          }
        })(),
      });
    }
    actions.push(
      {
        label: "Rename",
        paths: ["M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z", "M14.5 7.5l3 3"],
        onSelect: () => { state.editingServerId = server.id; renderNavigation(); },
      },
      {
        label: "Disconnect",
        paths: ["M6 6l12 12M18 6 6 18"],
        danger: true,
        onSelect: () => {
          if (!window.confirm(`Disconnect “${server.name}”? Its sessions keep running there.`)) return;
          void api(`/api/servers/${server.id}`, { method: "DELETE" })
            .then(() => refreshSnapshot())
            .catch((error) => setFeedback(error.message, true));
        },
      },
    );
    return sidebarActionMenu({
      id: `server-${server.id}`,
      label: `More actions for ${server.name}`,
      className: "server-action-menu",
      actions,
    });
  }

  // A session shows the agent that happens to be running in it, which is not a
  // name: it changes under you and two of them read alike. A tab starts out
  // numbered, and the number is hidden, so this is the only way to give one.
  function tabRenameForm(tab, tabId, tabLabel) {
    // Emptying the field is how a name is taken back off: the session goes back
    // to showing the agent, which is what it showed before it was named.
    const cleared = clearedTabLabel(tab);
    return renameForm({
      value: tabLabel,
      label: "Session name",
      placeholder: cleared === null ? "Session name" : "Session name — empty to clear",
      maxLength: 120,
      invalidMessage: "Enter a session name.",
      allowEmpty: cleared !== null,
      onCancel: () => { state.editingTabId = null; renderNavigation(); },
      onSubmit: async (typed) => {
        const label = typed || cleared;
        await api(`/api/tabs/${encodeURIComponent(tabId)}/rename`, {
          method: "POST",
          body: { label },
        });
        tab.label = label;
        state.editingTabId = null;
        renderNavigation();
        const selected = selectedRecords();
        renderPaneHeading(selected.pane, selected.tab, selected.workspace);
      },
    });
  }

  // Every redraw of the sidebar asks this, because every redraw would otherwise
  // throw away a name being typed. It also clears a rename whose record is gone,
  // so a closed session cannot leave the sidebar frozen on its form.
  function renameIsOpen() {
    const open = openRenames(
      {
        workspaceId: state.editingWorkspaceId,
        tabId: state.editingTabId,
        serverId: state.editingServerId,
      },
      snapshotRecords(),
    );
    state.editingWorkspaceId = open.workspaceId;
    state.editingTabId = open.tabId;
    state.editingServerId = open.serverId;
    return open.any;
  }

  function renderNavigation() {
    // A row being held or dragged stays where it is; the redraw waits for the drop.
    if (sidebarDrag.isActive()) {
      deps.navigationRedrawHeld = true;
      return;
    }
    deps.navigationRedrawHeld = false;
    const { servers, herdrSessions, workspaces, tabs, panes } = snapshotRecords();
    // What the tree is made of is decided by navigationModel (ui-model.js); this
    // draws it, with the page's own editing and dragging.
    const tree = navigationModel({
      servers, herdrSessions, workspaces, tabs, panes,
      statusOfPane: (paneId, pane) => visibleStatusForPane(paneId, agentForPane(paneId), pane),
      pageConnection: state.connection,
    });
    elements.workspaceList.replaceChildren();
    // Shown even for this machine alone: its row is where the machine is managed,
    // AI accounts included.
    const serverBodies = new Map();
    for (const node of tree.servers) {
      const server = node.record;
      const group = createElement("section", { className: "server-group" });
      const editingServer = state.editingServerId === server.id;
      const connection = node.connection;
      const heading = createElement("div", {
        className: `server-heading${connection.online ? " is-online" : ""}${connection.error ? " is-error" : ""}${editingServer ? " is-editing" : ""}`,
      });
      heading.dataset.serverId = server.id;
      heading.dataset.serverName = server.name;
      heading.title = `${server.name}: ${connection.text}`;
      heading.setAttribute("aria-label", heading.title);
      heading.append(createIcon(["M4 5h16v11H4z", "M9 20h6", "M12 16v4"], "server-icon"));
      if (editingServer) heading.append(serverRenameForm(server));
      else {
        heading.append(createElement("strong", { text: server.name }));
        // This PC is the host the page is served from; another machine keeps
        // its words for the states a dot cannot tell apart.
        if (node.role === "host") heading.append(createElement("small", { className: "server-role", text: "Host" }));
        else if (node.role) {
          heading.append(createElement("small", { text: node.role === "connecting" ? "Connecting" : "Offline" }));
        }
        const dot = createElement("span", { className: "server-dot" });
        dot.setAttribute("aria-hidden", "true");
        heading.append(dot);
        // A server is managed where it is seen. The dialog is for adding one.
        heading.append(serverActionMenu(server));
      }
      group.append(heading);
      const body = createElement("div", { className: "server-body" });
      if (node.emptyText !== null) body.append(createElement("p", { className: "server-empty", text: node.emptyText }));
      group.append(body);
      attachGroupCollapse(group, heading, body, `server:${server.id}`, server.name);
      serverBodies.set(node.id, body);
      elements.workspaceList.append(group);
    }

    const appendWorkspace = (parent, node) => {
      const workspace = node.record;
      const workspaceId = node.id;
      const group = createElement("section", { className: "workspace-group" });
      group.dataset.workspaceId = workspaceId;
      group.dataset.dropScope = dropScope(workspace);
      const workspaceLabel = displayRecordLabel(workspace, "Project");
      const { hasCompletion, hasRequest } = node;
      const children = createElement("div", { className: "workspace-children" });
      children.id = `workspace-${workspaceId}-children`;
      const childrenInner = createElement("div", {
        className: "workspace-children-inner",
      });
      const collapsed = state.collapsedWorkspaceIds.has(workspaceId);
      group.classList.toggle("is-collapsed", collapsed);
      group.dataset.hasCompletion = String(hasCompletion);
      group.dataset.hasRequest = String(hasRequest);
      children.inert = collapsed;
      children.setAttribute("aria-hidden", String(collapsed));
      group.append(workspaceHeading(group, workspace, workspaceLabel, children));

      for (const { record: tab, id: tabId, panes: tabPanes } of node.tabs) {
        const tabGroup = createElement("div", { className: "tab-group" });
        tabGroup.dataset.tabId = tabId;
        tabGroup.dataset.workspaceId = workspaceId;
        tabGroup.dataset.dropScope = group.dataset.dropScope;
        const tabLabel = displayTabLabel(tab);
        const editingTab = state.editingTabId === tabId;
        const split = tabPanes.length > 1;
        const sessionRow = createElement("div", { className: "session-row" });
        let sessionLabel;
        if (split) {
          // A split session can be put in order within its project, not carried out.
          tabGroup.dataset.split = "true";
          sessionLabel = splitSessionName(tabId, tabLabel, tabPanes);
          const paneList = createElement("div", { className: "split-panes" });
          paneList.id = `split-${tabId.replace(/[^A-Za-z0-9_-]/gu, "_")}-panes`;
          paneList.hidden = !state.expandedSplitTabIds.has(tabId);
          tabGroup.classList.toggle("is-expanded", !paneList.hidden);
          // Each pane says its own name: the session's name is on the row. On
          // this machine each has its own ⋯ with the grid cell's actions.
          const local = isLocalRecord(tabPanes[0]);
          for (const pane of tabPanes) paneList.append(splitPaneRow(pane, tab, workspace, local));
          sessionRow.classList.add("split-session-row");
          if (editingTab) {
            sessionRow.classList.add("is-editing");
            sessionRow.append(tabRenameForm(tab, tabId, tabLabel));
          } else {
            // The arrow takes the place of the row's program mark: laid over the
            // mark's column, first in reading order as it is first on screen.
            sessionRow.append(
              splitDisclosureButton(tabGroup, tabId, sessionLabel, paneList),
              splitSessionButton(tabId, sessionLabel, tabPanes, workspace),
            );
          }
          tabGroup.append(sessionRow, paneList);
        } else {
          // With one pane the pane is the session, so its name belongs in the button.
          const namesSession = Boolean(tabLabel);
          // An unnamed session has no heading to rename in, so renaming makes one.
          if (editingTab) {
            const tabHeading = createElement("div", { className: "tab-heading is-editing" });
            tabHeading.append(tabRenameForm(tab, tabId, tabLabel));
            tabGroup.append(tabHeading);
          }
          const sessionPanes = createElement("div", { className: "session-panes" });
          for (const pane of tabPanes) {
            sessionPanes.append(paneButton(pane, tab, workspace, { namesSession }));
          }
          sessionRow.append(sessionPanes);
          tabGroup.append(sessionRow);
          sessionLabel =
            tabLabel ||
            displayRecordLabel(agentForPane(idOf(tabPanes[0], "pane_id", "id")), "Session");
        }
        const sessionMenu = sidebarActionMenu({
          id: `tab-${tabId}`,
          label: `More actions for ${sessionLabel}`,
          className: "session-action-menu",
          actions: [
            {
              label: "Rename",
              paths: ["M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z", "M14.5 7.5l3 3"],
              onSelect: () => {
                state.editingTabId = tabId;
                setFeedback("");
                renderNavigation();
              },
            },
            // Gives the panes equal shares of the session, and undoes the
            // split: each pane but the first becomes a session of its own.
            // This machine's only, as the grid's actions are.
            ...(split && isLocalRecord(tabPanes[0]) ? [{
              key: "even-layout",
              label: "Even out layout",
              paths: deps.EVEN_ICON,
              onSelect: () => void evenOutLayout(idOf(tabPanes[0], "pane_id", "id")),
            }, {
              key: "separate-all",
              label: "Separate all panes",
              paths: deps.SEPARATE_ICON,
              onSelect: () => void separateSplitSession(tabId, sessionLabel),
            }] : []),
            {
              label: "Close session",
              paths: ["M6 6l12 12M18 6 6 18"],
              danger: true,
              onSelect: (button) => void closeSession(
                tab,
                sessionLabel,
                button,
              ),
            },
          ],
        });
        if (!sessionRow.classList.contains("is-editing")) sessionRow.append(sessionMenu);
        childrenInner.append(tabGroup);
      }
      children.append(childrenInner);
      group.append(children);
      parent.append(group);
    };

    const appendSession = (parent, node) => {
      const session = node.record;
      const sessionGroup = createElement("section", {
        className: "herdr-session-group",
      });
      const sessionHeading = createElement("div", {
        className: "herdr-session-heading",
      });
      const statusDot = createElement("span", {
        className: `herdr-session-dot${node.tone === "online" ? " is-online" : node.tone === "error" ? " is-error" : ""}`,
      });
      statusDot.setAttribute("aria-hidden", "true");
      sessionHeading.setAttribute("aria-label", `Herdr ${session.name}, ${node.status}`);
      sessionHeading.title = node.status;
      sessionHeading.append(
        statusDot,
        createElement("strong", { text: session.name }),
        createElement("small", { text: node.status }),
      );
      sessionGroup.append(sessionHeading);
      const sessionBody = createElement("div", { className: "herdr-session-body" });
      if (node.workspaces.length === 0) {
        sessionBody.append(createElement("p", {
          className: "herdr-session-empty",
          text: node.emptyText,
        }));
      } else {
        for (const workspaceNode of node.workspaces) appendWorkspace(sessionBody, workspaceNode);
      }
      sessionGroup.append(sessionBody);
      attachGroupCollapse(
        sessionGroup,
        sessionHeading,
        sessionBody,
        `session:${node.id}`,
        displayRecordLabel(session, "Herdr session"),
      );
      parent.append(sessionGroup);
    };

    // Projects (or their sessions) belong to a machine, so they go inside that
    // machine's body. Appending them to the list itself would leave them as
    // siblings of the machine heading, which then collapses over nothing.
    const draw = (parent, node) => (node.kind === "session" ? appendSession : appendWorkspace)(parent, node);
    for (const node of tree.servers) {
      for (const child of node.children) draw(serverBodies.get(node.id), child);
    }
    if (tree.empty) {
      elements.workspaceList.append(createElement("p", {
        className: "empty-state",
        text: "No open projects.",
      }));
      return;
    }
    for (const child of tree.children) draw(elements.workspaceList, child);
  }

  // Every place the page keeps state under a pane's id, each with how it follows
  // the pane to a new id: the unsent draft (and its secret verdict), the
  // blocked/held marks, the message history, the chosen lens and the acknowledged
  // completion. A new pane-keyed store joins by being listed here. The functions
  // are called late, so a store defined further down the file is fine.
  const paneScopedStores = [
    { rename: (moves) => composerDrafts.rename(moves) },
    {
      rename(moves) {
        for (const set of [draftBlocked, draftHeld]) {
          const kept = [...set];
          set.clear();
          for (const id of kept) set.add(followMovedPane(id, moves));
        }
        // The pane on screen keeps its composer: the text stays, only the key changes.
        if (deps.draftPaneId) deps.draftPaneId = followMovedPane(deps.draftPaneId, moves);
      },
    },
    {
      rename(moves) {
        state.inputHistoryByPane = renamePaneKeys(state.inputHistoryByPane, moves);
        writeInputHistories(panePreferenceStorage, state.inputHistoryByPane);
      },
    },
    {
      rename(moves) {
        state.acknowledgedCompletions = renamePaneKeys(state.acknowledgedCompletions, moves);
        writeAcknowledgedCompletions(panePreferenceStorage, state.acknowledgedCompletions);
      },
    },
    { rename: (moves) => renamePaneLenses(panePreferenceStorage, moves) },
    { rename: (moves) => deps.chatLens.renamePanes(moves) },
    {
      rename(moves) {
        if (!viewSplit.tree) return;
        viewSplit.focus = followMovedPane(viewSplit.focus, moves);
        setViewSplit(renameTiles(viewSplit.tree, moves));
      },
    },
  ];

  function followMovedPaneState(moves) {
    if (!Array.isArray(moves) || moves.length === 0) return;
    saveComposerDraft();
    for (const store of paneScopedStores) store.rename(moves);
  }

  async function moveSidebarItem(request, pathFor, optimistic) {
    if (!request || state.mutationBusy) return;
    const before = state.snapshot;
    state.mutationBusy = true;
    setFeedback("");
    state.snapshot = optimistic();
    renderNavigation();
    let failed = false;
    let unread = false;
    let reorderedFeedback = "";
    try {
      const payload = await api(pathFor(request), { method: "POST", body: request.body });
      if (payload.moved?.reordered === false) reorderedFeedback = "Moved; it is at the end of the project.";
      // A session moved to another project brings its panes under new ids; the
      // one on screen is followed there.
      const followed = followMovedPane(state.selectedPaneId, payload.moved?.panes);
      followMovedPaneState(payload.moved?.panes);
      const paneMoved = followed !== state.selectedPaneId;
      if (paneMoved) writePanePreference(panePreferenceStorage, followed);
      if (payload.snapshot) adoptMutationSnapshot(payload.snapshot, paneMoved ? followed : null);
      else {
        // read once the mutation is over: refreshSnapshot waits out a busy one
        if (paneMoved) state.selectedPaneId = followed;
        unread = true;
      }
    } catch (error) {
      failed = true;
      state.snapshot = before;
      renderNavigation();
      setFeedback(error.message, true);
    } finally {
      state.mutationBusy = false;
    }
    if (reorderedFeedback) setFeedback(reorderedFeedback);
    // A failed move may still have changed something; a move answered without a
    // snapshot is read now.
    if (failed || unread) void refreshSnapshot();
  }

  return {
    serverActionMenu,
    linkActionMenu,
    tabRenameForm,
    renameIsOpen,
    renderNavigation,
    paneScopedStores,
    followMovedPaneState,
    moveSidebarItem,
  };
}
