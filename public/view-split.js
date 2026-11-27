// This browser's own view splits: panes of different projects side by side,
// kept by the browser alone (several, each window showing one; see "Several
// view splits" below). Herdr never hears of them, other devices never see
// them, and nothing moves or closes: each is a layout over pane ids, nothing more.
//
// The layout is a tree. A leaf is a pane id; a node splits its box in two:
// { dir: "right" | "down", first, second, ratio }, `first` on the left (or the
// top) taking `ratio` of the box. A view split has 2 to MAX_TILES leaves; a
// tree of fewer is no view split at all (null).

import { laysOutPanes } from "./sidebar-drag.js?v=1.4.61";

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

// `tree` with the tiles of panes `a` and `b` trading places. Unchanged when
// either is not a tile, or they are the same.
export function swapTiles(tree, a, b) {
  const present = tiles(tree);
  if (a === b || !present.includes(a) || !present.includes(b)) return tree;
  const swap = (node) => (isLeaf(node) ? (node === a ? b : node === b ? a : node)
    : { ...node, first: swap(node.first), second: swap(node.second) });
  return swap(tree);
}

// `tree` with `paneId`'s tile taken out and put next to `targetPaneId`'s on
// `side` (left, right, up or down), taking half of it. Unchanged when either
// is not a tile, they are the same, or the side is not one.
export function moveTile(tree, paneId, targetPaneId, side) {
  const present = tiles(tree);
  if (!SIDES.includes(side) || paneId === targetPaneId || !present.includes(paneId) || !present.includes(targetPaneId)) return tree;
  const rest = without(tree, (leaf) => leaf === paneId);
  const next = addTile(isLeaf(rest) ? null : rest, targetPaneId, paneId, side);
  return tiles(next).length === present.length ? next : tree;
}

// How many tiles side by side `node` makes along `dir`: a node split the same
// way counts each of its parts, anything else (a tile, or a split the other
// way) is one.
const partsAlong = (node, dir) => (!isLeaf(node) && node.dir === dir
  ? partsAlong(node.first, dir) + partsAlong(node.second, dir) : 1);

