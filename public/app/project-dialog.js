import { createElement } from "./dom.js?v=1.4.24";
import { idOf } from "./snapshot.js?v=1.4.24";
import { sessionAgentChoices } from "../agents.js?v=1.4.24";

// The "New project" dialog: the add menu's button opens it, the form creates
// the workspace, with a shell or with an agent installed on the chosen
// session's machine started in its first pane. Which agents are installed is
// asked of that machine when the dialog opens and when another session is
// chosen. Listeners are registered when this is called, not on import.
export function createProjectDialog({
  state,
  elements,
  api,
  snapshotRecords,
  newProjectHerdrSession,
  adoptMutationSnapshot,
  closeMobileSidebar,
  refreshSnapshot,
  setFeedback,
}) {
  const sessionSelect = document.querySelector("#project-server-session");
  const agentSelect = document.querySelector("#project-agent");
  // A late agent list, for a session chosen before the one chosen now, is dropped.
  let asked = 0;
  let agentsLoading = false;

  function say(text, error = false) {
    elements.projectDialogFeedback.textContent = text;
    elements.projectDialogFeedback.dataset.error = String(error);
  }

  function fillAgents(names) {
    const wanted = agentSelect.value;
    agentSelect.replaceChildren(...sessionAgentChoices(names).map(({ value, label }) => {
      const option = createElement("option", { text: label });
      option.value = value;
      return option;
    }));
    agentSelect.value = [...agentSelect.options].some((option) => option.value === wanted) ? wanted : "";
  }

  // The machine of the Herdr session chosen: this one when none is named.
  function chosenServerId() {
    const sessionId = sessionSelect.value || state.createProjectSessionId;
    const session = snapshotRecords().herdrSessions.find((item) => idOf(item, "session_id", "id") === sessionId);
    return session?.server_id || "local";
  }

  async function loadAgents() {
    const mine = ++asked;
    agentsLoading = true;
    agentSelect.disabled = true;
    say("Looking for installed agents…");
    try {
      const answer = await api(`/api/agents?server=${encodeURIComponent(chosenServerId())}`);
      if (mine !== asked) return;
      fillAgents(answer.agents);
      if (!answer.supported) say("This machine cannot list its agents. Update HerdRabbit there to start one from here.");
      else if (!answer.agents?.length) say("No agents were found on this machine's PATH. A shell will open.");
      else say("");
    } catch (error) {
      if (mine === asked) say(`${error.message} A shell can still be opened.`, true);
    } finally {
      if (mine === asked) {
        agentsLoading = false;
        agentSelect.disabled = state.mutationBusy;
      }
    }
  }

  elements.createProject.addEventListener("click", () => {
    document.querySelector("#add-menu").open = false;
    if (state.mutationBusy) return;
    const herdrSession = newProjectHerdrSession();
    if (!herdrSession) return;
    state.createProjectSessionId = idOf(herdrSession, "session_id", "id") || null;
    sessionSelect.replaceChildren();
    // Every machine's running sessions: the picker chooses where it is made.
    for (const session of snapshotRecords().herdrSessions.filter((item) => item.running && item.available)) {
      const option = createElement("option", { text: `${session.server_name || "Local"} / ${session.name}` });
      option.value = idOf(session, "session_id", "id");
      sessionSelect.append(option);
    }
    sessionSelect.value = state.createProjectSessionId || "";
    sessionSelect.disabled = sessionSelect.options.length < 2;
    elements.projectSessionContext.textContent = sessionSelect.options.length > 1
      ? `It opens in Herdr session “${herdrSession.name}” unless another is chosen, with a shell or the agent chosen.`
      : "It opens with a shell, or the agent chosen.";
    agentSelect.value = "";
    fillAgents([]);
    say("");
    elements.projectDialog.showModal();
    window.requestAnimationFrame(() => elements.projectName.focus());
    void loadAgents();
  });

  sessionSelect.addEventListener("change", () => { void loadAgents(); });

  elements.projectDialogCancel.addEventListener("click", () => {
    if (!state.mutationBusy) elements.projectDialog.close();
  });

  elements.projectDialog.addEventListener("close", () => {
    asked += 1;
    state.createProjectSessionId = null;
    elements.projectCreateForm.reset();
    elements.projectDialogFeedback.textContent = "";
  });

  elements.projectCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy) return;
    state.createProjectSessionId = sessionSelect.value || state.createProjectSessionId;
    const label = elements.projectName.value.trim();
    if (!label) {
      elements.projectName.setCustomValidity("Enter a project name.");
      elements.projectName.reportValidity();
      return;
    }
    elements.projectName.setCustomValidity("");
    const agent = agentSelect.value;
    state.mutationBusy = true;
    const submitButton = elements.projectCreateForm.querySelector('button[type="submit"]');
    const controls = [elements.projectName, agentSelect, elements.projectDialogCancel, submitButton];
    for (const control of controls) control.disabled = true;
    say(agent ? "Creating project and starting the agent…" : "Creating project…");
    const previousPaneIds = new Set(
      snapshotRecords().panes.map((pane) => idOf(pane, "pane_id", "id")),
    );
    try {
      const payload = await api("/api/workspaces", {
        method: "POST",
        body: {
          label,
          ...(state.createProjectSessionId
            ? { herdrSessionId: state.createProjectSessionId }
            : {}),
          ...(agent ? { agent } : {}),
        },
      });
      state.snapshot = payload.snapshot || {};
      const newPane = snapshotRecords().panes.find(
        (pane) => !previousPaneIds.has(idOf(pane, "pane_id", "id")) &&
          (!state.createProjectSessionId || pane.herdr_session_id === state.createProjectSessionId),
      );
      adoptMutationSnapshot(
        state.snapshot,
        payload.paneId || (newPane ? idOf(newPane, "pane_id", "id") : null),
      );
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
      // the agent list may still be on its way: its select stays off until it lands
      agentSelect.disabled = agentsLoading;
    }
  });

  elements.projectName.addEventListener("input", () => {
    elements.projectName.setCustomValidity("");
  });

  return {};
}
