import { createElement } from "./dom.js?v=1.4.51";
import { appVersionText, createUpdatePanel, runSummary } from "../app-update.js?v=1.4.51";
import { writeGridFit } from "../terminal-preference.js?v=1.4.51";
import { applicationServerKeyBytes, pushButtonPresentation } from "../push-notifications.js?v=1.4.51";
import { OPEN_PANES_IN, readOpenPanesIn, writeOpenPanesIn } from "../lens-preference.js?v=1.4.51";
import { CHAT_WIDTHS, readChatWidth, writeChatWidth } from "../chat-width-preference.js?v=1.4.51";
import { readHtmlInternet, writeHtmlInternet } from "../files-preference.js?v=1.4.51";
import { notificationStateText, settingsPageList, settingsPageTitle, updateBadges } from "../settings-pages.js?v=1.4.51";
import { herdrVersionText } from "../ui-model.js?v=1.4.51";
import { createPluginsPage } from "./plugins.js?v=1.4.51";
import { createHerdrSettingsPage } from "./herdr-settings.js?v=1.4.51";
import { createPcAccess } from "./pc-access.js?v=1.4.51";

// What each "Open panes in" choice does, under the choice.
const OPEN_PANES_IN_HINTS = Object.freeze({
  auto: "Chat on a touch screen, Terminal on a desktop. A pane you switched keeps its choice.",
  chat: "Panes with an agent's conversation open in Chat. A pane you switched keeps its choice.",
  terminal: "Panes open in Terminal. A pane you switched keeps its choice.",
});

