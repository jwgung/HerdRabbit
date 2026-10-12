// Only what needs the person: an agent asking, or one that finished. Idle and
// unknown say nothing they have to act on.
const NOTIFIABLE_STATES = new Set(["blocked", "done"]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function idOf(record, ...keys) {
  for (const key of keys) {
    if (typeof record?.[key] === "string") return record[key];
  }
  return "";
}

function firstLabel(record, keys, fallback = "") {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return fallback;
}

function statusOf(agent, pane) {
  return firstLabel(agent, ["agent_status", "state"],
    firstLabel(pane, ["agent_status", "agent_state"], "unknown"));
}

function sequenceOf(agent, pane) {
  for (const record of [agent, pane]) {
    if (Number.isSafeInteger(record?.state_change_seq) && record.state_change_seq >= 0) {
      return record.state_change_seq;
    }
  }
  for (const record of [agent, pane]) {
    if (Number.isSafeInteger(record?.revision) && record.revision >= 0) {
      return record.revision;
    }
  }
  return 0;
}

function bodyFor(status) {
  if (status === "done") return "Task completed.";
  return "Waiting for your input.";
}

function shouldNotify(previous, current, hasPendingRequest) {
  if (!NOTIFIABLE_STATES.has(current.status)) {
    return false;
  }
  const requestFinishedBetweenPolls = hasPendingRequest &&
    previous.sequence !== current.sequence;
  return previous.status !== current.status || requestFinishedBetweenPolls;
}

function recordsForSnapshot(snapshot) {
  const workspaces = array(snapshot?.workspaces);
  const tabs = array(snapshot?.tabs);
  const panes = array(snapshot?.panes);
  const agents = array(snapshot?.agents);
  const workspaceById = new Map(
    workspaces.map((workspace) => [idOf(workspace, "workspace_id", "id"), workspace]),
  );
  const tabById = new Map(
    tabs.map((tab) => [idOf(tab, "tab_id", "id"), tab]),
  );
  const agentByPaneId = new Map(
    agents.map((agent) => [idOf(agent, "pane_id", "paneId"), agent]),
  );

  return panes.map((pane) => {
    const paneId = idOf(pane, "pane_id", "id");
    const tab = tabById.get(idOf(pane, "tab_id", "tabId"));
    const workspaceId = idOf(
      pane,
      "workspace_id",
      "workspaceId",
    ) || idOf(tab, "workspace_id", "workspaceId");
    const workspace = workspaceById.get(workspaceId);
    const agent = agentByPaneId.get(paneId);
    return {
      paneId,
      serverLabel: array(snapshot.servers).length > 1 ? pane.server_name : "",
      status: statusOf(agent, pane),
      sequence: sequenceOf(agent, pane),
      projectLabel: firstLabel(workspace, ["label", "name"], "Project"),
      tabLabel: firstLabel(tab, ["label", "name"], "Tab"),
    };
  }).filter((record) => record.paneId !== "");
}

function subscriptionAvailable(push) {
  return typeof push?.hasSubscriptions === "function"
    ? push.hasSubscriptions()
    : push?.hasSubscriptions === true;
}

export class AgentNotificationMonitor {
  constructor({
    herdr = null,
    push,
    pollIntervalMs = 2_000,
    logger = console,
  } = {}) {
    if (!push) throw new TypeError("push service is required");
    this.herdr = herdr;
    this.push = push;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.previousStates = new Map();
    this.pendingRequests = new Set();
    this.timer = null;
    this.pollBusy = false;
  }

  recordRequest(paneId, request) {
    if (
      typeof paneId === "string" &&
      paneId !== "" &&
      typeof request === "string" &&
      request.trim() !== ""
    ) {
      this.pendingRequests.add(paneId);
    }
  }

  async observeSnapshot(snapshot) {
    const records = recordsForSnapshot(snapshot);
    const livePaneIds = new Set(records.map(({ paneId }) => paneId));
    const notifications = [];

    for (const record of records) {
      const previous = this.previousStates.get(record.paneId);
      this.previousStates.set(record.paneId, {
        status: record.status,
        sequence: record.sequence,
      });
      if (!previous || !shouldNotify(
        previous,
        record,
        this.pendingRequests.has(record.paneId),
      )) continue;

      notifications.push({
        title: [record.serverLabel, record.projectLabel, record.tabLabel].filter(Boolean).join(" · "),
        body: bodyFor(record.status),
        tag: `herd-rabbit:${record.paneId}`,
        data: {
          paneId: record.paneId,
          status: record.status,
          url: `/?${new URLSearchParams({ pane: record.paneId })}`,
        },
      });
      this.pendingRequests.delete(record.paneId);
    }

    for (const paneId of this.previousStates.keys()) {
      if (!livePaneIds.has(paneId)) {
        this.previousStates.delete(paneId);
        this.pendingRequests.delete(paneId);
      }
    }

    if (!subscriptionAvailable(this.push)) return;
    await Promise.all(notifications.map((notification) => this.push.send(notification)));
  }

  async poll() {
    if (this.pollBusy || !this.herdr || !subscriptionAvailable(this.push)) return;
    this.pollBusy = true;
    try {
      await this.observeSnapshot(await this.herdr.snapshot());
    } catch (error) {
      this.logger.error?.("notification poll failed", { message: error.message });
    } finally {
      this.pollBusy = false;
    }
  }

  start() {
    if (this.timer || !this.herdr) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
