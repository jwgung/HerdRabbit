import { isTerminalKey, TERMINAL_KEYS } from "../public/key-combinations.js";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import { subscribeHerdrStatuses } from "./herdr-status-stream.mjs";
import { callHerdrSocket } from "./herdr-rpc.mjs";
import { claudeInputBox, restoredDraftStep } from "./prompt/claude-input.mjs";

const execFileAsync = promisify(execFile);
// Herdr IDs may contain letters (for example wB:p1). Require the exact end
// of the input, including rejecting a trailing newline.
const PANE_ID_PATTERN = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+(?![\s\S])/;
const WORKSPACE_ID_PATTERN = /^w[A-Za-z0-9]+(?![\s\S])/;
const TAB_ID_PATTERN = /^w[A-Za-z0-9]+:t[A-Za-z0-9]+(?![\s\S])/;
const MAX_TEXT_LENGTH = 8_000;
const MAX_WORKSPACE_LABEL_LENGTH = 120;
const MAX_HERDR_SESSION_NAME_LENGTH = 240;
export const MAX_PANE_READ_LINES = 100_001;
// More projects or sessions than anyone keeps open; Herdr refuses an index
// past its own list anyway.
const MAX_INSERT_INDEX = 10_000;

export const ALLOWED_KEYS = Object.freeze([...TERMINAL_KEYS, "ctrl+c", "shift+tab"]);

export class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputValidationError";
  }
}

export class HerdrCommandError extends Error {
  constructor(message, { code = "herdr_command_failed", cause } = {}) {
    super(message, { cause });
    this.name = "HerdrCommandError";
    this.code = code;
  }
}

function validatePaneId(paneId) {
  if (typeof paneId !== "string" || !PANE_ID_PATTERN.test(paneId)) {
    throw new InputValidationError("Invalid pane id");
  }

  return paneId;
}

function validateHerdrSessionName(sessionName) {
  if (
    typeof sessionName !== "string" ||
    sessionName.length === 0 ||
    Buffer.byteLength(sessionName, "utf8") > MAX_HERDR_SESSION_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(sessionName)
  ) {
    throw new InputValidationError("Invalid Herdr session name");
  }
  return sessionName;
}

function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new InputValidationError("Invalid workspace id");
  }
  return workspaceId;
}

function validateTabId(tabId) {
  if (typeof tabId !== "string" || !TAB_ID_PATTERN.test(tabId)) {
    throw new InputValidationError("Invalid tab id");
  }
  return tabId;
}

// Projects and sessions are both named by the same hand, in the same sidebar,
// so they get the same rules; only the word in the message differs.
function validateLabel(label, noun) {
  if (typeof label !== "string") {
    throw new InputValidationError(`${noun} name must be text`);
  }
  const value = label.trim();
  if (value.length === 0) {
    throw new InputValidationError(`${noun} name must not be empty`);
  }
  if (value.length > MAX_WORKSPACE_LABEL_LENGTH) {
    throw new InputValidationError(
      `${noun} name must be at most ${MAX_WORKSPACE_LABEL_LENGTH} characters`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new InputValidationError(`${noun} name must not contain control characters`);
  }
  return value;
}

function validateWorkspaceLabel(label) {
  return validateLabel(label, "Workspace");
}

function validateTabLabel(label) {
  return validateLabel(label, "Session");
}

function validateInsertIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INSERT_INDEX) {
    throw new InputValidationError("Invalid position");
  }
  return index;
}

// Find in a pane's whole history (herdr's copy-mode search, without entering
// copy mode). Adapted from herdr-web-ui (MIT), server/herdr/client.ts paneFind
// and the /api/pane/find checks in server/index.ts.
// Same limit as public/terminal-find.js and the find input's maxlength.
export const MAX_FIND_QUERY_LENGTH = 256;
const MAX_HISTORY_ROW = 0xffff_ffff;
const MAX_HISTORY_COL = 0xffff;
// Herdr answers with at most 1024 matches around the current one.
const MAX_FIND_MATCHES = 1024;

