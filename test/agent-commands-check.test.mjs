import test from "node:test";
import assert from "node:assert/strict";
import { claudeCommandNames, commandDrift } from "../scripts/check-agent-commands.mjs";

test("reads Claude Code's commands from its commands reference, the removed ones left out", () => {
  const markdown = [
    "| Command | Purpose |",
    "| :-- | :-- |",
    "| `/add-dir <path>` | Add a working directory. |",
    "| `/clear` | Start a new conversation with empty context. Aliases: `/reset`, `/new` |",
    "| `/pr-comments [PR]` | Removed in v2.1.91. Ask Claude directly instead. |",
    "| `/simplify [focus]` | **[Skill](/en/skills).** Review the changed code. |",
    "| `/clear` | listed twice |",
  ].join("\n");
  assert.deepEqual(claudeCommandNames(markdown), ["add-dir", "clear", "simplify"]);
});

test("says which commands a recorded list lacks and which it has that are gone", () => {
  assert.deepEqual(commandDrift(["a", "b", "c"], ["b", "c", "d"]), { missing: ["d"], extra: ["a"] });
  assert.deepEqual(commandDrift(["a"], ["a"]), { missing: [], extra: [] });
});
