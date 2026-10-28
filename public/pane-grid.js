// The panes of one split tab, laid out the way Herdr has them: the wide-screen
// grid (every pane a live terminal in its own cell) and the phone's small map
// of the same layout. Herdr's `pane layout` gives each pane a rect in cells;
// both views place a pane at its share of the tab's area, whatever the count.
import { createAttachedTerminal } from "./xterm-terminal.js?v=1.3.5";
import { terminalConnection } from "./terminal-connection.js?v=1.3.5";

// A cell smaller than this (in Herdr's cells) is too small to read: it shows
// the pane's name until it is focused, rather than a terminal nobody can use.
export const MIN_ATTACH_COLS = 10;
export const MIN_ATTACH_ROWS = 3;

// Herdr answers with its own ids (`wM:p1`); the page's are scoped by session
// (`hs_…~wM:p1`). The part after the last `~` is the same in both.
const localId = (id) => String(id ?? "").split("~").pop();

// Where each of `paneIds` sits, as fractions of the tab ({ left, top, width,
// height } in 0..1) with its size in Herdr's cells ({ cols, rows }).
// `zoomedPaneId` is the pane a zoomed tab shows alone. Without a layout (an
// older server, or one that failed) the panes share an even grid; panes the
// layout does not have yet are left out until it is read again.
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
// `panes` given to show() are { paneId, label, status, statusIcon, statusText }.
// `menuFor(pane, zoomed)` builds a cell's ⋯ menu; `onSelect(paneId)` hears a
// cell focused, `onExpand(paneId)` the cell opened alone, `onUnzoom(paneId)`
// the zoom undone.
export function createPaneGrid({ host, xterm, credentials, fontSize, menuFor, onSelect, onExpand, onUnzoom,
  onAuthenticationRequired = () => {}, terminalOptions = {} }) {
  const root = element("div", "pane-grid");
  root.hidden = true;
  const zoomBar = element("div", "pane-grid-zoom");
  zoomBar.hidden = true;
  const zoomText = element("span", "pane-grid-zoom-text");
  const unzoom = element("button", "secondary-button pane-grid-unzoom", "Unzoom");
  unzoom.type = "button";
  zoomBar.append(zoomText, unzoom);
  const board = element("div", "pane-grid-board");
  root.append(zoomBar, board);
  host.append(root);
  let zoomedPaneId = null;
  unzoom.addEventListener("click", () => { if (zoomedPaneId) onUnzoom(zoomedPaneId); });

  // paneId -> { node, status, label, body, note, menuSlot, menuKey, terminal, connection, attached }
  const cells = new Map();
  let selected = null;

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
        keepSize: true,
        onFallback: (paneId, problem) => {
          cell.note.textContent = problem?.code === "busy" || problem?.code === "too_many_attachments"
            ? "Too many terminals are open to show this one."
            : "This pane cannot be shown here.";
          cell.note.hidden = false;
        },
        onRetry: (paneId) => { if (cell.attached && cells.get(paneId) === cell) cell.terminal.show(paneId); },
        onStateChange: ({ ready }) => { if (ready) cell.note.hidden = true; },
      });
    }
    cell.attached = true;
    cell.note.hidden = true;
    cell.terminal.show(cell.paneId);
  }

  // A cell that leaves or shrinks lets its pane and socket go.
  function detach(cell) {
    if (!cell.attached) return;
    cell.attached = false;
    cell.terminal.show(null);
    cell.connection.pause();
  }

  function dispose(cell) {
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
    const expand = element("button", "pane-grid-expand");
    expand.type = "button";
    expand.append(icon(EXPAND_ICON));
    const menuSlot = element("span", "pane-grid-menu-slot");
    header.append(status, label, expand, menuSlot);
    const body = element("div", "pane-grid-terminal");
    body.hidden = true;
    const note = element("p", "pane-grid-note");
    note.hidden = true;
    node.append(header, body, note);
    const cell = { paneId, node, status, label, expand, body, note, menuSlot, menuKey: null, terminal: null, connection: null, attached: false };
    // Any press in the cell makes it the selected pane; a press on its
    // terminal also leaves the typing there.
    node.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".pane-grid-menu-slot, .pane-grid-expand")) return;
      if (selected !== paneId) onSelect(paneId);
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
    // Draws the grid of `panes` at `layout`, `selectedPaneId` focused.
    // Cheap to call again: cells are kept, moved and updated in place.
    show({ panes, layout, selectedPaneId }) {
      root.hidden = false;
      selected = selectedPaneId;
      const info = new Map(panes.map((pane) => [pane.paneId, pane]));
      const placed = gridCells(layout, panes.map((pane) => pane.paneId));
      zoomedPaneId = placed.zoomedPaneId;
      zoomBar.hidden = !zoomedPaneId;
      if (zoomedPaneId) zoomText.textContent = `Zoomed: ${info.get(zoomedPaneId)?.label ?? "pane"}`;
      const where = new Map(placed.cells.map((cell) => [cell.paneId, cell]));
      for (const [paneId, cell] of cells) {
        if (!where.has(paneId)) { dispose(cell); cells.delete(paneId); }
      }
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
        cell.node.setAttribute("aria-label", `${pane.label}, ${pane.statusText}`);
        cell.expand.setAttribute("aria-label", `Open ${pane.label} alone`);
        cell.expand.title = "Open alone";
        const menuKey = String(Boolean(zoomedPaneId));
        if (cell.menuKey !== menuKey) {
          cell.menuKey = menuKey;
          cell.menuSlot.replaceChildren(menuFor(pane, Boolean(zoomedPaneId)));
        }
        // Lazily: a hidden cell lets its pane go, and a tiny one waits until
        // it is focused or zoomed.
        const roomy = zoomed || (place.cols >= MIN_ATTACH_COLS && place.rows >= MIN_ATTACH_ROWS);
        const tiny = !roomy && !focused;
        cell.node.classList.toggle("is-tiny", tiny);
        if (hidden || tiny) detach(cell);
        else attach(cell);
      }
    },
    // Moves the focus ring and the typing to `paneId`'s cell.
    focus(paneId, { terminal = true } = {}) {
      selected = paneId;
      for (const cell of cells.values()) cell.node.classList.toggle("is-focused", cell.paneId === paneId);
      const cell = cells.get(paneId);
      if (terminal && cell?.attached) cell.terminal.focus();
    },
    // Leaves the grid: every cell lets its pane and its socket go.
    hide() {
      root.hidden = true;
      zoomBar.hidden = true;
      for (const cell of cells.values()) dispose(cell);
      cells.clear();
    },
    contains(node) { return root.contains(node); },
  };
}

