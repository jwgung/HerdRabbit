import { createElement } from "./dom.js?v=1.4.33";
import { pluginMachines } from "./plugin-model.js?v=1.4.33";
import { integrationAction, integrationConfirmText, integrationStateText } from "./herdr-settings-model.js?v=1.4.33";

// Settings → Herdr: Herdr's own settings on one machine at a time. The server
// runs Herdr's commands and writes config.toml (src/herdr-settings.mjs); this
// page shows the update channel, the agent integrations and config.toml, and
// asks before an integration changes or config.toml is saved. Herdr's own
// update is in Settings → Updates (`openUpdates`). Only shown with sign-in on
// (settings.js decides).
export function createHerdrSettingsPage({ api, snapshotRecords, openUpdates = () => {} }) {
  const machineRow = document.querySelector("#herdr-machine-row");
  const machineSelect = document.querySelector("#herdr-machine");
  const channelButtons = [...document.querySelectorAll("[data-herdr-channel]")];
  const list = document.querySelector("#herdr-integrations");
  const pathLine = document.querySelector("#herdr-config-path");
  const viewButtons = [...document.querySelectorAll("[data-herdr-config-view]")];
  const editor = document.querySelector("#herdr-config-text");
  const defaults = document.querySelector("#herdr-config-default");
  const diagnostics = document.querySelector("#herdr-config-diagnostics");
  const feedback = document.querySelector("#herdr-feedback");
  const checkButton = document.querySelector("#herdr-config-check");
  const revertButton = document.querySelector("#herdr-config-revert");
  const saveButton = document.querySelector("#herdr-config-save");
  document.querySelector("#herdr-open-updates").addEventListener("click", () => openUpdates());

  const page = {
    visible: false, server: "local", machines: [], settings: null, config: null, defaults: null,
    loaded: false, sending: false, generation: 0, view: "edit",
  };

  const machineName = (id = page.server) => page.machines.find((item) => item.id === id)?.name ?? "this machine";
  const dirty = () => page.config !== null && editor.value !== page.config.text;
  const locked = () => page.sending || !page.loaded;
  const query = () => `server=${encodeURIComponent(page.server)}`;

  function setFeedback(text, isError = false) {
    feedback.textContent = text;
    feedback.dataset.error = String(isError);
  }

  function showDiagnostics(text) {
    diagnostics.textContent = text || "";
    diagnostics.hidden = !text;
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

  function integrationRow(item) {
    const row = createElement("li", { className: "plugin-row herdr-integration" });
    row.dataset.integration = item.name;
    const identity = createElement("div", { className: "plugin-identity" });
    const title = createElement("div", { className: "plugin-title" });
    title.append(createElement("strong", { text: item.name }));
    if (item.experimental) title.append(createElement("span", { className: "ui-badge", text: "experimental" }));
    identity.append(title, createElement("small", { className: "plugin-source", text: integrationStateText(item) }));
    const { action, label } = integrationAction(item);
    const button = createElement("button", { className: "secondary-button herdr-integration-action", text: label });
    button.type = "button";
    button.dataset.action = action;
    button.setAttribute("aria-label", `${label.replace("…", "")} ${item.name}`);
    button.disabled = locked();
    button.addEventListener("click", () => void changeIntegration(item, action));
    const actions = createElement("div", { className: "plugin-actions" });
    actions.append(button);
    row.append(identity, actions);
    return row;
  }

  function render() {
    for (const button of channelButtons) {
      button.setAttribute("aria-pressed", String(page.settings?.channel === button.dataset.herdrChannel));
      button.disabled = locked();
    }
    for (const button of viewButtons) button.setAttribute("aria-pressed", String(button.dataset.herdrConfigView === page.view));
    editor.hidden = page.view !== "edit";
    defaults.hidden = page.view !== "default";
    editor.readOnly = locked();
    const editing = page.view === "edit" && page.loaded;
    checkButton.disabled = page.sending || !editing;
    revertButton.disabled = page.sending || !editing || !dirty();
    saveButton.disabled = page.sending || !editing || !dirty();
    if (!page.loaded) return;
    const integrations = page.settings?.integrations ?? [];
    list.replaceChildren(...(integrations.length
      ? integrations.map(integrationRow)
      : [createElement("li", { className: "settings-row-hint plugin-empty", text: `Herdr on ${machineName()} lists no integrations.` })]));
    const config = page.config;
    pathLine.textContent = config?.path
      ? `${config.path}${config.exists ? "" : " (not there yet: Herdr uses its defaults)"}`
      : "Herdr did not say where its config.toml is.";
  }

  function adoptConfig(config) {
    page.config = { text: config.text ?? "", version: config.version, path: config.path, exists: config.exists };
    editor.value = page.config.text;
  }

  async function load() {
    const generation = ++page.generation;
    page.loaded = false;
    page.settings = null;
    page.config = null;
    page.defaults = null;
    defaults.value = "";
    editor.value = "";
    showDiagnostics("");
    list.replaceChildren(createElement("li", { className: "settings-row-hint plugin-empty", text: `Reading Herdr's settings on ${machineName()}…` }));
    pathLine.textContent = "";
    setFeedback("");
    render();
    try {
      const [settings, config] = await Promise.all([api(`/api/herdr/settings?${query()}`), api(`/api/herdr/config?${query()}`)]);
      if (generation !== page.generation) return;
      page.settings = settings;
      adoptConfig(config);
      page.loaded = true;
      if (page.view === "default") void showDefaults();
    } catch (error) {
      if (generation !== page.generation) return;
      list.replaceChildren();
      setFeedback(error.message, true);
    }
    render();
  }

  // One request at a time from this page; the server refuses a second one too.
  async function send(work) {
    if (page.sending) return;
    page.sending = true;
    render();
    try {
      await work();
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      page.sending = false;
      render();
    }
  }

  function setChannel(channel) {
    if (locked() || page.settings?.channel === channel) return;
    void send(async () => {
      page.settings = await api("/api/herdr/channel", { method: "POST", body: { server: page.server, channel } });
      setFeedback(`Herdr on ${machineName()} follows ${channel === "preview" ? "Preview" : "Stable"} now. Updates checks against it.`);
      // Herdr keeps the channel in config.toml: unedited, it is read again.
      if (!dirty()) adoptConfig(await api(`/api/herdr/config?${query()}`));
    });
  }

  function changeIntegration(item, action) {
    if (locked() || !window.confirm(integrationConfirmText(item, action, machineName()))) return;
    void send(async () => {
      page.settings = await api(`/api/herdr/integrations/${encodeURIComponent(item.name)}/${action}`, {
        method: "POST", body: { server: page.server },
      });
      const now = page.settings.integrations?.find((entry) => entry.name === item.name);
      setFeedback(`${item.name}: ${integrationStateText(now ?? item)}.`);
    });
  }

  function check() {
    void send(async () => {
      const answer = await api("/api/herdr/config/check", { method: "POST", body: { server: page.server, text: editor.value } });
      showDiagnostics(answer.ok ? "" : answer.diagnostics);
      setFeedback(answer.ok ? "Herdr accepts this config." : "Herdr found problems in this config:", !answer.ok);
    });
  }

  function save() {
    if (!dirty()) return;
    const kept = page.config.exists ? " The old file is kept beside it as a .bak." : "";
    if (!window.confirm(`Save config.toml on ${machineName()}? Herdr checks it first and reloads it once saved.${kept}`)) return;
    void send(async () => {
      try {
        const answer = await api("/api/herdr/config", {
          method: "PUT", body: { server: page.server, text: editor.value, version: page.config.version },
        });
        adoptConfig(answer);
        showDiagnostics("");
        const backup = answer.backup ? ` The old one is ${answer.backup}.` : "";
        setFeedback(answer.reloaded
          ? `Saved and reloaded on ${machineName()}.${backup}`
          : `Saved on ${machineName()}, but Herdr did not reload it (${answer.reloadDetail || "no answer"}). It applies when Herdr starts.${backup}`);
        page.settings = await api(`/api/herdr/settings?${query()}`);
      } catch (error) {
        if (error.code === "config_invalid") {
          showDiagnostics(error.details?.diagnostics ?? "");
          setFeedback(`${error.message} Fix what Herdr says, then save again.`, true);
        } else if (error.code === "config_changed") {
          setFeedback("config.toml changed on that machine since it was read. Revert reads it again; copy your edits first.", true);
        } else {
          throw error;
        }
      }
    });
  }

  function revert() {
    if (dirty() && !window.confirm("Discard your edits and read config.toml again?")) return;
    void send(async () => {
      adoptConfig(await api(`/api/herdr/config?${query()}`));
      showDiagnostics("");
      setFeedback("");
    });
  }

  async function showDefaults() {
    if (page.defaults !== null || !page.loaded) return;
    const generation = page.generation;
    try {
      const answer = await api(`/api/herdr/config/default?${query()}`);
      if (generation !== page.generation) return;
      page.defaults = answer.text;
      defaults.value = answer.text;
    } catch (error) {
      setFeedback(error.message, true);
    }
  }

  function showView(view) {
    page.view = view;
    if (view === "default") void showDefaults();
    render();
  }

  for (const button of channelButtons) button.addEventListener("click", () => setChannel(button.dataset.herdrChannel));
  for (const button of viewButtons) button.addEventListener("click", () => showView(button.dataset.herdrConfigView));
  editor.addEventListener("input", () => render());
  checkButton.addEventListener("click", check);
  saveButton.addEventListener("click", save);
  revertButton.addEventListener("click", revert);
  machineSelect.addEventListener("change", () => {
    if (dirty() && !window.confirm(`Discard your edits to config.toml on ${machineName()}?`)) {
      machineSelect.value = page.server;
      return;
    }
    page.server = machineSelect.value;
    void load();
  });

  // Settings tells the page whether it is on screen; it reads Herdr's
  // settings each time it comes into view, unless edits are waiting.
  function sync({ visible }) {
    renderMachines();
    if (visible === page.visible) return;
    page.visible = visible;
    if (visible && !dirty()) void load();
  }

  return { sync, dirty };
}
