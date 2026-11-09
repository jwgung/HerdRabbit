// What a `/` command in the composer's list can be, wherever it comes from
// (src/slash-commands.mjs, src/agent-commands.mjs).

// What a typed `/name` can be: no spaces, quotes or slashes.
export const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u;
// A description longer than this is cut, so a list row shows one line.
export const MAX_COMMAND_DESCRIPTION = 200;

// One line of plain text, without control characters, cut to what a list row shows.
export function commandLine(value, limit = MAX_COMMAND_DESCRIPTION) {
  // eslint-disable-next-line no-control-regex
  const flat = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}
