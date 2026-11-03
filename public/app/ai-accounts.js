import {
  aiAccountNotice,
  aiAccountsToSave,
  aiLoginSessionId,
  aiRestartHint,
  isAiLoginWorkspace,
  sortAiAccounts,
} from "../ui-model.js?v=1.4.23";
import { array, createElement } from "./dom.js?v=1.4.23";

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
  const aiAccounts = { server: null, busy: false, highlight: null };
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

  function renderAiAccounts(clis) {
    aiAccountsList.replaceChildren();
    for (const cli of clis) {
      const section = createElement("section", { className: "ai-cli" });
      section.append(createElement("h3", { text: cli.label }));
      if (cli.reason) {
        const note = createElement("p", { className: "dialog-feedback", text: cli.reason });
        note.dataset.error = String(!cli.supported);
        section.append(note);
      }
      const rows = createElement("ul", { className: "ai-account-rows" });
      const accounts = array(cli.accounts);
      // Saved on open, so this only shows when saving was not possible.
      if (cli.current && !accounts.some((account) => account.active)) accounts.unshift(cli.current);
      for (const account of sortAiAccounts(accounts)) rows.append(aiAccountRow(cli, account));
      if (cli.supported) {
        const add = createElement("li", { className: "ai-account-add-row" });
        add.append(aiButton("+ Add account", () => void aiAccountsAction(() => startAiLogin(cli)), "ai-account-add"));
        rows.append(add);
      }
      if (rows.children.length > 0) section.append(rows);
      aiAccountsList.append(section);
    }
  }

  async function loadAiAccounts() {
    const server = aiAccounts.server;
    const list = () => api(`/api/ai-accounts?server=${encodeURIComponent(server.id)}`);
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
    renderAiAccounts(array(payload.clis));
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
    if (!herdrSessionId) throw new Error(`${server.name} has no running Herdr session to sign in from.`);
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
