import { createElement } from "./dom.js?v=1.4.47";
import { idOf } from "./snapshot.js?v=1.4.47";
import { sessionChoiceLabel, sessionChoiceParts } from "../agents.js?v=1.4.47";
import { createAgentPicker } from "./agent-picker.js?v=1.4.47";
import { createFolderField, workspaceFolder } from "./folder-field.js?v=1.4.47";
import { createWorkspace } from "./project-dialog.js?v=1.4.47";

// The "New tab" dialog. The + at the top of the sidebar opens it on the
// workspace on show (the first machine's first workspace when nothing is),
// and a workspace's ⋯ menu opens it on that workspace. From the top, it asks:
// - Machine and Workspace: where the tab goes. Workspace ends with "New
//   workspace…", which asks for a name and makes the workspace with this tab
//   as its first, through the New workspace dialog's own call
//   (createWorkspace in project-dialog.js).
// - Folder: where the tab opens, the workspace's folder at first (the home
//   folder for a new workspace); typed, or chosen from the Files tree.
// - Agent: a shell or an agent installed on the machine, as a strip of tabs
//   with their marks. Which agents are installed is asked of the machine each
//   time it is chosen (the server keeps its answer briefly).
// - Earlier conversations: the chosen agent's on that machine in the chosen
//   Folder, asked again whenever the agent, the workspace or the Folder
//   changes, as radio rows under "Start new conversation"; picking one
//   resumes it in that folder instead of starting new. Titles are shown as
//   text only. A new workspace has none to offer.
// - Tab name, optional.
// Listeners are registered when this is called, not on import.
const FOLDER_DEBOUNCE_MS = 400;

// The Workspace choice that makes a new one.
export const NEW_WORKSPACE = "+new";

// The Machine choices: every machine in the snapshot, with its status for the
// select popover's dot; a snapshot that lists none is this machine alone.
export function newTabMachines(servers) {
  if (!Array.isArray(servers) || servers.length === 0) return [{ value: "local", label: "This machine", status: "online" }];
  return servers.map((server) => ({
    value: server.id,
    label: server.name || (server.id === "local" ? "This machine" : server.id),
    status: server.available ? "online" : "offline",
  }));
}

// The Workspace choices on `serverId`'s machine (a workspace with no
// server_id is this machine's), in the snapshot's order.
export function newTabWorkspaces(workspaces, serverId) {
  return (Array.isArray(workspaces) ? workspaces : [])
    .filter((workspace) => (workspace.server_id || "local") === serverId)
    .map((workspace) => ({ value: workspace.workspace_id, label: workspace.label || workspace.workspace_id }));
}

// Where the dialog opens: the workspace asked for, else the selected pane's,
// else the first online machine's first workspace (New workspace when it has
// none).
export function newTabPlace({ servers, workspaces, panes }, { workspaceId = null, selectedPaneId = null } = {}) {
  const all = Array.isArray(workspaces) ? workspaces : [];
  const at = (id) => all.find((workspace) => workspace.workspace_id === id);
  const pane = selectedPaneId ? (panes ?? []).find((item) => (item.pane_id ?? item.id) === selectedPaneId) : null;
  const workspace = (workspaceId && at(workspaceId)) || (pane && at(pane.workspace_id));
  if (workspace) return { serverId: workspace.server_id || "local", workspaceId: workspace.workspace_id };
  const machines = newTabMachines(servers);
  const serverId = (machines.find((machine) => machine.status === "online") ?? machines[0]).value;
  return { serverId, workspaceId: newTabWorkspaces(all, serverId)[0]?.value ?? NEW_WORKSPACE };
}

