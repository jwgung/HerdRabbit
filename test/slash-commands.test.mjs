import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { PasswordAuth, createPasswordConfiguration } from "../src/password-auth.mjs";
import { localProtectedPaths } from "../src/protected-paths.mjs";
import {
  CLAUDE_BUILT_IN_COMMANDS,
  CODEX_BUILT_IN_COMMANDS,
  MAX_COMMAND_FILE_BYTES,
  MAX_LISTED_COMMANDS,
  MAX_OPENCODE_LEVELS,
  MAX_REMOTE_COMMANDS,
  MAX_SKILL_DEPTH,
  OPENCODE_BUILT_IN_COMMANDS,
  MAX_SCANNED_ENTRIES,
  SlashCommandCatalog,
  cleanRemoteCommands,
  commandSummary,
  parseFrontmatter,
} from "../src/slash-commands.mjs";

test("reads name and description from the frontmatter", () => {
  assert.deepEqual(parseFrontmatter("---\nname: alpha\ndescription: Does alpha things\n---\n# Body\n").fields,
    { name: "alpha", description: "Does alpha things" });
  // quoted, with a comment, CRLF and a BOM
  assert.deepEqual(parseFrontmatter("﻿---\r\nname: 'it''s'\r\ndescription: \"say \\\"hi\\\"\" \r\n---\r\n").fields,
    { name: "it's", description: 'say "hi"' });
  assert.deepEqual(parseFrontmatter("---\nname: plain # a comment\n---\n").fields, { name: "plain" });
  // folded and literal blocks become one line
  assert.equal(parseFrontmatter("---\ndescription: >-\n  First line\n  second line\nname: x\n---\n").fields.description,
    "First line second line");
  assert.equal(parseFrontmatter("---\ndescription: |\n  One\n\n  Two\n---\n").fields.description, "One Two");
  // a plain value continued on indented lines
  assert.equal(parseFrontmatter("---\ndescription: Runs the\n  whole suite\n---\n").fields.description, "Runs the whole suite");
  // other keys, nested keys and lists are not taken
  assert.deepEqual(parseFrontmatter("---\nallowed-tools: Bash\nmeta:\n  name: nested\n---\n").fields, {});
  // no frontmatter at all
  assert.deepEqual(parseFrontmatter("# Title\nname: not frontmatter\n"), { fields: {}, body: "# Title\nname: not frontmatter\n" });
  // cut off before it closes: the last, cut line is not read
  assert.deepEqual(parseFrontmatter("---\nname: cut\ndescription: half a sen").fields, { name: "cut" });
});

test("falls back to the file's name and its first line", () => {
  assert.deepEqual(commandSummary("# Deploy the app\n\nMore text\n", "deploy"), { name: "deploy", description: "Deploy the app" });
  assert.deepEqual(commandSummary("---\nallowed-tools: Bash\n---\n\n```sh\nls\n```\nRun it\n", "run"), { name: "run", description: "ls" });
  assert.deepEqual(commandSummary("", "empty"), { name: "empty", description: "" });
  const long = commandSummary(`---\ndescription: ${"word ".repeat(100)}\n---\n`, "long").description;
  assert.ok(long.length <= 200 && long.endsWith("…"), long);
  assert.equal(commandSummary("---\ndescription: a\u0007b\tc\n---\n", "x").description, "a b c");
});

