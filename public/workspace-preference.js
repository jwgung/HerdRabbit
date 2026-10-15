export const COLLAPSED_WORKSPACES_STORAGE_KEY =
  "herdrbridge-collapsed-workspaces";

const WORKSPACE_ID_PATTERN = /^(?:link_[a-f0-9-]{36}!)?(?:hs_[A-Za-z0-9_-]+~)?w[A-Za-z0-9]+$/;
const MAX_STORED_WORKSPACES = 500;

function normalizedWorkspaceIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(
    (value) => typeof value === "string" && value.length <= 512 &&
      !/[\u0000-\u001f\u007f]/u.test(value) && WORKSPACE_ID_PATTERN.test(value),
  ))].slice(0, MAX_STORED_WORKSPACES);
}

export const COLLAPSED_GROUPS_STORAGE_KEY = "herdrbridge-collapsed-groups";

const MAX_STORED_GROUPS = 200;

// Server and Herdr-session headings collapse too. Their ids do not follow the
// workspace shape, so they are kept apart and validated only for length and
// control characters.
function normalizedGroupIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(
    (value) => typeof value === "string" && value !== "" && value.length <= 512 &&
      !/[\u0000-\u001f\u007f]/u.test(value),
  ))].slice(0, MAX_STORED_GROUPS);
}

export function readCollapsedGroupIds(storage) {
  try {
    const value = storage?.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
    return new Set(normalizedGroupIds(JSON.parse(value || "[]")));
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroupIds(storage, groupIds) {
  try {
    if (!storage) return false;
    storage.setItem(
      COLLAPSED_GROUPS_STORAGE_KEY,
      JSON.stringify(normalizedGroupIds([...groupIds])),
    );
    return true;
  } catch {
    return false;
  }
}

export function readCollapsedWorkspaceIds(storage) {
  try {
    const value = storage?.getItem(COLLAPSED_WORKSPACES_STORAGE_KEY);
    return new Set(normalizedWorkspaceIds(JSON.parse(value || "[]")));
  } catch {
    return new Set();
  }
}

export function writeCollapsedWorkspaceIds(storage, workspaceIds) {
  try {
    if (!storage) return false;
    storage.setItem(
      COLLAPSED_WORKSPACES_STORAGE_KEY,
      JSON.stringify(normalizedWorkspaceIds([...workspaceIds])),
    );
    return true;
  } catch {
    return false;
  }
}
