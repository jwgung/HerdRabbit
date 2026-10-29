export const TERMINAL_FONT_SIZE_STORAGE_KEY =
  "herdrbridge-terminal-font-size";
export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 18;

function normalizedFontSize(value) {
  const size = Number(value);
  if (!Number.isInteger(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, size));
}

export function readTerminalFontSize(storage) {
  try {
    const stored = storage?.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
    return stored === null
      ? DEFAULT_TERMINAL_FONT_SIZE
      : normalizedFontSize(stored);
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

export function writeTerminalFontSize(storage, fontSize) {
  try {
    if (!storage) return false;
    storage.setItem(
      TERMINAL_FONT_SIZE_STORAGE_KEY,
      String(normalizedFontSize(fontSize)),
    );
    return true;
  } catch {
    return false;
  }
}

export function adjustedTerminalFontSize(fontSize, direction) {
  const current = normalizedFontSize(fontSize);
  if (direction === "smaller") {
    return Math.max(MIN_TERMINAL_FONT_SIZE, current - 1);
  }
  if (direction === "larger") {
    return Math.min(MAX_TERMINAL_FONT_SIZE, current + 1);
  }
  return current;
}

// The text size of a Herdr grid, chosen by the user (null: the grid picks the
// largest that fits its stage). Kept apart from the size of a single pane, in
// the same storage, in the half steps the grid's fonts go in.
export const GRID_FONT_STORAGE_KEY = "herdrbridge-grid-font";
export const MIN_GRID_FONT = 4;
export const MAX_GRID_FONT = 32;

export function normalizedGridFont(value) {
  if (value === null || value === undefined || value === "") return null;
  const size = Number(value);
  if (!Number.isFinite(size)) return null;
  return Math.min(MAX_GRID_FONT, Math.max(MIN_GRID_FONT, Math.round(size * 2) / 2));
}

export function readGridFont(storage) {
  try {
    return normalizedGridFont(storage?.getItem(GRID_FONT_STORAGE_KEY));
  } catch {
    return null;
  }
}

// `fontSize` null puts the grid back to picking its own.
export function writeGridFont(storage, fontSize) {
  try {
    if (!storage) return false;
    const size = normalizedGridFont(fontSize);
    if (size === null) storage.removeItem(GRID_FONT_STORAGE_KEY);
    else storage.setItem(GRID_FONT_STORAGE_KEY, String(size));
    return true;
  } catch {
    return false;
  }
}

// One step from the font the grid has now (a half step stays one), the same
// step a single pane's text size takes.
export function adjustedGridFont(fontSize, direction) {
  const current = normalizedGridFont(fontSize);
  if (current === null) return null;
  if (direction === "smaller") return normalizedGridFont(current - 1);
  if (direction === "larger") return normalizedGridFont(current + 1);
  return current;
}

// Whether a Herdr grid's cells size their panes to themselves, as Herdr sizes
// them to its own window (on, the default), or keep the size Herdr gave them
// and scale their text to fit (off). Kept in the same storage.
export const GRID_FIT_STORAGE_KEY = "herdrbridge-grid-fit";

export function readGridFit(storage) {
  try {
    return storage?.getItem(GRID_FIT_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeGridFit(storage, fit) {
  try {
    if (!storage) return false;
    storage.setItem(GRID_FIT_STORAGE_KEY, fit ? "on" : "off");
    return true;
  } catch {
    return false;
  }
}
