import {
  browseDiffSummary,
  diffBrowseListing,
  flattenTree,
  formatTransferSize,
  parentDirectory,
} from "../ui-model.js?v=1.4.32";
import { createElement, createIcon } from "./dom.js?v=1.4.32";

// The Files tab's tree: one machine's folders as rows that open in place, the
// path field under them with its completion, and ↑. The sidebar's Files tab
// and the New tab / New workspace folder picker each make one. A tree keeps
// its own folder, open folders and selection; whatever outlives it (the
// sidebar's last folder per machine, say) is the caller's, told through
// `onShown`.
//
// `root` holds the parts, found by class: `.browse-tree` (the rows),
// `.file-feedback` (one line of status), `.file-path` (the path field),
// `.file-up` (↑) and `.file-suggestions` (the path field's completion list).
//
// Options:
// - `request(url)`: resolves with the JSON of a GET, rejects with an Error
//   whose message can be shown.
// - `server()`: the machine to list, asked at each request.
// - `foldersOnly`: lists folders and nothing else, and a click on a folder goes
//   into it instead of opening it in place: the folder picker.
// - `fileActions(entry)`: buttons for a readable file's row, as
//   `{ label, paths, run }` (the sidebar's View and Download).
// - `onNavigate()`: the tree is about to go to another folder because someone
//   asked it to (a row, ↑, the path field); not called for `open()`.
// - `onShown(listing)`: a folder is now the one on show (`/api/browse`'s answer).
//
// Entries are listed as the server gives them: hidden ones too, a broken link
// and a sign-in folder (locked) named but not opened. Folders only leaves out
// everything that is not a folder, broken links included.

// A remote listing with no path starts at that machine's home.
export function browseUrl(server, path, prefix = "") {
  const parts = [`server=${encodeURIComponent(server)}`];
  if (path) parts.push(`path=${encodeURIComponent(path)}`);
  if (prefix !== "") parts.push(`prefix=${encodeURIComponent(prefix)}`);
  return `/api/browse?${parts.join("&")}`;
}

// A folder the tree can open into: not a broken link, and not one of the
// sign-in folders the server lists by name only.
export function isOpenableFolder(entry) {
  return entry.kind === "directory" && !entry.broken && entry.locked !== true;
}

const FOLDER_ICON = ["M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"];
const FILE_ICON = ["M7 3h7l5 5v13H7z", "M14 3v5h5"];
const IMAGE_ICON = ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M9 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"];
const CODE_ICON = ["M9 8l-4 4 4 4", "M15 8l4 4-4 4"];
const DATA_ICON = ["M12 6c4 0 7-.9 7-2v12c0 1.1-3 2-7 2s-7-.9-7-2V4c0 1.1 3 2 7 2Z", "M5 4c0 1.1 3 2 7 2s7-.9 7-2"];
const ARCHIVE_ICON = ["M4 7h16v13H4z", "M4 7l2-3h12l2 3", "M12 11v3"];

const ICONS_BY_EXTENSION = new Map(Object.entries({
  png: IMAGE_ICON, jpg: IMAGE_ICON, jpeg: IMAGE_ICON, gif: IMAGE_ICON,
  webp: IMAGE_ICON, svg: IMAGE_ICON, avif: IMAGE_ICON, bmp: IMAGE_ICON, ico: IMAGE_ICON,
  js: CODE_ICON, mjs: CODE_ICON, cjs: CODE_ICON, ts: CODE_ICON, tsx: CODE_ICON,
  jsx: CODE_ICON, py: CODE_ICON, rb: CODE_ICON, go: CODE_ICON, rs: CODE_ICON,
  java: CODE_ICON, c: CODE_ICON, h: CODE_ICON, cpp: CODE_ICON, sh: CODE_ICON,
  css: CODE_ICON, html: CODE_ICON, vue: CODE_ICON, php: CODE_ICON, sql: CODE_ICON,
  json: DATA_ICON, yaml: DATA_ICON, yml: DATA_ICON, toml: DATA_ICON,
  csv: DATA_ICON, xml: DATA_ICON, db: DATA_ICON, sqlite: DATA_ICON,
  zip: ARCHIVE_ICON, gz: ARCHIVE_ICON, tar: ARCHIVE_ICON, tgz: ARCHIVE_ICON,
  bz2: ARCHIVE_ICON, xz: ARCHIVE_ICON, rar: ARCHIVE_ICON, "7z": ARCHIVE_ICON,
}));

