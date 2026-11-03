import { createElement, createIcon, workspaceActionButton } from "./dom.js?v=1.4.24";
import { idOf } from "./snapshot.js?v=1.4.24";
import {
  agentStatus,
  agentStatusIcon,
  agentStatusLabel,
  displayRecordLabel,
  displayTabLabel,
  mostUrgentStatus,
  paneAgentKind,
  paneDisplayTitle,
  paneRowLine,
  paneSubtitle,
} from "../ui-model.js?v=1.4.24";
import { createPaneGrid, renderPaneMap } from "../pane-grid.js?v=1.4.24";
import * as xterm from "../vendor/xterm.mjs?v=1.4.24";
import { writePanePreference } from "../pane-preference.js?v=1.4.24";
import { writeExpandedSplitTabIds } from "../workspace-preference.js?v=1.4.24";
import { readGridFit, readGridFont, writeGridFont } from "../terminal-preference.js?v=1.4.24";
import { paneMoveRequest } from "../sidebar-drag.js?v=1.4.24";
import {
  addTile,
  layoutRects,
  moveTile,
  paneDropKind,
  prune as pruneViewTiles,
  removeTile,
  swapTiles,
  tiles as viewTiles,
  writeViewSplit,
} from "../view-split.js?v=1.4.24";

// Split tabs and this window's own view split: the Herdr grid on a wide
// screen, the pane map on a phone, the view split's tiles, a session dropped
// on a pane, the selection of a pane, a split session's rows in the sidebar
// and the pane actions (split, zoom, even out, move out, close, rearrange).
// Nothing here runs until createPaneViews is called; app.js calls it where
// this code used to sit, so the two grids are made and the Back and Close
// listeners are added in the same order as before.
// `shownGridTabId` and `shownPaneView` stay app.js's own `let`s, which other
// parts of the page read; they are read and set here through accessors on
// `deps`, and so is `snapshotSettled`, which the snapshot refresh reassigns.
// `viewSplit` is app.js's object, changed in place.
export function createPaneViews(deps) {
  const {
    state, elements, desktopMedia, panePreferenceStorage, viewSplit, viewSplitStorage,
    paneCalls, notificationNavigation,
    getShownGridTabId, setShownGridTabId, getShownPaneView, setShownPaneView, getSnapshotSettled,
    snapshotRecords, agentForPane, visibleStatusForPane, acknowledgePaneCompletion, completeNotificationRelay,
    selectedRecords, selectedRecordsFor, followMovedPaneState, refreshSnapshot, refreshTerminal,
    renderNavigation, renderPaneHeading, showTerminalMessage, resetInputHistoryNavigation, syncComposerDraft,
    focusComposer, closeMobileSidebar, setFeedback, showLogin, syncSettings, applyTerminalFontSize,
    isLinkableTerminalPath, openTerminalPath, sidebarActionMenu, paneButton, agentMark,
  } = deps;

  // --- Split tabs: the grid (wide screens) and the pane map (phones) ---------

  const GRID_ICON = ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"];

  function paneTabId(paneId) {
    const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
    return idOf(pane, "tab_id", "tabId");
  }

  function panesOfTab(tabId) {
    return snapshotRecords().panes.filter((pane) => idOf(pane, "tab_id", "tabId") === tabId);
  }

  // Only this machine's panes are split, closed, zoomed or laid out from here:
  // a connected PC's split tab opens one pane at a time, with no grid or map.
  function isLocalRecord(record) {
    return (record?.server_id || "local") === "local";
  }

  // The selected pane's tab when it has more than one pane, on this machine, else null.
  function selectedSplitTabId() {
    const tabId = paneTabId(state.selectedPaneId);
    const tabPanes = tabId ? panesOfTab(tabId) : [];
    return tabPanes.length > 1 && isLocalRecord(tabPanes[0]) ? tabId : null;
  }

  // The tab drawn as a grid now: a split tab chosen as one, on a wide screen.
  function gridTabId() {
    const tabId = selectedSplitTabId();
    return tabId && desktopMedia.matches && state.paneViews.get(tabId) === "grid" ? tabId : null;
  }

  // What a cell or a map box says of each pane of `tabId`.
  function splitTabPanes(tabId) {
    return panesOfTab(tabId).map((pane) => {
      const paneId = idOf(pane, "pane_id", "id");
      const agent = agentForPane(paneId);
      const status = visibleStatusForPane(paneId, agent, pane);
      return {
        paneId,
        label: paneDisplayTitle("", pane, "Terminal", agent),
        status,
        statusIcon: agentStatusIcon(status),
        statusText: agentStatusLabel(status),
      };
    });
  }

  // Herdr's layout of the split tab on screen, read again when its panes change
  // or it is a few seconds old (a zoom or a split made in Herdr itself). It is
  // undefined until first read, and null when it could not be read (a connected
  // PC's tab is refused). Each read has its own number, and `latest` holds the
  // newest read of each key: an older read of the same tab answering late (asked
  // before the user went to another tab and back) is dropped, and so is every
  // read begun before forgetPaneLayout (a split, a zoom), which may show the tab
  // as it was. `loadingKey` is the read in flight: one for another tab does not
  // hold up this tab's read, and its answer, should the tab no longer be
  // selected, is dropped.
  const PANE_LAYOUT_MAX_AGE_MS = 3_000;
  const paneLayout = { key: "", tabId: null, layout: undefined, at: 0, loadingKey: null, reads: 0, latest: new Map() };

  function paneLayoutFor(tabId) {
    const paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"));
    const key = `${tabId}|${paneIds.join(",")}`;
    if (paneLayout.loadingKey !== key && (paneLayout.key !== key || Date.now() - paneLayout.at > PANE_LAYOUT_MAX_AGE_MS)) {
      paneLayout.loadingKey = key;
      const read = ++paneLayout.reads;
      paneLayout.latest.set(key, read);
      paneCalls.layout(paneIds[0])
        .then((payload) => payload?.layout ?? null, () => null)
        .then((layout) => {
          if (paneLayout.latest.get(key) !== read) return;
          paneLayout.latest.delete(key);
          if (paneLayout.loadingKey === key) paneLayout.loadingKey = null;
          // The tab on screen is another now: draw it, which reads its layout.
          if (selectedSplitTabId() !== tabId) {
            if (state.authenticated) renderPaneViews();
            return;
          }
          const before = JSON.stringify(paneLayout.tabId === tabId ? paneLayout.layout ?? null : undefined);
          // A failed read keeps what was known of the same tab.
          const known = layout ?? (paneLayout.tabId === tabId ? paneLayout.layout ?? null : null);
          Object.assign(paneLayout, { key, tabId, layout: known, at: Date.now() });
          if (JSON.stringify(known) !== before) renderPaneViews();
        });
    }
    return paneLayout.tabId === tabId ? paneLayout.layout : undefined;
  }

  function forgetPaneLayout() {
    paneLayout.latest.clear();
    paneLayout.loadingKey = null;
    paneLayout.at = 0;
    paneLayout.key = "";
  }

  const paneGrid = createPaneGrid({
    host: elements.terminalStage,
    xterm,
    credentials: () => ({ csrf: state.csrfToken, launchToken: state.launchToken }),
    fontSize: state.terminalFontSize,
    fit: readGridFit(panePreferenceStorage),
    manualFont: readGridFont(panePreferenceStorage),
    onFontChange: (font) => {
      writeGridFont(panePreferenceStorage, font);
      syncSettings();
    },
    menuFor: paneGridMenu,
    onSelect: (paneId) => selectPane(paneId, { fromGrid: true }),
    onExpand: (paneId) => {
      selectPane(paneId, { view: "solo" });
      focusComposer();
    },
    onUnzoom: (paneId) => void paneGridAction(paneId, "zoom", { mode: "toggle" }),
    onRearrange: (drop) => void rearrangeGridPanes(drop),
    canRearrange: () => !state.mutationBusy,
    onAuthenticationRequired: () => showLogin(),
    terminalOptions: {
      // A pinch on a cell that sizes its pane sets the terminal font, as on a pane alone.
      onFontSizeChange: applyTerminalFontSize,
      isLinkablePath: isLinkableTerminalPath,
      onPath: openTerminalPath,
      onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
    },
  });

  // --- This window's own view split (view-split.js) --------------------------
  // Panes of other projects side by side, for this browser window alone: Herdr
  // is never asked to move or close anything, other devices never see it.

  // The tiles: the Herdr grid's cells in view mode, each its own socket at the
  // pane's own size. ⤢ opens a tile's pane alone (with Back to split view), ✕
  // takes the tile out of the view and leaves the pane as it is.
  const viewGrid = createPaneGrid({
    host: elements.terminalStage,
    xterm,
    credentials: () => ({ csrf: state.csrfToken, launchToken: state.launchToken }),
    fontSize: state.terminalFontSize,
    mode: "view",
    menuFor: viewTileMenu,
    onSelect: (paneId) => selectPane(paneId, { fromGrid: true }),
    onExpand: (paneId) => {
      selectPane(paneId, { view: "solo" });
      focusComposer();
    },
    onRearrange: (drop) => rearrangeViewTiles(drop),
    onAuthenticationRequired: () => showLogin(),
    terminalOptions: {
      isLinkablePath: isLinkableTerminalPath,
      onPath: openTerminalPath,
      onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
    },
  });

  // A tile dragged onto another: the two trade places (its middle) or it goes
  // next to that tile on a side. This window's layout alone: Herdr hears
  // nothing. The dragged tile stays selected and keeps the typing.
  function rearrangeViewTiles({ paneId, targetPaneId, kind, side }) {
    const next = kind === "swap" ? swapTiles(viewSplit.tree, paneId, targetPaneId)
      : moveTile(viewSplit.tree, paneId, targetPaneId, side);
    if (!next || next === viewSplit.tree) return;
    viewSplit.focus = paneId;
    setViewSplit(next, true);
    if (state.selectedPaneId !== paneId) selectPane(paneId, { view: "tiles" });
    else renderPaneViews();
    viewGrid.focus(paneId);
  }

  // The grid on screen, the Herdr tab's or the view split's, or null.
  function shownGrid() {
    return viewGrid.shown ? viewGrid : paneGrid.shown ? paneGrid : null;
  }

  // Keeps `tree` (null: no view split) and whether it is on screen, here and in
  // this window's session storage.
  function setViewSplit(tree, shown = viewSplit.shown) {
    viewSplit.tree = tree;
    viewSplit.shown = Boolean(tree) && shown;
    const ids = viewTiles(tree);
    if (!ids.includes(viewSplit.focus)) viewSplit.focus = ids[0] ?? null;
    writeViewSplit(viewSplitStorage, viewSplit);
  }

  // Whether the view split is on screen now: it is, it was not left for a pane
  // alone, the selected pane is one of its tiles, and the screen is wide.
  function viewSplitOnScreen() {
    return viewSplit.shown && desktopMedia.matches && viewTiles(viewSplit.tree).includes(state.selectedPaneId);
  }

  // What each tile says of its pane: as a grid cell, with its project.
  function viewTilePanes() {
    const { panes } = snapshotRecords();
    return viewTiles(viewSplit.tree).flatMap((paneId) => {
      const pane = panes.find((item) => idOf(item, "pane_id", "id") === paneId);
      if (!pane) return [];
      const agent = agentForPane(paneId);
      const status = visibleStatusForPane(paneId, agent, pane);
      const records = selectedRecordsFor(paneId);
      return [{
        paneId,
        label: paneDisplayTitle(displayTabLabel(records.tab), pane, "Terminal", agent),
        context: displayRecordLabel(records.workspace, "Project"),
        status,
        statusIcon: agentStatusIcon(status),
        statusText: agentStatusLabel(status),
      }];
    });
  }

  const REMOVE_TILE_ICON = "M6 6l12 12M18 6 6 18";

  // A tile's one action besides ⤢: ✕ takes it out of the view. Nothing in Herdr
  // is touched (no split, zoom or close here).
  function viewTileMenu(pane) {
    const button = createElement("button", { className: "pane-grid-remove" });
    button.type = "button";
    button.setAttribute("aria-label", `Remove ${pane.label} from view`);
    button.title = "Remove from view";
    button.append(createIcon([REMOVE_TILE_ICON]));
    button.addEventListener("click", () => removeViewTile(pane.paneId));
    return button;
  }

  // ✕ on a tile. With one tile left, the view split is over and that pane shows alone.
  function removeViewTile(paneId) {
    const before = viewTiles(viewSplit.tree);
    const next = removeTile(viewSplit.tree, paneId);
    if (!next) {
      const remaining = before.find((id) => id !== paneId) ?? state.selectedPaneId;
      closeViewSplit(remaining);
      return;
    }
    setViewSplit(next, true);
    if (state.selectedPaneId === paneId || !viewTiles(next).includes(state.selectedPaneId)) {
      selectPane(viewSplit.focus, { view: "tiles" });
    } else renderPaneViews();
  }

  // Ends the view split; `paneId` (else the selected pane) shows alone.
  function closeViewSplit(paneId = state.selectedPaneId) {
    setViewSplit(null, false);
    if (paneId) selectPane(paneId, { view: "solo" });
    else renderPaneViews();
  }

  // A session dropped on the pane alone or on a tile becomes a tile beside it,
  // on the side it was dropped, and is selected there. On the pane alone a view
  // split this window still keeps is carried on when that pane is one of its
  // tiles; otherwise the two make a new one.
  function addViewTile({ tabId, targetPaneId, side }) {
    const pane = panesOfTab(tabId)[0];
    const paneId = idOf(pane, "pane_id", "id");
    if (!paneId) return;
    const base = viewTiles(viewSplit.tree).includes(targetPaneId) ? viewSplit.tree : null;
    const next = addTile(base, targetPaneId, paneId, side);
    if (!next || next === base) {
      setFeedback(viewTiles(base).length >= 6 ? "A split view shows at most 6 panes." : "This pane is in the split view already.", true);
      if (base) selectPane(targetPaneId, { view: "tiles" });
      return;
    }
    setViewSplit(next, true);
    viewSplit.focus = paneId;
    selectPane(paneId, { view: "tiles" });
  }

  // Tiles whose panes are gone leave the view; with fewer than two left it is
  // over. The selected pane, gone with its tile, gives way to another tile.
  function pruneViewSplit(paneIds) {
    if (!viewSplit.tree || paneIds.length === 0) return;
    const before = viewTiles(viewSplit.tree);
    const next = pruneViewTiles(viewSplit.tree, paneIds);
    const after = viewTiles(next);
    if (after.length === before.length) return;
    const selectedGone = before.includes(state.selectedPaneId) && !paneIds.includes(state.selectedPaneId);
    const survivor = before.find((id) => paneIds.includes(id)) ?? null;
    setViewSplit(next);
    if (selectedGone && survivor) {
      state.selectedPaneId = next ? viewSplit.focus : survivor;
      syncComposerDraft();
    }
  }

  elements.viewBack.addEventListener("click", () => {
    if (!viewSplit.tree) return;
    selectPane(viewSplit.focus ?? viewTiles(viewSplit.tree)[0], { view: "tiles" });
  });
  elements.viewClose.addEventListener("click", () => closeViewSplit());

  // Which screen a session dropped from the sidebar lands on.
  function paneDropScreen() {
    return viewGrid.shown ? "tiles" : paneGrid.shown ? "grid" : "solo";
  }

  function paneDropKindFor(tabId, targetPaneId, screen = paneDropScreen()) {
    return paneDropKind(state.snapshot, { tabId, targetPaneId }, {
      screen,
      tileIds: viewTiles(viewSplit.tree),
      paneMoveAllowed: () => Boolean(paneMoveRequest(state.snapshot, { tabId, targetPaneId, side: "right" })),
    });
  }

  // A session dropped on a pane's edge: Herdr's own merge for a session of the
  // pane's project, this window's view split for another project's (or any on
  // a view split).
  function dropOnPane(drop) {
    const kind = paneDropKindFor(drop.tabId, drop.targetPaneId);
    if (kind === "move") void movePaneIntoSplit(paneMoveRequest(state.snapshot, drop));
    else if (kind === "view") addViewTile(drop);
  }

  // What the phone's map last drew.
  let paneMapKey = "";

  // Draws the grid (a Herdr tab's or this window's view split), the map and
  // the Back to grid and Back to split view controls for the selected pane, and
  // answers what is shown as a grid: the tab's id, "view" for the view split,
  // null for one pane alone.
  function renderPaneViews() {
    const tilesShown = viewSplitOnScreen();
    const splitTabId = tilesShown ? null : selectedSplitTabId();
    const gridTab = tilesShown ? null : gridTabId();
    const showMap = Boolean(splitTabId) && !desktopMedia.matches;
    // Read only for a grid or a map on screen: a pane shown alone needs none.
    const layout = gridTab || showMap ? paneLayoutFor(splitTabId) : undefined;
    const panes = splitTabId ? splitTabPanes(splitTabId) : [];
    elements.paneMap.hidden = !showMap;
    if (showMap) {
      const key = JSON.stringify([state.selectedPaneId, layout, panes]);
      if (key !== paneMapKey) {
        paneMapKey = key;
        renderPaneMap(elements.paneMap, {
          layout,
          panes,
          selectedPaneId: state.selectedPaneId,
          onPick: (paneId) => selectPane(paneId),
        });
      }
    } else paneMapKey = "";
    // The find bar lies over the terminal's top corner: below the map, not on it.
    elements.terminalStage.style.setProperty("--pane-map-clearance", showMap ? `${elements.paneMap.offsetHeight + 8}px` : "0px");
    elements.gridBack.hidden = !(splitTabId && desktopMedia.matches && !gridTab);
    elements.viewBack.hidden = !(viewSplit.tree && desktopMedia.matches && !tilesShown);
    elements.viewClose.hidden = !tilesShown;
    elements.terminalPanel.classList.toggle("is-grid", Boolean(gridTab) || tilesShown);
    if (gridTab) paneGrid.show({ panes, layout, selectedPaneId: state.selectedPaneId });
    else if (paneGrid.shown) paneGrid.hide();
    if (tilesShown) {
      if (viewSplit.focus !== state.selectedPaneId) {
        viewSplit.focus = state.selectedPaneId;
        writeViewSplit(viewSplitStorage, viewSplit);
      }
      viewGrid.show({ panes: viewTilePanes(), layout: layoutRects(viewSplit.tree), selectedPaneId: state.selectedPaneId });
    } else if (viewGrid.shown) viewGrid.hide();
    setShownGridTabId(gridTab);
    // A notification left waiting on a zoomed-out cell is done once a layout
    // read shows that cell.
    if ((gridTab || tilesShown) && state.renderedGrid && notificationNavigation.relayTarget) void completeNotificationRelay();
    setShownPaneView(gridTab ?? (tilesShown ? "view" : null));
    return getShownPaneView();
  }

  // Makes `paneId` the selected pane: the sidebar, the heading, the composer and
  // the key bar all follow it. `view` ("grid" or "solo") is how its tab shows,
  // or "tiles" for this window's view split, which "grid" and "solo" leave (it
  // stays kept, with Back to split view); left out, the tab keeps its view.
  // From a grid cell or a tile nothing is redrawn but the focus ring, so the
  // cell keeps the typing.
  function selectPane(paneId, { view = null, fromGrid = false } = {}) {
    const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
    if (!pane) return;
    const changed = state.selectedPaneId !== paneId;
    if (changed) resetInputHistoryNavigation();
    state.selectedPaneId = paneId;
    syncComposerDraft();
    state.preferredPaneId = paneId;
    writePanePreference(panePreferenceStorage, paneId);
    acknowledgePaneCompletion(paneId);
    setFeedback("");
    const tabId = idOf(pane, "tab_id", "tabId");
    if (tabId) state.lastPaneOfTab.set(tabId, paneId);
    if (view === "grid") state.paneViews.set(tabId, "grid");
    else if (view === "solo") state.paneViews.delete(tabId);
    if (viewSplit.tree && view) setViewSplit(viewSplit.tree, view === "tiles");
    renderNavigation();
    const selected = selectedRecords();
    renderPaneHeading(selected.pane, selected.tab, selected.workspace);
    if (fromGrid) {
      shownGrid()?.focus(paneId, { terminal: false });
      void refreshTerminal();
      return;
    }
    const leavingGrid = getShownGridTabId() || viewGrid.shown;
    if (!gridTabId() && !viewSplitOnScreen() && (changed || leavingGrid)) showTerminalMessage("Loading output…");
    void refreshTerminal();
  }

  // The pane a split tab opens on, and whose title and mark its row wears: the
  // selected pane when it is there, else the one last selected there, else the
  // one Herdr has focused, else its first.
  function splitTabFocusPaneId(tabId, paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"))) {
    const candidates = [state.selectedPaneId, state.lastPaneOfTab.get(tabId), state.snapshot?.focused_pane_id];
    return candidates.find((paneId) => paneId && paneIds.includes(paneId)) ?? paneIds[0] ?? null;
  }

  // Opens a split tab as a grid, on its focus pane (see splitTabFocusPaneId).
  function openPaneGrid(tabId) {
    const paneId = splitTabFocusPaneId(tabId);
    if (!paneId) return;
    selectPane(paneId, { view: "grid" });
    closeMobileSidebar();
  }

  // A split session's row: the grid on a wide screen; on a phone, which has no
  // grid, its focus pane alone with the pane map over it. A connected PC's
  // split tab has no grid here, so it opens that pane alone too.
  function openSplitSession(tabId) {
    const tabPanes = panesOfTab(tabId);
    if (tabPanes.length === 0) return;
    if (desktopMedia.matches && isLocalRecord(tabPanes[0])) {
      openPaneGrid(tabId);
      return;
    }
    const paneId = splitTabFocusPaneId(tabId);
    selectPane(paneId, { view: "solo" });
    closeMobileSidebar();
  }

  elements.gridBack.addEventListener("click", () => {
    const tabId = selectedSplitTabId();
    if (tabId) openPaneGrid(tabId);
  });

  // A split session's name: its tab's, else its focus pane's title, else "Split session".
  function splitSessionName(tabId, tabLabel, tabPanes) {
    if (tabLabel) return tabLabel;
    const paneId = splitTabFocusPaneId(tabId, tabPanes.map((pane) => idOf(pane, "pane_id", "id")));
    const pane = tabPanes.find((item) => idOf(item, "pane_id", "id") === paneId);
    return paneDisplayTitle("", pane, "", agentForPane(paneId)) || "Split session";
  }

  // A split session is one row in the sidebar, as a one-pane session is: its
  // focus pane's mark, its name, the number of panes, and the most urgent status
  // of them. It is shown selected while any of its panes is.
  function splitSessionButton(tabId, name, tabPanes, workspace) {
    const paneIds = tabPanes.map((pane) => idOf(pane, "pane_id", "id"));
    const focusPaneId = splitTabFocusPaneId(tabId, paneIds);
    const focusPane = tabPanes.find((pane) => idOf(pane, "pane_id", "id") === focusPaneId);
    const status = mostUrgentStatus(tabPanes.map((pane) => {
      const paneId = idOf(pane, "pane_id", "id");
      return visibleStatusForPane(paneId, agentForPane(paneId), pane);
    }));
    const statusText = agentStatusLabel(status);
    const button = createElement("button", { className: "pane-button split-session-button" });
    button.type = "button";
    button.dataset.tabId = tabId;
    button.dataset.status = status;
    button.setAttribute("aria-pressed", String(paneIds.includes(state.selectedPaneId)));
    const where = displayRecordLabel(workspace, "Project");
    button.setAttribute(
      "aria-label",
      `${name}, split session, ${paneIds.length} panes, ${statusText}, ${where}`,
    );
    button.title = `${name} · ${paneIds.length} panes · ${statusText}`;
    // Its mark column holds the arrow (laid over it, see splitDisclosureButton):
    // the focus pane's mark is drawn only in the folded sidebar's rail, which
    // has no arrow.
    button.append(agentMark(paneAgentKind(focusPane, agentForPane(focusPaneId))));
    const copy = createElement("span", { className: "pane-copy" });
    copy.append(createElement("strong", { className: "pane-title", text: name }));
    const line = paneRowLine(status, paneSubtitle(name, focusPane));
    if (line) copy.append(createElement("small", line));
    const badge = createElement("span", { className: "split-badge" });
    badge.setAttribute("aria-hidden", "true");
    badge.append(createIcon(GRID_ICON), createElement("span", { text: String(paneIds.length) }));
    const statusMark = createElement("span", {
      className: `pane-status ui-status state-${status}`,
      text: agentStatusIcon(status),
    });
    statusMark.setAttribute("aria-hidden", "true");
    button.append(copy, badge, statusMark);
    button.addEventListener("click", () => openSplitSession(tabId));
    return button;
  }

  // The arrow at the start of a split session's row, in the column the other
  // rows' program marks sit in: shows or hides its panes under it. Folded until
  // opened; which are open is kept in this browser. A pane selected in a folded
  // session does not open it: the row shows it selected.
  function splitDisclosureButton(tabGroup, tabId, name, paneList) {
    const expanded = state.expandedSplitTabIds.has(tabId);
    const labelFor = (open) => `${open ? "Hide" : "Show"} the panes of ${name}`;
    const button = workspaceActionButton({
      className: "split-disclosure",
      label: labelFor(expanded),
      paths: ["M9 18l6-6-6-6"],
    });
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-controls", paneList.id);
    button.addEventListener("click", () => {
      const open = !state.expandedSplitTabIds.has(tabId);
      if (open) state.expandedSplitTabIds.add(tabId);
      else state.expandedSplitTabIds.delete(tabId);
      tabGroup.classList.toggle("is-expanded", open);
      paneList.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute("aria-label", labelFor(open));
      button.title = labelFor(open);
      writeExpandedSplitTabIds(panePreferenceStorage, state.expandedSplitTabIds);
    });
    return button;
  }

  const SPLIT_RIGHT_ICON = ["M4 5h16v14H4z", "M12 5v14"];
  const SPLIT_DOWN_ICON = ["M4 5h16v14H4z", "M4 12h16"];
  const ZOOM_ICON = ["M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"];
  const UNZOOM_ICON = ["M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"];
  const MOVE_OUT_ICON = ["M14 4h6v6", "M20 4l-8 8", "M19 14v5H5V5h5"];
  const SEPARATE_ICON = ["M3 5h7v14H3z", "M14 5h7v14h-7z"];
  const EVEN_ICON = ["M3 5h18v14H3z", "M9 5v14", "M15 5v14"];

  // A pane's actions, the same in a grid cell's ⋯ and a split session's pane
  // row in the sidebar.
  function paneActions(paneId, zoomed) {
    return [
      { key: "split-right", label: "Split right", paths: SPLIT_RIGHT_ICON,
        onSelect: () => void paneGridAction(paneId, "split", { direction: "right" }) },
      { key: "split-down", label: "Split down", paths: SPLIT_DOWN_ICON,
        onSelect: () => void paneGridAction(paneId, "split", { direction: "down" }) },
      { key: "zoom", label: zoomed ? "Unzoom" : "Zoom", paths: zoomed ? UNZOOM_ICON : ZOOM_ICON,
        onSelect: () => void paneGridAction(paneId, "zoom", { mode: "toggle" }) },
      { key: "even-layout", label: "Even out layout", paths: EVEN_ICON,
        onSelect: () => void evenOutLayout(paneId) },
      { key: "move-out", label: "Move out to its own session", paths: MOVE_OUT_ICON,
        onSelect: () => void movePanesOut([paneId]) },
      { separator: true },
      { key: "close", label: "Close pane", paths: ["M6 6l12 12M18 6 6 18"], danger: true,
        onSelect: () => void closePaneFromGrid(paneId) },
    ];
  }

  function paneGridMenu(pane, zoomed) {
    return sidebarActionMenu({
      id: `grid-${pane.paneId}`,
      label: `More actions for ${pane.label}`,
      className: "pane-grid-menu",
      escapesOverflow: true,
      actions: paneActions(pane.paneId, zoomed),
    });
  }

  // A pane of a split session in the sidebar's list: its row, and on this
  // machine a ⋯ with the grid cell's actions, laid over the row's right padding
  // as every session row's is. Zoom reads Unzoom when the layout last read of
  // its tab (the tab on screen) says it is zoomed.
  function splitPaneRow(pane, tab, workspace, local) {
    const row = createElement("div", { className: "split-pane-row" });
    const button = paneButton(pane, tab, workspace);
    row.append(button);
    if (!local) return row;
    const paneId = button.dataset.paneId;
    const tabId = idOf(pane, "tab_id", "tabId");
    const layout = paneLayout.tabId === tabId ? paneLayout.layout : null;
    const zoomed = Boolean(layout?.zoomed);
    row.append(sidebarActionMenu({
      id: `split-pane-${paneId}`,
      label: `More actions for ${paneDisplayTitle("", pane, "Terminal", agentForPane(paneId))}`,
      className: "session-action-menu split-pane-menu",
      actions: paneActions(paneId, zoomed),
    }));
    return row;
  }

  // Takes panes out of their split session, one after another, each into a
  // session of its own in the same project. A pane Herdr renames is followed
  // (what the page keeps under its id, and the selection). A session left with
  // one pane shows it alone again. The first refusal stops the rest and is said
  // in the feedback line; the sidebar is read once at the end.
  async function movePanesOut(paneIds) {
    if (paneIds.length === 0) return;
    if (state.mutationBusy) {
      setFeedback("Another change is still in progress. Try again in a moment.", true);
      return;
    }
    const fromTabId = paneTabId(paneIds[0]);
    let left = panesOfTab(fromTabId).length;
    state.mutationBusy = true;
    setFeedback("");
    let refusal = "";
    try {
      for (const paneId of paneIds) {
        try {
          const result = await paneCalls.moveOut(paneId);
          left -= 1;
          const movedTo = typeof result?.pane_id === "string" ? result.pane_id : paneId;
          if (movedTo !== paneId) {
            followMovedPaneState([{ from: paneId, to: movedTo }]);
            if (state.selectedPaneId === paneId) {
              state.selectedPaneId = movedTo;
              state.preferredPaneId = movedTo;
              writePanePreference(panePreferenceStorage, movedTo);
            }
          }
        } catch (error) {
          refusal = error.message;
          break;
        }
      }
    } finally {
      state.mutationBusy = false;
    }
    if (fromTabId && left <= 1) state.paneViews.delete(fromTabId);
    await refreshAfterPaneChange();
    void refreshTerminal();
    if (refusal) setFeedback(refusal, true);
  }

  // "Even out layout": the panes of `paneId`'s split session take equal shares
  // of it. Herdr resizes them, so every device sees it; the grid re-reads the
  // layout and its cells slide to their new places. Said in the feedback line:
  // evened out, or why not (Herdr's reason, or a layout it could only partly
  // even out or had to put back).
  async function evenOutLayout(paneId) {
    if (state.mutationBusy) {
      setFeedback("Another change is still in progress. Try again in a moment.", true);
      return;
    }
    state.mutationBusy = true;
    setFeedback("");
    let notice;
    let failed = false;
    try {
      const result = await paneCalls.evenLayout(paneId);
      if (result?.even === false) {
        notice = result.message || "Could not even out the layout.";
        failed = true;
      } else notice = result?.changed === false ? "The panes are already even." : "Layout evened out.";
    } catch (error) {
      notice = error.message;
      failed = true;
    } finally {
      state.mutationBusy = false;
    }
    await refreshAfterPaneChange();
    void refreshTerminal();
    setFeedback(notice, failed);
  }

  // The split session's ⋯ "Separate all panes": every pane but the first to a
  // session of its own, once the user says so.
  function separateSplitSession(tabId, name) {
    const paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"));
    if (paneIds.length < 2) return;
    const count = paneIds.length;
    if (!window.confirm(`Separate the ${count} panes of “${name}” into ${count} sessions? Each pane keeps running; only the split is undone.`)) return;
    void movePanesOut(paneIds.slice(1));
  }

  function closePaneFromGrid(paneId) {
    const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
    if (!pane) return;
    const status = agentStatus(agentForPane(paneId), pane);
    const last = panesOfTab(idOf(pane, "tab_id", "tabId")).length <= 1;
    const label = paneDisplayTitle("", pane, "Terminal", agentForPane(paneId));
    const reason = last ? " It is the session's last pane, so the session closes too."
      : status === "working" ? " Its agent is still working."
      : status === "blocked" ? " Its agent is waiting for your answer." : "";
    if ((last || status === "working" || status === "blocked") &&
        !window.confirm(`Close pane “${label}”?${reason} This stops any running processes in it.`)) return;
    // The server closes a pane only when told the user meant it.
    void paneGridAction(paneId, "close", { confirmed: true });
  }

  // Runs a pane action from the grid (split, zoom, close) and shows the result:
  // a split selects the new pane; a refusal (no room for another pane) is said
  // in the feedback line.
  async function paneGridAction(paneId, action, body = {}) {
    if (state.mutationBusy) {
      setFeedback("Another change is still in progress. Try again in a moment.", true);
      return;
    }
    state.mutationBusy = true;
    setFeedback("");
    let result = null;
    // Closing the selected pane leaves the selection on a neighbour in its tab,
    // not on whatever pane the page would fall back to.
    const siblings = panesOfTab(paneTabId(paneId)).map((pane) => idOf(pane, "pane_id", "id"));
    const at = siblings.indexOf(paneId);
    const neighbour = siblings[at + 1] ?? siblings[at - 1] ?? null;
    try {
      result = await paneCalls.act(paneId, action, body);
      if (action === "close" && state.selectedPaneId === paneId && neighbour) {
        state.selectedPaneId = neighbour;
        state.preferredPaneId = neighbour;
        writePanePreference(panePreferenceStorage, neighbour);
        syncComposerDraft();
      }
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      state.mutationBusy = false;
    }
    await refreshAfterPaneChange();
    const added = typeof result?.pane_id === "string" ? result.pane_id : null;
    if (action === "split" && added && snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === added)) {
      selectPane(added, { fromGrid: getShownGridTabId() !== null });
    } else void refreshTerminal();
  }

  // The panes a session dragged from the sidebar may join now: the grid's cells,
  // or the pane shown alone. A phone has neither (its sidebar is a drawer over
  // them), and a session that may not join (several panes, another machine or
  // Herdr session, the pane itself) gets none.
  function paneDropTargets(tabId) {
    if (!desktopMedia.matches || state.mutationBusy) return [];
    const screen = paneDropScreen();
    const targets = screen !== "solo"
      ? [...elements.terminalStage.querySelectorAll(".pane-grid:not([hidden]) .pane-grid-cell:not([hidden])")]
        .map((element) => ({ paneId: element.dataset.paneId, element }))
      : state.selectedPaneId ? [{ paneId: state.selectedPaneId, element: elements.terminalStage }] : [];
    return targets.filter(({ paneId }) => paneDropKindFor(tabId, paneId, screen));
  }

  // After a pane is split, closed, zoomed or moved: the layout and the snapshot
  // are read again. A snapshot already on its way was asked for before the
  // change, so it is waited out first.
  async function refreshAfterPaneChange() {
    forgetPaneLayout();
    await getSnapshotSettled();
    await refreshSnapshot();
  }

  // Moves a session's one pane next to another pane, into that pane's tab. The
  // pane comes back under a new id: what the page keeps under its id follows it,
  // and it is selected in the grid of the tab it joined. A refusal (Herdr has
  // no room there) is said in the feedback line, and so is a pane that moved
  // but could not then be swapped to the left or the top (`placed` false).
  async function movePaneIntoSplit(request) {
    if (!request || state.mutationBusy) return;
    const targetTabId = paneTabId(request.body.targetPaneId);
    state.mutationBusy = true;
    setFeedback("");
    let movedTo = null;
    let unplaced = null;
    try {
      const result = await paneCalls.move(request.paneId, request.body);
      movedTo = typeof result?.pane_id === "string" ? result.pane_id : null;
      if (movedTo && movedTo !== request.paneId) {
        followMovedPaneState([{ from: request.paneId, to: movedTo }]);
        if (state.selectedPaneId === request.paneId) state.selectedPaneId = movedTo;
      }
      if (movedTo && targetTabId) state.paneViews.set(targetTabId, "grid");
      if (movedTo && result?.placed === false) {
        unplaced = `Moved, but could not put it on the ${request.body.side === "up" ? "top" : "left"}.`;
      }
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      state.mutationBusy = false;
    }
    await refreshAfterPaneChange();
    if (movedTo && snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === movedTo)) {
      selectPane(movedTo, { view: "grid" });
    } else void refreshTerminal();
    // After the selection, which clears the feedback line.
    if (unplaced) setFeedback(unplaced, true);
  }

  // A cell of a Herdr grid dragged onto another of the same tab: the two swap
  // places (dropped in its middle), or it moves next to it on a side (Herdr
  // lifts it out of the tab and splits it back in there). The pane stays
  // selected in the grid; should Herdr answer it under another id, what the
  // page keeps under its id follows it. A relocate that could not finish says
  // where the pane is now (`placed` false: put back in its session, or in a
  // session of its own).
  async function rearrangeGridPanes({ paneId, targetPaneId, kind, side }) {
    if (state.mutationBusy || !getShownGridTabId() || paneTabId(paneId) !== getShownGridTabId() || paneTabId(targetPaneId) !== getShownGridTabId()) return;
    const tabId = getShownGridTabId();
    state.mutationBusy = true;
    setFeedback("");
    let finalId = paneId;
    let notice = null;
    try {
      const result = kind === "swap"
        ? await paneCalls.swap(paneId, targetPaneId)
        : await paneCalls.relocate(paneId, targetPaneId, side);
      if (typeof result?.pane_id === "string" && result.pane_id !== paneId) {
        finalId = result.pane_id;
        followMovedPaneState([{ from: paneId, to: finalId }]);
        if (state.selectedPaneId === paneId) state.selectedPaneId = finalId;
      }
      if (result?.placed === false) notice = result.message || "Could not move the pane there.";
    } catch (error) {
      notice = error.message;
    } finally {
      state.mutationBusy = false;
    }
    await refreshAfterPaneChange();
    if (snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === finalId)) {
      // Left in a session of its own, it shows there, alone.
      const inGrid = paneTabId(finalId) === tabId;
      selectPane(finalId, inGrid ? { fromGrid: true } : { view: "solo" });
      if (inGrid) paneGrid.focus(finalId);
    } else void refreshTerminal();
    // After the selection, which clears the feedback line.
    if (notice) setFeedback(notice, true);
  }

  return {
    SEPARATE_ICON, EVEN_ICON,
    paneTabId, isLocalRecord, paneLayout, paneGrid, viewGrid, shownGrid, setViewSplit, pruneViewSplit,
    dropOnPane, paneDropTargets, renderPaneViews, selectPane,
    splitSessionName, splitSessionButton, splitDisclosureButton, splitPaneRow,
    evenOutLayout, separateSplitSession,
  };
}
