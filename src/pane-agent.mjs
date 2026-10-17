// The agent the snapshot names for the pane, lower case, or null.
export function paneAgentName(pane) {
  const reported = pane?.agent_session && typeof pane.agent_session === "object" ? pane.agent_session : null;
  const name = [pane?.agent, reported?.agent].find((value) => typeof value === "string" && value.trim());
  return name ? name.trim().toLowerCase() : null;
}
