import { createElement, createIcon, placeFloatingMenu, workspaceActionButton } from "./dom.js?v=1.4.24";
import { idOf } from "./snapshot.js?v=1.4.24";
import {
  agentStatusIcon,
  agentStatusLabel,
  displayRecordLabel,
  displayTabLabel,
  paneAgentKind,
  paneDisplayTitle,
  paneRowLine,
  paneSubtitle,
} from "../ui-model.js?v=1.4.24";
import { writeCollapsedGroupIds, writeCollapsedWorkspaceIds } from "../workspace-preference.js?v=1.4.24";
import { tiles as viewTiles } from "../view-split.js?v=1.4.24";

// The sidebar's rows and what they open: the ⋯ action menus (also used by
// AI accounts and Files), a project's heading with its collapse
// and rename, a session's row with its agent mark, the fold on server and
// session headings, the rename form shared by projects, sessions and machines,
// and creating (through the New session dialog) or closing sessions and
// projects. Nothing here runs until createSidebarRows is called. The
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
    openNewSession,
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
        state.selectedPaneId ? "Loading output…" : "No open sessions.",
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
      !window.confirm(`Close session “${label}”? This will also stop any running processes.`)
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
      !window.confirm(`Close project “${workspaceLabel}”? This will close all of its sessions and stop any running processes.`)
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
        label: `${workspaceLabel} project name`,
        maxLength: 120,
        invalidMessage: "Enter a project name.",
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
            label: "New session…",
            paths: ["M12 5v14M5 12h14"],
            onSelect: () => openNewSession({
              workspaceId,
              workspaceLabel,
              serverId: workspace.server_id || "local",
            }),
          },
          {
            label: "Close project",
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

  // Small marks drawn here for each kind of program a row can run: simple
  // shapes that suggest the program, not its published artwork.
  const AGENT_MARKS = Object.freeze({
    claude: { box: "#d9774f", strokes: ["M12 5v14M5 12h14M7.1 7.1l9.8 9.8M16.9 7.1l-9.8 9.8"], color: "#ffffff", width: 1.9 },
    // six rounded petals turned 60 degrees apart, overlapping into a knot
    codex: { strokes: ["M12 2.6c2.3 0 3.6 2.3 3.6 4.7S14.2 12 12 12s-3.6-2.3-3.6-4.7S9.7 2.6 12 2.6z"], turns: 6, width: 1.4 },
    agy: { strokes: ["M6.5 19.5L12 5l5.5 14.5", "M3.5 14c4-2.4 13-2.4 17 0"], width: 1.8 },
    // OpenCode's mark: a pixelated "O" — outer ring with an inner block,
    // the same shape as the published favicon
    opencode: { box: "#131010", fills: [{ d: "M6 4.5h12v15H6V4.5ZM9 7.5v9h6v-9H9Z", color: "#ffffff" }, { d: "M9 10.5h6v6H9v-6Z", color: "#5A5858" }] },
    // Cursor's mark: a text caret on a dark field, the terminal cursor it is named for
    cursor: { box: "#111111", strokes: ["M9 5h6M9 19h6M12 5v14"], color: "#ffffff", width: 1.9 },
    // Kiro's Ghostie mark on its brand violet (from ovis / devswha, MIT)
    kiro: { box: "#9046FF", fills: [
      { d: "M8 16.4c-1.7 3.6 1.8 4.5 4.4 2.4.8 2.4 3.6.6 4.6-1.2 2.3-4.1 1.4-8.3 1.2-9.2-1.6-5.8-9.6-5.8-11 0q-.4 1.7-.5 3.5l-.4 1.7-.6 1.2c-.5.9-.3 2.5 2 1.7z", color: "#ffffff" },
      { d: "M12.7 11c-.6 0-.7-.8-.7-1.3q0-.6.2-1l.5-.2q.5 0 .6.3l.2 1q0 1.1-.8 1.2m2.7 0c-.6 0-.7-.8-.7-1.3q0-.6.2-1l.5-.2q.5 0 .6.3.3.3.2 1 0 1.1-.8 1.2", color: "#9046FF" },
    ] },
    other: { strokes: ["M12 3c.7 5 2 6.3 7 7-5 .7-6.3 2-7 7-.7-5-2-6.3-7-7 5-.7 6.3-2 7-7z", "M19 17v4M17 19h4"], width: 1.6 },
    shell: { strokes: ["M5 8l5 4-5 4", "M13 17h6"], width: 1.9 },
  });

  function agentMark(kind) {
    // Own keys only: "constructor" and the like are not marks.
    const known = Object.hasOwn(AGENT_MARKS, kind);
    const mark = known ? AGENT_MARKS[kind] : AGENT_MARKS.shell;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", `agent-icon agent-icon-${known ? kind : "shell"}`);
    if (mark.box) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", "1");
      rect.setAttribute("y", "1");
      rect.setAttribute("width", "22");
      rect.setAttribute("height", "22");
      rect.setAttribute("rx", "6");
      rect.setAttribute("fill", mark.box);
      svg.append(rect);
    }
    if (mark.fills) {
      for (const { d, color } of mark.fills) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", color || "currentColor");
        path.setAttribute("fill-rule", "evenodd");
        svg.append(path);
      }
      return svg;
    }
    for (const d of mark.strokes) for (let turn = 0; turn < (mark.turns || 1); turn += 1) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      if (turn > 0) path.setAttribute("transform", `rotate(${(360 / mark.turns) * turn} 12 12)`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", mark.color || "currentColor");
      path.setAttribute("stroke-width", String(mark.width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.append(path);
    }
    return svg;
  }

  function paneButton(pane, tab, workspace, { namesSession = false } = {}) {
    const paneId = idOf(pane, "pane_id", "id");
    const agent = agentForPane(paneId);
    const currentAgentStatus = visibleStatusForPane(paneId, agent, pane);
    const workspaceLabel = displayRecordLabel(workspace, "Project");
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