function isCount(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function validTextPoint(point) {
  return point !== null && typeof point === "object" &&
    isCount(point.row, MAX_HISTORY_ROW) && isCount(point.col, MAX_HISTORY_COL);
}

// What a herdr terminal id may look like before it goes into an argument list.
export const TERMINAL_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u;

function textRange(range) {
  if (range === null || typeof range !== "object" || !validTextPoint(range.start) || !validTextPoint(range.end)) return null;
  return { start: { row: range.start.row, col: range.start.col }, end: { row: range.end.row, col: range.end.col } };
}

// What a find asks for: literal text (herdr matches it case-insensitively
// unless it holds a capital), which way from where the view is, and the match
// found last with the history revision it was found in, to step past it.
export function validateFindRequest({ query, direction, previous, contentRevision } = {}) {
  if (typeof query !== "string" || query.length === 0) {
    throw new InputValidationError("Search text must not be empty");
  }
  if (query.length > MAX_FIND_QUERY_LENGTH) {
    throw new InputValidationError(`Search text must be at most ${MAX_FIND_QUERY_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(query)) {
    throw new InputValidationError("Search text must not contain control characters");
  }
  if (direction !== "forward" && direction !== "backward") {
    throw new InputValidationError("Direction must be forward or backward");
  }
  if (previous === undefined || previous === null) {
    if (contentRevision !== undefined && contentRevision !== null) {
      throw new InputValidationError("A revision comes with the previous match");
    }
    return { query, direction, previous: null, contentRevision: null };
  }
  const range = textRange(previous);
  if (!range || !isCount(contentRevision)) {
    throw new InputValidationError("The previous match needs two history cells and its revision");
  }
  return { query, direction, previous: range, contentRevision };
}

// What a reveal asks for: a match a find gave, and the revision it was found in.
export function validateRevealRequest({ match, contentRevision, coverRows = DEFAULT_COVER_ROWS } = {}) {
  const range = textRange(match);
  if (!range || !isCount(contentRevision)) {
    throw new InputValidationError("The match needs two history cells and its revision");
  }
  if (!Number.isSafeInteger(coverRows) || coverRows < 0 || coverRows > MAX_COVER_ROWS) {
    throw new InputValidationError(`coverRows must be a whole number from 0 to ${MAX_COVER_ROWS}`);
  }
  return { match: range, contentRevision, coverRows };
}

function scrollInfo(value) {
  if (value === null || typeof value !== "object") return null;
  const { offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: rows } = value;
  if (!isCount(offset) || !isCount(max) || !isCount(rows)) return null;
  return { offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: rows };
}

// The page's find bar lies over the view's top rows: a match there is not
// seen. The page measures how many and says so; this is for a page that
// does not.
const DEFAULT_COVER_ROWS = 3;
const MAX_COVER_ROWS = 20;

// Where to scroll so `match` shows: nowhere when it is on screen already,
// clear of the find bar, otherwise with it a third of the way down, some lines
// above it for context. History rows count from the top; the view is counted
// from the bottom.
export function findScrollOffset(scroll, match, coverRows = DEFAULT_COVER_ROWS) {
  const max = scroll.max_offset_from_bottom;
  const rows = Math.max(1, scroll.viewport_rows);
  const top = max - scroll.offset_from_bottom;
  const clear = Math.min(coverRows, rows - 1);
  if (match.start.row >= top + clear && match.end.row < top + rows) return scroll.offset_from_bottom;
  const wantedTop = Math.min(max, Math.max(0, match.start.row - Math.floor(rows / 3)));
  return max - wantedTop;
}

function staleContent(cause) {
  return new HerdrCommandError("The terminal changed while searching. Search again.", { code: "stale_content", cause });
}

// Herdr numbers an unnamed tab by its place; a number is no name to carry
// over to another project (displayTabLabel hides it the same way).
function carriedTabLabel(label) {
  if (typeof label !== "string" || /^\d+$/u.test(label.trim())) return null;
  try {
    return validateTabLabel(label);
  } catch {
    return null;
  }
}

// A move result with its ids put through `scope` (a session or machine
// prefix), for callers that hand the page scoped ids.
export function mapMovedIds(result, scope) {
  return {
    ...result,
    tab_id: scope(result.tab_id),
    panes: result.panes.map(({ from, to }) => ({ from: scope(from), to: scope(to) })),
  };
}

// `herdr pane move` arguments that lift a pane into a new tab of a project.
function paneMoveArgs(paneId, workspaceId, label) {
  return ["pane", "move", paneId, "--new-tab", "--workspace", workspaceId, ...(label ? [`--label=${label}`] : []), "--no-focus"];
}

// The pane and tab Herdr made from a pane move, as { paneId, tabId }.
function movedPaneIds(result) {
  const moved = result?.move_result ?? result;
  const paneId = moved?.pane?.pane_id;
  const tabId = moved?.created_tab?.tab_id ?? moved?.pane?.tab_id;
  if (typeof paneId !== "string" || !PANE_ID_PATTERN.test(paneId) || typeof tabId !== "string" || !TAB_ID_PATTERN.test(tabId)) {
    throw new HerdrCommandError("Herdr returned an unexpected move result", { code: "invalid_herdr_response" });
  }
  return { paneId, tabId };
}

function validateText(text) {
  if (typeof text !== "string" || text.length === 0) {
    throw new InputValidationError("Text must not be empty");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new InputValidationError(`Text must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  if (text.includes("\0")) {
    throw new InputValidationError("Text must not contain null bytes");
  }

  return text;
}

function validateLines(lines) {
  const value = Number(lines);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PANE_READ_LINES) {
    throw new InputValidationError(`Lines must be between 1 and ${MAX_PANE_READ_LINES}`);
  }

  return value;
}

function validateReadFormat(format) {
  if (format !== "text" && format !== "ansi") {
    throw new InputValidationError("Read format must be text or ansi");
  }
  return format;
}

function validateReadSource(source) {
  if (source !== "recent-unwrapped" && source !== "detection") {
    throw new InputValidationError("Read source must be recent-unwrapped or detection");
  }
  return source;
}

function validateKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8) {
    throw new InputValidationError("Provide between 1 and 8 keys");
  }

  for (const key of keys) {
    if (!isTerminalKey(key)) {
      throw new InputValidationError("Invalid key format");
    }
  }

  return keys;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HerdrCommandError("Herdr returned invalid JSON", {
      code: "invalid_herdr_response",
      cause: error,
    });
  }
}

