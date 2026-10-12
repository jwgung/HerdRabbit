// A finger selects terminal text by cells: these turn touch points into cells
// and two cells into the run xterm's select() takes.

// The cell under a point on the screen element, kept inside the grid.
export function cellAt({ left, top, width, height }, cols, rows, x, y) {
  const clamp = (value, max) => Math.min(max, Math.max(0, value));
  return {
    col: clamp(Math.floor(((x - left) * cols) / width), cols - 1),
    row: clamp(Math.floor(((y - top) * rows) / height), rows - 1),
  };
}

// Everything from the earlier cell to the later one, both included, read
// row by row the way the screen is.
export function selectionRun(anchor, point, cols) {
  const before = anchor.row < point.row || (anchor.row === point.row && anchor.col <= point.col);
  const [start, end] = before ? [anchor, point] : [point, anchor];
  return { col: start.col, row: start.row, length: (end.row - start.row) * cols + end.col - start.col + 1 };
}
