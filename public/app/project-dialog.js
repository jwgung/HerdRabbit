import { createElement } from "./dom.js?v=1.4.23";
import { idOf } from "./snapshot.js?v=1.4.23";

// The "New project" dialog: the add menu's button opens it, the form creates
// the workspace. Listeners are registered when this is called, not on import.
export function createProjectDialog({
  state,
  elements,
  api,
  snapshotRecords,
  newProjectHerdrSession,
  adoptMutationSnapshot,
  closeMobileSidebar,
}) {
  elements.createProject.addEventListener("click", () => {
    document.querySelector("#add-menu").open = false;
    if (state.mutationBusy) return;
    const herdrSession = newProjectHerdrSession();
    if (!herdrSession) return;
    state.createProjectSessionId = idOf(herdrSession, "session_id", "id") || null;
    const select = document.querySelector("#project-server-session");
    select.replaceChildren();
    // Every machine's running sessions: the picker chooses where it is made.
    for (const session of snapshotRecords().herdrSessions.filter((item) => item.running && item.available)) {
      const option = createElement("option", { text: `${session.server_name || "Local"} / ${session.name}` });
      option.value = idOf(session, "session_id", "id");
      select.append(option);
    }
    select.value = state.createProjectSessionId || "";
    select.disabled = select.options.length < 2;
    elements.projectSessionContext.textContent = select.options.length > 1
      ? `A default shell will open in Herdr session “${herdrSession.name}”.`
      : "A default shell will open.";
    elements.projectDialogFeedback.textContent = "";
    elements.projectDialogFeedback.dataset.error = "false";
    elements.projectDialog.showModal();
    window.requestAnimationFrame(() => elements.projectName.focus());
  });

  elements.projectDialogCancel.addEventListener("click", () => {
    if (!state.mutationBusy) elements.projectDialog.close();
  });

  elements.projectDialog.addEventListener("close", () => {
    state.createProjectSessionId = null;
    elements.projectCreateForm.reset();
    elements.projectDialogFeedback.textContent = "";
  });

  elements.projectCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy) return;
    state.createProjectSessionId = document.querySelector("#project-server-session").value || state.createProjectSessionId;
    const label = elements.projectName.value.trim();
    if (!label) {
      elements.projectName.setCustomValidity("Enter a project name.");
      elements.projectName.reportValidity();
      return;
    }
    elements.projectName.setCustomValidity("");
    state.mutationBusy = true;
    const submitButton = elements.projectCreateForm.querySelector('button[type="submit"]');
    elements.projectName.disabled = true;
    elements.projectDialogCancel.disabled = true;
    submitButton.disabled = true;
    elements.projectDialogFeedback.textContent = "Creating project…";
    elements.projectDialogFeedback.dataset.error = "false";
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
        },
      });
      state.snapshot = payload.snapshot || {};
      const newPane = snapshotRecords().panes.find(
        (pane) => !previousPaneIds.has(idOf(pane, "pane_id", "id")) &&
          (!state.createProjectSessionId || pane.herdr_session_id === state.createProjectSessionId),
      );
      adoptMutationSnapshot(
        state.snapshot,
        newPane ? idOf(newPane, "pane_id", "id") : null,
      );
      elements.projectDialog.close();
      closeMobileSidebar();
    } catch (error) {
      elements.projectDialogFeedback.textContent = error.message;
      elements.projectDialogFeedback.dataset.error = "true";
    } finally {
      state.mutationBusy = false;
      elements.projectName.disabled = false;
      elements.projectDialogCancel.disabled = false;
      submitButton.disabled = false;
    }
  });

  elements.projectName.addEventListener("input", () => {
    elements.projectName.setCustomValidity("");
  });

  return {};
}
