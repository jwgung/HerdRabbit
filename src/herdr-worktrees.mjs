// Git worktrees through Herdr (`herdr worktree list|create|open|remove`): what
// a request may name, and what is kept of Herdr's answers. Herdr 0.9.5 answers
// `worktree_list` ({ source, worktrees: WorktreeInfo[] }), `worktree_created`
// and `worktree_opened` ({ workspace, tab, root_pane, worktree }, the second
// with `already_open`), and `worktree_removed` ({ workspace_id, path, forced }).
// Everything here is plain checks and shapes; HerdrClient runs the commands.
import { isFolder } from "./project-folder.mjs";

// A request that names something Herdr would never take; the page is told
// what to fix (src/error-response.mjs: 400 invalid_input).
export class WorktreeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorktreeInputError";
  }
}

const MAX_REF_LENGTH = 200;
const WORKSPACE_ID = /^w[A-Za-z0-9]+(?![\s\S])/u;

// Herdr's refusals of a worktree request: the person's to fix (a folder that
// is not in Git, a dirty checkout, a branch already checked out), not a broken
// Herdr. They reach the page with their code, and through a link too.
export const WORKTREE_REFUSAL_CODES = new Set([
  "not_git_worktree", "linked_worktree_source", "not_linked_worktree", "worktree_not_found",
  "ambiguous_worktree_branch", "worktree_operation_in_progress", "dirty_worktree_requires_force",
  "worktree_create_failed", "worktree_open_failed", "worktree_remove_failed", "stale_worktree_operation",
]);

// A ref name's shape, as `git check-ref-format` takes it, narrowed: letters,
// digits and `._/-` only (no spaces, no `~^:?*[\@`), no part starting with a
// dot or ending in `.lock`, no `..` or `//`, not starting with `-` or `/` and
// not ending with `/` or `.`.
function isRefName(ref) {
  return /^[A-Za-z0-9._/-]+$/u.test(ref) && !/^[-/]/u.test(ref) && !/[/.]$/u.test(ref) &&
    !/\.\.|\/\/|(?:^|\/)\.|\.lock(?:\/|$)/u.test(ref);
}

const INVALID_REF = "Use letters, digits and . _ / - only, not starting with - or /.";

function refText(value, noun) {
  if (typeof value !== "string") throw new WorktreeInputError(`${noun} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new WorktreeInputError(`Enter a ${noun.toLowerCase()}.`);
  if (ref.length > MAX_REF_LENGTH) throw new WorktreeInputError(`${noun} must be at most ${MAX_REF_LENGTH} characters`);
  return ref;
}

// It goes to Herdr as one argument (`--branch`).
export function validateBranchName(value) {
  const branch = refText(value, "Branch name");
  if (!isRefName(branch) || branch === "HEAD") throw new WorktreeInputError(`That branch name is not one Git takes. ${INVALID_REF}`);
  return branch;
}

// What a new branch starts from (`--base`): a branch, tag or commit, which may
// step back with `~N` and `^N` (`HEAD~2`, `main^`).
export function validateBaseRef(value) {
  const base = refText(value, "Base");
  const named = base.replace(/(?:[~^][0-9]*)+$/u, "");
  if (!isRefName(named)) throw new WorktreeInputError(`That base is not a ref Git takes. ${INVALID_REF}`);
  return base;
}

// An existing checkout to open, named by its folder as Herdr's list does.
export function validateWorktreePath(value) {
  if (!isFolder(value)) throw new WorktreeInputError("Invalid worktree folder");
  return value;
}

export function validateForce(value) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new WorktreeInputError("Invalid force flag");
  return value;
}

export const worktreeText = (value) => (typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null);
const workspaceId = (value) => (typeof value === "string" && WORKSPACE_ID.test(value) ? value : null);

// One checkout of Herdr's list, or null for one without a folder. `idOf`
// keeps the workspace it is open in: Herdr's own id here, a scoped one over a link.
function worktreeEntry(item, idOf = workspaceId) {
  const path = worktreeText(item?.path);
  if (!path) return null;
  return {
    path,
    branch: worktreeText(item.branch),
    label: worktreeText(item.label),
    is_linked_worktree: item.is_linked_worktree === true,
    is_detached: item.is_detached === true,
    is_bare: item.is_bare === true,
    is_prunable: item.is_prunable === true,
    open_workspace_id: idOf(item.open_workspace_id),
  };
}

// The checkouts of a workspace's repository, as Herdr lists them: its primary
// checkout first, then each linked one. `source` names the repository.
export function worktreeList(result, { idOf = workspaceId } = {}) {
  const source = result?.source && typeof result.source === "object" ? result.source : {};
  return {
    source: { repo_name: worktreeText(source.repo_name), repo_root: worktreeText(source.repo_root) },
    worktrees: (Array.isArray(result?.worktrees) ? result.worktrees : []).map((item) => worktreeEntry(item, idOf)).filter(Boolean),
  };
}

// What a create or open made: the workspace's ids and the checkout, or null
// when the answer does not name all three ids.
export function worktreeOpened(result) {
  const ids = {
    workspace_id: workspaceId(result?.workspace?.workspace_id),
    tab_id: worktreeText(result?.tab?.tab_id),
    pane_id: worktreeText(result?.root_pane?.pane_id),
  };
  if (!ids.workspace_id || !ids.tab_id || !ids.pane_id) return null;
  const worktree = worktreeEntry(result.worktree);
  return { ...ids, path: worktree?.path ?? null, branch: worktree?.branch ?? null, already_open: result.already_open === true };
}

export function worktreeRemoved(result, asked) {
  return {
    workspace_id: workspaceId(result?.workspace_id) ?? asked,
    path: worktreeText(result?.path),
    forced: result?.forced === true,
  };
}
