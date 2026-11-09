// The `/` commands a pane's agent takes, for the composer's command list:
// Claude Code's, Codex's, OpenCode's, Kiro's and Antigravity's own, and the
// skills, commands and prompts the user, the pane's project and the installed
// Claude plugins add.
//
// Only names and one-line descriptions ever leave here. What is opened is
// limited to the Markdown files those commands live in (their frontmatter,
// the first few KB) and Claude's installed_plugins.json -- never a
// transcript, history, settings or sign-in file. Every path is compared by
// its real path: an entry that leads out of the folder it was found in (a
// link elsewhere) is skipped, and HerdRabbit's protected paths are refused
// whatever leads to them.
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { agentExecutable } from "./agent-commands.mjs";
import { COMMAND_NAME, commandLine } from "./command-names.mjs";
import { paneAgentName } from "./pane-agent.mjs";
import { defaultProtectedPaths } from "./protected-paths.mjs";

export const COMMAND_AGENTS = Object.freeze(["claude", "codex", "opencode", "kiro", "agy"]);
// A command file larger than this is listed by its name alone, unread.
export const MAX_COMMAND_FILE_BYTES = 64 * 1024;
// Of a command file, only this much is read: the frontmatter and the first lines.
export const FRONTMATTER_READ_BYTES = 4 * 1024;
export const MAX_LISTED_COMMANDS = 500;
// Folders below a commands folder followed at most (`a:b:c:name`).
export const MAX_COMMAND_DEPTH = 3;
// Folder entries looked at under one skills or commands folder, however many
// turn out to be commands: a huge folder costs no more than this, and takes
// nothing from the folders after it.
export const MAX_SCANNED_ENTRIES = 5000;
// and under all of them together, in one listing
export const MAX_TOTAL_SCANNED_ENTRIES = 20_000;
export const COMMANDS_CACHE_MS = 10_000;
// An OpenCode switch in the environment, as OpenCode reads one.
const switchedOn = (value) => typeof value === "string" && /^(1|true|yes|on|y)$/iu.test(value.trim());
const MAX_MANIFEST_BYTES = 256 * 1024;
// Folders above a pane's folder looked at for the project's root.
const MAX_PROJECT_LEVELS = 8;
// OpenCode looks in every folder from the pane's up to the checkout's root,
// or up to `/` outside one: here at most this many folders, the pane's own included.
export const MAX_OPENCODE_LEVELS = 32;
// Folders below an OpenCode skills folder followed at most (`skills/a/b/c/d/SKILL.md`).
export const MAX_SKILL_DEPTH = 4;

// Where a listed command comes from. A connected PC naming anything else
// is passed on as "other".
export const COMMAND_SOURCES = Object.freeze(["built-in", "user", "project", "plugin"]);

const builtIn = (entries) => Object.freeze(entries.map(([name, description]) => Object.freeze({ name, description, source: "built-in" })));

