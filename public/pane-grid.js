// The panes of one split tab, laid out the way Herdr has them: the wide-screen
// grid (every pane a live terminal in its own cell) and the phone's small map
// of the same layout. Herdr's `pane layout` gives each pane a rect in cells;
// both views place a pane at its share of the tab's area, whatever the count.
import { createAttachedTerminal } from "./xterm-terminal.js?v=1.4.2";
import { terminalConnection } from "./terminal-connection.js?v=1.4.2";
import { MOUSE_DRAG_SLOP, dropPreview, dropSide } from "./sidebar-drag.js?v=1.4.2";

// A cell smaller than this (in Herdr's cells) is too small to read: it shows
// the pane's name until it is focused, rather than a terminal nobody can use.
export const MIN_ATTACH_COLS = 10;
export const MIN_ATTACH_ROWS = 3;

// A terminal cell is about twice as tall as it is wide, so a tab's shape on
// screen is its columns times this over its rows; the phone's map keeps that
// shape within these bounds so a very wide or tall tab stays tappable.
const CELL_ASPECT = 0.5;
const MAP_RATIO_MIN = 0.75;
const MAP_RATIO_MAX = 3;
const MAP_RATIO_FALLBACK = 4 / 3;

// Herdr answers with its own ids (`wM:p1`); the page's are scoped by session
// (`hs_…~wM:p1`). The part after the last `~` is the same in both.
const localId = (id) => String(id ?? "").split("~").pop();

// Where each of `paneIds` sits, as fractions of the tab ({ left, top, width,
// height } in 0..1) with its size in Herdr's cells ({ cols, rows }).
// `zoomedPaneId` is the pane a zoomed tab shows alone. Without a layout (not
// read yet, an older server, or one that failed) the panes share an even grid;
// panes the layout does not have yet are left out until it is read again.
export function gridCells(layout, paneIds) {
  const byLocal = new Map(paneIds.map((id) => [localId(id), id]));
  const listed = Array.isArray(layout?.panes)
    ? layout.panes.filter((item) => byLocal.has(localId(item?.pane_id)) && item.rect)
    : [];
  if (listed.length === 0) {
    const columns = Math.max(1, Math.ceil(Math.sqrt(paneIds.length)));
    const rows = Math.max(1, Math.ceil(paneIds.length / columns));
    return {
      zoomedPaneId: null,
      area: null,
      cells: paneIds.map((paneId, index) => ({
        paneId,
        left: (index % columns) / columns,
        top: Math.floor(index / columns) / rows,
        width: 1 / columns,
        height: 1 / rows,
        cols: Infinity,
        rows: Infinity,
      })),
    };
  }
  const area = layout.area && layout.area.width > 0 && layout.area.height > 0
    ? layout.area
    : {
      x: 0,
      y: 0,
      width: Math.max(...listed.map(({ rect }) => rect.x + rect.width)),
      height: Math.max(...listed.map(({ rect }) => rect.y + rect.height)),
    };
  const cells = listed.map(({ pane_id: id, rect }) => ({
    paneId: byLocal.get(localId(id)),
    left: (rect.x - (area.x ?? 0)) / area.width,
    top: (rect.y - (area.y ?? 0)) / area.height,
    width: rect.width / area.width,
    height: rect.height / area.height,
    cols: rect.width,
    rows: rect.height,
  }));
  const zoomedPaneId = layout.zoomed === true ? byLocal.get(localId(layout.focused_pane_id)) ?? null : null;
  return { zoomedPaneId, area, cells };
}

// A cell dragged by its header onto another cell: within this share of the
// other's width (or height) of an edge it goes next to that cell on that side;
// the middle (the rest, about 40% each way) swaps the two.
export const REARRANGE_EDGE_BAND = 0.3;

