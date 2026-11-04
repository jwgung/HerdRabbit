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