async function tree() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slash-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const outside = join(root, "outside");
  const write = async (path, text) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  const claude = join(home, ".claude");
  await write(join(claude, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: >\n  Does alpha\n  things\n---\nBODY-SECRET\n");
  await write(join(claude, "skills", "beta", "SKILL.md"), "# Beta skill\nBODY-SECRET\n");
  await write(join(claude, "skills", "no-skill-file", "README.md"), "x");
  await write(join(claude, "commands", "deploy.md"), "---\ndescription: Deploy from the user folder\n---\n");
  await write(join(claude, "commands", "frontend", "component.md"), "---\ndescription: Make a component\n---\n");
  await write(join(claude, "commands", "a", "b", "c", "deep.md"), "# Three folders down\n");
  await write(join(claude, "commands", "a", "b", "c", "d", "deeper.md"), "# Four folders down\n");
  await write(join(claude, "commands", "notes.txt"), "not a command");
  await write(join(claude, "commands", "huge.md"), `---\ndescription: never read\n---\n${"x".repeat(MAX_COMMAND_FILE_BYTES)}`);
  // what must never be opened
  await write(join(claude, ".credentials.json"), '{"token":"SECRET"}');
  await write(join(claude, "settings.json"), '{"env":{"KEY":"SECRET"}}');
  await write(join(claude, "projects", "p", "session.jsonl"), "SECRET");
  await write(join(claude, "history.jsonl"), "SECRET");
  await write(join(home, ".codex", "auth.json"), '{"token":"SECRET"}');
  await write(join(home, ".codex", "sessions", "rollout.md"), "SECRET");
  // links that lead out of the folder they are in
  await write(join(outside, "skill", "SKILL.md"), "---\nname: escaped\ndescription: from outside\n---\n");
  await write(join(outside, "stolen.md"), "---\ndescription: from outside\n---\n");
  await symlink(join(outside, "skill"), join(claude, "skills", "escape"));
  await symlink(join(outside, "stolen.md"), join(claude, "commands", "stolen.md"));
  // a link to the credentials, named like a command
  await symlink(join(claude, ".credentials.json"), join(claude, "commands", "creds.md"));
  // a loop
  await symlink(join(claude, "commands"), join(claude, "commands", "frontend", "loop"));
  await symlink(join(claude, "commands", "self.md"), join(claude, "commands", "self.md")).catch(() => {});
  // plugins: one installed for the user, one outside the plugins folder, one for another project
  const plugin = join(claude, "plugins", "cache", "market", "tools", "1.0.0");
  await write(join(plugin, "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lint the code\n---\n");
  await write(join(plugin, "commands", "fmt.md"), "---\ndescription: Format the code\n---\n");
  await write(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"tools"}');
  await write(join(outside, "rogue", "commands", "rogue.md"), "---\ndescription: rogue\n---\n");
  const other = join(claude, "plugins", "cache", "market", "other", "1.0.0");
  await write(join(other, "commands", "elsewhere.md"), "# Elsewhere\n");
  await write(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      "tools@market": [{ scope: "user", installPath: plugin, version: "1.0.0" }],
      "rogue@market": [{ scope: "user", installPath: join(outside, "rogue") }],
      "other@market": [{ scope: "project", projectPath: join(root, "another"), installPath: other }],
    },
  }));
  // the pane's project
  await write(join(project, ".claude", "commands", "build.md"), "---\ndescription: Build this project\n---\n");
  await write(join(project, ".claude", "commands", "deploy.md"), "---\ndescription: Deploy from the project\n---\n");
  await write(join(project, ".claude", "skills", "ship", "SKILL.md"), "---\nname: ship\ndescription: Ship it\n---\n");
  await symlink(join(outside, "stolen.md"), join(project, ".claude", "commands", "away.md"));
  // Codex prompts
  await write(join(home, ".codex", "prompts", "fix.md"), "---\ndescription: Fix the bug\n---\n");
  await write(join(home, ".codex", "prompts", "sub", "nested.md"), "# nested\n");
  return { root, home, project, claude };
}

function spyFs() {
  const opened = [];
  const listed = [];
  return {
    opened,
    listed,
    fs: {
      realpath,
      stat,
      async readdir(path, options) {
        listed.push(path);
        return readdir(path, options);
      },
      async open(path, flags) {
        opened.push(path);
        return open(path, flags);
      },
    },
  };
}

const names = (answer, source) => answer.commands.filter((command) => !source || command.source === source).map((command) => command.name);