// What a cell dropped at (x, y) on a cell whose screen box is `box` does:
// { kind: "swap", preview } in the middle, { kind: "side", side, preview }
// near an edge (the half of `box` it would take), null outside `box`.
export function rearrangeDrop(box, x, y) {
  if (!box || !(box.width > 0) || !(box.height > 0)) return null;
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  if (x < box.left || x > right || y < box.top || y > bottom) return null;
  const edges = { left: box.left, top: box.top, width: box.width, height: box.height, right, bottom };
  const side = dropSide(edges, x, y, REARRANGE_EDGE_BAND);
  if (side) return { kind: "side", side, preview: dropPreview(edges, side) };
  return { kind: "swap", preview: { left: box.left, top: box.top, width: box.width, height: box.height } };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const EXPAND_ICON = "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5";

function icon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

// The grid inside `host`. Each cell has a terminal socket of its own, attached
// with keepSize: a cell shows the pane at Herdr's size and never resizes it.
// `panes` given to show() are { paneId, label, status, statusIcon, statusText };
// its `layout` is undefined while not read yet (the cells wait, unattached, so
// none attaches only to let go once Herdr's sizes are known) and null when it
// could not be read (the cells share an even grid and attach).
// `menuFor(pane, zoomed)` builds a cell's ⋯ menu; `onSelect(paneId)` hears a
// cell focused, `onExpand(paneId)` the cell opened alone, `onUnzoom(paneId)`
// the zoom undone.
// `mode: "view"` is this window's own view split (view-split.js) rather than a
// Herdr tab: the same cells, placed by the same math from its layoutRects,
// each header naming its pane's project too (`context`), and every tile a
// terminal (its rects are the browser's, never too small to read).
// `onRearrange({ paneId, targetPaneId, kind, side })` hears a cell dragged by
// its header onto another: kind "swap" (dropped in the other's middle) or
// "side" with the side of the other it goes to. A mouse drags once it moves a
// few pixels; Escape cancels. There is no dragging while a pane is zoomed,
// with fewer than two cells, or while `canRearrange()` says no.
export function createPaneGrid({ host, xterm, credentials, fontSize, menuFor, onSelect, onExpand, onUnzoom = () => {},
  onAuthenticationRequired = () => {}, terminalOptions = {}, mode = "herdr",
  onRearrange = null, canRearrange = () => true }) {
  const view = mode === "view";
  const root = element("div", view ? "pane-grid is-view" : "pane-grid");
  root.hidden = true;
  const zoomBar = element("div", "pane-grid-zoom");
  zoomBar.hidden = true;
  const zoomText = element("span", "pane-grid-zoom-text");
  const unzoom = element("button", "secondary-button pane-grid-unzoom", "Unzoom");
  unzoom.type = "button";
  zoomBar.append(zoomText, unzoom);
  const board = element("div", "pane-grid-board");
  root.append(zoomBar, board);
  // The view split is in the page only while it is shown: the page has one
  // Herdr grid to find, as before there was a view split.
  if (!view) host.append(root);
  let zoomedPaneId = null;
  unzoom.addEventListener("click", () => { if (zoomedPaneId) onUnzoom(zoomedPaneId); });

  // paneId -> { node, status, label, body, note, menuSlot, menuKey, terminal, connection, attached }
  const cells = new Map();
  let selected = null;
  // What show() last drew, so a call with nothing new leaves the cells alone.
  let drawnKey = null;
  // While paused (a hidden page, a sign-in asked for) the cells keep their
  // panes but no socket: resume() connects each again.
  let paused = false;

  // Dragging a cell by its header. `press` is a mouse held on a header that
  // has not moved far enough yet; `drag` the cell being carried, with the
  // label following the pointer and the drop it would make now (`target`).
  let press = null;
  let drag = null;
  const dropMark = element("div", "pane-drop-preview pane-grid-drop-preview");
  dropMark.setAttribute("aria-hidden", "true");
  const dropText = element("span", "pane-grid-drop-label");
  dropMark.append(dropText);

  const visibleCells = () => [...cells.values()].filter((cell) => !cell.node.hidden);
  const rearrangeable = () => Boolean(onRearrange) && !root.hidden && !zoomedPaneId &&
    !root.classList.contains("is-waiting") && visibleCells().length >= 2 && canRearrange() !== false;

  function setDropTarget(target) {
    drag.target = target;
    for (const cell of cells.values()) {
      cell.node.classList.toggle("is-swap-target", target?.kind === "swap" && target.paneId === cell.paneId);
    }
    dropMark.hidden = !target;
    if (!target) return;
    dropMark.dataset.kind = target.kind;
    if (target.side) dropMark.dataset.side = target.side;
    else delete dropMark.dataset.side;
    dropText.textContent = target.kind === "swap" ? "Swap" : "";
    dropText.hidden = target.kind !== "swap";
    dropMark.style.left = `${target.preview.left}px`;
    dropMark.style.top = `${target.preview.top}px`;
    dropMark.style.width = `${target.preview.width}px`;
    dropMark.style.height = `${target.preview.height}px`;
  }

  // The cell under the pointer and what a drop there would do; over the
  // dragged cell itself, or off the cells, nothing.
  function dropAt(x, y) {
    for (const cell of visibleCells()) {
      const box = cell.node.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      if (cell === drag.cell) return null;
      const drop = rearrangeDrop(box, x, y);
      return drop ? { ...drop, paneId: cell.paneId } : null;
    }
    return null;
  }

  function followDrag(x, y) {
    drag.ghost.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
    setDropTarget(dropAt(x, y));
  }

  function beginDrag(event) {
    const { cell, pointerId } = press;
    press = null;
    if (!cell.node.isConnected || cells.get(cell.paneId) !== cell || !rearrangeable()) return;
    const ghost = element("div", "pane-grid-drag-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.append(element("span", cell.status.className, cell.status.textContent),
      element("span", "pane-grid-drag-ghost-label", cell.label.textContent));
    document.body.append(ghost, dropMark);
    dropMark.hidden = true;
    drag = { cell, pointerId, ghost, target: null };
    cell.node.classList.add("is-drag-source");
    root.classList.add("is-rearranging");
    document.body.classList.add("is-pane-rearranging");
    // The pointer stays the header's: the terminals it crosses see no
    // movement (no selection, no mouse reports to the program in them).
    try { cell.header.setPointerCapture(pointerId); } catch { /* the pointer may already be gone */ }
    followDrag(event.clientX, event.clientY);
  }

  // Ends a drag; `drop` makes the move the pointer is over, if any.
  function endDrag(drop) {
    if (!drag) return;
    const done = drag;
    drag = null;
    done.ghost.remove();
    dropMark.remove();
    done.cell.node.classList.remove("is-drag-source");
    for (const cell of cells.values()) cell.node.classList.remove("is-swap-target");
    root.classList.remove("is-rearranging");
    document.body.classList.remove("is-pane-rearranging");
    try { done.cell.header.releasePointerCapture(done.pointerId); } catch { /* already released */ }
    const target = drop ? done.target : null;
    if (!target || !cells.has(target.paneId) || !cells.has(done.cell.paneId)) return;
    onRearrange({ paneId: done.cell.paneId, targetPaneId: target.paneId, kind: target.kind, side: target.side ?? null });
  }

  if (onRearrange) {
    window.addEventListener("pointermove", (event) => {
      if (drag) {
        if (event.pointerId === drag.pointerId) {
          event.preventDefault();
          followDrag(event.clientX, event.clientY);
        }
        return;
      }
      if (!press || event.pointerId !== press.pointerId) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOUSE_DRAG_SLOP) beginDrag(event);
    });
    const release = (drop) => (event) => {
      if (drag && event.pointerId === drag.pointerId) endDrag(drop);
      else if (press && event.pointerId === press.pointerId) press = null;
    };
    window.addEventListener("pointerup", release(true));
    window.addEventListener("pointercancel", release(false));
    // Escape puts the cell back; it reaches no terminal.
    window.addEventListener("keydown", (event) => {
      if (!drag || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
    }, true);
  }

  function attach(cell) {
    if (cell.attached) return;
    if (!cell.terminal) {
      cell.connection = terminalConnection({
        credentials,
        onOutput() {},
        onDisconnect() {},
        onAuthenticationRequired,
      });
      cell.terminal = createAttachedTerminal({
        ...terminalOptions,
        host: cell.body,
        connection: cell.connection,
        xterm,
        fontSize,
        // A Herdr grid cell is placed by Herdr's layout and keeps the pane's size
        // (the font shrinks to fit); a tile of this window's view split has no
        // layout of Herdr's to match, so it sizes its pane to the tile and reads
        // at the usual font. Neither answers herdr's capability queries as typing.
        keepSize: !view,
        quietReplies: true,
        onFallback: (paneId, problem) => {
          cell.note.textContent = problem?.code === "busy" || problem?.code === "too_many_attachments"
            ? "Too many terminals are open to show this one."
            : "This pane cannot be shown here.";
          cell.note.hidden = false;
        },
        onRetry: (paneId) => { if (!paused && cell.attached && cells.get(paneId) === cell) cell.terminal.show(paneId); },
        onStateChange: ({ ready }) => { if (ready) cell.note.hidden = true; },
      });
    }
    cell.attached = true;
    cell.note.hidden = true;
    if (!paused) cell.terminal.show(cell.paneId);
  }

  // A cell that leaves or shrinks lets its pane and socket go.
  function detach(cell) {
    if (!cell.attached) return;
    cell.attached = false;
    cell.terminal.show(null);
    cell.connection.pause();
  }

  function dispose(cell) {
    if (drag?.cell === cell) endDrag(false);
    if (press?.cell === cell) press = null;
    detach(cell);
    cell.terminal?.dispose();
    cell.node.remove();
  }

  function createCell(paneId) {
    const node = element("div", "pane-grid-cell");
    node.dataset.paneId = paneId;
    const header = element("div", "pane-grid-cell-header");
    const status = element("span", "pane-grid-status ui-status");
    status.setAttribute("aria-hidden", "true");
    const label = element("span", "pane-grid-label");
    const context = element("small", "pane-grid-context");
    context.hidden = true;
    const expand = element("button", "pane-grid-expand");
    expand.type = "button";
    expand.append(icon(EXPAND_ICON));
    const menuSlot = element("span", "pane-grid-menu-slot");
    header.append(status, context, label, expand, menuSlot);
    const body = element("div", "pane-grid-terminal");
    body.hidden = true;
    const note = element("p", "pane-grid-note");
    note.hidden = true;
    node.append(header, body, note);
    // Reachable by Tab; focus arriving in the cell (the cell itself, its
    // terminal's textarea) selects it like a press does.
    node.tabIndex = 0;
    node.setAttribute("role", "group");
    const cell = { paneId, node, header, status, context, label, expand, body, note, menuSlot, menuKey: null, terminal: null, connection: null, attached: false };
    // A mouse held on the header (not on its buttons) may pick the cell up.
    header.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.pointerType === "touch" || event.button !== 0 || drag || press) return;
      if (event.target.closest(".pane-grid-menu-slot, .pane-grid-expand") || !rearrangeable()) return;
      press = { cell, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    });
    header.addEventListener("lostpointercapture", (event) => {
      if (drag?.cell === cell && event.pointerId === drag.pointerId) endDrag(false);
    });
    // Any press in the cell makes it the selected pane; a press on its
    // terminal also leaves the typing there.
    node.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".pane-grid-menu-slot, .pane-grid-expand")) return;
      if (selected !== paneId) onSelect(paneId);
    });
    node.addEventListener("focusin", () => {
      if (selected !== paneId) onSelect(paneId);
    });
    node.addEventListener("keydown", (event) => {
      if (event.target !== node || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      if (selected !== paneId) onSelect(paneId);
      if (cell.attached) cell.terminal.focus();
    });
    node.addEventListener("click", (event) => {
      if (event.target.closest(".pane-grid-menu-slot, .pane-grid-expand")) return;
      if (cell.attached && !event.target.closest(".pane-grid-terminal")) cell.terminal.focus();
    });
    header.addEventListener("dblclick", (event) => {
      if (event.target.closest(".pane-grid-menu-slot, .pane-grid-expand")) return;
      onExpand(paneId);
    });
    expand.addEventListener("click", () => onExpand(paneId));
    board.append(node);
    cells.set(paneId, cell);
    return cell;
  }

  return {
    get shown() { return !root.hidden; },
    // Whether `paneId`'s cell is on screen: laid out as Herdr has it and not
    // hidden behind another pane's zoom.
    showsPane(paneId) {
      const cell = cells.get(paneId);
      return !root.hidden && !root.classList.contains("is-waiting") && Boolean(cell) && !cell.node.hidden;
    },
    // Draws the grid of `panes` at `layout`, `selectedPaneId` focused.
    // Cheap to call again: cells are kept, moved and updated in place, and
    // not touched at all when nothing drawn here changed.
    show({ panes, layout, selectedPaneId }) {
      const key = JSON.stringify([panes, layout === undefined ? "waiting" : layout, selectedPaneId]);
      if (key === drawnKey && !root.hidden) return;
      drawnKey = key;
      if (!root.isConnected) host.append(root);
      root.hidden = false;
      selected = selectedPaneId;
      const waiting = layout === undefined;
      root.classList.toggle("is-waiting", waiting);
      const info = new Map(panes.map((pane) => [pane.paneId, pane]));
      const placed = gridCells(layout, panes.map((pane) => pane.paneId));
      zoomedPaneId = placed.zoomedPaneId;
      zoomBar.hidden = !zoomedPaneId;
      // The headers show they can be picked up.
      root.classList.toggle("can-rearrange", Boolean(onRearrange) && !zoomedPaneId && !waiting && placed.cells.length >= 2);
      if (zoomedPaneId) zoomText.textContent = `Zoomed: ${info.get(zoomedPaneId)?.label ?? "pane"}`;
      const where = new Map(placed.cells.map((cell) => [cell.paneId, cell]));
      for (const [paneId, cell] of cells) {
        if (!where.has(paneId)) { dispose(cell); cells.delete(paneId); }
      }
      // A zoom (made elsewhere) puts a carried cell back.
      if (zoomedPaneId) endDrag(false);
      for (const pane of panes) {
        const place = where.get(pane.paneId);
        if (!place) continue;
        const cell = cells.get(pane.paneId) ?? createCell(pane.paneId);
        const zoomed = pane.paneId === zoomedPaneId;
        const hidden = Boolean(zoomedPaneId) && !zoomed;
        const box = zoomed ? { left: 0, top: 0, width: 1, height: 1 } : place;
        cell.node.hidden = hidden;
        cell.node.style.left = `${box.left * 100}%`;
        cell.node.style.top = `${box.top * 100}%`;
        cell.node.style.width = `${box.width * 100}%`;
        cell.node.style.height = `${box.height * 100}%`;
        const focused = pane.paneId === selectedPaneId;
        cell.node.classList.toggle("is-focused", focused);
        cell.node.dataset.status = pane.status;
        cell.status.className = `pane-grid-status ui-status state-${pane.status}`;
        cell.status.textContent = pane.statusIcon;
        cell.label.textContent = pane.label;
        cell.label.title = pane.label;
        cell.context.hidden = !pane.context;
        cell.context.textContent = pane.context ?? "";
        cell.context.title = pane.context ?? "";
        const named = pane.context ? `${pane.label} (${pane.context})` : pane.label;
        cell.node.setAttribute("aria-label", `${named}, ${pane.statusText}`);
        cell.expand.setAttribute("aria-label", `Open ${pane.label} alone`);
        cell.expand.title = "Open alone";
        const menuKey = String(Boolean(zoomedPaneId));
        if (cell.menuKey !== menuKey) {
          cell.menuKey = menuKey;
          cell.menuSlot.replaceChildren(menuFor(pane, Boolean(zoomedPaneId)));
        }
        // The menu is kept while the pane is renamed; its name follows.
        const more = cell.menuSlot.querySelector("summary");
        if (more) {
          more.setAttribute("aria-label", `More actions for ${pane.label}`);
          more.title = `More actions for ${pane.label}`;
        }
        // Lazily: a hidden cell lets its pane go, and a tiny one waits until
        // it is focused or zoomed.
        const roomy = view || zoomed || (place.cols >= MIN_ATTACH_COLS && place.rows >= MIN_ATTACH_ROWS);
        const tiny = !roomy && !focused;
        cell.node.classList.toggle("is-tiny", tiny);
        if (waiting || hidden || tiny) detach(cell);
        else attach(cell);
      }
    },
    // Moves the focus ring and the typing to `paneId`'s cell.
    focus(paneId, { terminal = true } = {}) {
      selected = paneId;
      drawnKey = null;
      for (const cell of cells.values()) cell.node.classList.toggle("is-focused", cell.paneId === paneId);
      const cell = cells.get(paneId);
      if (terminal && cell?.attached) cell.terminal.focus();
    },
    // The terminal font size the cells' fonts grow to at most.
    setFontSize(size) {
      fontSize = size;
      for (const cell of cells.values()) cell.terminal?.setFontSize(size);
    },
    // Every cell's socket closes; each keeps its pane, to attach on resume().
    pause() {
      paused = true;
      for (const cell of cells.values()) if (cell.attached) cell.connection.pause();
    },
    // Connects every cell that has a pane again (a socket closed by pause() or
    // by a sign-out), which attaches its pane anew.
    resume() {
      paused = false;
      for (const cell of cells.values()) if (cell.attached) cell.terminal.show(cell.paneId);
    },
    // Leaves the grid: every cell lets its pane and its socket go.
    hide() {
      endDrag(false);
      press = null;
      root.hidden = true;
      zoomBar.hidden = true;
      drawnKey = null;
      for (const cell of cells.values()) dispose(cell);
      cells.clear();
      if (view) root.remove();
    },
  };
}