// `tree` with every row (or column) of tiles sharing its box evenly, as
// Herdr's Even out layout does for a tab: nodes split the same way in a row
// are read as one row (a | (b | c) is three columns of a third each), a split
// the other way inside it as one of its parts, evened inside its own box. The
// tiles stay where they are. The same tree when it is already even.
export function evenTree(tree) {
  if (tree == null || isLeaf(tree)) return tree;
  const first = evenTree(tree.first);
  const second = evenTree(tree.second);
  const before = partsAlong(tree.first, tree.dir);
  const ratio = before / (before + partsAlong(tree.second, tree.dir));
  if (first === tree.first && second === tree.second && Math.abs(ratio - tree.ratio) < 1e-9) return tree;
  return { ...tree, first, second, ratio };
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

// The one view split an earlier HerdRabbit kept per window, in session
// storage: { tree, shown, focus }. Read into the list by loadViewSplits,
// which takes the old entry away once it has a number there.
function readLegacyViewSplit(storage) {
  try {
    const raw = storage?.getItem(VIEW_SPLIT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const tree = parseTree(value?.tree);
    if (!tree) storage.removeItem(VIEW_SPLIT_STORAGE_KEY);
    return tree ? { tree, shown: value?.shown !== false, focus: value?.focus } : null;
  } catch {
    return null;
  }
}

// --- Several view splits --------------------------------------------------
// The browser keeps a list of view splits, each with a number from 1 to
// MAX_SPLITS that it keeps for as long as it lasts: { id, tree, focus }, in
// order of number. The list is in local storage, so every window of this
// browser has it and it outlasts them; which split a window shows, and
// whether it is on screen, is that window's own, in its session storage.
// A pane is a tile of one split at most: put in one, it leaves any other.

export const MAX_SPLITS = 8;
export const VIEW_SPLITS_STORAGE_KEY = "herdrbridge-view-splits";
export const OPEN_SPLIT_STORAGE_KEY = "herdrbridge-view-split-open";
// The marks in the sidebar have four colours; 5 to 8 have them again.
const SPLIT_HUES = 4;

const validSplitId = (id) => Number.isInteger(id) && id >= 1 && id <= MAX_SPLITS;
const focusIn = (tree, focus) => (tiles(tree).includes(focus) ? focus : tiles(tree)[0] ?? null);
const byId = (a, b) => a.id - b.id;

// Which of the four colours split `id` wears.
export function splitHue(id) {
  return (id - 1) % SPLIT_HUES;
}

// The lowest number no split has; null when all are used.
export function nextSplitId(list) {
  const used = new Set(list.map((split) => split.id));
  for (let id = 1; id <= MAX_SPLITS; id += 1) if (!used.has(id)) return id;
  return null;
}

// The split `paneId` is a tile of, or null.
export function splitWithPane(list, paneId) {
  return list.find((split) => tiles(split.tree).includes(paneId)) ?? null;
}

// `list` with split `id` set to `tree` (a picker in it is not kept). The
// split is taken out when `tree` is null or only a picker beside one pane.
// Its panes leave every other split, and one left with a single tile is gone.
export function putSplit(list, id, tree, focus) {
  if (!validSplitId(id)) return list;
  const kept = tiles(tree).includes(PICK_TILE) ? removeTile(tree, PICK_TILE) : settled(tree);
  const taken = new Set(tiles(kept));
  const others = list.flatMap((split) => {
    if (split.id === id) return [];
    if (!tiles(split.tree).some((leaf) => taken.has(leaf))) return [split];
    const rest = settled(without(split.tree, (leaf) => taken.has(leaf)));
    if (rest == null) return [];
    return [{ ...split, tree: rest, focus: focusIn(rest, split.focus) }];
  });
  if (kept == null) return others;
  return [...others, { id, tree: kept, focus: focusIn(kept, focus) }].sort(byId);
}

// `list` without the tiles `keep` says no to; a split left with one is gone.
// The same list when nothing went.
export function pruneSplits(list, keep) {
  let changed = false;
  const next = list.flatMap((split) => {
    if (tiles(split.tree).every(keep)) return [split];
    changed = true;
    const tree = settled(without(split.tree, (leaf) => !keep(leaf)));
    return tree ? [{ ...split, tree, focus: focusIn(tree, split.focus) }] : [];
  });
  return changed ? next : list;
}

// Every split's tiles (and focus) follow panes Herdr carried under new ids.
export function renameSplits(list, moves) {
  if (!Array.isArray(moves) || moves.length === 0) return list;
  const to = new Map(moves.filter((move) => typeof move?.to === "string").map((move) => [move.from, move.to]));
  return list.flatMap((split) => {
    const tree = renameTiles(split.tree, moves);
    if (tree == null) return [];
    return [{ ...split, tree, focus: focusIn(tree, to.get(split.focus) ?? split.focus) }];
  });
}

// The list read back: numbers in range and once each (the first kept), trees
// well formed, a pane in one split only (the first keeps it).
export function parseSplits(value) {
  if (!Array.isArray(value?.splits)) return [];
  const list = [];
  const seen = new Set();
  for (const item of value.splits) {
    const tree = parseTree(item?.tree);
    if (!validSplitId(item?.id) || !tree || list.some((split) => split.id === item.id)) continue;
    if (tiles(tree).some((paneId) => seen.has(paneId))) continue;
    for (const paneId of tiles(tree)) seen.add(paneId);
    list.push({ id: item.id, tree, focus: focusIn(tree, item.focus) });
  }
  return list.sort(byId);
}

export function readViewSplits(storage) {
  try {
    const raw = storage?.getItem(VIEW_SPLITS_STORAGE_KEY);
    return raw ? parseSplits(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeViewSplits(storage, list) {
  try {
    if (list.length === 0) storage?.removeItem(VIEW_SPLITS_STORAGE_KEY);
    else storage?.setItem(VIEW_SPLITS_STORAGE_KEY, JSON.stringify({ splits: list }));
  } catch { /* Storage may be full or blocked: the splits last until the page goes. */ }
}

// Which split this window shows (`id`) and whether it is on screen (false
// while a pane is open alone, with Back to split view).
export function writeOpenSplit(storage, { id, tree, shown }) {
  try {
    if (!validSplitId(id) || !tree) storage?.removeItem(OPEN_SPLIT_STORAGE_KEY);
    else storage?.setItem(OPEN_SPLIT_STORAGE_KEY, JSON.stringify({ id, shown: Boolean(shown) }));
  } catch { /* as above */ }
}

function readOpenSplit(storage) {
  try {
    const value = JSON.parse(storage?.getItem(OPEN_SPLIT_STORAGE_KEY) ?? "null");
    return validSplitId(value?.id) ? { id: value.id, shown: value.shown !== false } : null;
  } catch {
    return null;
  }
}

// The browser's splits (`local`) and the one this window shows (`session`),
// as { splits, open: { id, tree, shown, focus } }. The view split an earlier
// version kept for this window joins the list, under the lowest number free;
// with all MAX_SPLITS kept it waits in session storage for one to close.
export function loadViewSplits(local, session) {
  let splits = readViewSplits(local);
  let open = readOpenSplit(session);
  const legacy = readLegacyViewSplit(session);
  const legacyId = legacy ? nextSplitId(splits) : null;
  if (legacyId) {
    splits = putSplit(splits, legacyId, legacy.tree, legacy.focus);
    writeViewSplits(local, splits);
    try { session.removeItem(VIEW_SPLIT_STORAGE_KEY); } catch { /* read again next load: its panes then leave this copy */ }
    open = { id: legacyId, shown: legacy.shown };
  }
  const split = open ? splits.find((item) => item.id === open.id) : null;
  const shown = split ? { id: split.id, tree: split.tree, shown: open.shown, focus: split.focus }
    : { id: null, tree: null, shown: false, focus: null };
  writeOpenSplit(session, shown);
  return { splits, open: shown };
}

const idOf = (record, key) => (typeof record?.[key] === "string" ? record[key] : null);

// The tile a drop of a tab on its own pane opens: it holds the "What goes
// here?" picker until a pane fills it or the split is cancelled. It is a leaf
// like any other for the layout; it is never a pane, so it is never kept.
export const PICK_TILE = "herdrabbit:pick";

// `tree` with the picker's tile (if any) filled by `paneId`. Unchanged when
// there is no picker tile or the pane is a tile already.
export function fillPick(tree, paneId) {
  const present = tiles(tree);
  if (!present.includes(PICK_TILE) || typeof paneId !== "string" || !paneId || present.includes(paneId)) return tree;
  const fill = (node) => (isLeaf(node) ? (node === PICK_TILE ? paneId : node)
    : { ...node, first: fill(node.first), second: fill(node.second) });
  return fill(tree);
}

// `tree` with a picker tile on `side` of `targetPaneId` (the pane alone when
// there is no tree), evened. One picker at a time: an earlier one goes first.
export function addPickTile(tree, targetPaneId, side) {
  const base = tiles(tree).includes(PICK_TILE) ? removeTile(tree, PICK_TILE) : tree;
  const next = addTile(base, targetPaneId, PICK_TILE, side);
  return next === base ? tree : evenTree(next);
}

// What a session `tabId` dropped on `targetPaneId` does, given what the screen
// shows: `screen` is "solo" (one pane alone), "grid" (a Herdr split tab as a
// grid) or "tiles" (this window's view split, whose tiles are `tileIds`).
// Answers "view" (a new tile of this window's view split beside the target),
// "self" (the tab's own pane: split there, with a picker in the new half) or
// null (no drop). Never Herdr's own merge: a drop changes this window alone,
// whatever workspace or machine either pane is of, and "Apply to Herdr"
// (applyToHerdrPlan) is how a view split becomes a Herdr tab. Only a session
// of one pane is dropped; one already a tile is not added twice.
export function paneDropKind(snapshot, { tabId, targetPaneId }, { screen, tileIds = [] }) {
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  const moving = panes.filter((item) => idOf(item, "tab_id") === tabId);
  const target = panes.find((item) => idOf(item, "pane_id") === targetPaneId);
  if (moving.length !== 1 || !target || !tabs.some((item) => idOf(item, "tab_id") === tabId)) return null;
  const paneId = idOf(moving[0], "pane_id");
  const onTiles = screen === "tiles";
  if (onTiles && !tileIds.includes(targetPaneId)) return null;
  // The picker tile is one of the tiles: a full view has no room for it either.
  const count = onTiles ? tileIds.filter((id) => id !== PICK_TILE).length : 1;
  if (count >= MAX_TILES) return null;
  if (paneId === targetPaneId) return screen === "grid" ? null : "self";
  if (onTiles && tileIds.includes(paneId)) return null;
  return "view";
}

const machineOf = (record) => record?.server_id ?? "local";

// What "Apply to Herdr" does with `tree`, or null when it may not: every tile
// a pane of one workspace of one Herdr session on one machine that lays out
// its panes from here (laysOutPanes), each alone in its own tab, and no
// picker waiting. Herdr then makes them one split tab: the first tile stays
// where it is (`anchor`) and each `move` carries one other tile's pane next
// to a pane already there ({ paneId, targetPaneId, side }), in order. Herdr
// splits one pane in two, so the tree is rebuilt from its root down: a node's
// second part goes to the right of (or under) the first tile of its first
// part, which stands for that whole part until it is split in turn. Herdr
// gives each moved pane a new id; the moves name the old ones.
export function applyToHerdrPlan(snapshot, tree) {
  const ids = tiles(tree);
  if (ids.length < 2 || ids.includes(PICK_TILE)) return null;
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  const records = ids.map((paneId) => panes.find((item) => idOf(item, "pane_id") === paneId));
  if (records.some((pane) => !pane)) return null;
  const tabOf = records.map((pane) => tabs.find((item) => idOf(item, "tab_id") === idOf(pane, "tab_id")));
  if (tabOf.some((tab) => !tab)) return null;
  if (tabOf.some((tab) => panes.filter((item) => idOf(item, "tab_id") === idOf(tab, "tab_id")).length !== 1)) return null;
  const one = (values) => new Set(values).size === 1;
  if (!one(tabOf.map((tab) => idOf(tab, "workspace_id"))) ||
      !one(tabOf.map((tab) => tab.herdr_session_id ?? null)) ||
      !one([...tabOf, ...records].map(machineOf)) ||
      !laysOutPanes(snapshot, tabOf[0])) return null;
  const moves = [];
  const build = (node) => {
    if (isLeaf(node)) return;
    const targetPaneId = tiles(node.first)[0];
    moves.push({ paneId: tiles(node.second)[0], targetPaneId, side: node.dir });
    build(node.first);
    build(node.second);
  };
  build(tree);
  return { anchor: ids[0], moves };
}

// The tabs the picker offers for its tile, grouped the way the user thinks
// of them: `here` (the workspace of `anchorPaneId`, the pane the tile was
// split from), `workspaces` (the other workspaces of its machine) and
// `machines` (every other machine's). Each is { tabId, paneId, paneCount }:
// a split tab offers one of its panes (`preferredPane(tabId, paneIds)`, else
// its first) that is not a tile yet; a tab whose panes all are is left out.
export function pickChoices(snapshot, { anchorPaneId, tileIds = [], preferredPane = () => null }) {
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  const anchor = panes.find((item) => idOf(item, "pane_id") === anchorPaneId);
  const anchorTab = tabs.find((item) => idOf(item, "tab_id") === idOf(anchor, "tab_id"));
  const groups = { here: [], workspaces: [], machines: [] };
  for (const tab of tabs) {
    const tabId = idOf(tab, "tab_id");
    const paneIds = panes.filter((item) => idOf(item, "tab_id") === tabId).map((item) => idOf(item, "pane_id"));
    const free = paneIds.filter((id) => id && !tileIds.includes(id));
    if (free.length === 0) continue;
    const preferred = preferredPane(tabId, paneIds);
    const paneId = free.includes(preferred) ? preferred : free[0];
    const choice = { tabId, paneId, paneCount: paneIds.length };
    if (anchorTab && machineOf(tab) !== machineOf(anchorTab)) groups.machines.push(choice);
    else if (anchorTab && idOf(tab, "workspace_id") === idOf(anchorTab, "workspace_id") &&
      (tab.herdr_session_id ?? null) === (anchorTab.herdr_session_id ?? null)) groups.here.push(choice);
    else groups.workspaces.push(choice);
  }
  return groups;
}

// Whether HerdRabbit evens out a Herdr split tab after changing it itself:
// after a split, a close, a pane moved out or a view split applied. Never
// after Herdr's own resize, which the user made, nor after a cell dragged
// somewhere else in the grid, which keeps the sizes the user chose.
export const HERDR_EVENED_AFTER = new Set(["split", "close", "move-out", "apply"]);
export function evensHerdrTabAfter(action, panesLeft) {
  return HERDR_EVENED_AFTER.has(action) && panesLeft >= 2;
}