test("lists the user's, the project's and installed plugins' commands for Claude Code", async (context) => {
  const { root, home, project, claude } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  const spy = spyFs();
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs: spy.fs });
  const answer = await catalog.list({ agent: "claude", cwd: project });
  assert.equal(answer.agent, "claude");

  assert.deepEqual(names(answer, "project"), ["ship", "build", "deploy"]);
  assert.deepEqual(names(answer, "user"), ["alpha", "beta", "a:b:c:deep", "frontend:component", "huge"]);
  assert.deepEqual(names(answer, "plugin"), ["tools:lint", "tools:fmt"]);
  assert.deepEqual(names(answer, "built-in"), CLAUDE_BUILT_IN_COMMANDS.map((command) => command.name));
  const byName = Object.fromEntries(answer.commands.map((command) => [command.name, command]));
  assert.equal(byName.alpha.description, "Does alpha things");
  assert.equal(byName.beta.description, "Beta skill");
  // the project's command of the same name wins
  assert.equal(byName.deploy.description, "Deploy from the project");
  assert.equal(byName.huge.description, "", "a file over the limit is listed by name, unread");
  for (const command of answer.commands) assert.deepEqual(Object.keys(command), ["name", "description", "source"]);
  const found = answer.commands.filter((command) => command.source !== "built-in");
  assert.doesNotMatch(JSON.stringify(found), /SECRET|BODY|from outside|rogue|escaped|stolen|away|creds|elsewhere|deeper|notes|loop|self/u);

  // only command files and the plugin list were opened
  for (const path of spy.opened) {
    assert.ok(path.endsWith(".md") || path === join(claude, "plugins", "installed_plugins.json"), `opened ${path}`);
    assert.ok(path.startsWith(claude) || path.startsWith(project), `opened ${path}`);
    assert.doesNotMatch(path, /credentials|settings|projects|history|auth|outside|huge/u, `opened ${path}`);
  }
  for (const path of spy.listed) assert.doesNotMatch(path, /\/projects|outside|\.codex/u, `listed ${path}`);

  // kept for a while: nothing is opened again
  const count = spy.opened.length;
  await catalog.list({ agent: "claude", cwd: project });
  assert.equal(spy.opened.length, count);
});

test("lists Codex's own commands and the user's prompts", async (context) => {
  const { root, home, project } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  const spy = spyFs();
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs: spy.fs });
  const answer = await catalog.list({ agent: "Codex", cwd: project });
  assert.equal(answer.agent, "codex");
  assert.deepEqual(names(answer, "user"), ["prompts:fix"]);
  assert.equal(answer.commands[0].description, "Fix the bug");
  assert.deepEqual(names(answer, "built-in"), CODEX_BUILT_IN_COMMANDS.map((command) => command.name));
  assert.deepEqual(spy.opened, [join(home, ".codex", "prompts", "fix.md")]);
});

test("lists OpenCode's own commands and the user's and project's command files, never its config", async (context) => {
  const { root, home, project } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, text) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  const xdg = join(root, "xdg");
  const outside = join(root, "outside");
  await write(join(xdg, "opencode", "commands", "test.md"), "---\ndescription: Run the tests\n---\nBODY-SECRET\n");
  await write(join(xdg, "opencode", "command", "legacy.md"), "---\ndescription: Old folder\n---\n");
  await write(join(xdg, "opencode", "commands", "sub", "nested.md"), "# nested\n");
  await write(join(xdg, "opencode", "opencode.json"), '{"provider":{"key":"SECRET"}}');
  await write(join(xdg, "opencode", "opencode.jsonc"), "{}");
  await write(join(home, ".local", "share", "opencode", "auth.json"), '{"token":"SECRET"}');
  await write(join(project, ".opencode", "commands", "deploy.md"), "---\ndescription: Deploy it\n---\n");
  await write(join(project, ".opencode", "command", "old.md"), "# Old project command\n");
  await write(join(project, ".opencode", "commands", "test.md"), "---\ndescription: Project tests\n---\n");
  await write(join(project, "opencode.json"), '{"command":{"x":{}}}');
  await write(join(outside, "stolen.md"), "---\ndescription: from outside\n---\n");
  await symlink(join(outside, "stolen.md"), join(project, ".opencode", "commands", "away.md"));
  await symlink(join(xdg, "opencode", "opencode.json"), join(xdg, "opencode", "commands", "cfg.md"));
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "app", "src"), { recursive: true });
  const spy = spyFs();
  const env = { HOME: home, XDG_CONFIG_HOME: xdg };
  const catalog = new SlashCommandCatalog({ env, guard: localProtectedPaths({ env, home }), fs: spy.fs });
  const answer = await catalog.list({ agent: "OpenCode", cwd: join(project, "app", "src") });
  assert.equal(answer.agent, "opencode");
  // commands first, then skills (the project's .claude/skills, the user's ~/.claude/skills)
  assert.deepEqual(names(answer, "project"), ["deploy", "test", "old", "ship"]);
  assert.deepEqual(names(answer, "user"), ["legacy", "alpha"], "the project's /test wins over the user's");
  assert.equal(answer.commands.find((command) => command.name === "test").description, "Project tests");
  assert.equal(answer.commands.find((command) => command.name === "alpha").description, "Does alpha things");
  assert.ok(!names(answer).includes("beta"), "a SKILL.md without a name is no skill to OpenCode");
  assert.deepEqual(names(answer, "built-in"), OPENCODE_BUILT_IN_COMMANDS.map((command) => command.name));
  for (const name of ["compact", "undo", "redo", "sessions", "models", "thinking"]) assert.ok(names(answer, "built-in").includes(name), name);
  assert.doesNotMatch(JSON.stringify(answer), /BODY|SECRET|escaped|from outside/u);
  const all = answer.commands.map((command) => command.name);
  assert.ok(!all.includes("away") && !all.includes("cfg") && !all.includes("nested"), all.join());
  for (const path of [...spy.opened, ...spy.listed]) assert.doesNotMatch(path, /opencode\.jsonc?$|auth\.json|outside/u, `touched ${path}`);
  for (const path of spy.opened) assert.match(path, /\.md$/u);

  // the default config folder, ~/.config/opencode
  await write(join(home, ".config", "opencode", "commands", "home.md"), "# From home config\n");
  const plain = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }) });
  assert.deepEqual(names(await plain.list({ agent: "opencode", cwd: null }), "user"), ["home", "alpha"]);
});

