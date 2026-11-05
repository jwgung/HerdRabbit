import { createElement } from "./dom.js?v=1.4.38";
import { sessionChoiceLabel } from "../agents.js?v=1.4.38";
import { createAgentPicker } from "./agent-picker.js?v=1.4.38";
import { createFolderField, workspaceFolder } from "./folder-field.js?v=1.4.38";

// The "New tab" dialog: a workspace's ⋯ menu opens it for that workspace.
// The form makes a tab in the workspace with a shell or an installed agent,
// each shown with its mark, and a name if one is given, in the workspace's
// folder or another typed or chosen with Browse…. Which agents are
// installed is asked of the workspace's machine each time it opens (the server
// keeps its answer briefly). Once an agent is chosen, that machine's earlier
// conversations of it in the workspace's folder are offered too: picking one
// resumes it instead of starting new. Titles are shown as text only.
// Listeners are registered when this is called, not on import.
export function createSessionDialog({ state, api, snapshotRecords, createSession, agentMark }) {
  const dialog = document.querySelector("#session-dialog");
  const form = document.querySelector("#session-create-form");
  const context = document.querySelector("#session-dialog-context");
  const agentField = document.querySelector("#session-agent");
  const agents = createAgentPicker(agentField, { agentMark });
  const resumeLabel = document.querySelector("#session-resume-label");
  const resumeSelect = document.querySelector("#session-resume");
  const nameInput = document.querySelector("#session-name");
  const folder = createFolderField(document.querySelector("#session-folder-field"), { api });
  const feedback = document.querySelector("#session-dialog-feedback");
  const cancel = document.querySelector("#session-dialog-cancel");
  const submit = form.querySelector('button[type="submit"]');
  let target = null;
  // A late answer for a dialog opened since is dropped.
  let generation = 0;
  // While the agent list is still being asked for, its choices stay off.
  let agentsLoading = false;
  // The agent last started here, chosen first next time while this page lasts.
  let lastAgent = "";
  // A late session list, for an agent chosen before the one chosen now, is dropped.
  let sessionsAsked = 0;

  function say(text, error = false) {
    feedback.textContent = text;
    feedback.dataset.error = String(error);
  }

  function fillAgents(names) {
    agents.fill(names, agents.value() || lastAgent);
  }

  const choice = (value, text) => {
    const option = createElement("option", { text });
    option.value = value;
    return option;
  };

  function fillSessions(sessions) {
    const now = Date.now();
    resumeSelect.replaceChildren(choice("", "Start new"), ...sessions.map((session) => choice(session.id, sessionChoiceLabel(session, now))));
    resumeSelect.value = "";
    resumeLabel.hidden = sessions.length === 0;
    resumeSelect.hidden = sessions.length === 0;
    showChoice();
  }

  const resuming = () => !resumeSelect.hidden && resumeSelect.value !== "";

  // A resumed conversation opens in the workspace's folder, where it was kept.
  function showChoice() {
    submit.textContent = resuming() ? "Resume" : "Start";
    folder.setHidden(resuming());
  }

  // The chosen agent's earlier sessions in the project's folder, asked of the
  // project's machine. None for a shell, or for an agent that cannot be resumed.
  async function loadSessions(opened) {
    const agent = agents.value();
    const asked = ++sessionsAsked;
    fillSessions([]);
    if (!agent || !target) return;
    const current = () => asked === sessionsAsked && opened === generation;
    say("Looking for earlier conversations…");
    try {
      const answer = await api(`/api/workspaces/${encodeURIComponent(target.workspaceId)}/agent-sessions?agent=${encodeURIComponent(agent)}`);
      if (!current()) return;
      const where = answer.folder ? ` in ${answer.folder}` : " here";
      const sessions = Array.isArray(answer.sessions) ? answer.sessions : [];
      if (!answer.supported) {
        say(answer.reason === "machine" ? "This machine cannot list earlier conversations. Update HerdRabbit there to resume one." : "");
      } else if (sessions.length === 0) say(`No earlier conversations${where}.`);
      else {
        fillSessions(sessions);
        say(`Earlier conversations${where}.`);
      }
    } catch (error) {
      if (current()) say(`${error.message} A new conversation can still be started.`, true);
    }
  }

  function machineName(serverId) {
    const { servers } = snapshotRecords();
    if (servers.length < 2) return "";
    const server = servers.find((item) => item.id === serverId);
    return server?.name || (serverId === "local" ? "this machine" : "");
  }

  // The machine's agents for the project, and with them its earlier
  // sessions. A late answer for a dialog opened before is dropped.
  function askForAgents() {
    generation += 1;
    fillSessions([]);
    agentsLoading = true;
    agentField.disabled = true;
    say("Looking for installed agents…");
    void loadAgents(target.serverId, generation);
  }

  async function loadAgents(serverId, opened) {
    try {
      const answer = await api(`/api/agents?server=${encodeURIComponent(serverId)}`);
      if (opened !== generation) return;
      fillAgents(answer.agents);
      if (agents.value()) {
        void loadSessions(opened);
        return;
      }
      if (!answer.supported) say("This machine cannot list its agents. Update HerdRabbit there to start one from here.");
      else if (!answer.agents?.length) say("No agents were found on this machine's PATH. A shell will open.");
      else say("");
    } catch (error) {
      if (opened !== generation) return;
      say(`${error.message} A shell can still be opened.`, true);
    } finally {
      if (opened === generation) {
        agentsLoading = false;
        agentField.disabled = state.mutationBusy;
      }
    }
  }

  // From a project's ⋯ menu: that project.
  function open({ workspaceId, workspaceLabel, serverId = "local" }) {
    if (state.mutationBusy) return;
    target = { workspaceId, serverId };
    form.reset();
    fillAgents([]);
    folder.reset({ serverId, folder: workspaceFolder(snapshotRecords().panes, workspaceId) });
    const machine = machineName(serverId);
    context.textContent = machine
      ? `In workspace “${workspaceLabel}” on ${machine}.`
      : `In workspace “${workspaceLabel}”.`;
    dialog.showModal();
    askForAgents();
    window.requestAnimationFrame(() => agents.focus());
  }

  agentField.addEventListener("change", () => { void loadSessions(generation); });
  resumeSelect.addEventListener("change", showChoice);

  cancel.addEventListener("click", () => {
    if (!state.mutationBusy) dialog.close();
  });

  dialog.addEventListener("close", () => {
    generation += 1;
    target = null;
    form.reset();
    fillSessions([]);
    folder.close();
    say("");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy || !target) return;
    const agent = agents.value();
    const resume = agent && resuming() ? resumeSelect.value : "";
    const label = nameInput.value.trim();
    const chosenFolder = resume ? null : folder.value();
    const controls = [agentField, resumeSelect, nameInput, cancel, submit];
    state.mutationBusy = true;
    for (const control of controls) control.disabled = true;
    folder.setDisabled(true);
    say(resume ? "Resuming conversation…" : agent ? "Opening tab and starting the agent…" : "Opening tab…");
    try {
      await createSession(target.workspaceId, {
        ...(agent ? { agent } : {}), ...(resume ? { resume } : {}), ...(label ? { label } : {}), ...(chosenFolder ? { folder: chosenFolder, ...(folder.asOpened() ? { folderAsOpened: true } : {}) } : {}),
      });
      lastAgent = agent;
      dialog.close();
    } catch (error) {
      say(error.message, true);
    } finally {
      state.mutationBusy = false;
      for (const control of controls) control.disabled = false;
      folder.setDisabled(false);
      // the agent list may still be on its way: its choices stay off until it lands
      agentField.disabled = agentsLoading;
    }
  });

  return { open };
}
