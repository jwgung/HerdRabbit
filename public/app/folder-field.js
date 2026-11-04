import { browseUrl, createFolderTree } from "./folder-tree.js?v=1.4.32";

const IDLE_POLL_MS = 50;

// Each machine's home folder, as its Files listing of `~` answered, while this
// page lasts: a folder in it is shown as `~/…`.
const homes = new Map();

// A path as a person reads it on `serverId`'s machine: its home as `~`.
export function shownFolder(path, home) {
  if (typeof path !== "string" || !home) return path;
  if (path === home) return "~";
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

// The first of a workspace's panes, in Herdr's order, that is in a folder: the
// same rule the server's projectFolder uses (src/project-folder.mjs).
export function workspaceFolder(panes, workspaceId) {
  for (const pane of panes ?? []) {
    if (pane?.workspace_id !== workspaceId) continue;
    const folder = [pane.foreground_cwd, pane.cwd].find((value) => typeof value === "string" && value.startsWith("/"));
    if (folder) return folder;
  }
  return null;
}

// The Folder row of the New workspace and New tab dialogs: a path on the
// machine the dialog is for, typed or chosen with Browse…, which opens the
// Files tab's tree (folder-tree.js) for that machine in folders only: a folder
// is gone into with a click, ↑ and the path field are the Files tab's, and Use
// this folder takes the one on show. The folder shown is the one sent
// (`value()`), so what opens is where the dialog said, not where Herdr's
// new_cwd setting would put it. Only a connected PC too old to open folders,
// left as the dialog opened (`asOpened()`), makes it as before.
// `root` holds the input, the Browse… button and the picker's markup (a
// folder tree's parts, Close and Use this folder).

export function createFolderField(root, { api }) {
  const input = root.querySelector(".folder-row input");
  const browse = root.querySelector(".folder-browse");
  const picker = root.querySelector(".folder-picker");
  const rows = picker.querySelector(".browse-tree");
  const status = picker.querySelector(".file-feedback");
  const close = picker.querySelector(".folder-close");
  const choose = picker.querySelector(".folder-choose");

  let serverId = "local";
  // What the input opened with.
  let initial = "";
  // Which opening of the picker is the latest.
  let opened = 0;

  // Its own tree: the sidebar's folder and machine are not this dialog's. A
  // folder gone into redraws the rows, the one pressed with them: Use this
  // folder takes the keys then, so Escape stays the picker's.
  const tree = createFolderTree(picker, {
    request: (url) => api(url),
    server: () => serverId,
    foldersOnly: true,
    showPath: (path) => shownFolder(path, homes.get(serverId)),
    onShown: () => {
      if (!picker.contains(document.activeElement)) choose.focus({ preventScroll: true });
    },
  });

  // This machine's home, asked once; null when it cannot be had.
  async function homeOf(server) {
    if (homes.has(server)) return homes.get(server);
    try {
      const answer = await api(browseUrl(server, "~"));
      if (typeof answer?.path === "string") homes.set(server, answer.path);
    } catch { /* shown as a full path */ }
    return homes.get(server) ?? null;
  }

  // Opens with `folder` (an absolute path, shown with ~ once the machine's
  // home is known), or the home folder when there is none.
  function reset({ serverId: server = "local", folder = null } = {}) {
    serverId = server;
    closePicker();
    const home = homes.get(server);
    initial = folder ? shownFolder(folder, home) : "~";
    input.value = initial;
    if (folder && !homes.has(server)) {
      const opening = initial;
      void homeOf(server).then((found) => {
        // only while it is still the same dialog and nobody has typed
        if (serverId !== server || input.value !== opening || initial !== opening) return;
        initial = shownFolder(folder, found);
        input.value = initial;
      });
    }
  }

  // The folder to send: what is shown, or the one it opened with when emptied.
  function value() {
    return input.value.trim() || initial;
  }

  // Whether it is still the folder the dialog opened with.
  function asOpened() {
    return value() === initial;
  }

  // Waits out a listing still under way from a picker closed a moment ago.
  async function idle(mine) {
    while (tree.busy) {
      await new Promise((resolve) => window.setTimeout(resolve, IDLE_POLL_MS));
      if (mine !== opened) return false;
    }
    return true;
  }

  // The folder in the input, or the home folder when it is not there (yet).
  async function openPicker() {
    if (!picker.hidden) {
      closePicker();
      return;
    }
    const mine = ++opened;
    picker.hidden = false;
    browse.setAttribute("aria-expanded", "true");
    tree.clear();
    rows.replaceChildren();
    const target = input.value.trim() || "~";
    if (!await idle(mine)) return;
    // the path field writes the home folder as ~ once it is known
    await homeOf(serverId);
    if (mine !== opened) return;
    let shown = await tree.open(target);
    if (mine !== opened) return;
    if (!shown && target !== "~") {
      const why = status.textContent;
      shown = await tree.open("~");
      if (mine !== opened) return;
      if (shown) tree.say(`${why} Showing the home folder.`, true);
    }
  }

  function closePicker() {
    opened += 1;
    picker.hidden = true;
    browse.setAttribute("aria-expanded", "false");
    tree.say("");
  }

  browse.setAttribute("aria-expanded", "false");
  browse.addEventListener("click", () => void openPicker());
  close.addEventListener("click", () => {
    closePicker();
    browse.focus();
  });
  choose.addEventListener("click", async () => {
    const folder = tree.root;
    if (!folder) return;
    const server = serverId;
    const mine = opened;
    const home = await homeOf(server);
    if (mine !== opened || server !== serverId) return;
    input.value = shownFolder(folder, home);
    closePicker();
    input.focus();
  });
  // Escape closes the picker, not the dialog around it; one the path field's
  // list took is left alone.
  picker.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
    browse.focus();
  });

  // Whether the whole row is shown (a resumed conversation keeps its folder).
  function setHidden(hidden) {
    if (hidden) closePicker();
    root.hidden = hidden;
  }

  // The input and Browse… while a create is under way; the picker closes.
  function setDisabled(disabled) {
    if (disabled) closePicker();
    input.disabled = disabled;
    browse.disabled = disabled;
  }

  return { reset, value, asOpened, setHidden, setDisabled, close: closePicker };
}