// Claude Code's own commands and the skills it bundles, as its commands
// reference lists them (code.claude.com/docs/en/commands, read 2026-11-09
// against Claude Code 2.1.319), the removed ones left out. Some show in Claude
// Code only where they apply: a plan, a platform or a feature switched on.
export const CLAUDE_BUILT_IN_COMMANDS = builtIn([
  ["add-dir", "Add a working directory for file access during the current session"],
  ["advisor", "Turn the advisor tool, which consults a second model, on or off"],
  ["agents", "Remind how to ask Claude to create or manage subagents"],
  ["artifact-capabilities", "Load the reference for what a published artifact can use"],
  ["artifact-diagramming", "Load diagramming guidance for Claude to follow in artifacts"],
  ["artifacts", "List your artifacts and those shared with you, and attach one to the session"],
  ["auto-mode-setup", "Draft autoMode.environment entries from your project and recent sessions"],
  ["autocompact", "Set the auto-compact window"],
  ["autofix-pr", "Spawn a cloud session that pushes fixes to the current branch's PR"],
  ["background", "Detach the current session to run as a background agent"],
  ["batch", "Orchestrate large-scale changes across a codebase in parallel"],
  ["branch", "Create a branch of the current conversation at this point"],
  ["btw", "Ask a side question without adding to the conversation"],
  ["bug", "Report a bug or share your conversation"],
  ["cd", "Move this session to a new working directory, keeping the conversation"],
  ["chrome", "Configure Claude in Chrome settings"],
  ["claude-api", "Load Claude API and Managed Agents reference material for your project's language"],
  ["claude-in-chrome", "Have Claude carry out a task in your browser"],
  ["clear", "Start a new conversation with empty context"],
  ["code-review", "Review the current diff, or a PR, branch or path, for correctness bugs"],
  ["color", "Set the prompt bar color for the current session"],
  ["compact", "Free up context by summarizing the conversation so far"],
  ["config", "Open the Settings interface"],
  ["context", "Visualize current context usage as a colored grid"],
  ["copy", "Copy the last assistant response to clipboard"],
  ["cost", "Show usage (alias of /usage)"],
  ["dataviz", "Design guidance for charts, graphs, and dashboards"],
  ["debug", "Enable debug logging for the current session and troubleshoot from its log"],
  ["deep-research", "Search the web on a question, cross-check sources, and write a cited report"],
  ["design", "Draft UI mockups, screen flows, landing pages, or posters as artboards"],
  ["design-login", "Authorize design-system access for /design-sync with your claude.ai account"],
  ["design-sync", "Upload your repo's React design system to Claude Design"],
  ["desktop", "Continue the current session in the Claude Code Desktop app"],
  ["diff", "Review the changes in your working tree, Claude's edits included"],
  ["doctor", "Diagnose installation, settings, extension, and CLAUDE.md problems"],
  ["effort", "Set the effort level"],
  ["exit", "Exit the CLI"],
  ["export", "Export the current conversation as plain text"],
  ["fast", "Toggle fast mode on or off"],
  ["feedback", "Send product feedback about Claude Code"],
  ["fewer-permission-prompts", "Add an allowlist for your common read-only Bash and MCP tool calls"],
  ["focus", "Toggle the focus view"],
  ["fork", "Copy the current conversation into a new background session and keep working here"],
  ["goal", "Set a goal Claude keeps working toward across turns"],
  ["heapdump", "Write a JavaScript heap snapshot and a memory breakdown"],
  ["help", "Show help and available commands"],
  ["hooks", "View hook configurations"],
  ["ide", "Manage IDE integrations and show status"],
  ["import", "Bring configuration from OpenAI Codex, Gemini CLI, or Cursor into Claude Code"],
  ["init", "Initialize project with a CLAUDE.md guide"],
  ["insights", "Generate an HTML report analyzing your recent sessions on this machine"],
  ["install-github-app", "Install the Claude GitHub App for a repository"],
  ["install-slack-app", "Install the Claude Slack app"],
  ["keybindings", "Open your keyboard shortcuts file"],
  ["list-agents", "List the subagents, teammates, and other sessions Claude can message"],
  ["login", "Sign in to your Anthropic account"],
  ["logout", "Sign out from your Anthropic account"],
  ["loop", "Run a prompt repeatedly while the session stays open"],
  ["mcp", "Manage MCP server connections and OAuth authentication"],
  ["memory", "Edit CLAUDE.md files, enable or disable auto memory, and view auto memory entries"],
  ["mobile", "Show QR code to download the Claude mobile app"],
  ["model", "Switch the AI model and save it as your default for new sessions"],
  ["output-style", "List output styles or switch to one"],
  ["passes", "Share a free week of Claude Code with friends"],
  ["permissions", "Manage allow, ask, and deny rules for tool permissions"],
  ["plan", "Enter plan mode directly from the prompt"],
  ["plugin", "Manage Claude Code plugins"],
  ["plugin-authoring", "Load the reference Claude works from to write a mod"],
  ["powerup", "Discover Claude Code features through quick interactive lessons"],
  ["privacy-settings", "View and update your privacy settings"],
  ["radio", "Open Claude FM lo-fi radio in your browser"],
  ["rate-limit-options", "Show ways to keep working when a claude.ai usage limit blocks a request"],
  ["recap", "Generate a one-line summary of the current session on demand"],
  ["release-notes", "View the changelog in an interactive version picker"],
  ["reload-plugins", "Reload all active plugins to apply pending changes without restarting"],
  ["reload-skills", "Re-scan skill and command directories for skills added or changed on disk"],
  ["remote-control", "Make this session available for Remote Control from claude.ai"],
  ["remote-env", "Choose the default cloud environment for cloud sessions you start from the CLI"],
  ["rename", "Rename the current session and show the name on the prompt bar"],
  ["restart", "Restart Claude Code and resume this session, which applies an installed update"],
  ["resume", "Resume a conversation by ID or name, or open the session picker"],
  ["review", "Review the current diff (alias of /code-review)"],
  ["rewind", "Rewind the conversation and/or code to a previous point"],
  ["run", "Launch and drive your project's app to see a change working"],
  ["run-skill-generator", "Teach /run and /verify how to build, launch, and drive your project's app"],
  ["sandbox", "Toggle sandbox mode"],
  ["schedule", "Create, update, list, or run cloud scheduled tasks"],
  ["scroll-speed", "Adjust mouse wheel scroll speed interactively"],
  ["security-review", "Analyze the changes on your current branch for security vulnerabilities"],
  ["setup-bedrock", "Configure Amazon Bedrock authentication, region, and model pins"],
  ["setup-vertex", "Configure Google Cloud's Agent Platform authentication, project, region, and model pins"],
  ["simplify", "Review the changed code for cleanup opportunities and apply the fixes"],
  ["skill-doctor", "Show what each of your skills costs in context and how often it gets used"],
  ["skills", "List available skills"],
  ["slides", "Make a new presentation as a Claude Slides artifact"],
  ["stats", "Show usage (alias of /usage)"],
  ["status", "Show version, model, account, and connectivity"],
  ["statusline", "Configure Claude Code's status line"],
  ["stickers", "Order Claude Code stickers"],
  ["stop", "Stop the background session you're attached to"],
  ["subtask", "Spawn a forked subagent that inherits the full conversation"],
  ["tasks", "View and manage background work in the current session"],
  ["team-onboarding", "Generate a team onboarding guide from your Claude Code usage history"],
  ["teleport", "Pull a cloud session into this terminal"],
  ["terminal-setup", "Install a Shift+Enter keybinding for newlines"],
  ["theme", "Change the color theme"],
  ["tui", "Set the terminal UI renderer and relaunch into it with your conversation intact"],
  ["ultrareview", "Run a deep, multi-agent code review in a cloud sandbox"],
  ["update-config", "Describe a settings change and have Claude make it"],
  ["upgrade", "Open the upgrade page to switch to a higher plan tier"],
  ["usage", "Show session cost, plan usage limits, and activity stats"],
  ["usage-credits", "Configure usage credits, or request them from your admin, when you hit a limit"],
  ["verify", "Confirm a code change works by building, running, and observing your project's app"],
  ["voice", "Toggle voice dictation, or enable it in a specific mode"],
  ["web-setup", "Connect your GitHub account for cloud sessions using your local gh CLI credentials"],
  ["workflow-authoring", "Load the reference for writing dynamic workflow scripts"],
  ["workflows", "Open the workflow progress view"],
]);

