// Dragging sessions and projects in the sidebar. A session (Herdr tab) moves
// within its project or to another project of the same machine and Herdr
// session; a project moves among the projects of its Herdr session. A session
// of one pane dropped on a pane's edge, off the list, joins that pane's tab.
//
// A "gap" is a place between rows of a list as it is now, the dragged row
// included: 0 is before the first row, the list's length after the last. It is
// what Herdr's tab.move and workspace.move take as insert_index.

// A mouse press becomes a drag after this many pixels of travel.
export const MOUSE_DRAG_SLOP = 5;
// A finger held this long without moving picks the row up; moving sooner is a scroll.
export const LONG_PRESS_MS = 400;
export const TOUCH_SLOP = 8;
// A drag's trailing click arrives within this many milliseconds.
const DRAG_CLICK_WINDOW = 400;
// Near the top or bottom edge of the list, it scrolls by itself.
const EDGE_SCROLL_ZONE = 40;
const EDGE_SCROLL_STEP = 12;

// The gap a pointer at `y` is over, given each row's vertical middle.
export function gapIndex(middles, y) {
  let gap = 0;
  for (const middle of middles) if (middle < y) gap += 1;
  return gap;
}

// Dropping a row next to itself leaves the list as it was.
export function isNoopGap(fromIndex, gap) {
  return fromIndex >= 0 && (gap === fromIndex || gap === fromIndex + 1);
}

// Records belong to one Herdr session of one machine; only there can they move.
export function dropScope(record) {
  return `${serverOf(record)}|${record?.herdr_session_id ?? ""}`;
}

const serverOf = (record) => record?.server_id ?? "local";

const idOf = (record, key) => (typeof record?.[key] === "string" ? record[key] : null);

// What to ask the server for a session dropped at `gap` among the sessions of
// `workspaceId`, or null when nothing would change or the drop is not allowed.
export function tabMoveRequest(snapshot, { tabId, workspaceId, gap }) {
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [];
  const tab = tabs.find((item) => idOf(item, "tab_id") === tabId);
  const target = workspaces.find((item) => idOf(item, "workspace_id") === workspaceId);
  if (!tab || !target || !Number.isInteger(gap) || gap < 0) return null;
  const source = workspaces.find((item) => idOf(item, "workspace_id") === idOf(tab, "workspace_id"));
  if (dropScope(source ?? tab) !== dropScope(target)) return null;
  const targetTabs = tabs.filter((item) => idOf(item, "workspace_id") === workspaceId);
  if (gap > targetTabs.length) return null;
  if (idOf(tab, "workspace_id") === workspaceId) {
    const fromIndex = targetTabs.indexOf(tab);
    if (isNoopGap(fromIndex, gap)) return null;
    return { tabId, body: { insertIndex: gap } };
  }
  // Herdr carries one pane at a time, so a split session stays in its project.
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  if (panes.filter((item) => idOf(item, "tab_id") === tabId).length > 1) return null;
  return { tabId, body: { workspaceId, insertIndex: gap } };
}

export function workspaceMoveRequest(snapshot, { workspaceId, gap }) {
  const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [];
  const workspace = workspaces.find((item) => idOf(item, "workspace_id") === workspaceId);
  if (!workspace || !Number.isInteger(gap) || gap < 0) return null;
  const siblings = workspaces.filter((item) => dropScope(item) === dropScope(workspace));
  if (gap > siblings.length || isNoopGap(siblings.indexOf(workspace), gap)) return null;
  return { workspaceId, body: { insertIndex: gap } };
}

// `list` with `item` taken out and put back at `gap` among `peers` (the items
// of `list` it is ordered with, itself included when it is one of them).
function placeAmong(list, item, peers, gap) {
  const fromIndex = peers.indexOf(item);
  const others = peers.filter((peer) => peer !== item);
  const at = fromIndex >= 0 && gap > fromIndex ? gap - 1 : gap;
  const rest = list.filter((entry) => entry !== item);
  if (others.length === 0) {
    const index = list.indexOf(item);
    rest.splice(index < 0 ? rest.length : index, 0, item);
    return rest;
  }
  const anchor = at < others.length ? others[at] : null;
  const index = anchor ? rest.indexOf(anchor) : rest.indexOf(others.at(-1)) + 1;
  rest.splice(index, 0, item);
  return rest;
}

