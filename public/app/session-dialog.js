import { createElement } from "./dom.js?v=1.4.23";
import { sessionAgentChoices } from "../agents.js?v=1.4.23";

// The "New session" dialog: a project's ⋯ menu opens it, the form makes a
// session in that project with a shell or an installed agent, and a name if
// one is given. Which agents are installed is asked of the project's machine
// each time it opens (the server keeps its answer briefly). Listeners are
// registered when this is called, not on import.
export function createSessionDialog({ state, api, snapshotRecords, createSession }) {
  const dialog = document.querySelector("#session-dialog");
  const form = document.querySelector("#session-create-form");
  const context = document.querySelector("#session-dialog-context");
  const agentSelect = document.querySelector("#session-agent");
  const nameInput = document.querySelector("#session-name");
  const feedback = document.querySelector("#session-dialog-feedback");
  const cancel = document.querySelector("#session-dialog-cancel");
  const submit = form.querySelector('button[type="submit"]');
  let target = null;
  // A late answer for a dialog opened since is dropped.
  let generation = 0;
  // The agent last started here, chosen first next time while this page lasts.
  let lastAgent = "";

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
      if (!answer.supported) say("This machine cannot list its agents. Update HerdRabbit there to start one from here.");
      else if (!answer.agents?.length) say("No agents were found on this machine's PATH. A shell will open.");
      else say("");
    } catch (error) {
      if (opened !== generation) return;
      say(`${error.message} A shell can still be opened.`, true);
    } finally {
      if (opened === generation) agentSelect.disabled = false;
    }
  }

  function open({ workspaceId, workspaceLabel, serverId = "local" }) {
    if (state.mutationBusy) return;
    generation += 1;
    target = { workspaceId, serverId };
    form.reset();
    fillAgents([]);
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

  cancel.addEventListener("click", () => {
    if (!state.mutationBusy) dialog.close();
  });

  dialog.addEventListener("close", () => {
    generation += 1;
    target = null;
    form.reset();
    say("");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy || !target) return;
    const agent = agentSelect.value;
    const label = nameInput.value.trim();
    state.mutationBusy = true;
    for (const control of [agentSelect, nameInput, cancel, submit]) control.disabled = true;
    say(agent ? "Starting session…" : "Opening session…");
    try {
      await createSession(target.workspaceId, { ...(agent ? { agent } : {}), ...(label ? { label } : {}) });
      lastAgent = agent;
      dialog.close();
    } catch (error) {
      say(error.message, true);
    } finally {
      state.mutationBusy = false;
      for (const control of [agentSelect, nameInput, cancel, submit]) control.disabled = false;
    }
  });

  return { open };
}
