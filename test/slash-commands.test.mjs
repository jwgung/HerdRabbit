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
  MAX_SCANNED_ENTRIES,
  SlashCommandCatalog,
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

test("gives other agents nothing, and a remote pane its agent's own commands only", async (context) => {
  const { root, home, project } = await tree();
  context.after(() => rm(root, { recursive: true, force: true }));
  const spy = spyFs();
  const catalog = new SlashCommandCatalog({ env: { HOME: home }, guard: localProtectedPaths({ env: { HOME: home }, home }), fs: spy.fs });
  for (const agent of [null, undefined, "", "bash", "gemini", 3]) {
    assert.deepEqual(await catalog.list({ agent, cwd: project }), { agent: null, commands: [] });
  }
  const remote = await catalog.list({ agent: "claude", cwd: project, remote: true });
  assert.equal(remote.remote, true);
  assert.deepEqual(remote.commands.map((command) => command.source), CLAUDE_BUILT_IN_COMMANDS.map(() => "built-in"));
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
