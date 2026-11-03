import { createElement } from "./dom.js?v=1.4.27";
import {
  parsePluginSource, pluginMachines, pluginOperationText, pluginSourceText, pluginSourceUrl, validPluginRef,
} from "./plugin-model.js?v=1.4.27";

const POLL_MS = 1_500;

// Settings → Plugins: Herdr's plugins on one machine at a time. The server
// runs Herdr's own commands (src/herdr-plugins.mjs) and says how a change
// goes; this page lists, starts a change and follows it until it ends.
// HerdRabbit's own plugin is listed but has no controls: its update is
// About → Update. Only shown with sign-in on (settings.js decides).
export function createPluginsPage({ api, snapshotRecords, sidebarActionMenu }) {
  const machineRow = document.querySelector("#plugins-machine-row");
  const machineSelect = document.querySelector("#plugins-machine");
  const list = document.querySelector("#plugins-list");
  const feedback = document.querySelector("#plugins-feedback");
  const installButton = document.querySelector("#plugins-install");

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
    pending: null,
  };

  const machineName = (id = page.server) => page.machines.find((item) => item.id === id)?.name ?? "this machine";
  const running = () => page.operation?.state === "running";
  const locked = () => page.sending || running() || !page.loaded;

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
      actions.append(createElement("span", { className: "plugin-state", text: "Updated from About" }));
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

  function render() {
    installButton.disabled = locked();
    if (!page.loaded) return;
    if (page.plugins.length === 0) {
      list.replaceChildren(createElement("li", { className: "settings-row-hint plugin-empty", text: `No plugins are installed on ${machineName()}.` }));
    } else {
      list.replaceChildren(...page.plugins.map(pluginRow));
    }
    const status = pluginOperationText(page.operation, page.plugins);
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

  async function send(path, options) {
    if (locked()) return false;
    page.sending = true;
    render();
    try {
      adopt(await api(path, options));
      return true;
    } catch (error) {
      setFeedback(error.message, true);
      return false;
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

  function openInstall() {
    if (locked()) return;
    form.reset();
    page.pending = null;
    setInstallFeedback("");
    document.querySelector("#plugin-install-machine").textContent = `On ${machineName()}`;
    showStep("source");
    syncInstallPreview();
    dialog.showModal();
    sourceInput.focus();
  }

  sourceInput.addEventListener("input", () => { setInstallFeedback(""); syncInstallPreview(); });
  refInput.addEventListener("input", () => setInstallFeedback(""));
  installButton.addEventListener("click", openInstall);
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
      page.pending = { server: page.server, source: parsed.spec, ref: ref || null, url: parsed.url };
      confirmText.textContent = `Install ${parsed.spec}${ref ? ` at ${ref}` : ""} on ${machineName()}?`;
      confirmRepo.replaceChildren();
      const link = createElement("a", { text: parsed.url });
      link.href = parsed.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      confirmRepo.append("Herdr downloads it from ", link, ", builds it and runs it there. It can do anything your user there can.");
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
  dialog.addEventListener("close", () => { page.pending = null; if (page.visible) installButton.focus({ preventScroll: true }); });

  // Settings tells the page whether it is on screen; it reads its list as it
  // comes into view and stops following a change once it is gone.
  function sync({ visible }) {
    renderMachines();
    if (visible === page.visible) return;
    page.visible = visible;
    if (visible) void load();
    else {
      clearTimeout(page.timer);
      page.timer = null;
    }
  }

  return { sync };
}
