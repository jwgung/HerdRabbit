import { createIcon } from "./dom.js?v=1.4.23";
import { createUpdatePanel } from "../app-update.js?v=1.4.23";
import { writeGridFit } from "../terminal-preference.js?v=1.4.23";
import { applicationServerKeyBytes, pushButtonPresentation } from "../push-notifications.js?v=1.4.23";

const SUN_ICON = [
  "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
  "M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
];
const MOON_ICON = ["M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z"];
const BELL_ICON = ["M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8Z", "M10 20h4"];
const KEYBOARD_ICON = ["M2.5 6h19v12h-19z", "M6 9.5h.01M9 9.5h.01M12 9.5h.01M15 9.5h.01M18 9.5h.01M6 12.5h.01M18 12.5h.01M8.5 15h7"];
const PASSKEY_ICON = ["M8 15a4 4 0 1 1 3.9-5H21v3h-2v2h-3v-2h-4.1A4 4 0 0 1 8 15Z", "M8 11h.01"];
const DEVICES_ICON = ["M4 5h16v10H4z", "M8 19h8", "M12 15v4"];
const UPDATE_ICON = ["M12 3v12", "M7 10l5 5 5-5", "M5 20h14"];
const RETURN_ICON = ["M20 5v6a4 4 0 0 1-4 4H5", "M9 11l-4 4 4 4"];
const FIT_PANES_ICON = ["M3 4h18v16H3z", "M12 4v16", "M12 12h9"];
const GEAR_ICON = [
  "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
];

