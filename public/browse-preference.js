export const BROWSE_PATH_STORAGE_KEY = "herdrbridge-browse-path";
export const FILE_SERVER_STORAGE_KEY = "herdrbridge-file-server";
export const NAVIGATOR_TAB_STORAGE_KEY = "herdrbridge-navigator-tab";
export const NAVIGATOR_WIDTH_STORAGE_KEY = "herdrbridge-navigator-width";

export const MIN_NAVIGATOR_WIDTH = 260;
export const MAX_NAVIGATOR_WIDTH = 720;
export const DEFAULT_NAVIGATOR_WIDTH = 310;

export function clampNavigatorWidth(value) {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return DEFAULT_NAVIGATOR_WIDTH;
  return Math.min(MAX_NAVIGATOR_WIDTH, Math.max(MIN_NAVIGATOR_WIDTH, width));
}

export function readNavigatorWidth(storage) {
  try {
    const value = storage?.getItem(NAVIGATOR_WIDTH_STORAGE_KEY);
    if (value === null || value === undefined || value === "") return DEFAULT_NAVIGATOR_WIDTH;
    return clampNavigatorWidth(value);
  } catch {
    return DEFAULT_NAVIGATOR_WIDTH;
  }
}

export function writeNavigatorWidth(storage, width) {
  try {
    if (!storage) return false;
    storage.setItem(NAVIGATOR_WIDTH_STORAGE_KEY, String(clampNavigatorWidth(width)));
    return true;
  } catch {
    return false;
  }
}

const MAX_PATH_LENGTH = 4096;
const TABS = new Set(["sessions", "files"]);

function usablePath(value) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= MAX_PATH_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

// This machine or a PC connected with Connect PC (src/server-profiles.mjs).
const SERVER_ID_PATTERN = /^(?:local|link_[a-f0-9-]{36})$/u;
const MAX_REMEMBERED_SERVERS = 20;

function usableServer(value) {
  return typeof value === "string" && SERVER_ID_PATTERN.test(value);
}

// Each server keeps its own last folder; a path from one is meaningless on
// another. Older single-value storage is read as the local entry.
function readAll(storage) {
  try {
    const raw = storage?.getItem(BROWSE_PATH_STORAGE_KEY);
    if (!raw) return {};
    if (raw.startsWith("/")) return usablePath(raw) ? { local: raw } : {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function readBrowsePath(storage, server = "local") {
  if (!usableServer(server)) return null;
  const value = readAll(storage)[server];
  return usablePath(value) ? value : null;
}

export function writeBrowsePath(storage, path, server = "local") {
  try {
    if (!storage || !usablePath(path) || !usableServer(server)) return false;
    const all = readAll(storage);
    all[server] = path;
    const trimmed = Object.fromEntries(Object.entries(all).slice(-MAX_REMEMBERED_SERVERS));
    storage.setItem(BROWSE_PATH_STORAGE_KEY, JSON.stringify(trimmed));
    return true;
  } catch {
    return false;
  }
}

export function readNavigatorTab(storage) {
  try {
    const value = storage?.getItem(NAVIGATOR_TAB_STORAGE_KEY);
    return TABS.has(value) ? value : "sessions";
  } catch {
    return "sessions";
  }
}

export function writeNavigatorTab(storage, tab) {
  try {
    if (!storage || !TABS.has(tab)) return false;
    storage.setItem(NAVIGATOR_TAB_STORAGE_KEY, tab);
    return true;
  } catch {
    return false;
  }
}

// Which machine's files this browser is working with. Unset means "whichever
// machine the selected session runs on", which is what an upload used to
// follow; setting it pins the choice across reloads.
export function readFileServer(storage) {
  try {
    const value = storage?.getItem(FILE_SERVER_STORAGE_KEY);
    return usableServer(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeFileServer(storage, server) {
  try {
    if (server === null) storage?.removeItem(FILE_SERVER_STORAGE_KEY);
    else if (usableServer(server)) storage?.setItem(FILE_SERVER_STORAGE_KEY, server);
  } catch {
    // A browser with storage blocked simply forgets the choice on reload.
  }
}
