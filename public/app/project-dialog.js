import { createElement } from "./dom.js?v=1.4.43";
import { idOf } from "./snapshot.js?v=1.4.43";
import { createAgentPicker } from "./agent-picker.js?v=1.4.43";
import { createFolderField } from "./folder-field.js?v=1.4.43";

// A new workspace in a Herdr session (`herdrSessionId`, or the default when
// null), with a shell or an installed agent started in its first pane, in
// `folder` when one is given (`folderAsOpened`: still the folder the dialog
// opened with, see folder-field.js). The answer's snapshot is taken in and its
// first pane selected; that pane's id is returned, or null when the answer
// did not name one and nothing new could be told apart. The New workspace
// dialog and the New tab dialog's "New workspace…" both make one with this.
// Errors are the caller's to show; a `project_pane_missing` one means the
// workspace is there and only its agent did not start.
export async function createWorkspace({ api, state, snapshotRecords, adoptMutationSnapshot }, {
  label, herdrSessionId = null, agent = "", folder = "", folderAsOpened = false,
}) {
  const previousPaneIds = new Set(
    snapshotRecords().panes.map((pane) => idOf(pane, "pane_id", "id")),
  );
  const payload = await api("/api/workspaces", {
    method: "POST",
    body: {
      label,
      ...(herdrSessionId ? { herdrSessionId } : {}),
      ...(agent ? { agent } : {}),
      ...(folder ? { folder, ...(folderAsOpened ? { folderAsOpened: true } : {}) } : {}),
    },
  });
  state.snapshot = payload.snapshot || {};
  const newPane = snapshotRecords().panes.find(
    (pane) => !previousPaneIds.has(idOf(pane, "pane_id", "id")) &&
      (!herdrSessionId || pane.herdr_session_id === herdrSessionId),
  );
  const paneId = payload.paneId || (newPane ? idOf(newPane, "pane_id", "id") : null);
  adoptMutationSnapshot(state.snapshot, paneId);
  return paneId;
}