// The settings menu, push notifications and the Update window. `deps` hands in
// what lives in app.js; `paneGrid` is read through a getter because it is made
// further down app.js than this is called.
export function createSettingsMenu(deps) {
  const {
    state, elements, api, snapshotRecords, setFeedback, panePreferenceStorage, desktopMedia,
    sidebarActionMenu, closeMobileSidebar, openKeyBarDialog, showPasskeys, showSessions,
  } = deps;

  // The ⚙ menu at the foot of the sidebar: what belongs to this browser rather
  // than to a machine. Its items are built once and updated in place, so the
  // menu can stay open while the theme or the permission changes under it.
  const settingsMenu = {
    details: null,
    themeLabel: "Switch to light mode",
    themeIcon: SUN_ICON,
    push: null,
    // In-app update: whether the Update item shows, and whether some PC has a
    // newer version (a dot on the ⚙ button).
    update: { visible: false, available: false },
  };

  function buildSettingsMenu() {
    settingsMenu.details = sidebarActionMenu({
      id: "settings",
      label: "Settings",
      className: "settings-menu",
      summaryClass: "settings-button",
      icon: GEAR_ICON,
      // Any class but the default `more-icon`, whose thick stroke is for dots.
      iconClass: "settings-icon",
      // The menu opens upward from the footer; the top layer keeps it from being
      // cut off by the sidebar.
      escapesOverflow: true,
      actions: [
        { key: "notifications", label: "Notifications", paths: BELL_ICON, onSelect: () => void togglePushNotifications() },
        { key: "theme", label: "Theme", paths: SUN_ICON, onSelect: () => window.herdrTheme?.set(window.herdrTheme.current() === "dark" ? "light" : "dark") },
        { separator: true, key: "separator-tools" },
        {
          key: "keys",
          label: "Edit keys",
          paths: KEYBOARD_ICON,
          onSelect: () => {
            // on a phone the editor takes the screen; the sidebar it was opened from steps aside
            if (!desktopMedia.matches) closeMobileSidebar();
            openKeyBarDialog();
          },
        },
        {
          // Wide screens only: whether a Herdr grid's cells size their panes to
          // this window (on) or keep Herdr's sizes and scale their text (off).
          key: "grid-fit",
          label: "Fit panes to this window",
          paths: FIT_PANES_ICON,
          onSelect: () => {
            deps.paneGrid.setFit(!deps.paneGrid.fit);
            writeGridFit(panePreferenceStorage, deps.paneGrid.fit);
            syncSettingsMenu();
          },
        },
        {
          // A Herdr grid whose text size was chosen by hand: back to the largest that fits.
          key: "grid-font",
          label: "Reset text size",
          paths: RETURN_ICON,
          onSelect: () => deps.paneGrid.resetFont(),
        },
        { key: "update", label: "Update", paths: UPDATE_ICON, onSelect: () => updatePanel.open() },
        { separator: true, key: "separator-security" },
        {
          key: "passkeys",
          label: "Passkeys",
          paths: PASSKEY_ICON,
          onSelect: () => void showPasskeys(),
        },
        {
          key: "sessions",
          label: "Signed-in devices",
          paths: DEVICES_ICON,
          onSelect: () => void showSessions(),
        },
      ],
    });
    elements.navigatorFooter.append(settingsMenu.details);
    // Whether this is a wide screen can change with the window, so the items
    // that depend on it are shown or hidden again each time the menu opens.
    settingsMenu.details.addEventListener("toggle", () => {
      if (settingsMenu.details.open) syncSettingsMenu();
    });
    syncSettingsMenu();
  }

  function syncSettingsMenu() {
    const menu = settingsMenu.details;
    if (!menu) return;
    const item = (key) => menu.querySelector(`[data-action="${key}"]`);
    const setLabel = (button, text, icon) => {
      button.querySelector("span").textContent = text;
      if (icon) button.querySelector("svg").replaceWith(createIcon(icon));
    };
    const gridFit = item("grid-fit");
    gridFit.hidden = !desktopMedia.matches;
    gridFit.setAttribute("role", "menuitemcheckbox");
    gridFit.setAttribute("aria-checked", String(deps.paneGrid.fit));
    setLabel(gridFit, "Fit panes to this window");
    // On or off shows as the item's colour, as Notifications does.
    gridFit.dataset.toggle = deps.paneGrid.fit ? "on" : "off";
    gridFit.title = deps.paneGrid.fit
      ? "On: a grid sizes each pane to its cell (other screens on those panes see that size while it is open)"
      : "Off: a grid keeps each pane at Herdr's size and scales its text to fit";
    gridFit.setAttribute("aria-label", `Fit panes to this window, ${deps.paneGrid.fit ? "on" : "off"}`);
    item("grid-font").hidden = deps.paneGrid.fit || deps.paneGrid.manualFont === null;
    const push = settingsMenu.push;
    const notifications = item("notifications");
    notifications.hidden = !push || push.hidden;
    if (push && !push.hidden) {
      // On, off or blocked shows as the item's colour; the words go to the
      // tooltip and to assistive technology.
      notifications.dataset.notify = push.state === "enabled" ? "on" : push.state === "denied" ? "blocked" : "off";
      notifications.setAttribute("role", "menuitemcheckbox");
      notifications.setAttribute("aria-checked", String(push.state === "enabled"));
      notifications.disabled = push.disabled;
      notifications.title = push.label;
      notifications.setAttribute("aria-label", push.label);
    }
    const theme = item("theme");
    setLabel(theme, settingsMenu.themeLabel, settingsMenu.themeIcon);
    const update = item("update");
    update.hidden = !settingsMenu.update.visible;
    setLabel(update, settingsMenu.update.available ? "Update available" : "Update");
    update.classList.toggle("has-update", settingsMenu.update.available);
    const summary = menu.querySelector("summary");
    summary.classList.toggle("has-update", settingsMenu.update.available);
    summary.setAttribute("aria-label", settingsMenu.update.available ? "Settings (update available)" : "Settings");
    // Sign-in belongs to the HerdRabbit the browser is talking to; a linked
    // machine has none. Removing needs no WebAuthn, so a browser without it still
    // gets the list: that is how a lost device's passkey is taken off elsewhere.
    for (const key of ["passkeys", "sessions"]) item(key).hidden = !state.authRequired;
    menu.querySelector('[data-separator="separator-security"]').hidden = !state.authRequired;
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
      settingsMenu.update = { visible: updatePanel.visible(), available };
      syncSettingsMenu();
    },
  });
  document.querySelector("#update-close").addEventListener("click", () => document.querySelector("#update-dialog").close());

  function syncThemeItem() {
    const currentTheme = window.herdrTheme?.current() || "dark";
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    const label = nextTheme === "light" ? "Switch to light mode" : "Switch to dark mode";
    settingsMenu.themeLabel = label;
    settingsMenu.themeIcon = nextTheme === "light" ? SUN_ICON : MOON_ICON;
    syncSettingsMenu();
  }

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
    const presentation = pushButtonPresentation({
      supported,
      permission: supported ? Notification.permission : "default",
      subscribed: state.pushSubscription !== null,
      busy: state.pushBusy,
    });
    settingsMenu.push = presentation;
    syncSettingsMenu();
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
    settingsMenu, buildSettingsMenu, syncSettingsMenu, updatePanel, syncThemeItem,
    renderNotificationItem, syncPushSubscription,
  };
}
