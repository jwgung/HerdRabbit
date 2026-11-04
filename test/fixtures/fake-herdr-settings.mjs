import { readFile } from "node:fs/promises";

// Herdr 0.9.5's `channel`, `integration`, `config check`, `--help`,
// `--default-config` and `server reload-config`, for HerdrSettings tests and
// browser checks. Every call is recorded with the HERDR_CONFIG_PATH it ran
// with. `config check` reads that file: a line `[ui` (an open table header)
// or `onboarding = 3` is an error, as Herdr says it.
export const STATUS_OUTPUT = `pi: not installed (/home/me/.pi/agent/extensions/herdr-agent-state.ts)
claude: current (v11) (/home/me/.claude/hooks/herdr-agent-state.sh)
codex: current (v10) (/home/me/.codex/herdr-agent-state.sh)
opencode: needs repair (v13) (/home/me/.config/opencode/plugins/herdr-agent-state.js)
antigravity-cli: outdated (v2 < v4) (/home/me/.gemini/config/hooks/herdr-agent-state.sh)
letta (experimental): not installed (/home/me/.letta/hooks/herdr-agent-session.sh)
`;

export const DEFAULT_CONFIG = `# herdr configuration
# Place this file at ~/.config/herdr/config.toml

[update]
# channel = "stable"
`;

export function fakeHerdrSettings({ configPath, channel = "stable", reloadFails = false } = {}) {
  const state = {
    channel, reloadFails, calls: [], holdChannel: false, release: null,
    integrations: new Map([["pi", "not installed"], ["claude", "current (v11)"], ["codex", "current (v10)"],
      ["opencode", "needs repair (v13)"], ["antigravity-cli", "outdated (v2 < v4)"], ["letta", "not installed"]]),
  };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
  const run = async (args, { env } = {}) => {
    state.calls.push({ args, configPath: env?.HERDR_CONFIG_PATH ?? null });
    const [command, sub, target] = args;
    if (command === "--help") return ok(`herdr — terminal workspace manager\n\nConfig: ${configPath}\nLogs:   /home/me/.config/herdr/herdr.log\n`);
    if (command === "--default-config") return ok(DEFAULT_CONFIG);
    if (command === "channel" && sub === "show") return ok(`${state.channel}\n`);
    if (command === "channel" && sub === "set") {
      if (state.holdChannel) await new Promise((resolve) => { state.release = resolve; });
      state.channel = target;
      return ok(`update channel set to ${target}\n`);
    }
    if (command === "integration" && sub === "status") {
      return ok([...state.integrations].map(([name, value]) =>
        `${name}${name === "letta" ? " (experimental)" : ""}: ${value} (/home/me/.${name}/herdr-agent-state.sh)`).join("\n"));
    }
    if (command === "integration" && (sub === "install" || sub === "uninstall")) {
      if (!state.integrations.has(target)) return { code: 2, stdout: "", stderr: `error: invalid value '${target}' for '<TARGET>'\n`, timedOut: false };
      state.integrations.set(target, sub === "install" ? "current (v1)" : "not installed");
      return ok(`${sub}ed ${target} integration at /home/me/.${target}/herdr-agent-state.sh\n`);
    }
    if (command === "config" && sub === "check") {
      const path = env?.HERDR_CONFIG_PATH ?? configPath;
      let text = "";
      try { text = await readFile(path, "utf8"); } catch { return ok("config: ok\n"); }
      if (/^\[ui\s*$/mu.test(text)) {
        return { code: 1, stdout: "config: issues found\nconfig parse error: TOML parse error at line 4, column 4\n  |\n4 | [ui\n  |    ^\ninvalid table header\n; using defaults\n", stderr: "", timedOut: false };
      }
      if (/^onboarding = 3$/mu.test(text)) {
        return { code: 1, stdout: `config: issues found\nconfig parse error in ${path}: invalid type: integer \`3\`, expected a boolean\n`, stderr: "", timedOut: false };
      }
      return ok("config: ok\n");
    }
    if (command === "server" && sub === "reload-config") {
      return state.reloadFails
        ? { code: 1, stdout: "", stderr: "error: no running herdr server at /home/me/.config/herdr/herdr.sock\n", timedOut: false }
        : ok("");
    }
    return { code: 2, stdout: "", stderr: `error: unexpected ${args.join(" ")}\n`, timedOut: false };
  };
  return { state, run };
}
