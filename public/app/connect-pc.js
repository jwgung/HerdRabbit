import { legacyMachinesNotice } from "../ui-model.js?v=1.4.27";
import { array, createElement } from "./dom.js?v=1.4.27";

// The Connect PC dialogs: the one-time notice about Herdr SSH machines and the
// dialog that finds, tests and saves another PC. Nothing here runs until
// createConnectPc is called; app.js calls it where this code used to sit, so
// its listeners are added in the same order as before.
export function createConnectPc({ api, refreshSnapshot, panePreferenceStorage }) {
  // Herdr SSH machines (`herdr machine`) are not shown here any more. Said once
  // per browser: those PCs come back with Connect PC.
  const LEGACY_MACHINES_NOTICE_KEY = "herdr:legacy-machines-notice";
  const legacyMachinesDialog = document.querySelector("#legacy-machines-dialog");
  document.querySelector("#legacy-machines-close").addEventListener("click", () => legacyMachinesDialog.close());
  function showLegacyMachinesNotice(count) {
    let seen = false;
    try { seen = panePreferenceStorage?.getItem(LEGACY_MACHINES_NOTICE_KEY) === "seen"; } catch {}
    const message = legacyMachinesNotice({ count, seen });
    if (!message || legacyMachinesDialog.open) return;
    document.querySelector("#legacy-machines-message").textContent = message;
    try { panePreferenceStorage?.setItem(LEGACY_MACHINES_NOTICE_KEY, "seen"); } catch {}
    legacyMachinesDialog.showModal();
  }

  // Connect PC: another PC running HerdRabbit, reached on its Connect PC port.
  const serversDialog = document.querySelector("#servers-dialog");
  const serverForm = document.querySelector("#server-form");
  const serverFeedback = document.querySelector("#server-feedback");
  let editingServer = null;
  let serverBusy = false;

  // A PC is only worth saving once it has actually answered, so Save stays
  // closed until a test succeeds and reopens only for the settings that passed.
  const serverSubmitButton = serverForm.querySelector('button[type="submit"]');
  let verifiedServerSettings = null;

  function serverFormValues() {
    return Object.fromEntries(new FormData(serverForm));
  }

  function serverFormFingerprint() {
    return JSON.stringify(serverFormValues());
  }

  function syncServerSubmitState() {
    const verified = verifiedServerSettings !== null && verifiedServerSettings === serverFormFingerprint();
    serverSubmitButton.disabled = !verified;
    serverSubmitButton.title = verified ? "" : "Test the connection first";
  }

  serverForm.addEventListener("input", syncServerSubmitState);
  serverForm.addEventListener("change", syncServerSubmitState);

  function resetServerForm(profile = null) {
    editingServer = profile?.id || null;
    serverForm.reset();
    if (profile) for (const name of ["name", "address"]) {
      serverForm.elements.namedItem(name).value = profile[name] ?? "";
    }
    chosenBlock.hidden = profile === null;
    chosenAddress.textContent = profile?.address ?? "";
    serverFeedback.textContent = "";
    serverFeedback.dataset.error = "false";
    serverSubmitButton.textContent = profile ? "Save changes" : "Save";
    // Switching to another PC drops whatever the last test proved.
    verifiedServerSettings = null;
    syncServerSubmitState();
  }

  async function serverAction(action) {
    if (serverBusy) return;
    serverBusy = true;
    serversDialog.querySelectorAll("button, input").forEach((element) => { element.disabled = true; });
    serverFeedback.textContent = "Connecting…";
    serverFeedback.dataset.error = "false";
    try { await action(); }
    catch (error) { serverFeedback.textContent = error.message; serverFeedback.dataset.error = "true"; }
    finally {
      serverBusy = false;
      serversDialog.querySelectorAll("button, input").forEach((element) => { element.disabled = false; });
      // The blanket re-enable above would otherwise hand Save back untested.
      syncServerSubmitState();
      for (const row of candidateList.querySelectorAll(".server-candidate")) row.disabled = row.dataset.state !== "ready";
    }
  }

  // Opened from Settings → PCs and from this machine's row menu in the sidebar.
  function openConnectPc() {
    resetServerForm();
    serversDialog.showModal();
    // PCs already added are managed from their sidebar rows; here the list
    // marks them as added.
    serverFeedback.textContent = "";
    void lookForServers();
  }

  const candidateList = document.querySelector("#server-candidates");
  const setupHint = document.querySelector("#server-setup-hint");
  const restSummary = document.querySelector("#server-rest");
  const chosenBlock = document.querySelector("#server-chosen");
  const chosenAddress = document.querySelector("#server-chosen-address");
  const manualAddress = document.querySelector("#server-manual-address");

  // The address comes from the tailnet (or is typed below), so what is left to
  // decide is what to call the PC here.
  function chooseCandidate(candidate, { fromList = true } = {}) {
    serverForm.elements.namedItem("name").value = candidate?.name ?? "";
    serverForm.elements.namedItem("address").value = candidate?.address ?? "";
    chosenBlock.hidden = candidate === null;
    chosenAddress.textContent = candidate ? candidate.address : "";
    for (const row of candidateList.querySelectorAll(".server-candidate")) {
      row.classList.toggle("is-chosen", fromList && row.dataset.address === candidate?.address);
    }
    if (fromList) manualAddress.value = "";
    syncServerSubmitState();
    if (candidate) serverFeedback.textContent = "Test it to save.";
  }

  manualAddress.addEventListener("input", () => {
    const typed = manualAddress.value.trim();
    if (!typed) { chooseCandidate(null, { fromList: false }); return; }
    let name = typed;
    try { name = new URL(typed).hostname || typed; } catch { /* the test says what is wrong with it */ }
    const current = serverForm.elements.namedItem("name").value;
    chooseCandidate({ name: current || name, address: typed }, { fromList: false });
  });

  const CANDIDATE_LABELS = {
    ready: "Ready",
    added: "Added",
    refused: "Does not allow this PC",
    incompatible: "Other protocol",
    absent: "No Connect PC port",
    offline: "Offline",
  };

  const CANDIDATE_ORDER = ["ready", "refused", "incompatible", "added"];
  const NOTHING_TO_DO = new Set(["absent", "offline"]);

  function candidateRow(candidate) {
    const row = createElement("button", { className: `server-candidate is-${candidate.state}` });
    row.type = "button";
    // Only a ready PC can be picked; the rest are shown so the reason is visible.
    row.disabled = candidate.state !== "ready";
    row.dataset.state = candidate.state;
    row.dataset.address = candidate.address;
    row.title = candidate.reason || candidate.address;
    const dot = createElement("span", { className: "server-candidate-dot" });
    dot.setAttribute("aria-hidden", "true");
    const identity = createElement("span", { className: "server-candidate-identity" });
    let where = candidate.address;
    try {
      const url = new URL(candidate.address);
      where = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    } catch { /* an address we cannot parse is shown as it came */ }
    // A different app version connects; it is only said, for the person to know.
    if (candidate.version) where = `${where} · HerdRabbit ${candidate.version}`;
    identity.append(
      createElement("strong", { text: candidate.name }),
      createElement("small", { text: where }),
    );
    row.append(dot, identity, createElement("small", {
      className: "server-candidate-state",
      text: CANDIDATE_LABELS[candidate.state] || candidate.state,
    }));
    row.addEventListener("click", () => chooseCandidate(candidate));
    return row;
  }

  function renderCandidates(found) {
    candidateList.replaceChildren();
    restSummary.textContent = "";
    if (!found.available) {
      setupHint.textContent = "Tailscale is not running, so PCs cannot be listed. Enter an address below instead.";
      return;
    }
    setupHint.textContent = found.self?.address
      ? `New PC? Install HerdRabbit there, open its Connect PC port, and allow ${found.self.address}.`
      : "";
    const candidates = array(found.candidates);
    if (candidates.length === 0) {
      candidateList.append(createElement("p", { className: "dialog-feedback", text: "No other PCs here." }));
      return;
    }
    const ordered = [...candidates].sort((first, second) =>
      CANDIDATE_ORDER.indexOf(first.state) - CANDIDATE_ORDER.indexOf(second.state));
    const actionable = ordered.filter((candidate) => !NOTHING_TO_DO.has(candidate.state));
    const rest = ordered.filter((candidate) => NOTHING_TO_DO.has(candidate.state));
    for (const candidate of actionable) candidateList.append(candidateRow(candidate));
    if (actionable.length === 0) {
      candidateList.append(createElement("p", { className: "dialog-feedback", text: "Nothing ready to connect yet." }));
    }
    restSummary.textContent = rest.length === 0
      ? ""
      : `${rest.length} other ${rest.length === 1 ? "PC" : "PCs"} with nothing to connect to.`;
  }

  // Only the latest look is drawn: an earlier one that answers late (a Refresh
  // pressed while it ran) does not overwrite it.
  let serverLook = 0;

  async function lookForServers() {
    const look = ++serverLook;
    candidateList.replaceChildren(createElement("p", { className: "dialog-feedback", text: "Looking…" }));
    setupHint.textContent = "";
    try {
      const found = await api("/api/servers/discover", { method: "POST", body: {} });
      if (look === serverLook) renderCandidates(found);
    } catch (error) {
      if (look !== serverLook) return;
      candidateList.replaceChildren();
      setupHint.textContent = error.message;
    }
  }

  document.querySelector("#server-refresh").addEventListener("click", () => { void lookForServers(); });
  document.querySelector("#server-close").addEventListener("click", () => { if (!serverBusy) serversDialog.close(); });
  serversDialog.addEventListener("cancel", (event) => { if (serverBusy) event.preventDefault(); });
  document.querySelector("#server-test").addEventListener("click", () => {
    if (!serverForm.elements.namedItem("address").value) {
      serverFeedback.textContent = "Pick a PC, or enter its Connect PC address.";
      serverFeedback.dataset.error = "true";
      return;
    }
    if (!serverForm.reportValidity()) return;
    const profile = serverFormValues();
    const tested = serverFormFingerprint();
    void serverAction(async () => {
      const result = await api("/api/servers/test", { method: "POST", body: profile });
      verifiedServerSettings = tested;
      syncServerSubmitState();
      const reached = result.version ? `Connected to HerdRabbit ${result.version}.` : "Connected.";
      serverFeedback.textContent = `${reached} ${result.sessions} sessions, ${result.panes} panes. You can save now.`;
    });
  });
  serverForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (serverSubmitButton.disabled) return;
    const profile = serverFormValues();
    void serverAction(async () => {
      await api(editingServer ? `/api/servers/${editingServer}` : "/api/servers", {
        method: editingServer ? "PUT" : "POST", body: profile,
      });
      resetServerForm();
      await refreshSnapshot();
      void lookForServers();
      serverFeedback.textContent = "Saved. Connection status appears in the sidebar.";
    });
  });

  return { showLegacyMachinesNotice, openConnectPc };
}