function unwrapResult(payload) {
  return payload && typeof payload === "object" && "result" in payload
    ? payload.result
    : payload;
}

function publicCommandError(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    try {
      const payload = JSON.parse(stderr);
      const detail = payload?.error;
      if (detail && typeof detail === "object") {
        const code = typeof detail.code === "string" ? detail.code : "herdr_command_failed";
        const message =
          typeof detail.message === "string" && detail.message.length <= 300
            ? detail.message
            : "Herdr command failed";
        return new HerdrCommandError(message, { code, cause: error });
      }
    } catch {
      // Herdr sometimes prints human-readable CLI errors. Do not reflect them to the browser.
    }
  }

  if (error?.killed || error?.signal === "SIGTERM") {
    return new HerdrCommandError("Herdr command timed out", {
      code: "herdr_timeout",
      cause: error,
    });
  }

  return new HerdrCommandError("Herdr command failed", { cause: error });
}

// The input still going to each pane: text and keys for one pane go in the
// order they came, so a message waiting on its Enter is never cut into.
const PANE_INPUTS = new Map();
// The last message each pane was sent, and whether an Esc (Stop) followed it:
// Claude Code puts a message it was stopped on back in its input box, and the
// next message would be typed after it. Keyed as PANE_INPUTS is.
const PANE_SENT = new Map();
const MAX_PANE_SENT = 256;
// How long Claude Code gets to redraw its input box after a key.
const INPUT_SETTLE_MS = 150;
// Enough of the screen to hold Claude's whole input box with the longest
// message the composer sends (8,000 characters) wrapped on a narrow pane, and
// enough rounds to empty it a row or two at a time.
const RESTORED_READ_LINES = 1000;
// How long after an Esc Claude Code is given to put the stopped message back
// before the box is read (it took well under a second in Claude Code 2.1).
const RESTORE_SETTLE_MS = 1_000;
const MAX_CLEAR_ROUNDS = RESTORED_READ_LINES;

// Enough for Claude Code to read a pasted image path before its Enter.
const IMAGE_SETTLE_MS = 700;
// A path to an image file, as an upload or a path link puts in a message.
const IMAGE_EXTENSION = "(?:png|jpe?g|gif|webp|bmp|heic|heif|tiff?)";
// Before it the start, a space or an opening bracket; after it the end, a
// space, a closing bracket or sentence punctuation ("see /tmp/a.png, then").
const IMAGE_PATH_RE = new RegExp(`(?:^|[\\s([{<])(?:~|\\.{0,2})?/[^\\s"'\\]})>]*\\.${IMAGE_EXTENSION}(?=$|[\\s)\\]}>]|[,.;:!?](?:$|\\s))`, "iu");
// a quoted one may hold spaces: "/my shots/a.png"
const QUOTED_IMAGE_PATH_RE = new RegExp(`(["'])(?:~|\\.{0,2})?/[^"'\\n]*\\.${IMAGE_EXTENSION}\\1`, "iu");
// an @ reference to one, relative or not, quoted or not: @shots/a.png
const AT_IMAGE_RE = new RegExp(`(?:^|[\\s([{])@(?:"[^"\\n]*\\.${IMAGE_EXTENSION}"|[^\\s"\\]})]*\\.${IMAGE_EXTENSION})(?=$|[\\s)\\]}]|[,.;:!?](?:$|\\s))`, "iu");
export function namesImage(text) {
  const value = String(text ?? "");
  return IMAGE_PATH_RE.test(value) || QUOTED_IMAGE_PATH_RE.test(value) || AT_IMAGE_RE.test(value);
}