// The settings screen (⚙ at the foot of the sidebar): what belongs to this
// browser rather than to a machine, in pages. On a desktop it is a dialog with
// the page list on the left; on a phone a full-screen list where each page
// opens with a Back control. Push notifications and the Update window live
// here too. `deps` hands in what lives in app.js; `paneGrid` and `chatLens`
// are read through getters because they are made further down app.js.
export function createSettings(deps) {
  const {
    state, api, snapshotRecords, setFeedback, panePreferenceStorage, desktopMedia,
    openKeyBarDialog, showPasskeys, showSessions, showServerDetails, openConnectPc, sidebarActionMenu,
    refreshSnapshot = async () => {}, showPane = () => {},
  } = deps;

  const dialog = document.querySelector("#settings-dialog");
  const openButton = document.querySelector("#settings-open");
  const pageList = document.querySelector("#settings-page-list");
  const pageTitle = document.querySelector("#settings-page-title");
  const backButton = document.querySelector("#settings-back");
  const pages = new Map([...dialog.querySelectorAll(".settings-page")].map((page) => [page.dataset.page, page]));
  const pcList = document.querySelector("#settings-pc-list");

  const settings = {
    page: "appearance",
    push: null,
    // In-app update: whether Update… shows, and whether some PC has a newer
    // version (a dot on the ⚙ button; counts beside Plugins and Herdr).
    update: { visible: false, available: false, herdr: false },
  };

  // The chat column's width is the root's, so it holds before any chat is drawn.
  document.documentElement.dataset.chatWidth = readChatWidth(panePreferenceStorage);

  const visiblePages = () => settingsPageList({ security: state.authRequired === true,
    pcs: state.connectPcAvailable === true, plugins: state.pluginsAvailable === true,
    herdr: state.herdrSettingsAvailable === true });

  function pressOnly(buttons, attribute, value) {
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.getAttribute(attribute) === value));
  }

  // The counts beside Plugins (HerdRabbit and plugins with a new version)
  // and Herdr (a newer Herdr), over every PC checked.
  function badges() {
    return updateBadges(updateServers().map((server) => updatePanel.state(server.id).check), pluginsPage.updateCounts());
  }
  let shownBadges = "";

  function renderPageList() {
    const shown = visiblePages();
    const counts = badges();
    shownBadges = JSON.stringify(counts);
    if (!shown.some((page) => page.id === settings.page)) settings.page = shown[0].id;
    pageList.replaceChildren(...shown.map((page) => {
      const button = createElement("button", { className: "ui-nav-item settings-page-link" });
      button.type = "button";
      button.dataset.page = page.id;
      const copy = createElement("span", { className: "ui-nav-copy" });
      copy.append(createElement("strong", { text: page.title }));
      const count = counts[page.id] ?? 0;
      if (count > 0) {
        const badge = createElement("span", { className: "ui-badge is-accent settings-page-badge", text: String(count) });
        badge.setAttribute("aria-label", `${count} update${count === 1 ? "" : "s"}`);
        copy.append(badge);
      }
      button.append(copy);
      button.addEventListener("click", () => showPage(page.id, { focus: true }));
      const item = createElement("li");
      item.append(button);
      return item;
    }));
    syncCurrentPage();
  }

  function syncCurrentPage() {
    for (const link of pageList.querySelectorAll(".settings-page-link")) {
      const current = link.dataset.page === settings.page;
      if (current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    for (const [id, page] of pages) page.hidden = id !== settings.page;
    pageTitle.textContent = settingsPageTitle(settings.page);
  }

  // A page in the list was chosen. On a phone it takes the screen, Back
  // brings the list again.
  function showPage(id, { focus = false } = {}) {
    if (!visiblePages().some((page) => page.id === id)) return;
    settings.page = id;
    dialog.dataset.view = "page";
    syncSettings();
    if (focus && !desktopMedia.matches) backButton.focus();
  }

  function showList() {
    dialog.dataset.view = "list";
    pageList.querySelector(`[data-page="${settings.page}"]`)?.focus();
  }

  function open(page = null) {
    // A phone starts at the list; a desktop at the page last shown.
    dialog.dataset.view = desktopMedia.matches || page ? "page" : "list";
    if (page) settings.page = page;
    renderPageList();
    syncSettings();
    if (!dialog.open) dialog.showModal();
    const first = dialog.dataset.view === "list"
      ? pageList.querySelector(`[data-page="${settings.page}"]`)
      : pageList.querySelector('[aria-current="page"]');
    first?.focus();
  }

  openButton.addEventListener("click", () => open());
  backButton.addEventListener("click", showList);
  for (const button of dialog.querySelectorAll("[data-settings-close]")) {
    button.addEventListener("click", () => dialog.close());
  }
  dialog.addEventListener("close", () => openButton.focus({ preventScroll: true }));
  // Wide or narrow can change while it is open: the list and the Back control follow.
  desktopMedia.addEventListener("change", () => { if (dialog.open) syncSettings(); });

  // Appearance
  const themeChoices = dialog.querySelectorAll("[data-theme-choice]");
  for (const button of themeChoices) {
    button.addEventListener("click", () => window.herdrTheme?.set(button.dataset.themeChoice));
  }
  const textSizeReset = document.querySelector("#settings-text-size-reset");
  const textSizeHint = document.querySelector("#settings-text-size-hint");
  textSizeReset.addEventListener("click", () => {
    deps.paneGrid.resetFont();
    syncSettings();
  });

  // Chat
  const openInChoices = dialog.querySelectorAll("[data-open-in]");
  const openInHint = document.querySelector("#settings-open-in-hint");
  for (const button of openInChoices) {
    button.addEventListener("click", () => {
      writeOpenPanesIn(panePreferenceStorage, button.dataset.openIn);
      deps.chatLens?.reapply();
      syncSettings();
    });
  }
  const widthChoices = dialog.querySelectorAll("[data-chat-width]");
  for (const button of widthChoices) {
    button.addEventListener("click", () => {
      writeChatWidth(panePreferenceStorage, button.dataset.chatWidth);
      // Shown even when this browser cannot keep it.
      document.documentElement.dataset.chatWidth = button.dataset.chatWidth;
      syncSettings();
    });
  }

  // Files
  const htmlInternetChoices = dialog.querySelectorAll("[data-html-internet]");
  for (const button of htmlInternetChoices) {
    button.addEventListener("click", () => {
      writeHtmlInternet(panePreferenceStorage, button.dataset.htmlInternet === "on");
      syncSettings();
    });
  }

  // Terminal & keys
  document.querySelector("#settings-edit-keys").addEventListener("click", () => openKeyBarDialog());
  const gridFitRow = document.querySelector("#settings-grid-fit-row");
  const gridFitHint = document.querySelector("#settings-grid-fit-hint");
  const gridFitChoices = dialog.querySelectorAll("[data-grid-fit]");
  for (const button of gridFitChoices) {
    button.addEventListener("click", () => {
      // Wide screens only: whether a Herdr grid's cells size their panes to
      // this window (on) or keep Herdr's sizes and scale their text (off).
      const fit = button.dataset.gridFit === "on";
      if (deps.paneGrid.fit !== fit) {
        deps.paneGrid.setFit(fit);
        writeGridFit(panePreferenceStorage, fit);
      }
      syncSettings();
    });
  }

  // Notifications
  const notifyChoices = dialog.querySelectorAll("[data-notify-choice]");
  const notifyGroup = document.querySelector("#settings-notify-choices");
  const notifyState = document.querySelector("#settings-notify-state");
  for (const button of notifyChoices) {
    button.addEventListener("click", () => {
      const wanted = button.dataset.notifyChoice === "on";
      if (wanted !== (settings.push?.state === "enabled")) void togglePushNotifications();
    });
  }

  // Security
  document.querySelector("#settings-passkeys").addEventListener("click", () => void showPasskeys());
  document.querySelector("#settings-sessions").addEventListener("click", () => void showSessions());

  // PCs
  document.querySelector("#settings-connect-pc").addEventListener("click", () => openConnectPc());
  // A PC saved there shows here once the dialog closes.
  document.querySelector("#servers-dialog").addEventListener("close", () => { if (dialog.open) syncSettings(); });

  function renderPcs() {
    const linked = snapshotRecords().servers.filter((server) => server.transport === "link");
    if (linked.length === 0) {
      pcList.replaceChildren(createElement("li", { className: "settings-row-hint", text: "No PCs connected yet." }));
      return;
    }
    pcList.replaceChildren(...linked.map((server) => {
      const button = createElement("button", { className: "ui-nav-item settings-pc" });
      button.type = "button";
      button.dataset.serverId = server.id;
      const dot = createElement("span", { className: "connection-dot" });
      dot.dataset.state = server.available ? "online" : "error";
      dot.setAttribute("aria-hidden", "true");
      const copy = createElement("span", { className: "ui-nav-copy" });
      copy.append(
        createElement("strong", { text: server.name || server.id }),
        createElement("small", { text: server.available ? "Connected" : server.status || "Offline" }),
      );
      button.append(dot, copy);
      button.addEventListener("click", () => showServerDetails(server));
      const item = createElement("li");
      item.append(button);
      return item;
    }));
  }

  // About: the versions this machine runs. Where Plugins and Herdr are not
  // shown (sign-in off), it carries their updates for this PC instead:
  // HerdRabbit's line, Update and run, and the Update window's Update… for Herdr.
  const appVersion = document.querySelector("#settings-version-app");
  const herdrVersion = document.querySelector("#settings-version-herdr");
  const aboutUpdates = document.querySelector("#settings-about-updates");
  const appUpdateRow = document.querySelector("#settings-app-update-row");
  const appUpdateLine = document.querySelector("#settings-app-update-line");
  const appUpdateDetails = document.querySelector("#settings-app-update-details");
  const appUpdateButton = document.querySelector("#settings-app-update");
  const updateRow = document.querySelector("#settings-update-row");
  const updateButton = document.querySelector("#settings-update");
  updateButton.addEventListener("click", () => updatePanel.open());
  appUpdateButton.addEventListener("click", () => void updatePanel.run("local"));

  function renderAboutUpdates(onScreen) {
    const shown = visiblePages();
    const { check, error, run } = updatePanel.state("local");
    const app = appVersionText(check);
    const appRun = run?.tracking || run?.status?.state === "failed" || run?.resumed ? runSummary(run) : null;
    appUpdateRow.hidden = shown.some((page) => page.id === "plugins") || (!app && !error);
    // Its versions; the run itself is told step by step under them.
    const said = app ? { text: [app.text, app.note].filter(Boolean).join(" "), error: app.error || Boolean(app.note) }
      : { text: error ?? "", error: true };
    appUpdateLine.textContent = said.text;
    appUpdateLine.dataset.error = String(said.error === true);
    appUpdateButton.hidden = !app?.canUpdate || appRun?.running === true;
    appUpdateButton.disabled = updatePanel.state("local").busy;
    appUpdateDetails.replaceChildren(...(appUpdateRow.hidden ? [] : [updatePanel.appDetails("local", { onScreen })].filter(Boolean)));
    updateRow.hidden = shown.some((page) => page.id === "herdr") || !settings.update.visible;
    aboutUpdates.hidden = appUpdateRow.hidden && updateRow.hidden;
  }

  function syncSettings() {
    // ⚙ itself: its dot, whether the dialog is open or not.
    openButton.classList.toggle("has-update", settings.update.available);
    openButton.setAttribute("aria-label", settings.update.available ? "Settings (update available)" : "Settings");
    if (pageList.childElementCount !== visiblePages().length || JSON.stringify(badges()) !== shownBadges) renderPageList();
    else syncCurrentPage();

    pressOnly(themeChoices, "data-theme-choice", window.herdrTheme?.current() || "dark");
    const resettable = !deps.paneGrid.fit && deps.paneGrid.manualFont !== null;
    textSizeReset.disabled = !resettable;
    textSizeHint.textContent = resettable
      ? "Back to the largest size that fits the grid."
      : "For a grid whose text size you changed (Ctrl+wheel or a pinch).";

    const openIn = readOpenPanesIn(panePreferenceStorage);
    pressOnly(openInChoices, "data-open-in", OPEN_PANES_IN.includes(openIn) ? openIn : "auto");
    openInHint.textContent = OPEN_PANES_IN_HINTS[openIn];
    const width = document.documentElement.dataset.chatWidth;
    pressOnly(widthChoices, "data-chat-width", CHAT_WIDTHS.includes(width) ? width : "default");
    pressOnly(htmlInternetChoices, "data-html-internet", readHtmlInternet(panePreferenceStorage) ? "on" : "off");

    gridFitRow.hidden = !desktopMedia.matches;
    pressOnly(gridFitChoices, "data-grid-fit", deps.paneGrid.fit ? "on" : "off");
    gridFitHint.textContent = deps.paneGrid.fit
      ? "On: each pane takes its cell's size; other screens see that size while the grid is open."
      : "Off: a grid keeps each pane at Herdr's size and scales its text to fit.";

    const push = settings.push;
    const pushShown = Boolean(push) && !push.hidden;
    notifyGroup.hidden = !pushShown;
    pressOnly(notifyChoices, "data-notify-choice", push?.state === "enabled" ? "on" : "off");
    for (const button of notifyChoices) button.disabled = !pushShown || push.disabled;
    notifyState.textContent = notificationStateText(push);
    notifyState.dataset.error = String(push?.state === "denied");

    renderPcs();
    // On a phone the page is on screen only when it, not the list, is shown.
    const onScreen = (id) => dialog.open && settings.page === id && (desktopMedia.matches || dialog.dataset.view === "page");
    pluginsPage.sync({ visible: onScreen("plugins") });
    herdrPage.sync({ visible: onScreen("herdr") });
    pcAccess.sync({ visible: onScreen("pcs") });

    const local = snapshotRecords().servers.find((server) => server.id === "local");
    appVersion.textContent = local?.version || "Unknown";
    herdrVersion.textContent = herdrVersionText(local);
    renderAboutUpdates(onScreen("about"));
    // The Update window is Herdr's; HerdRabbit's update is its row in Plugins.
    const herdrAvailable = settings.update.herdr === true;
    updateButton.textContent = herdrAvailable ? "Update available…" : "Update…";
    updateButton.classList.toggle("has-update", herdrAvailable);
  }

  // The PCs the Update window lists: this one, then each connected PC.
  function updateServers() {
    const listed = snapshotRecords().servers;
    const local = listed.find((server) => server.id === "local");
    return [
      { id: "local", name: local?.machine ? `This PC (${local.machine})` : "This PC" },
      ...listed.filter((server) => server.transport === "link").map((server) => ({ id: server.id, name: server.name || server.id })),
    ];
  }
  const updatePanel = createUpdatePanel({
    api,
    dialog: document.querySelector("#update-dialog"),
    list: document.querySelector("#update-list"),
    feedback: document.querySelector("#update-feedback"),
    checkButton: document.querySelector("#update-check"),
    servers: updateServers,
    onChange: (available) => {
      settings.update = { visible: updatePanel.visible(), available, herdr: updatePanel.hasHerdrUpdate() };
      syncSettings();
    },
  });
  document.querySelector("#update-close").addEventListener("click", () => document.querySelector("#update-dialog").close());

  // Plugins: read when the page comes into view, per machine. HerdRabbit's
  // row and Update all drive the Update window's panel, so every place
  // starts and shows the same update; a machine read with plugins behind
  // changes the count beside Plugins.
  const pluginsPage = createPluginsPage({
    api, snapshotRecords, sidebarActionMenu, appUpdates: updatePanel, onUpdatesChange: () => syncSettings(),
    // A plugin's action runs, and its pane opens, for the pane on show; the
    // pane opened is shown once the sidebar has it, Settings closed.
    selectedPaneId: () => state.selectedPaneId,
    refreshSnapshot,
    showPane: (paneId) => {
      dialog.close();
      showPane(paneId);
    },
  });
  // PCs: whether other PCs may connect to this one, with sign-in on.
  const pcAccess = createPcAccess({ api, shown: () => state.connectPcAccessAvailable === true && state.authRequired === true });
  // Herdr: its update, channel, integrations and config.toml, per machine;
  // its Update… opens the Update window.
  const herdrPage = createHerdrSettingsPage({ api, snapshotRecords, appUpdates: updatePanel, openUpdate: () => updatePanel.open() });
  dialog.addEventListener("close", () => {
    pluginsPage.sync({ visible: false });
    herdrPage.sync({ visible: false });
    // A finished HerdRabbit run seen in Settings goes once it is closed.
    updatePanel.putAwayApp();
    pcAccess.sync({ visible: false });
  });

  function supportsPushNotifications() {
    return Boolean(
      state.pushPublicKey &&
      window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window,
    );
  }

  function renderNotificationItem() {
    const supported = supportsPushNotifications();
    settings.push = pushButtonPresentation({
      supported,
      permission: supported ? Notification.permission : "default",
      subscribed: state.pushSubscription !== null,
      busy: state.pushBusy,
    });
    syncSettings();
  }

  async function serviceWorkerRegistration() {
    if (!supportsPushNotifications()) return null;
    return navigator.serviceWorker.ready;
  }

  async function syncPushSubscription() {
    renderNotificationItem();
    const registration = await serviceWorkerRegistration();
    if (!registration) return;
    state.pushSubscription = await registration.pushManager.getSubscription();
    renderNotificationItem();
    if (state.pushSubscription && Notification.permission === "granted") {
      await api("/api/push/subscriptions", {
        method: "POST",
        body: { subscription: state.pushSubscription },
      });
    }
  }

  async function togglePushNotifications() {
    if (state.pushBusy || !supportsPushNotifications()) return;
    state.pushBusy = true;
    renderNotificationItem();
    setFeedback("");
    try {
      const registration = await serviceWorkerRegistration();
      if (!registration) return;
      const existing = state.pushSubscription ||
        await registration.pushManager.getSubscription();
      if (existing) {
        await api("/api/push/subscriptions", {
          method: "DELETE",
          body: { endpoint: existing.endpoint },
        });
        await existing.unsubscribe();
        state.pushSubscription = null;
        return;
      }

      const permission = Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
      if (permission !== "granted") return;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKeyBytes(state.pushPublicKey),
      });
      try {
        await api("/api/push/subscriptions", {
          method: "POST",
          body: { subscription },
        });
        state.pushSubscription = subscription;
      } catch (error) {
        await subscription.unsubscribe().catch(() => {});
        throw error;
      }
    } catch (error) {
      setFeedback(`Couldn't update notifications: ${error.message}`, true);
    } finally {
      state.pushBusy = false;
      renderNotificationItem();
    }
  }

  return {
    openSettings: open, closeSettings: () => dialog.close(), syncSettings, updatePanel,
    renderNotificationItem, syncPushSubscription,
  };
}
