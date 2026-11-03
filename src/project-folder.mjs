// A folder a new tab may open in, and the folder a project works in. The hub
// and a connected PC both decide a project's folder by this one rule.

// Absolute, at most 4096 characters, one line with no control characters. It
// reaches Herdr as one argument, never through a shell.
export function isFolder(value) {
  return typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
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