// The snapshot as it will be once the session has moved, shown at once while
// the server is asked. Pane ids stay as they are until the server says.
export function movedTabSnapshot(snapshot, { tabId, workspaceId, gap }) {
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const tab = tabs.find((item) => idOf(item, "tab_id") === tabId);
  if (!tab) return snapshot;
  const moved = { ...tab, workspace_id: workspaceId };
  const peers = tabs.filter((item) => idOf(item, "workspace_id") === workspaceId);
  const swapped = tabs.map((item) => (item === tab ? moved : item));
  const peersSwapped = peers.map((item) => (item === tab ? moved : item));
  return {
    ...snapshot,
    tabs: placeAmong(swapped, moved, peersSwapped, gap),
    panes: (Array.isArray(snapshot.panes) ? snapshot.panes : []).map((pane) =>
      idOf(pane, "tab_id") === tabId ? { ...pane, workspace_id: workspaceId } : pane),
  };
}

export function movedWorkspaceSnapshot(snapshot, { workspaceId, gap }) {
  const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [];
  const workspace = workspaces.find((item) => idOf(item, "workspace_id") === workspaceId);
  if (!workspace) return snapshot;
  const peers = workspaces.filter((item) => dropScope(item) === dropScope(workspace));
  return { ...snapshot, workspaces: placeAmong(workspaces, workspace, peers, gap) };
}

// A session dropped on a pane joins that pane's tab on one side of it. The
// side is the edge the pointer is nearest, if it is within this share of the
// pane's width (or height) of that edge; the middle is no drop.
export const PANE_EDGE_BAND = 0.28;
const PANE_SIDES = ["left", "right", "up", "down"];

// The side of `box` a pointer at (x, y) would split, or null in the middle or outside.
export function dropSide(box, x, y, band = PANE_EDGE_BAND) {
  if (!box || box.width <= 0 || box.height <= 0) return null;
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
  const reach = {
    left: (x - box.left) / box.width,
    right: (box.right - x) / box.width,
    up: (y - box.top) / box.height,
    down: (box.bottom - y) / box.height,
  };
  const side = PANE_SIDES.reduce((best, item) => (reach[item] < reach[best] ? item : best));
  return reach[side] < band ? side : null;
}

// The half of `box` the dropped pane would take on `side`.
export function dropPreview(box, side) {
  const halfWidth = box.width / 2;
  const halfHeight = box.height / 2;
  if (side === "left") return { left: box.left, top: box.top, width: halfWidth, height: box.height };
  if (side === "right") return { left: box.left + halfWidth, top: box.top, width: halfWidth, height: box.height };
  if (side === "up") return { left: box.left, top: box.top, width: box.width, height: halfHeight };
  return { left: box.left, top: box.top + halfHeight, width: box.width, height: halfHeight };
}

// What to ask the server for session `tabId` dropped on `targetPaneId`'s
// `side`, or null: only a session of one pane joins another, and only one of
// the same Herdr session of this machine (a connected PC's panes are not
// split from here), and not its own.
export function paneMoveRequest(snapshot, { tabId, targetPaneId, side }) {
  if (!PANE_SIDES.includes(side)) return null;
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [];
  const moving = panes.filter((item) => idOf(item, "tab_id") === tabId);
  const target = panes.find((item) => idOf(item, "pane_id") === targetPaneId);
  if (moving.length !== 1 || !target || idOf(target, "tab_id") === tabId) return null;
  const ownerOf = (id) => {
    const tab = tabs.find((item) => idOf(item, "tab_id") === id);
    return tab ? workspaces.find((item) => idOf(item, "workspace_id") === idOf(tab, "workspace_id")) ?? tab : null;
  };
  const [owner, targetOwner] = [ownerOf(tabId), ownerOf(idOf(target, "tab_id"))];
  if (!owner || !targetOwner || serverOf(owner) !== "local" || dropScope(owner) !== dropScope(targetOwner)) return null;
  const paneId = idOf(moving[0], "pane_id");
  return paneId ? { paneId, body: { targetPaneId, side } } : null;
}