// The Codex CLI's own commands as its 0.167.0 popup names them
// (codex-rs/tui/src/slash_command.rs at rust-v0.167.0, recorded 2026-11-09).
// Left out: /rollout and /test-approval (debug builds only), /debug-m-drop and
// /debug-m-update ("DO NOT USE"), /app (macOS and Windows only), and aliases.
export const CODEX_BUILT_IN_COMMANDS = builtIn([
  ["agents", "Open the agent command center"],
  ["apps", "Manage apps"],
  ["approve", "Approve one retry of a recent auto-review denial"],
  ["archive", "Archive this session"],
  ["btw", "Start a side conversation in an ephemeral fork"],
  ["cd", "Change the current working directory"],
  ["clear", "Clear the terminal and start a new chat"],
  ["compact", "Summarize conversation to prevent hitting the context limit"],
  ["config", "Configure Codex preferences"],
  ["copy", "Copy the last response or part of it"],
  ["daemon", "Manage the local background server"],
  ["daybreak", "Turn Daybreak on or off"],
  ["debug-config", "Show config layers and requirement sources for debugging"],
  ["delete", "Permanently delete this session"],
  ["diff", "Show git diff (including untracked files)"],
  ["exit", "Exit Codex"],
  ["experimental", "Toggle experimental features"],
  ["export", "Export the conversation as markdown"],
  ["feedback", "Send logs to maintainers"],
  ["fork", "Fork the current chat"],
  ["goal", "Set or view the goal for a long-running task"],
  ["hooks", "View and manage lifecycle hooks"],
  ["ide", "Include current selection, open files, and other context from your IDE"],
  ["import", "Import setup, this project, and recent chats from Claude Code"],
  ["init", "Create an AGENTS.md file with instructions for Codex"],
  ["keymap", "Remap TUI shortcuts"],
  ["logout", "Log out of Codex"],
  ["mcp", "List MCP tools; use /mcp verbose or /mcp login <name>"],
  ["memories", "Configure memory use and generation"],
  ["mention", "Mention a file"],
  ["model", "Choose what model and reasoning effort to use"],
  ["new", "Start a new chat during a conversation"],
  ["permissions", "Choose what Codex is allowed to do"],
  ["pets", "Choose or hide the terminal pet"],
  ["plan", "Switch to Plan mode"],
  ["plugins", "Browse plugins"],
  ["presets", "Run or save reusable prompts and slash commands"],
  ["ps", "List background terminals"],
  ["pwd", "Show the current working directory"],
  ["quit", "Exit Codex"],
  ["raw", "Toggle raw scrollback mode for copy-friendly terminal selection"],
  ["recap", "Summarize the current conversation now"],
  ["rename", "Rename the current thread"],
  ["resume", "Resume a saved chat"],
  ["review", "Review my current changes and find issues"],
  ["setup-default-sandbox", "Set up elevated agent sandbox"],
  ["side", "Start a side conversation in an ephemeral fork"],
  ["skills", "Use skills to improve how Codex performs specific tasks"],
  ["status", "Show current session configuration and token usage"],
  ["statusline", "Configure which items appear in the status line"],
  ["stop", "Stop all background terminals"],
  ["subagents", "Switch between this session's subagents"],
  ["theme", "Choose a syntax highlighting theme"],
  ["title", "Configure which items appear in the terminal title"],
  ["tui", "Choose the TUI mode for the next launch"],
  ["usage", "View account usage or use a usage limit reset"],
  ["vim", "Toggle Vim mode for the composer"],
  ["voice", "Start or stop voice; use /voice settings to choose a voice"],
  ["warnings", "View retained warnings and diagnostic details"],
  ["worktree", "Start or continue a conversation in a new worktree"],
]);

// OpenCode's own commands as its 1.19.3 TUI names them (each `/name` and alias,
// listed apart, with the command's title, or its description where it has
// one), the server's `/init` and `/review`, and its built-in skill. A few show
// in OpenCode only when they apply: /variants for a model with variants, /org
// with more than one org, /update where it can update itself, /warp and
// /workspaces with OPENCODE_EXPERIMENTAL_WORKSPACES.
export const OPENCODE_CUSTOMIZE_SKILL_DESCRIPTION = "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.";
export const OPENCODE_BUILT_IN_COMMANDS = builtIn([
  ["agents", "Switch agent"],
  ["clear", "New session (alias of /new)"],
  ["compact", "Compact session"],
  ["connect", "Connect provider"],
  ["continue", "Switch session (alias of /sessions)"],
  ["copy", "Copy session transcript"],
  ["customize-opencode", oneLine(OPENCODE_CUSTOMIZE_SKILL_DESCRIPTION)],
  ["debug", "View debug info"],
  ["diff", "Open diff viewer"],
  ["editor", "Open editor"],
  ["exit", "Exit the app"],
  ["export", "Export session transcript"],
  ["fork", "Fork session"],
  ["help", "Help"],
  ["init", "guided AGENTS.md setup"],
  ["mcps", "Toggle MCPs"],
  ["mo", "Switch model (alias of /models)"],
  ["models", "Switch model"],
  ["move", "Move to another project dir"],
  ["new", "New session"],
  ["org", "Switch org"],
  ["orgs", "Switch org (alias of /org)"],
  ["q", "Exit the app (alias of /exit)"],
  ["quit", "Exit the app (alias of /exit)"],
  ["redo", "Redo"],
  ["rename", "Rename session"],
  ["resume", "Switch session (alias of /sessions)"],
  ["review", "review changes [commit|branch|pr], defaults to uncommitted"],
  ["sessions", "Switch session"],
  ["skills", "Skills"],
  ["status", "View status"],
  ["summarize", "Compact session (alias of /compact)"],
  ["switch-org", "Switch org (alias of /org)"],
  ["themes", "Switch theme"],
  ["thinking", "Expand or collapse thinking"],
  ["timeline", "Jump to message"],
  ["timestamps", "Show or hide timestamps"],
  ["toggle-thinking", "Expand or collapse thinking (alias of /thinking)"],
  ["toggle-timestamps", "Show or hide timestamps (alias of /timestamps)"],
  ["undo", "Undo previous message"],
  ["update", "Update OpenCode"],
  ["variants", "Switch model variant"],
  ["warp", "Change the workspace for the session"],
  ["workspaces", "Manage workspaces"],
]);
// Kiro CLI's own `/` commands, as its menu lists them (kiro-cli 2.35.1,
// recorded 2026-11-01). Its skills and file prompts are found on disk.
export const KIRO_BUILT_IN_COMMANDS = builtIn([
  ["agent", "List or switch agents"],
  ["autonomous", "Turn autonomous mode on or off"],
  ["changelog", "Show recent release notes"],
  ["chat", "Load a previous session, save, or start a new one"],
  ["clear", "Clear the conversation and start a fresh session"],
  ["code", "Code intelligence status, initialization, codebase overview, and documentation"],
  ["compact", "Compact conversation history to reduce context usage"],
  ["config", "View configured agents, MCP servers, powers, steering, skills, and hooks"],
  ["context", "Show or manage context files"],
  ["copy", "Copy last response to clipboard (use /transcript for full conversation)"],
  ["editor", "Open $EDITOR to compose a prompt"],
  ["effort", "List or set the reasoning effort level"],
  ["exit", "Quit the application"],
  ["feedback", "Submit feedback, request features, or report issues"],
  ["fullscreen", "Take over the whole terminal, with mouse scrolling (run again to leave)"],
  ["help", "Show available commands"],
  ["hooks", "View configured hooks"],
  ["knowledge", "Manage knowledge bases"],
  ["mcp", "Show MCP server status"],
  ["memories", "Manage repo-scoped memories from previous sessions"],
  ["model", "List or switch models"],
  ["paste", "Paste image from clipboard"],
  ["plan", "Switch to plan mode to break ideas into an implementation plan"],
  ["powers", "View, install, and uninstall powers"],
  ["prompts", "Select or list available prompts"],
  ["quit", "Quit the application"],
  ["reply", "Reply to the last assistant message in $EDITOR"],
  ["rewind", "Fork the session at an earlier turn"],
  ["sandbox", "View local sandbox settings"],
  ["session-id", "Print the current session ID"],
  ["sessions", "Browse sessions (dashboard); \"/sessions clean\" removes empty ones"],
  ["settings", "Configure theme, terminal, keybindings, and other preferences"],
  ["spec", "List specs, switch to spec mode, or run spec tasks"],
  ["tangent", "Go back, switch to, create, or merge a conversation tangent"],
  ["title", "Set, clear, or show the terminal window title"],
  ["tools", "List available tools"],
  ["transcript", "Open conversation transcript in $PAGER (quit with q)"],
  ["upgrade-agent", "Upgrade V2 agent configs to universal (V2 + V3) format"],
  ["usage", "Show plan usage and billing information"],
]);

