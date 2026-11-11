import { parentDirectory } from "../ui-model.js?v=1.4.52";
import { attachPathCompletion, browseUrl, createFolderTree } from "./folder-tree.js?v=1.4.52";

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

// The full path of a folder written from `~`, once the home is known; any
// other is returned as it is.
export function fullFolder(path, home) {
  if (typeof path !== "string" || !home) return path;
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home.endsWith("/") ? home.slice(0, -1) : home}/${path.slice(2)}` : path;
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

// The Folder row of the New workspace, New tab and Link local folder dialogs:
// a path on the machine the dialog is for, typed (it completes as the Files
// tab's path field does) or chosen from the tree that ▾ opens under it. The
// tree is the Files tab's (folder-tree.js) for that machine, in folders only
// and without its own path field and ↑: the Folder input is the one path on
// show. It opens on the folder's parent with the folder marked, so its
// neighbours are a click away too. A click on a folder's row chooses it (the
// Folder input takes it, and `onChange` is told); its arrow opens it in place
// to go deeper. ▾ again, Escape, or a click anywhere outside the row and the
// tree closes it.
// The folder shown is the one sent (`value()`), so what opens is where the
// dialog said, not where Herdr's new_cwd setting would put it. Only a
// connected PC too old to open folders, left as the dialog opened
// (`asOpened()`), makes it as before.
// `onChange` is told when the folder shown changes by typing or by a choice
// (not by `reset`), for a dialog that depends on it.
// `root` holds the input, the ▾ button, the input's completion list and the
// picker's markup (a folder tree's rows and status line).

export function createFolderField(root, { api, onChange = () => {} }) {
  const input = root.querySelector(".folder-row input");
  const browse = root.querySelector(".folder-browse");
  const suggestions = root.querySelector(".folder-row .file-suggestions");
  const picker = root.querySelector(".folder-picker");
  const rows = picker.querySelector(".browse-tree");

  let serverId = "local";
  // What the input opened with.
  let initial = "";
  // Which opening of the picker is the latest.
  let opened = 0;

  // A folder written in the input, as the person reads it.
  async function take(folder) {
    const server = serverId;
    const mine = opened;
    const home = await homeOf(server);
    if (mine !== opened || server !== serverId) return;
    input.value = shownFolder(folder, home);
    onChange();
  }

  // Its own tree: the sidebar's folder and machine are not this dialog's.
  const tree = createFolderTree(picker, {
    request: (url) => api(url),
    server: () => serverId,
    foldersOnly: true,
    pathField: false,
    onPick: (folder) => void take(folder),
  });

  // The input completes from the folder typed so far; a pick is the folder
  // chosen, and the tree, when open, moves to it.
  const completion = attachPathCompletion(input, suggestions, {
    suggest: async (folder, prefix) => (await api(browseUrl(serverId, folder, prefix))).entries ?? [],
    showPath: (path) => shownFolder(path, homes.get(serverId)),
    onPick: (folder) => {
      onChange();
      if (!picker.hidden) void showIn(++opened, folder);
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
    completion.reset();
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

  // The tree on `folder`'s parent with `folder` marked; the home folder (or a
  // folder with no parent) is shown itself. A folder that is not there shows
  // the home folder, and says so.
  async function showIn(mine, folder) {
    tree.clear();
    rows.replaceChildren();
    if (!await idle(mine)) return;
    const home = await homeOf(serverId);
    if (mine !== opened) return;
    const full = fullFolder(folder, home);
    const parent = full !== home ? parentDirectory(full) : null;
    let shown = await tree.open(parent ?? full);
    if (mine !== opened) return;
    if (shown && parent) {
      const name = full.replace(/\/+$/u, "").slice(parent.length).replace(/^\//u, "");
      const entry = await tree.locate(name);
      if (mine !== opened) return;
      if (entry) tree.select(entry.path, { focus: false });
      else {
        // the parent is there and the folder is not
        shown = false;
        tree.say(`There is no folder ${shownFolder(full, home)}.`, true);
      }
    }
    if (mine !== opened) return;
    if (!shown && folder !== "~") {
      const why = picker.querySelector(".file-feedback").textContent;
      if (await tree.open("~") && mine === opened) tree.say(`${why} Showing the home folder.`, true);
    }
  }

  function openPicker() {
    if (!picker.hidden) {
      closePicker();
      return;
    }
    const mine = ++opened;
    picker.hidden = false;
    browse.setAttribute("aria-expanded", "true");
    void showIn(mine, input.value.trim() || "~");
  }

  function closePicker() {
    opened += 1;
    picker.hidden = true;
    browse.setAttribute("aria-expanded", "false");
    tree.say("");
  }

  browse.setAttribute("aria-expanded", "false");
  browse.addEventListener("click", () => openPicker());
  input.addEventListener("input", () => onChange());
  // A click anywhere but the row and the tree closes the tree. On the click,
  // not the press: closing it moves what is under it up, and a press that did
  // so would see its click land on whatever moved there (Start, say).
  root.ownerDocument.addEventListener("click", (event) => {
    if (!picker.hidden && !root.contains(event.target)) closePicker();
  });
  // Escape closes the picker, not the dialog around it; one the completion
  // list took is left alone.
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || picker.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
    browse.focus();
  });

  // The input and ▾ while a create is under way; the picker closes.
  function setDisabled(disabled) {
    if (disabled) closePicker();
    input.disabled = disabled;
    browse.disabled = disabled;
  }

  // A full path on this machine as the Folder input would write it.
  function show(path) {
    return shownFolder(path, homes.get(serverId));
  }

  return { reset, value, asOpened, show, setDisabled, close: closePicker };
}