// A pane carried to another project comes back under a new id.
export function followMovedPane(paneId, moves) {
  const move = Array.isArray(moves) ? moves.find((item) => item?.from === paneId) : null;
  return typeof move?.to === "string" ? move.to : paneId;
}

function middles(elements) {
  return elements.map((element) => {
    const box = element.getBoundingClientRect();
    return box.top + box.height / 2;
  });
}

function scrollParent(element) {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

// Pointer dragging on the sidebar list. Rows carry what the drag needs:
// `.tab-group[data-tab-id][data-workspace-id][data-drop-scope]` for a session,
// `.workspace-group[data-workspace-id][data-drop-scope]` for a project, whose
// `.workspace-heading` is where a project is picked up.
// A mouse drags once it travels a few pixels; a finger has to rest on the row
// for LONG_PRESS_MS first, so a short tap still selects and a swipe still scrolls.
// Off the list, a session can land on a pane: `paneTargets({ tabId, scope })`
// lists the { paneId, element } it may join now (none when it may not), and
// `onDropPane({ tabId, targetPaneId, side })` hears it dropped on one's edge.
export function attachSidebarDrag(list, {
  canStart = () => true, onDropTab, onDropWorkspace, onEnd = () => {},
  paneTargets = () => [], onDropPane,
  longPressMs = LONG_PRESS_MS, now = () => performance.now(),
} = {}) {
  let press = null;
  let drag = null;
  let suppressClickUntil = 0;
  const line = document.createElement("div");
  line.className = "sidebar-drop-line";
  line.setAttribute("aria-hidden", "true");
  // The half of a pane the session would take.
  const preview = document.createElement("div");
  preview.className = "pane-drop-preview";
  preview.setAttribute("aria-hidden", "true");

  const groupsIn = (scope) => [...list.querySelectorAll(".workspace-group")]
    .filter((group) => group.dataset.dropScope === scope);
  const rowsOf = (group) => [...group.querySelectorAll(".tab-group")];

  // `settled`: the press ended without a drag. The page held its redraws for
  // the press; it gets them back after the click this press may still make,
  // since redrawing first would take the row away from under that click.
  function clearPress(settled = true) {
    if (!press) return;
    if (press.timer) clearTimeout(press.timer);
    press = null;
    if (settled) setTimeout(() => { if (!press && !drag) onEnd(); }, 0);
  }

  function setTarget(target) {
    for (const group of list.querySelectorAll(".workspace-group.is-drop-target")) {
      if (group !== target?.highlight) group.classList.remove("is-drop-target");
    }
    target?.highlight?.classList.add("is-drop-target");
    preview.hidden = !target?.side;
    if (!target) {
      line.hidden = true;
      drag.target = null;
      return;
    }
    if (target.side) {
      line.hidden = true;
      preview.dataset.side = target.side;
      preview.style.left = `${target.preview.left}px`;
      preview.style.top = `${target.preview.top}px`;
      preview.style.width = `${target.preview.width}px`;
      preview.style.height = `${target.preview.height}px`;
      drag.target = target;
      return;
    }
    line.hidden = false;
    line.style.left = `${target.lineLeft}px`;
    line.style.width = `${target.lineWidth}px`;
    line.style.top = `${target.lineY - 1}px`;
    drag.target = target;
  }

  // The line goes in the gap: above the row after it, or below the last row.
  function lineFor(rows, gap, box, fallbackY) {
    if (rows.length === 0) return { lineY: fallbackY, lineLeft: box.left, lineWidth: box.width };
    const after = rows[gap];
    const before = rows[gap - 1];
    const y = after && before
      ? (before.getBoundingClientRect().bottom + after.getBoundingClientRect().top) / 2
      : after ? after.getBoundingClientRect().top - 2 : before.getBoundingClientRect().bottom + 2;
    return { lineY: y, lineLeft: box.left, lineWidth: box.width };
  }

  // The pane edge under the pointer, for a session off the list.
  function paneTargetAt(x, y) {
    if (drag.kind !== "tab" || drag.split) return null;
    for (const { paneId, element } of paneTargets({ tabId: drag.tabId, scope: drag.scope })) {
      const box = element?.getBoundingClientRect();
      if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      // Over a pane, its middle is no drop rather than the pane beneath it.
      const side = dropSide(box, x, y);
      return side ? { targetPaneId: paneId, side, preview: dropPreview(box, side) } : null;
    }
    return null;
  }

  function targetAt(x, y) {
    const listBox = list.getBoundingClientRect();
    if (x < listBox.left - 24 || x > listBox.right + 24) return paneTargetAt(x, y);
    if (drag.kind === "tab") {
      const group = groupsIn(drag.scope).find((item) => {
        if (drag.split && item.dataset.workspaceId !== drag.workspaceId) return false;
        const box = item.getBoundingClientRect();
        return y >= box.top && y <= box.bottom;
      });
      if (!group) return null;
      const box = group.getBoundingClientRect();
      const collapsed = group.classList.contains("is-collapsed");
      const rows = collapsed ? [] : rowsOf(group);
      const gap = collapsed ? rowsOf(group).length : gapIndex(middles(rows), y);
      const heading = group.querySelector(".workspace-heading")?.getBoundingClientRect();
      const cross = group.dataset.workspaceId !== drag.workspaceId;
      return {
        workspaceId: group.dataset.workspaceId, gap,
        highlight: cross ? group : null,
        ...lineFor(rows, gap, box, (heading?.bottom ?? box.top) + 1),
      };
    }
    const container = drag.item.parentElement;
    const box = container.getBoundingClientRect();
    if (y < box.top - 12 || y > box.bottom + 12) return null;
    const siblings = [...container.children]
      .filter((child) => child.classList.contains("workspace-group") && child.dataset.dropScope === drag.scope);
    const gap = gapIndex(middles(siblings), y);
    return { workspaceId: drag.workspaceId, gap, highlight: null, ...lineFor(siblings, gap, box, box.top) };
  }

  function follow(x, y) {
    drag.x = x;
    drag.y = y;
    drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`;
    setTarget(targetAt(x, y));
  }

  function edgeScroll() {
    if (!drag) return;
    const scroller = drag.scroller;
    // A session held over a pane leaves the list where it is.
    if (scroller && !drag.target?.side) {
      const box = scroller.getBoundingClientRect();
      const step = drag.y < box.top + EDGE_SCROLL_ZONE ? -EDGE_SCROLL_STEP
        : drag.y > box.bottom - EDGE_SCROLL_ZONE ? EDGE_SCROLL_STEP : 0;
      if (step !== 0) {
        const before = scroller.scrollTop;
        scroller.scrollTop += step;
        if (scroller.scrollTop !== before) setTarget(targetAt(drag.x, drag.y));
      }
    }
    drag.frame = requestAnimationFrame(edgeScroll);
  }

  function begin(event) {
    const { item, kind, grip } = press;
    if (!item.isConnected) { clearPress(); return; }
    const box = grip.getBoundingClientRect();
    const ghost = grip.cloneNode(true);
    ghost.removeAttribute("id");
    for (const node of ghost.querySelectorAll("[id]")) node.removeAttribute("id");
    ghost.classList.add("sidebar-drag-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = `${box.width}px`;
    ghost.style.left = "0px";
    ghost.style.top = "0px";
    document.body.append(ghost, line, preview);
    line.hidden = true;
    preview.hidden = true;
    drag = {
      kind, item, ghost, pointerId: press.pointerId,
      tabId: item.dataset.tabId ?? null,
      workspaceId: item.dataset.workspaceId,
      scope: item.dataset.dropScope,
      split: item.dataset.split === "true",
      offsetX: press.x - box.left, offsetY: press.y - box.top,
      scroller: scrollParent(list), target: null, x: press.x, y: press.y, frame: 0,
    };
    clearPress(false);
    item.classList.add("is-drag-source");
    list.classList.add("is-dragging");
    document.body.classList.add("is-sidebar-dragging");
    try { list.setPointerCapture(drag.pointerId); } catch { /* the pointer may already be gone */ }
    follow(event?.clientX ?? drag.x, event?.clientY ?? drag.y);
    drag.frame = requestAnimationFrame(edgeScroll);
  }

  function finish(drop) {
    if (!drag) return;
    const done = drag;
    drag = null;
    cancelAnimationFrame(done.frame);
    done.ghost.remove();
    line.remove();
    preview.remove();
    done.item.classList.remove("is-drag-source");
    for (const group of list.querySelectorAll(".workspace-group.is-drop-target")) group.classList.remove("is-drop-target");
    list.classList.remove("is-dragging");
    document.body.classList.remove("is-sidebar-dragging");
    try { list.releasePointerCapture(done.pointerId); } catch { /* already released */ }
    suppressClickUntil = now() + DRAG_CLICK_WINDOW;
    onEnd();
    const target = drop ? done.target : null;
    if (!target) return;
    if (target.side) onDropPane?.({ tabId: done.tabId, targetPaneId: target.targetPaneId, side: target.side });
    else if (done.kind === "tab") onDropTab?.({ tabId: done.tabId, workspaceId: target.workspaceId, gap: target.gap });
    else onDropWorkspace?.({ workspaceId: done.workspaceId, gap: target.gap });
  }

  list.addEventListener("pointerdown", (event) => {
    // A new press makes its own click; only a drag's own trailing click is eaten.
    suppressClickUntil = 0;
    if (drag || press || !event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!canStart()) return;
    const origin = event.target instanceof Element ? event.target : null;
    if (!origin || origin.closest(".sidebar-action-menu, input, textarea, select, form, .workspace-collapse, .group-collapse, .split-disclosure, .is-editing")) return;
    const heading = origin.closest(".workspace-heading");
    const tabGroup = heading ? null : origin.closest(".tab-group");
    const item = heading ? heading.closest(".workspace-group") : tabGroup;
    if (!item || !list.contains(item) || !item.dataset.dropScope) return;
    press = {
      item, kind: heading ? "workspace" : "tab", grip: heading ?? tabGroup,
      pointerId: event.pointerId, touch: event.pointerType === "touch",
      x: event.clientX, y: event.clientY, timer: null,
    };
    if (press.touch) press.timer = setTimeout(() => { if (press) begin(null); }, longPressMs);
  });

  // On the window: a press that leaves the list still ends, and a held
  // redraw is never left waiting for a release the list did not see.
  window.addEventListener("pointermove", (event) => {
    if (drag) {
      if (event.pointerId === drag.pointerId) {
        event.preventDefault();
        follow(event.clientX, event.clientY);
      }
      return;
    }
    if (!press || event.pointerId !== press.pointerId) return;
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (press.touch) {
      if (distance > TOUCH_SLOP) clearPress(); // a scroll, not a hold
    } else if (distance > MOUSE_DRAG_SLOP) begin(event);
  });

  const release = (drop) => (event) => {
    if (drag && event.pointerId === drag.pointerId) finish(drop);
    else if (press && event.pointerId === press.pointerId) clearPress();
  };
  window.addEventListener("pointerup", release(true));
  window.addEventListener("pointercancel", release(false));
  list.addEventListener("lostpointercapture", (event) => {
    if (drag && event.pointerId === drag.pointerId) finish(false);
  });

  // Once a row is held, the finger moves it instead of scrolling the list.
  list.addEventListener("touchmove", (event) => {
    if (drag) event.preventDefault();
  }, { passive: false });
  // A held row is not text to select or a link to share.
  list.addEventListener("contextmenu", (event) => {
    if (drag || press?.touch) event.preventDefault();
  });
  // The click a drag ends with is not a selection.
  list.addEventListener("click", (event) => {
    if (now() < suppressClickUntil) {
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    if (drag && event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });

  return {
    isActive: () => drag !== null || press !== null,
    cancel: () => { clearPress(); finish(false); },
  };
}
