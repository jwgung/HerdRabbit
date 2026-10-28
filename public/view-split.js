// This window's own view split: panes of different projects side by side,
// kept by the browser alone. Herdr never hears of it, other devices never see
// it, and nothing moves or closes: it is a layout over pane ids, nothing more.
//
// The layout is a tree. A leaf is a pane id; a node splits its box in two:
// { dir: "right" | "down", first, second, ratio }, `first` on the left (or the
// top) taking `ratio` of the box. A view split has 2 to MAX_TILES leaves; a
// tree of fewer is no view split at all (null).

export const MAX_TILES = 6;
export const VIEW_SPLIT_STORAGE_KEY = "herdrbridge-view-split";

// The cell space layoutRects lays the tiles out in, as Herdr's own layout
// gives each pane a rect in terminal cells. Large enough that six tiles each
// have room for a terminal.
export const VIEW_AREA = { x: 0, y: 0, width: 240, height: 80 };

const DIRS = ["right", "down"];
const SIDES = ["left", "right", "up", "down"];

const isLeaf = (tree) => typeof tree === "string";

// The pane ids of `tree`, left to right and top to bottom.
export function tiles(tree) {
  if (tree == null) return [];
  if (isLeaf(tree)) return [tree];
  return [...tiles(tree.first), ...tiles(tree.second)];
}

// A view split of fewer than two tiles is none.
const settled = (tree) => (tiles(tree).length >= 2 ? tree : null);

// `tree` with `targetPaneId`'s tile split on `side` (left, right, up or down,
// as a drop on that edge of it) and `newPaneId` in the new half. With no
// tree, the target is the only tile so far (the pane shown alone). Unchanged
// when the new pane is a tile already, the target is not one, or it is full.
export function addTile(tree, targetPaneId, newPaneId, side) {
  const base = tree ?? targetPaneId;
  if (!SIDES.includes(side) || typeof newPaneId !== "string" || !newPaneId ||
      typeof targetPaneId !== "string" || newPaneId === targetPaneId) return tree;
  const present = tiles(base);
  if (!present.includes(targetPaneId) || present.includes(newPaneId) || present.length >= MAX_TILES) return tree;
  const dir = side === "left" || side === "right" ? "right" : "down";
  const before = side === "left" || side === "up";
  const replace = (node) => {
    if (isLeaf(node)) {
      if (node !== targetPaneId) return node;
      return { dir, first: before ? newPaneId : node, second: before ? node : newPaneId, ratio: 0.5 };
    }
    return { ...node, first: replace(node.first), second: replace(node.second) };
  };
  return replace(base);
}

// `tree` without the tiles `drop` says no to; a node left with one side
// becomes that side.
function without(tree, drop) {
  if (tree == null) return null;
  if (isLeaf(tree)) return drop(tree) ? null : tree;
  const first = without(tree.first, drop);
  const second = without(tree.second, drop);
  if (first == null) return second;
  if (second == null) return first;
  return { ...tree, first, second };
}

// `tree` without `paneId`'s tile; null when fewer than two are left.
export function removeTile(tree, paneId) {
  return settled(without(tree, (leaf) => leaf === paneId));
}

// `tree` without the tiles whose panes no longer exist (`paneIds`: those that
// do); null when fewer than two are left.
export function prune(tree, paneIds) {
  const existing = new Set(paneIds);
  return settled(without(tree, (leaf) => !existing.has(leaf)));
}

// A pane carried to another tab by Herdr comes back under a new id: its tile
// follows it. `moves` is [{ from, to }].
export function renameTiles(tree, moves) {
  if (tree == null || !Array.isArray(moves) || moves.length === 0) return tree;
  const to = new Map(moves.filter((move) => typeof move?.to === "string").map((move) => [move.from, move.to]));
  const rename = (node) => (isLeaf(node) ? to.get(node) ?? node
    : { ...node, first: rename(node.first), second: rename(node.second) });
  // Should a new id already be a tile, the later of the two goes.
  const seen = new Set();
  return settled(without(rename(tree), (leaf) => {
    if (seen.has(leaf)) return true;
    seen.add(leaf);
    return false;
  }));
}

