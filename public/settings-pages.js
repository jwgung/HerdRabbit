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
  { id: "plugins", title: "Plugins" },
  // Herdr's own settings, per machine (channel, integrations, config.toml):
  // only with sign-in on, as each changes what Herdr runs.
  { id: "herdr", title: "Herdr" },
  // HerdRabbit's and Herdr's updates on every machine (no sign-in needed),
  // and the plugins' where Plugins shows.
  { id: "updates", title: "Updates" },
  // The versions this machine runs.
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