test("OpenCode's own list matches its 1.19.3 TUI and server commands", () => {
  const all = OPENCODE_BUILT_IN_COMMANDS.map((command) => command.name);
  assert.ok(!all.includes("details"), "1.19.3 has no /details");
  for (const name of [
    "review", "init", "agents", "mcps", "status", "skills", "copy", "fork", "rename", "timeline", "timestamps",
    "variants", "diff", "debug", "update", "workspaces", "move", "org", "warp",
    "mo", "toggle-thinking", "toggle-timestamps", "customize-opencode",
  ]) assert.ok(all.includes(name), name);
  assert.equal(new Set(all).size, all.length);
  const byName = Object.fromEntries(OPENCODE_BUILT_IN_COMMANDS.map((command) => [command.name, command.description]));
  assert.equal(byName.review, "review changes [commit|branch|pr], defaults to uncommitted");
  assert.equal(byName.init, "guided AGENTS.md setup");
  assert.equal(byName.move, "Move to another project dir");
  assert.equal(byName.mo, "Switch model (alias of /models)");
  for (const command of OPENCODE_BUILT_IN_COMMANDS) assert.ok(command.description.length <= 200, command.name);
});

async function writeTo(path, text) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

test("lists OpenCode's skills as its /commands, a command's name first", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slash-oc-skills-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const xdg = join(root, "xdg");
  await mkdir(join(project, ".git"), { recursive: true });
  const skill = (folder, text) => writeTo(join(folder, "SKILL.md"), text);
  await skill(join(project, ".opencode", "skills", "group", "nested"), "---\nname: nested\ndescription: A nested skill\n---\nBODY-SECRET\n");
  await skill(join(project, ".opencode", "skill", "single"), "---\nname: single-folder\ndescription: From skill/\n---\n");
  await skill(join(project, ".opencode", "skills", "nameless"), "# No name in the frontmatter\n");
  await skill(join(project, ".opencode", "skills", "review"), "---\nname: review\ndescription: A skill named like the server's command\n---\n");
  await skill(join(project, ".opencode", "skills", "deploy"), "---\nname: deploy\ndescription: The skill\n---\n");
  await writeTo(join(project, ".opencode", "commands", "deploy.md"), "---\ndescription: The command\n---\n");
  await skill(join(project, ".opencode", "skills", "big"), `---\nname: other-name\n---\n${"x".repeat(MAX_COMMAND_FILE_BYTES)}`);
  await skill(join(project, ".opencode", "skills", ...Array.from({ length: MAX_SKILL_DEPTH }, (_, n) => `d${n}`)), "---\nname: deepest\n---\n");
  await skill(join(project, ".opencode", "skills", ...Array.from({ length: MAX_SKILL_DEPTH + 1 }, (_, n) => `d${n}`)), "---\nname: too-deep\n---\n");
  await skill(join(project, ".claude", "skills", "from-claude"), "---\nname: from-claude\ndescription: Claude's\n---\n");
  await skill(join(project, ".agents", "skills", "from-agents"), "---\nname: from-agents\ndescription: Agents'\n---\n");
  await skill(join(home, ".claude", "skills", "home-claude"), "---\nname: home-claude\n---\n");
  await skill(join(home, ".agents", "skills", "home-agents"), "---\nname: home-agents\n---\n");
  await skill(join(xdg, "opencode", "skills", "global"), "---\nname: global\ndescription: In the config folder\n---\n");
  await skill(join(home, ".opencode", "skills", "dot-home"), "---\nname: dot-home\n---\n");
  // a link out of the skills folder
  await skill(join(root, "outside", "escaped"), "---\nname: escaped\n---\n");
  await symlink(join(root, "outside", "escaped"), join(project, ".opencode", "skills", "escape"));
  const spy = spyFs();
  const make = (extra = {}) => {
    const env = { HOME: home, XDG_CONFIG_HOME: xdg, ...extra };
    return new SlashCommandCatalog({ env, guard: localProtectedPaths({ env, home }), fs: spy.fs });
  };
  const answer = await make().list({ agent: "opencode", cwd: project });
  assert.deepEqual(names(answer, "project"), ["deploy", "from-claude", "from-agents", "single-folder", "big", "deepest", "nested"]);
  assert.deepEqual(names(answer, "user"), ["home-claude", "home-agents", "dot-home", "global"]);
  const byName = Object.fromEntries(answer.commands.map((command) => [command.name, command]));
  assert.equal(byName.deploy.description, "The command", "a command wins over a skill of its name");
  assert.equal(byName.review.source, "built-in", "the server's /review wins over a skill of its name");
  assert.equal(byName.nested.description, "A nested skill");
  assert.equal(byName.big.description, "", "too large to read: listed by its folder's name");
  assert.equal(byName["customize-opencode"].source, "built-in");
  for (const absent of ["nameless", "too-deep", "escaped", "other-name"]) assert.ok(!byName[absent], absent);
  assert.doesNotMatch(JSON.stringify(answer), /BODY-SECRET/u);
  for (const path of spy.opened) assert.match(path, /\.md$/u);

  // OpenCode's switches: no Claude Code skills, no external skills at all
  const noClaude = await make({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }).list({ agent: "opencode", cwd: project });
  assert.ok(!names(noClaude).includes("from-claude") && !names(noClaude).includes("home-claude"));
  assert.ok(names(noClaude).includes("from-agents") && names(noClaude).includes("home-agents"));
  const noExternal = await make({ OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" }).list({ agent: "opencode", cwd: project });
  for (const name of ["from-claude", "home-claude", "from-agents", "home-agents"]) assert.ok(!names(noExternal).includes(name), name);
  assert.ok(names(noExternal).includes("nested") && names(noExternal).includes("global"));
});

test("OpenCode's config folders: up to the checkout's root or to /, ~/.opencode and OPENCODE_CONFIG_DIR", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slash-oc-dirs-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  const top = join(root, "top");
  const repo = join(top, "repo");
  const leaf = join(repo, "a", "b");
  const command = (folder, name, description) => writeTo(join(folder, "commands", `${name}.md`), `---\ndescription: ${description}\n---\n`);
  await mkdir(leaf, { recursive: true });
  await command(join(leaf, ".opencode"), "leaf", "In the pane's folder");
  await command(join(repo, "a", ".opencode"), "middle", "Between");
  await command(join(repo, ".opencode"), "root", "At the checkout's root");
  await command(join(top, ".opencode"), "above", "Above the checkout");
  await command(join(home, ".opencode"), "home-dot", "In ~/.opencode");
  await writeTo(join(home, ".opencode", "opencode.json"), '{"provider":{"key":"SECRET"}}');
  const custom = join(root, "custom");
  await command(custom, "custom", "In OPENCODE_CONFIG_DIR");
  await writeTo(join(custom, "skills", "custom-skill", "SKILL.md"), "---\nname: custom-skill\n---\n");
  await writeTo(join(custom, "opencode.jsonc"), "{}");
  const spy = spyFs();
  const make = (extra = {}) => {
    const env = { HOME: home, XDG_CONFIG_HOME: xdg, ...extra };
    return new SlashCommandCatalog({ env, guard: localProtectedPaths({ env, home }), fs: spy.fs });
  };

  // not in a checkout: every folder up to /
  let answer = await make().list({ agent: "opencode", cwd: leaf });
  for (const name of ["leaf", "middle", "root", "above"]) assert.ok(names(answer, "project").includes(name), name);
  assert.deepEqual(names(answer, "project").slice(0, 4), ["leaf", "middle", "root", "above"], "nearest first");
  assert.deepEqual(names(answer, "user"), ["home-dot"], "~/.opencode is always read");

  // in a checkout: up to its root, not above it
  await mkdir(join(repo, ".git"));
  answer = await make({ OPENCODE_CONFIG_DIR: custom }).list({ agent: "opencode", cwd: leaf });
  assert.deepEqual(names(answer, "project"), ["leaf", "middle", "root"]);
  assert.deepEqual(names(answer, "user"), ["home-dot", "custom", "custom-skill"]);

  // a relative OPENCODE_CONFIG_DIR is not followed; project config switched off
  answer = await make({ OPENCODE_CONFIG_DIR: "custom", OPENCODE_DISABLE_PROJECT_CONFIG: "1" }).list({ agent: "opencode", cwd: leaf });
  assert.deepEqual(names(answer, "project"), []);
  assert.deepEqual(names(answer, "user"), ["home-dot"]);

  // a pane with no folder still gets ~/.opencode's
  assert.deepEqual(names(await make().list({ agent: "opencode", cwd: null }), "user"), ["home-dot"]);
  for (const path of [...spy.opened, ...spy.listed]) assert.doesNotMatch(path, /opencode\.jsonc?$|auth\.json/u, `touched ${path}`);

  // so many folders up, and no further
  const deep = join(root, "deep");
  const folders = Array.from({ length: MAX_OPENCODE_LEVELS + 8 }, (_, n) => `d${n}`);
  const bottom = join(deep, ...folders);
  await mkdir(bottom, { recursive: true });
  await mkdir(join(deep, ".git"));
  const last = join(deep, ...folders.slice(0, folders.length - MAX_OPENCODE_LEVELS + 1));
  await command(join(last, ".opencode"), "farthest", "The last folder looked at");
  await command(join(last, "..", ".opencode"), "beyond", "One folder too far");
  answer = await make().list({ agent: "opencode", cwd: bottom });
  assert.ok(names(answer, "project").includes("farthest"));
  assert.ok(!names(answer).includes("beyond"));
});

