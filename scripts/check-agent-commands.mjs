// Whether the list of Claude Code's own `/` commands HerdRabbit keeps
// (src/slash-commands.mjs) still matches Claude Code's commands reference.
// A pane's Claude Code is asked for its commands itself (src/agent-commands.mjs),
// but its answer leaves out the ones only its terminal UI has, which come from
// that list, as does the whole list when the build cannot be asked. Codex
// needs no such check: a pane's Codex commands are read from its own release.
// Run it after a Claude Code update:
//
//   npm run check:agent-commands
//
// It exits 1 and names the commands to add and to drop when the list is behind.
// It needs the network; nothing is changed.
import { pathToFileURL } from "node:url";
import { boundedText } from "../src/agent-commands.mjs";
import { CLAUDE_BUILT_IN_COMMANDS } from "../src/slash-commands.mjs";

const REFERENCE = "https://code.claude.com/docs/en/commands.md";
// The reference is about 60 KiB; a page far larger than that is not it.
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;

// The commands of Claude Code's commands reference (its Markdown form): the
// first `/name` of each table row, once, less the rows that say it was removed.
export function claudeCommandNames(markdown) {
  const names = [];
  for (const line of String(markdown).split("\n")) {
    const cells = line.split(/(?<!\\)\|/u).map((cell) => cell.trim());
    const name = /^`\/([a-z0-9][a-z0-9:-]*)/u.exec(cells[1] ?? "")?.[1];
    if (!name || names.includes(name) || /^Removed\b/u.test(cells[2] ?? "")) continue;
    names.push(name);
  }
  return names;
}

// What `recorded` lacks of `current`, and what it has that `current` does not.
export function commandDrift(recorded, current) {
  const have = new Set(recorded);
  const now = new Set(current);
  return { missing: current.filter((name) => !have.has(name)), extra: recorded.filter((name) => !now.has(name)) };
}

async function main() {
  const response = await fetch(REFERENCE, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${REFERENCE} answered ${response.status}`);
  const markdown = await boundedText(response, MAX_REFERENCE_BYTES);
  if (markdown === null) throw new Error(`${REFERENCE} is larger than ${MAX_REFERENCE_BYTES} bytes`);
  const drift = commandDrift(CLAUDE_BUILT_IN_COMMANDS.map((command) => command.name), claudeCommandNames(markdown));
  if (drift.missing.length === 0 && drift.extra.length === 0) {
    console.log("Claude Code: the list matches its commands reference");
    return;
  }
  console.error("Claude Code: the list in src/slash-commands.mjs is behind its commands reference");
  if (drift.missing.length > 0) console.error(`  add:  ${drift.missing.join(", ")}`);
  if (drift.extra.length > 0) console.error(`  drop: ${drift.extra.join(", ")}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`Could not check Claude Code's commands: ${error.message}`);
    process.exit(1);
  });
}
