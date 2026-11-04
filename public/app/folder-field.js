import { createElement } from "./dom.js?v=1.4.32";

function box(tag, className, children) {
  const node = createElement(tag, { className });
  node.append(...children);
  return node;
}

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
// machine the dialog is for, typed or chosen with Browse…, which lists that
// machine's folders through the Files tab's own listing (/api/browse). The
// folder shown is the one sent (`value()`), so what opens is where the dialog
// said, not where Herdr's new_cwd setting would put it. Only a connected PC
// too old to open folders, left as the dialog opened (`asOpened()`), makes it
// as before.
// `root` holds the input, the Browse… button and an empty picker container.
export function createFolderField(root, { api }) {
  const input = root.querySelector("input");
  const browse = root.querySelector(".folder-browse");
  const picker = root.querySelector(".folder-picker");
  const up = createElement("button", { className: "secondary-button folder-up", text: "Up" });
  up.type = "button";
  up.setAttribute("aria-label", "Up one folder");
  const where = createElement("span", { className: "folder-picker-path" });
  where.setAttribute("aria-live", "polite");
  const list = createElement("ul", { className: "folder-picker-list" });
  list.setAttribute("aria-label", "Folders here");
  const note = createElement("p", { className: "dialog-feedback folder-picker-feedback" });
  const close = createElement("button", { className: "secondary-button", text: "Close" });
  close.type = "button";
  const choose = createElement("button", { className: "secondary-button folder-choose", text: "Use this folder" });
  choose.type = "button";
  picker.replaceChildren(
    box("div", "folder-picker-bar", [up, where]),
    list,
    note,
    box("div", "folder-picker-actions", [close, choose]),
  );

  let serverId = "local";
  // What the input opened with.
  let initial = "";
  // The folder the picker shows ({ path, parent }), and which listing is the latest.
  let shown = null;
  let asked = 0;

  function say(text, error = false) {
    note.textContent = text;
    note.dataset.error = String(error);
  }

  const query = (path) => `/api/browse?server=${encodeURIComponent(serverId)}&path=${encodeURIComponent(path)}`;

  // This machine's home, asked once; null when it cannot be had.
  async function homeOf(server) {
    if (homes.has(server)) return homes.get(server);
    try {
      const answer = await api(`/api/browse?server=${encodeURIComponent(server)}&path=~`);
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
      const opened = initial;
      void homeOf(server).then((found) => {
        // only while it is still the same dialog and nobody has typed
        if (serverId !== server || input.value !== opened || initial !== opened) return;
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

  function render(answer) {
    shown = answer;
    where.textContent = shownFolder(answer.path, homes.get(serverId));
    where.title = answer.path;
    up.disabled = !answer.parent;
    const folders = (answer.entries ?? []).filter((entry) =>
      entry.kind === "directory" && entry.readable !== false && !entry.locked);
    list.replaceChildren(...folders.map((entry) => {
      const button = createElement("button", { className: "folder-picker-item", text: entry.name });
      button.type = "button";
      button.dataset.path = entry.path;
      return box("li", "", [button]);
    }));
    if (folders.length === 0) say("No folders in here.");
    else say(answer.truncated ? `Showing the first ${answer.entries.length} entries.` : "");
  }

  // `notice`: why this folder is shown instead of the one asked for.
  async function load(path, { fallback = true, notice = "" } = {}) {
    const mine = ++asked;
    say("Loading folders…");
    try {
      const answer = await api(query(path));
      if (mine !== asked) return;
      if (path === "~") homes.set(serverId, answer.path);
      render(answer);
      if (notice) say(notice, true);
      // the first folder, else Use this folder, takes the keys
      (list.querySelector("button") || choose).focus({ preventScroll: true });
    } catch (error) {
      if (mine !== asked) return;
      // A folder that is not there (yet) opens the home folder instead.
      if (fallback && !shown && path !== "~") {
        await load("~", { fallback: false, notice: `${error.message} Showing the home folder.` });
        return;
      }
      say(error.message, true);
    }
  }

  function openPicker() {
    if (!picker.hidden) {
      closePicker();
      return;
    }
    shown = null;
    picker.hidden = false;
    browse.setAttribute("aria-expanded", "true");
    list.replaceChildren();
    where.textContent = "";
    up.disabled = true;
    void load(input.value.trim() || "~");
  }

  function closePicker() {
    asked += 1;
    picker.hidden = true;
    browse.setAttribute("aria-expanded", "false");
    shown = null;
    list.replaceChildren();
    say("");
  }

  browse.setAttribute("aria-expanded", "false");
  browse.addEventListener("click", openPicker);
  up.addEventListener("click", () => { if (shown?.parent) void load(shown.parent); });
  list.addEventListener("click", (event) => {
    const button = event.target.closest(".folder-picker-item");
    if (button) void load(button.dataset.path);
  });
  close.addEventListener("click", () => {
    closePicker();
    browse.focus();
  });
  choose.addEventListener("click", () => {
    if (!shown) return;
    input.value = shownFolder(shown.path, homes.get(serverId));
    closePicker();
    input.focus();
  });
  // Escape closes the list, not the dialog around it.
  picker.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
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

  // The input and Browse… while a create is under way; the list closes.
  function setDisabled(disabled) {
    if (disabled) closePicker();
    input.disabled = disabled;
    browse.disabled = disabled;
  }

  return { reset, value, asOpened, setHidden, setDisabled, close: closePicker };
}
