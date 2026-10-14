// A pane carried to another project comes back under a new id; what the page
// keeps by pane id follows it. `moves` is the server's [{ from, to }] list.

// The {from, to} pairs of a move that really change an id, as a Map from -> to.
export function paneRenames(moves) {
  const renames = new Map();
  for (const move of Array.isArray(moves) ? moves : []) {
    if (typeof move?.from === "string" && typeof move?.to === "string" && move.from && move.from !== move.to) {
      renames.set(move.from, move.to);
    }
  }
  return renames;
}

// A Map keyed by pane id with the moved panes under their new ids (all renames
// at once, so a swap is safe). A renamed entry replaces any under its new id.
export function renamePaneKeys(map, moves) {
  const renames = paneRenames(moves);
  if (renames.size === 0) return map;
  const result = new Map();
  const moved = [];
  for (const [key, value] of map) {
    if (renames.has(key)) moved.push([renames.get(key), value]);
    else result.set(key, value);
  }
  for (const [key, value] of moved) {
    result.delete(key);
    result.set(key, value);
  }
  return result;
}