// Each tile's rect in VIEW_AREA, as Herdr's `pane layout` answers for a tab:
// { area, panes: [{ pane_id, rect: { x, y, width, height } }] }, whole cells
// that cover the area exactly. null for no view split.
export function layoutRects(tree, area = VIEW_AREA) {
  if (settled(tree) == null) return null;
  const panes = [];
  const place = (node, rect) => {
    if (isLeaf(node)) {
      panes.push({ pane_id: node, rect });
      return;
    }
    const across = node.dir === "right";
    const size = across ? rect.width : rect.height;
    const firstSize = Math.max(1, Math.min(size - 1, Math.round(size * node.ratio)));
    if (across) {
      place(node.first, { x: rect.x, y: rect.y, width: firstSize, height: rect.height });
      place(node.second, { x: rect.x + firstSize, y: rect.y, width: rect.width - firstSize, height: rect.height });
    } else {
      place(node.first, { x: rect.x, y: rect.y, width: rect.width, height: firstSize });
      place(node.second, { x: rect.x, y: rect.y + firstSize, width: rect.width, height: rect.height - firstSize });
    }
  };
  place(tree, { x: area.x, y: area.y, width: area.width, height: area.height });
  return { area: { ...area }, panes };
}

// A tree read back from storage, or null when it is not one: every node a
// known direction with a sane ratio, every leaf a pane id, none twice, no more
// than MAX_TILES.
export function parseTree(value, depth = 0) {
  const check = (node, level) => {
    if (level > MAX_TILES) return null;
    if (typeof node === "string") return node ? node : null;
    if (!node || typeof node !== "object" || !DIRS.includes(node.dir)) return null;
    const first = check(node.first, level + 1);
    const second = check(node.second, level + 1);
    if (first == null || second == null) return null;
    const ratio = Number.isFinite(node.ratio) && node.ratio > 0.05 && node.ratio < 0.95 ? node.ratio : 0.5;
    return { dir: node.dir, first, second, ratio };
  };
  const tree = check(value, depth);
  const ids = tiles(tree);
  if (ids.length < 2 || ids.length > MAX_TILES || new Set(ids).size !== ids.length) return null;
  return tree;
}

// What this window keeps of its view split: the tree, whether it is on screen
// (false while a pane is open alone, with a way back to it), and the tile last
// focused (a tile of the tree, else its first).
export function readViewSplit(storage) {
  const none = { tree: null, shown: false, focus: null };
  try {
    const raw = storage?.getItem(VIEW_SPLIT_STORAGE_KEY);
    if (!raw) return none;
    const value = JSON.parse(raw);
    const tree = parseTree(value?.tree);
    if (!tree) return none;
    const focus = tiles(tree).includes(value?.focus) ? value.focus : tiles(tree)[0];
    return { tree, shown: value?.shown !== false, focus };
  } catch {
    return none;
  }
}

export function writeViewSplit(storage, { tree, shown, focus = null }) {
  try {
    if (!tree) storage?.removeItem(VIEW_SPLIT_STORAGE_KEY);
    else storage?.setItem(VIEW_SPLIT_STORAGE_KEY, JSON.stringify({ tree, shown: Boolean(shown), focus }));
  } catch { /* Storage may be full or blocked: the view split lasts until the page goes. */ }
}

const idOf = (record, key) => (typeof record?.[key] === "string" ? record[key] : null);

// What a session `tabId` dropped on `targetPaneId` does, given what the screen
// shows: `screen` is "solo" (one pane alone), "grid" (a Herdr split tab as a
// grid) or "tiles" (this window's view split, whose panes are `tileIds`).
// Answers "move" (Herdr's own merge into the target's tab: same project),
// "view" (a tile of this window's view split: another project, or anything
// dropped on a view split) or null (no drop). Only a session of one pane of
// this machine is dropped, never on its own pane, and only on this machine's
// panes; `paneMoveAllowed` says whether Herdr may merge the two.
export function paneDropKind(snapshot, { tabId, targetPaneId }, { screen, tileIds = [], paneMoveAllowed = () => false }) {
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  const moving = panes.filter((item) => idOf(item, "tab_id") === tabId);
  const target = panes.find((item) => idOf(item, "pane_id") === targetPaneId);
  if (moving.length !== 1 || !target || idOf(target, "tab_id") === tabId) return null;
  const local = (record) => (record?.server_id ?? "local") === "local";
  const tab = tabs.find((item) => idOf(item, "tab_id") === tabId);
  const targetTab = tabs.find((item) => idOf(item, "tab_id") === idOf(target, "tab_id"));
  if (!tab || !targetTab || !local(tab) || !local(targetTab) || !local(moving[0]) || !local(target)) return null;
  const paneId = idOf(moving[0], "pane_id");
  if (screen === "tiles") {
    if (!tileIds.includes(targetPaneId) || tileIds.includes(paneId) || tileIds.length >= MAX_TILES) return null;
    return "view";
  }
  const sameProject = idOf(tab, "workspace_id") === idOf(targetTab, "workspace_id") &&
    (tab.herdr_session_id ?? null) === (targetTab.herdr_session_id ?? null);
  if (sameProject) return paneMoveAllowed() ? "move" : null;
  return screen === "solo" ? "view" : null;
}
