// The pages of the settings screen (⚙ at the foot of the sidebar), in the
// order its list shows them. public/app/settings.js draws them.
export const SETTINGS_PAGES = Object.freeze([
  { id: "appearance", title: "Appearance" },
  { id: "chat", title: "Chat" },
  { id: "terminal", title: "Terminal & keys" },
  { id: "notifications", title: "Notifications" },
  // Sign-in belongs to the HerdRabbit the browser talks to: only with it on.
  { id: "security", title: "Security" },
  // Only where this HerdRabbit can connect to other PCs.
  { id: "pcs", title: "PCs" },
  // Herdr's plugins, per machine: only with sign-in on, as a plugin runs code.
  // HerdRabbit's own update is its row there, and Update all.
  { id: "plugins", title: "Plugins" },
  // Herdr's own settings, per machine (its update, channel, integrations,
  // config.toml): only with sign-in on, as each changes what Herdr runs.
  { id: "herdr", title: "Herdr" },
  // The versions this machine runs, and, where Plugins and Herdr are not
  // shown, this PC's HerdRabbit and Herdr updates.
  { id: "about", title: "About" },
].map((page) => Object.freeze(page)));

export function settingsPageTitle(id) {
  return SETTINGS_PAGES.find((page) => page.id === id)?.title ?? null;
}

// The pages shown: Security with sign-in on, PCs where Connect PC is, and
// Plugins and Herdr with sign-in on where this HerdRabbit can manage them.
export function settingsPageList({ security = false, pcs = false, plugins = false, herdr = false } = {}) {
  return SETTINGS_PAGES.filter((page) => (page.id !== "security" || security) && (page.id !== "pcs" || pcs) &&
    (page.id !== "plugins" || (plugins && security)) && (page.id !== "herdr" || (herdr && security)));
}

// The line under the notifications switch, from pushButtonPresentation.
export function notificationStateText(presentation) {
  if (!presentation || presentation.hidden) return "Notifications aren't supported in this browser.";
  if (presentation.state === "enabled") return "On: this browser is told when an agent needs you or is done.";
  if (presentation.state === "denied") return "Blocked: allow notifications for this site in your browser settings.";
  return "Off.";
}

// The counts beside Plugins and Herdr in the list: per PC checked (the
// Update window panel's checks), a newer HerdRabbit counts for Plugins and
// a newer Herdr for Herdr; `pluginUpdates` adds each machine's plugins with
// a new version that Plugins has read.
export function updateBadges(checks = [], pluginUpdates = []) {
  const usable = [...checks].filter((check) => check?.supported === true);
  return {
    plugins: usable.filter((check) => check.available === true).length +
      [...pluginUpdates].reduce((sum, count) => sum + (Number.isInteger(count) && count > 0 ? count : 0), 0),
    herdr: usable.filter((check) => check.herdr?.available === true).length,
  };
}
