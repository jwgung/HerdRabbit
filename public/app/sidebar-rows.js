import { createElement, createIcon, placeFloatingMenu, workspaceActionButton } from "./dom.js?v=1.4.45";
import { agentMark } from "./agent-icons.js?v=1.4.45";
import { idOf } from "./snapshot.js?v=1.4.45";
import {
  agentStatusIcon,
  agentStatusLabel,
  displayRecordLabel,
  displayTabLabel,
  paneAgentKind,
  paneDisplayTitle,
  paneRowLine,
  paneSubtitle,
} from "../ui-model.js?v=1.4.45";
import { writeCollapsedGroupIds, writeCollapsedWorkspaceIds } from "../workspace-preference.js?v=1.4.45";
import { tiles as viewTiles } from "../view-split.js?v=1.4.45";

// The sidebar's rows and what they open: the ⋯ action menus (also used by
// AI accounts and Files), a project's heading with its collapse
// and rename, a session's row with its agent mark, the fold on server and
// session headings, the rename form shared by projects, sessions and machines,
// and creating (through the New session dialog) or closing sessions and
// projects, and a workspace's Git worktrees (public/app/worktree-dialogs.js). Nothing here runs until createSidebarRows is called. The
// functions it calls live in app.js (or in modules made around it) and are
// handed in as wrappers, so they may be defined after this is made;
// `viewGrid` is made further down app.js and is read through a getter on
// `deps`.
export function createSidebarRows(deps) {
  const {
    state, panePreferenceStorage, desktopMedia, viewSplit, api,
    snapshotRecords, agentForPane, visibleStatusForPane,
    choosePane, renderNavigation, selectedRecords, renderPaneHeading, showTerminalMessage,
    refreshTerminal, refreshSnapshot, setFeedback, closeMobileSidebar, selectPane, focusComposer,
    openNewSession, openNewWorktree, openWorktree, removeWorktree,
  } = deps;

  function sidebarActionMenu({
    id, label, actions, className = "", escapesOverflow = false,
    icon = ["M6 12h.01M12 12h.01M18 12h.01"], iconClass = "more-icon", summaryClass = "",
  }) {
    const details = createElement("details", {
      className: `sidebar-action-menu ${className}`.trim(),
    });
    details.dataset.menuId = id;
    details.open = state.openActionMenuId === id;
    const summary = createElement("summary", {
      className: `workspace-action ${summaryClass}`.trim(),
    });
    summary.setAttribute("aria-label", label);
    summary.title = label;
    summary.append(createIcon(icon, iconClass));
    const popover = createElement("div", {
      className: "sidebar-action-popover",
    });
    popover.setAttribute("role", "menu");
    // A list that scrolls clips whatever is positioned inside it, and the uploads
    // list is one. The top layer is outside every such box, so the menu opens
    // over the dialog instead of being cut off at the row.
    if (escapesOverflow) {
      popover.setAttribute("popover", "auto");
      popover.classList.add("is-floating");
      popover.addEventListener("toggle", (event) => {
        // Clicking away closes the popover without telling the details element.
        if (event.newState === "closed" && details.open) details.open = false;
      });
    }

    for (const action of actions) {
      if (action.separator) {
        const rule = createElement("div", { className: "sidebar-action-separator" });
        rule.setAttribute("role", "separator");
        if (action.key) rule.dataset.separator = action.key;
        popover.append(rule);
        continue;
      }
      const button = createElement("button", {
        className: `sidebar-action-item ${action.danger ? "is-danger" : ""}`.trim(),
      });
      button.type = "button";
      button.setAttribute("role", "menuitem");
      if (action.key) button.dataset.action = action.key;
      button.append(
        createIcon(action.paths),
        createElement("span", { text: action.label }),
      );
      button.addEventListener("click", () => {
        details.open = false;
        state.openActionMenuId = null;
        action.onSelect(button);
      });
      popover.append(button);
    }

    details.addEventListener("toggle", () => {
      if (details.open) {
        state.openActionMenuId = id;
        // Document-wide: the sidebar is no longer the only place with menus.
        for (const other of document.querySelectorAll(".sidebar-action-menu[open]")) {
          if (other !== details) other.open = false;
        }
        if (escapesOverflow) placeFloatingMenu(popover, summary);
      } else {
        if (escapesOverflow && popover.matches(":popover-open")) popover.hidePopover();
        if (state.openActionMenuId === id) state.openActionMenuId = null;
      }
    });
    details.append(summary, popover);
    return details;
  }

  function paneBelongsToWorkspace(pane, workspaceId) {
    if (idOf(pane, "workspace_id", "workspaceId") === workspaceId) return true;
    const tabId = idOf(pane, "tab_id", "tabId");
    return snapshotRecords().tabs.some(
      (tab) =>
        idOf(tab, "tab_id", "id") === tabId &&
        idOf(tab, "workspace_id", "workspaceId") === workspaceId,
    );
  }

  function adoptMutationSnapshot(snapshot, preferredPaneId = null) {
    const previousPaneId = state.selectedPaneId;
    state.snapshot = snapshot || {};
    if (preferredPaneId) {
      state.selectedPaneId = preferredPaneId;
      state.preferredPaneId = preferredPaneId;
    }
    choosePane();
    renderNavigation();
    const selected = selectedRecords();
    renderPaneHeading(selected.pane, selected.tab, selected.workspace);
    if (previousPaneId !== state.selectedPaneId) {
      showTerminalMessage(
        state.selectedPaneId ? "Loading output…" : "No open tabs.",
      );
    }
    void refreshTerminal();
  }

  // A new session in a project, from the New session dialog: a shell, or an
  // installed agent the server starts in it, named when a name is given. The
  // server says which pane it made; an older answer is matched by what is new.
  // Errors go back to the dialog, which shows them.
  async function createSession(workspaceId, body = {}) {
    const previousPaneIds = new Set(
      snapshotRecords().panes.map((pane) => idOf(pane, "pane_id", "id")),
    );
    setFeedback("");
    const payload = await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/tabs`,
      { method: "POST", body },
    );
    state.snapshot = payload.snapshot || {};
    const newPane = snapshotRecords().panes.find(
      (pane) =>
        !previousPaneIds.has(idOf(pane, "pane_id", "id")) &&
        paneBelongsToWorkspace(pane, workspaceId),
    );
    state.collapsedWorkspaceIds.delete(workspaceId);
    writeCollapsedWorkspaceIds(panePreferenceStorage, state.collapsedWorkspaceIds);
    adoptMutationSnapshot(
      state.snapshot,
      payload.paneId || (newPane ? idOf(newPane, "pane_id", "id") : null),
    );
    closeMobileSidebar();
  }

  async function closeSession(tab, label, button) {
    const tabId = idOf(tab, "tab_id", "id");
    const workspaceId = idOf(tab, "workspace_id", "workspaceId");
    if (
      !tabId ||
      state.mutationBusy ||
      !window.confirm(`Close tab “${label}”? This will also stop any running processes.`)
    ) return;
    state.mutationBusy = true;
    button.disabled = true;
    setFeedback("");
    try {
      const payload = await api(`/api/tabs/${encodeURIComponent(tabId)}/close`, {
        method: "POST",
        body: { confirmed: true },
      });
      state.snapshot = payload.snapshot || {};
      const fallbackPane = snapshotRecords().panes.find((pane) =>
        paneBelongsToWorkspace(pane, workspaceId),
      );
      adoptMutationSnapshot(
        state.snapshot,
        fallbackPane ? idOf(fallbackPane, "pane_id", "id") : null,
      );
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      state.mutationBusy = false;
      button.disabled = false;
    }
  }

  async function closeProject(workspaceId, workspaceLabel, button) {
    if (
      state.mutationBusy ||
      !window.confirm(`Close workspace “${workspaceLabel}”? This will close all of its tabs and stop any running processes.`)
    ) return;
    state.mutationBusy = true;
    button.disabled = true;
    setFeedback("");
    try {
      const payload = await api(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/close`,
        { method: "POST", body: { confirmed: true } },
      );
      state.collapsedWorkspaceIds.delete(workspaceId);
      writeCollapsedWorkspaceIds(panePreferenceStorage, state.collapsedWorkspaceIds);
      adoptMutationSnapshot(payload.snapshot);
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      state.mutationBusy = false;
      button.disabled = false;
    }
  }

  function stopWorkspaceRename() {
    state.editingWorkspaceId = null;
    setFeedback("");
    renderNavigation();
  }

  // Three things in the sidebar can be renamed, and a rename is the same
  // interaction each time: type, Enter or the check to keep it, Esc or the cross
  // to drop it, controls locked while it is in flight. Written out three times
  // the copies drifted -- the newest one lost Esc and kept a stale validity
  // message -- so they share one form and can only drift together.
  function renameForm({ value, label, placeholder = "", maxLength, invalidMessage, allowEmpty = false, onCancel, onSubmit }) {
    const form = createElement("form", { className: "workspace-rename-form" });
    const input = createElement("input", { className: "workspace-rename-input" });
    input.type = "text";
    input.value = value;
    input.maxLength = maxLength;
    input.required = !allowEmpty;
    if (placeholder) input.placeholder = placeholder;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => input.setCustomValidity(""));
    const saveButton = workspaceActionButton({
      className: "workspace-rename-save",
      label: `Save ${label}`,
      paths: ["M5 12l4 4L19 6"],
      type: "submit",
    });
    const cancelButton = workspaceActionButton({
      className: "workspace-rename-cancel",
      label: "Cancel rename",
      paths: ["M6 6l12 12M18 6 6 18"],
    });
    const controls = [input, saveButton, cancelButton];
    cancelButton.addEventListener("click", onCancel);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const next = input.value.trim();
      if (!next && !allowEmpty) {
        input.setCustomValidity(invalidMessage);
        input.reportValidity();
        return;
      }
      input.setCustomValidity("");
      for (const control of controls) control.disabled = true;
      setFeedback("");
      try {
        await onSubmit(next);
      } catch (error) {
        for (const control of controls) control.disabled = false;
        setFeedback(error.message, true);
        input.focus();
      }
    });
    form.append(input, saveButton, cancelButton);
    window.requestAnimationFrame(() => { input.focus(); input.select(); });
    return form;
  }

  // A branch forking off a line: Git's own picture of a branch.
  const BRANCH_ICON = ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M18 9a9 9 0 0 1-9 9"];

  function workspaceHeading(group, workspace, workspaceLabel, children) {
    const workspaceId = idOf(workspace, "workspace_id", "id");
    const collapsed = state.collapsedWorkspaceIds.has(workspaceId);
    const editing = state.editingWorkspaceId === workspaceId;
    const heading = createElement("div", {
      className: `workspace-heading${editing ? " is-editing" : ""}`,
    });
    const collapseButton = workspaceActionButton({
      className: "workspace-collapse",
      label: collapsed ? `Expand ${workspaceLabel}` : `Collapse ${workspaceLabel}`,
      paths: ["M9 18l6-6-6-6"],
    });
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
    collapseButton.setAttribute("aria-controls", children.id);
    collapseButton.addEventListener("click", () => {
      if (state.collapsedWorkspaceIds.has(workspaceId)) {
        state.collapsedWorkspaceIds.delete(workspaceId);
      } else {
        state.collapsedWorkspaceIds.add(workspaceId);
      }
      const isNowCollapsed = state.collapsedWorkspaceIds.has(workspaceId);
      group.classList.toggle("is-collapsed", isNowCollapsed);
      children.inert = isNowCollapsed;
      children.setAttribute("aria-hidden", String(isNowCollapsed));
      collapseButton.setAttribute("aria-expanded", String(!isNowCollapsed));
      const nextLabel = isNowCollapsed
        ? `Expand ${workspaceLabel}`
        : `Collapse ${workspaceLabel}`;
      collapseButton.setAttribute("aria-label", nextLabel);
      collapseButton.title = nextLabel;
      writeCollapsedWorkspaceIds(
        panePreferenceStorage,
        state.collapsedWorkspaceIds,
      );
    });
    heading.append(collapseButton);

    if (editing) {
      heading.append(renameForm({
        value: workspaceLabel,
        label: `${workspaceLabel} workspace name`,
        maxLength: 120,
        invalidMessage: "Enter a workspace name.",
        onCancel: stopWorkspaceRename,
        onSubmit: async (label) => {
          await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/rename`, {
            method: "POST",
            body: { label },
          });
          const currentWorkspace = snapshotRecords().workspaces.find(
            (item) => idOf(item, "workspace_id", "id") === workspaceId,
          );
          if (currentWorkspace) currentWorkspace.label = label;
          state.editingWorkspaceId = null;
          renderNavigation();
          const selected = selectedRecords();
          renderPaneHeading(selected.pane, selected.tab, selected.workspace);
        },
      }));
    } else {
      heading.append(createElement("h3", { text: workspaceLabel }));
      // Herdr's Git checkout of a worktree workspace (and of its repository's
      // own workspace once grouped with one): its branch, beside the name.
      const worktree = workspace.worktree && typeof workspace.worktree === "object" ? workspace.worktree : null;
      const branch = typeof worktree?.branch === "string" && worktree.branch ? worktree.branch : null;
      if (branch) {
        const tag = createElement("span", { className: "workspace-branch" });
        tag.title = `Branch ${branch}`;
        tag.setAttribute("aria-label", `Branch ${branch}`);
        tag.append(createIcon(BRANCH_ICON, "workspace-branch-icon"), createElement("span", { text: branch }));
        heading.append(tag);
      }
      const target = { workspaceId, workspaceLabel, branch, serverId: workspace.server_id || "local" };
      // New and Open start from the repository's own workspace (Herdr
      // refuses them from a worktree); a worktree workspace removes itself.
      const worktreeActions = worktree?.is_linked_worktree === true
        ? [{
          label: "Remove worktree…",
          key: "remove-worktree",
          paths: ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
          danger: true,
          onSelect: (button) => void removeWorktree(target, button),
        }]
        : [
          { label: "New worktree…", key: "new-worktree", paths: BRANCH_ICON, onSelect: () => openNewWorktree(target) },
          { label: "Open worktree…", key: "open-worktree", paths: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"], onSelect: () => openWorktree(target) },
        ];
      heading.append(sidebarActionMenu({
        id: `workspace-${workspaceId}`,
        label: `More actions for ${workspaceLabel}`,
        actions: [
          {
            label: "Rename",
            paths: [
              "M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z",
              "M14.5 7.5l3 3",
            ],
            onSelect: () => {
              state.editingWorkspaceId = workspaceId;
              setFeedback("");
              renderNavigation();
            },
          },
          {
            label: "New tab…",
            paths: ["M12 5v14M5 12h14"],
            onSelect: () => openNewSession({
              workspaceId,
              workspaceLabel,
              serverId: workspace.server_id || "local",
            }),
          },
          ...worktreeActions,
          {
            label: "Close workspace",
            paths: ["M6 6l12 12M18 6 6 18"],
            danger: true,
            onSelect: (button) => void closeProject(
              workspaceId,
              workspaceLabel,
              button,
            ),
          },
        ],
      }));
    }
    return heading;
  }

  function paneButton(pane, tab, workspace, { namesSession = false } = {}) {
    const paneId = idOf(pane, "pane_id", "id");
    const agent = agentForPane(paneId);
    const currentAgentStatus = visibleStatusForPane(paneId, agent, pane);
    const workspaceLabel = displayRecordLabel(workspace, "Workspace");
    const tabLabel = displayTabLabel(tab);
    const agentLabel = displayRecordLabel(agent, displayRecordLabel(pane, "Terminal"));
    // Once a session has a name, that name is what it is; the agent running in it
    // is a detail that changes under you, so it steps back next to the status.
    const sessionName = namesSession ? tabLabel : "";
    const kind = paneAgentKind(pane, agent);
    const statusText = agentStatusLabel(currentAgentStatus);
    const button = createElement("button", { className: "pane-button" });
    button.type = "button";
    button.dataset.paneId = paneId;
    button.dataset.status = currentAgentStatus;
    button.setAttribute("aria-pressed", String(paneId === state.selectedPaneId));

    button.setAttribute(
      "aria-label",
      `${agentLabel}, ${statusText}, ${[workspaceLabel, tabLabel].filter(Boolean).join(" / ")}`,
    );
    button.title = `${[sessionName, agentLabel].filter(Boolean).join(" · ")} · ${statusText}`;

    button.append(agentMark(kind));

    const title = paneDisplayTitle(sessionName, pane, tabLabel || "Terminal", agent);
    const copy = createElement("span", { className: "pane-copy" });
    copy.append(createElement("strong", { className: "pane-title", text: title }));
    const line = paneRowLine(currentAgentStatus, paneSubtitle(title, pane));
    if (line) copy.append(createElement("small", line));
    button.append(copy);

    // Always present, so the row's text and menu stay put whatever the status.
    const status = createElement("span", {
      className: `pane-status ui-status state-${currentAgentStatus}`,
      text: agentStatusIcon(currentAgentStatus),
    });
    status.setAttribute("aria-hidden", "true");
    button.append(status);

    // A row opens its pane alone, even in a split tab: the split session's own row opens the grid.
    // A pane that is a tile of this window's view split is focused there instead.
    button.addEventListener("click", () => {
      if (desktopMedia.matches && viewTiles(viewSplit.tree).includes(paneId)) {
        selectPane(paneId, { view: "tiles" });
        deps.viewGrid.focus(paneId, { terminal: false });
      } else selectPane(paneId, { view: "solo" });
      closeMobileSidebar();
      focusComposer();
    });

    return button;
  }

  // Server and session headings fold the same way project headings do, so a
  // sidebar with several machines can be narrowed down to the one in use.
  function attachGroupCollapse(group, heading, body, groupId, label) {
    const collapsed = state.collapsedGroupIds.has(groupId);
    const button = workspaceActionButton({
      className: "group-collapse",
      label: `${collapsed ? "Expand" : "Collapse"} ${label}`,
      paths: ["M9 18l6-6-6-6"],
    });
    button.setAttribute("aria-expanded", String(!collapsed));
    group.classList.toggle("is-collapsed", collapsed);
    body.inert = collapsed;
    body.setAttribute("aria-hidden", String(collapsed));

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.collapsedGroupIds.has(groupId)) state.collapsedGroupIds.delete(groupId);
      else state.collapsedGroupIds.add(groupId);
      const now = state.collapsedGroupIds.has(groupId);
      group.classList.toggle("is-collapsed", now);
      body.inert = now;
      body.setAttribute("aria-hidden", String(now));
      button.setAttribute("aria-expanded", String(!now));
      const next = `${now ? "Expand" : "Collapse"} ${label}`;
      button.setAttribute("aria-label", next);
      button.title = next;
      writeCollapsedGroupIds(panePreferenceStorage, state.collapsedGroupIds);
    });
    heading.prepend(button);
  }

  // Only a PC connected with Connect PC is renamed: this PC is not a connection.
  function serverRenameForm(server) {
    return renameForm({
      value: server.name,
      label: `${server.name} machine name`,
      maxLength: 80,
      invalidMessage: "Enter a name.",
      onCancel: () => { state.editingServerId = null; renderNavigation(); },
      onSubmit: async (name) => {
        // The address is not edited here, so it is carried over unchanged.
        await api(`/api/servers/${server.id}`, { method: "PUT", body: { name, address: server.address ?? "" } });
        state.editingServerId = null;
        await refreshSnapshot();
      },
    });
  }

  return {
    sidebarActionMenu, adoptMutationSnapshot, createSession, closeSession, renameForm, workspaceHeading,
    agentMark, paneButton, attachGroupCollapse, serverRenameForm,
  };
}
