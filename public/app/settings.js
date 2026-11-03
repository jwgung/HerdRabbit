import { createElement } from "./dom.js?v=1.4.27";
import { createUpdatePanel } from "../app-update.js?v=1.4.27";
import { writeGridFit } from "../terminal-preference.js?v=1.4.27";
import { applicationServerKeyBytes, pushButtonPresentation } from "../push-notifications.js?v=1.4.27";
import { OPEN_PANES_IN, readOpenPanesIn, writeOpenPanesIn } from "../lens-preference.js?v=1.4.27";
import { CHAT_WIDTHS, readChatWidth, writeChatWidth } from "../chat-width-preference.js?v=1.4.27";
import { notificationStateText, settingsPageList, settingsPageTitle } from "../settings-pages.js?v=1.4.27";
import { herdrVersionText } from "../ui-model.js?v=1.4.27";

// What each "Open panes in" choice does, under the choice.
const OPEN_PANES_IN_HINTS = Object.freeze({
  auto: "Chat on a phone or touch screen, Terminal on a desktop. A pane you switched yourself keeps its own choice.",
  chat: "Panes whose agent has a conversation open in Chat. A pane you switched yourself keeps its own choice.",
  terminal: "Panes open in Terminal. A pane you switched yourself keeps its own choice.",
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
    openKeyBarDialog, showPasskeys, showSessions, showServerDetails, openConnectPc,
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
    // In-app update: whether Update shows, and whether some PC has a newer
    // version (a dot on the ⚙ button and on About).
    update: { visible: false, available: false },
  };

  // The chat column's width is the root's, so it holds before any chat is drawn.
  document.documentElement.dataset.chatWidth = readChatWidth(panePreferenceStorage);

  const visiblePages = () => settingsPageList({ security: state.authRequired === true, pcs: state.connectPcAvailable === true });

  function pressOnly(buttons, attribute, value) {
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.getAttribute(attribute) === value));
  }

  function renderPageList() {
    const shown = visiblePages();
    if (!shown.some((page) => page.id === settings.page)) settings.page = shown[0].id;
    pageList.replaceChildren(...shown.map((page) => {
      const button = createElement("button", { className: "ui-nav-item settings-page-link" });
      button.type = "button";
      button.dataset.page = page.id;
      const copy = createElement("span", { className: "ui-nav-copy" });
      copy.append(createElement("strong", { text: page.title }));
      if (page.id === "about" && settings.update.available) {
        copy.append(createElement("span", { className: "ui-badge is-accent", text: "Update" }));
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

  // About
  const appVersion = document.querySelector("#settings-version-app");
  const herdrVersion = document.querySelector("#settings-version-herdr");
  const updateRow = document.querySelector("#settings-update-row");
  const updateButton = document.querySelector("#settings-update");
  updateButton.addEventListener("click", () => updatePanel.open());

  function syncSettings() {
    // ⚙ itself: its dot, whether the dialog is open or not.
    openButton.classList.toggle("has-update", settings.update.available);
    openButton.setAttribute("aria-label", settings.update.available ? "Settings (update available)" : "Settings");
    if (pageList.childElementCount !== visiblePages().length ||
        Boolean(pageList.querySelector(".ui-badge")) !== settings.update.available) renderPageList();
    else syncCurrentPage();

    pressOnly(themeChoices, "data-theme-choice", window.herdrTheme?.current() || "dark");
    const resettable = !deps.paneGrid.fit && deps.paneGrid.manualFont !== null;
    textSizeReset.disabled = !resettable;
    textSizeHint.textContent = resettable
      ? "A grid's text size was changed by hand: reset it to the largest size that fits."
      : "Used when a grid's text size was changed by hand (Ctrl+wheel or a pinch over the grid).";

    const openIn = readOpenPanesIn(panePreferenceStorage);
    pressOnly(openInChoices, "data-open-in", OPEN_PANES_IN.includes(openIn) ? openIn : "auto");
    openInHint.textContent = OPEN_PANES_IN_HINTS[openIn];
    const width = document.documentElement.dataset.chatWidth;
    pressOnly(widthChoices, "data-chat-width", CHAT_WIDTHS.includes(width) ? width : "default");

    gridFitRow.hidden = !desktopMedia.matches;
    pressOnly(gridFitChoices, "data-grid-fit", deps.paneGrid.fit ? "on" : "off");
    gridFitHint.textContent = deps.paneGrid.fit
      ? "On: a grid sizes each pane to its cell (other screens on those panes see that size while it is open)."
      : "Off: a grid keeps each pane at Herdr's size and scales its text to fit.";

    const push = settings.push;
    const pushShown = Boolean(push) && !push.hidden;
    notifyGroup.hidden = !pushShown;
    pressOnly(notifyChoices, "data-notify-choice", push?.state === "enabled" ? "on" : "off");
    for (const button of notifyChoices) button.disabled = !pushShown || push.disabled;
    notifyState.textContent = notificationStateText(push);
    notifyState.dataset.error = String(push?.state === "denied");

    renderPcs();

    const local = snapshotRecords().servers.find((server) => server.id === "local");
    appVersion.textContent = local?.version || "Unknown";
    herdrVersion.textContent = herdrVersionText(local);
    updateRow.hidden = !settings.update.visible;
    updateButton.textContent = settings.update.available ? "Update available…" : "Update…";
    updateButton.classList.toggle("has-update", settings.update.available);
  }

  // The PCs the Update window lists: this one, then each connected PC.
  const updatePanel = createUpdatePanel({
    api,
    dialog: document.querySelector("#update-dialog"),
    list: document.querySelector("#update-list"),
    feedback: document.querySelector("#update-feedback"),
    checkButton: document.querySelector("#update-check"),
    servers: () => {
      const listed = snapshotRecords().servers;
      const local = listed.find((server) => server.id === "local");
      return [
        { id: "local", name: local?.machine ? `This PC (${local.machine})` : "This PC" },
        ...listed.filter((server) => server.transport === "link").map((server) => ({ id: server.id, name: server.name || server.id })),
      ];
    },
    onChange: (available) => {
      settings.update = { visible: updatePanel.visible(), available };
      syncSettings();
    },
  });
  document.querySelector("#update-close").addEventListener("click", () => document.querySelector("#update-dialog").close());

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