test("gives other agents nothing", async (context) => {
  const { root, home, project } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  const spy = spyFs();
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs: spy.fs });
  for (const agent of [null, undefined, "", "bash", "gemini", 3]) {
    assert.deepEqual(await catalog.list({ agent, cwd: project }), { agent: null, commands: [] });
  }
  assert.deepEqual(spy.opened, []);
  assert.deepEqual(spy.listed, []);
});

test("a pane with no folder still gets the user's commands", async (context) => {
  const { root, home } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }) });
  const answer = await catalog.list({ agent: "claude", cwd: null });
  assert.deepEqual(names(answer, "project"), []);
  assert.ok(names(answer, "user").includes("alpha"));
});

async function startServer(herdr, options = {}) {
  const created = createHerdrHttpServer({ herdr, csrfToken: "fixed-test-token", logger: { error() {} }, ...options });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  return { ...created, baseUrl: `http://127.0.0.1:${created.server.address().port}` };
}

test("GET /api/panes/:id/commands answers for the pane's agent and folder", async (context) => {
  const { root, home, project } = await tree();
  const herdr = {
    async snapshot() {
      return {
        workspaces: [], tabs: [], agents: [{ pane_id: "w1:p3", agent: "codex" }],
        panes: [
          { pane_id: "w1:p1", agent: "claude", cwd: root, foreground_cwd: project },
          { pane_id: "w1:p2", agent: "bash", cwd: project },
          { pane_id: "w1:p3", cwd: project },
          { pane_id: "link_lab!w1:p1", agent: "claude", cwd: project, server_id: "link_lab" },
        ],
      };
    },
  };
  const slashCommands = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }) });
  const app = await startServer(herdr, { slashCommands });
  context.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const get = (paneId, headers = {}) => fetch(`${app.baseUrl}/api/panes/${encodeURIComponent(paneId)}/commands`, { headers });

  const claude = await (await get("w1:p1")).json();
  assert.equal(claude.agent, "claude");
  assert.ok(names(claude, "project").includes("build"), "the pane's own folder is read");
  assert.ok(names(claude, "built-in").includes("compact"));
  assert.deepEqual(await (await get("w1:p2")).json(), { agent: null, commands: [] });
  assert.deepEqual(names(await (await get("w1:p3")).json(), "user"), ["prompts:fix"]);
  const remote = await (await get("link_lab!w1:p1")).json();
  assert.equal(remote.remote, true);
  assert.deepEqual(names(remote).length, CLAUDE_BUILT_IN_COMMANDS.length);
  assert.equal((await get("w1:gone")).status, 404);
  assert.equal((await get("w1:p1", { Origin: "https://evil.example" })).status, 403);
});