// The phone's map of a split tab: one small box per pane where Herdr has it,
// coloured by its status, the selected one ringed. A tap picks a pane.
export function renderPaneMap(host, { layout, panes, selectedPaneId, onPick }) {
  const placed = gridCells(layout, panes.map((pane) => pane.paneId));
  const info = new Map(panes.map((pane) => [pane.paneId, pane]));
  const map = element("div", "pane-map-board");
  // The map keeps the tab's shape: Herdr's cells are about twice as tall as wide.
  const ratio = placed.area ? (placed.area.width * 0.5) / placed.area.height : 4 / 3;
  map.style.aspectRatio = String(Math.min(3, Math.max(0.75, ratio)));
  for (const place of placed.cells) {
    const pane = info.get(place.paneId);
    const box = element("button", "pane-map-cell");
    box.type = "button";
    box.dataset.paneId = place.paneId;
    box.dataset.status = pane.status;
    box.style.left = `${place.left * 100}%`;
    box.style.top = `${place.top * 100}%`;
    box.style.width = `${place.width * 100}%`;
    box.style.height = `${place.height * 100}%`;
    box.setAttribute("aria-pressed", String(place.paneId === selectedPaneId));
    box.setAttribute("aria-label", `${pane.label}, ${pane.statusText}`);
    box.title = `${pane.label} · ${pane.statusText}`;
    box.addEventListener("click", () => onPick(place.paneId));
    map.append(box);
  }
  const index = placed.cells.findIndex((place) => place.paneId === selectedPaneId);
  const current = info.get(selectedPaneId);
  const caption = element("div", "pane-map-caption");
  caption.append(
    element("strong", "pane-map-count", `${index + 1} / ${placed.cells.length}`),
    element("span", `pane-map-state state-${current?.status ?? "unknown"}`, current ? current.statusText : ""),
  );
  host.replaceChildren(map, caption);
}
