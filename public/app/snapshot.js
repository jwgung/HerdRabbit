import { agentCompletionIdentity, agentStatus, visibleAgentStatus } from "../ui-model.js?v=1.4.51";
import { writeAcknowledgedCompletions } from "../completion-preference.js?v=1.4.51";
import { array } from "./dom.js?v=1.4.51";

export function idOf(record, ...keys) {
  for (const key of keys) {
    if (typeof record?.[key] === "string") {
      return record[key];
    }
  }
  return "";
}

// What the page knows of Herdr: the records of the last snapshot, and the
// completions this browser has seen. `state` is the page's own object; these
// read it as it is when they are called.
export function createSnapshotModel({ state, storage }) {
  function snapshotRecords() {
    const snapshot = state.snapshot || {};
    return {
      servers: array(snapshot.servers),
      herdrSessions: array(snapshot.herdr_sessions),
      workspaces: array(snapshot.workspaces),
      tabs: array(snapshot.tabs),
      panes: array(snapshot.panes),
      agents: array(snapshot.agents),
    };
  }

  // The running Herdr session to use on `serverId`: the selected pane's, when it
  // is on that machine, else the machine's default.
  function herdrSessionForServer(serverId) {
    const { herdrSessions: all, panes } = snapshotRecords();
    if (all.length === 0) {
      return serverId === "local"
        ? { session_id: null, name: "default", running: true, available: true }
        : null;
    }
    const herdrSessions = all.filter((session) => (session.server_id || "local") === serverId);
    const selectedPane = panes.find(
      (pane) => idOf(pane, "pane_id", "id") === state.selectedPaneId,
    );
    const selectedSessionId = idOf(
      selectedPane,
      "herdr_session_id",
      "herdrSessionId",
    );
    return herdrSessions.find(
      (session) => idOf(session, "session_id", "id") === selectedSessionId &&
        session.running === true && session.available === true,
    ) || herdrSessions.find(
      (session) => session.machine_default === true && session.running === true &&
        session.available === true,
    ) || herdrSessions.find(
      (session) => session.running === true && session.available === true,
    ) || null;
  }

  function agentForPane(paneId) {
    return snapshotRecords().agents.find(
      (agent) => idOf(agent, "pane_id", "paneId") === paneId,
    );
  }

  function visibleStatusForPane(paneId, agent, pane) {
    return visibleAgentStatus(
      agent,
      pane,
      state.acknowledgedCompletions.get(paneId) || null,
    );
  }

  function acknowledgePaneCompletion(paneId) {
    const pane = snapshotRecords().panes.find(
      (item) => idOf(item, "pane_id", "id") === paneId,
    );
    const agent = agentForPane(paneId);
    if (agentStatus(agent, pane) !== "done") return;
    const identity = agentCompletionIdentity(agent, pane);
    if (!identity || state.acknowledgedCompletions.get(paneId) === identity) return;
    state.acknowledgedCompletions.set(paneId, identity);
    writeAcknowledgedCompletions(
      storage,
      state.acknowledgedCompletions,
    );
  }

  function pruneAcknowledgedCompletions() {
    const { panes } = snapshotRecords();
    const liveDonePanes = new Set();
    for (const pane of panes) {
      const paneId = idOf(pane, "pane_id", "id");
      if (agentStatus(agentForPane(paneId), pane) === "done") {
        liveDonePanes.add(paneId);
      }
    }
    let changed = false;
    for (const paneId of state.acknowledgedCompletions.keys()) {
      if (!liveDonePanes.has(paneId)) {
        state.acknowledgedCompletions.delete(paneId);
        changed = true;
      }
    }
    if (changed) {
      writeAcknowledgedCompletions(
        storage,
        state.acknowledgedCompletions,
      );
    }
  }

  return {
    snapshotRecords, herdrSessionForServer,
    agentForPane, visibleStatusForPane, acknowledgePaneCompletion, pruneAcknowledgedCompletions,
  };
}
