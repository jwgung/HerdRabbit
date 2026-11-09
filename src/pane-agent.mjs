// The agent the snapshot names for the pane, lower case, or null.
export function paneAgentName(pane) {
  const reported = pane?.agent_session && typeof pane.agent_session === "object" ? pane.agent_session : null;
  const name = [pane?.agent, reported?.agent].find((value) => typeof value === "string" && value.trim());
  return name ? name.trim().toLowerCase() : null;
}

// The pane's foreground processes ({ pid, argv, … }) by herdr's process info;
// none when this herdr cannot tell or the call fails.
export async function paneForegroundProcesses(herdr, paneId) {
  if (typeof herdr?.paneProcessInfo !== "function") return [];
  try {
    const info = await herdr.paneProcessInfo(paneId);
    const processes = info?.process_info?.foreground_processes ?? info?.foreground_processes ?? [];
    return Array.isArray(processes) ? processes : [];
  } catch {
    return [];
  }
}
