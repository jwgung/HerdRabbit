import { herdrVersionText, paneServerId, passkeyDetails } from "../ui-model.js?v=1.4.42";
import { clearLaunchToken, writeLaunchToken } from "../launch-session.js?v=1.4.42";
import { array, createElement } from "./dom.js?v=1.4.42";

// The machine details dialog, the signed-in devices list and the passkeys
// dialog. Calling createAccountDialogs looks up the dialogs and adds their
// listeners; nothing happens when this file is only imported.
export function createAccountDialogs({
  state,
  api,
  snapshotRecords,
  showLogin,
  renderLoginMethods,
  passkeyErrorMessage,
  supportsPasskeys,
  enteredPassword,
  registerPasskey,
  launchSessionStorage,
  composerDrafts,
  draftBlocked,
  clearComposer,
  // The composer's draft pane and save timer stay app.js's own variables.
  getDraftSaveTimer,
  setDraftSaveTimer,
  setDraftPaneId,
}) {
  const serverDetailsDialog = document.querySelector("#server-details-dialog");
  document.querySelector("#server-details-close")
    .addEventListener("click", () => serverDetailsDialog.close());

  const SERVER_KINDS = { local: "This PC", link: "Connect PC" };

  // A connected PC on another app version still connects; Details says so. Its
  // link protocol is what decides, so that is shown beside this PC's.
  function linkDetailRows(server) {
    const here = snapshotRecords().servers.find((item) => item.id === "local");
    if (server.id === "local") {
      return [
        ["Connection protocol", server.link_protocol == null ? "Unknown" : String(server.link_protocol)],
        ["Connect PC port", state.connectPc
          ? `${state.connectPc.address} (${state.connectPc.allowed > 0 ? `${state.connectPc.allowed} allowed` : "nobody allowed yet"})`
          : "Closed"],
      ];
    }
    const protocol = server.link_protocol == null ? "Unknown" : String(server.link_protocol);
    const differs = here?.link_protocol != null && server.link_protocol != null && here.link_protocol !== server.link_protocol;
    return [
      ["Address", server.address || "Unknown"],
      ["Connection protocol", differs ? `${protocol} (this PC: ${here.link_protocol})` : protocol],
    ];
  }

  function herdRabbitVersionText(server) {
    if (!server.version) return "Unknown";
    const here = snapshotRecords().servers.find((item) => item.id === "local");
    return server.id !== "local" && here?.version && here.version !== server.version
      ? `${server.version} (this PC: ${here.version})`
      : server.version;
  }

  function showServerDetails(server) {
    const sessions = snapshotRecords().herdrSessions.filter((item) => item.server_id === server.id);
    // A pane record carries no server of its own; its id is where the server is.
    const panes = snapshotRecords().panes.filter((item) => paneServerId(item.pane_id) === server.id);
    // A machine is shown by the name Tailscale knows it by, not by an address.
    const rows = [
      ...(server.machine ? [["Machine", server.machine]] : []),
      ["Kind", server.id === "local" ? SERVER_KINDS.local : SERVER_KINDS.link],
      ["HerdRabbit", herdRabbitVersionText(server)],
      ...linkDetailRows(server),
      ["Herdr", herdrVersionText(server)],
      ["Status", server.available ? "Connected" : server.status || "Offline"],
      ["Sessions", String(sessions.length)],
      ["Panes", String(panes.length)],
    ];
    const list = document.querySelector("#server-details");
    list.replaceChildren();
    for (const [term, value] of rows) {
      list.append(createElement("dt", { text: term }), createElement("dd", { text: value }));
    }
    document.querySelector("#server-details-title").textContent = server.name;
    serverDetailsDialog.showModal();
  }

  // Signed-in devices. Each is named by its browser and dates; the list never
  // carries a token. Signing out needs no password: it only takes access away.
  const sessionsDialog = document.querySelector("#sessions-dialog");
  const sessionsList = document.querySelector("#sessions-list");
  const sessionsFeedback = document.querySelector("#sessions-feedback");
  document.querySelector("#sessions-close").addEventListener("click", () => sessionsDialog.close());
  // Even when the server cannot be told, this window forgets its launch token,
  // so it is signed out here either way.
  async function signOutThisDevice() {
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
    sessionsDialog.close();
    signedOut();
  }

  // A sign-in from before the list existed has no row to sign out from, so the
  // dialog offers this device on its own.
  const sessionsEndThis = document.querySelector("#sessions-end-this");
  sessionsEndThis.addEventListener("click", () => void sessionsAction(signOutThisDevice));

  document.querySelector("#sessions-end-all").addEventListener("click", () => {
    if (!window.confirm("Sign out every browser, this one included?")) return;
    void sessionsAction(async () => {
      await api("/api/auth/sessions/end-all", { method: "POST", body: {} });
      sessionsDialog.close();
      signedOut();
    });
  });

  function setSessionsFeedback(text, isError = false) {
    sessionsFeedback.textContent = text;
    sessionsFeedback.dataset.error = String(isError);
  }

  async function sessionsAction(work) {
    if (state.sessionsBusy) return;
    state.sessionsBusy = true;
    const controls = sessionsDialog.querySelectorAll("button");
    controls.forEach((control) => { control.disabled = true; });
    try {
      await work();
    } catch (error) {
      if (error.code !== "authentication_required") setSessionsFeedback(error.message, true);
    } finally {
      state.sessionsBusy = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  }

  function sessionRow(session) {
    const row = createElement("li", { className: "passkey-row" });
    const identity = createElement("div", { className: "passkey-identity" });
    identity.append(createElement("strong", { text: session.current ? `${session.agent} (this device)` : session.agent }));
    identity.append(createElement("small", {
      text: `Signed in ${passkeyDate(session.createdAt * 1000)} · last used ${passkeyDate(session.lastUsedAt * 1000)}`,
    }));
    const end = createElement("button", { className: "secondary-button passkey-remove", text: "Sign out" });
    end.type = "button";
    end.addEventListener("click", () => void sessionsAction(async () => {
      if (session.current) {
        await signOutThisDevice();
        return;
      }
      await api("/api/auth/sessions/end", { method: "POST", body: { id: session.id } });
      setSessionsFeedback(`Signed out ${session.agent}.`);
      await loadSessions();
    }));
    row.append(identity, end);
    return row;
  }

  async function loadSessions() {
    let sessions;
    try {
      ({ sessions } = await api("/api/auth/sessions"));
    } catch (error) {
      // Without the list there is no row to sign out from; this device still can.
      sessionsEndThis.hidden = false;
      throw error;
    }
    const items = array(sessions);
    sessionsEndThis.hidden = items.some((session) => session?.current);
    sessionsList.replaceChildren(...(items.length > 0
      ? items.map(sessionRow)
      : [createElement("li", { className: "passkey-empty", text: "Only sign-ins made since this list started are shown." })]));
  }

  async function showSessions() {
    setSessionsFeedback("");
    sessionsList.replaceChildren();
    sessionsEndThis.hidden = true;
    sessionsDialog.showModal();
    await sessionsAction(loadSessions);
  }

  function signedOut() {
    state.launchToken = clearLaunchToken(launchSessionStorage);
    showLogin();
  }

  // Unsent text belongs to the sign-in it was typed under: whichever way that
  // ends (signing out, an expired session, a revoked device), it goes with it,
  // so the next person to sign in on this browser does not get it back.
  function forgetComposerDrafts() {
    window.clearTimeout(getDraftSaveTimer());
    setDraftSaveTimer(null);
    composerDrafts.clearAll();
    draftBlocked.clear();
    clearComposer();
    setDraftPaneId(null);
  }

  // Passkeys. The server lists each one by name, dates and a handle; credential
  // IDs and public keys never leave it.
  const passkeysDialog = document.querySelector("#passkeys-dialog");
  const passkeysList = document.querySelector("#passkeys-list");
  const passkeysFeedback = document.querySelector("#passkeys-feedback");
  // Adding or removing asks for the password in a window of its own, opened by
  // the button that needs it, so no password field sits under the list.
  const passkeyPasswordDialog = document.querySelector("#passkey-password-dialog");
  const passkeyPasswordForm = document.querySelector("#passkey-password-form");
  const passkeyPasswordInput = document.querySelector("#passkey-password-input");
  const passkeyPasswordFeedback = document.querySelector("#passkey-password-feedback");
  const passkeyPasswordConfirm = document.querySelector("#passkey-password-confirm");
  let passkeyPasswordRun = null;

  function setPasskeysFeedback(text, isError = false) {
    passkeysFeedback.textContent = text;
    passkeysFeedback.dataset.error = String(isError);
  }

  function passkeyDate(value) {
    return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  async function passkeysAction(work) {
    if (state.passkeyBusy) return;
    state.passkeyBusy = true;
    const controls = passkeysDialog.querySelectorAll("button, input");
    controls.forEach((control) => { control.disabled = true; });
    try {
      await work();
    } catch (error) {
      setPasskeysFeedback(passkeyErrorMessage(error), true);
    } finally {
      state.passkeyBusy = false;
      controls.forEach((control) => { control.disabled = false; });
      renderLoginMethods();
    }
  }


  function passkeyRow(passkey) {
    const row = createElement("li", { className: "passkey-row" });
    const identity = createElement("div", { className: "passkey-identity" });
    identity.append(createElement("strong", { text: passkey.label || "Passkey" }));
    const details = passkeyDetails(passkey, passkeyDate);
    if (details) identity.append(createElement("small", { text: details }));
    const remove = createElement("button", { className: "secondary-button passkey-remove", text: "Remove" });
    remove.type = "button";
    remove.addEventListener("click", () => removePasskey(passkey));
    row.append(identity, remove);
    return row;
  }

  async function loadPasskeys() {
    const { passkeys } = await api("/api/auth/passkeys");
    const items = array(passkeys);
    state.passkeyAvailable = items.length > 0;
    passkeysList.replaceChildren(...(items.length > 0
      ? items.map(passkeyRow)
      : [createElement("li", { className: "passkey-empty", text: "No passkeys yet. Sign-in uses the password only." })]));
  }

  async function showPasskeys() {
    document.querySelector("#passkeys-add").hidden = !supportsPasskeys();
    setPasskeysFeedback("");
    passkeysList.replaceChildren();
    passkeysDialog.showModal();
    await passkeysAction(loadPasskeys);
  }

  // The window stays open while the change runs, so a wrong password is said
  // there and can be typed again; it closes once the change is done. Reloading
  // the list comes after that, so a failed reload never asks to redo a change
  // that already happened.
  function askPasskeyPassword({ title, text, confirmLabel, run, done }) {
    document.querySelector("#passkey-password-title").textContent = title;
    document.querySelector("#passkey-password-text").textContent = text;
    passkeyPasswordConfirm.textContent = confirmLabel;
    passkeyPasswordInput.value = "";
    passkeyPasswordFeedback.textContent = "";
    passkeyPasswordFeedback.dataset.error = "false";
    passkeyPasswordRun = { run, done };
    passkeyPasswordDialog.showModal();
  }

  passkeyPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.passkeyBusy || !passkeyPasswordRun) return;
    const password = enteredPassword(passkeyPasswordInput, passkeyPasswordFeedback);
    if (!password) return;
    state.passkeyBusy = true;
    const controls = [...passkeyPasswordDialog.querySelectorAll("button, input"), ...passkeysDialog.querySelectorAll("button")];
    controls.forEach((control) => { control.disabled = true; });
    passkeyPasswordFeedback.dataset.error = "false";
    const { run, done } = passkeyPasswordRun;
    let changed = false;
    try {
      await run(password);
      changed = true;
      passkeyPasswordDialog.close();
    } catch (error) {
      passkeyPasswordFeedback.textContent = passkeyErrorMessage(error);
      passkeyPasswordFeedback.dataset.error = "true";
    } finally {
      state.passkeyBusy = false;
      controls.forEach((control) => { control.disabled = false; });
      renderLoginMethods();
      if (passkeyPasswordDialog.open) passkeyPasswordInput.select();
    }
    if (changed) void passkeysAction(done);
  });
  document.querySelector("#passkey-password-cancel").addEventListener("click", () => {
    if (!state.passkeyBusy) passkeyPasswordDialog.close();
  });
  passkeyPasswordDialog.addEventListener("cancel", (event) => { if (state.passkeyBusy) event.preventDefault(); });
  passkeyPasswordDialog.addEventListener("close", () => {
    passkeyPasswordInput.value = "";
    passkeyPasswordRun = null;
  });

  function removePasskey(passkey) {
    const name = passkey.label || "this passkey";
    askPasskeyPassword({
      title: "Remove passkey",
      text: `${name} can no longer sign in to this HerdRabbit, and every other signed-in device has to sign in again.`,
      confirmLabel: "Remove",
      run: async (password) => {
        const result = await api("/api/auth/passkeys/remove", {
          method: "POST",
          body: { handle: passkey.handle, password },
        });
        // Removing signed every session out; the server sent this window a new one.
        state.launchToken = writeLaunchToken(launchSessionStorage, result.launchToken);
      },
      done: async () => {
        await loadPasskeys();
        setPasskeysFeedback(`Removed ${name}.`);
      },
    });
  }

  document.querySelector("#passkeys-add").addEventListener("click", () => {
    if (!supportsPasskeys()) return;
    askPasskeyPassword({
      title: "Add passkey",
      text: "After the password, follow the prompt on your device.",
      confirmLabel: "Continue",
      run: async (password) => {
        passkeyPasswordFeedback.textContent = "Follow the prompt on your device…";
        await registerPasskey(password);
      },
      done: async () => {
        await loadPasskeys();
        setPasskeysFeedback("Passkey added.");
      },
    });
  });
  document.querySelector("#passkeys-close").addEventListener("click", () => {
    if (!state.passkeyBusy) passkeysDialog.close();
  });
  // Escape would close the dialog under a ceremony still running.
  passkeysDialog.addEventListener("cancel", (event) => { if (state.passkeyBusy) event.preventDefault(); });

  return { showServerDetails, showSessions, showPasskeys, forgetComposerDrafts };
}
