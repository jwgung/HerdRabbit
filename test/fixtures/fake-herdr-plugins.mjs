// A stand-in for `herdr plugin ...` (src/herdr-plugins.mjs's `run`), shared by
// the plugin tests and scripts/check-plugins.mjs.

// `herdr plugin list --json` as Herdr 0.9.5 answers it.
export function pluginList(plugins) {
  return JSON.stringify({ id: "cli:plugin", result: { type: "plugin_list", plugins } });
}

export const HERDRABBIT = {
  plugin_id: "herdrabbit", name: "HerdRabbit", version: "1.4.27", enabled: true, description: "Phone access",
  plugin_root: "/home/me/.config/herdr/plugins/x/checkout",
  source: { kind: "github", owner: "ultivis-iot", repo: "HerdRabbit", requested_ref: "v1.4.27", resolved_commit: "a074fe0dbe4c3d96ed53fdeb325bd6d6cd1e080e", managed_path: "/secret" },
  actions: [{ id: "restart", title: "HerdRabbit: restart", contexts: ["workspace"], command: ["node", "scripts/plugin.mjs", "restart"] }],
  panes: [{ id: "connect", title: "HerdRabbit: connect", placement: "overlay", command: ["node", "scripts/plugin.mjs", "connect"] }],
};
export const NOTES = {
  plugin_id: "notes", name: "Notes", version: "0.2.0", enabled: false, description: "Pane notes",
  source: { kind: "github", owner: "someone", repo: "herdr-notes", requested_ref: "main", resolved_commit: "1234567890abcdef1234567890abcdef12345678" },
};
export const LINKED = {
  plugin_id: "local-tool", name: "Local tool", version: "0.1.0", enabled: true, source: { kind: "local", path: "/home/me/tool" },
  actions: [{ id: "apply", title: "Apply layout", contexts: ["workspace"], command: ["sh", "/home/me/tool/apply.sh"] }],
  panes: [{ id: "board", title: "Board", placement: "overlay", command: ["sh", "/home/me/tool/board.sh"] }],
};

// `herdr plugin log list` entries as Herdr 0.9.5 answers them, oldest first.
export const LOGS = [
  {
    log_id: "plugin-log-3", plugin_id: "local-tool", action_id: "apply", command: ["sh", "/home/me/tool/apply.sh"],
    status: "failed", exit_code: 2, started_unix_ms: 1793774930134, finished_unix_ms: 1793774931325,
    stdout: "\u001b[32mApplying\u001b[0m in /home/me/projects/site\n", stderr: "error: /home/me/tool/layout.json not found\n",
  },
  {
    log_id: "plugin-log-5", plugin_id: "local-tool", event: "startup", command: ["sh", "start.sh"],
    status: "succeeded", exit_code: 0, started_unix_ms: 1793782954522, finished_unix_ms: 1793782955721, stdout: "ready\n", stderr: "",
  },
];

// A Herdr that answers list from `plugins` and records every other command;
// `hold` keeps a change running until it is released.
// `action invoke` answers the running log Herdr starts; `log list` the logs.
export function fakeHerdr(plugins = [HERDRABBIT, NOTES, LINKED], { fail = null, hold = false, logs = LOGS } = {}) {
  const calls = [];
  let release = () => {};
  const run = async (args, options) => {
    calls.push({ args, timeout: options.timeout });
    if (args[1] === "list") return { code: 0, stdout: pluginList(plugins), stderr: "", timedOut: false };
    if (args[1] === "log" && !fail) {
      return { code: 0, stdout: JSON.stringify({ id: "cli:plugin", result: { type: "plugin_log_list", logs } }), stderr: "", timedOut: false };
    }
    if (args[1] === "action" && !fail) {
      const log = { log_id: "plugin-log-9", plugin_id: args[5], action_id: args[3], command: ["sh"], status: "running", started_unix_ms: 1793795003264 };
      return { code: 0, stdout: JSON.stringify({ id: "cli:plugin", result: { type: "plugin_action_invoked", log } }), stderr: "", timedOut: false };
    }
    if (hold) await new Promise((resolve) => { release = resolve; });
    if (fail) return { code: 1, stdout: "", stderr: `progress\n${fail}\n`, timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { calls, run, release: () => release() };
}


// This PC's Herdr client as the manager uses it for a pane
// (src/herdr-bridge-client.mjs): it records each call; `missing` panes are gone.
export function fakePaneHerdr({ missing = [], fail = null } = {}) {
  const calls = [];
  const check = (paneId) => {
    if (missing.includes(paneId)) throw Object.assign(new Error("That pane is no longer open"), { code: "pane_not_found" });
    if (fail) throw Object.assign(new Error(fail), { code: "plugin_command_failed" });
  };
  return {
    calls,
    async pluginActionInvoke(paneId, pluginId, actionId) {
      calls.push(["invoke", paneId, pluginId, actionId]);
      check(paneId);
      return { log_id: "plugin-log-10", plugin_id: pluginId, action_id: actionId, command: ["sh"], status: "running", started_unix_ms: 1793795003264 };
    },
    async pluginPaneOpen(paneId, pluginId, entrypoint) {
      calls.push(["open", paneId, pluginId, entrypoint]);
      check(paneId);
      return { pane_id: "hs_ZGVmYXVsdA~w1:p9", tab_id: "hs_ZGVmYXVsdA~w1:t9" };
    },
  };
}
