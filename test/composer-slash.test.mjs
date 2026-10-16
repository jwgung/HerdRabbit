import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SLASH_MATCHES,
  applySlashCompletion,
  matchingCommands,
  parseSlashQuery,
  slashCommandsSource,
} from "../public/composer-slash.js";

const slash = (value, caret = value.length) => parseSlashQuery(value, caret, caret);

test("finds the /command word only at the very start of the text", () => {
  assert.deepEqual(slash("/"), { start: 0, end: 1, query: "" });
  assert.deepEqual(slash("/com"), { start: 0, end: 4, query: "com" });
  assert.deepEqual(slash("/plugin:sk"), { start: 0, end: 10, query: "plugin:sk" });
  // the rest of the word after the caret is part of it
  assert.deepEqual(parseSlashQuery("/compact more", 3, 3), { start: 0, end: 8, query: "co" });
});

test("is no command after a space, mid-text, before the slash or with a selection", () => {
  assert.equal(slash("/compact "), null);
  assert.equal(slash("/compact now"), null);
  assert.equal(slash("look /com"), null);
  assert.equal(slash(" /com"), null);
  assert.equal(slash("a/com"), null);
  assert.equal(slash("line\n/com"), null);
  assert.equal(slash("plain"), null);
  assert.equal(slash(""), null);
  assert.equal(parseSlashQuery("/com", 0, 0), null);
  assert.equal(parseSlashQuery("/com", 1, 3), null);
  assert.equal(parseSlashQuery("/com", undefined), null);
  assert.equal(parseSlashQuery(null, 1), null);
});

test("an absolute path at the start is no command", () => {
  assert.equal(slash("/home/me"), null);
  assert.equal(slash("/etc/"), null);
  assert.equal(parseSlashQuery("/et/c", 3, 3), null);
});

const commands = [
  { name: "compact", description: "Compact the conversation", source: "built-in" },
  { name: "commit", description: "Create a git commit", source: "user" },
  { name: "config", description: "Open the settings", source: "built-in" },
  { name: "clear", description: "Clear the conversation history", source: "built-in" },
  { name: "code-review:code-review", description: "Review a pull request", source: "plugin" },
  { name: "recompile", description: "Build again", source: "project" },
  { name: "model", description: "Choose the model", source: "built-in" },
];

test("puts names starting with the query first, then names and descriptions containing it", () => {
  assert.deepEqual(matchingCommands(commands, "com").map((command) => command.name), ["commit", "compact", "recompile"]);
  assert.deepEqual(matchingCommands(commands, "CO").map((command) => command.name),
    ["code-review:code-review", "commit", "compact", "config", "recompile", "clear"]);
  // a description match comes after every name match
  assert.deepEqual(matchingCommands(commands, "conversation").map((command) => command.name), ["clear", "compact"]);
  assert.deepEqual(matchingCommands(commands, "review").map((command) => command.name), ["code-review:code-review"]);
  assert.deepEqual(matchingCommands(commands, "zzz"), []);
});

test("an empty query lists every command by name, capped", () => {
  assert.deepEqual(matchingCommands(commands, "").map((command) => command.name),
    ["clear", "code-review:code-review", "commit", "compact", "config", "model", "recompile"]);
  const many = Array.from({ length: 80 }, (_, index) => ({ name: `cmd${String(index).padStart(2, "0")}`, description: "" }));
  assert.equal(matchingCommands(many, "").length, MAX_SLASH_MATCHES);
  assert.deepEqual(matchingCommands([null, { name: "" }, { description: "x" }, "x"], ""), []);
});

test("picking puts /name and a space in place of the typed word", () => {
  assert.deepEqual(applySlashCompletion("/com", { start: 0, end: 4, query: "com" }, { name: "compact" }),
    { value: "/compact ", caret: 9, open: false });
  // the rest of the text stays, with one space
  assert.deepEqual(applySlashCompletion("/co the rest", { start: 0, end: 3, query: "co" }, { name: "compact" }),
    { value: "/compact the rest", caret: 9, open: false });
  assert.deepEqual(applySlashCompletion("/cothe", { start: 0, end: 6, query: "co" }, { name: "compact" }),
    { value: "/compact ", caret: 9, open: false });
});

test("asks for the pane's commands only for Claude Code and Codex, and keeps them a while", async () => {
  let context = { paneId: "w1:p1", agent: "claude" };
  const asked = [];
  let clock = 0;
  const source = slashCommandsSource({
    context: () => context,
    fetchCommands: async (paneId) => {
      asked.push(paneId);
      return { agent: "claude", commands };
    },
    now: () => clock,
  });
  const found = await source.lookUp({ start: 0, end: 4, query: "com" });
  assert.deepEqual(found.matches.map((command) => command.name), ["commit", "compact", "recompile"]);
  assert.deepEqual(found.where, { paneId: "w1:p1", agent: "claude" });
  await source.lookUp({ start: 0, end: 3, query: "co" });
  assert.deepEqual(asked, ["w1:p1"], "the list was kept");
  clock = 20_000;
  await source.lookUp({ start: 0, end: 3, query: "co" });
  assert.deepEqual(asked, ["w1:p1", "w1:p1"], "an old list is asked again");
  assert.equal(source.stillCurrent(found.where), true);

  context = { paneId: "w1:p1", agent: "codex" };
  assert.equal(source.stillCurrent(found.where), false, "the agent changed");
  // an answer for another agent is no answer
  assert.deepEqual((await source.lookUp({ start: 0, end: 1, query: "" })).matches, []);

  for (const agent of [null, "shell", "gemini"]) {
    context = { paneId: "w1:p2", agent };
    assert.equal(await source.lookUp({ start: 0, end: 1, query: "" }), null, `${agent} has no list`);
  }
  context = null;
  assert.equal(await source.lookUp({ start: 0, end: 1, query: "" }), null);
  assert.equal(source.stillCurrent(found.where), false);
});

test("draws each row with its name, description and source", () => {
  const made = [];
  const element = (tag) => {
    const node = { tag, className: "", dataset: {}, textContent: "", title: "", children: [], append(...nodes) { node.children.push(...nodes); } };
    made.push(node);
    return node;
  };
  const doc = { createElement: element };
  const source = slashCommandsSource({ context: () => null, fetchCommands: async () => ({}) });
  const item = element("li");
  source.renderItem(item, { name: "compact", description: "Compact it", source: "built-in" }, doc);
  assert.equal(item.className, "file-suggestion composer-command");
  assert.deepEqual(item.children.map((child) => [child.className, child.textContent]), [
    ["composer-command-name", "/compact"],
    ["composer-command-description", "Compact it"],
    ["composer-command-source", "built-in"],
  ]);
  const odd = element("li");
  source.renderItem(odd, { name: "x", source: "<b>" }, doc);
  assert.equal(odd.dataset.source, "built-in", "an unknown source is not shown");
});