// Antigravity CLI's own `/` commands and the skills it ships, as its menu
// lists them (agy 1.4.12, recorded 2026-11-01). An alias shown beside a
// name ("/clear (new)") is left out.
export const AGY_BUILT_IN_COMMANDS = builtIn([
  ["add-dir", "Add a directory to the workspace"],
  ["agents", "List available custom agents"],
  ["artifact", "View and review artifacts"],
  ["btw", "Ask a side question without interrupting the current task"],
  ["changelog", "Show release notes and changes"],
  ["clear", "Clear conversation and start a new one"],
  ["codesearch", "Search code in the workspace (usage: /codesearch <query>)"],
  ["config", "Open settings panel"],
  ["context", "Visualize current context usage"],
  ["copy", "Copy the last planner response to the clipboard, the n-th with '/copy n', or the /btw answer with '/copy btw'"],
  ["credits", "Show remaining G1 credits and purchase link"],
  ["diff", "View uncommitted changes and per-turn diffs"],
  ["effort", "Set the reasoning effort"],
  ["exit", "Exit the CLI"],
  ["feedback", "Submit qualitative feedback to improve the agent"],
  ["fork", "Create a branch of the current conversation at this point, optionally specifying a project ID to fork into"],
  ["help", "Show available commands and keybindings"],
  ["hooks", "Manage hook configurations for tool events"],
  ["keybindings", "Set custom keybindings"],
  ["logout", "Log out"],
  ["mcp", "Manage MCP servers"],
  ["model", "Set a model, or run a single prompt on another model"],
  ["open", "Open a file or view opened/edited files"],
  ["permissions", "Manage tool permissions"],
  ["plugin", "Manage, discover, install, uninstall, enable, and disable plugins"],
  ["remote-control", "Turn on remote control for this session (off to disable)"],
  ["rename", "Rename the current conversation"],
  ["resume", "Browse and resume past conversations"],
  ["rewind", "Rewind conversation to a previous message"],
  ["skills", "List available skills"],
  ["statusline", "Toggle the statusline"],
  ["tasks", "View background tasks"],
  ["title", "Toggle custom terminal window title"],
  ["usage", "View model quota usage"],
  ["voice", "Dictate a prompt using your microphone"],
  ["goal", "Run until the specified goal is completely finished."],
  ["compact", "Compact the conversation now (summarize history to free up the context window)."],
  ["schedule", "Run an instruction on a recurring schedule or as a one-time timer."],
  ["browser", "Invoke a browser agent for web tasks."],
  ["plan", "Plan carefully before executing a task."],
  ["grill-me", "Interview me to align on a plan."],
  ["learn", "Reflect on recent successes or corrections to capture reusable skills or rules."],
  ["agy-customizations", "Comprehensive guide and reference for the Antigravity Customization System. Use to explain how customizations work, their loading priority, discovery mechanisms, and to guid..."],
  ["antigravity-guide", "Provides a comprehensive guide, quick reference, and sitemap for Google Antigravity (AGY), including the Antigravity CLI (agy), Antigravity 2.0, Antigravity IDE, Python SDK,..."],
]);

// The OpenCode server's own commands: a skill of the same name is not one.
const OPENCODE_SERVER_COMMANDS = new Set(["init", "review"]);

// Claude Code's commands only its terminal UI has: a build asked for its
// commands (src/agent-commands.mjs) leaves these out, so they are added from
// the list above. The ones 2.1.319's answer left out of that list.
export const CLAUDE_TUI_ONLY_COMMANDS = new Set([
  "add-dir", "artifact-capabilities", "artifact-diagramming", "artifacts", "autofix-pr", "background", "branch", "btw",
  "bug", "cd", "chrome", "claude-in-chrome", "copy", "cost", "design-login", "desktop", "diff", "exit", "export",
  "feedback", "fork", "help", "hooks", "ide", "install-github-app", "install-slack-app", "keybindings", "login",
  "logout", "memory", "mobile", "passes", "permissions", "plan", "plugin", "powerup", "privacy-settings", "radio",
  "rate-limit-options", "release-notes", "remote-control", "remote-env", "restart", "resume", "review", "rewind",
  "sandbox", "scroll-speed", "setup-bedrock", "setup-vertex", "skills", "slides", "stats", "status", "statusline",
  "stickers", "stop", "subtask", "tasks", "teleport", "terminal-setup", "theme", "tui", "ultrareview", "upgrade",
  "voice", "web-setup", "workflows",
]);

// An agent's own commands as its running version answered them, and for
// Claude Code those only its terminal UI has, which that answer leaves out.
function withTerminalOnly(agent, answered) {
  if (agent !== "claude") return answered;
  const named = new Set(answered.map((command) => command.name));
  const terminal = CLAUDE_BUILT_IN_COMMANDS.filter((command) => CLAUDE_TUI_ONLY_COMMANDS.has(command.name) && !named.has(command.name));
  return [...answered, ...terminal].sort((a, b) => a.name.localeCompare(b.name));
}

export function builtInCommands(agent) {
  if (agent === "opencode") return OPENCODE_BUILT_IN_COMMANDS;
  if (agent === "claude") return CLAUDE_BUILT_IN_COMMANDS;
  if (agent === "codex") return CODEX_BUILT_IN_COMMANDS;
  if (agent === "kiro") return KIRO_BUILT_IN_COMMANDS;
  if (agent === "agy") return AGY_BUILT_IN_COMMANDS;
  return [];
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/gu, "$1").replace(/\\n/gu, " ");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'");
  // A plain value ends at a comment.
  return value.replace(/\s+#.*$/u, "");
}

