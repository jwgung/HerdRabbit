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
};
export const NOTES = {
  plugin_id: "notes", name: "Notes", version: "0.2.0", enabled: false, description: "Pane notes",
  source: { kind: "github", owner: "someone", repo: "herdr-notes", requested_ref: "main", resolved_commit: "1234567890abcdef1234567890abcdef12345678" },
};
export const LINKED = { plugin_id: "local-tool", name: "Local tool", version: "0.1.0", enabled: true, source: { kind: "local", path: "/home/me/tool" } };

// A Herdr that answers list from `plugins` and records every other command;
// `hold` keeps a change running until it is released.
export function fakeHerdr(plugins = [HERDRABBIT, NOTES, LINKED], { fail = null, hold = false } = {}) {
  const calls = [];
  let release = () => {};
  const run = async (args, options) => {
    calls.push({ args, timeout: options.timeout });
    if (args[1] === "list") return { code: 0, stdout: pluginList(plugins), stderr: "", timedOut: false };
    if (hold) await new Promise((resolve) => { release = resolve; });
    if (fail) return { code: 1, stdout: "", stderr: `progress\n${fail}\n`, timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { calls, run, release: () => release() };
}

