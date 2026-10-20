import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "./herdr-client.mjs";

// A pane keeps the size of the last TUI client that touched its tab. With no
// client attached those leftovers outlive the client that set them, and a
// full-screen agent then renders into a window it was never built for. The
// only headless repair is a fresh pane: new panes take the server's
// configured headless size, so close and recreate.

export const DEFAULT_HEADLESS_COLS = 120;
export const DEFAULT_HEADLESS_ROWS = 40;

export function defaultHerdrConfigPath(environment = process.env) {
  return environment.HERDR_CONFIG_PATH
    || join(homedir(), ".config", "herdr", "config.toml");
}

// [server] headless_cols / headless_rows override the built-in 120x40. The
// file is plain TOML and these are the only values read from it, so a line
// scan beats pulling in a parser for one table.
export function parseHeadlessConfig(text) {
  let inServer = false;
  let cols = null;
  let rows = null;
  for (const line of String(text).split("\n")) {
    const value = line.trim();
    if (value.startsWith("#") || value === "") continue;
    if (value.startsWith("[")) {
      inServer = value === "[server]";
      continue;
    }
    if (!inServer) continue;
    const match = value.match(/^(headless_(?:cols|rows))\s*=\s*(\d+)(?:\s+#.*)?$/);
    if (!match) continue;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 2 || number > 500) continue;
    if (match[1] === "headless_cols") cols = number;
    else rows = number;
  }
  return {
    cols: cols ?? DEFAULT_HEADLESS_COLS,
    rows: rows ?? DEFAULT_HEADLESS_ROWS,
  };
}

export async function readHeadlessSize({
  path = null,
  readFile: read = readFile,
} = {}) {
  const configPath = path ?? defaultHerdrConfigPath();
  let text;
  try {
    text = await read(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { cols: DEFAULT_HEADLESS_COLS, rows: DEFAULT_HEADLESS_ROWS };
  }
  return parseHeadlessConfig(text);
}

function idOf(record, ...keys) {
  for (const key of keys) {
    if (typeof record?.[key] === "string") return record[key];
  }
  return "";
}

export function staleSoloPanes(snapshot, { cols, rows }) {
  if (!snapshot) return [];
  const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  const panes = Array.isArray(snapshot.panes) ? snapshot.panes : [];
  const soloTabIds = new Set(tabs
    .filter((tab) => tab.pane_count === 1)
    .map((tab) => idOf(tab, "tab_id")));
  const stale = [];
  for (const pane of panes) {
    const viewportRows = pane?.scroll?.viewport_rows;
    if (!soloTabIds.has(idOf(pane, "tab_id"))) continue;
    if (typeof viewportRows !== "number" || viewportRows === rows) continue;
    stale.push({
      paneId: idOf(pane, "pane_id"),
      tabId: idOf(pane, "tab_id"),
      workspaceId: idOf(pane, "workspace_id"),
      viewportRows,
      agent: typeof pane?.agent === "string" ? pane.agent : null,
    });
  }
  return stale;
}

// Only panes nothing is waiting on may be replaced: a working or blocked
// agent would lose its session.
export function repairablePanes(panes) {
  return panes.filter(({ agent }) => !agent);
}

// The tab of a replaced pane loses it, and a tab cannot outlive its last
// pane, so the replacement is a new tab in the same workspace.
export async function repairPane(client, { paneId, tabId, workspaceId }) {
  for (const id of [tabId, workspaceId]) {
    if (typeof id !== "string" || id === "") {
      throw new InputValidationError("Invalid pane location");
    }
  }
  await client.closeTab(tabId);
  await client.createTab(workspaceId);
  return paneId;
}