// The `name` and `description` of a Markdown file's YAML frontmatter, and the
// body after it. Only top-level `key: value` pairs are read: plain, quoted,
// folded or literal (`>`, `|`) and plain values continued on indented lines.
// A frontmatter cut off before its closing `---` (the file was only read in
// part) gives what it has, without its last, possibly cut, line.
export function parseFrontmatter(text) {
  const source = String(text ?? "").replace(/^\uFEFF/u, "");
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return { fields: {}, body: source };
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/u.test(line));
  const head = end < 0 ? lines.slice(1, -1) : lines.slice(1, end);
  const body = end < 0 ? "" : lines.slice(end + 1).join("\n");
  const fields = {};
  for (let index = 0; index < head.length; index += 1) {
    const match = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/u.exec(head[index]);
    if (!match) continue;
    const key = match[1];
    const raw = (match[2] ?? "").trim();
    const continued = [];
    while (index + 1 < head.length && (/^[ \t]+\S/u.test(head[index + 1]) || head[index + 1].trim() === "")) {
      continued.push(head[index + 1].trim());
      index += 1;
    }
    if (key !== "name" && key !== "description") continue;
    let value;
    if (/^[|>][+-]?\d*$/u.test(raw)) value = continued.filter(Boolean).join(" ");
    else value = unquote([raw, ...continued.filter(Boolean)].join(" ").trim());
    fields[key] = oneLine(value);
  }
  return { fields, body };
}

// One line of plain text, cut to a length a list row can show (a declaration:
// the lists above use it as the module loads).
function oneLine(value, limit) {
  return commandLine(value, limit);
}