function entryIcon(entry) {
  if (entry.kind === "directory") return FOLDER_ICON;
  const dot = entry.name.lastIndexOf(".");
  const extension = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  return ICONS_BY_EXTENSION.get(extension) || FILE_ICON;
}

function actionButton({ label, paths, danger = false, run }) {
  const button = createElement("button", {
    className: `secondary-button ${danger ? "is-danger" : ""}`.trim(),
  });
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(createIcon(paths));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

// Folds as long as a project does in Sessions, which is what the CSS animates.
const BROWSE_FOLD_MS = 180;
const DIFF_CLEAR_MS = 4_000;

export function createFolderTree(root, {
  request,
  server,
  foldersOnly = false,
  fileActions = () => [],
  onNavigate = () => {},
  onShown = () => {},
}) {
  const tree = root.querySelector(".browse-tree");
  const feedback = root.querySelector(".file-feedback");
  const pathInput = root.querySelector(".file-path");
  const up = root.querySelector(".file-up");
  const suggestions = root.querySelector(".file-suggestions");

  // Only folders that were opened have been fetched, so the tree keeps a
  // listing per visited path rather than one nested structure.
  const view = {
    root: null,
    loaded: new Map(),
    expanded: new Set(),
    selected: null,
    busy: false,
    addedPaths: new Set(),
    clearDiffTimer: null,
  };

  function say(text, isError = false) {
    feedback.textContent = text;
    feedback.dataset.error = String(isError);
  }

  // How many entries the server sent, before folders only left some out.
  function truncationNote(listing) {
    return listing?.truncated ? `Showing the first ${listing.listed ?? listing.entries.length} of ${listing.total}.` : "";
  }

  async function fetchListing(target, prefix = "") {
    const listing = await request(browseUrl(server(), target, prefix));
    if (!foldersOnly) return listing;
    return {
      ...listing,
      listed: listing.entries.length,
      entries: listing.entries.filter((entry) => entry.kind === "directory"),
    };
  }

  function navigate(target) {
    onNavigate();
    return open(target);
  }

  function setTwisty(twisty, expanded) {
    twisty.setAttribute("aria-expanded", String(expanded));
    twisty.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${twisty.dataset.name}`);
  }

  // The server marks a locked entry readable: false too, so the file actions
  // need no separate locked test.
  function browseRow({ entry, depth, expanded }) {
    // Sign-in keys and HerdRabbit's own settings are listed by name only: the
    // server never opens them, so neither does the tree.
    const locked = entry.locked === true;
    const element = createElement("div", { className: "transfer-row browse-row" });
    if (locked) element.classList.add("is-locked");
    element.tabIndex = -1;
    element.style.setProperty("--depth", String(depth));
    element.dataset.path = entry.path;
    if (view.addedPaths.has(entry.path)) {
      element.classList.add("is-added");
    } else if (entry.removed) {
      element.classList.add("is-removed");
    }

    const lead = createElement("div", { className: "browse-lead" });
    // One guide per level, drawn in the DOM so the lines line up with the rows
    // above and below rather than being faked with padding.
    for (let level = 0; level < depth; level += 1) {
      lead.append(createElement("span", { className: "browse-indent" }));
    }
    if (isOpenableFolder(entry) && !entry.removed) {
      const twisty = createElement("button", { className: "browse-twisty" });
      twisty.type = "button";
      twisty.dataset.name = entry.name;
      setTwisty(twisty, expanded);
      twisty.append(createIcon(["M9 6l6 6-6 6"]));
      twisty.addEventListener("click", (event) => {
        // The row reacts too, so without this the chevron would fire twice and
        // land back where it started.
        event.stopPropagation();
        void toggleBrowseFolder(entry.path);
      });
      lead.append(twisty);
    } else {
      lead.append(createElement("span", { className: "browse-twisty-gap" }));
    }

    lead.append(createIcon(entryIcon(entry), "browse-icon"));

    // One line per entry: the name carries the row, the size sits at the end, and
    // the full timestamp waits in the tooltip rather than wrapping the row.
    const copy = createElement("div", { className: "transfer-copy" });
    const name = createElement("div", { className: "transfer-name", text: entry.name });
    if (entry.symlink) name.append(createElement("span", { className: "transfer-tag", text: "link" }));
    copy.append(name);
    lead.append(copy);
    if (entry.removed) {
      element.title = `${entry.name} (removed)`;
    } else if (locked) {
      element.title = `${entry.name}\nHerdRabbit does not open sign-in keys or its own settings.`;
    } else if (entry.modifiedAt) {
      const size = entry.kind === "directory" ? "" : `${formatTransferSize(entry.size ?? 0)} · `;
      element.title = `${entry.name}\n${size}${new Date(entry.modifiedAt).toLocaleString()}`;
    }

    if (entry.broken) {
      lead.append(createElement("span", { className: "transfer-meta", text: "broken" }));
    } else if (locked) {
      lead.append(createElement("span", { className: "transfer-meta", text: "locked" }));
    }

    const actions = createElement("div", { className: "transfer-row-actions" });
    if (!entry.removed) {
      // Expanding shows a folder in place; this re-roots the tree there, so a deep
      // path stops costing a column of indentation. In folders only, a click on
      // the row already does that.
      if (isOpenableFolder(entry) && !foldersOnly) {
        actions.append(actionButton({
          label: `Open ${entry.name} as the root`,
          paths: ["M4 12h13", "M13 7l5 5-5 5", "M20 5v14"],
          run: () => void navigate(entry.path),
        }));
      }
      if (entry.kind === "file" && entry.readable !== false) {
        for (const action of fileActions(entry)) actions.append(actionButton(action));
      }

      // Clicking the row selects it, and clicking a folder opens it -- the way an
      // editor sidebar behaves, rather than making people hit the small chevron.
      element.dataset.selected = String(view.selected === entry.path);
      element.addEventListener("click", () => {
        if (foldersOnly && isOpenableFolder(entry)) {
          void navigate(entry.path);
          return;
        }
        view.selected = entry.path;
        for (const other of tree.querySelectorAll(".browse-row")) other.dataset.selected = "false";
        element.dataset.selected = "true";
        if (isOpenableFolder(entry)) void toggleBrowseFolder(entry.path);
      });
    }

    element.append(lead, actions);
    return element;
  }

  // An open folder's rows sit in their own wrapper, right after the folder's row,
  // so a folder opens and closes on its own -- sliding, as a project does --
  // instead of the whole tree being drawn again.
  function childrenWrapper() {
    const children = createElement("div", { className: "browse-children" });
    const inner = createElement("div", { className: "browse-children-inner" });
    children.append(inner);
    return { children, inner };
  }

  function appendRows(container, rows) {
    const open = [{ depth: -1, container }];
    for (const item of rows) {
      while (open.at(-1).depth >= item.depth) open.pop();
      const parent = open.at(-1).container;
      parent.append(browseRow(item));
      if (item.expanded && item.entry.kind === "directory") {
        const { children, inner } = childrenWrapper();
        parent.append(children);
        open.push({ depth: item.depth, container: inner });
      }
    }
  }

  function rowElement(path) {
    return [...tree.querySelectorAll(".browse-row")].find((element) => element.dataset.path === path) || null;
  }

  function render() {
    if (document.activeElement !== pathInput) pathInput.value = view.root || "";
    up.disabled = !parentDirectory(view.root);

    const rows = flattenTree(view.root, view.loaded, view.expanded);
    tree.replaceChildren();
    if (rows.length === 0) {
      tree.append(createElement("p", {
        className: "transfer-empty",
        text: foldersOnly ? "No folders in here." : "This folder is empty.",
      }));
      return;
    }
    appendRows(tree, rows);
  }

  async function toggleBrowseFolder(path) {
    if (view.expanded.has(path)) {
      view.expanded.delete(path);
      const row = rowElement(path);
      const children = row?.nextElementSibling?.classList.contains("browse-children") ? row.nextElementSibling : null;
      if (!children) {
        render();
        return;
      }
      setTwisty(row.querySelector(".browse-twisty"), false);
      children.inert = true;
      children.classList.add("is-collapsed");
      // Dropped once folded, unless the folder was opened again meanwhile.
      window.setTimeout(() => {
        if (children.classList.contains("is-collapsed")) children.remove();
      }, BROWSE_FOLD_MS);
      return;
    }
    if (!view.loaded.has(path)) {
      say("Loading…");
      try {
        const listing = await fetchListing(path);
        view.loaded.set(listing.path, listing);
        say(truncationNote(listing));
      } catch (error) {
        say(error.message, true);
        return;
      }
    }
    view.expanded.add(path);
    // Looked up after the listing arrives: the tree may have been drawn again
    // while it loaded.
    const row = rowElement(path);
    if (!row) {
      render();
      return;
    }
    setTwisty(row.querySelector(".browse-twisty"), true);
    const folding = row.nextElementSibling?.classList.contains("browse-children") ? row.nextElementSibling : null;
    const { children, inner } = folding ? { children: folding, inner: folding.firstElementChild } : childrenWrapper();
    if (!folding) {
      children.classList.add("is-collapsed");
      const depth = Number(row.style.getPropertyValue("--depth")) + 1;
      appendRows(inner, flattenTree(path, view.loaded, view.expanded, depth));
      row.after(children);
      // Laid out folded first, so opening is a change the transition can run.
      children.getBoundingClientRect();
    }
    children.inert = false;
    children.classList.remove("is-collapsed");
  }

  function stopDiffTimer() {
    window.clearTimeout(view.clearDiffTimer);
    view.clearDiffTimer = null;
  }

  // Shows `target` as the root, every folder closed. Says whether it is now the
  // one on show: false while another load is under way, or when it could not be
  // listed (the status line says why).
  async function open(target) {
    if (view.busy) return false;
    view.busy = true;
    stopDiffTimer();
    view.addedPaths.clear();
    say("Loading…");
    try {
      const listing = await fetchListing(target);
      view.expanded.clear();
      view.loaded.clear();
      view.loaded.set(listing.path, listing);
      view.root = listing.path;
      render();
      say(truncationNote(listing));
      onShown(listing);
      return true;
    } catch (error) {
      say(error.message, true);
      return false;
    } finally {
      view.busy = false;
    }
  }

  async function changedTargets(targets) {
    const targetEtags = {};
    for (const path of targets) {
      const listing = view.loaded.get(path);
      if (listing?.etag) targetEtags[path] = listing.etag;
    }
    if (Object.keys(targetEtags).length !== targets.length) {
      return targets;
    }
    const parts = [`server=${encodeURIComponent(server())}`];
    parts.push(`targets=${encodeURIComponent(JSON.stringify(targetEtags))}`);
    const result = await request(`/api/browse/check?${parts.join("&")}`)
      .catch(() => ({ changed: targets }));
    return Array.isArray(result?.changed) ? result.changed : targets;
  }

  function dropRemoved() {
    for (const [path, listing] of view.loaded.entries()) {
      const cleaned = listing.entries.filter((entry) => !entry.removed);
      if (cleaned.length !== listing.entries.length) {
        view.loaded.set(path, { ...listing, entries: cleaned });
      }
    }
  }

  // Lists the root and every open folder again, marking what came and went.
  // `silent` asks the server first whether anything changed, and keeps quiet
  // about errors and about there being nothing new.
  async function refresh({ silent = false } = {}) {
    if (view.busy || !view.root) return;
    view.busy = true;

    try {
      const targets = [
        view.root,
        ...[...view.expanded].filter((path) => view.loaded.has(path) && path !== view.root),
      ];

      let pathsToFetch = targets;

      if (silent) {
        const changed = await changedTargets(targets);
        if (changed.length === 0) {
          return;
        }
        pathsToFetch = targets.filter((path) => changed.includes(path));
      }

      const results = await Promise.allSettled(pathsToFetch.map((path) => fetchListing(path)));

      let totalAdded = 0;
      let totalRemoved = 0;
      let anyChanged = false;

      for (let i = 0; i < pathsToFetch.length; i += 1) {
        const targetPath = pathsToFetch[i];
        const result = results[i];

        if (result.status !== "fulfilled") {
          if (targetPath !== view.root) {
            view.expanded.delete(targetPath);
            view.loaded.delete(targetPath);
            anyChanged = true;
          }
          continue;
        }

        const newListing = result.value;
        const oldListing = view.loaded.get(targetPath);

        const { listing: diffedListing, added, removed } = diffBrowseListing(oldListing, newListing);

        for (const entry of added) {
          view.addedPaths.add(entry.path);
          totalAdded += 1;
          anyChanged = true;
        }

        for (const entry of removed) {
          view.addedPaths.delete(entry.path);
          if (view.selected === entry.path) view.selected = null;
          totalRemoved += 1;
          anyChanged = true;
        }

        const newPaths = new Set((newListing.entries || []).map((entry) => entry.path));
        for (const path of view.addedPaths) {
          if (parentDirectory(path) === targetPath && !newPaths.has(path)) {
            view.addedPaths.delete(path);
          }
        }

        if (
          !oldListing ||
          diffedListing.entries.length !== oldListing.entries.length ||
          diffedListing.entries.some((entry, idx) => {
            const old = oldListing.entries[idx];
            return (
              !old ||
              old.path !== entry.path ||
              Boolean(old.removed) !== Boolean(entry.removed) ||
              old.size !== entry.size ||
              old.modifiedAt !== entry.modifiedAt
            );
          })
        ) {
          anyChanged = true;
        }

        view.loaded.set(targetPath, diffedListing);
      }

      if (anyChanged) {
        render();
      }

      const summary = browseDiffSummary(totalAdded, totalRemoved);

      if (summary) {
        say(summary);
        window.clearTimeout(view.clearDiffTimer);
        view.clearDiffTimer = window.setTimeout(() => {
          view.clearDiffTimer = null;
          view.addedPaths.clear();
          dropRemoved();
          render();
          say(truncationNote(view.loaded.get(view.root)));
        }, DIFF_CLEAR_MS);
      } else if (!silent) {
        if (view.addedPaths.size > 0 || [...view.loaded.values()].some((l) => l.entries.some((e) => e.removed))) {
          view.addedPaths.clear();
          dropRemoved();
          render();
        }
        say(truncationNote(view.loaded.get(view.root)) || "Folder is up to date.");
      }
    } catch (error) {
      if (!silent) {
        say(error.message, true);
      }
    } finally {
      view.busy = false;
    }
  }

  // Forgets every folder: the machine is about to change.
  function clear() {
    view.root = null;
    stopDiffTimer();
    view.addedPaths.clear();
    view.loaded.clear();
    view.expanded.clear();
    completion.entries = [];
  }

  // The root's entry called `name`, or null. A folder listed only in part may
  // hold it past the cut: it is asked for by name, and added to the rows.
  async function locate(name) {
    const listing = view.loaded.get(view.root);
    let entry = listing?.entries.find((item) => item.name === name);
    if (!entry && listing?.truncated) {
      try {
        entry = (await fetchListing(view.root, name)).entries.find((item) => item.name === name);
      } catch { /* not found, then */ }
      if (entry && view.loaded.get(view.root) === listing) listing.entries.push(entry);
    }
    return entry ?? null;
  }

  // Selects the row at `path`, scrolled into view and focused; null selects none.
  function select(path) {
    view.selected = path;
    render();
    if (!path) return;
    const element = rowElement(path);
    element?.scrollIntoView({ block: "center" });
    element?.focus({ preventScroll: true });
  }

  up.addEventListener("click", () => {
    const parent = parentDirectory(view.root);
    if (parent) void navigate(parent);
  });

  const completion = { entries: [], active: -1, timer: null };

  function hideSuggestions() {
    // Cancel the pending lookup too, or it reopens the list a moment later.
    window.clearTimeout(completion.timer);
    completion.active = -1;
    suggestions.hidden = true;
    suggestions.replaceChildren();
    pathInput.setAttribute("aria-expanded", "false");
  }

  function applySuggestion(value) {
    pathInput.value = value;
    hideSuggestions();
    void navigate(value);
  }

  function renderSuggestions(matches) {
    suggestions.replaceChildren();
    if (matches.length === 0) {
      hideSuggestions();
      return;
    }
    matches.forEach((entry, index) => {
      const item = createElement("li", { className: "file-suggestion" });
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === completion.active));
      item.append(createElement("span", { text: entry.name }));
      item.addEventListener("mousedown", (event) => {
        // mousedown beats the input losing focus and closing the list first.
        event.preventDefault();
        applySuggestion(entry.path);
      });
      suggestions.append(item);
    });
    suggestions.hidden = false;
    pathInput.setAttribute("aria-expanded", "true");
  }

  async function updateCompletion() {
    const typed = pathInput.value;
    if (!typed.startsWith("/")) {
      hideSuggestions();
      return;
    }
    const cut = typed.lastIndexOf("/");
    const folder = cut === 0 ? "/" : typed.slice(0, cut);
    const prefix = typed.slice(cut + 1).toLowerCase();

    // The server does the prefix match: a folder like /tmp can hold thousands of
    // entries, and filtering here would only see whatever survived the limit.
    try {
      const listing = await fetchListing(folder, prefix);
      // Typing moves on while the request is in flight; a reply the caret has
      // already left behind would otherwise replace the newer list.
      if (pathInput.value !== typed) return;
      completion.entries = listing.entries.filter((entry) => entry.kind === "directory");
    } catch {
      if (pathInput.value !== typed) return;
      completion.entries = [];
    }
    completion.active = -1;
    renderSuggestions(completion.entries.slice(0, 12));
  }

  pathInput.addEventListener("input", () => {
    // A short wait keeps a fast typist from firing one listing per keystroke.
    window.clearTimeout(completion.timer);
    completion.timer = window.setTimeout(() => void updateCompletion(), 150);
  });

  pathInput.addEventListener("keydown", (event) => {
    const items = [...suggestions.children];
    if (event.key === "Escape" && !suggestions.hidden) {
      // Handled: whatever is around the field (a picker) leaves this Escape be.
      event.preventDefault();
      hideSuggestions();
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length > 0) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      completion.active = (completion.active + step + items.length) % items.length;
      items.forEach((item, index) => item.setAttribute("aria-selected", String(index === completion.active)));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = items[completion.active];
      if (chosen) {
        const match = completion.entries.find((entry) => entry.name === chosen.textContent);
        applySuggestion(match ? match.path : pathInput.value);
        return;
      }
      hideSuggestions();
      void navigate(pathInput.value);
    }
  });

  pathInput.addEventListener("blur", () => window.setTimeout(hideSuggestions, 120));

  return {
    open,
    refresh,
    clear,
    locate,
    select,
    say,
    get root() { return view.root; },
    get busy() { return view.busy; },
  };
}
