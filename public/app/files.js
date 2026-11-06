import {
  formatTransferSize,
  insertPathAtSelection,
  paneServerId,
  sortUploads,
  uploadSummary,
} from "../ui-model.js?v=1.4.44";
import { MAX_TEXT_PREVIEW_BYTES, looksLikeText, previewFor } from "../file-preview.js?v=1.4.44";
import { zoomablePicture, zoomableText } from "./viewer-zoom.js?v=1.4.44";
import { createImageViewer } from "../chat/image-viewer.js?v=1.4.44";
import { ticketUrl } from "../chat/chat-images.js?v=1.4.44";
import {
  clampNavigatorWidth,
  readBrowsePath,
  readNavigatorWidth,
  writeBrowsePath,
  writeFileServer,
  writeNavigatorTab,
  writeNavigatorWidth,
} from "../browse-preference.js?v=1.4.44";
import { createSpeechButton, speechSupported } from "../speech-recognition.js?v=1.4.44";
import { array, createElement } from "./dom.js?v=1.4.44";
import { browseUrl, createFolderTree, isOpenableFolder } from "./folder-tree.js?v=1.4.44";

// Files in and out of a machine: uploads, downloads and the uploads dialog,
// the file viewer, voice input, and the Files tab around its tree
// (folder-tree.js). Called once, where this code used to run in app.js: it registers
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
  // A name that was only a guess (preview.probe) is checked by its bytes first,
  // so a program without an extension is not drawn as a page of noise.
  async function readFileText(filePath, server, probe = false) {
    const ticket = await viewTicket(filePath, server, false);
    const response = await fetch(`/api/browse/download/${ticket}`);
    if (!response.ok) throw new Error(`Could not read the file (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (probe && !looksLikeText(bytes)) throw new Error("This file is not text. Download it to open it.");
    const text = new TextDecoder().decode(bytes);
    if (text.length > MAX_TEXT_PREVIEW_BYTES) throw new Error("That file is too long to show here.");
    return text;
  }

  function viewerText(text) {
    return zoomableText(createElement("pre", { className: "viewer-text", text }));
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
    return kind === "image" ? zoomablePicture(element) : element;
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

  let imageViewer = null;

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
    // A picture opens full screen in the chat's own picture viewer: zoom to 8x
    // with buttons, wheel or pinch, pan, copy and download, the same in both
    // places. An SVG stays in the dialog below, which can also show its source.
    if (preview.kind === "image" && !preview.source) {
      try {
        const url = ticketUrl(await viewTicket(filePath, server, true));
        if (url === null) throw new Error("This file could not be shown here.");
        imageViewer ??= createImageViewer({ viewTicket });
        imageViewer.open([{ url, path: filePath, server, name }]);
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
        ? viewerText(await readFileText(filePath, server, preview.probe))
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
      report("Select a tab first.", true);
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
      : `Stored on ${serverLabel(target)}. The selected tab runs elsewhere, so the path is not inserted.`;
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

  const browseState = {
    // null means "follow the session being viewed", which is where an upload
    // used to go. Picking a machine in the Files tab pins it for both browsing
    // and uploads, and the choice survives a reload.
    pinnedServer: null,
    get server() { return this.pinnedServer ?? sessionServerId(); },
    set server(value) { this.pinnedServer = value; },
    uploads: null,
    // The folder on show, and whether a load is under way: the tree's.
    get root() { return fileTree.root; },
    get busy() { return fileTree.busy; },
  };

  function syncUploadsButton() {
    elements.fileUploads.disabled = !browseState.uploads || fileTree.root === browseState.uploads;
  }

  // The Files tab's tree, in the panel; what it adds for the sidebar is the
  // file buttons, the reveal hand-off and the last folder per machine.
  const fileTree = createFolderTree(elements.filePanel, {
    request: (url) => transferRequest(url).then((response) => response.json()),
    server: () => browseState.server,
    fileActions: (entry) => [
      // Reading a log or checking a screenshot is most of what a file in this
      // tree is opened for, and downloading it to a phone to do that is a detour.
      ...(canView(entry.name, entry.size) ? [{
        label: `View ${entry.name}`,
        paths: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
        run: () => void viewFile(entry.path, entry.name, browseState.server, entry.size),
      }] : []),
      {
        label: `Download ${entry.name}`,
        paths: ["M12 4v11m-4-4 4 4 4-4", "M5 20h14"],
        run: () => void downloadPath(entry.path, entry.name),
      },
    ],
    // A folder picked by hand: a file link still waiting gives way to it.
    onNavigate: () => { revealState.generation += 1; },
    onShown: (listing) => {
      writeBrowsePath(browsePathStorage, listing.path, browseState.server);
      syncUploadsButton();
    },
  });

  // The Files tab's request, for any machine: the composer's `@` files use it too.
  async function fetchListing(target, { prefix = "", server = browseState.server } = {}) {
    return transferRequest(browseUrl(server, target, prefix)).then((response) => response.json());
  }

  // Says whether the folder is now the one on show.
  function loadBrowseFolder(target, { reveal = false } = {}) {
    if (!reveal) revealState.generation += 1;
    return fileTree.open(target);
  }

  const BROWSE_AUTO_REFRESH_MS = 1_500;

  async function refreshBrowseFolder({ silent = false } = {}) {
    if (silent || fileTree.busy || !fileTree.root) {
      await fileTree.refresh({ silent });
      return;
    }
    elements.fileRefresh?.classList.add("is-busy");
    try {
      await fileTree.refresh({ silent });
    } finally {
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
    syncUploadsButton();
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
    fileTree.clear();
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
    const entry = await fileTree.locate(name);
    if (generation !== revealState.generation) return;
    if (!entry) {
      setBrowseFeedback(`${name} is not in this folder.`);
      return;
    }
    if (isOpenableFolder(entry)) {
      fileTree.select(null);
      await open(entry.path, false);
      return;
    }
    fileTree.select(entry.path);
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
