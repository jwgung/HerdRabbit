// `/` commands in the composer. Typed at the very start of the text, a `/`
// offers the commands the selected pane's agent takes -- Claude Code's,
// Codex's, OpenCode's, Kiro's or Antigravity's own, and the skills, commands
// and prompts the user, the project and installed plugins add
// (GET /api/panes/:id/commands). Picking one puts `/name ` in; nothing is
// sent.
//
// The parts that decide what is typed, what matches and what goes in are
// plain functions; slashCommandsSource hands them to the list above the
// composer (composer-popup.js).

import { agentNamesWith } from "./agents.js?v=1.4.22";

export const MAX_SLASH_MATCHES = 50;
export const SLASH_DEBOUNCE_MS = 60;
export const SLASH_CACHE_MS = 10_000;
export const SLASH_AGENTS = Object.freeze(agentNamesWith("slash"));
export const SLASH_SOURCES = Object.freeze(["built-in", "user", "project", "plugin"]);

// The `/command` word the caret is in, or null. Only the text's first word
// is one: it starts with `/` at the very beginning, the caret is past the
// slash and nothing before the caret is whitespace. `end` takes in the rest
// of the word past the caret. A second `/` (an absolute path) is no command.
export function parseSlashQuery(value, selectionStart, selectionEnd = selectionStart) {
  if (typeof value !== "string" || !Number.isInteger(selectionStart) || selectionStart !== selectionEnd) return null;
  if (!value.startsWith("/") || selectionStart < 1) return null;
  const typed = /^\/([^\s/]*)$/u.exec(value.slice(0, selectionStart));
  if (!typed) return null;
  const rest = /^\S*/u.exec(value.slice(selectionStart))[0];
  if (rest.includes("/")) return null;
  return { start: 0, end: selectionStart + rest.length, query: typed[1] };
}

const byName = (first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0);

// What is offered for `query`: the names that start with it, by name; then
// those with it elsewhere in the name, then in the description.
export function matchingCommands(commands, query = "", limit = MAX_SLASH_MATCHES) {
  const wanted = String(query).toLowerCase();
  const valid = (Array.isArray(commands) ? commands : [])
    .filter((command) => typeof command?.name === "string" && command.name !== "");
  const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");
  const starts = valid.filter((command) => lower(command.name).startsWith(wanted)).sort(byName);
  if (wanted === "") return starts.slice(0, limit);
  const inName = valid.filter((command) => !lower(command.name).startsWith(wanted) && lower(command.name).includes(wanted)).sort(byName);
  const inDescription = valid.filter((command) => !lower(command.name).includes(wanted) && lower(command.description).includes(wanted)).sort(byName);
  return [...starts, ...inName, ...inDescription].slice(0, limit);
}

// The composer once `command` is picked for `token`: `/name ` replaces the
// typed word, with the caret after the space.
export function applySlashCompletion(value, token, command) {
  const text = `/${command.name}`;
  let tail = value.slice(token.end);
  if (!/^\s/u.test(tail)) tail = ` ${tail}`;
  return { value: `${text}${tail}`, caret: text.length + 1, open: false };
}

// The `/` source of the composer's list. `context()` says which pane is
// selected, what its agent is and the folder it is in ({ paneId, agent, cwd })
// or null; a project's commands go with its folder, so a pane that moves gets
// the new folder's at once.
// `fetchCommands(paneId)` brings back { agent, commands } or throws. A pane
// whose agent is not Claude Code, Codex or OpenCode gets no list.
export function slashCommandsSource({ context, fetchCommands, now = () => Date.now() }) {
  const cache = new Map();
  const where = () => {
    const found = context();
    return found && typeof found.paneId === "string" && SLASH_AGENTS.includes(found.agent) ? found : null;
  };
  async function commandsFor({ paneId, agent, cwd }) {
    const key = JSON.stringify([paneId, agent, cwd ?? null]);
    const kept = cache.get(key);
    if (kept && now() - kept.at <= SLASH_CACHE_MS) return kept.commands;
    const answer = await fetchCommands(paneId);
    const commands = answer?.agent === agent && Array.isArray(answer.commands) ? answer.commands : [];
    if (cache.size > 64) cache.clear();
    cache.set(key, { at: now(), commands });
    return commands;
  }
  return {
    label: "Commands",
    debounceMs: SLASH_DEBOUNCE_MS,
    parse: parseSlashQuery,
    async lookUp(token) {
      const pane = where();
      if (!pane) return null;
      const commands = await commandsFor(pane);
      return { matches: matchingCommands(commands, token.query), where: { paneId: pane.paneId, agent: pane.agent, cwd: pane.cwd ?? null } };
    },
    // Another pane, or the pane's agent or folder changed: the commands are another's.
    stillCurrent(previous) {
      const pane = where();
      return Boolean(pane) && pane.paneId === previous?.paneId && pane.agent === previous?.agent && (pane.cwd ?? null) === (previous?.cwd ?? null);
    },
    sameToken: (a, b) => a.start === b.start && a.end === b.end && a.query === b.query,
    apply: applySlashCompletion,
    renderItem(item, command, doc) {
      item.className = "file-suggestion composer-command";
      // a source this page does not know yet is "other", never one it is not
      const source = SLASH_SOURCES.includes(command.source) ? command.source : "other";
      item.dataset.source = source;
      const name = doc.createElement("span");
      name.className = "composer-command-name";
      name.textContent = `/${command.name}`;
      const description = doc.createElement("span");
      description.className = "composer-command-description";
      description.textContent = typeof command.description === "string" ? command.description : "";
      if (description.textContent) description.title = description.textContent;
      const tag = doc.createElement("span");
      tag.className = "composer-command-source";
      tag.textContent = source;
      item.append(name, description, tag);
    },
  };
}
