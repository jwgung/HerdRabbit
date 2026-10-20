// The `/` commands a pane's agent takes, for the composer's command list:
// Claude Code's, Codex's and OpenCode's own, and the skills, commands and prompts the
// user, the pane's project and the installed Claude plugins add.
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
import { paneAgentName } from "./pane-agent.mjs";
import { defaultProtectedPaths } from "./protected-paths.mjs";

export const COMMAND_AGENTS = Object.freeze(["claude", "codex", "opencode"]);
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
const MAX_DESCRIPTION_LENGTH = 200;
// What a typed `/name` can be: no spaces, quotes or slashes.
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u;

// Where a listed command comes from. A connected PC naming anything else
// is passed on as "other".
export const COMMAND_SOURCES = Object.freeze(["built-in", "user", "project", "plugin"]);

const builtIn = (entries) => Object.freeze(entries.map(([name, description]) => Object.freeze({ name, description, source: "built-in" })));

// Claude Code's own commands, the well-known ones.
export const CLAUDE_BUILT_IN_COMMANDS = builtIn([
  ["add-dir", "Add another working directory"],
  ["agents", "Manage subagents"],
  ["bug", "Report a bug to Anthropic"],
  ["clear", "Clear the conversation history"],
  ["compact", "Compact the conversation, with optional focus instructions"],
  ["config", "Open the settings"],
  ["context", "Show what fills the context window"],
  ["cost", "Show the session's token cost"],
  ["doctor", "Check the Claude Code installation"],
  ["exit", "Exit Claude Code"],
  ["export", "Export the conversation to a file or the clipboard"],
  ["help", "Show help and the available commands"],
  ["hooks", "Manage hooks"],
  ["ide", "Manage IDE integrations"],
  ["init", "Create a CLAUDE.md for this project"],
  ["login", "Sign in to an Anthropic account"],
  ["logout", "Sign out"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Edit CLAUDE.md memory files"],
  ["model", "Choose the model"],
  ["output-style", "Choose the output style"],
  ["permissions", "View and change tool permissions"],
  ["plugin", "Manage plugins"],
  ["pr-comments", "Show a pull request's comments"],
  ["release-notes", "Show the release notes"],
  ["resume", "Resume an earlier conversation"],
  ["review", "Review a pull request"],
  ["rewind", "Rewind the conversation and code"],
  ["security-review", "Review pending changes for security issues"],
  ["status", "Show version, model, account and connections"],
  ["statusline", "Set up the status line"],
  ["terminal-setup", "Set up Shift+Enter for newlines"],
  ["todos", "Show the current todo items"],
  ["usage", "Show plan usage limits"],
  ["vim", "Toggle Vim editing mode"],
]);

// The Codex CLI's own commands, the well-known ones.
export const CODEX_BUILT_IN_COMMANDS = builtIn([
  ["approvals", "Choose what Codex may do without asking"],
  ["compact", "Summarize the conversation to free context"],
  ["diff", "Show the git diff, untracked files included"],
  ["exit", "Exit Codex"],
  ["feedback", "Send logs to the Codex maintainers"],
  ["init", "Create an AGENTS.md for this project"],
  ["logout", "Sign out of Codex"],
  ["mcp", "List the configured MCP tools"],
  ["mention", "Mention a file"],
  ["model", "Choose the model and reasoning effort"],
  ["new", "Start a new chat"],
  ["quit", "Exit Codex"],
  ["review", "Review the current changes"],
  ["status", "Show the session's settings and token usage"],
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
// The OpenCode server's own commands: a skill of the same name is not one.
const OPENCODE_SERVER_COMMANDS = new Set(["init", "review"]);

export function builtInCommands(agent) {
  if (agent === "opencode") return OPENCODE_BUILT_IN_COMMANDS;
  if (agent === "claude") return CLAUDE_BUILT_IN_COMMANDS;
  if (agent === "codex") return CODEX_BUILT_IN_COMMANDS;
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

// One line of plain text, cut to a length a list row can show.
function oneLine(value, limit = MAX_DESCRIPTION_LENGTH) {
  // eslint-disable-next-line no-control-regex
  const flat = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
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
// its agent's own, which must not be cut off the end.
export const MAX_REMOTE_COMMANDS = MAX_LISTED_COMMANDS + 100;

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
// test can see what is opened.
export class SlashCommandCatalog {
  constructor({
    env = process.env,
    home = env.HOME || homedir(),
    guard = defaultProtectedPaths(),
    ttlMs = COMMANDS_CACHE_MS,
    now = () => Date.now(),
    fs = nodeFs,
  } = {}) {
    this.claudeDir = posix.resolve(env.CLAUDE_CONFIG_DIR || posix.join(home, ".claude"));
    this.home = posix.resolve(home);
    this.opencodeDir = posix.resolve(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith("/") ? posix.join(env.XDG_CONFIG_HOME, "opencode") : posix.join(home, ".config", "opencode"));
    this.codexDir = posix.resolve(env.CODEX_HOME || posix.join(home, ".codex"));
    this.env = env;
    this.guard = guard;
    this.ttlMs = ttlMs;
    this.now = now;
    this.fs = fs;
    this.cache = new Map();
  }

  // { agent, commands: [{ name, description, source }] } for a pane on this
  // PC (one on a connected PC asks there: listRemote). An agent other than
  // Claude Code, Codex or OpenCode has none.
  async list({ agent, cwd = null } = {}) {
    const name = agentName(agent);
    if (!COMMAND_AGENTS.includes(name)) return { agent: null, commands: [] };
    const folder = typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 4096 ? posix.resolve(cwd) : null;
    const key = JSON.stringify([name, folder]);
    const at = this.now();
    const cached = this.cache.get(key);
    if (cached && at - cached.at <= this.ttlMs) return cached.answer;
    const answer = (async () => {
      const found = await this.#found(name, folder);
      const seen = new Set();
      const commands = [];
      // The first of a name wins: the project's, the user's, a plugin's, then the agent's own.
      for (const command of [...found, ...builtInCommands(name)]) {
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
