import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

// A folder a new tab may open in, and the folder a project works in. The hub
// and a connected PC both decide a project's folder by this one rule.

const MAX_FOLDER_LENGTH = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/u;

// Absolute, at most 4096 characters, one line with no control characters. It
// reaches Herdr as one argument, never through a shell.
export function isFolder(value) {
  return typeof value === "string" && value.startsWith("/") && value.length <= MAX_FOLDER_LENGTH && !CONTROL.test(value);
}

// A folder a person may ask for: absolute, or `~` / `~/…` for the home folder
// of the machine it is on, by the same length and character rules.
export function isFolderRequest(value) {
  return typeof value === "string" && value.length <= MAX_FOLDER_LENGTH && !CONTROL.test(value) &&
    (value.startsWith("/") || value === "~" || value.startsWith("~/"));
}

// Why a folder asked for cannot be used; `status` and `code` reach the page.
export class FolderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FolderError";
    this.status = 400;
    this.code = code;
  }
}

export const FOLDER_CODES = new Set(["invalid_folder", "folder_not_found", "not_a_folder"]);

export const invalidFolder = () => new FolderError("invalid_folder", "Enter a folder as a full path, like /home/me/project or ~/project.");

// A folder asked for, on this machine: `~` expanded to `home`, resolved, and
// an existing directory here. The path answered is absolute (isFolder).
export async function existingFolder(value, { home = homedir() } = {}) {
  if (!isFolderRequest(value)) throw invalidFolder();
  const folder = value === "~" || value.startsWith("~/") ? resolve(home, value.slice(2)) : resolve(value);
  if (!isFolder(folder)) throw invalidFolder();
  let stats;
  try {
    stats = await stat(folder);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(error?.code)) {
      throw new FolderError("folder_not_found", `There is no folder ${value} on that machine.`);
    }
    throw error;
  }
  if (!stats.isDirectory()) throw new FolderError("not_a_folder", `${value} is a file, not a folder.`);
  return folder;
}

// The folder a project works in, as the page shows a pane's: the first of its
// panes, in Herdr's order, that is in a folder. Null when none is. Herdr gives
// a project no folder of its own.
export function projectFolder(snapshot, workspaceId) {
  for (const pane of snapshot?.panes ?? []) {
    if (pane?.workspace_id !== workspaceId) continue;
    const folder = [pane.foreground_cwd, pane.cwd].find(isFolder);
    if (folder) return folder;
  }
  return null;
}