// The phone's map of a split tab: one small box per pane where Herdr has it,
// coloured by its status, the selected one ringed. A tap picks a pane. A pane
// the layout does not have yet (one just split off) gets a box beside the map
// until the layout is read again.
export function renderPaneMap(host, { layout, panes, selectedPaneId, onPick }) {
  const placed = gridCells(layout, panes.map((pane) => pane.paneId));
  const info = new Map(panes.map((pane) => [pane.paneId, pane]));
  const map = element("div", "pane-map-board");
  const ratio = placed.area ? (placed.area.width * CELL_ASPECT) / placed.area.height : MAP_RATIO_FALLBACK;
  map.style.aspectRatio = String(Math.min(MAP_RATIO_MAX, Math.max(MAP_RATIO_MIN, ratio)));
  const mapBox = (paneId) => {
    const pane = info.get(paneId);
    const box = element("button", "pane-map-cell");
    box.type = "button";
    box.dataset.paneId = paneId;
    box.dataset.status = pane.status;
    box.setAttribute("aria-pressed", String(paneId === selectedPaneId));
    box.setAttribute("aria-label", `${pane.label}, ${pane.statusText}`);
    box.title = `${pane.label} · ${pane.statusText}`;
    box.addEventListener("click", () => onPick(paneId));
    return box;
  };
  for (const place of placed.cells) {
    const box = mapBox(place.paneId);
    box.style.left = `${place.left * 100}%`;
    box.style.top = `${place.top * 100}%`;
    box.style.width = `${place.width * 100}%`;
    box.style.height = `${place.height * 100}%`;
    map.append(box);
  }
  const shown = new Set(placed.cells.map((place) => place.paneId));
  const unplaced = panes.filter((pane) => !shown.has(pane.paneId));
  const extra = element("div", "pane-map-extra");
  extra.append(...unplaced.map((pane) => mapBox(pane.paneId)));
  const index = panes.findIndex((pane) => pane.paneId === selectedPaneId);
  const current = info.get(selectedPaneId);
  const caption = element("div", "pane-map-caption");
  caption.append(
    element("strong", "pane-map-count", `${index + 1} / ${panes.length}`),
    element("span", `pane-map-state state-${current?.status ?? "unknown"}`, current ? current.statusText : ""),
  );
  host.replaceChildren(...[map, unplaced.length > 0 ? extra : null, caption].filter(Boolean));
}
