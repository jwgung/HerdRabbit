import { herdrBlockedText, herdrErrorText, herdrRunSummary } from "../app-update.js?v=1.4.52";

// Settings → Herdr without the page: how an integration reads and what its
// button does. The server says each integration's state as Herdr does
// (src/herdr-settings.mjs): not_installed, current, outdated, needs_repair,
// or other with Herdr's own words in `label`.

// The line under an integration's name.
export function integrationStateText(item) {
  const detail = item?.detail ? ` (${item.detail})` : "";
  switch (item?.state) {
    case "current": return `Installed${detail}`;
    case "not_installed": return "Not installed";
    case "outdated": return `Outdated${detail}`;
    case "needs_repair": return `Needs repair${detail}`;
    default: return `${item?.label ?? "Unknown"}${detail}`;
  }
}

// The action an integration's button runs: install a missing, outdated or
// broken one (Herdr's install writes the current version), uninstall one
// that is current. Answers { action, label }.
export function integrationAction(item) {
  if (item?.state === "current") return { action: "uninstall", label: "Uninstall…" };
  if (item?.state === "outdated") return { action: "install", label: "Update…" };
  if (item?.state === "needs_repair") return { action: "install", label: "Repair…" };
  return { action: "install", label: "Install…" };
}

// The question a change asks before it runs.
export function integrationConfirmText(item, action, machine) {
  return action === "uninstall"
    ? `Uninstall Herdr's ${item.name} integration on ${machine}? Herdr removes its hook, and ${item.name} stops reporting its state to Herdr.`
    : `Install Herdr's ${item.name} integration on ${machine}? Herdr writes its hook into ${item.name}'s settings there.`;
}

// Herdr's row at the head of the page, from its machine's update check (the
// `check` of the Update window's panel, app-update.js) and its run:
// { text, error, available, canUpdate, notes, latest }. The text is its
// versions and channel ("0.9.12 → 0.9.14 · Stable"), why it cannot update,
// or how a run goes. `notes` is what is new in the newer Herdr, when told.
export function herdrUpdateLine(check, { run = null, error = null } = {}) {
  const none = (text, isError = false) => ({ text, error: isError, available: false, canUpdate: false, notes: null, latest: null });
  if (!check) return none(error ?? "Not checked yet.", Boolean(error));
  if (check.supported !== true) return none("Herdr cannot be updated from the page there.");
  const herdr = check.herdr;
  if (!herdr) return none("Could not check Herdr.", true);
  if (herdr.error) return none(herdrErrorText(herdr.error), true);
  const channel = herdr.channel === "preview" ? "Preview" : "Stable";
  const available = herdr.available === true;
  const latest = herdr.latest ?? null;
  const versions = available
    ? `${herdr.current ?? "unknown"} → ${latest ?? "unknown"} · ${channel}`
    : `${herdr.current ?? "unknown"} · Up to date · ${channel}`;
  const line = { available, canUpdate: available && !herdr.blocked, notes: available && herdr.notes ? herdr.notes : null, latest };
  const running = run?.tracking ? herdrRunSummary(run) : null;
  if (running) return { ...line, text: running.text, error: running.error, canUpdate: false };
  if (available && herdr.blocked) return { ...line, text: `${versions}. ${herdrBlockedText(herdr.blocked)}`, error: true };
  return { ...line, text: versions, error: false };
}