test("a connected PC's list is held to what a list here could be", () => {
  assert.equal(cleanRemoteCommands(null, "claude"), null);
  assert.equal(cleanRemoteCommands("nope", "claude"), null);
  assert.equal(cleanRemoteCommands({ agent: "claude", commands: "ship" }, "claude"), null);
  assert.equal(cleanRemoteCommands({ agent: "codex", commands: [{ name: "ship" }] }, "claude"), null, "another agent's list");
  assert.equal(cleanRemoteCommands({ agent: "claude", commands: [null, 3, { name: "a b" }, { name: "x/y" }] }, "claude"), null, "nothing usable");
  const cleaned = cleanRemoteCommands({
    agent: "claude",
    commands: [null, { name: "ship", description: "Ship\n\tit", source: "plugin", body: "SECRET" }, { name: "ship", description: "again" }, { name: "odd", source: "elsewhere" }],
  }, "claude");
  assert.deepEqual(cleaned, [
    { name: "ship", description: "Ship it", source: "plugin" },
    { name: "odd", description: "", source: "other" },
  ]);
  const many = cleanRemoteCommands({ agent: "claude", commands: Array.from({ length: 900 }, (_, n) => ({ name: `c${n}`, source: "user" })) }, "claude");
  assert.equal(many.length, MAX_REMOTE_COMMANDS);
  // a full list of found commands keeps the agent's own after it
  const full = cleanRemoteCommands({
    agent: "claude",
    commands: [...Array.from({ length: MAX_LISTED_COMMANDS }, (_, n) => ({ name: `c${n}`, source: "user" })), ...CLAUDE_BUILT_IN_COMMANDS.map((command) => ({ ...command, source: "built-in" }))],
  }, "claude");
  assert.ok(full.some((command) => command.name === CLAUDE_BUILT_IN_COMMANDS.at(-1).name), "the agent's own were cut off a full list");
});