// The "New workspace" dialog: a machine's ⋯ menu opens it for that machine. The
// form creates the workspace in one of the machine's running sessions
// (a choice only when it has more than one), with a shell or with an agent
// installed there started in its first pane, each agent a tab with its mark,
// in the machine's home folder or a folder typed or chosen from the folder tree.
// Which agents are installed is asked of the machine when the dialog opens.
// Listeners are registered when this is called, not on import.
export function createProjectDialog({
  state,
  elements,
  api,
  snapshotRecords,
  herdrSessionForServer,
  adoptMutationSnapshot,
  closeMobileSidebar,
  refreshSnapshot,
  setFeedback,
  agentMark,
}) {
  const sessionLabel = document.querySelector('label[for="project-server-session"]');
  const sessionSelect = document.querySelector("#project-server-session");
  const agentField = document.querySelector("#project-agent");
  const agents = createAgentPicker(agentField, { agentMark });
  const folder = createFolderField(document.querySelector("#project-folder-field"), { api });
  // The machine the dialog was opened for.
  let serverId = "local";
  // A late agent list, for a session chosen before the one chosen now, is dropped.
  let asked = 0;
  let agentsLoading = false;

  function say(text, error = false) {
    elements.projectDialogFeedback.textContent = text;
    elements.projectDialogFeedback.dataset.error = String(error);
  }

  async function loadAgents() {
    const mine = ++asked;
    agentsLoading = true;
    agentField.disabled = true;
    say("Looking for installed agents…");
    try {
      const answer = await api(`/api/agents?server=${encodeURIComponent(serverId)}`);
      if (mine !== asked) return;
      agents.fill(answer.agents, agents.value());
      if (!answer.supported) say("This machine cannot list its agents. Update HerdRabbit there to start one from here.");
      else if (!answer.agents?.length) say("No agents were found on this machine's PATH. A shell will open.");
      else say("");
    } catch (error) {
      if (mine === asked) say(`${error.message} A shell can still be opened.`, true);
    } finally {
      if (mine === asked) {
        agentsLoading = false;
        agentField.disabled = state.mutationBusy;
      }
    }
  }

  // From a machine's ⋯ menu: a project on that machine, in its running Herdr
  // session (the selected pane's when that is on it). Nothing opens when the
  // machine has none running.
  function open(forServerId = "local") {
    if (state.mutationBusy) return;
    const herdrSession = herdrSessionForServer(forServerId);
    if (!herdrSession) return;
    serverId = forServerId;
    state.createProjectSessionId = idOf(herdrSession, "session_id", "id") || null;
    const { servers, herdrSessions } = snapshotRecords();
    const running = herdrSessions.filter((item) =>
      item.running && item.available && (item.server_id || "local") === serverId);
    sessionSelect.replaceChildren(...running.map((session) => {
      const option = createElement("option", { text: session.name });
      option.value = idOf(session, "session_id", "id");
      return option;
    }));
    sessionSelect.value = state.createProjectSessionId || "";
    // One session leaves nothing to choose.
    sessionLabel.hidden = running.length < 2;
    sessionSelect.hidden = running.length < 2;
    const machine = servers.length > 1
      ? servers.find((server) => server.id === serverId)?.name || (serverId === "local" ? "this machine" : "")
      : "";
    elements.projectSessionContext.textContent = machine
      ? `On ${machine}, with a shell or the agent chosen.`
      : "A shell opens in it, or the agent chosen.";
    agents.fill([]);
    folder.reset({ serverId });
    say("");
    elements.projectDialog.showModal();
    window.requestAnimationFrame(() => elements.projectName.focus());
    void loadAgents();
  }

  elements.projectDialogCancel.addEventListener("click", () => {
    if (!state.mutationBusy) elements.projectDialog.close();
  });

  elements.projectDialog.addEventListener("close", () => {
    asked += 1;
    state.createProjectSessionId = null;
    elements.projectCreateForm.reset();
    folder.close();
    elements.projectDialogFeedback.textContent = "";
  });

  elements.projectCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy) return;
    state.createProjectSessionId = sessionSelect.value || state.createProjectSessionId;
    const label = elements.projectName.value.trim();
    if (!label) {
      elements.projectName.setCustomValidity("Enter a workspace name.");
      elements.projectName.reportValidity();
      return;
    }
    elements.projectName.setCustomValidity("");
    const agent = agents.value();
    const chosenFolder = folder.value();
    state.mutationBusy = true;
    const submitButton = elements.projectCreateForm.querySelector('button[type="submit"]');
    const controls = [elements.projectName, sessionSelect, agentField, elements.projectDialogCancel, submitButton];
    for (const control of controls) control.disabled = true;
    folder.setDisabled(true);
    say(agent ? "Creating workspace and starting the agent…" : "Creating workspace…");
    try {
      await createWorkspace({ api, state, snapshotRecords, adoptMutationSnapshot }, {
        label,
        herdrSessionId: state.createProjectSessionId,
        agent,
        folder: chosenFolder,
        folderAsOpened: folder.asOpened(),
      });
      elements.projectDialog.close();
      closeMobileSidebar();
    } catch (error) {
      if (error.code === "project_pane_missing") {
        // The project is there, only its agent did not start: pressing Create
        // again would make a second one, so the dialog closes and says so.
        elements.projectDialog.close();
        setFeedback(error.message, true);
        void refreshSnapshot();
      } else say(error.message, true);
    } finally {
      state.mutationBusy = false;
      for (const control of controls) control.disabled = false;
      folder.setDisabled(false);
      // the agent list may still be on its way: its choices stay off until it lands
      agentField.disabled = agentsLoading;
    }
  });

  elements.projectName.addEventListener("input", () => {
    elements.projectName.setCustomValidity("");
  });

  return { open };
}