export function createSessionDialog({
  state, api, snapshotRecords, createSession, agentMark,
  herdrSessionForServer, adoptMutationSnapshot, closeMobileSidebar, refreshSnapshot, setFeedback,
}) {
  const dialog = document.querySelector("#session-dialog");
  const form = document.querySelector("#session-create-form");
  const machineSelect = document.querySelector("#session-machine");
  const workspaceSelect = document.querySelector("#session-workspace");
  const newWorkspace = document.querySelector("#session-new-workspace");
  const workspaceName = document.querySelector("#session-workspace-name");
  const agentField = document.querySelector("#session-agent");
  const conversations = document.querySelector("#session-conversations");
  const agents = createAgentPicker(agentField, { agentMark, panel: conversations.id });
  const list = conversations.querySelector(".conversation-list");
  const note = document.querySelector("#session-conversations-note");
  const nameInput = document.querySelector("#session-name");
  const folder = createFolderField(document.querySelector("#session-folder-field"), { api, onChange: () => folderChanged() });
  const feedback = document.querySelector("#session-dialog-feedback");
  const cancel = document.querySelector("#session-dialog-cancel");
  const submit = form.querySelector('button[type="submit"]');
  // Where the tab goes: { serverId, workspaceId }, NEW_WORKSPACE for a new one.
  let target = null;
  // A late answer for a machine chosen (or a dialog opened) since is dropped.
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

  const making = () => target?.workspaceId === NEW_WORKSPACE;

  function fillAgents(names) {
    agents.fill(names, agents.value() || lastAgent);
    labelPanel();
  }

  // The panel is the chosen tab's.
  function labelPanel() {
    const tab = agents.selectedTab();
    if (tab?.id) conversations.setAttribute("aria-labelledby", tab.id);
  }

  const option = ({ value, label, status, description }) => {
    const element = createElement("option", { text: label });
    element.value = value;
    if (status) element.dataset.status = status;
    if (description) element.dataset.description = description;
    return element;
  };

  // The machines, an offline one not to be chosen (unless it is where the
  // dialog was opened, so the select still says so).
  function fillMachines() {
    const machines = newTabMachines(snapshotRecords().servers);
    machineSelect.replaceChildren(...machines.map((machine) => {
      const element = option(machine);
      element.disabled = machine.status === "offline" && machine.value !== target.serverId;
      return element;
    }));
    machineSelect.value = target.serverId;
  }

  // The machine's workspaces, the one on show marked "current", then New
  // workspace… (off when the machine has no running Herdr session to make
  // it in).
  function fillWorkspaces() {
    const { panes } = snapshotRecords();
    const shown = panes.find((pane) => idOf(pane, "pane_id", "id") === state.selectedPaneId)?.workspace_id;
    const workspaces = newTabWorkspaces(snapshotRecords().workspaces, target.serverId);
    const make = option({ value: NEW_WORKSPACE, label: "New workspace…" });
    make.disabled = !herdrSessionForServer(target.serverId);
    workspaceSelect.replaceChildren(
      ...workspaces.map((workspace) => option({ ...workspace, ...(workspace.value === shown ? { description: "current" } : {}) })),
      make,
    );
    if (![...workspaceSelect.options].some((item) => item.value === target.workspaceId && !item.disabled)) {
      target.workspaceId = workspaces[0]?.value ?? NEW_WORKSPACE;
    }
    workspaceSelect.value = target.workspaceId;
  }

  // The Folder, the name field and the conversations for the workspace chosen.
  function workspaceChosen() {
    newWorkspace.hidden = !making();
    workspaceName.required = making();
    folder.reset({ serverId: target.serverId, folder: making() ? null : workspaceFolder(snapshotRecords().panes, target.workspaceId) });
    void loadSessions(generation);
  }

  // The agents are asked for first: the conversations wait for them.
  function machineChosen() {
    fillWorkspaces();
    askForAgents();
    workspaceChosen();
  }

  const resumeChoice = () => list.querySelector('input[type="radio"]:checked')?.value ?? "";
  const resuming = () => !list.hidden && resumeChoice() !== "";

  function conversationRow({ value, title, ago = "", tooltip = "" }) {
    const row = createElement("label", { className: "conversation-choice" });
    const input = createElement("input");
    input.type = "radio";
    input.name = "session-resume";
    input.value = value;
    input.checked = value === "";
    row.append(input, createElement("span", { className: "conversation-radio" }),
      createElement("span", { className: "conversation-title", text: title }));
    if (ago) row.append(createElement("span", { className: "conversation-when", text: ago }));
    if (tooltip) row.title = tooltip;
    return row;
  }

  // The rows: Start new conversation first and chosen, then each earlier one.
  function fillSessions(sessions, text = "") {
    const now = Date.now();
    list.replaceChildren(...(sessions.length ? [
      conversationRow({ value: "", title: "Start new conversation" }),
      ...sessions.map((session) => conversationRow({ value: session.id, ...sessionChoiceParts(session, now), tooltip: sessionChoiceLabel(session, now) })),
    ] : []));
    list.hidden = sessions.length === 0;
    note.textContent = text;
    note.dataset.error = "false";
    showChoice();
  }

  // A resumed conversation opens in the Folder shown, which is also the one
  // its earlier conversations are listed for, so the row stays on view.
  function showChoice() {
    submit.textContent = resuming() ? "Resume" : making() ? "Create" : "Start";
  }

  // Typing or choosing another Folder lists that folder's conversations; a
  // keystroke waits a moment, and an answer for a folder since changed is
  // dropped (sessionsAsked in loadSessions).
  let folderTimer = 0;
  function folderChanged() {
    window.clearTimeout(folderTimer);
    if (!target || !agents.value() || making()) return;
    folderTimer = window.setTimeout(() => { void loadSessions(generation); }, FOLDER_DEBOUNCE_MS);
  }

  // The chosen agent's earlier conversations in the chosen Folder, asked of
  // the workspace's machine. None for a shell, for an agent that cannot be
  // resumed, or for a workspace not made yet.
  async function loadSessions(opened) {
    const agent = agents.value();
    const asked = ++sessionsAsked;
    window.clearTimeout(folderTimer);
    fillSessions([]);
    if (!agent || !target) return;
    if (making()) {
      note.textContent = "A new workspace starts a new conversation.";
      return;
    }
    const current = () => asked === sessionsAsked && opened === generation;
    note.textContent = "Looking for earlier conversations…";
    try {
      // the folder as the dialog opened is the workspace's own: left out, so
      // its answer is the workspace's, as before
      const chosen = folder.asOpened() ? "" : `&folder=${encodeURIComponent(folder.value())}`;
      const answer = await api(`/api/workspaces/${encodeURIComponent(target.workspaceId)}/agent-sessions?agent=${encodeURIComponent(agent)}${chosen}`);
      if (!current()) return;
      const where = answer.folder ? ` in ${folder.show(answer.folder)}` : " here";
      const sessions = Array.isArray(answer.sessions) ? answer.sessions : [];
      if (!answer.supported) {
        fillSessions([], answer.reason === "machine"
          ? "This machine cannot list earlier conversations. Update HerdRabbit there to resume one."
          : "This agent's conversations cannot be resumed from here.");
      } else if (sessions.length === 0) fillSessions([], `No earlier conversations${where}.`);
      else fillSessions(sessions, `Earlier conversations${where}.`);
    } catch (error) {
      if (!current()) return;
      note.textContent = `${error.message} A new conversation can still be started.`;
      note.dataset.error = "true";
    }
  }

  // The machine's agents, and with them its earlier conversations. A late
  // answer for a machine chosen before is dropped.
  function askForAgents() {
    generation += 1;
    agents.fill([]);
    labelPanel();
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
      if (!answer.supported) say("This machine cannot list its agents. Update HerdRabbit there to start one from here.");
      else if (!answer.agents?.length) say("No agents were found on this machine's PATH. A shell will open.");
      else say("");
      if (agents.value()) void loadSessions(opened);
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

  // From the + (no workspace: the one on show) or a workspace's ⋯ menu (that
  // workspace).
  function open({ workspaceId = null } = {}) {
    if (state.mutationBusy) return;
    form.reset();
    target = newTabPlace(snapshotRecords(), { workspaceId, selectedPaneId: state.selectedPaneId });
    fillMachines();
    fillWorkspaces();
    say("");
    dialog.showModal();
    askForAgents();
    workspaceChosen();
    window.requestAnimationFrame(() => (making() ? workspaceName : workspaceSelect).focus());
  }

  machineSelect.addEventListener("change", () => {
    if (!target) return;
    target.serverId = machineSelect.value;
    machineChosen();
  });
  workspaceSelect.addEventListener("change", () => {
    if (!target) return;
    target.workspaceId = workspaceSelect.value;
    workspaceChosen();
    if (making()) workspaceName.focus();
  });
  agentField.addEventListener("change", () => {
    labelPanel();
    void loadSessions(generation);
  });
  list.addEventListener("change", showChoice);
  workspaceName.addEventListener("input", () => workspaceName.setCustomValidity(""));

  cancel.addEventListener("click", () => {
    if (!state.mutationBusy) dialog.close();
  });

  dialog.addEventListener("close", () => {
    generation += 1;
    target = null;
    window.clearTimeout(folderTimer);
    form.reset();
    fillSessions([]);
    folder.close();
    say("");
  });

  // The new workspace, with this tab as its first (named when a name is
  // given). A workspace made whose agent did not start closes the dialog, as
  // the New workspace dialog does: pressing Create again would make another.
  async function makeWorkspace({ agent, label }) {
    const herdrSession = herdrSessionForServer(target.serverId);
    const paneId = await createWorkspace({ api, state, snapshotRecords, adoptMutationSnapshot }, {
      label: workspaceName.value.trim(),
      herdrSessionId: idOf(herdrSession, "session_id", "id") || null,
      agent,
      folder: folder.value(),
      folderAsOpened: folder.asOpened(),
    });
    const tabId = label && paneId ? snapshotRecords().panes.find((pane) => idOf(pane, "pane_id", "id") === paneId)?.tab_id : null;
    if (tabId) {
      // the workspace is made either way: a name that did not take is said
      // in the sidebar, not here, where Create would make a second one
      try {
        await api(`/api/tabs/${encodeURIComponent(tabId)}/rename`, { method: "POST", body: { label } });
      } catch (error) {
        setFeedback(`The workspace was made, but its tab was not named. ${error.message}`, true);
      }
      void refreshSnapshot();
    }
    closeMobileSidebar();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy || !target) return;
    if (making() && !workspaceName.value.trim()) {
      workspaceName.setCustomValidity("Enter a workspace name.");
      workspaceName.reportValidity();
      return;
    }
    const agent = agents.value();
    const resume = agent && resuming() ? resumeChoice() : "";
    const label = nameInput.value.trim();
    // a resume in the folder the dialog opened with leaves it to the server,
    // which then uses the workspace's own folder as before
    const chosenFolder = resume && folder.asOpened() ? null : folder.value();
    const controls = [machineSelect, workspaceSelect, workspaceName, agentField, ...list.querySelectorAll("input"), nameInput, cancel, submit];
    state.mutationBusy = true;
    for (const control of controls) control.disabled = true;
    folder.setDisabled(true);
    say(making() ? (agent ? "Creating workspace and starting the agent…" : "Creating workspace…")
      : resume ? "Resuming conversation…" : agent ? "Opening tab and starting the agent…" : "Opening tab…");
    try {
      if (making()) await makeWorkspace({ agent, label });
      else {
        await createSession(target.workspaceId, {
          ...(agent ? { agent } : {}), ...(resume ? { resume } : {}), ...(label ? { label } : {}), ...(chosenFolder ? { folder: chosenFolder, ...(folder.asOpened() ? { folderAsOpened: true } : {}) } : {}),
        });
      }
      lastAgent = agent;
      dialog.close();
    } catch (error) {
      if (making() && error.code === "project_pane_missing") {
        dialog.close();
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

  return { open };
}
