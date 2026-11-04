import { createElement } from "./dom.js?v=1.4.30";
import {
  parsePluginSource, pluginMachines, pluginOperationText, pluginSourceText, pluginSourceUrl, validPluginRef,
} from "./plugin-model.js?v=1.4.30";
import { createPluginBrowse } from "./plugin-browse.js?v=1.4.30";

const POLL_MS = 1_500;

// Settings → Plugins: Herdr's plugins on one machine at a time. The server
// runs Herdr's own commands (src/herdr-plugins.mjs) and says how a change
// goes; this page lists, starts a change and follows it until it ends.
// HerdRabbit's own plugin has no switch or menu: its row shows its version
// and "Updated from Updates", which opens Settings → Updates (`openUpdates`),
// where HerdRabbit, Herdr and plugins are updated. Another plugin the server
// marks `updateAvailable` (its repository moved on in Herdr's marketplace)
// carries an "Update available" badge that opens Updates too; ⋯ → Update
// still updates any plugin Herdr can update, marked or not. While HerdRabbit
// or Herdr updates on the machine (`appUpdates`, the Update window's panel
// in app-update.js), the controls wait. Browse lists Herdr's plugin
// marketplace (plugin-browse.js) and installs through the same dialog. Only
// shown with sign-in on (settings.js decides).
export function createPluginsPage({ api, snapshotRecords, sidebarActionMenu, appUpdates = null, openUpdates = () => {} }) {
  const machineRow = document.querySelector("#plugins-machine-row");
  const machineSelect = document.querySelector("#plugins-machine");
  const list = document.querySelector("#plugins-list");
  const feedback = document.querySelector("#plugins-feedback");
  const installButton = document.querySelector("#plugins-install");
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
    pending: null, view: "installed", opener: null, appBusy: false,
  };

  const browse = createPluginBrowse({
    api,
    installed: () => ({ plugins: page.plugins, loaded: page.loaded }),
    locked: () => locked(),
    install: (source, opener) => openInstall(source, opener),
    openUpdates: () => openUpdates(),
  });

  const machineName = (id = page.server) => page.machines.find((item) => item.id === id)?.name ?? "this machine";
  const running = () => page.operation?.state === "running";
  // HerdRabbit's or Herdr's own update on this machine, followed by the
  // Update window's panel. The server refuses plugin changes meanwhile too.
  const appState = () => appUpdates?.state(page.server) ?? null;
  const updateRunning = () => appState()?.busy === true;
  const changing = () => page.sending || running() || updateRunning();
  const locked = () => changing() || !page.loaded;

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
    if (!plugin.protected && plugin.updateAvailable === true) title.append(updatesLink("ui-badge is-accent plugin-update-badge", "Update available"));
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
      actions.append(updatesLink("plugin-state plugin-updates-link", "Updated from Updates"));
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

  // Opens Settings → Updates, where the update is.
  function updatesLink(className, text) {
    const button = createElement("button", { className, text });
    button.type = "button";
    button.title = "Open Updates";
    button.addEventListener("click", () => openUpdates());
    return button;
  }

  // The line under the list: an update of HerdRabbit or Herdr on this
  // machine first (plugin changes wait for it), then the change last started.
  function statusLine() {
    const { run, herdrRun } = appState() ?? {};
    if (run?.tracking) return { text: `HerdRabbit is updating on ${machineName()}. Plugin changes wait until it finishes.`, error: false };
    if (herdrRun?.tracking) return { text: `Herdr is updating on ${machineName()}. Plugin changes wait until it finishes.`, error: false };
    return pluginOperationText(page.operation, page.plugins);
  }

  function render() {
    installButton.disabled = locked();
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
  }

  // Follows a change while the page is on screen.
  function schedule() {
    clearTimeout(page.timer);
    page.timer = null;
    if (page.visible && running()) page.timer = setTimeout(() => void load({ quiet: true }), POLL_MS);
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
      page.loaded = false;
      list.replaceChildren();
      setFeedback(error.message, true);
      render();
    }
  }

  // Starts one change. Answers { ok, error }.
  async function send(path, options) {
    if (locked()) return { ok: false, error: "Another change is running." };
    page.sending = true;
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
    page.server = machineSelect.value;
    void load();
    void appUpdates?.follow(page.server);
  });

  // HerdRabbit's or Herdr's update moved on: the row and the controls follow;
  // once it ends, the list is read again (versions change).
  appUpdates?.subscribe(() => {
    const busy = updateRunning();
    const ended = page.appBusy && !busy;
    page.appBusy = busy;
    if (!page.visible) return;
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
    } else {
      clearTimeout(page.timer);
      page.timer = null;
    }
  }

  return { sync };
}