// A command's name and description from the start of its file: the
// frontmatter's, else `fallbackName` and the first line of the body that is
// not empty (a heading's text without its `#`).
export function commandSummary(text, fallbackName) {
  const { fields, body } = parseFrontmatter(text);
  let description = fields.description || "";
  if (!description) {
    const lines = body.split(/\r?\n/u);
    // The last line may have been cut where the read stopped.
    if (lines.length > 1 && !/\n$/u.test(body)) lines.pop();
    const first = lines.map((line) => line.trim()).find((line) => line && !/^(```|~~~|<!--)/u.test(line));
    description = first ? first.replace(/^(#+|>|[-*+])\s*/u, "") : "";
  }
  return { name: fields.name || fallbackName, description: oneLine(description) };
}

export function isCommandName(name) {
  return typeof name === "string" && COMMAND_NAME.test(name);
}

// The agent and folder of a pane as `snapshot` reports them, or null for a
// pane it does not list: what a pane's command list is built for. A
// connected PC answers this from its own snapshot, never from what it is asked.
export function paneCommandTarget(snapshot, paneId) {
  const pane = (snapshot?.panes ?? []).find((candidate) => candidate?.pane_id === paneId);
  if (!pane) return null;
  const cwd = [pane.foreground_cwd, pane.cwd].find((value) => typeof value === "string" && value.startsWith("/")) ?? null;
  const reported = (snapshot?.agents ?? []).find((candidate) => candidate?.pane_id === paneId)?.agent;
  return { pane, agent: paneAgentName(pane) ?? reported ?? null, cwd };
}

// What a connected PC said its pane's agent takes, held to what a list here
// could have been: the agent this hub sees in the pane, at most
// MAX_REMOTE_COMMANDS names a typed `/name` can be, each once, a one-line
// description and a known source. Only those three fields are kept. Null
// when the answer is not a list for `agent`, or holds no command at all.
// A PC's list is its found commands (MAX_LISTED_COMMANDS at most) and then
// its agent's own, which must not be cut off the end: room for the longest
// list of an agent's own here, and as much again for a PC whose lists are newer.
export const MAX_REMOTE_COMMANDS = MAX_LISTED_COMMANDS + 2 * Math.max(...COMMAND_AGENTS.map((agent) => builtInCommands(agent).length));

export function cleanRemoteCommands(answer, agent) {
  if (!answer || typeof answer !== "object" || answer.agent !== agent || !Array.isArray(answer.commands)) return null;
  const seen = new Set();
  const commands = [];
  for (const command of answer.commands.slice(0, MAX_REMOTE_COMMANDS)) {
    if (!command || typeof command !== "object" || !isCommandName(command.name) || seen.has(command.name)) continue;
    seen.add(command.name);
    commands.push({
      name: command.name,
      description: typeof command.description === "string" ? oneLine(command.description) : "",
      source: COMMAND_SOURCES.includes(command.source) ? command.source : "other",
    });
  }
  return commands.length ? commands : null;
}

function agentName(agent) {
  return typeof agent === "string" ? agent.trim().toLowerCase() : "";
}

function inside(path, folder) {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

const nodeFs = { open, readdir, realpath, stat };

// The commands each pane's agent takes, kept a little while per agent and
// folder. `fs` is the file calls used (open, readdir, realpath, stat), so a
// test can see what is opened. `agentCommands` (an AgentCommandSource) gives
// an agent's own commands for the version a pane runs, which `executableOf`
// reads from the pane's processes; without it, or when it has none, the lists
// kept here are the agent's own.
export class SlashCommandCatalog {
  constructor({
    env = process.env,
    home = env.HOME || homedir(),
    guard = defaultProtectedPaths(),
    ttlMs = COMMANDS_CACHE_MS,
    now = () => Date.now(),
    fs = nodeFs,
    agentCommands = null,
    executableOf = (agent, processes) => agentExecutable(agent, processes),
  } = {}) {
    this.agentCommands = agentCommands;
    this.executableOf = executableOf;
    this.claudeDir = posix.resolve(env.CLAUDE_CONFIG_DIR || posix.join(home, ".claude"));
    this.home = posix.resolve(home);
    this.opencodeDir = posix.resolve(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith("/") ? posix.join(env.XDG_CONFIG_HOME, "opencode") : posix.join(home, ".config", "opencode"));
    this.codexDir = posix.resolve(env.CODEX_HOME || posix.join(home, ".codex"));
    this.kiroDir = posix.resolve(env.KIRO_CONFIG_DIR && env.KIRO_CONFIG_DIR.startsWith("/") ? env.KIRO_CONFIG_DIR : posix.join(home, ".kiro"));
    this.agyDir = posix.resolve(home, ".gemini", "config");
    this.env = env;
    this.guard = guard;
    this.ttlMs = ttlMs;
    this.now = now;
    this.fs = fs;
    this.cache = new Map();
  }

  // { agent, commands: [{ name, description, source }] } for a pane on this
  // PC (one on a connected PC asks there: listRemote). An agent not in
  // COMMAND_AGENTS has none.
  async list({ agent, cwd = null, processes = [] } = {}) {
    const name = agentName(agent);
    if (!COMMAND_AGENTS.includes(name)) return { agent: null, commands: [] };
    const folder = typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 4096 ? posix.resolve(cwd) : null;
    // the version the pane runs decides the agent's own commands, so the list is kept per version
    const running = this.agentCommands ? await this.executableOf(name, Array.isArray(processes) ? processes : []).catch(() => null) : null;
    const version = running?.version ?? null;
    const key = JSON.stringify([name, folder, version]);
    const at = this.now();
    const cached = this.cache.get(key);
    if (cached && at - cached.at <= this.ttlMs) return cached.answer;
    const answer = (async () => {
      const found = await this.#found(name, folder);
      const answered = version ? await this.agentCommands.builtIn(name, version, { executable: running.path }).catch(() => null) : null;
      const own = answered ? withTerminalOnly(name, answered) : builtInCommands(name);
      const seen = new Set();
      const commands = [];
      // The first of a name wins: the project's, the user's, a plugin's, then the agent's own.
      for (const command of [...found, ...own]) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        commands.push({ name: command.name, description: command.description, source: command.source });
      }
      return { agent: name, commands };
    })();
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(key, { at, answer });
    try {
      return await answer;
    } catch (error) {
      this.cache.delete(key);
      throw error;
    }
  }

  // A pane on a connected PC: that PC's own list, which `ask` gets from it
  // (its own files, its own snapshot's agent and folder), cleaned here and
  // kept as long as a list of this PC's under `key` (the pane). A PC that does
  // not answer this (`ask` gives null), cannot be reached, fails or answers
  // something unusable gives the agent's own commands, as before: the
  // composer always gets a list. Never throws.
  async listRemote({ agent, key, ask }) {
    const name = agentName(agent);
    if (!COMMAND_AGENTS.includes(name)) return { agent: null, commands: [] };
    const cacheKey = JSON.stringify(["remote", String(key), name]);
    const at = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && at - cached.at <= this.ttlMs) return cached.answer;
    const answer = (async () => {
      let said = null;
      try { said = await ask(); } catch { said = null; }
      const commands = cleanRemoteCommands(said, name);
      return { agent: name, commands: commands ?? [...builtInCommands(name)], remote: true };
    })();
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(cacheKey, { at, answer });
    return answer;
  }

  async #found(agent, cwd) {
    const isProtected = await this.guard.matcher();
    const scan = { out: [], isProtected, scanned: 0 };
    if (agent === "opencode") return this.#opencode(scan, cwd);
    if (agent === "kiro") return this.#kiro(scan, cwd);
    if (agent === "agy") return this.#agy(scan, cwd);
    if (agent === "codex") {
      const base = await this.#real(this.codexDir);
      if (base) await this.#commands(scan, posix.join(this.codexDir, "prompts"), base, { prefix: "prompts:", source: "user", depth: 0 });
      return scan.out;
    }
    const userDir = await this.#real(this.claudeDir);
    const claudeHome = async (folder) => Boolean(userDir) && (await this.#real(posix.join(folder, ".claude"))) === userDir;
    const projects = cwd ? await this.#projectFolders(cwd, claudeHome) : [];
    for (const base of projects) {
      await this.#skills(scan, posix.join(base, ".claude", "skills"), base, { prefix: "", source: "project" });
      await this.#commands(scan, posix.join(base, ".claude", "commands"), base, { prefix: "", source: "project" });
    }
    if (userDir) {
      await this.#skills(scan, posix.join(userDir, "skills"), userDir, { prefix: "", source: "user" });
      await this.#commands(scan, posix.join(userDir, "commands"), userDir, { prefix: "", source: "user" });
      await this.#plugins(scan, userDir, projects);
    }
    return scan.out;
  }

  // Kiro CLI's skills and file prompts: `.kiro/skills/<name>/SKILL.md` and
  // `.kiro/prompts/<name>.md` in the pane's own folder (Kiro reads no folder
  // above it, checked with kiro-cli 2.35.1), then the same in `~/.kiro`.
  // Prompts an MCP server offers are not on disk and are not listed.
  async #kiro(scan, cwd) {
    const userDir = await this.#real(this.kiroDir);
    const folder = cwd ? await this.#real(cwd) : null;
    if (folder) {
      const project = await this.#real(posix.join(folder, ".kiro"));
      if (project && project !== userDir) {
        await this.#skills(scan, posix.join(folder, ".kiro", "skills"), folder, { prefix: "", source: "project" });
        await this.#commands(scan, posix.join(folder, ".kiro", "prompts"), folder, { prefix: "", source: "project", depth: 0 });
      }
    }
    if (userDir) {
      await this.#skills(scan, posix.join(userDir, "skills"), userDir, { prefix: "", source: "user" });
      await this.#commands(scan, posix.join(userDir, "prompts"), userDir, { prefix: "", source: "user", depth: 0 });
    }
    return scan.out;
  }

  // Antigravity CLI's skills: `.agents/skills/<name>/SKILL.md` in the pane's
  // folder and, inside a git checkout, each folder above it up to its root
  // (outside one, the pane's folder only), then `~/.gemini/config/skills`.
  // Its workflows are deprecated and no longer listed by it (agy 1.4.12).
  async #agy(scan, cwd) {
    const userDir = await this.#real(this.agyDir);
    const homeReal = await this.#real(this.home);
    const projects = cwd ? await this.#projectFolders(cwd, async (folder) => folder === homeReal) : [];
    for (const base of projects) {
      await this.#skills(scan, posix.join(base, ".agents", "skills"), base, { prefix: "", source: "project" });
    }
    if (userDir) await this.#skills(scan, posix.join(userDir, "skills"), userDir, { prefix: "", source: "user" });
    return scan.out;
  }

  // What OpenCode adds to its own commands, as its Command.state builds
  // them: the Markdown commands of its config folders (ConfigPaths.directories),
  // then its skills, each of which is a `/name` too unless a command already
  // has that name. opencode.json(c) may hold keys and is never opened:
  // commands and skill paths defined there are not listed. Of the commands
  // folders (`commands/`, and the older `command/`) only the files directly
  // inside are read: OpenCode names one in a subfolder `sub/name`, which a
  // typed `/name` here cannot be.
  async #opencode(scan, cwd) {
    const env = this.env;
    const homeReal = await this.#real(this.home);
    // the pane's folder up to its checkout's root (OpenCode's worktree), or to `/` outside one
    const chain = cwd ? (await this.#upToRoot(cwd)).filter((folder) => folder !== homeReal) : [];
    // ConfigPaths.directories: each `.opencode` on the way up, `~/.opencode`,
    // OPENCODE_CONFIG_DIR and the global config folder. A project's comes
    // first: its command or skill wins over the user's of the same name.
    const configs = [];
    if (!switchedOn(env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
      for (const folder of chain) configs.push({ dir: posix.join(folder, ".opencode"), base: folder, source: "project" });
    }
    if (homeReal) configs.push({ dir: posix.join(homeReal, ".opencode"), base: homeReal, source: "user" });
    const configDir = typeof env.OPENCODE_CONFIG_DIR === "string" && env.OPENCODE_CONFIG_DIR.startsWith("/") ? await this.#real(env.OPENCODE_CONFIG_DIR) : null;
    if (configDir) configs.push({ dir: configDir, base: configDir, source: "user" });
    const globalDir = await this.#real(this.opencodeDir);
    if (globalDir) configs.push({ dir: globalDir, base: globalDir, source: "user" });
    const seen = new Set();
    const directories = configs.filter(({ dir }) => !seen.has(dir) && seen.add(dir));
    for (const { dir, base, source } of directories) {
      for (const name of ["commands", "command"]) {
        await this.#commands(scan, posix.join(dir, name), base, { prefix: "", source, depth: 0 });
      }
    }
    // Skills: `skills/**/SKILL.md` under `.claude` and `.agents` on the way up
    // and in the home folder (unless switched off), then `{skill,skills}/**/SKILL.md`
    // under each config folder.
    const skip = new Set([...OPENCODE_SERVER_COMMANDS, ...scan.out.map((command) => command.name)]);
    const external = [];
    if (!switchedOn(env.OPENCODE_DISABLE_EXTERNAL_SKILLS)) {
      if (!switchedOn(env.OPENCODE_DISABLE_CLAUDE_CODE) && !switchedOn(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)) external.push(".claude");
      external.push(".agents");
    }
    const skillFolders = [];
    for (const folder of chain) {
      for (const name of external) skillFolders.push({ folder: posix.join(folder, name, "skills"), base: folder, source: "project" });
    }
    for (const { dir, base, source } of directories.filter(({ source }) => source === "project")) {
      for (const name of ["skill", "skills"]) skillFolders.push({ folder: posix.join(dir, name), base, source });
    }
    if (homeReal) {
      for (const name of external) skillFolders.push({ folder: posix.join(homeReal, name, "skills"), base: homeReal, source: "user" });
    }
    for (const { dir, base, source } of directories.filter(({ source }) => source === "user")) {
      for (const name of ["skill", "skills"]) skillFolders.push({ folder: posix.join(dir, name), base, source });
    }
    for (const { folder, base, source } of skillFolders) await this.#skillTree(scan, folder, base, { source, skip });
    return scan.out;
  }

  // `cwd` and each folder above it, nearest first, up to the first that holds
  // `.git` (a checkout's root) or up to `/`; MAX_OPENCODE_LEVELS at most.
  async #upToRoot(cwd) {
    const start = await this.#real(cwd);
    if (!start) return [];
    const chain = [];
    for (let folder = start; chain.length < MAX_OPENCODE_LEVELS;) {
      chain.push(folder);
      if (await this.#real(posix.join(folder, ".git"))) break;
      const parent = posix.dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
    return chain;
  }

  // OpenCode's skills: every `SKILL.md` in `folder` or below it (at most
  // MAX_SKILL_DEPTH folders down), named by its frontmatter's `name` as
  // OpenCode names it; one without a name is not a skill to OpenCode and is
  // not listed. One too large to read goes by its folder's name. A name in
  // `skip` (a command's) is not listed again.
  async #skillTree(scan, folder, base, { source, skip }) {
    const root = await this.#within(scan, folder, base);
    if (!root || (await this.#kind(root)) !== "directory") return;
    const visited = new Set();
    const budget = { left: MAX_SCANNED_ENTRIES };
    const walk = async (directory, depth) => {
      if (visited.has(directory)) return;
      visited.add(directory);
      for (const name of await this.#entries(scan, directory, budget)) {
        if (scan.out.length >= MAX_LISTED_COMMANDS) return;
        const real = await this.#within(scan, posix.join(directory, name), root);
        if (!real) continue;
        const kind = await this.#kind(real);
        if (kind === "directory") {
          if (depth < MAX_SKILL_DEPTH) await walk(real, depth + 1);
        } else if (kind === "file" && name === "SKILL.md") {
          const head = await this.#head(real);
          const fallback = head === null && directory !== root ? posix.basename(directory) : "";
          const skill = head === null ? fallback : parseFrontmatter(head).fields.name ?? "";
          if (!isCommandName(skill) || skip.has(skill)) continue;
          skip.add(skill);
          this.#add(scan, skill, head === null ? "" : parseFrontmatter(head).fields.description ?? "", source);
        }
      }
    };
    await walk(root, 0);
  }

  // The project folders a pane in `cwd` takes commands from, nearest first:
  // `cwd` and, inside a git checkout, each folder above it up to the
  // checkout's root (a pane in `app/src` gets `app`'s too). A folder `isHome`
  // calls the agent's home (Claude's `~/.claude`, the user's own) is never one.
  async #projectFolders(cwd, isHome) {
    const start = await this.#real(cwd);
    if (!start) return [];
    const chain = [];
    for (let folder = start, level = 0; level <= MAX_PROJECT_LEVELS; level += 1) {
      if (await isHome(folder)) break;
      chain.push(folder);
      if (await this.#real(posix.join(folder, ".git"))) return chain;
      const parent = posix.dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
    // not in a git checkout (or its root is too far up): the pane's own folder only
    return chain.slice(0, 1);
  }

  async #real(path) {
    try {
      return await this.fs.realpath(path);
    } catch {
      return null;
    }
  }

  // The real path of `path` when it stays inside `folder` (a real path) and
  // is not protected; null otherwise, or when it does not exist.
  async #within(scan, path, folder) {
    const real = await this.#real(path);
    if (!real || !inside(real, folder) || scan.isProtected(real)) return null;
    return real;
  }

  // `budget` is the one skills or commands folder's own allowance ({ left }).
  async #entries(scan, folder, budget) {
    const left = Math.min(budget.left, MAX_TOTAL_SCANNED_ENTRIES - scan.scanned);
    if (left <= 0) return [];
    try {
      const entries = await this.fs.readdir(folder, { withFileTypes: true });
      const names = entries.map((entry) => entry.name).filter((name) => !name.startsWith(".")).sort().slice(0, left);
      scan.scanned += names.length;
      budget.left -= names.length;
      return names;
    } catch {
      return [];
    }
  }

  async #kind(real) {
    try {
      const info = await this.fs.stat(real);
      return info.isDirectory() ? "directory" : info.isFile() ? "file" : null;
    } catch {
      return null;
    }
  }

  // The start of a Markdown file, or null when it is too large to read or
  // cannot be. Opened without following links and without waiting on
  // anything that is not a plain file.
  async #head(real) {
    if (!real.endsWith(".md")) return null;
    try {
      const info = await this.fs.stat(real);
      if (!info.isFile() || info.size > MAX_COMMAND_FILE_BYTES) return null;
    } catch {
      return null;
    }
    let handle;
    try {
      handle = await this.fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      // A folder above it swapped for a link after `real` was checked would
      // open another file: where it can be told, it must still be `real`.
      if (((await this.#opened(handle)) ?? real) !== real) return null;
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_COMMAND_FILE_BYTES) return null;
      const buffer = Buffer.alloc(Math.min(FRONTMATTER_READ_BYTES, info.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  // The real path of an open file, where the system tells it (Linux); null elsewhere.
  async #opened(handle) {
    try {
      return await this.fs.realpath(`/proc/self/fd/${handle.fd}`);
    } catch {
      return null;
    }
  }

  #add(scan, name, description, source) {
    if (scan.out.length >= MAX_LISTED_COMMANDS || !isCommandName(name)) return;
    scan.out.push({ name, description, source });
  }

  // `<folder>/<skill>/SKILL.md`, named by its frontmatter or its folder.
  async #skills(scan, folder, base, { prefix, source }) {
    const root = await this.#within(scan, folder, base);
    if (!root || (await this.#kind(root)) !== "directory") return;
    for (const name of await this.#entries(scan, root, { left: MAX_SCANNED_ENTRIES })) {
      if (scan.out.length >= MAX_LISTED_COMMANDS) return;
      const skill = await this.#within(scan, posix.join(root, name), root);
      if (!skill || skill === root || (await this.#kind(skill)) !== "directory") continue;
      const file = await this.#within(scan, posix.join(skill, "SKILL.md"), root);
      if (!file) continue;
      const summary = commandSummary(await this.#head(file), name);
      const own = isCommandName(summary.name) && !summary.name.includes(":") ? summary.name : name;
      this.#add(scan, `${prefix}${own}`, summary.description, source);
    }
  }

  // `<folder>/**/*.md`, a file in a subfolder named `sub:name`.
  async #commands(scan, folder, base, { prefix, source, depth = MAX_COMMAND_DEPTH }) {
    const root = await this.#within(scan, folder, base);
    if (!root || (await this.#kind(root)) !== "directory") return;
    const visited = new Set();
    const budget = { left: MAX_SCANNED_ENTRIES };
    const walk = async (directory, parts) => {
      if (visited.has(directory)) return;
      visited.add(directory);
      for (const name of await this.#entries(scan, directory, budget)) {
        if (scan.out.length >= MAX_LISTED_COMMANDS) return;
        const real = await this.#within(scan, posix.join(directory, name), root);
        if (!real) continue;
        const kind = await this.#kind(real);
        if (kind === "directory") {
          if (parts.length < depth) await walk(real, [...parts, name]);
        } else if (kind === "file" && name.endsWith(".md") && name.length > 3) {
          const command = [...parts, name.slice(0, -3)].join(":");
          const summary = commandSummary(await this.#head(real), command);
          this.#add(scan, `${prefix}${command}`, summary.description, source);
        }
      }
    };
    await walk(root, []);
  }

  // Claude Code's installed plugins, from its installed_plugins.json: each
  // one's skills and commands, named `plugin:name`. A plugin installed for
  // one project counts only in that project (`projects`, the pane's project folders).
  async #plugins(scan, base, projects) {
    const pluginsDir = await this.#within(scan, posix.join(base, "plugins"), base);
    if (!pluginsDir) return;
    const manifest = await this.#within(scan, posix.join(pluginsDir, "installed_plugins.json"), pluginsDir);
    if (!manifest) return;
    let installed;
    try {
      installed = JSON.parse(await this.#readManifest(manifest));
    } catch {
      return;
    }
    const plugins = installed?.plugins && typeof installed.plugins === "object" ? installed.plugins : {};
    for (const [id, installs] of Object.entries(plugins).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const plugin = id.split("@", 1)[0];
      if (!isCommandName(plugin) || plugin.includes(":")) continue;
      for (const install of Array.isArray(installs) ? installs : []) {
        if (typeof install?.installPath !== "string" || !install.installPath.startsWith("/")) continue;
        const scope = install.scope ?? "user";
        if (scope !== "user") {
          const project = typeof install.projectPath === "string" ? await this.#real(install.projectPath) : null;
          if (!project || !projects.includes(project)) continue;
        }
        const root = await this.#within(scan, install.installPath, pluginsDir);
        if (!root || (await this.#kind(root)) !== "directory") continue;
        await this.#skills(scan, posix.join(root, "skills"), root, { prefix: `${plugin}:`, source: "plugin" });
        await this.#commands(scan, posix.join(root, "commands"), root, { prefix: `${plugin}:`, source: "plugin" });
        break;
      }
    }
  }

  async #readManifest(real) {
    if ((await this.#kind(real)) !== "file") return "";
    const handle = await this.fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return "";
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close().catch(() => {});
    }
  }
}
