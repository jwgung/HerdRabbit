import { createElement } from "./dom.js?v=1.4.29";
import {
  parsePluginSource, pluginMachines, pluginOperationText, pluginSourceText, pluginSourceUrl, validPluginRef,
  updateAllConfirmText, updateAllCount, updateAllPlan, updateAllResultText,
} from "./plugin-model.js?v=1.4.29";
import { createPluginBrowse } from "./plugin-browse.js?v=1.4.29";
import { appVersionText, confirmDetails as appConfirmDetails, herdrRunSummary, runSummary } from "../app-update.js?v=1.4.29";

const POLL_MS = 1_500;

// Settings → Plugins: Herdr's plugins on one machine at a time. The server
// runs Herdr's own commands (src/herdr-plugins.mjs) and says how a change
// goes; this page lists, starts a change and follows it until it ends.
// HerdRabbit's own plugin has no switch or menu: its row shows the version
// About's update check found and an Update… that starts About's update
// (`appUpdates`, the Update window's panel in app-update.js), never
// `herdr plugin update`. Another plugin the server marks `updateAvailable`
// (its repository moved on in Herdr's marketplace) carries a badge, and
// Update all updates each of them, one at a time, then HerdRabbit last.
// Browse lists Herdr's plugin marketplace (plugin-browse.js) and installs
// through the same dialog. Only shown with sign-in on (settings.js decides).
export function createPluginsPage({ api, snapshotRecords, sidebarActionMenu, appUpdates = null }) {
  const machineRow = document.querySelector("#plugins-machine-row");
  const machineSelect = document.querySelector("#plugins-machine");
  const list = document.querySelector("#plugins-list");
  const feedback = document.querySelector("#plugins-feedback");
  const installButton = document.querySelector("#plugins-install");
  const updateAllButton = document.querySelector("#plugins-update-all");
  const viewButtons = [...document.querySelectorAll("[data-plugins-view]")];
  const installedView = document.querySelector("#plugins-installed-view");
  const browseView = document.querySelector("#plugins-browse-view");

  const dialog = document.querySelector("#plugin-install-dialog");
  const form = document.querySelector("#plugin-install-form");
  const sourceInput = document.querySelector("#plugin-install-source");
  const refInput = document.querySelector("#plugin-install-ref");
  const sourceStep = document.querySelector("#plugin-install-source-step");
  const confirmStep = document.querySelector("#plugin-install-confirm-step");
  const repoLine = document.querySelector("#plugin-install-repo");
  const warning = document.querySelector("#plugin-install-warning");
  const confirmText = document.querySelector("#plugin-install-confirm-text");
  const confirmRepo = document.querySelector("#plugin-install-confirm-repo");
  const installFeedback = document.querySelector("#plugin-install-feedback");
  const cancelButton = document.querySelector("#plugin-install-cancel");
  const submitButton = document.querySelector("#plugin-install-submit");

  const page = {
    visible: false, server: "local", machines: [], plugins: [], operation: null,
    loaded: false, loading: false, sending: false, timer: null, generation: 0,
    pending: null, view: "installed", opener: null,
    // Update all while it runs: { server }; and its last word, shown until
    // something else starts.
    updatingAll: null, allResult: null, waiters: [], appBusy: false,
  };

  const browse = createPluginBrowse({
    api,
    installed: () => ({ plugins: page.plugins, loaded: page.loaded }),
    locked: () => locked(),
    install: (source, opener) => openInstall(source, opener),
  });

  const machineName = (id = page.server) => page.machines.find((item) => item.id === id)?.name ?? "this machine";
  const running = () => page.operation?.state === "running";
  // HerdRabbit's or Herdr's own update on this machine, followed by the
  // Update window's panel. The server refuses plugin changes meanwhile too.
  const appState = () => appUpdates?.state(page.server) ?? null;
  const updateRunning = () => appState()?.busy === true;
  const changing = () => page.sending || running() || updateRunning();
  const locked = () => changing() || !page.loaded || page.updatingAll !== null;
  const appLine = () => appVersionText(appState()?.check, page.plugins.find((item) => item.protected)?.version);
  const plan = () => updateAllPlan(page.plugins, appLine());

  function setFeedback(text, isError = false) {
    feedback.textContent = text;
    feedback.dataset.error = String(isError);
  }

  function setInstallFeedback(text, isError = false) {
    installFeedback.textContent = text;
    installFeedback.dataset.error = String(isError);
  }

  function renderMachines() {
    const machines = pluginMachines(snapshotRecords().servers);
    const same = machines.length === page.machines.length &&
      machines.every((item, index) => item.id === page.machines[index].id && item.name === page.machines[index].name);
    page.machines = machines;
    if (!machines.some((item) => item.id === page.server)) {
      page.server = "local";
      if (page.visible) void load();
    }
    machineRow.hidden = machines.length < 2;
    if (same && machineSelect.childElementCount === machines.length) return;
    machineSelect.replaceChildren(...machines.map((item) => {
      const option = createElement("option", { text: item.name });
      option.value = item.id;
      return option;
    }));
    machineSelect.value = page.server;
  }

  function pluginSwitch(plugin) {
    const button = createElement("button", { className: "plugin-switch" });
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(plugin.enabled));
    button.setAttribute("aria-label", `${plugin.name} on`);
    button.dataset.plugin = plugin.id;
    button.disabled = locked();
    button.append(createElement("span", { className: "plugin-switch-track" }),
      createElement("span", { className: "plugin-switch-text", text: plugin.enabled ? "On" : "Off" }));
    button.addEventListener("click", () => void change(plugin.enabled ? "disable" : "enable", plugin));
    return button;
  }

  function pluginRow(plugin) {
    const row = createElement("li", { className: `plugin-row${plugin.enabled ? "" : " is-off"}` });
    row.dataset.plugin = plugin.id;
    const identity = createElement("div", { className: "plugin-identity" });
    const title = createElement("div", { className: "plugin-title" });
    title.append(createElement("strong", { text: plugin.name }));
    if (plugin.version) title.append(createElement("span", { className: "plugin-version", text: plugin.version }));
    const app = plugin.protected ? appLine() : null;
    if (plugin.protected ? app !== null && appState().check.available === true : plugin.updateAvailable === true) {
      title.append(createElement("span", { className: "ui-badge is-accent plugin-update-badge", text: "Update available" }));
    }
    identity.append(title);
    const sourceText = pluginSourceText(plugin);
    const url = pluginSourceUrl(plugin);
    if (url) {
      const link = createElement("a", { className: "plugin-source", text: sourceText });
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      identity.append(link);
    } else {
      identity.append(createElement("small", { className: "plugin-source", text: sourceText }));
    }
    if (plugin.description) identity.append(createElement("small", { className: "plugin-description", text: plugin.description }));
    const actions = createElement("div", { className: "plugin-actions" });
    if (plugin.protected) {
      appRow(identity, actions, app);
    } else {
      actions.append(pluginSwitch(plugin));
      const menu = sidebarActionMenu({
        id: `plugin-${page.server}-${plugin.id}`,
        label: `Actions for ${plugin.name}`,
        escapesOverflow: true,
        actions: [
          ...(plugin.updatable ? [{
            label: "Update", key: "update", paths: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
            onSelect: () => void change("update", plugin),
          }] : []),
          {
            label: "Uninstall…", key: "uninstall", danger: true, paths: ["M6 6l12 12M18 6 6 18"],
            onSelect: () => uninstall(plugin),
          },
        ],
      });
      const summary = menu.querySelector("summary");
      if (locked()) {
        menu.classList.add("is-disabled");
        summary.setAttribute("aria-disabled", "true");
        summary.tabIndex = -1;
      }
      actions.append(menu);
    }
    row.append(identity, actions);
    return row;
  }

  // HerdRabbit's row: About's check for this machine (versions, or why it
  // cannot update), a run in progress in one line, and Update… or Details….
  function appRow(identity, actions, app) {
    const { run, herdrRun } = appState() ?? {};
    // a run while it goes, and one that failed (until the Update window puts it away)
    const summary = run?.tracking || run?.status?.state === "failed" ? runSummary(run, { local: page.server === "local" }) : null;
    if (!app && !summary) {
      actions.append(createElement("span", { className: "plugin-state", text: "Updated from About" }));
      return;
    }
    if (app) {
      const line = createElement("small", { className: "plugin-update-line", text: app.text });
      line.dataset.error = String(app.error);
      identity.append(line);
      if (app.note) identity.append(createElement("small", { className: "plugin-update-note", text: app.note }));
    }
    const herdr = herdrRunSummary(herdrRun);
    for (const said of [summary, herdr?.running ? herdr : null]) {
      if (!said) continue;
      const line = createElement("small", { className: "plugin-update-run", text: said.text });
      line.dataset.error = String(said.error);
      identity.append(line);
    }
    if (summary || herdr?.running) {
      const details = createElement("button", { className: "secondary-button plugin-app-details", text: "Details…" });
      details.type = "button";
      details.addEventListener("click", () => appUpdates.open());
      actions.append(details);
    }
    if (app?.canUpdate && !summary?.running) {
      const button = createElement("button", { className: "secondary-button plugin-app-update", text: "Update…" });
      button.type = "button";
      button.disabled = locked();
      button.addEventListener("click", () => void updateApp());
      actions.append(button);
    }
  }

  // The line under the list: an update of HerdRabbit or Herdr on this
  // machine first (plugin changes wait for it), then Update all, then the
  // change last started.
  function statusLine() {
    const { run, herdrRun } = appState() ?? {};
    if (run?.tracking) return { text: `HerdRabbit is updating on ${machineName()}. Plugin changes wait until it finishes.`, error: false };
    if (herdrRun?.tracking) return { text: `Herdr is updating on ${machineName()}. Plugin changes wait until it finishes.`, error: false };
    const status = pluginOperationText(page.operation, page.plugins);
    if (page.updatingAll && status) return { ...status, text: `Update all: ${status.text}` };
    return page.allResult ?? status;
  }

  function render() {
    installButton.disabled = locked();
    machineSelect.disabled = page.updatingAll !== null;
    const count = page.loaded ? updateAllCount(plan()) : 0;
    updateAllButton.hidden = page.view !== "installed" || (count === 0 && page.updatingAll === null);
    updateAllButton.disabled = locked();
    updateAllButton.textContent = page.updatingAll ? "Updating all…" : `Update all (${count})`;
    browse.render();
    if (!page.loaded) return;
    if (page.plugins.length === 0) {
      list.replaceChildren(createElement("li", { className: "settings-row-hint plugin-empty", text: `No plugins are installed on ${machineName()}.` }));
    } else {
      list.replaceChildren(...page.plugins.map(pluginRow));
    }
    const status = statusLine();
    if (status) setFeedback(status.text, status.error);
  }

  function adopt(answer) {
    if (answer.server !== page.server) return;
    page.plugins = Array.isArray(answer.plugins) ? answer.plugins : [];
    page.operation = answer.operation ?? null;
    page.loaded = true;
    render();
    schedule();
    if (!running()) for (const resolve of page.waiters.splice(0)) resolve(page.operation);
  }

  // Follows a change while the page is on screen, and while Update all
  // waits for one even when Settings was closed meanwhile.
  function schedule() {
    clearTimeout(page.timer);
    page.timer = null;
    if ((page.visible || page.updatingAll) && running()) page.timer = setTimeout(() => void load({ quiet: true }), POLL_MS);
  }

  // The change just started, once it has ended: the operation as it ended.
  function settled() {
    return new Promise((resolve) => {
      if (running()) page.waiters.push(resolve);
      else resolve(page.operation);
    });
  }

  // HerdRabbit's row's Update…: About's update, with its own confirm.
  async function updateApp() {
    if (locked()) return;
    page.allResult = null;
    const result = await appUpdates.run(page.server);
    if (result?.startFailed) setFeedback(result.detail, true);
    else render();
  }

  // Update all, from this page: each plugin's own update (the same request as
  // ⋯ → Update), waiting for each to end before the next, then HerdRabbit's
  // update last, since it restarts HerdRabbit there. The first failure stops
  // it and says what was left. One question first, for all of them.
  async function updateAll() {
    if (locked()) return;
    const server = page.server;
    const todo = plan();
    const count = updateAllCount(todo);
    if (count === 0) return;
    const app = appLine();
    const appCheck = appState()?.check;
    const appDetails = todo.app ? appConfirmDetails(appCheck) : "";
    if (!window.confirm(updateAllConfirmText(machineName(), todo, { appLine: app?.text, appDetails }))) return;
    page.updatingAll = { server };
    page.allResult = null;
    const names = [...todo.plugins.map((plugin) => plugin.name), ...(todo.app ? ["HerdRabbit"] : [])];
    const done = [];
    let failure = null;
    render();
    try {
      for (const plugin of todo.plugins) {
        const started = await send(`/api/plugins/${encodeURIComponent(plugin.id)}/update`, {
          method: "POST", body: { server },
        }, { queued: true });
        if (!started.ok) {
          failure = `Couldn't update ${plugin.name}: ${started.error}`;
          break;
        }
        const ended = await settled();
        if (ended?.state !== "succeeded") {
          failure = pluginOperationText(ended, page.plugins)?.text ?? `Couldn't update ${plugin.name}.`;
          break;
        }
        done.push(plugin.name);
      }
      if (!failure && todo.app) {
        const ended = await appUpdates.run(server, { confirmed: true });
        if (ended?.state === "succeeded") done.push("HerdRabbit");
        else failure = ended?.startFailed ? `Couldn't update HerdRabbit: ${ended.detail}`
          : ended ? runSummary({ status: ended }, { local: server === "local" })?.text ?? "The HerdRabbit update failed."
            : "HerdRabbit's update did not start.";
      }
    } finally {
      page.updatingAll = null;
      page.allResult = updateAllResultText(done, names.slice(done.length + (failure ? 1 : 0)), failure);
      render();
      if (server === page.server) void load({ quiet: true });
    }
  }

  async function load({ quiet = false } = {}) {
    const generation = ++page.generation;
    const server = page.server;
    if (!quiet) {
      page.loaded = false;
      page.plugins = [];
      list.replaceChildren(createElement("li", { className: "settings-row-hint plugin-empty", text: `Reading the plugins on ${machineName()}…` }));
      setFeedback("");
      render();
    }
    try {
      const answer = await api(`/api/plugins?server=${encodeURIComponent(server)}`);
      if (generation !== page.generation || server !== page.server) return;
      adopt(answer);
    } catch (error) {
      if (generation !== page.generation) return;
      if (quiet && page.loaded) {
        // A look while a change runs failed: try again on the next tick.
        schedule();
        return;
      }
      // Update all waits for the change it started: look again.
      if (page.updatingAll) page.timer = setTimeout(() => void load({ quiet: true }), POLL_MS);
      page.loaded = false;
      list.replaceChildren();
      setFeedback(error.message, true);
      render();
    }
  }

  // Starts one change. Update all's own (`queued`) go while it holds the
  // page; anything else waits for it. Answers { ok, error }.
  async function send(path, options, { queued = false } = {}) {
    if (queued ? changing() || !page.loaded : locked()) return { ok: false, error: "Another change is running." };
    page.sending = true;
    if (!queued) page.allResult = null;
    render();
    try {
      adopt(await api(path, options));
      return { ok: true };
    } catch (error) {
      setFeedback(error.message, true);
      return { ok: false, error: error.message };
    } finally {
      page.sending = false;
      render();
    }
  }

  function change(action, plugin) {
    return send(`/api/plugins/${encodeURIComponent(plugin.id)}/${action}`, {
      method: "POST", body: { server: page.server },
    });
  }

  function uninstall(plugin) {
    if (!window.confirm(`Uninstall ${plugin.name} from ${machineName()}? Herdr removes it and its actions and panes.`)) return;
    void send(`/api/plugins/${encodeURIComponent(plugin.id)}?server=${encodeURIComponent(page.server)}`, { method: "DELETE" });
  }

  machineSelect.addEventListener("change", () => {
    if (page.updatingAll) return;
    page.server = machineSelect.value;
    page.allResult = null;
    void load();
    void appUpdates?.follow(page.server);
  });
  updateAllButton.addEventListener("click", () => void updateAll());

  // HerdRabbit's or Herdr's update moved on: the row and the controls follow;
  // once it ends, the list is read again (versions change).
  appUpdates?.subscribe(() => {
    const busy = updateRunning();
    const ended = page.appBusy && !busy;
    page.appBusy = busy;
    if (!page.visible && !page.updatingAll) return;
    render();
    if (ended && page.loaded) void load({ quiet: true });
  });

  // Install: Source and Ref, the repository it names and what it will do, then
  // a confirm step naming exactly what is sent.
  function showStep(step) {
    dialog.dataset.step = step;
    sourceStep.hidden = step !== "source";
    confirmStep.hidden = step !== "confirm";
    cancelButton.textContent = step === "confirm" ? "Back" : "Cancel";
    submitButton.textContent = step === "confirm" ? "Install" : "Continue";
  }

  function syncInstallPreview() {
    const parsed = parsePluginSource(sourceInput.value);
    repoLine.replaceChildren();
    if (parsed) {
      const link = createElement("a", { text: parsed.url });
      link.href = parsed.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      repoLine.append("From ", link, parsed.subdir ? `, folder ${parsed.subdir}` : "");
    } else {
      repoLine.textContent = sourceInput.value.trim() ? "Enter owner/repo, or owner/repo/folder, of a GitHub repository." : "";
    }
    repoLine.dataset.error = String(Boolean(sourceInput.value.trim()) && !parsed);
    warning.textContent = `A plugin runs its build and its own code on ${machineName()}, as your user there. Install only plugins you trust.`;
  }

  // From Install plugin…, or from a Browse listing with its source filled in.
  function openInstall(source = "", opener = installButton) {
    if (locked()) return;
    form.reset();
    sourceInput.value = source;
    page.pending = null;
    page.opener = opener;
    setInstallFeedback("");
    document.querySelector("#plugin-install-machine").textContent = `On ${machineName()}`;
    showStep("source");
    syncInstallPreview();
    dialog.showModal();
    if (source) submitButton.focus();
    else sourceInput.focus();
  }

  sourceInput.addEventListener("input", () => { setInstallFeedback(""); syncInstallPreview(); });
  refInput.addEventListener("input", () => setInstallFeedback(""));
  installButton.addEventListener("click", () => openInstall());
  cancelButton.addEventListener("click", () => {
    if (dialog.dataset.step === "confirm") {
      showStep("source");
      setInstallFeedback("");
      sourceInput.focus();
    } else {
      dialog.close();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (dialog.dataset.step === "source") {
      const parsed = parsePluginSource(sourceInput.value);
      const ref = refInput.value.trim();
      if (!parsed) {
        setInstallFeedback("Enter the plugin's GitHub repository as owner/repo, or owner/repo/folder.", true);
        sourceInput.focus();
        return;
      }
      if (!validPluginRef(ref)) {
        setInstallFeedback("Ref is a branch, tag or commit name, without spaces or \"..\", and not starting with \"-\".", true);
        refInput.focus();
        return;
      }
      page.pending = { server: page.server, source: parsed.spec, ref: ref || null };
      confirmText.textContent = `Install ${parsed.spec}${ref ? ` at ${ref}` : ""} on ${machineName()}?`;
      confirmRepo.replaceChildren();
      const link = createElement("a", { text: parsed.url });
      link.href = parsed.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      confirmRepo.append("Herdr downloads it from ", link, ", builds it and runs it there. It can do anything your user there can.",
        ref ? "" : " Without a Ref it takes the repository's default branch as it is now, which can differ from what a listing says.");
      setInstallFeedback("");
      showStep("confirm");
      submitButton.focus();
      return;
    }
    const pending = page.pending;
    if (!pending || pending.server !== page.server) {
      showStep("source");
      return;
    }
    if (locked()) {
      setInstallFeedback("Another plugin change is running. Wait for it to finish.", true);
      return;
    }
    submitButton.disabled = true;
    page.sending = true;
    render();
    try {
      const answer = await api("/api/plugins/install", {
        method: "POST", body: { server: pending.server, source: pending.source, ...(pending.ref ? { ref: pending.ref } : {}) },
      });
      page.sending = false;
      dialog.close();
      adopt(answer);
    } catch (error) {
      setInstallFeedback(error.message, true);
    } finally {
      page.sending = false;
      submitButton.disabled = false;
      render();
    }
  });
  dialog.addEventListener("close", () => {
    page.pending = null;
    if (!page.visible) return;
    // A listing's Install… is gone once the list is drawn again.
    const opener = page.opener?.isConnected ? page.opener : installButton;
    opener.focus({ preventScroll: true });
  });

  // Installed or Browse; the machine, the status line and Install plugin…
  // are the same for both.
  function showView(view) {
    page.view = view;
    for (const button of viewButtons) button.setAttribute("aria-pressed", String(button.dataset.pluginsView === view));
    installedView.hidden = view !== "installed";
    browseView.hidden = view !== "browse";
    if (view === "browse") browse.show();
    render();
  }
  for (const button of viewButtons) button.addEventListener("click", () => showView(button.dataset.pluginsView));

  // Settings tells the page whether it is on screen; it reads its list as it
  // comes into view and stops following a change once it is gone.
  function sync({ visible }) {
    renderMachines();
    if (visible === page.visible) return;
    page.visible = visible;
    if (visible) {
      void load();
      void appUpdates?.follow(page.server);
    } else if (!page.updatingAll) {
      // Update all goes on with Settings closed: it waits for each change
      // through these looks, so they stop only when nothing is waiting.
      clearTimeout(page.timer);
      page.timer = null;
    }
  }

  return { sync };
}