export class HerdrClient {
  constructor({
    binary = "herdr",
    timeoutMs = 5_000,
    runner = execFileAsync,
    sessionName = null,
    socketPath = null,
    // How long an agent gets to take in a pasted image before its Enter.
    imageSettleMs = IMAGE_SETTLE_MS,
    inputSettleMs = INPUT_SETTLE_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = {}) {
    this.binary = binary;
    this.imageSettleMs = imageSettleMs;
    this.inputSettleMs = inputSettleMs;
    this.sleep = sleep;
    this.now = now;

    this.timeoutMs = timeoutMs;
    this.runner = runner;
    this.sessionName = sessionName === null
      ? null
      : validateHerdrSessionName(sessionName);
    // A Herdr reached through a socket given here rather than one `session
    // list` names: every command goes to that socket, and it is the one session.
    this.socketPath = socketPath;
  }

  async #run(args, { json = true, timeoutMs = this.timeoutMs } = {}) {
    try {
      const commandArgs = this.sessionName === null || this.socketPath
        ? args
        : [`--session=${this.sessionName}`, ...args];
      const { stdout } = await this.runner(this.binary, commandArgs, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", ...(this.socketPath ? { HERDR_SOCKET_PATH: this.socketPath } : {}) },
        windowsHide: true,
      });

      return json ? unwrapResult(parseJson(stdout)) : stdout;
    } catch (error) {
      if (error instanceof HerdrCommandError) {
        throw error;
      }
      throw publicCommandError(error);
    }
  }

  async snapshot() {
    const result = await this.#run(["api", "snapshot"]);
    return result?.snapshot ?? result;
  }

  async listSessions({ timeoutMs = this.timeoutMs } = {}) {
    // `session list` reads this machine's sessions, never the socket's.
    if (this.socketPath) return [{ name: this.sessionName || "default", default: true, running: true, socket_path: this.socketPath }];
    const result = await this.#run(["session", "list", "--json"], { timeoutMs });
    return result?.sessions ?? result;
  }

  async listAgents() {
    const result = await this.#run(["agent", "list"]);
    return result?.agents ?? result;
  }

  async renameWorkspace(workspaceId, label) {
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    const safeLabel = validateWorkspaceLabel(label);
    return this.#run(["workspace", "rename", safeWorkspaceId, safeLabel]);
  }

  async createWorkspace(label) {
    const safeLabel = validateWorkspaceLabel(label);
    return this.#run(
      ["workspace", "create", "--label", safeLabel, "--no-focus"],
      { json: false },
    );
  }

  async closeWorkspace(workspaceId) {
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    return this.#run(["workspace", "close", safeWorkspaceId], {
      json: false,
    });
  }

  async createTab(workspaceId) {
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    return this.#run(
      ["tab", "create", "--workspace", safeWorkspaceId, "--no-focus"],
      { json: false },
    );
  }

  async renameTab(tabId, label) {
    const safeTabId = validateTabId(tabId);
    const safeLabel = validateTabLabel(label);
    // The CLI takes the label as trailing words; one argv entry stays one name,
    // spaces and all.
    return this.#run(["tab", "rename", safeTabId, safeLabel]);
  }

  async closeTab(tabId) {
    const safeTabId = validateTabId(tabId);
    return this.#run(["tab", "close", safeTabId], { json: false });
  }

  // The socket of the session this client speaks for: the one given, or the
  // one `session list` names here.
  async #sessionSocket() {
    if (this.socketPath) return this.socketPath;
    const sessions = await this.listSessions();
    const session = sessions.find(item => item.name === (this.sessionName || "default") && item.running);
    if (!session?.socket_path) throw new HerdrCommandError("Herdr socket is unavailable", { code: "server_unavailable" });
    return session.socket_path;
  }

  // Socket API methods the CLI has no command for.
  async #call(method, params) {
    const socketPath = await this.#sessionSocket();
    return callHerdrSocket({
      socketPath, method, params, openSocket: this.runner.openSocket, timeoutMs: this.timeoutMs,
      wrapError: ({ code, message }) => new HerdrCommandError(message, { code }),
    });
  }

  // insert_index is a gap in the list as it is now, the moving one included:
  // 0 puts it first, the list's length puts it last.
  async moveTab(tabId, insertIndex) {
    const safeTabId = validateTabId(tabId);
    const safeIndex = validateInsertIndex(insertIndex);
    return this.#call("tab.move", { tab_id: safeTabId, insert_index: safeIndex });
  }

  async moveWorkspace(workspaceId, insertIndex) {
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    const safeIndex = validateInsertIndex(insertIndex);
    return this.#call("workspace.move", { workspace_id: safeWorkspaceId, insert_index: safeIndex });
  }

  // A session (tab) carried to another project of the same Herdr session.
  // Herdr moves panes, not tabs: the pane opens a new tab there under the
  // session's name and the tab left empty closes. Only a session of one pane
  // moves: carrying several one by one could fail halfway and split the
  // session across two projects. The pane gets a new id, so the move is
  // returned for the page to follow it. `reordered` is false when the session
  // moved but could not be put at the dropped place and is last in the project.
  // insertIndex is the gap among the project's sessions as they are now.
  async moveTabToWorkspace(tabId, workspaceId, insertIndex) {
    const safeTabId = validateTabId(tabId);
    const safeWorkspaceId = validateWorkspaceId(workspaceId);
    const safeIndex = validateInsertIndex(insertIndex);
    const snapshot = await this.snapshot();
    const tab = (snapshot?.tabs ?? []).find((item) => item.tab_id === safeTabId);
    if (!tab) throw new HerdrCommandError("That session is no longer open", { code: "tab_not_found" });
    if (tab.workspace_id === safeWorkspaceId) {
      await this.moveTab(safeTabId, safeIndex);
      return { tab_id: safeTabId, panes: [], reordered: true };
    }
    if (!(snapshot.workspaces ?? []).some((item) => item.workspace_id === safeWorkspaceId)) {
      throw new HerdrCommandError("That project is no longer open", { code: "workspace_not_found" });
    }
    const paneIds = (snapshot.panes ?? []).filter((item) => item.tab_id === safeTabId).map((item) => validatePaneId(item.pane_id));
    if (paneIds.length === 0) throw new HerdrCommandError("That session has no panes", { code: "tab_not_found" });
    if (paneIds.length > 1) {
      throw new HerdrCommandError("A split session can only be reordered within its project.", { code: "split_session" });
    }
    const targetTabs = (snapshot.tabs ?? []).filter((item) => item.workspace_id === safeWorkspaceId).length;
    const label = carriedTabLabel(tab.label);
    const { paneId: to, tabId: newTabId } = movedPaneIds(
      await this.#run(paneMoveArgs(paneIds[0], safeWorkspaceId, label)),
    );
    // The new tab opened last; put it where it was dropped.
    let reordered = true;
    if (safeIndex < targetTabs) {
      try {
        await this.moveTab(newTabId, safeIndex);
      } catch {
        reordered = false;
      }
    }
    return { tab_id: newTabId, panes: [{ from: paneIds[0], to }], reordered };
  }

  // Where the pane's shared view sits in its history; null when herdr says nothing.
  async #paneScroll(paneId) {
    const result = await this.#call("pane.get", { pane_id: paneId });
    return scrollInfo(result?.pane?.scroll);
  }

  // Finds `query` in the pane's whole history; it moves nothing (paneReveal
  // scrolls the view to the match). The first find starts
  // at the bottom of the view and goes `direction`; a next one steps from
  // `previous`, the match found last, as long as the history is still the
  // revision it was found in (stale_content otherwise). Herdr wraps round at
  // either end. `current` counts from 1; `matches` are the ones herdr gives
  // around it, end cells included.
  async paneFind(paneId, request) {
    const safePaneId = validatePaneId(paneId);
    const { query, direction, previous, contentRevision } = validateFindRequest(request);
    const unexpected = () => new HerdrCommandError("Herdr returned an unexpected search answer", { code: "invalid_herdr_response" });
    const scroll = await this.#paneScroll(safePaneId);
    const top = scroll ? scroll.max_offset_from_bottom - scroll.offset_from_bottom : 0;
    const bottom = scroll ? top + Math.max(0, scroll.viewport_rows - 1) : 0;
    // pane.read's revision is not the one copy_search wants; copy_motion gives
    // it without entering copy mode or moving anyone's cursor.
    const motion = await this.#call("pane.copy_motion", {
      pane_id: safePaneId, cursor: { row: bottom, col: 0 }, motion: "line_end",
    });
    const revision = motion?.content_revision;
    if (!isCount(revision) || !validTextPoint(motion?.cursor)) throw unexpected();
    if (previous && contentRevision !== revision) throw staleContent();
    let found;
    try {
      found = await this.#call("pane.copy_search", {
        pane_id: safePaneId, query, direction,
        cursor: previous?.start ?? (direction === "backward" ? motion.cursor : { row: top, col: 0 }),
        content_revision: revision,
        ...(previous ? { previous } : {}),
      });
    } catch (error) {
      if (error?.code === "stale_content") throw staleContent(error);
      throw error;
    }
    if (!isCount(found?.total) || !Array.isArray(found?.matches)) throw unexpected();
    const matches = found.matches.slice(0, MAX_FIND_MATCHES).map(textRange);
    if (matches.includes(null)) throw unexpected();
    // An answer that contradicts itself is refused, not read as "no match".
    if (isCount(found.current) && found.current >= found.matches.length) throw unexpected();
    const match = isCount(found.current) ? textRange(found.matches[found.current]) : null;
    if (isCount(found.current) && !match) throw unexpected();
    if (match && found.total === 0) throw unexpected();
    if (isCount(found.current_global) && found.current_global >= found.total) throw unexpected();
    const ordinal = isCount(found.current_global) ? found.current_global : found.current;
    const foundRevision = isCount(found.content_revision) ? found.content_revision : revision;
    return {
      total: found.total,
      current: match ? ordinal + 1 : null,
      match,
      matches,
      content_revision: foundRevision,
      scroll,
    };
  }

  // Scrolls the pane's view, which every client of the pane shares, to a match
  // a find gave, unless it shows already. Herdr refuses this if output or a
  // reflow moved the history since the find (stale_content), so the view never
  // goes to a row that now holds something else. Answers the view as it is.
  async paneReveal(paneId, request) {
    const safePaneId = validatePaneId(paneId);
    const { match, contentRevision, coverRows } = validateRevealRequest(request);
    // The view as it is now: the page may have been resized since the find.
    const now = await this.#paneScroll(safePaneId);
    if (!now) return { scroll: null };
    const offset = findScrollOffset(now, match, coverRows);
    // Checked even when the view need not move: a match the history has moved
    // away from must not be shown as the current one.
    try {
      await this.#call("pane.copy_motion", {
        pane_id: safePaneId, cursor: match.start, motion: "line_end", content_revision: contentRevision,
      });
    } catch (error) {
      if (error?.code === "stale_content") throw staleContent(error);
      throw error;
    }
    if (offset === now.offset_from_bottom) return { scroll: now };
    const scrolled = await this.#call("pane.scroll", { pane_id: safePaneId, offset_from_bottom: offset });
    return { scroll: scrollInfo(scrolled?.pane?.scroll) ?? { ...now, offset_from_bottom: offset } };
  }

  // Scrolls the pane's view, which every client of the pane shares, down to
  // the newest output; nothing is sent when it is there already (or herdr
  // gives no view position). Answers the view as it is.
  async paneScrollToBottom(paneId) {
    const safePaneId = validatePaneId(paneId);
    const now = await this.#paneScroll(safePaneId);
    if (!now || now.offset_from_bottom === 0) return { scroll: now };
    const scrolled = await this.#call("pane.scroll", { pane_id: safePaneId, offset_from_bottom: 0 });
    return { scroll: scrollInfo(scrolled?.pane?.scroll) ?? { ...now, offset_from_bottom: 0 } };
  }

  // The pane's processes as herdr sees them (its shell and the foreground
  // group, each with pid and argv): where a Codex pane's rollout is open.
  async paneProcessInfo(paneId) {
    const safePaneId = validatePaneId(paneId);
    return this.#run(["pane", "process-info", "--pane", safePaneId]);
  }

  // `source` "detection" is the screen as herdr reads it for agent states:
  // the live bottom of the pane, whatever the viewport is scrolled to.
  async readPane(paneId, { lines = 160, format = "ansi", source = "recent-unwrapped" } = {}) {
    const safePaneId = validatePaneId(paneId);
    const safeLines = validateLines(lines);
    const safeFormat = validateReadFormat(format);
    const safeSource = validateReadSource(source);
    return this.#run(
      [
        "pane",
        "read",
        safePaneId,
        "--source",
        safeSource,
        "--lines",
        String(safeLines),
        "--format",
        safeFormat,
      ],
      { json: false },
    );
  }

  async watchStatuses(paneIds, onStatus, onError) {
    const ids = paneIds.map(validatePaneId);
    const sessions = await this.listSessions();
    const session = sessions.find(item => item.name === (this.sessionName || "default") && item.running);
    if (!session?.socket_path) throw new HerdrCommandError("Herdr status socket is unavailable");
    return subscribeHerdrStatuses({ socketPath: session.socket_path, paneIds: ids,
      openSocket: this.runner.openSocket, onStatus, onError });
  }

  // What `terminal attach` needs for a pane: its terminal, the socket of this
  // session (the attach must reach the server the other commands talk to), and
  // the pane's own size for a viewer that does not set one.
  // `timeoutMs` bounds each lookup when an attach is looked up again after
  // herdr ended it, so a herdr that does not answer cannot hold it past its time.
  async terminalTarget(paneId, timeoutMs = this.timeoutMs) {
    const safePaneId = validatePaneId(paneId);
    const run = (args) => this.#run(args, { timeoutMs: Math.min(timeoutMs, this.timeoutMs) });
    const [{ pane }, sessions, layout] = await Promise.all([
      run(["pane", "get", safePaneId]),
      this.listSessions({ timeoutMs: Math.min(timeoutMs, this.timeoutMs) }),
      run(["pane", "layout", "--pane", safePaneId]).catch(() => null),
    ]);
    const session = sessions.find(item => item.name === (this.sessionName || "default") && item.running);
    if (!session?.socket_path) throw new HerdrCommandError("Herdr socket is unavailable", { code: "server_unavailable" });
    // `terminal attach` takes the API socket in HERDR_SOCKET_PATH and finds the
    // client socket beside it as `<name>-client.sock`.
    // The id comes from Herdr's answer: it may only ever be an id, never
    // something `terminal attach` would read as an option.
    if (typeof pane?.terminal_id !== "string" || !TERMINAL_ID.test(pane.terminal_id)) {
      throw new HerdrCommandError("The pane has no terminal", { code: "no_terminal" });
    }
    const rect = layout?.layout?.panes?.find(item => item.pane_id === safePaneId)?.rect;
    return {
      command: this.binary,
      args: ["terminal", "attach", pane.terminal_id],
      // herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET.
      env: { HERDR_SOCKET_PATH: session.socket_path },
      terminalId: pane.terminal_id,
      cols: rect?.width,
      rows: rect?.height,
    };
  }

  // One pane of one Herdr, for every client made for it (the bridge makes
  // one per call): keyed by the socket or session too.
  #paneKey(paneId) {
    return `${this.binary}\0${this.socketPath ?? ""}\0${this.sessionName ?? ""}\0${paneId}`;
  }

  // Runs `send` once the pane's earlier input has gone.
  #inOrder(paneId, send) {
    const key = this.#paneKey(paneId);
    const before = PANE_INPUTS.get(key) ?? Promise.resolve();
    const run = before.catch(() => {}).then(send);
    const settled = run.catch(() => {});
    PANE_INPUTS.set(key, settled);
    settled.then(() => { if (PANE_INPUTS.get(key) === settled) PANE_INPUTS.delete(key); });
    return run;
  }

  async sendText(paneId, text, { submit = false } = {}) {
    const safePaneId = validatePaneId(paneId);
    const safeText = validateText(text);
    return this.#inOrder(safePaneId, () => this.#sendText(safePaneId, safeText, submit));
  }

  async #sendText(safePaneId, safeText, submit) {
    const key = this.#paneKey(safePaneId);
    const before = PANE_SENT.get(key);
    PANE_SENT.delete(key);
    if (!submit) return this.#submitText(safePaneId, safeText, submit);
    if (before?.stopped) {
      try {
        // Claude puts the stopped message back a moment after the Esc: a look
        // straight after it could find the box still empty.
        const settle = RESTORE_SETTLE_MS - (this.now() - (before.stoppedAt ?? 0));
        if (settle > 0) await this.sleep(settle);
        await this.#clearRestoredMessage(safePaneId, before.text);
      } catch (error) {
        // still there: the next send looks again
        PANE_SENT.set(key, before);
        throw error;
      }
    }
    const result = await this.#submitText(safePaneId, safeText, submit);
    PANE_SENT.set(key, { text: safeText, stopped: false });
    if (PANE_SENT.size > MAX_PANE_SENT) PANE_SENT.delete(PANE_SENT.keys().next().value);
    return result;
  }

  // After a Stop, Claude Code may hold the stopped message in its input box:
  // when the box shows exactly that message, it is emptied first, so the new
  // one is not typed after it. Text it holds otherwise is left alone; a box
  // the keys cannot empty refuses the send (the composer keeps the draft).
  async #clearRestoredMessage(safePaneId, restored) {
    // Read with its styles, so an empty box's dim tip is told from typed words.
    // A screen that cannot be read refuses the send: the stopped message may
    // still be there.
    const look = async () => claudeInputBox(await this.readPane(safePaneId, { lines: RESTORED_READ_LINES, format: "ansi" }));
    let before = null;
    let box;
    try {
      box = await look();
    } catch {
      box = undefined;
    }
    for (let round = 0; box !== undefined && round < MAX_CLEAR_ROUNDS; round += 1) {
      const step = restoredDraftStep(box, restored, before);
      if (step.done) return;
      if (step.stuck) break;
      await this.#sendKeys(safePaneId, step.keys);
      await this.sleep(this.inputSettleMs);
      before = box;
      try {
        box = await look();
      } catch {
        break;
      }
    }
    throw new HerdrCommandError("Claude's input box still holds the stopped message. Clear it in the terminal, then send again.",
      { code: "input_not_empty" });
  }

  async #submitText(safePaneId, safeText, submit) {
    if (submit && namesImage(safeText)) {
      // Claude Code turns a pasted image path into an attachment ([Image #1])
      // and drops an Enter that arrives while it does: the text goes first,
      // the Enter after a moment, so the message is sent in one go.
      await this.#run(["pane", "send-text", safePaneId, safeText], { json: false });
      await this.sleep(this.imageSettleMs);
      return this.#run(["pane", "send-keys", safePaneId, "enter"], { json: false });
    }
    if (submit) {
      return this.#run(["pane", "run", safePaneId, safeText], {
        json: false,
      });
    }
    // This CLI joins trailing arguments as literal text, including "--".
    return this.#run(["pane", "send-text", safePaneId, safeText], { json: false });
  }

  // `stop` marks the Chat lens's Stop button: only its lone Esc is taken for a
  // Stop. An Esc from anywhere else (a shell, Codex, a closed menu) is a key.
  async sendKeys(paneId, keys, { stop = false } = {}) {
    const safePaneId = validatePaneId(paneId);
    const safeKeys = validateKeys(keys);
    return this.#inOrder(safePaneId, async () => {
      // A Stop (a lone Esc sent for the Stop button) after a message counts once it has gone through; any
      // other key changes what the input box holds, so nothing is cleared
      // for it later (forgotten before it goes, whether or not it arrives).
      const key = this.#paneKey(safePaneId);
      const sent = PANE_SENT.get(key);
      const isStop = stop === true && safeKeys.length === 1 && safeKeys[0] === "esc";
      if (sent && !isStop) PANE_SENT.delete(key);
      const result = await this.#sendKeys(safePaneId, safeKeys);
      if (sent && isStop && PANE_SENT.get(key) === sent) {
        sent.stopped = true;
        sent.stoppedAt = this.now();
      }
      return result;
    });
  }

  async #sendKeys(safePaneId, safeKeys) {
    // Herdr's named-key parser (0.8.2 through 0.9.3) omits these navigation keys. Its
    // send-text API writes bytes directly to the PTY, without paste wrapping.
    const groups = [];
    for (const key of safeKeys) {
      const parts = key.split("+");
      const base = parts.pop();
      const navigationCodes = { home: "H", end: "F", pageup: "5", pagedown: "6", insert: "2", delete: "3" };
      const code = Object.hasOwn(navigationCodes, base) ? navigationCodes[base] : undefined;
      const raw = code !== undefined && parts.every((part) => ["ctrl", "alt", "shift"].includes(part));
      let value = key === "-" ? "minus" : key;
      if (raw) {
        const modifier = 1 + (parts.includes("shift") ? 1 : 0) +
          (parts.includes("alt") ? 2 : 0) + (parts.includes("ctrl") ? 4 : 0);
        const suffix = modifier === 1 ? "" : `;${modifier}`;
        value = base === "home" || base === "end"
          ? `\x1b[${modifier === 1 ? "" : `1${suffix}`}${code}`
          : `\x1b[${code}${suffix}~`;
      }
      const last = groups.at(-1);
      if (last?.raw === raw) last.values.push(value);
      else groups.push({ raw, values: [value] });
    }
    let result;
    for (const group of groups) {
      result = await this.#run(group.raw
        ? ["pane", "send-text", safePaneId, group.values.join("")]
        : ["pane", "send-keys", safePaneId, ...group.values], { json: false });
    }
    return result;
  }
}

// The optional Stop mark on a keys request: absent or a boolean.
function validateStop(value) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new InputValidationError("Invalid stop flag");
  return value;
}

export const validation = Object.freeze({
  validateStop,
  validateHerdrSessionName,
  validatePaneId,
  validateWorkspaceId,
  validateTabId,
  validateWorkspaceLabel,
  validateInsertIndex,
  validateText,
  validateLines,
  validateReadFormat,
  validateReadSource,
  validateKeys,
  validateFindRequest,
  validateRevealRequest,
});