test("GET /api/panes/:id/commands asks a connected PC for its pane's list, and falls back to the agent's own", async (context) => {
  const asked = [];
  let answer = { agent: "claude", commands: [{ name: "ship", description: "Ship it", source: "project" }] };
  const herdr = {
    async snapshot() {
      return {
        workspaces: [], tabs: [], agents: [],
        panes: [
          { pane_id: "link_lab!w1:p1", agent: "claude", cwd: "/work", server_id: "link_lab" },
          { pane_id: "link_lab!w1:p2", agent: "claude", cwd: "/work", server_id: "link_lab" },
          { pane_id: "link_lab!w1:p3", agent: "codex", server_id: "link_lab" },
        ],
      };
    },
    async paneCommands(paneId) {
      asked.push(paneId);
      if (paneId.endsWith("p2")) throw Object.assign(new Error("offline"), { code: "link_offline" });
      return answer;
    },
  };
  const slashCommands = new SlashCommandCatalog({ env: { HOME: "/nonexistent-herdrabbit-home" }, fs: { open: () => assert.fail("opened a file"), readdir: () => assert.fail("listed a folder"), realpath, stat } });
  const app = await startServer(herdr, { slashCommands });
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const get = async (paneId) => (await fetch(`${app.baseUrl}/api/panes/${encodeURIComponent(paneId)}/commands`)).json();

  assert.deepEqual(await get("link_lab!w1:p1"), { agent: "claude", commands: answer.commands, remote: true });
  // kept a little while: not asked again
  answer = { agent: "claude", commands: [{ name: "other", description: "", source: "user" }] };
  assert.equal((await get("link_lab!w1:p1")).commands[0].name, "ship");
  assert.deepEqual(asked, ["link_lab!w1:p1"]);
  // a PC that cannot be reached: the agent's own, the composer still gets a list
  assert.deepEqual((await get("link_lab!w1:p2")).commands, [...CLAUDE_BUILT_IN_COMMANDS]);
  // a Claude list for a pane the hub sees running Codex is not taken
  assert.deepEqual((await get("link_lab!w1:p3")).commands, [...CODEX_BUILT_IN_COMMANDS]);
});

