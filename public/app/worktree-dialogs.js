import { createElement } from "./dom.js?v=1.4.53";
import { createAgentPicker } from "./agent-picker.js?v=1.4.53";

// Git worktrees from a workspace's ⋯ menu (Herdr's `herdr worktree`): New
// worktree… checks a branch out in a new folder of the workspace's repository
// and opens it as its own workspace; Open worktree… lists the repository's
// checkouts and opens one; Remove worktree…, on a worktree workspace, deletes
// its folder (never the branch) and closes it, and asks again before forcing
// past changes Git has not committed. Herdr says whether the workspace's
// folder is in Git: the dialogs ask it as they open and say so when it is not.
// New worktree… may start an installed agent of the workspace's machine in
// the new workspace's first pane, as New workspace… does; Shell is the default.
// Listeners are registered when this is called, not on import.
export function createWorktreeDialogs({ state, api, agentMark, adoptMutationSnapshot, closeMobileSidebar, refreshSnapshot, setFeedback }) {
  const create = {
    dialog: document.querySelector("#worktree-dialog"),
    form: document.querySelector("#worktree-create-form"),
    context: document.querySelector("#worktree-dialog-context"),
    branch: document.querySelector("#worktree-branch"),
    base: document.querySelector("#worktree-base"),
    label: document.querySelector("#worktree-label"),
    feedback: document.querySelector("#worktree-dialog-feedback"),
    cancel: document.querySelector("#worktree-dialog-cancel"),
    agentField: document.querySelector("#worktree-agent"),
  };
  create.submit = create.form.querySelector('button[type="submit"]');
  create.agents = createAgentPicker(create.agentField, { agentMark });
  // The agent last started in a worktree, chosen first next time while this page lasts.
  let lastAgent = "";
  const pick = {
    dialog: document.querySelector("#worktree-open-dialog"),
    form: document.querySelector("#worktree-open-form"),
    context: document.querySelector("#worktree-open-context"),
    choices: document.querySelector("#worktree-choices"),
    list: document.querySelector("#worktree-choices .worktree-choice-list"),
    feedback: document.querySelector("#worktree-open-feedback"),
    cancel: document.querySelector("#worktree-open-cancel"),
  };
  pick.submit = pick.form.querySelector('button[type="submit"]');
  // The workspace a dialog was opened for; a late list for an earlier one is dropped.
  let target = null;
  let generation = 0;

  const say = (feedback, text, error = false) => {
    feedback.textContent = text;
    feedback.dataset.error = String(error);
  };

  const worktreesPath = (workspaceId, rest = "worktrees") => `/api/workspaces/${encodeURIComponent(workspaceId)}/${rest}`;

  // What Herdr's refusal means for the person, in the page's words.
  function refusal(error) {
    if (error.code === "not_git_worktree") return "This workspace's folder is not in a Git repository, so it has no worktrees.";
    if (error.code === "linked_worktree_source") return "This workspace is itself a worktree. Use the menu of its repository's workspace.";
    return error.message;
  }

  // The repository's checkouts, or null after saying why there are none.
  async function loadList(feedback, opened) {
    say(feedback, "Asking Herdr for the repository…");
    try {
      const list = await api(worktreesPath(target.workspaceId));
      if (opened !== generation) return null;
      say(feedback, "");
      return list;
    } catch (error) {
      if (opened === generation) say(feedback, refusal(error), true);
      return null;
    }
  }

  function setBusy(controls, busy) {
    state.mutationBusy = busy;
    for (const control of controls) control.disabled = busy;
  }

  // The new workspace's snapshot and pane taken in; a snapshot that could not
  // be read is fetched again.
  function adopt(payload) {
    if (payload.snapshot) adoptMutationSnapshot(payload.snapshot, payload.paneId || null);
    else void refreshSnapshot();
    closeMobileSidebar();
  }

  // The workspace's machine's agents; a machine that cannot list them, or an
  // answer that fails, leaves Shell only, and the worktree can still be made.
  async function loadAgents(serverId, opened) {
    create.agentField.disabled = true;
    try {
      const answer = await api(`/api/agents?server=${encodeURIComponent(serverId)}`);
      if (opened !== generation) return;
      create.agents.fill(answer.agents ?? [], create.agents.value() || lastAgent);
      if (!answer.supported) create.agentsNote = "This machine cannot list its agents. Update HerdRabbit there to start one from here.";
      else if (!answer.agents?.length) create.agentsNote = "No agents were found on this machine's PATH. A shell will open.";
    } catch (error) {
      if (opened !== generation) return;
      create.agents.fill([]);
      create.agentsNote = `${error.message} A shell can still be opened.`;
    } finally {
      if (opened === generation) create.agentField.disabled = state.mutationBusy;
    }
  }

  async function openNew({ workspaceId, workspaceLabel, serverId = "local" }) {
    if (state.mutationBusy) return;
    target = { workspaceId, workspaceLabel };
    const opened = ++generation;
    create.context.textContent = `A branch of ${workspaceLabel}'s repository, checked out in a new folder and opened as its own workspace.`;
    create.submit.disabled = true;
    create.agents.fill([]);
    create.agentsNote = "";
    say(create.feedback, "");
    create.dialog.showModal();
    window.requestAnimationFrame(() => create.branch.focus());
    const agentsLoaded = loadAgents(serverId, opened);
    const list = await loadList(create.feedback, opened);
    await agentsLoaded;
    if (!list || opened !== generation) return;
    if (create.agentsNote) say(create.feedback, create.agentsNote);
    if (list.source?.repo_name) {
      create.context.textContent = `A branch of ${list.source.repo_name}, checked out in a new folder and opened as its own workspace. A local branch of that name is used as it is.`;
    }
    create.submit.disabled = false;
  }

  create.cancel.addEventListener("click", () => {
    if (!state.mutationBusy) create.dialog.close();
  });
  create.dialog.addEventListener("close", () => {
    generation += 1;
    create.form.reset();
    say(create.feedback, "");
  });
  create.branch.addEventListener("input", () => create.branch.setCustomValidity(""));

  create.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy || !target) return;
    const branch = create.branch.value.trim();
    if (!branch) {
      create.branch.setCustomValidity("Enter a branch name.");
      create.branch.reportValidity();
      return;
    }
    const base = create.base.value.trim();
    const label = create.label.value.trim();
    const agent = create.agents.value();
    const controls = [create.branch, create.base, create.label, create.agentField, create.cancel, create.submit];
    setBusy(controls, true);
    say(create.feedback, agent ? "Creating the worktree and starting the agent…" : "Creating the worktree…");
    try {
      const payload = await api(worktreesPath(target.workspaceId), {
        method: "POST",
        body: { branch, ...(base ? { base } : {}), ...(label ? { label } : {}), ...(agent ? { agent } : {}) },
      });
      lastAgent = agent;
      setBusy(controls, false);
      create.dialog.close();
      adopt(payload);
    } catch (error) {
      setBusy(controls, false);
      say(create.feedback, refusal(error), true);
      // Made, but the agent could not be started: the sidebar shows the new workspace.
      if (error.code === "worktree_pane_missing") void refreshSnapshot();
    }
  });

  // One choice per checkout Herdr can open (not a bare or prunable one): its
  // branch, or "Detached" without one, its folder, and Open when it is
  // already open in a workspace.
  function fillChoices(worktrees) {
    const usable = worktrees.filter((item) => !item.is_bare && !item.is_prunable);
    const first = usable.find((item) => item.is_linked_worktree && !item.open_workspace_id) ?? usable[0];
    pick.list.replaceChildren(...usable.map((item) => {
      const input = createElement("input");
      input.type = "radio";
      input.name = "worktree-choice";
      input.value = item.path;
      input.checked = item === first;
      const label = createElement("label", { className: "worktree-choice" });
      const text = createElement("span", { className: "worktree-choice-text" });
      text.append(
        createElement("span", { className: "worktree-choice-branch", text: item.branch || "Detached" }),
        createElement("span", { className: "worktree-choice-path", text: item.path }),
      );
      label.append(input, text);
      if (item.open_workspace_id) label.append(createElement("span", { className: "ui-badge", text: "Open" }));
      if (!item.is_linked_worktree) label.append(createElement("span", { className: "ui-badge", text: "Main" }));
      return label;
    }));
    return usable.length;
  }

  async function openExisting({ workspaceId, workspaceLabel }) {
    if (state.mutationBusy) return;
    target = { workspaceId, workspaceLabel };
    const opened = ++generation;
    pick.context.textContent = `A checkout of ${workspaceLabel}'s repository, opened as its own workspace.`;
    pick.list.replaceChildren();
    pick.choices.hidden = true;
    pick.submit.disabled = true;
    pick.dialog.showModal();
    const list = await loadList(pick.feedback, opened);
    if (!list || opened !== generation) return;
    if (list.source?.repo_name) pick.context.textContent = `A checkout of ${list.source.repo_name}, opened as its own workspace.`;
    const count = fillChoices(list.worktrees ?? []);
    pick.choices.hidden = count === 0;
    if (!list.worktrees?.some((item) => item.is_linked_worktree)) {
      say(pick.feedback, "This repository has no other worktrees yet. New worktree… makes one.");
    }
    pick.submit.disabled = count === 0;
    pick.list.querySelector("input:checked")?.focus();
  }

  pick.cancel.addEventListener("click", () => {
    if (!state.mutationBusy) pick.dialog.close();
  });
  pick.dialog.addEventListener("close", () => {
    generation += 1;
    pick.list.replaceChildren();
    say(pick.feedback, "");
  });

  pick.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.mutationBusy || !target) return;
    const path = pick.list.querySelector("input:checked")?.value;
    if (!path) {
      say(pick.feedback, "Choose a checkout to open.", true);
      return;
    }
    const controls = [pick.choices, pick.cancel, pick.submit];
    setBusy(controls, true);
    say(pick.feedback, "Opening the worktree…");
    try {
      const payload = await api(worktreesPath(target.workspaceId, "worktrees/open"), { method: "POST", body: { path } });
      setBusy(controls, false);
      pick.dialog.close();
      adopt(payload);
    } catch (error) {
      setBusy(controls, false);
      say(pick.feedback, refusal(error), true);
    }
  });

  // A worktree workspace's checkout deleted and the workspace closed, after a
  // confirm; Git's refusal of a checkout with changes is asked about again
  // before it is forced.
  async function remove({ workspaceId, workspaceLabel, branch }, button) {
    const name = branch ? `${workspaceLabel} (${branch})` : workspaceLabel;
    if (
      state.mutationBusy ||
      !window.confirm(`Remove worktree “${name}”? Its folder is deleted and the workspace closes, stopping its processes. The branch is kept.`)
    ) return;
    setBusy([button], true);
    setFeedback("");
    const post = (force) => api(worktreesPath(workspaceId, "worktree/remove"), {
      method: "POST", body: { confirmed: true, ...(force ? { force: true } : {}) },
    });
    try {
      let payload;
      try {
        payload = await post(false);
      } catch (error) {
        if (error.code !== "dirty_worktree_requires_force") throw error;
        if (!window.confirm(`“${name}” has changes Git has not committed. Remove it anyway? Those changes are lost.`)) return;
        payload = await post(true);
      }
      if (payload.snapshot) adoptMutationSnapshot(payload.snapshot);
      else void refreshSnapshot();
    } catch (error) {
      setFeedback(refusal(error), true);
    } finally {
      setBusy([button], false);
    }
  }

  return { openNew, openExisting, remove };
}
