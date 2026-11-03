import {
  browseDiffSummary,
  diffBrowseListing,
  flattenTree,
  formatTransferSize,
  insertPathAtSelection,
  paneServerId,
  parentDirectory,
  sortUploads,
  uploadSummary,
} from "../ui-model.js?v=1.4.27";
import { MAX_TEXT_PREVIEW_BYTES, previewFor } from "../file-preview.js?v=1.4.27";
import {
  clampNavigatorWidth,
  readBrowsePath,
  readNavigatorWidth,
  writeBrowsePath,
  writeFileServer,
  writeNavigatorTab,
  writeNavigatorWidth,
} from "../browse-preference.js?v=1.4.27";
import { createSpeechButton, speechSupported } from "../speech-recognition.js?v=1.4.27";
import { array, createElement, createIcon } from "./dom.js?v=1.4.27";

// Files in and out of a machine: uploads, downloads and the uploads dialog,
// the file viewer, voice input, the Files tab's tree and the path completion
// under it. Called once, where this code used to run in app.js: it registers
// its listeners and its refresh timer then, in the same order as before.
// `revealState.generation` is the page's count of file-link presses, which
// app.js also moves on when a link is pressed.
export function createFiles({
  state,
  elements,
  desktopMedia,
  revealState,
  transferRequest,
  setFeedback,
  sidebarActionMenu,
  syncComposerExpanded,
  syncSidebar,
}) {
  function setTransferFeedback(text, isError = false) {
    elements.transferDialogFeedback.textContent = text;
    elements.transferDialogFeedback.dataset.error = String(isError);
  }

  function setBrowseFeedback(text, isError = false) {
    elements.browseFeedback.textContent = text;
    elements.browseFeedback.dataset.error = String(isError);
  }

  function sessionServerId() {
    return paneServerId(state.selectedPaneId) || "local";
  }

  // Browsing and uploading use the same machine: picking one in the Files tab is
  // how you say where files go.
  function uploadServerId() {
    return browseState.server;
  }

  function serverLabel(id) {
    if (id === "local") return "this machine";
    const server = array(state.snapshot?.servers).find((item) => item.id === id);
    return server?.name || "another machine";
  }

  function syncAttachAvailability() {
    elements.attachButton.disabled = !state.selectedPaneId;
    // Where a file lands is not obvious once it can differ from the session in
    // front of you, so the control says it rather than leaving it to be found out.
    elements.attachButton.title = `Upload a file to ${serverLabel(uploadServerId())}`;
  }

  function insertTransferPath(path) {
    const input = elements.terminalInput;
    const { value, caret } = insertPathAtSelection(
      input.value,
      input.selectionStart,
      input.selectionEnd,
      path,
    );
    input.value = value;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // The download route trades the launch token header for a one-time ticket, so a
  // plain link works and the browser streams the file itself instead of holding
  // the whole thing in memory as a blob.

  // Looking at a file is the thing a browser is already good at, and downloading
  // one to a phone just to read two lines of a log is not. What may be shown and
  // as what is decided in file-preview.js, which the server consults with the
  // same code before it will hand over a type at all.
  const viewerDialog = document.querySelector("#viewer-dialog");
  const viewerBody = document.querySelector("#viewer-body");
  const viewerFeedback = document.querySelector("#viewer-feedback");
  let viewerDownload = null;

  function setViewerFeedback(message, isError = false) {
    viewerFeedback.textContent = message;
    viewerFeedback.dataset.error = String(isError);
  }

  function closeViewer() {
    // A <video> left with a src keeps its connection and its buffer alive after
    // the dialog is gone, so the element goes rather than just being hidden.
    viewerBody.replaceChildren();
    viewerDialog.close();
  }

  document.querySelector("#viewer-close").addEventListener("click", closeViewer);
  viewerDialog.addEventListener("close", () => {
    viewerBody.replaceChildren();
    // A phone's pinch inside the dialog (an image) can leave the whole page
    // zoomed when the dialog closes. Chrome on Android keeps the document
    // viewport zoom as a page-level state, so the only way back is to force the
    // viewport to re-lay-out: reset the scroll and re-assert the viewport width.
    window.scrollTo(0, 0);
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
      const original = viewport.getAttribute("content");
      viewport.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => viewport.setAttribute("content", original));
      });
    }
  });
  document.querySelector("#viewer-download").addEventListener("click", () => {
    if (viewerDownload) void downloadPath(viewerDownload.path, viewerDownload.name, viewerDownload.server);
  });

  async function viewTicket(filePath, server, view) {
    const response = await transferRequest("/api/browse/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Herdr-CSRF": state.csrfToken },
      body: JSON.stringify({ path: filePath, server, ...(view ? { view: true } : {}) }),
    });
    return (await response.json()).ticket;
  }

  // Text and HTML both arrive this way: as the same opaque bytes a download
  // gets, never as a type the server named. What is done with them afterwards is
  // this side's business, and neither route lets the file pick.
  async function readFileText(filePath, server) {
    const ticket = await viewTicket(filePath, server, false);
    const response = await fetch(`/api/browse/download/${ticket}`);
    if (!response.ok) throw new Error(`Could not read the file (${response.status}).`);
    const text = await response.text();
    if (text.length > MAX_TEXT_PREVIEW_BYTES) throw new Error("That file is too long to show here.");
    return text;
  }

  function viewerText(text) {
    return createElement("pre", { className: "viewer-text", text });
  }

  // The sandbox is on the response, not on this element. Putting it here as well
  // would give the frame an opaque origin before the fetch, and a same-origin
  // body guarded by Cross-Origin-Resource-Policy will not load into one -- the
  // PDF simply never appears. The response says `sandbox` either way, and says
  // it to anyone who opens the URL rather than only to this frame.
  function viewerFrame(className, title, ticket) {
    const frame = createElement("iframe", { className });
    frame.setAttribute("title", title);
    frame.src = `/api/browse/download/${ticket}`;
    return frame;
  }

  function viewerMedia(kind, type, name, ticket) {
    if (kind === "document") return viewerFrame("viewer-document", name, ticket);
    const element = createElement(kind === "image" ? "img" : kind);
    element.className = `viewer-${kind}`;
    if (kind === "image") element.alt = name;
    else {
      element.controls = true;
      element.preload = "metadata";
    }
    element.addEventListener("error", () => setViewerFeedback("This file could not be shown here.", true));
    element.src = `/api/browse/download/${ticket}`;
    return element;
  }

  function canView(name, size) {
    return previewFor(name, size) !== null;
  }

  const viewerSourceButton = document.querySelector("#viewer-source");
  let viewerSource = null;

  // A PDF opens in a tab rather than in the dialog. Framing one is the part that
  // browsers disagree about -- Android Chrome draws nothing in a frame, iOS
  // Safari draws the first page -- while a tab is not framing at all and works
  // everywhere, at the full height a page-shaped document was written for. It
  // also means the response needs no exception to this app's framing rules,
  // because there is no frame.
  function openInTab(url) {
    const link = createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  viewerSourceButton.addEventListener("click", () => {
    if (!viewerSource) return;
    void (async () => {
      viewerSourceButton.disabled = true;
      try {
        if (viewerSource.showing === "source") {
          viewerBody.replaceChildren(await viewerSource.rendered());
          viewerSource.showing = "rendered";
          viewerSourceButton.textContent = "Source";
        } else {
          viewerSource.text ??= await readFileText(viewerSource.path, viewerSource.server);
          viewerBody.replaceChildren(viewerText(viewerSource.text));
          viewerSource.showing = "source";
          viewerSourceButton.textContent = "Rendered";
        }
        setViewerFeedback("");
      } catch (error) {
        setViewerFeedback(error.message, true);
      } finally {
        viewerSourceButton.disabled = false;
      }
    })();
  });

  async function viewFile(filePath, name, server, size = null) {
    const preview = previewFor(name, size);
    if (!preview) return;
    // Nothing to open a dialog around: the tab is the viewer.
    if (preview.kind === "pdf") {
      try {
        openInTab(`/api/browse/download/${await viewTicket(filePath, server, true)}`);
      } catch (error) {
        setBrowseFeedback(error.message, true);
      }
      return;
    }
    viewerDownload = { path: filePath, name, server };
    viewerSource = null;
    viewerSourceButton.hidden = true;
    viewerSourceButton.textContent = "Source";
    document.querySelector("#viewer-title").textContent = name;
    document.querySelector("#viewer-context").textContent = serverLabel(server) || "";
    viewerBody.replaceChildren();
    setViewerFeedback("Opening…");
    viewerDialog.showModal();
    try {
      const element = preview.kind === "text"
        ? viewerText(await readFileText(filePath, server))
        : viewerMedia(preview.kind, preview.type, name, await viewTicket(filePath, server, true));
      viewerBody.replaceChildren(element);
      // Markup is worth both readings, and which one is wanted is not ours to
      // guess: the drawing is the default, the source is one press away.
      if (preview.source) {
        viewerSource = {
          path: filePath,
          server,
          showing: "rendered",
          text: null,
          rendered: async () =>
            viewerMedia(preview.kind, preview.type, name, await viewTicket(filePath, server, true)),
        };
        viewerSourceButton.hidden = false;
      }
      setViewerFeedback("");
    } catch (error) {
      setViewerFeedback(error.message, true);
    }
  }

  async function downloadPath(filePath, label, server = browseState.server) {
    setBrowseFeedback(`Downloading ${label}…`);
    try {
      const { ticket } = await transferRequest("/api/browse/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Herdr-CSRF": state.csrfToken },
        body: JSON.stringify({ path: filePath, server }),
      }).then((response) => response.json());

      const link = createElement("a");
      link.href = `/api/browse/download/${ticket}`;
      link.download = label;
      document.body.append(link);
      link.click();
      link.remove();
      setBrowseFeedback("");
    } catch (error) {
      setBrowseFeedback(error.message, true);
    }
  }

  // A pasted screenshot arrives as a blob with no useful name, so it gets one
  // that says when it came from.
  function droppedFileName(file) {
    if (file.name && file.name !== "image.png" && file.name !== "blob") return file.name;
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
    const extension = (file.type.split("/")[1] || "bin").replace(/[^a-z0-9]/giu, "");
    return `pasted-${stamp}.${extension}`;
  }

  // One path for every way files can arrive: the picker, a drop, or a paste. They
  // go up one at a time, in the order given, so their paths land in the composer in
  // that order; one that fails is reported and the rest still go.
  async function uploadFiles(files, { report = setFeedback } = {}) {
    const list = [...(files || [])].filter((file) => file instanceof File);
    if (list.length === 0) return [];
    if (!state.selectedPaneId) {
      report("Select a session first.", true);
      return [];
    }

    const target = uploadServerId();
    // Inserting a path the session cannot open would read as a broken upload
    // rather than a deliberate one.
    const insert = target === sessionServerId();
    const saved = [];
    const failed = [];
    state.mutationBusy = true;
    try {
      for (const [index, file] of list.entries()) {
        const name = droppedFileName(file);
        report(list.length > 1 ? `Uploading ${index + 1} of ${list.length}: ${name}…` : `Uploading ${name}…`);
        // null: the server accepts any size.
        if (state.maxTransferBytes !== null && file.size > state.maxTransferBytes) {
          failed.push({ name, reason: `larger than ${formatTransferSize(state.maxTransferBytes)}` });
          continue;
        }
        try {
          const response = await transferRequest(
            `/api/files/${encodeURIComponent(name)}?server=${encodeURIComponent(target)}`,
            {
              method: "POST",
              // File.type would otherwise set a media type the upload route rejects.
              headers: { "Content-Type": "application/octet-stream", "X-Herdr-CSRF": state.csrfToken },
              body: file,
            },
          );
          const { file: stored } = await response.json();
          if (insert) insertTransferPath(stored.path);
          saved.push(stored);
        } catch (error) {
          failed.push({ name, reason: error.message.replace(/\.$/u, "") });
        }
      }
    } finally {
      state.mutationBusy = false;
    }
    report(uploadSummary({
      saved: saved.map((stored) => stored.name),
      failed,
      elsewhere: insert ? null : serverLabel(target),
    }), failed.length > 0);
    if (elements.transferDialog.open) void refreshUploadsList();
    if (elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
      void refreshBrowseFolder({ silent: true });
    }
    return saved;
  }

  async function uploadFromDialog() {
    const files = [...(elements.transferFile.files || [])];
    if (files.length === 0) {
      setTransferFeedback("Choose a file first.", true);
      return;
    }
    const controls = elements.transferDialog.querySelectorAll("button, input");
    for (const control of controls) control.disabled = true;
    const saved = await uploadFiles(files, { report: setTransferFeedback });
    for (const control of controls) control.disabled = false;
    // Left open when one failed, so what failed stays on screen.
    if (saved.length === files.length) elements.transferDialog.close();
  }

  function showChosenFile() {
    const files = [...(elements.transferFile.files || [])];
    const size = formatTransferSize(files.reduce((total, file) => total + file.size, 0));
    elements.transferDropLabel.textContent = files.length === 0
      ? "Choose files, or drop them here"
      : `${files.length === 1 ? files[0].name : `${files.length} files`} · ${size}`;
  }

  // Drops and pastes are accepted wherever they land in the app, so a screenshot
  // can go straight from the clipboard to the composer without opening anything.
  function acceptDroppedFiles(list, report, onUploaded) {
    const files = [...(list || [])].filter((item) => item instanceof File);
    if (files.length === 0) return false;
    void uploadFiles(files, { report }).then((saved) => {
      if (saved.length === files.length) onUploaded?.(saved);
    });
    return true;
  }

  function attachDropZone(element, { report, onDragState, onUploaded } = {}) {
    let depth = 0;
    const setActive = (active) => onDragState?.(active);
    element.addEventListener("dragenter", (event) => {
      if (![...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      depth += 1;
      setActive(true);
    });
    element.addEventListener("dragover", (event) => {
      if (![...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    element.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    });
    element.addEventListener("drop", (event) => {
      if (![...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      depth = 0;
      setActive(false);
      acceptDroppedFiles(event.dataTransfer.files, report ?? setFeedback, onUploaded);
    });
  }

  function uploadsRow(file) {
    const row = createElement("div", { className: "uploads-row" });
    const copy = createElement("div", { className: "transfer-copy" });
    copy.append(createElement("div", { className: "transfer-name", text: file.name }));
    copy.append(createElement("div", {
      className: "transfer-meta",
      text: `${formatTransferSize(file.size)} · ${new Date(file.modifiedAt).toLocaleString()}`,
    }));

    // Four buttons per row was most of the row, and every one of them was an icon
    // a reader had to decode. They move behind one menu that names them. The menu
    // is not wrapped in .transfer-row-actions: that class squares off whatever
    // button it contains, which is right for icons and wrong for a list of names.
    const actions = sidebarActionMenu({
      id: `upload-${file.name}`,
      label: `Actions for ${file.name}`,
      className: "uploads-action-menu",
      escapesOverflow: true,
      actions: [
        ...(canView(file.name, file.size) ? [{
          label: "View",
          paths: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
          onSelect: () => void viewFile(file.path, file.name, uploadServerId(), file.size),
        }] : []),
        {
          label: "Insert path",
          paths: ["M12 5v14M5 12h14"],
          onSelect: () => {
            insertTransferPath(file.path);
            elements.transferDialog.close();
          },
        },
        {
          label: "Copy path",
          paths: ["M9 9h9v11H9z", "M6 15H5V4h9v1"],
          onSelect: () => void copyUploadPath(file.path),
        },
        {
          label: "Download",
          paths: ["M12 4v11m-4-4 4 4 4-4", "M5 20h14"],
          onSelect: () => void downloadPath(file.path, file.name, uploadServerId()),
        },
        {
          label: "Delete",
          paths: ["M5 7h14", "M10 7V4h4v3", "M7 7l1 13h8l1-13"],
          danger: true,
          onSelect: () => void deleteUpload(file.name),
        },
      ],
    });

    row.append(copy, actions);
    return row;
  }

  async function copyUploadPath(path) {
    try {
      await navigator.clipboard.writeText(path);
      setTransferFeedback("Path copied.");
    } catch {
      setTransferFeedback("Copying needs a secure connection (HTTPS).", true);
    }
  }

  async function deleteUpload(name) {
    if (!window.confirm(`Delete “${name}”?`)) return;
    setTransferFeedback(`Deleting ${name}…`);
    try {
      await transferRequest(
        `/api/files/${encodeURIComponent(name)}?server=${encodeURIComponent(uploadServerId())}`,
        { method: "DELETE", headers: { "X-Herdr-CSRF": state.csrfToken } },
      );
      setTransferFeedback("");
      await refreshUploadsList();
      if (elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
        void refreshBrowseFolder({ silent: true });
      }
    } catch (error) {
      setTransferFeedback(error.message, true);
    }
  }

  function describeUploadTarget() {
    const target = uploadServerId();
    const context = document.querySelector("#transfer-dialog-context");
    if (!context) return;
    context.textContent = target === sessionServerId()
      ? `Stored on ${serverLabel(target)}, path inserted into the composer.`
      : `Stored on ${serverLabel(target)}. The selected session runs elsewhere, so the path is not inserted.`;
  }

  async function refreshUploadsList() {
    describeUploadTarget();
    try {
      const server = encodeURIComponent(uploadServerId());
      const { files } = await transferRequest(`/api/files?server=${server}`)
        .then((response) => response.json());
      elements.uploadsList.replaceChildren();
      if (!array(files).length) {
        elements.uploadsList.append(
          createElement("p", { className: "transfer-empty", text: "Nothing uploaded yet." }),
        );
        return;
      }
      for (const file of sortUploads(array(files))) elements.uploadsList.append(uploadsRow(file));
    } catch (error) {
      setTransferFeedback(error.message, true);
    }
  }

  function openUploadsDialog() {
    if (elements.transferDialog.open) return;
    setTransferFeedback("");
    elements.transferDialog.showModal();
    void refreshUploadsList();
  }

  elements.attachButton.addEventListener("click", () => {
    if (elements.attachButton.disabled) return;
    openUploadsDialog();
  });

  // Voice input: the mic shows only when the browser can recognise speech
  // (Chrome's webkitSpeechRecognition, Google-backed, no key). The words land in
  // the textarea so they can be reviewed before sending.
  let speech = null;
  function speechStop() {
    if (speech) speech.stop();
  }
  if (elements.dictateButton && speechSupported()) {
    elements.dictateButton.hidden = false;
    speech = createSpeechButton({
      button: elements.dictateButton,
      textarea: elements.terminalInput,
      // words shown while still being heard come without an input event
      onTextChange: () => syncComposerExpanded({ defer: true }),
    });
  }

  elements.transferUpload.addEventListener("click", () => void uploadFromDialog());

  elements.transferDrop.addEventListener("click", () => elements.transferFile.click());

  elements.transferFile.addEventListener("change", showChosenFile);

  attachDropZone(elements.transferDialog, {
    report: setTransferFeedback,
    onDragState: (active) => elements.transferDrop.classList.toggle("is-dragging", active),
    onUploaded: () => elements.transferDialog.close(),
  });

  // The terminal panel covers the output, the key bar, and the composer, which is
  // the whole area a person would aim a file at.
  attachDropZone(elements.terminalPanel, {
    onDragState: (active) => elements.terminalPanel.classList.toggle("is-dropping", active),
  });

  // A screenshot pasted into the composer is uploaded instead of being ignored;
  // ordinary text still pastes normally.
  elements.terminalInput.addEventListener("paste", (event) => {
    if (acceptDroppedFiles(event.clipboardData?.files, setFeedback)) event.preventDefault();
  });

  elements.transferClose.addEventListener("click", () => {
    if (!state.mutationBusy) elements.transferDialog.close();
  });

  elements.transferDialog.addEventListener("cancel", (event) => {
    if (state.mutationBusy) event.preventDefault();
  });

  elements.transferDialog.addEventListener("close", () => {
    elements.transferFile.value = "";
    showChosenFile();
    setTransferFeedback("");
  });

  // Only folders that were opened have been fetched, so the tree keeps a listing
  // per visited path rather than one nested structure.

  const browseState = {
    // null means "follow the session being viewed", which is where an upload
    // used to go. Picking a machine in the Files tab pins it for both browsing
    // and uploads, and the choice survives a reload.
    pinnedServer: null,
    get server() { return this.pinnedServer ?? sessionServerId(); },
    set server(value) { this.pinnedServer = value; },
    root: null,
    uploads: null,
    loaded: new Map(),
    expanded: new Set(),
    selected: null,
    busy: false,
    addedPaths: new Set(),
    clearDiffTimer: null,
  };

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

  function browseActionButton({ label, paths, danger = false, run }) {
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

  // A folder the tree can open into: not a broken link, and not one of the
  // sign-in folders the server lists by name only.
  function isOpenableFolder(entry) {
    return entry.kind === "directory" && !entry.broken && entry.locked !== true;
  }

  // The server marks a locked entry readable: false too, so the file actions
  // need no separate locked test.
  function browseRow({ entry, depth, expanded }) {
    // Sign-in keys and HerdRabbit's own settings are listed by name only: the
    // server never opens them, so neither does the tree.
    const locked = entry.locked === true;
    const row = createElement("div", { className: "transfer-row browse-row" });
    if (locked) row.classList.add("is-locked");
    row.tabIndex = -1;
    row.style.setProperty("--depth", String(depth));
    row.dataset.path = entry.path;
    if (browseState.addedPaths?.has(entry.path)) {
      row.classList.add("is-added");
    } else if (entry.removed) {
      row.classList.add("is-removed");
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
      setBrowseTwisty(twisty, expanded);
      twisty.append(createIcon(["M9 6l6 6-6 6"]));
      twisty.addEventListener("click", (event) => {
        // The row toggles too, so without this the chevron would fire twice and
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
      row.title = `${entry.name} (removed)`;
    } else if (locked) {
      row.title = `${entry.name}\nHerdRabbit does not open sign-in keys or its own settings.`;
    } else if (entry.modifiedAt) {
      const size = entry.kind === "directory" ? "" : `${formatTransferSize(entry.size ?? 0)} · `;
      row.title = `${entry.name}\n${size}${new Date(entry.modifiedAt).toLocaleString()}`;
    }

    if (entry.broken) {
      lead.append(createElement("span", { className: "transfer-meta", text: "broken" }));
    } else if (locked) {
      lead.append(createElement("span", { className: "transfer-meta", text: "locked" }));
    }

    const actions = createElement("div", { className: "transfer-row-actions" });
    if (!entry.removed) {
      // Expanding shows a folder in place; this re-roots the tree there, so a deep
      // path stops costing a column of indentation.
      if (isOpenableFolder(entry)) {
        actions.append(browseActionButton({
          label: `Open ${entry.name} as the root`,
          paths: ["M4 12h13", "M13 7l5 5-5 5", "M20 5v14"],
          run: () => void loadBrowseFolder(entry.path),
        }));
      }
      if (entry.kind === "file" && entry.readable !== false) {
        // Reading a log or checking a screenshot is most of what a file in this
        // tree is opened for, and downloading it to a phone to do that is a detour.
        if (canView(entry.name, entry.size)) {
          actions.append(browseActionButton({
            label: `View ${entry.name}`,
            paths: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
            run: () => void viewFile(entry.path, entry.name, browseState.server, entry.size),
          }));
        }
        actions.append(browseActionButton({
          label: `Download ${entry.name}`,
          paths: ["M12 4v11m-4-4 4 4 4-4", "M5 20h14"],
          run: () => void downloadPath(entry.path, entry.name),
        }));
      }

      // Clicking the row selects it, and clicking a folder opens it -- the way an
      // editor sidebar behaves, rather than making people hit the small chevron.
      row.dataset.selected = String(browseState.selected === entry.path);
      row.addEventListener("click", () => {
        browseState.selected = entry.path;
        for (const other of elements.browseTree.querySelectorAll(".browse-row")) {
          other.dataset.selected = "false";
        }
        row.dataset.selected = "true";
        if (isOpenableFolder(entry)) void toggleBrowseFolder(entry.path);
      });
    }

    row.append(lead, actions);
    return row;
  }

  // Folds as long as a project does in Sessions, which is what the CSS animates.
  const BROWSE_FOLD_MS = 180;

  function setBrowseTwisty(twisty, expanded) {
    twisty.setAttribute("aria-expanded", String(expanded));
    twisty.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${twisty.dataset.name}`);
  }

  // An open folder's rows sit in their own wrapper, right after the folder's row,
  // so a folder opens and closes on its own -- sliding, as a project does --
  // instead of the whole tree being drawn again.
  function browseChildren() {
    const children = createElement("div", { className: "browse-children" });
    const inner = createElement("div", { className: "browse-children-inner" });
    children.append(inner);
    return { children, inner };
  }

  function appendBrowseRows(container, rows) {
    const open = [{ depth: -1, container }];
    for (const row of rows) {
      while (open.at(-1).depth >= row.depth) open.pop();
      const parent = open.at(-1).container;
      parent.append(browseRow(row));
      if (row.expanded && row.entry.kind === "directory") {
        const { children, inner } = browseChildren();
        parent.append(children);
        open.push({ depth: row.depth, container: inner });
      }
    }
  }

  function browseRowElement(path) {
    return [...elements.browseTree.querySelectorAll(".browse-row")].find((row) => row.dataset.path === path) || null;
  }

  function renderBrowseTree() {
    if (document.activeElement !== elements.filePath) {
      elements.filePath.value = browseState.root || "";
    }
    elements.fileUp.disabled = !parentDirectory(browseState.root);
    elements.fileUploads.disabled = !browseState.uploads || browseState.root === browseState.uploads;

    const rows = flattenTree(browseState.root, browseState.loaded, browseState.expanded);

    elements.browseTree.replaceChildren();
    if (rows.length === 0) {
      elements.browseTree.append(createElement("p", {
        className: "transfer-empty",
        text: "This folder is empty.",
      }));
      return;
    }
    appendBrowseRows(elements.browseTree, rows);
  }

  async function fetchListing(target, { prefix = "", server = browseState.server } = {}) {
    const parts = [`server=${encodeURIComponent(server)}`];
    // A remote listing with no path starts at that server's home.
    if (target) parts.push(`path=${encodeURIComponent(target)}`);
    if (prefix !== "") parts.push(`prefix=${encodeURIComponent(prefix)}`);
    return transferRequest(`/api/browse?${parts.join("&")}`).then((response) => response.json());
  }

  async function toggleBrowseFolder(path) {
    if (browseState.expanded.has(path)) {
      browseState.expanded.delete(path);
      const row = browseRowElement(path);
      const children = row?.nextElementSibling?.classList.contains("browse-children") ? row.nextElementSibling : null;
      if (!children) {
        renderBrowseTree();
        return;
      }
      setBrowseTwisty(row.querySelector(".browse-twisty"), false);
      children.inert = true;
      children.classList.add("is-collapsed");
      // Dropped once folded, unless the folder was opened again meanwhile.
      window.setTimeout(() => {
        if (children.classList.contains("is-collapsed")) children.remove();
      }, BROWSE_FOLD_MS);
      return;
    }
    if (!browseState.loaded.has(path)) {
      setBrowseFeedback("Loading…");
      try {
        const listing = await fetchListing(path);
        browseState.loaded.set(listing.path, listing);
        setBrowseFeedback(listing.truncated ? `Showing the first ${listing.entries.length} of ${listing.total}.` : "");
      } catch (error) {
        setBrowseFeedback(error.message, true);
        return;
      }
    }
    browseState.expanded.add(path);
    // Looked up after the listing arrives: the tree may have been drawn again
    // while it loaded.
    const row = browseRowElement(path);
    if (!row) {
      renderBrowseTree();
      return;
    }
    setBrowseTwisty(row.querySelector(".browse-twisty"), true);
    const folding = row.nextElementSibling?.classList.contains("browse-children") ? row.nextElementSibling : null;
    const { children, inner } = folding ? { children: folding, inner: folding.firstElementChild } : browseChildren();
    if (!folding) {
      children.classList.add("is-collapsed");
      const depth = Number(row.style.getPropertyValue("--depth")) + 1;
      appendBrowseRows(inner, flattenTree(path, browseState.loaded, browseState.expanded, depth));
      row.after(children);
      // Laid out folded first, so opening is a change the transition can run.
      children.getBoundingClientRect();
    }
    children.inert = false;
    children.classList.remove("is-collapsed");
  }

  // Says whether the folder is now the one on show.
  async function loadBrowseFolder(target, { refresh = false, reveal = false } = {}) {
    if (!reveal) revealState.generation += 1;
    if (browseState.busy) return false;
    browseState.busy = true;
    window.clearTimeout(browseState.clearDiffTimer);
    browseState.clearDiffTimer = null;
    browseState.addedPaths.clear();
    setBrowseFeedback("Loading…");
    try {
      const listing = await fetchListing(target);
      if (!refresh) browseState.expanded.clear();
      browseState.loaded.clear();
      browseState.loaded.set(listing.path, listing);
      browseState.root = listing.path;
      writeBrowsePath(browsePathStorage, listing.path, browseState.server);
      renderBrowseTree();
      setBrowseFeedback(listing.truncated ? `Showing the first ${listing.entries.length} of ${listing.total}.` : "");
      return true;
    } catch (error) {
      setBrowseFeedback(error.message, true);
      return false;
    } finally {
      browseState.busy = false;
    }
  }

  const BROWSE_AUTO_REFRESH_MS = 1_500;
  const BROWSE_DIFF_CLEAR_MS = 4_000;

  async function checkBrowseChanges(targets) {
    const targetEtags = {};
    for (const path of targets) {
      const listing = browseState.loaded.get(path);
      if (listing?.etag) targetEtags[path] = listing.etag;
    }
    if (Object.keys(targetEtags).length !== targets.length) {
      return targets;
    }
    const parts = [`server=${encodeURIComponent(browseState.server)}`];
    parts.push(`targets=${encodeURIComponent(JSON.stringify(targetEtags))}`);
    const result = await transferRequest(`/api/browse/check?${parts.join("&")}`)
      .then((r) => r.json())
      .catch(() => ({ changed: targets }));
    return Array.isArray(result?.changed) ? result.changed : targets;
  }

  async function refreshBrowseFolder({ silent = false } = {}) {
    if (browseState.busy || !browseState.root) return;
    browseState.busy = true;
    if (!silent) elements.fileRefresh?.classList.add("is-busy");

    try {
      const targets = [
        browseState.root,
        ...[...browseState.expanded].filter((path) => browseState.loaded.has(path) && path !== browseState.root),
      ];

      let pathsToFetch = targets;

      if (silent) {
        const changed = await checkBrowseChanges(targets);
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
          if (targetPath !== browseState.root) {
            browseState.expanded.delete(targetPath);
            browseState.loaded.delete(targetPath);
            anyChanged = true;
          }
          continue;
        }

        const newListing = result.value;
        const oldListing = browseState.loaded.get(targetPath);

        const { listing: diffedListing, added, removed } = diffBrowseListing(oldListing, newListing);

        for (const entry of added) {
          browseState.addedPaths.add(entry.path);
          totalAdded += 1;
          anyChanged = true;
        }

        for (const entry of removed) {
          browseState.addedPaths.delete(entry.path);
          if (browseState.selected === entry.path) browseState.selected = null;
          totalRemoved += 1;
          anyChanged = true;
        }

        const newPaths = new Set((newListing.entries || []).map((entry) => entry.path));
        for (const path of browseState.addedPaths) {
          if (parentDirectory(path) === targetPath && !newPaths.has(path)) {
            browseState.addedPaths.delete(path);
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

        browseState.loaded.set(targetPath, diffedListing);
      }

      if (anyChanged) {
        renderBrowseTree();
      }

      const summary = browseDiffSummary(totalAdded, totalRemoved);

      if (summary) {
        setBrowseFeedback(summary);
        window.clearTimeout(browseState.clearDiffTimer);
        browseState.clearDiffTimer = window.setTimeout(() => {
          browseState.clearDiffTimer = null;
          browseState.addedPaths.clear();
          for (const [path, listing] of browseState.loaded.entries()) {
            const cleaned = listing.entries.filter((entry) => !entry.removed);
            if (cleaned.length !== listing.entries.length) {
              browseState.loaded.set(path, { ...listing, entries: cleaned });
            }
          }
          renderBrowseTree();
          const rootListing = browseState.loaded.get(browseState.root);
          setBrowseFeedback(
            rootListing?.truncated ? `Showing the first ${rootListing.entries.length} of ${rootListing.total}.` : ""
          );
        }, BROWSE_DIFF_CLEAR_MS);
      } else if (!silent) {
        if (browseState.addedPaths.size > 0 || [...browseState.loaded.values()].some((l) => l.entries.some((e) => e.removed))) {
          browseState.addedPaths.clear();
          for (const [path, listing] of browseState.loaded.entries()) {
            const cleaned = listing.entries.filter((entry) => !entry.removed);
            if (cleaned.length !== listing.entries.length) {
              browseState.loaded.set(path, { ...listing, entries: cleaned });
            }
          }
          renderBrowseTree();
        }
        const rootListing = browseState.loaded.get(browseState.root);
        setBrowseFeedback(
          rootListing?.truncated
            ? `Showing the first ${rootListing.entries.length} of ${rootListing.total}.`
            : "Folder is up to date."
        );
      }
    } catch (error) {
      if (!silent) {
        setBrowseFeedback(error.message, true);
      }
    } finally {
      browseState.busy = false;
      elements.fileRefresh?.classList.remove("is-busy");
    }
  }


  const browsePathStorage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();

  async function ensureUploadsPath() {
    if (browseState.uploads !== null) return browseState.uploads;
    const server = encodeURIComponent(browseState.server);
    const { directory } = await transferRequest(`/api/files?server=${server}`)
      .then((response) => response.json())
      .catch(() => ({ directory: null }));
    browseState.uploads = directory || null;
    return browseState.uploads;
  }

  // Files opens where browsing last stopped; the uploads folder is the fallback on a
  // first visit because it is the one folder this app is certain exists.
  // The snapshot already carries every configured server with its reachability,
  // including ones Herdr could not answer on. Reading the session records instead
  // would drop exactly those, and a connected PC's files may still be reachable
  // when Herdr itself is missing there.
  function refreshServerChoices() {
    const options = [
      { id: "local", name: "This machine" },
      // Every connected PC answers for its own files.
      ...array(state.snapshot?.servers)
        .filter((server) => server.id !== "local")
        .map((server) => ({ id: server.id, name: server.name || server.id })),
    ];
    elements.fileServer.replaceChildren();
    for (const option of options) {
      const node = createElement("option", { text: option.name });
      node.value = option.id;
      elements.fileServer.append(node);
    }
    // A server that was removed falls back to this machine.
    // A pinned machine that is gone falls back to following the session again --
    // but only once a snapshot has actually said which servers exist. Before that
    // the list is just this machine, and clearing here would drop the choice on
    // every reload.
    const known = array(state.snapshot?.servers);
    if (known.length > 0 && browseState.pinnedServer !== null &&
        !options.some((option) => option.id === browseState.pinnedServer)) {
      browseState.pinnedServer = null;
      writeFileServer(browsePathStorage, null);
    }
    elements.fileServer.value = browseState.server;
    elements.fileServer.hidden = options.length < 2;
  }

  async function openFilePanel() {
    if (browseState.root) {
      await refreshBrowseFolder({ silent: true });
      return;
    }
    refreshServerChoices();
    const remembered = readBrowsePath(browsePathStorage, browseState.server);
    const uploads = await ensureUploadsPath();
    await loadBrowseFolder(remembered || uploads || "/");
  }

  // Points the Files tab at another machine and loads `target` there. An empty
  // target asks that machine where its home is.
  function selectBrowseServer(id, target, { reveal = false } = {}) {
    browseState.server = id;
    writeFileServer(browsePathStorage, browseState.server);
    syncAttachAvailability();
    browseState.uploads = null;
    browseState.root = null;
    window.clearTimeout(browseState.clearDiffTimer);
    browseState.clearDiffTimer = null;
    browseState.addedPaths.clear();
    browseState.loaded.clear();
    browseState.expanded.clear();
    completion.entries = [];
    return loadBrowseFolder(target ?? (readBrowsePath(browsePathStorage, browseState.server) || ""), { reveal });
  }

  // How often a waiting folder load checks whether the one under way is done.
  const BROWSE_IDLE_POLL_MS = 50;

  // Resolves once no folder load is under way. `giveUp()` is asked after each
  // wait; when it says so, resolves false instead.
  async function waitForBrowseIdle(giveUp = () => false) {
    while (browseState.busy) {
      await new Promise((resolve) => window.setTimeout(resolve, BROWSE_IDLE_POLL_MS));
      if (giveUp()) return false;
    }
    return true;
  }

  // A machine picked by hand waits out a load still under way, which would turn
  // its own away, and a file link still waiting gives way to it.
  elements.fileServer.addEventListener("change", async () => {
    const id = elements.fileServer.value;
    revealState.generation += 1;
    await waitForBrowseIdle();
    if (elements.fileServer.value !== id) return;
    void selectBrowseServer(id);
  });

  const REVEAL_LOADED = "loaded";
  const REVEAL_FAILED = "failed";
  const REVEAL_SUPERSEDED = "superseded";

  // A file the viewer cannot show is still a file somebody named: take them to
  // it in the Files tab, in its own folder, with its row selected and in view.
  // A folder somebody named is opened itself: whether the name is a file or a
  // folder is read from its row in the parent's listing.
  async function revealInFiles(filePath, name, server) {
    const generation = ++revealState.generation;
    const folder = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
    if (desktopMedia.matches) state.desktopSidebarCollapsed = false;
    else state.mobileSidebarOpen = true;
    syncSidebar();
    showNavigatorTab("files", { load: false });
    refreshServerChoices();
    // A load already under way would turn this one away, however slow the
    // machine it is reading: wait it out, and go again if another slipped in.
    // Settles as REVEAL_LOADED, REVEAL_FAILED, or REVEAL_SUPERSEDED when a later
    // press or a hand-picked folder took over.
    const open = async (target, first) => {
      const superseded = () => generation !== revealState.generation;
      for (;;) {
        if (!await waitForBrowseIdle(superseded)) return REVEAL_SUPERSEDED;
        const loaded = first && server !== browseState.server
          ? await selectBrowseServer(server, target, { reveal: true })
          : await loadBrowseFolder(target, { reveal: true });
        if (superseded()) return REVEAL_SUPERSEDED;
        if (loaded || !browseState.busy) return loaded ? REVEAL_LOADED : REVEAL_FAILED;
      }
    };
    const outcome = await open(folder, true);
    if (outcome === REVEAL_SUPERSEDED) return;
    elements.fileServer.value = browseState.server;
    if (outcome === REVEAL_FAILED) return;
    await ensureUploadsPath();
    if (generation !== revealState.generation) return;
    const listing = browseState.loaded.get(browseState.root);
    let entry = listing?.entries.find((item) => item.name === name);
    // A folder listed only in part may hold it past the cut: ask for it by name,
    // and add it to the rows already shown.
    if (!entry && listing?.truncated) {
      try {
        entry = (await fetchListing(browseState.root, { prefix: name })).entries.find((item) => item.name === name);
      } catch { /* the note below still says it could not be found */ }
      if (generation !== revealState.generation) return;
      if (entry) listing.entries.push(entry);
    }
    if (!entry) {
      setBrowseFeedback(`${name} is not in this folder.`);
      return;
    }
    if (isOpenableFolder(entry)) {
      browseState.selected = null;
      await open(entry.path, false);
      return;
    }
    browseState.selected = entry.path;
    renderBrowseTree();
    const row = browseRowElement(entry.path);
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  }

  // The collapsed rail is for moving between sessions, so it shows the session
  // list whichever tab is chosen: a file tree squeezed into the rail is blank.
  // Expanding the sidebar again brings the chosen tab back.
  function applyNavigatorPanels() {
    const files = state.navigatorTab === "files" && !document.body.classList.contains("sidebar-collapsed");
    elements.workspaceList.hidden = files;
    elements.filePanel.hidden = !files;
  }

  function showNavigatorTab(tab, { load = true } = {}) {
    const files = tab === "files";
    elements.tabSessions.setAttribute("aria-selected", String(!files));
    elements.tabFiles.setAttribute("aria-selected", String(files));
    state.navigatorTab = tab;
    applyNavigatorPanels();
    writeNavigatorTab(browsePathStorage, tab);
    if (files && load) {
      if (browseState.root) void refreshBrowseFolder({ silent: true });
      else void openFilePanel();
    }
  }

  for (const tab of elements.navigatorTabs) {
    tab.addEventListener("click", () => showNavigatorTab(tab === elements.tabFiles ? "files" : "sessions"));
  }

  // A file tree needs more room than a session list, so the sidebar is draggable
  // and remembers the width. On a phone the sidebar is a full-width overlay and
  // the handle does nothing, so it is hidden there by CSS.
  function applyNavigatorWidth(width) {
    const clamped = clampNavigatorWidth(width);
    // Set on the root so the shell grid narrows the terminal by the same amount
    // the sidebar gains, instead of the two overlapping.
    document.documentElement.style.setProperty("--navigator-width", `${clamped}px`);
    elements.navigatorResizer.setAttribute("aria-valuenow", String(clamped));
    return clamped;
  }

  let navigatorWidth = applyNavigatorWidth(readNavigatorWidth(browsePathStorage));

  elements.navigatorResizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = navigatorWidth;
    elements.navigatorResizer.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-sidebar");

    const move = (moveEvent) => {
      navigatorWidth = applyNavigatorWidth(startWidth + (moveEvent.clientX - startX));
    };
    const stop = () => {
      elements.navigatorResizer.removeEventListener("pointermove", move);
      elements.navigatorResizer.removeEventListener("pointerup", stop);
      elements.navigatorResizer.removeEventListener("pointercancel", stop);
      document.body.classList.remove("is-resizing-sidebar");
      writeNavigatorWidth(browsePathStorage, navigatorWidth);
    };
    elements.navigatorResizer.addEventListener("pointermove", move);
    elements.navigatorResizer.addEventListener("pointerup", stop);
    elements.navigatorResizer.addEventListener("pointercancel", stop);
  });

  elements.navigatorResizer.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 12;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    navigatorWidth = applyNavigatorWidth(navigatorWidth + (event.key === "ArrowRight" ? step : -step));
    writeNavigatorWidth(browsePathStorage, navigatorWidth);
  });

  elements.fileRefresh?.addEventListener("click", () => {
    if (browseState.root) void refreshBrowseFolder({ silent: false });
    else void openFilePanel();
  });

  elements.fileUp.addEventListener("click", () => {
    const parent = parentDirectory(browseState.root);
    if (parent) void loadBrowseFolder(parent);
  });

  // The uploads folder gets its own dialog rather than sending the tree there:
  // it is a short list you act on, not somewhere to browse.
  elements.fileUploads.addEventListener("click", () => openUploadsDialog());

  window.setInterval(() => {
    if (
      elements.filePanel &&
      !elements.filePanel.hidden &&
      !document.hidden &&
      browseState.root &&
      !browseState.busy &&
      document.activeElement !== elements.filePath
    ) {
      void refreshBrowseFolder({ silent: true });
    }
  }, BROWSE_AUTO_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
      void refreshBrowseFolder({ silent: true });
    }
  });

  const completion = { entries: [], active: -1, timer: null };

  function hideSuggestions() {
    // Cancel the pending lookup too, or it reopens the list a moment later.
    window.clearTimeout(completion.timer);
    completion.active = -1;
    elements.fileSuggestions.hidden = true;
    elements.fileSuggestions.replaceChildren();
    elements.filePath.setAttribute("aria-expanded", "false");
  }

  function applySuggestion(value) {
    elements.filePath.value = value;
    hideSuggestions();
    void loadBrowseFolder(value);
  }

  function renderSuggestions(matches) {
    elements.fileSuggestions.replaceChildren();
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
      elements.fileSuggestions.append(item);
    });
    elements.fileSuggestions.hidden = false;
    elements.filePath.setAttribute("aria-expanded", "true");
  }

  async function updateCompletion() {
    const typed = elements.filePath.value;
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
      const listing = await fetchListing(folder, { prefix });
      // Typing moves on while the request is in flight; a reply the caret has
      // already left behind would otherwise replace the newer list.
      if (elements.filePath.value !== typed) return;
      completion.entries = listing.entries.filter((entry) => entry.kind === "directory");
    } catch {
      if (elements.filePath.value !== typed) return;
      completion.entries = [];
    }
    completion.active = -1;
    renderSuggestions(completion.entries.slice(0, 12));
  }

  elements.filePath.addEventListener("input", () => {
    // A short wait keeps a fast typist from firing one listing per keystroke.
    window.clearTimeout(completion.timer);
    completion.timer = window.setTimeout(() => void updateCompletion(), 150);
  });

  elements.filePath.addEventListener("keydown", (event) => {
    const items = [...elements.fileSuggestions.children];
    if (event.key === "Escape" && !elements.fileSuggestions.hidden) {
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
        applySuggestion(match ? match.path : elements.filePath.value);
        return;
      }
      hideSuggestions();
      void loadBrowseFolder(elements.filePath.value);
    }
  });

  elements.filePath.addEventListener("blur", () => window.setTimeout(hideSuggestions, 120));

  return {
    applyNavigatorPanels,
    browsePathStorage,
    browseState,
    fetchListing,
    refreshBrowseFolder,
    revealInFiles,
    showNavigatorTab,
    speechStop,
    syncAttachAvailability,
    viewFile,
    viewTicket,
  };
}