test("the commands route needs a signed-in session", async (context) => {
  const auth = new PasswordAuth(await createPasswordConfiguration("secret"));
  const herdr = { async snapshot() { return { workspaces: [], tabs: [], agents: [], panes: [{ pane_id: "w1:p1", agent: "claude" }] }; } };
  const app = await startServer(herdr, { auth, slashCommands: { list: async () => assert.fail("listed without a session") } });
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const response = await fetch(`${app.baseUrl}/api/panes/w1%3Ap1/commands`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "authentication_required");
});

test("a folder with a great many entries is looked at only so far", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "hr-slash-many-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const commands = join(home, ".claude", "commands");
  await mkdir(commands, { recursive: true });
  await Promise.all(Array.from({ length: MAX_SCANNED_ENTRIES + 50 }, (_, i) => writeFile(join(commands, `n${String(i).padStart(5, "0")}.txt`), "")));
  await writeFile(join(commands, "zz-last.md"), "---\ndescription: past the limit\n---\n");
  const spy = spyFs();
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs: spy.fs });
  const answer = await catalog.list({ agent: "claude", cwd: null });
  assert.deepEqual(names(answer, "user"), [], "a command past the scan limit was still read");
  assert.ok(!spy.opened.some((path) => path.endsWith("zz-last.md")));
});

test("a file that is not the one checked, once open, is not read", { skip: process.platform !== "linux" }, async (context) => {
  const { root, home, project } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  const spy = spyFs();
  // stands in for a folder above swapped for a link between the check and the open
  const outside = join(root, "outside.md");
  await writeFile(outside, "---\ndescription: SECRET-OUTSIDE\n---\n");
  const fs = { ...spy.fs, open: (path, flags) => spy.fs.open(path.endsWith("SKILL.md") ? outside : path, flags) };
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs });
  const answer = await catalog.list({ agent: "claude", cwd: project });
  assert.ok(answer.commands.every((command) => !command.description.includes("SECRET-OUTSIDE")), "the swapped file's text went out");
});

test("a pane in a checkout's subfolder gets the checkout root's commands and project plugins too", async (context) => {
  const { root, home, project, claude } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(project, ".git"));
  const inner = join(project, "src", "lib");
  await mkdir(join(inner, ".claude", "commands"), { recursive: true });
  await writeFile(join(inner, ".claude", "commands", "build.md"), "---\ndescription: Build the lib\n---\n");
  // a plugin installed for the checkout's root
  const manifest = join(claude, "plugins", "installed_plugins.json");
  const installed = JSON.parse(await readFile(manifest, "utf8"));
  installed.plugins["other@market"][0].projectPath = project;
  await writeFile(manifest, JSON.stringify(installed));
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs: spyFs().fs });
  const answer = await catalog.list({ agent: "claude", cwd: inner });
  assert.deepEqual(names(answer, "project"), ["build", "ship", "deploy"]);
  assert.equal(answer.commands.find((command) => command.name === "build").description, "Build the lib", "the nearest folder's wins");
  assert.ok(names(answer, "plugin").includes("other:elsewhere"), "the root's project plugin is missing");

  // outside a git checkout only the pane's own folder counts
  await rm(join(project, ".git"), { recursive: true });
  const plain = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs: spyFs().fs });
  assert.deepEqual(names(await plain.list({ agent: "claude", cwd: inner }), "project"), ["build"]);
});

test("a huge project folder takes nothing from the user's own commands", async (context) => {
  const { root, home, project } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  const commands = join(project, ".claude", "commands");
  await Promise.all(Array.from({ length: MAX_SCANNED_ENTRIES + 50 }, (_, i) => writeFile(join(commands, `n${String(i).padStart(5, "0")}.txt`), "")));
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs: spyFs().fs });
  const answer = await catalog.list({ agent: "claude", cwd: project });
  assert.deepEqual(names(answer, "user"), ["alpha", "beta", "a:b:c:deep", "frontend:component", "huge"]);
  assert.deepEqual(names(answer, "plugin"), ["tools:lint", "tools:fmt"]);
});
