import { createElement } from "./dom.js?v=1.4.23";
import { sessionAgentChoices, sessionChoiceLabel } from "../agents.js?v=1.4.23";

// The "New session" dialog: a project's ⋯ menu opens it, the form makes a
// session in that project with a shell or an installed agent, and a name if
// one is given. Which agents are installed is asked of the project's machine
// each time it opens (the server keeps its answer briefly). Once an agent is
// chosen, that machine's earlier sessions of it in the project's folder are
// offered too: picking one resumes it instead of starting new. Titles are
// shown as text only. Listeners are registered when this is called, not on
// import.
export function createSessionDialog({ state, api, snapshotRecords, createSession }) {
  const dialog = document.querySelector("#session-dialog");
  const form = document.querySelector("#session-create-form");
  const context = document.querySelector("#session-dialog-context");
  const agentSelect = document.querySelector("#session-agent");
  const resumeLabel = document.querySelector("#session-resume-label");
  const resumeSelect = document.querySelector("#session-resume");
  const nameInput = document.querySelector("#session-name");
  const feedback = document.querySelector("#session-dialog-feedback");
  const cancel = document.querySelector("#session-dialog-cancel");
  const submit = form.querySelector('button[type="submit"]');
  let target = null;
  // A late answer for a dialog opened since is dropped.
  let generation = 0;
  // While the agent list is still being asked for, its select stays off.
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
    const wanted = agentSelect.value || lastAgent;
    agentSelect.replaceChildren(...sessionAgentChoices(names).map(({ value, label }) => {
      const option = createElement("option", { text: label });
      option.value = value;
      return option;
    }));
    agentSelect.value = [...agentSelect.options].some((option) => option.value === wanted) ? wanted : "";
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

  function showChoice() {
    submit.textContent = resuming() ? "Resume" : "Start";
  }

  // The chosen agent's earlier sessions in the project's folder, asked of the
  // project's machine. None for a shell, or for an agent that cannot be resumed.
  async function loadSessions(opened) {
    const agent = agentSelect.value;
    const asked = ++sessionsAsked;
    fillSessions([]);
    if (!agent || !target) return;
    const current = () => asked === sessionsAsked && opened === generation;
    say("Looking for earlier sessions…");
    try {
      const answer = await api(`/api/workspaces/${encodeURIComponent(target.workspaceId)}/agent-sessions?agent=${encodeURIComponent(agent)}`);
      if (!current()) return;
      const where = answer.folder ? ` in ${answer.folder}` : " here";
      const sessions = Array.isArray(answer.sessions) ? answer.sessions : [];
      if (!answer.supported) {
        say(answer.reason === "machine" ? "This machine cannot list earlier sessions. Update HerdRabbit there to resume one." : "");
      } else if (sessions.length === 0) say(`No earlier sessions${where}.`);
      else {
        fillSessions(sessions);
        say(`Earlier sessions${where}.`);
      }
    } catch (error) {
      if (current()) say(`${error.message} A new session can still be started.`, true);
    }
  }

  function machineName(serverId) {
    const { servers } = snapshotRecords();
    if (servers.length < 2) return "";
    const server = servers.find((item) => item.id === serverId);
    return server?.name || (serverId === "local" ? "this machine" : "");
  }

  async function loadAgents(serverId, opened) {
    try {
      const answer = await api(`/api/agents?server=${encodeURIComponent(serverId)}`);
      if (opened !== generation) return;
      fillAgents(answer.agents);
      if (agentSelect.value) {
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
        agentSelect.disabled = state.mutationBusy;
      }
    }
  }

  function open({ workspaceId, workspaceLabel, serverId = "local" }) {
    if (state.mutationBusy) return;
    generation += 1;
    target = { workspaceId, serverId };
    form.reset();
    fillAgents([]);
    fillSessions([]);
    agentsLoading = true;
    agentSelect.disabled = true;
    const machine = machineName(serverId);
    context.textContent = machine
      ? `In project “${workspaceLabel}” on ${machine}.`
      : `In project “${workspaceLabel}”.`;
    say("Looking for installed agents…");
    dialog.showModal();
    window.requestAnimationFrame(() => agentSelect.focus());
    void loadAgents(serverId, generation);
  }

  agentSelect.addEventListener("change", () => { void loadSessions(generation); });
  resumeSelect.addEventListener("change", showChoice);

  cancel.addEventListener("click", () => {
    if (!state.mutationBusy) dialog.close();
  });

  dialog.addEventListener("close", () => {
    generation += 1;
    target = null;
    form.reset();
    fillSessions([]);
    say("");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy || !target) return;
    const agent = agentSelect.value;
    const resume = agent && resuming() ? resumeSelect.value : "";
    const label = nameInput.value.trim();
    const controls = [agentSelect, resumeSelect, nameInput, cancel, submit];
    state.mutationBusy = true;
    for (const control of controls) control.disabled = true;
    say(resume ? "Resuming session…" : agent ? "Starting session…" : "Opening session…");
    try {
      await createSession(target.workspaceId, { ...(agent ? { agent } : {}), ...(resume ? { resume } : {}), ...(label ? { label } : {}) });
      lastAgent = agent;
      dialog.close();
    } catch (error) {
      say(error.message, true);
    } finally {
      state.mutationBusy = false;
      for (const control of controls) control.disabled = false;
      // the agent list may still be on its way: its select stays off until it lands
      agentSelect.disabled = agentsLoading;
    }
  });

  return { open };
}
