import {
  aiAccountNotice,
  aiAccountTabLabel,
  aiAccountTabs,
  aiAccountsFirstTab,
  aiAccountsListed,
  aiAccountsToSave,
  aiLoginSessionId,
  aiRestartHint,
  isAiLoginWorkspace,
  readAiAccountsTab,
  sortAiAccounts,
  writeAiAccountsTab,
} from "../ui-model.js?v=1.4.31";
import { array, createElement } from "./dom.js?v=1.4.31";

// What the sign-in wait says beyond "waiting", for a CLI that needs more.
const AI_LOGIN_HINTS = Object.freeze({
  codex: " Device code sign-in must be on in ChatGPT settings.",
  agy: " Antigravity signs in on its first run: follow its steps there.",
  kiro: " For your organization, have its start URL and region ready.",
});

// The AI accounts dialog and the sign-ins it waits on. Calling createAiAccounts
// looks up the dialog and adds its listeners; nothing happens when this file is
// only imported.
export function createAiAccounts({
  state,
  api,
  snapshotRecords,
  sidebarActionMenu,
  agentMark,
  setFeedback,
  adoptMutationSnapshot,
  closeMobileSidebar,
}) {
  // AI accounts. The server says whose account each saved sign-in is and never
  // hands over a credential; this dialog only asks it to save, sign in, switch
  // or remove.
  const aiAccountsDialog = document.querySelector("#ai-accounts-dialog");
  const aiAccountsList = document.querySelector("#ai-accounts-list");
  const aiAccountsFeedback = document.querySelector("#ai-accounts-feedback");
  const aiAccountsLogin = document.querySelector("#ai-accounts-login");
  // highlight names the account a sign-in just saved, marked until the dialog closes.
  // tab is the CLI whose list is shown; it stays while the list is reloaded.
  const aiAccounts = { server: null, busy: false, highlight: null, tab: null };
  // A sign-in outlives the dialog: it closes so the terminal can be used. The
  // sign-in directory gains its credential files the moment the CLI is signed in,
  // and finishing is what checks for them, so asking every few seconds saves the
  // account without anyone pressing anything.
  const pendingAiLogins = new Map();
  // A list fetched a moment before a sign-in was saved still names it; these are
  // never taken up again from such a list.
  const finishedAiLogins = new Set();
  const AI_LOGIN_CHECK_MS = 3_000;
  const AI_LOGIN_GIVE_UP_MS = 20 * 60_000;

  function setAiAccountsFeedback(text, isError = false) {
    aiAccountsFeedback.textContent = text;
    aiAccountsFeedback.dataset.error = String(isError);
  }

  async function aiAccountsAction(work) {
    if (aiAccounts.busy) return;
    aiAccounts.busy = true;
    aiAccountsDialog.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      await work();
    } catch (error) {
      setAiAccountsFeedback(error.message, true);
    } finally {
      aiAccounts.busy = false;
      aiAccountsDialog.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  }

  function aiButton(text, onClick, className = "secondary-button") {
    const button = createElement("button", { className, text });
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  // One row per account: its email, and what can be done with it. In use needs
  // nothing; any other account has one menu holding Switch and Remove.
  function aiAccountRow(cli, account) {
    const added = Boolean(account.id) && account.id === aiAccounts.highlight;
    const row = createElement("li", { className: `ai-account-row${account.active ? " is-active" : ""}${added ? " is-new" : ""}` });
    const identity = createElement("div", { className: "ai-account-identity" });
    identity.append(createElement("strong", { text: account.email || "Unknown account" }));
    if (added) identity.append(createElement("small", { className: "is-new", text: "Just added" }));
    const notice = aiAccountNotice(account);
    if (notice) identity.append(createElement("small", { className: "is-expiring", text: notice }));
    const box = createElement("div", { className: "ai-account-actions" });
    if (account.active) {
      box.append(createElement("span", { className: "ai-account-state", text: "In use" }));
    } else if (cli.supported && account.id) {
      box.append(sidebarActionMenu({
        id: `ai-account-${account.id}`,
        label: `Actions for ${account.email || "this account"}`,
        escapesOverflow: true,
        actions: [
          {
            label: "Switch",
            paths: ["M7 7h11l-3-3", "M17 17H6l3 3"],
            onSelect: () => void aiAccountsAction(() => switchAiAccount(cli, account, false)),
          },
          {
            label: "Remove",
            paths: ["M6 6l12 12M18 6 6 18"],
            danger: true,
            onSelect: () => removeAiAccount(cli, account),
          },
        ],
      }));
    }
    row.append(identity, box);
    return row;
  }

  // One tab per CLI, each wearing its program's mark, over the list of the one
  // chosen. A tab is a WAI-ARIA tab: arrow keys, Home and End move between
  // them and choose as they go, and only the chosen one is in the Tab order.
  function renderAiAccounts(clis, installed) {
    const tabs = aiAccountTabs(clis, { installed });
    aiAccountsList.replaceChildren();
    if (tabs.length === 0) {
      aiAccountsList.append(createElement("p", { className: "dialog-feedback",
        text: "No AI CLI was found on this machine, and none has an account saved here. Install one there, then open AI accounts again." }));
      return;
    }
    const pending = pendingAiLogins.get(aiAccounts.server.id);
    if (!tabs.some((tab) => tab.id === aiAccounts.tab)) {
      aiAccounts.tab = aiAccountsFirstTab(tabs, {
        highlight: aiAccounts.highlight,
        signingIn: pending?.cli,
        remembered: readAiAccountsTab(localStorageOrNull()),
      });
    }
    const tablist = createElement("div", { className: "ai-accounts-tabs" });
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "AI CLIs");
    const buttons = [];
    const panels = [];
    const choose = (id, { focus = false } = {}) => {
      aiAccounts.tab = id;
      buttons.forEach((button, index) => {
        const chosen = tabs[index].id === id;
        button.setAttribute("aria-selected", String(chosen));
        button.tabIndex = chosen ? 0 : -1;
        panels[index].hidden = !chosen;
        if (chosen) {
          if (focus) button.focus();
          button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        }
      });
    };
    for (const tab of tabs) {
      const button = createElement("button", { className: "ai-accounts-tab" });
      button.type = "button";
      button.id = `ai-accounts-tab-${tab.id}`;
      button.dataset.cli = tab.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `ai-accounts-panel-${tab.id}`);
      button.setAttribute("aria-label", aiAccountTabLabel(tab));
      button.append(agentMark(tab.id), createElement("span", { className: "ai-accounts-tab-name", text: tab.label }));
      if (tab.count > 0) button.append(createElement("span", { className: "ui-badge ai-accounts-tab-count", text: String(tab.count) }));
      if (tab.inUse) button.append(createElement("span", { className: "ai-accounts-tab-in-use" }));
      button.addEventListener("click", () => {
        choose(tab.id);
        writeAiAccountsTab(localStorageOrNull(), tab.id);
      });
      buttons.push(button);
      panels.push(aiAccountsPanel(tab));
    }
    tablist.addEventListener("keydown", (event) => {
      const at = buttons.indexOf(event.target);
      if (at < 0) return;
      const last = buttons.length - 1;
      const to = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      choose(tabs[to].id, { focus: true });
      writeAiAccountsTab(localStorageOrNull(), tabs[to].id);
    });
    tablist.append(...buttons);
    aiAccountsList.append(tablist, ...panels);
    choose(aiAccounts.tab);
  }

  // A CLI's tab panel: why it cannot be switched, when it cannot, then its
  // accounts and + Add account.
  function aiAccountsPanel(tab) {
    const { cli } = tab;
    const panel = createElement("section", { className: "ai-cli" });
    panel.id = `ai-accounts-panel-${tab.id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `ai-accounts-tab-${tab.id}`);
    if (cli.reason) {
      const note = createElement("p", { className: "dialog-feedback ai-cli-reason", text: cli.reason });
      note.dataset.error = String(!cli.supported);
      panel.append(note);
    }
    const rows = createElement("ul", { className: "ai-account-rows" });
    // Saved on open, so the live sign-in is only listed apart when saving was not possible.
    for (const account of sortAiAccounts(aiAccountsListed(cli))) rows.append(aiAccountRow(cli, account));
    if (cli.supported) {
      const add = createElement("li", { className: "ai-account-add-row" });
      add.append(aiButton("+ Add account", () => void aiAccountsAction(() => startAiLogin(cli)), "ai-account-add"));
      rows.append(add);
    }
    if (rows.children.length > 0) panel.append(rows);
    else if (!cli.reason) panel.append(createElement("p", { className: "dialog-feedback", text: "No accounts are saved for this CLI." }));
    // Tab from the tab reaches the panel's first control; a panel with none
    // takes the focus itself, so its note can still be reached.
    if (!panel.querySelector("button, summary")) panel.tabIndex = 0;
    return panel;
  }

  function localStorageOrNull() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  // The agents installed on the machine, or null when it cannot say (a PC on
  // an older HerdRabbit, or the question failed), which hides no CLI.
  async function fetchInstalledAgents(server) {
    try {
      const answer = await api(`/api/agents?server=${encodeURIComponent(server.id)}`);
      return answer.supported === false || !Array.isArray(answer.agents) ? null : answer.agents;
    } catch {
      return null;
    }
  }

  async function loadAiAccounts() {
    const server = aiAccounts.server;
    const list = () => api(`/api/ai-accounts?server=${encodeURIComponent(server.id)}`);
    const installed = fetchInstalledAgents(server);
    let payload = await list();
    const unsaved = aiAccountsToSave(array(payload.clis));
    if (unsaved.length > 0) {
      for (const cli of unsaved) {
        await api("/api/ai-accounts/current", { method: "POST", body: { server: server.id, cli } });
      }
      payload = await list();
    }
    settleAiLogins(server, array(payload.clis));
    renderAiLogin();
    renderAiAccounts(array(payload.clis), await installed);
    setAiAccountsFeedback("");
  }

  // The server's list is what is true about sign-ins. A wait it no longer lists
  // was saved or cancelled elsewhere, so it ends here too; one it still lists and
  // this page is not waiting on is taken up.
  function settleAiLogins(server, clis) {
    const open = new Set(clis.flatMap((cli) => array(cli.logins)));
    const pending = pendingAiLogins.get(server.id);
    if (pending && !open.has(pending.loginId)) {
      window.clearInterval(pending.timer);
      pendingAiLogins.delete(server.id);
    }
    adoptAiLogins(server, clis);
  }

  // The server keeps which sign-ins are still open, so a page that reloaded while
  // one was waiting takes the wait back up instead of losing it. The sign-in's
  // project carries the first characters of its id, which is how it is found to
  // be closed again when the account is saved.
  function adoptAiLogins(server, clis) {
    if (pendingAiLogins.has(server.id)) return;
    for (const cli of clis) {
      const loginId = array(cli.logins).find((id) => !finishedAiLogins.has(id));
      if (!loginId) continue;
      const tag = `(${loginId.slice(6, 14)})`;
      const workspace = snapshotRecords().workspaces.find((item) => isAiLoginWorkspace(item) &&
        (item.server_id ?? "local") === server.id && String(item.label).endsWith(tag));
      const login = { cli: cli.id, label: cli.label, loginId, workspaceId: workspace?.workspace_id, timer: null };
      pendingAiLogins.set(server.id, login);
      watchAiLogin(server, login);
      return;
    }
  }

  // On a fresh page, an open sign-in project means a wait was cut short by the
  // reload; its server is asked which sign-ins are still open.
  async function resumeAiLogins() {
    const serverIds = new Set(snapshotRecords().workspaces.filter(isAiLoginWorkspace)
      .map((workspace) => workspace.server_id ?? "local"));
    for (const serverId of serverIds) {
      if (pendingAiLogins.has(serverId)) continue;
      const server = snapshotRecords().servers.find((item) => item.id === serverId) ?? { id: serverId, name: serverId };
      try {
        const payload = await api(`/api/ai-accounts?server=${encodeURIComponent(serverId)}`);
        adoptAiLogins(server, array(payload.clis));
      } catch {
        // Opening AI accounts for that server asks again.
      }
    }
  }

  function renderAiLogin() {
    const login = aiAccounts.server ? pendingAiLogins.get(aiAccounts.server.id) : null;
    aiAccountsLogin.hidden = !login;
    if (!login) return;
    const hint = AI_LOGIN_HINTS[login.cli] ?? "";
    document.querySelector("#ai-accounts-login-text").textContent =
      `Waiting for ${login.label} to be signed in in the “AI login” terminal. It is saved as soon as you are.${hint}`;
  }

  // Asks the server to finish the sign-in until it can. "Not yet" is the answer
  // while the terminal is still waiting; any other refusal ends the wait.
  function watchAiLogin(server, login) {
    const startedAt = Date.now();
    let checking = false;
    const stop = () => {
      window.clearInterval(login.timer);
      if (pendingAiLogins.get(server.id) === login) pendingAiLogins.delete(server.id);
      if (aiAccounts.server?.id === server.id) renderAiLogin();
    };
    login.timer = window.setInterval(() => {
      if (checking) return;
      if (Date.now() - startedAt > AI_LOGIN_GIVE_UP_MS) {
        stop();
        setFeedback(`Stopped waiting for the ${login.label} sign-in. Add the account again to retry.`, true);
        return;
      }
      checking = true;
      void api(`/api/ai-accounts/logins/${login.loginId}/finish`, {
        method: "POST",
        body: { server: server.id, cli: login.cli, workspaceId: login.workspaceId },
      }).then(async (payload) => {
        finishedAiLogins.add(login.loginId);
        stop();
        if (payload.snapshot) adoptMutationSnapshot(payload.snapshot);
        const saved = `Saved ${payload.account.email} for ${login.label}.`;
        setFeedback(saved);
        // The sign-in's terminal has just closed under the person using it, so the
        // account list comes back to show what was saved -- unless something else
        // is open over the page, which it would push aside.
        const elsewhere = [...document.querySelectorAll("dialog[open]")].some((dialog) => dialog !== aiAccountsDialog) ||
          (aiAccountsDialog.open && aiAccounts.server?.id !== server.id);
        if (elsewhere) return;
        aiAccounts.highlight = payload.account.id;
        aiAccounts.tab = null;
        if (aiAccountsDialog.open) await aiAccountsAction(loadAiAccounts);
        else await showAiAccounts(snapshotRecords().servers.find((item) => item.id === server.id) ?? server);
        if (aiAccountsFeedback.dataset.error !== "true") setAiAccountsFeedback(saved);
      }, (error) => {
        if (error.code === "login_incomplete") return;
        stop();
        if (error.code !== "login_not_found") setFeedback(error.message, true);
      }).finally(() => { checking = false; });
    }, AI_LOGIN_CHECK_MS);
  }

  function showAiAccounts(server) {
    aiAccounts.server = server;
    aiAccounts.tab = null;
    aiAccountsList.replaceChildren();
    document.querySelector("#ai-accounts-title").textContent = `AI accounts · ${server.name}`;
    renderAiLogin();
    setAiAccountsFeedback("Loading accounts…");
    aiAccountsDialog.showModal();
    return aiAccountsAction(loadAiAccounts);
  }

  async function startAiLogin(cli) {
    const server = aiAccounts.server;
    if (pendingAiLogins.has(server.id)) {
      renderAiLogin();
      throw new Error("A sign-in is already open. Finish it in its terminal or cancel it.");
    }
    const herdrSessionId = aiLoginSessionId(server.id, snapshotRecords().herdrSessions);
    if (!herdrSessionId) throw new Error(`${server.name} has no running session to sign in from.`);
    const payload = await api("/api/ai-accounts/logins", {
      method: "POST",
      body: { server: server.id, cli: cli.id, herdrSessionId },
    });
    const login = { cli: cli.id, label: cli.label, loginId: payload.loginId, workspaceId: payload.workspaceId, timer: null };
    pendingAiLogins.set(server.id, login);
    watchAiLogin(server, login);
    adoptMutationSnapshot(payload.snapshot || state.snapshot, payload.paneId);
    aiAccountsDialog.close();
    closeMobileSidebar();
    setFeedback(`Sign in to ${cli.label} in this terminal. The account is saved as soon as you are signed in.`);
  }

  async function cancelAiLogin() {
    const server = aiAccounts.server;
    const login = pendingAiLogins.get(server.id);
    if (!login) return;
    window.clearInterval(login.timer);
    pendingAiLogins.delete(server.id);
    renderAiLogin();
    try {
      const payload = await api(`/api/ai-accounts/logins/${login.loginId}/cancel`, {
        method: "POST",
        body: { server: server.id, cli: login.cli, workspaceId: login.workspaceId },
      });
      if (payload.snapshot) adoptMutationSnapshot(payload.snapshot);
    } catch (error) {
      if (error.code !== "login_not_found") throw error;
    }
    await loadAiAccounts();
    setAiAccountsFeedback("Sign-in cancelled.");
  }

  async function switchAiAccount(cli, account, confirmRunning = false) {
    try {
      await api("/api/ai-accounts/switch", {
        method: "POST",
        body: { server: aiAccounts.server.id, cli: cli.id, account: account.id, confirmRunning },
      });
    } catch (error) {
      if (error.code !== "agents_running" || confirmRunning) throw error;
      // Asked apart from the list, like every other confirmation here, so the
      // warning cannot be read past on the way to the next account.
      const panes = array(error.details?.panes).map((pane) => `• ${pane.label || pane.paneId}`);
      if (!window.confirm([
        `${cli.label} is running on ${aiAccounts.server.name}. These keep the old account until restarted:`,
        ...panes,
        "",
        "Switch anyway?",
      ].join("\n"))) {
        setAiAccountsFeedback("");
        return;
      }
      await switchAiAccount(cli, account, true);
      return;
    }
    await loadAiAccounts();
    setAiAccountsFeedback(`Now using ${account.email}. Restart with ${aiRestartHint(cli.id)}.`);
  }

  function removeAiAccount(cli, account) {
    if (!window.confirm(`Remove ${account.email} from ${cli.label} on ${aiAccounts.server.name}? Using it here again needs a new sign-in.`)) return;
    void aiAccountsAction(async () => {
      await api("/api/ai-accounts/remove", {
        method: "POST",
        body: { server: aiAccounts.server.id, cli: cli.id, account: account.id },
      });
      await loadAiAccounts();
      setAiAccountsFeedback(`Removed ${account.email}.`);
    });
  }

  document.querySelector("#ai-accounts-close").addEventListener("click", () => aiAccountsDialog.close());
  aiAccountsDialog.addEventListener("close", () => { aiAccounts.highlight = null; });
  document.querySelector("#ai-accounts-login-cancel")
    .addEventListener("click", () => void aiAccountsAction(cancelAiLogin));

  return { showAiAccounts, resumeAiLogins };
}
