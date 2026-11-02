import { array, browserSessionStorage, browserStorage, createElement, createIcon, placeFloatingMenu, workspaceActionButton } from "./app/dom.js?v=1.4.23";
import { createSnapshotModel, idOf } from "./app/snapshot.js?v=1.4.23";
import { previewFor } from "./file-preview.js?v=1.4.23";
import { isFileName, isFolderPath, trimTrailingSlashes } from "./path-links.js?v=1.4.23";
import { createApiClient, paneApi } from "./api-client.js?v=1.4.23";
let modifierPaneId = null;
// The selected pane's agent and status, for the Chat lens's Stop button.
let stopTarget = { paneId: null, agent: null, status: null };
import {
  HISTORY_PAGE_LINES,
  agentStatus,
  detectTouchInput,
  displayRecordLabel,
  displayTabLabel,
  paneServerId,
  loginMethodPresentation,
  preferredLoginMethod,
  outputPollingDecision,
  outputTextForUpdate,
  paneShortcutTarget,
  paneSelectionAfterSnapshot,
  sidebarPresentation,
  paneAgentKind,
  agentStatusIcon,
  agentStatusLabel,
  mostUrgentStatus,
  paneDisplayTitle,
  paneSubtitle,
  openRenames,
  clearedTabLabel,
  reconcileLiveStatus,
  seenCompletions,
  navigationModel,
  serverConnectionState,
} from "./ui-model.js?v=1.4.23";
import {
  readFileServer,
  readNavigatorTab,
} from "./browse-preference.js?v=1.4.23";
import { terminalConnection } from "./terminal-connection.js?v=1.4.23";
import { terminalStatus } from "./terminal-status.js?v=1.4.23";
import { createAttachedTerminal } from "./xterm-terminal.js?v=1.4.23";
import { createPaneGrid, renderPaneMap } from "./pane-grid.js?v=1.4.23";
import {
  adjustedChatFontSize,
} from "./chat-font-preference.js?v=1.4.23";
import { chatAgent } from "./lens-preference.js?v=1.4.23";
import * as xterm from "./vendor/xterm.mjs?v=1.4.23";
import {
  readPanePreference,
  writePanePreference,
} from "./pane-preference.js?v=1.4.23";
import {
  readCollapsedGroupIds,
  readCollapsedWorkspaceIds,
  readExpandedSplitTabIds,
  writeCollapsedGroupIds,
  writeCollapsedWorkspaceIds,
  writeExpandedSplitTabIds,
} from "./workspace-preference.js?v=1.4.23";
import {
  adjustedTerminalFontSize,
  readGridFit,
  readGridFont,
  readTerminalFontSize,
  writeGridFont,
  writeTerminalFontSize,
} from "./terminal-preference.js?v=1.4.23";
import {
  readAcknowledgedCompletions,
  writeAcknowledgedCompletions,
} from "./completion-preference.js?v=1.4.23";
import {
  looksLikePhysicalKey,
  readEnterKeyMode,
} from "./enter-key-preference.js?v=1.4.23";
import {
  attachSidebarDrag,
  dropScope,
  followMovedPane,
  movedTabSnapshot,
  movedWorkspaceSnapshot,
  paneMoveRequest,
  tabMoveRequest,
  workspaceMoveRequest,
} from "./sidebar-drag.js?v=1.4.23";
import {
  addTile,
  layoutRects,
  moveTile,
  paneDropKind,
  prune as pruneViewTiles,
  readViewSplit,
  removeTile,
  renameTiles,
  swapTiles,
  tiles as viewTiles,
  writeViewSplit,
} from "./view-split.js?v=1.4.23";
import { renamePaneKeys } from "./pane-rename.js?v=1.4.23";
import { renamePaneLenses } from "./lens-preference.js?v=1.4.23";
import {
  readInputHistories,
  writeInputHistories,
} from "./input-history-preference.js?v=1.4.23";
import { atFilesSource } from "./composer-at-files.js?v=1.4.23";
import { createComposerPopup } from "./composer-popup.js?v=1.4.23";
import { slashCommandsSource } from "./composer-slash.js?v=1.4.23";
import { createComposerDrafts, draftScreenIsSecret, draftScreenShowsPrompt } from "./composer-draft-preference.js?v=1.4.23";
import {
  readKeyBarItems,
} from "./key-bar-preference.js?v=1.4.23";
import {
  clearLaunchToken,
  readLaunchToken,
  writeLaunchToken,
} from "./launch-session.js?v=1.4.23";


const panePreferenceStorage = browserStorage();
let lastLoginMethod;
try { lastLoginMethod = panePreferenceStorage?.getItem("herdr:last-login-method"); } catch {}

function rememberLoginMethod(method) {
  lastLoginMethod = method;
  try { panePreferenceStorage?.setItem("herdr:last-login-method", method); } catch {}
}

function currentLoginMethod() {
  return preferredLoginMethod({
    lastMethod: lastLoginMethod, touchInput: usesTouchInputEnvironment(),
    passkeyAvailable: state.passkeyAvailable && supportsPasskeys(),
  });
}
const launchSessionStorage = browserSessionStorage();
const notificationPanePreference = new URL(window.location.href).searchParams.get("pane");
import { createNotifications } from "./app/notifications.js?v=1.4.23";
// How long a link to another server's pane waits for that server's panes to load.
const PENDING_REMOTE_PANE_MS = 20_000;
const pageOpenedAt = Date.now();
// This window's own view split (view-split.js), kept for this window alone: a
// reload opens it again, on the tile last focused, unless a link names a pane.
const viewSplitStorage = browserSessionStorage();
const viewSplit = readViewSplit(viewSplitStorage);
const initialPanePreference =
  typeof notificationPanePreference === "string" &&
  notificationPanePreference.length > 0 &&
  notificationPanePreference.length <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(notificationPanePreference)
    ? notificationPanePreference
    : (viewSplit.shown && viewSplit.focus) || readPanePreference(panePreferenceStorage);
const initialCollapsedGroupIds = readCollapsedGroupIds(
  (() => { try { return window.localStorage; } catch { return null; } })(),
);
const initialCollapsedWorkspaceIds = readCollapsedWorkspaceIds(
  panePreferenceStorage,
);
const initialExpandedSplitTabIds = readExpandedSplitTabIds(panePreferenceStorage);
const initialTerminalFontSize = readTerminalFontSize(panePreferenceStorage);
const initialAcknowledgedCompletions = readAcknowledgedCompletions(
  panePreferenceStorage,
);
const initialInputHistories = readInputHistories(panePreferenceStorage);
// A draft is not stored unless the screen is known to be this pane's current
// one and is not asking for a password: anything else fails closed.
const composerDrafts = createComposerDrafts(panePreferenceStorage, Date.now,
  (paneId) => draftScreenIsSecret(paneId, draftPaneId, attachedTerminal.screenText(8)),
  (paneId) => draftScreenShowsPrompt(paneId, draftPaneId, attachedTerminal.screenText(8)));
document.documentElement.style.setProperty(
  "--terminal-font-size",
  `${initialTerminalFontSize}px`,
);

const elements = {
  shell: document.querySelector(".shell"),
  navigator: document.querySelector("#navigator"),
  navigatorContent: document.querySelector("#navigator-content"),
  createProject: document.querySelector("#create-project"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  sidebarScrim: document.querySelector("#sidebar-scrim"),
  mobileSidebarOpen: document.querySelector("#mobile-sidebar-open"),
  // The key bar's editor lives with the other settings at the foot of the sidebar.
  navigatorFooter: document.querySelector(".navigator-footer"),
  workspaceList: document.querySelector("#workspace-list"),
  paneContext: document.querySelector("#pane-context"),
  paneTitle: document.querySelector("#pane-title"),
  terminalPanel: document.querySelector(".terminal-panel"),
  terminalMessage: document.querySelector("#terminal-message"),
  terminalXterm: document.querySelector("#terminal-xterm"),
  terminalHeld: document.querySelector("#terminal-held"),
  terminalStatus: document.querySelector("#terminal-status"),
  terminalStatusText: document.querySelector("#terminal-status-text"),
  terminalStatusCountdown: document.querySelector("#terminal-status-countdown"),
  terminalReconnect: document.querySelector("#terminal-reconnect"),
  terminalStage: document.querySelector(".terminal-stage"),
  paneMap: document.querySelector("#pane-map"),
  gridBack: document.querySelector("#grid-back"),
  viewBack: document.querySelector("#view-back"),
  viewClose: document.querySelector("#view-close"),
  chatHost: document.querySelector("#chat-host"),
  promptDock: document.querySelector("#prompt-dock"),
  lensSwitch: document.querySelector("#lens-switch"),
  lensChat: document.querySelector("#lens-chat"),
  lensTerminal: document.querySelector("#lens-terminal"),
  quickKeys: document.querySelector(".quick-keys"),
  inputForm: document.querySelector("#input-form"),
  sendButton: document.querySelector("#input-form .send-button"),
  terminalInput: document.querySelector("#terminal-input"),
  inputComposer: document.querySelector(".input-composer"),
  dictateButton: document.querySelector("#dictate-button"),
  composerFiles: document.querySelector("#composer-files"),
  actionFeedback: document.querySelector("#action-feedback"),
  projectDialog: document.querySelector("#project-dialog"),
  projectCreateForm: document.querySelector("#project-create-form"),
  projectName: document.querySelector("#project-name"),
  projectSessionContext: document.querySelector("#project-session-context"),
  projectDialogCancel: document.querySelector("#project-dialog-cancel"),
  projectDialogFeedback: document.querySelector("#project-dialog-feedback"),
  loginScreen: document.querySelector("#login-screen"),
  loginForm: document.querySelector("#login-form"),
  loginInstruction: document.querySelector("#login-instruction"),
  loginPassword: document.querySelector("#login-password"),
  loginPasswordLabel: document.querySelector("#login-password-label"),
  loginSubmit: document.querySelector(".login-submit"),
  loginFeedback: document.querySelector("#login-feedback"),
  passkeyLogin: document.querySelector("#passkey-login"),
  passkeyDialog: document.querySelector("#passkey-dialog"),
  passkeyRegister: document.querySelector("#passkey-register"),
  passkeyDialogCancel: document.querySelector("#passkey-dialog-cancel"),
  passkeyDialogFeedback: document.querySelector("#passkey-dialog-feedback"),
  passkeyDialogPassword: document.querySelector("#passkey-dialog-password"),
  passkeyDialogPasswordField: document.querySelector("#passkey-dialog-password-field"),
  attachButton: document.querySelector("#attach-button"),
  transferDialog: document.querySelector("#transfer-dialog"),
  transferFile: document.querySelector("#transfer-file"),
  transferUpload: document.querySelector("#transfer-upload"),
  transferClose: document.querySelector("#transfer-close"),
  transferDialogFeedback: document.querySelector("#transfer-dialog-feedback"),
  transferDrop: document.querySelector("#transfer-drop"),
  transferDropLabel: document.querySelector("#transfer-drop-label"),
  uploadsList: document.querySelector("#uploads-list"),
  navigator: document.querySelector("#navigator"),
  navigatorResizer: document.querySelector("#navigator-resizer"),
  navigatorTabs: document.querySelectorAll(".navigator-tab"),
  tabSessions: document.querySelector("#tab-sessions"),
  tabFiles: document.querySelector("#tab-files"),
  filePanel: document.querySelector("#file-panel"),
  filePath: document.querySelector("#file-path"),
  fileSuggestions: document.querySelector("#file-suggestions"),
  fileRefresh: document.querySelector("#file-refresh"),
  fileUp: document.querySelector("#file-up"),
  fileUploads: document.querySelector("#file-uploads"),
  fileServer: document.querySelector("#file-server"),
  browseTree: document.querySelector("#file-tree"),
  browseFeedback: document.querySelector("#file-feedback"),
};

const state = {
  csrfToken: "",
  pollIntervalMs: 1_000,
  // From /api/bootstrap: the most one file may be, or null for no limit.
  maxTransferBytes: null,
  snapshot: null,
  selectedPaneId: initialPanePreference,
  preferredPaneId: initialPanePreference,
  snapshotBusy: false,
  lastOutputRequestAt: 0,
  desktopSidebarCollapsed: false,
  navigatorTab: "sessions",
  mobileSidebarOpen: false,
  // The pane on screen, attached or mirrored, and a mirrored pane's text.
  // While a grid shows the selected pane's tab it is that pane, in its cell,
  // and `renderedGrid` is true.
  renderedPaneId: null,
  renderedGrid: false,
  mirrored: null,
  outputBurstUntil: 0,
  inputHistoryByPane: initialInputHistories,
  inputHistoryCursor: null,
  inputHistoryDraft: "",
  collapsedWorkspaceIds: initialCollapsedWorkspaceIds,
  collapsedGroupIds: initialCollapsedGroupIds,
  // Split sessions whose pane list is open under their row; folded otherwise.
  expandedSplitTabIds: initialExpandedSplitTabIds,
  editingWorkspaceId: null,
  editingServerId: null,
  editingTabId: null,
  mutationBusy: false,
  openActionMenuId: null,
  createProjectSessionId: null,
  terminalFontSize: initialTerminalFontSize,
  authenticated: false,
  pollingStarted: false,
  connection: { kind: "pending", text: "Connecting" },
  acknowledgedCompletions: initialAcknowledgedCompletions,
  launchToken: readLaunchToken(launchSessionStorage),
  pushPublicKey: null,
  pushSubscription: null,
  pushBusy: false,
  authRequired: false,
  passkeyAvailable: false,
  passkeyBusy: false,
  sessionsBusy: false,
  passkeyAutoStarted: false,
  // The pane whose terminal was let go while its chat stayed on screen.
  terminalParked: null,
  // This PC's own Connect PC port, { address, allowed }, or null when closed.
  connectPc: null,
  // Split tabs shown as a grid of their panes (tab id -> "grid"); any other
  // tab shows its selected pane alone.
  paneViews: new Map(),
  // The pane last selected in each split tab (tab id -> pane id), so a split
  // session's row on a phone opens where the user was.
  lastPaneOfTab: new Map(),
};

const {
  snapshotRecords, newProjectHerdrSession, syncCreateProjectAvailability, herdrSessionForServer,
  agentForPane, visibleStatusForPane, acknowledgePaneCompletion, pruneAcknowledgedCompletions,
} = createSnapshotModel({ state, elements, storage: panePreferenceStorage });

// Made after `state`, which its listeners read. Nothing above calls these.
const notificationNavigation = createNotifications({
  state,
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  shownGrid: (...args) => shownGrid(...args),
});
const {
  acceptNotificationTarget, receiveNotificationRelay, completeNotificationRelay, restoreNotificationTarget,
} = notificationNavigation;

// Made right after `state`, which it reads, and before anything at the top
// level hands `api` on (createSettingsMenu below does, for the Update panel).
const { api, transferRequest, conversationRequest } = createApiClient({
  launchToken: () => state.launchToken,
  csrfToken: () => state.csrfToken,
  onAuthenticationRequired: () => {
    state.launchToken = clearLaunchToken(launchSessionStorage);
    showLogin();
  },
});
const paneCalls = paneApi(api);

// The list above the composer: `@` file references (names in the pane's
// folder) and, at the start of the text, the `/` commands of the pane's
// agent. Its keys come first in the composer's keydown, so a row picked with
// Enter is never also sent.
const composerPopup = createComposerPopup({
  input: elements.terminalInput,
  listElement: elements.composerFiles,
  sources: [
    atFilesSource({
      context: () => {
        const paneId = state.selectedPaneId;
        if (!paneId) return null;
        const pane = selectedRecords().pane;
        const cwd = pane?.foreground_cwd || pane?.cwd;
        if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
        return { server: paneServerId(paneId) || "local", cwd };
      },
      // The Files tab's own request, for the pane's machine instead of the tab's.
      fetchListing: (server, path, prefix) => fetchListing(path, { prefix, server }),
    }),
    slashCommandsSource({
      context: () => {
        const paneId = state.selectedPaneId;
        if (!paneId) return null;
        const pane = selectedRecords().pane;
        return { paneId, agent: chatAgent(pane, agentForPane(paneId)), cwd: pane?.foreground_cwd || pane?.cwd || null };
      },
      fetchCommands: (paneId) => paneCalls.commands(paneId),
    }),
  ],
});

// Dragging in the sidebar: what was dropped shows where it landed at once,
// and goes back with a word if Herdr refuses.
let navigationRedrawHeld = false;
const sidebarDrag = attachSidebarDrag(elements.workspaceList, {
  canStart: () => !state.mutationBusy && !renameIsOpen() &&
    !document.body.classList.contains("sidebar-collapsed"),
  onEnd: () => { if (navigationRedrawHeld) renderNavigation(); },
  onDropTab: (drop) => void moveSidebarItem(
    tabMoveRequest(state.snapshot, drop),
    (request) => `/api/tabs/${encodeURIComponent(request.tabId)}/move`,
    () => movedTabSnapshot(state.snapshot, drop),
  ),
  onDropWorkspace: (drop) => void moveSidebarItem(
    workspaceMoveRequest(state.snapshot, drop),
    (request) => `/api/workspaces/${encodeURIComponent(request.workspaceId)}/move`,
    () => movedWorkspaceSnapshot(state.snapshot, drop),
  ),
  paneTargets: ({ tabId }) => paneDropTargets(tabId),
  onDropPane: (drop) => dropOnPane(drop),
});

const desktopMedia = window.matchMedia("(min-width: 761px)");
const primaryTouchMedia = window.matchMedia("(pointer: coarse) and (hover: none)");
const anyCoarsePointerMedia = window.matchMedia("(any-pointer: coarse)");
const anyHoverMedia = window.matchMedia("(any-hover: hover)");
const compactInputMedia = window.matchMedia("(max-width: 1024px)");
let sidebarAnimationTimer;
let terminalFontWheelDelta = 0;
let terminalInputResizeTimer = null;

const COMPOSER_RESIZE_DELAY_MS = 300;
const OUTPUT_SUBMISSION_BURST_MS = 3_000;
const OUTPUT_SUBMISSION_RETRY_MS = 250;
// Check deadlines often enough to honor the 300ms post-submission cadence.
const OUTPUT_POLL_TICK_MS = 100;

// The composer's Enter on a touch device (see enter-key-preference.js), and
// whether this page has seen a physical keyboard type. The sighting lasts for
// the page only, so a keyboard unplugged later does not leave the on-screen
// keyboard without a way to break a line after a reload.
let enterKeyMode = readEnterKeyMode(browserStorage());
let physicalKeyboardSeen = false;
document.addEventListener("keydown", (event) => {
  if (!physicalKeyboardSeen && looksLikePhysicalKey(event)) physicalKeyboardSeen = true;
}, { capture: true, passive: true });

function usesTouchInputEnvironment() {
  return detectTouchInput({
    primaryTouch: primaryTouchMedia.matches,
    anyCoarsePointer: anyCoarsePointerMedia.matches,
    anyHover: anyHoverMedia.matches,
    maxTouchPoints: navigator.maxTouchPoints,
    compactViewport: compactInputMedia.matches,
  });
}

function clearSidebarAnimationState() {
  window.clearTimeout(sidebarAnimationTimer);
  document.body.classList.remove("sidebar-animating");
}

function markSidebarAnimating() {
  window.clearTimeout(sidebarAnimationTimer);
  document.body.classList.add("sidebar-animating");
  sidebarAnimationTimer = window.setTimeout(clearSidebarAnimationState, 400);
}

function syncSidebar() {
  const presentation = sidebarPresentation({
    isDesktop: desktopMedia.matches,
    desktopCollapsed: state.desktopSidebarCollapsed,
    mobileOpen: state.mobileSidebarOpen,
  });
  document.body.classList.toggle("sidebar-collapsed", presentation.collapsed);
  document.body.classList.toggle(
    "sidebar-open",
    !desktopMedia.matches && presentation.open,
  );
  elements.navigator.inert = presentation.navigatorInert;
  applyNavigatorPanels();
  elements.sidebarToggle.setAttribute("aria-expanded", String(presentation.toggleExpanded));
  elements.sidebarToggle.setAttribute("aria-label", presentation.toggleLabel);
  elements.sidebarToggle.title = presentation.toggleLabel;
  elements.mobileSidebarOpen.setAttribute("aria-expanded", String(presentation.open));
}

async function dismissDeliveredNotifications() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (typeof registration.getNotifications !== "function") return;
    for (const notification of await registration.getNotifications()) {
      notification.close();
    }
  } catch {
    // Tidying notifications is best effort and never blocks the app.
  }
}

function showLogin() {
  forgetComposerDrafts();
  terminalStream.pause();
  paneGrid.pause();
  state.authenticated = false;
  document.body.classList.remove("auth-pending", "auth-ready");
  document.body.classList.add("auth-required");
  elements.shell.inert = true;
  elements.loginScreen.hidden = false;
  renderLoginMethods();
  // Let the revealed login screen participate in layout before requesting IME
  // focus, as in the original password login flow.
  window.requestAnimationFrame(() => {
    if (!elements.loginScreen.contains(document.activeElement)) focusLoginMethod();
  });
  startAutomaticPasskeyLogin();
}

function focusLoginMethod() {
  if (state.authenticated || elements.loginScreen.hidden || state.passkeyBusy) return;
  if (currentLoginMethod() === "passkey") {
    elements.passkeyLogin.focus({ preventScroll: true });
  } else {
    focusLoginPassword();
  }
}

function restoreLoginFocus() {
  if (document.hidden || state.authenticated || elements.loginScreen.hidden) return;
  const active = document.activeElement;
  // Preserve the user's chosen control; restore only missing login focus.
  if ((active === elements.loginPassword && currentLoginMethod() === "password") ||
      !elements.loginScreen.contains(active)) {
    focusLoginMethod();
  }
  startAutomaticPasskeyLogin();
}

function startAutomaticPasskeyLogin() {
  if (document.hidden || state.authenticated || elements.loginScreen.hidden ||
      currentLoginMethod() !== "passkey" ||
      state.passkeyAutoStarted || state.passkeyBusy ||
      !state.passkeyAvailable || !supportsPasskeys()) return;
  state.passkeyAutoStarted = true;
  void startPasskeyLogin();
}

function focusLoginPassword() {
  if (state.authenticated || elements.loginScreen.hidden || elements.loginPassword.disabled) return;
  elements.loginPassword.focus();
  // Android may focus the DOM input without opening its software keyboard.
  // Keyboard display still depends on browser policy and user activation.
  if (usesTouchInputEnvironment()) {
    try { navigator.virtualKeyboard?.show(); } catch { /* Native input remains usable. */ }
  }
}

function focusComposer() {
  if (!desktopMedia.matches || usesTouchInputEnvironment() ||
      !state.authenticated || elements.terminalInput.disabled) return;
  elements.terminalInput.focus({ preventScroll: true });
}

function showApplication() {
  state.authenticated = true;
  document.body.classList.remove("auth-pending", "auth-required");
  document.body.classList.add("auth-ready");
  elements.shell.inert = false;
  elements.loginScreen.hidden = true;
  elements.loginFeedback.textContent = "";
  // A grid left open over the sign-in connects its cells again.
  if (!document.hidden) {
    paneGrid.resume();
    viewGrid.resume();
  }
}

function supportsPasskeys() {
  try {
    return window.isSecureContext &&
      window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn?.() === true;
  } catch {
    return false;
  }
}

async function completePasskeyLogin(ceremony, credential) {
  // Ignore a result if another login path already established the session.
  if (state.authenticated) return;
  const login = await api("/api/auth/passkeys/login/verify", {
    method: "POST",
    csrf: false,
    body: { attemptId: ceremony.attemptId, credential },
  });
  state.launchToken = writeLaunchToken(launchSessionStorage, login.launchToken);
  rememberLoginMethod("passkey");
  state.passkeyAvailable = true;
  elements.loginPassword.value = "";
  await initializeApplication();
}

function renderLoginMethods() {
  const presentation = loginMethodPresentation({
    passkeyAvailable: state.passkeyAvailable,
    passkeySupported: supportsPasskeys(),
  });
  elements.passkeyLogin.hidden = !presentation.passkeyVisible;
  elements.passkeyLogin.disabled = state.passkeyBusy;
  elements.passkeyLogin.classList.toggle("primary-button", presentation.passkeyPrimary);
  elements.passkeyLogin.classList.toggle("secondary-button", !presentation.passkeyPrimary);
  elements.loginSubmit.classList.toggle("primary-button", presentation.passwordPrimary);
  elements.loginSubmit.classList.toggle("secondary-button", !presentation.passwordPrimary);
  elements.loginInstruction.textContent = presentation.instruction;
  elements.loginPasswordLabel.textContent = presentation.passwordLabel;
  return presentation;
}

function setLoginBusy(busy) {
  state.passkeyBusy = busy;
  elements.loginPassword.disabled = busy;
  elements.loginSubmit.disabled = busy;
  renderLoginMethods();
}

function passkeyErrorMessage(error) {
  if (error?.name === "NotAllowedError") {
    return "The passkey request was canceled or timed out.";
  }
  return error?.message || "The passkey request failed.";
}

// Adding or removing a passkey needs the password; asking for it before
// anything else keeps the device prompt from opening for a request the server
// will refuse.
function enteredPassword(input, feedback) {
  if (input.value) return input.value;
  feedback.textContent = "Enter your password first.";
  feedback.dataset.error = "true";
  input.focus();
  return null;
}

function offerPasskeyRegistration() {
  if (!supportsPasskeys() || state.passkeyAvailable || elements.passkeyDialog.open) return;
  elements.passkeyDialogFeedback.textContent = "";
  elements.passkeyDialogFeedback.dataset.error = "false";
  elements.passkeyDialogPassword.value = "";
  // Offered right after a password sign-in, which the server still counts as
  // fresh; the field only appears if it no longer does.
  elements.passkeyDialogPasswordField.hidden = true;
  elements.passkeyDialog.showModal();
}

// The password goes with the request that starts the ceremony; the server
// checks it before it hands out a challenge.
async function registerPasskey(password) {
  const ceremony = await api("/api/auth/passkeys/register/options", {
    method: "POST",
    body: { password },
  });
  const credential = await window.SimpleWebAuthnBrowser.startRegistration({
    optionsJSON: ceremony.options,
  });
  await api("/api/auth/passkeys/register/verify", {
    method: "POST",
    body: { attemptId: ceremony.attemptId, credential },
  });
  state.passkeyAvailable = true;
}

function closeMobileSidebar({ restoreFocus = false } = {}) {
  if (desktopMedia.matches || !state.mobileSidebarOpen) return;
  state.mobileSidebarOpen = false;
  syncSidebar();
  if (restoreFocus) elements.mobileSidebarOpen.focus();
}

// This machine's row carries whether this page can reach HerdRabbit at all --
// what a separate footer dot used to say. A linked machine's row keeps saying
// only whether HerdRabbit reaches it.
function serverConnection(server) {
  return serverConnectionState(server, state.connection);
}

function setConnection(kind, text) {
  state.connection = { kind, text };
  // The row is updated in place: a rename in progress holds off a full redraw.
  const heading = document.querySelector('.server-heading[data-server-id="local"]');
  if (!heading) return;
  const local = snapshotRecords().servers.find((item) => item.id === "local") ??
    { id: "local", available: kind === "online", status: text };
  const connection = serverConnection(local);
  heading.classList.toggle("is-online", connection.online);
  heading.classList.toggle("is-error", connection.error);
  heading.title = `${heading.dataset.serverName}: ${connection.text}`;
  heading.setAttribute("aria-label", heading.title);
}

function setFeedback(text, isError = false) {
  elements.actionFeedback.textContent = text;
  elements.actionFeedback.dataset.error = String(isError);
}
import { createSettingsMenu } from "./app/settings-menu.js?v=1.4.23";
const {
  settingsMenu, buildSettingsMenu, syncSettingsMenu, updatePanel, syncThemeItem,
  renderNotificationItem, syncPushSubscription,
} = createSettingsMenu({
  state,
  elements,
  api,
  snapshotRecords: (...args) => snapshotRecords(...args),
  setFeedback: (...args) => setFeedback(...args),
  panePreferenceStorage,
  desktopMedia,
  get paneGrid() { return paneGrid; },
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  openKeyBarDialog: (...args) => openKeyBarDialog(...args),
  showPasskeys: (...args) => showPasskeys(...args),
  showSessions: (...args) => showSessions(...args),
});

// On a Herdr grid whose cells keep their panes' sizes the text size steps the
// grid's own font, from the one its cells have now; the size chosen for a
// single pane stays as it is. A grid fitted to the window reads at that size.
function adjustTerminalFont(direction) {
  if (paneGrid.adjustFont(direction)) return;
  applyTerminalFontSize(adjustedTerminalFontSize(state.terminalFontSize, direction));
}

function applyTerminalFontSize(nextSize) {
  state.terminalFontSize = nextSize;
  document.documentElement.style.setProperty(
    "--terminal-font-size",
    `${nextSize}px`,
  );
  writeTerminalFontSize(panePreferenceStorage, nextSize);
  syncComposerExpanded({ defer: true });
  resizeTerminalInput();
  attachedTerminal.setFontSize(nextSize);
  paneGrid.setFontSize(nextSize);
  viewGrid.setFontSize(nextSize);
}


// Each pane keeps the message typed but not sent. The textarea shows the
// selected pane's; switching panes saves it and brings the other pane's back.
// A draft is dropped before it is sent, and a text the server calls
// a password answer is never stored.
let draftPaneId = null;
let draftSaveTimer = null;
const draftBlocked = new Set(); // panes whose composer text must not be stored
const draftHeld = new Set(); // panes with a message on its way
import { createComposer } from "./app/composer.js?v=1.4.23";
const {
  resizeTerminalInput,
  syncComposerExpanded,
  scheduleTerminalInputResize,
  resetInputHistoryNavigation,
  saveComposerDraft,
  scheduleComposerDraftSave,
  syncComposerDraft,
  holdComposerDraft,
  releaseComposerDraft,
  rememberSentInput,
} = createComposer({
  state,
  elements,
  panePreferenceStorage,
  composerDrafts,
  composerPopup,
  draftBlocked,
  draftHeld,
  getDraftPaneId: () => draftPaneId,
  setDraftPaneId: (value) => { draftPaneId = value; },
  getDraftSaveTimer: () => draftSaveTimer,
  setDraftSaveTimer: (value) => { draftSaveTimer = value; },
  getTerminalInputResizeTimer: () => terminalInputResizeTimer,
  setTerminalInputResizeTimer: (value) => { terminalInputResizeTimer = value; },
  COMPOSER_RESIZE_DELAY_MS,
});

function sidebarActionMenu({
  id, label, actions, className = "", escapesOverflow = false,
  icon = ["M6 12h.01M12 12h.01M18 12h.01"], iconClass = "more-icon", summaryClass = "",
}) {
  const details = createElement("details", {
    className: `sidebar-action-menu ${className}`.trim(),
  });
  details.dataset.menuId = id;
  details.open = state.openActionMenuId === id;
  const summary = createElement("summary", {
    className: `workspace-action ${summaryClass}`.trim(),
  });
  summary.setAttribute("aria-label", label);
  summary.title = label;
  summary.append(createIcon(icon, iconClass));
  const popover = createElement("div", {
    className: "sidebar-action-popover",
  });
  popover.setAttribute("role", "menu");
  // A list that scrolls clips whatever is positioned inside it, and the uploads
  // list is one. The top layer is outside every such box, so the menu opens
  // over the dialog instead of being cut off at the row.
  if (escapesOverflow) {
    popover.setAttribute("popover", "auto");
    popover.classList.add("is-floating");
    popover.addEventListener("toggle", (event) => {
      // Clicking away closes the popover without telling the details element.
      if (event.newState === "closed" && details.open) details.open = false;
    });
  }

  for (const action of actions) {
    if (action.separator) {
      const rule = createElement("div", { className: "sidebar-action-separator" });
      rule.setAttribute("role", "separator");
      if (action.key) rule.dataset.separator = action.key;
      popover.append(rule);
      continue;
    }
    const button = createElement("button", {
      className: `sidebar-action-item ${action.danger ? "is-danger" : ""}`.trim(),
    });
    button.type = "button";
    button.setAttribute("role", "menuitem");
    if (action.key) button.dataset.action = action.key;
    button.append(
      createIcon(action.paths),
      createElement("span", { text: action.label }),
    );
    button.addEventListener("click", () => {
      details.open = false;
      state.openActionMenuId = null;
      action.onSelect(button);
    });
    popover.append(button);
  }

  details.addEventListener("toggle", () => {
    if (details.open) {
      state.openActionMenuId = id;
      // Document-wide: the sidebar is no longer the only place with menus.
      for (const other of document.querySelectorAll(".sidebar-action-menu[open]")) {
        if (other !== details) other.open = false;
      }
      if (escapesOverflow) placeFloatingMenu(popover, summary);
    } else {
      if (escapesOverflow && popover.matches(":popover-open")) popover.hidePopover();
      if (state.openActionMenuId === id) state.openActionMenuId = null;
    }
  });
  details.append(summary, popover);
  return details;
}

function paneBelongsToWorkspace(pane, workspaceId) {
  if (idOf(pane, "workspace_id", "workspaceId") === workspaceId) return true;
  const tabId = idOf(pane, "tab_id", "tabId");
  return snapshotRecords().tabs.some(
    (tab) =>
      idOf(tab, "tab_id", "id") === tabId &&
      idOf(tab, "workspace_id", "workspaceId") === workspaceId,
  );
}

function adoptMutationSnapshot(snapshot, preferredPaneId = null) {
  const previousPaneId = state.selectedPaneId;
  state.snapshot = snapshot || {};
  if (preferredPaneId) {
    state.selectedPaneId = preferredPaneId;
    state.preferredPaneId = preferredPaneId;
  }
  choosePane();
  syncCreateProjectAvailability();
  renderNavigation();
  const selected = selectedRecords();
  renderPaneHeading(selected.pane, selected.tab, selected.workspace);
  if (previousPaneId !== state.selectedPaneId) {
    showTerminalMessage(
      state.selectedPaneId ? "Loading output…" : "No open sessions.",
    );
  }
  void refreshTerminal();
}

async function createShellSession(workspaceId, button) {
  if (state.mutationBusy) return;
  state.mutationBusy = true;
  button.disabled = true;
  const previousPaneIds = new Set(
    snapshotRecords().panes.map((pane) => idOf(pane, "pane_id", "id")),
  );
  setFeedback("");
  try {
    const payload = await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/tabs`,
      { method: "POST", body: {} },
    );
    state.snapshot = payload.snapshot || {};
    const newPane = snapshotRecords().panes.find(
      (pane) =>
        !previousPaneIds.has(idOf(pane, "pane_id", "id")) &&
        paneBelongsToWorkspace(pane, workspaceId),
    );
    state.collapsedWorkspaceIds.delete(workspaceId);
    writeCollapsedWorkspaceIds(panePreferenceStorage, state.collapsedWorkspaceIds);
    adoptMutationSnapshot(
      state.snapshot,
      newPane ? idOf(newPane, "pane_id", "id") : null,
    );
    closeMobileSidebar();
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
    button.disabled = false;
  }
}

async function closeSession(tab, label, button) {
  const tabId = idOf(tab, "tab_id", "id");
  const workspaceId = idOf(tab, "workspace_id", "workspaceId");
  if (
    !tabId ||
    state.mutationBusy ||
    !window.confirm(`Close session “${label}”? This will also stop any running processes.`)
  ) return;
  state.mutationBusy = true;
  button.disabled = true;
  setFeedback("");
  try {
    const payload = await api(`/api/tabs/${encodeURIComponent(tabId)}/close`, {
      method: "POST",
      body: { confirmed: true },
    });
    state.snapshot = payload.snapshot || {};
    const fallbackPane = snapshotRecords().panes.find((pane) =>
      paneBelongsToWorkspace(pane, workspaceId),
    );
    adoptMutationSnapshot(
      state.snapshot,
      fallbackPane ? idOf(fallbackPane, "pane_id", "id") : null,
    );
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
    button.disabled = false;
  }
}

async function closeProject(workspaceId, workspaceLabel, button) {
  if (
    state.mutationBusy ||
    !window.confirm(`Close project “${workspaceLabel}”? This will close all of its sessions and stop any running processes.`)
  ) return;
  state.mutationBusy = true;
  button.disabled = true;
  setFeedback("");
  try {
    const payload = await api(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/close`,
      { method: "POST", body: { confirmed: true } },
    );
    state.collapsedWorkspaceIds.delete(workspaceId);
    writeCollapsedWorkspaceIds(panePreferenceStorage, state.collapsedWorkspaceIds);
    adoptMutationSnapshot(payload.snapshot);
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
    button.disabled = false;
  }
}

function stopWorkspaceRename() {
  state.editingWorkspaceId = null;
  setFeedback("");
  renderNavigation();
}

// Three things in the sidebar can be renamed, and a rename is the same
// interaction each time: type, Enter or the check to keep it, Esc or the cross
// to drop it, controls locked while it is in flight. Written out three times
// the copies drifted -- the newest one lost Esc and kept a stale validity
// message -- so they share one form and can only drift together.
function renameForm({ value, label, placeholder = "", maxLength, invalidMessage, allowEmpty = false, onCancel, onSubmit }) {
  const form = createElement("form", { className: "workspace-rename-form" });
  const input = createElement("input", { className: "workspace-rename-input" });
  input.type = "text";
  input.value = value;
  input.maxLength = maxLength;
  input.required = !allowEmpty;
  if (placeholder) input.placeholder = placeholder;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => input.setCustomValidity(""));
  const saveButton = workspaceActionButton({
    className: "workspace-rename-save",
    label: `Save ${label}`,
    paths: ["M5 12l4 4L19 6"],
    type: "submit",
  });
  const cancelButton = workspaceActionButton({
    className: "workspace-rename-cancel",
    label: "Cancel rename",
    paths: ["M6 6l12 12M18 6 6 18"],
  });
  const controls = [input, saveButton, cancelButton];
  cancelButton.addEventListener("click", onCancel);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const next = input.value.trim();
    if (!next && !allowEmpty) {
      input.setCustomValidity(invalidMessage);
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    for (const control of controls) control.disabled = true;
    setFeedback("");
    try {
      await onSubmit(next);
    } catch (error) {
      for (const control of controls) control.disabled = false;
      setFeedback(error.message, true);
      input.focus();
    }
  });
  form.append(input, saveButton, cancelButton);
  window.requestAnimationFrame(() => { input.focus(); input.select(); });
  return form;
}

function workspaceHeading(group, workspace, workspaceLabel, children) {
  const workspaceId = idOf(workspace, "workspace_id", "id");
  const collapsed = state.collapsedWorkspaceIds.has(workspaceId);
  const editing = state.editingWorkspaceId === workspaceId;
  const heading = createElement("div", {
    className: `workspace-heading${editing ? " is-editing" : ""}`,
  });
  const collapseButton = workspaceActionButton({
    className: "workspace-collapse",
    label: collapsed ? `Expand ${workspaceLabel}` : `Collapse ${workspaceLabel}`,
    paths: ["M9 18l6-6-6-6"],
  });
  collapseButton.setAttribute("aria-expanded", String(!collapsed));
  collapseButton.setAttribute("aria-controls", children.id);
  collapseButton.addEventListener("click", () => {
    if (state.collapsedWorkspaceIds.has(workspaceId)) {
      state.collapsedWorkspaceIds.delete(workspaceId);
    } else {
      state.collapsedWorkspaceIds.add(workspaceId);
    }
    const isNowCollapsed = state.collapsedWorkspaceIds.has(workspaceId);
    group.classList.toggle("is-collapsed", isNowCollapsed);
    children.inert = isNowCollapsed;
    children.setAttribute("aria-hidden", String(isNowCollapsed));
    collapseButton.setAttribute("aria-expanded", String(!isNowCollapsed));
    const nextLabel = isNowCollapsed
      ? `Expand ${workspaceLabel}`
      : `Collapse ${workspaceLabel}`;
    collapseButton.setAttribute("aria-label", nextLabel);
    collapseButton.title = nextLabel;
    writeCollapsedWorkspaceIds(
      panePreferenceStorage,
      state.collapsedWorkspaceIds,
    );
  });
  heading.append(collapseButton);

  if (editing) {
    heading.append(renameForm({
      value: workspaceLabel,
      label: `${workspaceLabel} project name`,
      maxLength: 120,
      invalidMessage: "Enter a project name.",
      onCancel: stopWorkspaceRename,
      onSubmit: async (label) => {
        await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/rename`, {
          method: "POST",
          body: { label },
        });
        const currentWorkspace = snapshotRecords().workspaces.find(
          (item) => idOf(item, "workspace_id", "id") === workspaceId,
        );
        if (currentWorkspace) currentWorkspace.label = label;
        state.editingWorkspaceId = null;
        renderNavigation();
        const selected = selectedRecords();
        renderPaneHeading(selected.pane, selected.tab, selected.workspace);
      },
    }));
  } else {
    heading.append(createElement("h3", { text: workspaceLabel }));
    heading.append(sidebarActionMenu({
      id: `workspace-${workspaceId}`,
      label: `More actions for ${workspaceLabel}`,
      actions: [
        {
          label: "Rename",
          paths: [
            "M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z",
            "M14.5 7.5l3 3",
          ],
          onSelect: () => {
            state.editingWorkspaceId = workspaceId;
            setFeedback("");
            renderNavigation();
          },
        },
        {
          label: "New session",
          paths: ["M12 5v14M5 12h14"],
          onSelect: (button) => void createShellSession(workspaceId, button),
        },
        {
          label: "Close project",
          paths: ["M6 6l12 12M18 6 6 18"],
          danger: true,
          onSelect: (button) => void closeProject(
            workspaceId,
            workspaceLabel,
            button,
          ),
        },
      ],
    }));
  }
  return heading;
}

// Small marks drawn here for each kind of program a row can run: simple
// shapes that suggest the program, not its published artwork.
const AGENT_MARKS = Object.freeze({
  claude: { box: "#d9774f", strokes: ["M12 5v14M5 12h14M7.1 7.1l9.8 9.8M16.9 7.1l-9.8 9.8"], color: "#ffffff", width: 1.9 },
  // six rounded petals turned 60 degrees apart, overlapping into a knot
  codex: { strokes: ["M12 2.6c2.3 0 3.6 2.3 3.6 4.7S14.2 12 12 12s-3.6-2.3-3.6-4.7S9.7 2.6 12 2.6z"], turns: 6, width: 1.4 },
  agy: { strokes: ["M6.5 19.5L12 5l5.5 14.5", "M3.5 14c4-2.4 13-2.4 17 0"], width: 1.8 },
  // OpenCode's mark: a pixelated "O" — outer ring with an inner block,
  // the same shape as the published favicon
  opencode: { box: "#131010", fills: [{ d: "M6 4.5h12v15H6V4.5ZM9 7.5v9h6v-9H9Z", color: "#ffffff" }, { d: "M9 10.5h6v6H9v-6Z", color: "#5A5858" }] },
  // Cursor's mark: a text caret on a dark field, the terminal cursor it is named for
  cursor: { box: "#111111", strokes: ["M9 5h6M9 19h6M12 5v14"], color: "#ffffff", width: 1.9 },
  // Kiro's Ghostie mark on its brand violet (from ovis / devswha, MIT)
  kiro: { box: "#9046FF", fills: [
    { d: "M8 16.4c-1.7 3.6 1.8 4.5 4.4 2.4.8 2.4 3.6.6 4.6-1.2 2.3-4.1 1.4-8.3 1.2-9.2-1.6-5.8-9.6-5.8-11 0q-.4 1.7-.5 3.5l-.4 1.7-.6 1.2c-.5.9-.3 2.5 2 1.7z", color: "#ffffff" },
    { d: "M12.7 11c-.6 0-.7-.8-.7-1.3q0-.6.2-1l.5-.2q.5 0 .6.3l.2 1q0 1.1-.8 1.2m2.7 0c-.6 0-.7-.8-.7-1.3q0-.6.2-1l.5-.2q.5 0 .6.3.3.3.2 1 0 1.1-.8 1.2", color: "#9046FF" },
  ] },
  other: { strokes: ["M12 3c.7 5 2 6.3 7 7-5 .7-6.3 2-7 7-.7-5-2-6.3-7-7 5-.7 6.3-2 7-7z", "M19 17v4M17 19h4"], width: 1.6 },
  shell: { strokes: ["M5 8l5 4-5 4", "M13 17h6"], width: 1.9 },
});

function agentMark(kind) {
  const mark = AGENT_MARKS[kind] || AGENT_MARKS.shell;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `agent-icon agent-icon-${kind in AGENT_MARKS ? kind : "shell"}`);
  if (mark.box) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", "1");
    rect.setAttribute("y", "1");
    rect.setAttribute("width", "22");
    rect.setAttribute("height", "22");
    rect.setAttribute("rx", "6");
    rect.setAttribute("fill", mark.box);
    svg.append(rect);
  }
  if (mark.fills) {
    for (const { d, color } of mark.fills) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", color || "currentColor");
      path.setAttribute("fill-rule", "evenodd");
      svg.append(path);
    }
    return svg;
  }
  for (const d of mark.strokes) for (let turn = 0; turn < (mark.turns || 1); turn += 1) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    if (turn > 0) path.setAttribute("transform", `rotate(${(360 / mark.turns) * turn} 12 12)`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", mark.color || "currentColor");
    path.setAttribute("stroke-width", String(mark.width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

function paneButton(pane, tab, workspace, { namesSession = false } = {}) {
  const paneId = idOf(pane, "pane_id", "id");
  const agent = agentForPane(paneId);
  const currentAgentStatus = visibleStatusForPane(paneId, agent, pane);
  const workspaceLabel = displayRecordLabel(workspace, "Project");
  const tabLabel = displayTabLabel(tab);
  const agentLabel = displayRecordLabel(agent, displayRecordLabel(pane, "Terminal"));
  // Once a session has a name, that name is what it is; the agent running in it
  // is a detail that changes under you, so it steps back next to the status.
  const sessionName = namesSession ? tabLabel : "";
  const kind = paneAgentKind(pane, agent);
  const statusText = agentStatusLabel(currentAgentStatus);
  const button = createElement("button", { className: "pane-button" });
  button.type = "button";
  button.dataset.paneId = paneId;
  button.dataset.status = currentAgentStatus;
  button.setAttribute("aria-pressed", String(paneId === state.selectedPaneId));

  button.setAttribute(
    "aria-label",
    `${agentLabel}, ${statusText}, ${[workspaceLabel, tabLabel].filter(Boolean).join(" / ")}`,
  );
  button.title = `${[sessionName, agentLabel].filter(Boolean).join(" · ")} · ${statusText}`;

  button.append(agentMark(kind));

  const title = paneDisplayTitle(sessionName, pane, tabLabel || "Terminal", agent);
  const copy = createElement("span", { className: "pane-copy" });
  copy.append(createElement("strong", { className: "pane-title", text: title }));
  const subtitle = paneSubtitle(title, pane);
  if (subtitle) copy.append(createElement("small", { className: "pane-cwd", text: subtitle }));
  button.append(copy);

  // Always present, so the row's text and menu stay put whatever the status.
  const status = createElement("span", {
    className: `pane-status ui-status state-${currentAgentStatus}`,
    text: agentStatusIcon(currentAgentStatus),
  });
  status.setAttribute("aria-hidden", "true");
  button.append(status);

  // A row opens its pane alone, even in a split tab: the split session's own row opens the grid.
  // A pane that is a tile of this window's view split is focused there instead.
  button.addEventListener("click", () => {
    if (desktopMedia.matches && viewTiles(viewSplit.tree).includes(paneId)) {
      selectPane(paneId, { view: "tiles" });
      viewGrid.focus(paneId, { terminal: false });
    } else selectPane(paneId, { view: "solo" });
    closeMobileSidebar();
    focusComposer();
  });

  return button;
}

// Server and session headings fold the same way project headings do, so a
// sidebar with several machines can be narrowed down to the one in use.
function attachGroupCollapse(group, heading, body, groupId, label) {
  const collapsed = state.collapsedGroupIds.has(groupId);
  const button = workspaceActionButton({
    className: "group-collapse",
    label: `${collapsed ? "Expand" : "Collapse"} ${label}`,
    paths: ["M9 18l6-6-6-6"],
  });
  button.setAttribute("aria-expanded", String(!collapsed));
  group.classList.toggle("is-collapsed", collapsed);
  body.inert = collapsed;
  body.setAttribute("aria-hidden", String(collapsed));

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (state.collapsedGroupIds.has(groupId)) state.collapsedGroupIds.delete(groupId);
    else state.collapsedGroupIds.add(groupId);
    const now = state.collapsedGroupIds.has(groupId);
    group.classList.toggle("is-collapsed", now);
    body.inert = now;
    body.setAttribute("aria-hidden", String(now));
    button.setAttribute("aria-expanded", String(!now));
    const next = `${now ? "Expand" : "Collapse"} ${label}`;
    button.setAttribute("aria-label", next);
    button.title = next;
    writeCollapsedGroupIds(panePreferenceStorage, state.collapsedGroupIds);
  });
  heading.prepend(button);
}

// Only a PC connected with Connect PC is renamed: this PC is not a connection.
function serverRenameForm(server) {
  return renameForm({
    value: server.name,
    label: `${server.name} machine name`,
    maxLength: 80,
    invalidMessage: "Enter a name.",
    onCancel: () => { state.editingServerId = null; renderNavigation(); },
    onSubmit: async (name) => {
      // The address is not edited here, so it is carried over unchanged.
      await api(`/api/servers/${server.id}`, { method: "PUT", body: { name, address: server.address ?? "" } });
      state.editingServerId = null;
      await refreshSnapshot();
    },
  });
}
import { createAccountDialogs } from "./app/account-dialogs.js?v=1.4.23";
import { createAiAccounts } from "./app/ai-accounts.js?v=1.4.23";

const { showServerDetails, showSessions, showPasskeys, forgetComposerDrafts } = createAccountDialogs({
  state,
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  showLogin: (...args) => showLogin(...args),
  renderLoginMethods: (...args) => renderLoginMethods(...args),
  passkeyErrorMessage: (...args) => passkeyErrorMessage(...args),
  supportsPasskeys: (...args) => supportsPasskeys(...args),
  enteredPassword: (...args) => enteredPassword(...args),
  registerPasskey: (...args) => registerPasskey(...args),
  launchSessionStorage,
  composerDrafts,
  draftBlocked,
  clearComposer: (...args) => clearComposer(...args),
  getDraftSaveTimer: () => draftSaveTimer,
  setDraftSaveTimer: (value) => { draftSaveTimer = value; },
  setDraftPaneId: (value) => { draftPaneId = value; },
});

const { showAiAccounts, resumeAiLogins } = createAiAccounts({
  state,
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  setFeedback: (...args) => setFeedback(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
});

function serverActionMenu(server) {
  const actions = [
    {
      label: "Details",
      paths: ["M12 8h.01", "M11 12h1v4h1", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"],
      onSelect: () => showServerDetails(server),
    },
    // This PC's accounts, or a connected PC's, switched on that PC.
    {
      label: "AI accounts",
      paths: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 20a8 8 0 0 1 16 0"],
      onSelect: () => showAiAccounts(server),
    },
  ];
  // This machine is not a connection: there is nothing to rename or drop.
  if (server.id === "local") {
    return sidebarActionMenu({
      id: `server-${server.id}`,
      label: `More actions for ${server.name}`,
      className: "server-action-menu",
      actions,
    });
  }
  // A PC connected with Connect PC: renamed and dropped here, and found again
  // when it moved to another port.
  return linkActionMenu(server, actions);
}

function linkActionMenu(server, actions) {
  // A PC that moved to another port leaves its entry pointing at the old one,
  // offline for good. Its tailnet address says it is the same PC.
  if (!server.available) {
    actions.push({
      label: "Find new address",
      paths: ["M20 12a8 8 0 1 1-2.3-5.6", "M20 4v5h-5"],
      onSelect: () => void (async () => {
        try {
          setFeedback(`Looking for ${server.name}…`);
          const found = await api("/api/servers/discover", { method: "POST", body: {} });
          const host = new URL(server.address).hostname;
          const moved = array(found.candidates).find((candidate) =>
            candidate.state === "ready" && candidate.address !== server.address &&
            new URL(candidate.address).hostname === host);
          if (!moved) {
            setFeedback(`${server.name} is not answering anywhere on ${host}.`, true);
            return;
          }
          await api(`/api/servers/${server.id}`, {
            method: "PUT", body: { name: server.name, address: moved.address },
          });
          await refreshSnapshot();
          setFeedback(`${server.name} now points at ${moved.address}.`);
        } catch (error) {
          setFeedback(error.message, true);
        }
      })(),
    });
  }
  actions.push(
    {
      label: "Rename",
      paths: ["M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z", "M14.5 7.5l3 3"],
      onSelect: () => { state.editingServerId = server.id; renderNavigation(); },
    },
    {
      label: "Disconnect",
      paths: ["M6 6l12 12M18 6 6 18"],
      danger: true,
      onSelect: () => {
        if (!window.confirm(`Disconnect “${server.name}”? Its sessions keep running there.`)) return;
        void api(`/api/servers/${server.id}`, { method: "DELETE" })
          .then(() => refreshSnapshot())
          .catch((error) => setFeedback(error.message, true));
      },
    },
  );
  return sidebarActionMenu({
    id: `server-${server.id}`,
    label: `More actions for ${server.name}`,
    className: "server-action-menu",
    actions,
  });
}

// A session shows the agent that happens to be running in it, which is not a
// name: it changes under you and two of them read alike. A tab starts out
// numbered, and the number is hidden, so this is the only way to give one.
function tabRenameForm(tab, tabId, tabLabel) {
  // Emptying the field is how a name is taken back off: the session goes back
  // to showing the agent, which is what it showed before it was named.
  const cleared = clearedTabLabel(tab);
  return renameForm({
    value: tabLabel,
    label: "Session name",
    placeholder: cleared === null ? "Session name" : "Session name — empty to clear",
    maxLength: 120,
    invalidMessage: "Enter a session name.",
    allowEmpty: cleared !== null,
    onCancel: () => { state.editingTabId = null; renderNavigation(); },
    onSubmit: async (typed) => {
      const label = typed || cleared;
      await api(`/api/tabs/${encodeURIComponent(tabId)}/rename`, {
        method: "POST",
        body: { label },
      });
      tab.label = label;
      state.editingTabId = null;
      renderNavigation();
      const selected = selectedRecords();
      renderPaneHeading(selected.pane, selected.tab, selected.workspace);
    },
  });
}

// Every redraw of the sidebar asks this, because every redraw would otherwise
// throw away a name being typed. It also clears a rename whose record is gone,
// so a closed session cannot leave the sidebar frozen on its form.
function renameIsOpen() {
  const open = openRenames(
    {
      workspaceId: state.editingWorkspaceId,
      tabId: state.editingTabId,
      serverId: state.editingServerId,
    },
    snapshotRecords(),
  );
  state.editingWorkspaceId = open.workspaceId;
  state.editingTabId = open.tabId;
  state.editingServerId = open.serverId;
  return open.any;
}

function renderNavigation() {
  // A row being held or dragged stays where it is; the redraw waits for the drop.
  if (sidebarDrag.isActive()) {
    navigationRedrawHeld = true;
    return;
  }
  navigationRedrawHeld = false;
  const { servers, herdrSessions, workspaces, tabs, panes } = snapshotRecords();
  // What the tree is made of is decided by navigationModel (ui-model.js); this
  // draws it, with the page's own editing and dragging.
  const tree = navigationModel({
    servers, herdrSessions, workspaces, tabs, panes,
    statusOfPane: (paneId, pane) => visibleStatusForPane(paneId, agentForPane(paneId), pane),
    pageConnection: state.connection,
  });
  elements.workspaceList.replaceChildren();
  // Shown even for this machine alone: its row is where the machine is managed,
  // AI accounts included.
  const serverBodies = new Map();
  for (const node of tree.servers) {
    const server = node.record;
    const group = createElement("section", { className: "server-group" });
    const editingServer = state.editingServerId === server.id;
    const connection = node.connection;
    const heading = createElement("div", {
      className: `server-heading${connection.online ? " is-online" : ""}${connection.error ? " is-error" : ""}${editingServer ? " is-editing" : ""}`,
    });
    heading.dataset.serverId = server.id;
    heading.dataset.serverName = server.name;
    heading.title = `${server.name}: ${connection.text}`;
    heading.setAttribute("aria-label", heading.title);
    heading.append(createIcon(["M4 5h16v11H4z", "M9 20h6", "M12 16v4"], "server-icon"));
    if (editingServer) heading.append(serverRenameForm(server));
    else {
      heading.append(createElement("strong", { text: server.name }));
      // This PC is the host the page is served from; another machine keeps
      // its words for the states a dot cannot tell apart.
      if (node.role === "host") heading.append(createElement("small", { className: "server-role", text: "Host" }));
      else if (node.role) {
        heading.append(createElement("small", { text: node.role === "connecting" ? "Connecting" : "Offline" }));
      }
      const dot = createElement("span", { className: "server-dot" });
      dot.setAttribute("aria-hidden", "true");
      heading.append(dot);
      // A server is managed where it is seen. The dialog is for adding one.
      heading.append(serverActionMenu(server));
    }
    group.append(heading);
    const body = createElement("div", { className: "server-body" });
    if (node.emptyText !== null) body.append(createElement("p", { className: "server-empty", text: node.emptyText }));
    group.append(body);
    attachGroupCollapse(group, heading, body, `server:${server.id}`, server.name);
    serverBodies.set(node.id, body);
    elements.workspaceList.append(group);
  }

  const appendWorkspace = (parent, node) => {
    const workspace = node.record;
    const workspaceId = node.id;
    const group = createElement("section", { className: "workspace-group" });
    group.dataset.workspaceId = workspaceId;
    group.dataset.dropScope = dropScope(workspace);
    const workspaceLabel = displayRecordLabel(workspace, "Project");
    const { hasCompletion, hasRequest } = node;
    const children = createElement("div", { className: "workspace-children" });
    children.id = `workspace-${workspaceId}-children`;
    const childrenInner = createElement("div", {
      className: "workspace-children-inner",
    });
    const collapsed = state.collapsedWorkspaceIds.has(workspaceId);
    group.classList.toggle("is-collapsed", collapsed);
    group.dataset.hasCompletion = String(hasCompletion);
    group.dataset.hasRequest = String(hasRequest);
    children.inert = collapsed;
    children.setAttribute("aria-hidden", String(collapsed));
    group.append(workspaceHeading(group, workspace, workspaceLabel, children));

    for (const { record: tab, id: tabId, panes: tabPanes } of node.tabs) {
      const tabGroup = createElement("div", { className: "tab-group" });
      tabGroup.dataset.tabId = tabId;
      tabGroup.dataset.workspaceId = workspaceId;
      tabGroup.dataset.dropScope = group.dataset.dropScope;
      const tabLabel = displayTabLabel(tab);
      const editingTab = state.editingTabId === tabId;
      const split = tabPanes.length > 1;
      const sessionRow = createElement("div", { className: "session-row" });
      let sessionLabel;
      if (split) {
        // A split session can be put in order within its project, not carried out.
        tabGroup.dataset.split = "true";
        sessionLabel = splitSessionName(tabId, tabLabel, tabPanes);
        const paneList = createElement("div", { className: "split-panes" });
        paneList.id = `split-${tabId.replace(/[^A-Za-z0-9_-]/gu, "_")}-panes`;
        paneList.hidden = !state.expandedSplitTabIds.has(tabId);
        tabGroup.classList.toggle("is-expanded", !paneList.hidden);
        // Each pane says its own name: the session's name is on the row. On
        // this machine each has its own ⋯ with the grid cell's actions.
        const local = isLocalRecord(tabPanes[0]);
        for (const pane of tabPanes) paneList.append(splitPaneRow(pane, tab, workspace, local));
        sessionRow.classList.add("split-session-row");
        if (editingTab) {
          sessionRow.classList.add("is-editing");
          sessionRow.append(tabRenameForm(tab, tabId, tabLabel));
        } else {
          // The arrow takes the place of the row's program mark: laid over the
          // mark's column, first in reading order as it is first on screen.
          sessionRow.append(
            splitDisclosureButton(tabGroup, tabId, sessionLabel, paneList),
            splitSessionButton(tabId, sessionLabel, tabPanes, workspace),
          );
        }
        tabGroup.append(sessionRow, paneList);
      } else {
        // With one pane the pane is the session, so its name belongs in the button.
        const namesSession = Boolean(tabLabel);
        // An unnamed session has no heading to rename in, so renaming makes one.
        if (editingTab) {
          const tabHeading = createElement("div", { className: "tab-heading is-editing" });
          tabHeading.append(tabRenameForm(tab, tabId, tabLabel));
          tabGroup.append(tabHeading);
        }
        const sessionPanes = createElement("div", { className: "session-panes" });
        for (const pane of tabPanes) {
          sessionPanes.append(paneButton(pane, tab, workspace, { namesSession }));
        }
        sessionRow.append(sessionPanes);
        tabGroup.append(sessionRow);
        sessionLabel =
          tabLabel ||
          displayRecordLabel(agentForPane(idOf(tabPanes[0], "pane_id", "id")), "Session");
      }
      const sessionMenu = sidebarActionMenu({
        id: `tab-${tabId}`,
        label: `More actions for ${sessionLabel}`,
        className: "session-action-menu",
        actions: [
          {
            label: "Rename",
            paths: ["M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z", "M14.5 7.5l3 3"],
            onSelect: () => {
              state.editingTabId = tabId;
              setFeedback("");
              renderNavigation();
            },
          },
          // Gives the panes equal shares of the session, and undoes the
          // split: each pane but the first becomes a session of its own.
          // This machine's only, as the grid's actions are.
          ...(split && isLocalRecord(tabPanes[0]) ? [{
            key: "even-layout",
            label: "Even out layout",
            paths: EVEN_ICON,
            onSelect: () => void evenOutLayout(idOf(tabPanes[0], "pane_id", "id")),
          }, {
            key: "separate-all",
            label: "Separate all panes",
            paths: SEPARATE_ICON,
            onSelect: () => void separateSplitSession(tabId, sessionLabel),
          }] : []),
          {
            label: "Close session",
            paths: ["M6 6l12 12M18 6 6 18"],
            danger: true,
            onSelect: (button) => void closeSession(
              tab,
              sessionLabel,
              button,
            ),
          },
        ],
      });
      if (!sessionRow.classList.contains("is-editing")) sessionRow.append(sessionMenu);
      childrenInner.append(tabGroup);
    }
    children.append(childrenInner);
    group.append(children);
    parent.append(group);
  };

  const appendSession = (parent, node) => {
    const session = node.record;
    const sessionGroup = createElement("section", {
      className: "herdr-session-group",
    });
    const sessionHeading = createElement("div", {
      className: "herdr-session-heading",
    });
    const statusDot = createElement("span", {
      className: `herdr-session-dot${node.tone === "online" ? " is-online" : node.tone === "error" ? " is-error" : ""}`,
    });
    statusDot.setAttribute("aria-hidden", "true");
    sessionHeading.setAttribute("aria-label", `Herdr ${session.name}, ${node.status}`);
    sessionHeading.title = node.status;
    sessionHeading.append(
      statusDot,
      createElement("strong", { text: session.name }),
      createElement("small", { text: node.status }),
    );
    sessionGroup.append(sessionHeading);
    const sessionBody = createElement("div", { className: "herdr-session-body" });
    if (node.workspaces.length === 0) {
      sessionBody.append(createElement("p", {
        className: "herdr-session-empty",
        text: node.emptyText,
      }));
    } else {
      for (const workspaceNode of node.workspaces) appendWorkspace(sessionBody, workspaceNode);
    }
    sessionGroup.append(sessionBody);
    attachGroupCollapse(
      sessionGroup,
      sessionHeading,
      sessionBody,
      `session:${node.id}`,
      displayRecordLabel(session, "Herdr session"),
    );
    parent.append(sessionGroup);
  };

  // Projects (or their sessions) belong to a machine, so they go inside that
  // machine's body. Appending them to the list itself would leave them as
  // siblings of the machine heading, which then collapses over nothing.
  const draw = (parent, node) => (node.kind === "session" ? appendSession : appendWorkspace)(parent, node);
  for (const node of tree.servers) {
    for (const child of node.children) draw(serverBodies.get(node.id), child);
  }
  if (tree.empty) {
    elements.workspaceList.append(createElement("p", {
      className: "empty-state",
      text: "No open projects.",
    }));
    return;
  }
  for (const child of tree.children) draw(elements.workspaceList, child);
}

// Every place the page keeps state under a pane's id, each with how it follows
// the pane to a new id: the unsent draft (and its secret verdict), the
// blocked/held marks, the message history, the chosen lens and the acknowledged
// completion. A new pane-keyed store joins by being listed here. The functions
// are called late, so a store defined further down the file is fine.
const paneScopedStores = [
  { rename: (moves) => composerDrafts.rename(moves) },
  {
    rename(moves) {
      for (const set of [draftBlocked, draftHeld]) {
        const kept = [...set];
        set.clear();
        for (const id of kept) set.add(followMovedPane(id, moves));
      }
      // The pane on screen keeps its composer: the text stays, only the key changes.
      if (draftPaneId) draftPaneId = followMovedPane(draftPaneId, moves);
    },
  },
  {
    rename(moves) {
      state.inputHistoryByPane = renamePaneKeys(state.inputHistoryByPane, moves);
      writeInputHistories(panePreferenceStorage, state.inputHistoryByPane);
    },
  },
  {
    rename(moves) {
      state.acknowledgedCompletions = renamePaneKeys(state.acknowledgedCompletions, moves);
      writeAcknowledgedCompletions(panePreferenceStorage, state.acknowledgedCompletions);
    },
  },
  { rename: (moves) => renamePaneLenses(panePreferenceStorage, moves) },
  { rename: (moves) => chatLens.renamePanes(moves) },
  {
    rename(moves) {
      if (!viewSplit.tree) return;
      viewSplit.focus = followMovedPane(viewSplit.focus, moves);
      setViewSplit(renameTiles(viewSplit.tree, moves));
    },
  },
];

function followMovedPaneState(moves) {
  if (!Array.isArray(moves) || moves.length === 0) return;
  saveComposerDraft();
  for (const store of paneScopedStores) store.rename(moves);
}

async function moveSidebarItem(request, pathFor, optimistic) {
  if (!request || state.mutationBusy) return;
  const before = state.snapshot;
  state.mutationBusy = true;
  setFeedback("");
  state.snapshot = optimistic();
  renderNavigation();
  let failed = false;
  let unread = false;
  let reorderedFeedback = "";
  try {
    const payload = await api(pathFor(request), { method: "POST", body: request.body });
    if (payload.moved?.reordered === false) reorderedFeedback = "Moved; it is at the end of the project.";
    // A session moved to another project brings its panes under new ids; the
    // one on screen is followed there.
    const followed = followMovedPane(state.selectedPaneId, payload.moved?.panes);
    followMovedPaneState(payload.moved?.panes);
    const paneMoved = followed !== state.selectedPaneId;
    if (paneMoved) writePanePreference(panePreferenceStorage, followed);
    if (payload.snapshot) adoptMutationSnapshot(payload.snapshot, paneMoved ? followed : null);
    else {
      // read once the mutation is over: refreshSnapshot waits out a busy one
      if (paneMoved) state.selectedPaneId = followed;
      unread = true;
    }
  } catch (error) {
    failed = true;
    state.snapshot = before;
    renderNavigation();
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
  }
  if (reorderedFeedback) setFeedback(reorderedFeedback);
  // A failed move may still have changed something; a move answered without a
  // snapshot is read now.
  if (failed || unread) void refreshSnapshot();
}

function renderPaneHeading(pane, tab, workspace) {
  syncAttachAvailability();
  if (modifierPaneId !== state.selectedPaneId) clearKeyModifiers();
  if (!pane) {
    elements.paneContext.textContent = "Select a pane";
    elements.paneTitle.textContent = "Terminal";
    elements.paneTitle.removeAttribute("title");
    stopTarget = { paneId: null, agent: null, status: null };
    chatLens.select(null);
    promptDock?.select(null);
    syncSendButton();
    return;
  }

  const paneId = idOf(pane, "pane_id", "id");
  const agent = agentForPane(paneId);
  stopTarget = { paneId, agent: chatAgent(pane, agent), status: agentStatus(agent, pane) };
  chatLens.select(paneId, { agent: chatAgent(pane, agent), status: agentStatus(agent, pane) });
  promptDock?.select(paneId, { agent: chatAgent(pane, agent), status: agentStatus(agent, pane) });
  syncSendButton();
  const workspaceLabel = displayRecordLabel(workspace, "Project");
  const tabLabel = displayTabLabel(tab);

  const sessionName = typeof pane.herdr_session_name === "string"
    ? pane.herdr_session_name
    : "";
  const herdrSessions = snapshotRecords().herdrSessions;
  const showSessionName = herdrSessions.length > 1 ||
    (herdrSessions.length === 1 && herdrSessions[0].available !== true);
  elements.paneContext.textContent = [
    snapshotRecords().servers.length > 1 ? pane.server_name : "",
    showSessionName ? sessionName : "",
    workspaceLabel,
    tabLabel,
  ].filter(Boolean).join(" / ");
  // the program's mark says which agent it is; the title says which pane
  const title = paneDisplayTitle("", pane, tabLabel || "Terminal", agent);
  elements.paneTitle.replaceChildren(agentMark(paneAgentKind(pane, agent)), createElement("span", { className: "pane-title-text", text: title }));
  elements.paneTitle.title = displayRecordLabel(agent, displayRecordLabel(pane, "Terminal"));
}

// An agent names files as it works -- "wrote src/api.mjs", "see ./docs/plan.md"
// -- and on a phone the only way to look at one was to go find it in the tree.
// A named file that this app can show becomes a link that opens it; any other
// name that ends in an extension becomes a link that shows it in the Files tab.
// So does a folder written out in full (`/home/me/proj`, `./build`): it opens
// in the Files tab.
//
// Relative names are resolved against the pane's own directory, because that is
// what the agent writing them meant. `~` is not resolved: that home belongs to
// the machine the pane runs on, and guessing it would open the wrong file or
// none. A path that cannot be resolved is left as plain text rather than
// offered as a link that fails when pressed.
function resolveTerminalPath(raw) {
  if (raw.startsWith("/")) return raw;
  if (raw.startsWith("~")) return null;
  const pane = selectedRecords().pane;
  const base = pane?.foreground_cwd || pane?.cwd;
  if (typeof base !== "string" || !base.startsWith("/")) return null;
  // `..` and `.` survive as they are: the machine that opens this resolves it.
  return `${trimTrailingSlashes(base)}/${raw.replace(/^\.\//u, "")}`;
}

// Whether the viewer can show a file of this name.
const hasPreview = (name) => previewFor(name) !== null;

function isLinkableTerminalPath(raw) {
  const name = raw.split("/").pop();
  return (hasPreview(name) || isFileName(name) || isFolderPath(raw)) && resolveTerminalPath(raw) !== null;
}

// Whether `path` on `server` lists as a folder. A file, or nothing there,
// does not.
async function listsAsFolder(server, path) {
  try {
    await transferRequest(`/api/browse?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`);
    return true;
  } catch {
    return false;
  }
}

async function openTerminalPath(raw) {
  const resolved = resolveTerminalPath(raw);
  if (!resolved) return;
  // a closing slash says "folder"; the name is the last one before it
  const trimmed = trimTrailingSlashes(resolved) || "/";
  const name = trimmed.split("/").pop();
  const server = paneServerId(state.selectedPaneId) || "local";
  // A folder may well be called `docs.md`: one written out in full is asked
  // about before the viewer is opened on it. Anything picked meanwhile -- a
  // folder, a machine, another link, another pane -- wins over this one.
  const generation = ++revealGeneration;
  const paneId = state.selectedPaneId;
  const viewable = trimmed === resolved && hasPreview(name)
    && !(isFolderPath(raw) && await listsAsFolder(server, trimmed));
  if (generation !== revealGeneration || paneId !== state.selectedPaneId) return;
  if (viewable) void viewFile(resolved, name, server);
  else void revealInFiles(trimmed, name, server);
}

function showTerminalMessage(message) {
  elements.terminalMessage.textContent = message;
  showTerminalView(false);
  state.renderedPaneId = null;
  if (terminalFind) syncTerminalFind();
}

function selectedRecords() {
  return selectedRecordsFor(state.selectedPaneId);
}

// The pane `paneId`, its tab and its project.
function selectedRecordsFor(paneId) {
  const { workspaces, tabs, panes } = snapshotRecords();
  const pane = panes.find((item) => idOf(item, "pane_id", "id") === paneId);
  const tabId = idOf(pane, "tab_id", "tabId");
  const tab = tabs.find((item) => idOf(item, "tab_id", "id") === tabId);
  const workspaceId = idOf(tab, "workspace_id", "workspaceId") || idOf(pane, "workspace_id");
  const workspace = workspaces.find(
    (item) => idOf(item, "workspace_id", "id") === workspaceId,
  );
  return { pane, tab, workspace };
}

function selectedAgentStatus() {
  const { pane } = selectedRecords();
  return agentStatus(agentForPane(state.selectedPaneId), pane);
}

// ?pane= names the pane a link or notification opened; once it is used up (or
// given up on), a reload must not open it again. `onlyIf` drops it only when
// it still names that pane.
function dropPaneFromAddress(onlyIf = null) {
  const currentUrl = new URL(window.location.href);
  if (onlyIf !== null && currentUrl.searchParams.get("pane") !== onlyIf) return;
  currentUrl.searchParams.delete("pane");
  window.history.replaceState(null, "", currentUrl);
}

// What to select is decided by paneSelectionAfterSnapshot (ui-model.js); this
// carries it out.
function choosePane() {
  const { herdrSessions, panes, servers } = snapshotRecords();
  const before = state.selectedPaneId;
  const plan = paneSelectionAfterSnapshot({
    panes,
    servers,
    herdrSessions,
    selectedPaneId: state.selectedPaneId,
    preferredPaneId: state.preferredPaneId,
    pendingPaneId: notificationNavigation.pendingPaneId,
    pendingSince: notificationNavigation.pendingSince,
    openedAt: pageOpenedAt,
    now: Date.now(),
    waitLimitMs: PENDING_REMOTE_PANE_MS,
  });
  if (plan.selectedPaneId !== before) resetInputHistoryNavigation();
  state.selectedPaneId = plan.selectedPaneId;
  state.preferredPaneId = plan.preferredPaneId;
  notificationNavigation.pendingPaneId = plan.pendingPaneId;
  if (plan.remember) writePanePreference(panePreferenceStorage, plan.remember);
  if (plan.adopted) {
    dropPaneFromAddress();
    closeMobileSidebar();
  }
  if (plan.giveUp) dropPaneFromAddress(plan.giveUp);
  // A pane being waited for, or kept while its server returns, leaves the
  // composer as it is unless a notification's pane has just taken its place.
  if (plan.adopted || !plan.stop) syncComposerDraft();
}

const liveStatusUpdates = new Map();
let liveStatusSequence = 0;

function applyLiveStatus(event) {
  const records = snapshotRecords();
  for (const record of [...records.panes, ...records.agents]) {
    if (idOf(record, "pane_id", "id") === event.pane_id) record.agent_status = event.agent_status;
  }
}

function receiveLiveStatus(event) {
  if (!["idle", "working", "blocked", "done", "unknown"].includes(event.agent_status)) return;
  if (!snapshotRecords().panes.some(pane => idOf(pane, "pane_id", "id") === event.pane_id)) return;
  liveStatusUpdates.set(event.pane_id, { ...event, sequence: ++liveStatusSequence });
  applyLiveStatus(event);
  pruneAcknowledgedCompletions();
  if (state.selectedPaneId) acknowledgePaneCompletion(state.selectedPaneId);
  if (!renameIsOpen()) renderNavigation();
  const selected = selectedRecords();
  renderPaneHeading(selected.pane, selected.tab, selected.workspace);
}

// Settles when the snapshot on its way (if any) has arrived or failed.
let snapshotSettled = Promise.resolve();

async function refreshSnapshot() {
  if (!state.authenticated) return;
  if (state.snapshotBusy || state.mutationBusy || document.hidden) return;
  state.snapshotBusy = true;
  let settle;
  snapshotSettled = new Promise((resolve) => { settle = resolve; });
  const previousPaneId = state.selectedPaneId;
  const previousStatus = selectedAgentStatus();
  try {
    await restoreNotificationTarget();
    const statusAtRequest = liveStatusSequence;
    // when this snapshot was asked for: it shows the panes as they were then, or later
    const requestedAt = Date.now();
    const payload = await api("/api/snapshot");
    const held = snapshotRecords();
    const seen = seenCompletions({ panes: held.panes, agents: held.agents, acknowledged: state.acknowledgedCompletions });
    state.snapshot = payload.snapshot || {};
    // when the snapshot last arrived was asked for (one that failed or was skipped leaves it)
    state.snapshotAt = requestedAt;
    const records = snapshotRecords();
    const paneIds = records.panes.map(pane => idOf(pane, "pane_id", "id"));
    // What each status event received meanwhile does is reconcileLiveStatus's (ui-model.js):
    // a slow HTTP response must not undo a newer event.
    const reconciled = reconcileLiveStatus({
      pending: liveStatusUpdates, requestedAfter: statusAtRequest, panes: records.panes, agents: records.agents, seen,
    });
    for (const paneId of reconciled.drop) liveStatusUpdates.delete(paneId);
    for (const event of reconciled.apply) applyLiveStatus(event);
    for (const [paneId, identity] of reconciled.acknowledge) state.acknowledgedCompletions.set(paneId, identity);
    terminalStream.watchStatuses(paneIds);
    pruneViewSplit(paneIds);
    choosePane();
    pruneAcknowledgedCompletions();
    if (state.selectedPaneId) acknowledgePaneCompletion(state.selectedPaneId);
    syncCreateProjectAvailability();
    if (!renameIsOpen()) renderNavigation();
    const selected = selectedRecords();
    renderPaneHeading(selected.pane, selected.tab, selected.workspace);
    const gridBefore = shownPaneView;
    if (renderPaneViews() !== gridBefore) void refreshTerminal();
    setConnection("online", "Connected");
    const polling = outputPollingDecision({
      baseIntervalMs: state.pollIntervalMs,
      previousStatus,
      currentStatus: selectedAgentStatus(),
    });
    if (previousPaneId !== state.selectedPaneId || polling.refreshNow || notificationNavigation.relayTarget) {
      void refreshTerminal();
    }
  } catch (error) {
    setConnection("error", error.message);
  } finally {
    state.snapshotBusy = false;
    settle();
  }
}

// Every pane is drawn by xterm. One that attaches gets herdr's own stream; one
// that cannot (no node-pty on this server, or herdr refused the attach)
// mirrors the screen the terminal socket polls instead: redrawn whole on each
// update and read-only to keystrokes, while the composer and quick keys still
// send to it.
function refreshTerminal({ streamPayload = null } = {}) {
  const paneId = state.selectedPaneId;
  if (!state.authenticated || document.hidden) return;
  // A split tab shown as a grid: each cell attaches its own pane, and the
  // single terminal lets its pane go, so a hidden screen never sizes it.
  if (renderPaneViews()) {
    state.lastOutputRequestAt = Date.now();
    attachedTerminal.show(null);
    terminalStream.unwatch();
    // The page may open on a view split (a reload): the composer, the keys and
    // the statuses still go through the page's own socket.
    terminalStream.hold();
    // The selected pane is in its cell: a notification for it is done once
    // that cell is on screen (another pane's zoom hides it until undone).
    state.renderedPaneId = paneId;
    state.renderedGrid = true;
    state.mirrored = null;
    // The strip describes the single terminal, which is not on screen, and
    // the terminal find works on it alone.
    renderTerminalStatus();
    if (terminalFind) syncTerminalFind();
    void completeNotificationRelay();
    return;
  }
  // Back from the grid, the single terminal has yet to show the pane (or, the
  // pane gone, says so below).
  if (state.renderedGrid) {
    state.renderedGrid = false;
    if (paneId) state.renderedPaneId = null;
  }
  // Another pane may have its own reason, or none.
  if (paneId !== state.renderedPaneId) renderTerminalStatus();
  if (!paneId) {
    // The pane on screen went away and nothing took its place.
    if (state.renderedPaneId) {
      attachedTerminal.show(null);
      showTerminalMessage("No open sessions.");
    }
    return;
  }
  // Long in the Chat lens, the terminal was let go: it attaches again on return.
  if (state.terminalParked !== null && state.terminalParked !== paneId) state.terminalParked = null;
  if (state.terminalParked === paneId) return;
  state.lastOutputRequestAt = Date.now();
  if (attachedTerminal.show(paneId)) {
    terminalStream.unwatch();
    state.mirrored = null;
    showTerminal(paneId);
    return;
  }
  terminalStream.select(paneId, HISTORY_PAGE_LINES);
  const payload = streamPayload ?? terminalStream.latest(paneId, HISTORY_PAGE_LINES);
  if (!payload || (!payload.update && payload.output === undefined)) return;
  const previous = state.mirrored?.paneId === paneId ? state.mirrored.output : null;
  const output = outputTextForUpdate(previous, payload.update ? payload : { ...payload, update: "replace" });
  if (output === null) return;
  state.mirrored = { paneId, output };
  attachedTerminal.mirror(paneId, output);
  showTerminal(paneId);
}

function showTerminal(paneId) {
  showTerminalView(true);
  state.renderedPaneId = paneId;
  if (terminalFind) syncTerminalFind();
  void completeNotificationRelay();
}

function refreshOutputOnSchedule() {
  const polling = outputPollingDecision({
    baseIntervalMs: state.pollIntervalMs,
    currentStatus: selectedAgentStatus(),
    recentSubmission: Date.now() < state.outputBurstUntil,
    connection: navigator.connection || navigator.mozConnection || navigator.webkitConnection,
  });
  if (Date.now() - state.lastOutputRequestAt < polling.intervalMs) return;
  void refreshTerminal();
}

async function sendText(text, paneId = state.selectedPaneId) {
  if (!paneId) throw new Error("Select a pane first.");
  return terminalStream.send({ paneId, text, submit: true });
}

async function sendKeys(keys, paneId = state.selectedPaneId, { stop = false } = {}) {
  if (!paneId) throw new Error("Select a pane first.");
  await terminalStream.send(stop ? { paneId, keys, stop: true } : { paneId, keys });
}

function refreshAfterSubmission() {
  state.outputBurstUntil = Date.now() + OUTPUT_SUBMISSION_BURST_MS;
  void refreshTerminal();
  window.setTimeout(() => void refreshTerminal(), OUTPUT_SUBMISSION_RETRY_MS);
  if (elements.filePanel && !elements.filePanel.hidden && browseState.root && !browseState.busy) {
    window.setTimeout(() => void refreshBrowseFolder({ silent: true }), OUTPUT_SUBMISSION_RETRY_MS);
  }
}

function streamPayloadIsCurrent(payload) {
  return payload.paneId === state.selectedPaneId && payload.requestedLines === HISTORY_PAGE_LINES;
}

// Stream updates can arrive faster than a large terminal renders. Draw only the
// newest one per frame so keystrokes do not queue behind stale renders.
let pendingStreamPayload = null;
function scheduleStreamRender(payload) {
  const scheduled = pendingStreamPayload !== null;
  pendingStreamPayload = payload;
  if (scheduled) return;
  window.requestAnimationFrame(() => {
    const next = pendingStreamPayload;
    pendingStreamPayload = null;
    if (streamPayloadIsCurrent(next)) void refreshTerminal({ streamPayload: next });
  });
}

const terminalStream = terminalConnection({
  credentials: () => ({ csrf: state.csrfToken, launchToken: state.launchToken }),
  onOutput: payload => {
    if (streamPayloadIsCurrent(payload)) {
      setConnection("online", "Connected");
      scheduleStreamRender(payload);
    }
  },
  onDisconnect: error => {
    liveStatusUpdates.clear();
    if (state.authenticated && !document.hidden) setConnection("error", error.message);
  },
  onAuthenticationRequired: () => showLogin(),
  onStatus: receiveLiveStatus,
  onStatusesReady: () => void refreshSnapshot(),
  onStatusesUnavailable: () => liveStatusUpdates.clear(),
});

// The find bar over the Terminal lens (terminal-find.js), made once the lens is,
// and the one over the Chat lens (chat-find.js).
let terminalFind = null;
let chatFind = null;

const attachedTerminal = createAttachedTerminal({
  host: elements.terminalXterm,
  connection: terminalStream,
  xterm,
  fontSize: state.terminalFontSize,
  // A pane that cannot attach is mirrored from the polled screen instead.
  onFallback: (paneId, problem) => {
    attachTracker.failed(paneId, problem);
    renderTerminalStatus();
    if (paneId !== state.selectedPaneId) return;
    showTerminalMessage("Loading output…");
    void refreshTerminal();
  },
  onStateChange: ({ paneId, held, ready, dropped }) => {
    if (paneId !== state.selectedPaneId) return;
    noteTerminalAttach(paneId, held ? "held" : ready ? "live" : "attaching");
    elements.terminalHeld.hidden = !held;
    if (dropped) setFeedback("Typing did not reach the terminal while it reconnected. Check the screen before typing again.", true);
  },
  isLinkablePath: isLinkableTerminalPath,
  onPath: openTerminalPath,
  onFontSizeChange: applyTerminalFontSize,
  onRetry: (paneId) => { if (paneId === state.selectedPaneId) void refreshTerminal(); },
  onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
  onViewMoved: () => terminalFind?.forgetPlace(),
});

// --- Split tabs: the grid (wide screens) and the pane map (phones) ---------

// The split tab whose grid is on screen, and what renderPaneViews last
// answered: set by pane-views.js, read here as well.
let shownGridTabId = null;
let shownPaneView = null;

import { createPaneViews } from "./app/pane-views.js?v=1.4.23";
const {
  SEPARATE_ICON, EVEN_ICON,
  paneTabId, isLocalRecord, paneLayout, paneGrid, viewGrid, shownGrid, setViewSplit, pruneViewSplit,
  dropOnPane, paneDropTargets, renderPaneViews, selectPane,
  splitSessionName, splitSessionButton, splitDisclosureButton, splitPaneRow,
  evenOutLayout, separateSplitSession,
} = createPaneViews({
  state,
  elements,
  desktopMedia,
  panePreferenceStorage,
  viewSplit,
  viewSplitStorage,
  paneCalls,
  notificationNavigation,
  getShownGridTabId: () => shownGridTabId,
  setShownGridTabId: (value) => { shownGridTabId = value; },
  getShownPaneView: () => shownPaneView,
  setShownPaneView: (value) => { shownPaneView = value; },
  getSnapshotSettled: () => snapshotSettled,
  snapshotRecords: (...args) => snapshotRecords(...args),
  agentForPane: (...args) => agentForPane(...args),
  visibleStatusForPane: (...args) => visibleStatusForPane(...args),
  acknowledgePaneCompletion: (...args) => acknowledgePaneCompletion(...args),
  completeNotificationRelay: (...args) => completeNotificationRelay(...args),
  selectedRecords: (...args) => selectedRecords(...args),
  selectedRecordsFor: (...args) => selectedRecordsFor(...args),
  followMovedPaneState: (...args) => followMovedPaneState(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  renderNavigation: (...args) => renderNavigation(...args),
  renderPaneHeading: (...args) => renderPaneHeading(...args),
  showTerminalMessage: (...args) => showTerminalMessage(...args),
  resetInputHistoryNavigation: (...args) => resetInputHistoryNavigation(...args),
  syncComposerDraft: (...args) => syncComposerDraft(...args),
  focusComposer: (...args) => focusComposer(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  setFeedback: (...args) => setFeedback(...args),
  showLogin: (...args) => showLogin(...args),
  syncSettingsMenu: (...args) => syncSettingsMenu(...args),
  applyTerminalFontSize: (...args) => applyTerminalFontSize(...args),
  isLinkableTerminalPath: (...args) => isLinkableTerminalPath(...args),
  openTerminalPath: (...args) => openTerminalPath(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  paneButton: (...args) => paneButton(...args),
  agentMark: (...args) => agentMark(...args),
});

import { createTerminalStatus } from "./app/terminal-status.js?v=1.4.23";

let phoneKeyboardOpen = false;
// A phone keyboard put away leaves the composer focused: Send reads that as
// out of the composer (and may turn into Stop) until the composer is tapped
// or focused again.
let composerKeyboardDismissed = false;

// Made after `attachedTerminal`, whose callbacks call these (only later, never
// while it is made). The phone keyboard is followed at once, as before.
const {
  attachTracker, noteTerminalAttach, renderTerminalStatus, showNewestTerminalOutput, scheduleTerminalPark,
} = createTerminalStatus({
  state,
  elements,
  terminalStream,
  attachedTerminal,
  paneCalls,
  paneServerId: (...args) => paneServerId(...args),
  shownGrid: (...args) => shownGrid(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  usesTouchInputEnvironment: (...args) => usesTouchInputEnvironment(...args),
  syncSendButton: (...args) => syncSendButton(...args),
  get phoneKeyboardOpen() { return phoneKeyboardOpen; },
  set phoneKeyboardOpen(value) { phoneKeyboardOpen = value; },
  get composerKeyboardDismissed() { return composerKeyboardDismissed; },
  set composerKeyboardDismissed(value) { composerKeyboardDismissed = value; },
  get chatLens() { return chatLens; },
});

// Made right after the lens switch, which tells it the lens (below).
let promptDock = null;
import { createChatPanel } from "./app/chat-lens.js?v=1.4.23";
const chatPanel = createChatPanel({
  state,
  elements,
  panePreferenceStorage,
  desktopMedia,
  terminalStream,
  attachedTerminal,
  paneCalls,
  conversationRequest,
  api: (...args) => api(...args),
  usesTouchInputEnvironment: (...args) => usesTouchInputEnvironment(...args),
  isLinkableTerminalPath: (...args) => isLinkableTerminalPath(...args),
  openTerminalPath: (...args) => openTerminalPath(...args),
  setFeedback: (...args) => setFeedback(...args),
  showNewestTerminalOutput: (...args) => showNewestTerminalOutput(...args),
  scheduleTerminalPark: (...args) => scheduleTerminalPark(...args),
  syncComposerExpanded: (...args) => syncComposerExpanded(...args),
  resizeTerminalInput: (...args) => resizeTerminalInput(...args),
  syncSendButton: (...args) => syncSendButton(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  refreshAfterSubmission: (...args) => refreshAfterSubmission(...args),
});
const { chatLens, syncTerminalFind, applyChatFontSize, overChat, showTerminalView } = chatPanel;
promptDock = chatPanel.promptDock;
terminalFind = chatPanel.terminalFind;
chatFind = chatPanel.chatFind;
// Ctrl/Cmd + wheel over the chat sizes its text (the wheel handler below).
let chatFontWheelDelta = 0;

import { createKeyBar } from "./app/key-bar.js?v=1.4.23";
let keyBarItems = readKeyBarItems(panePreferenceStorage);
const { clearComposer, syncSendButton, clearKeyModifiers, renderKeyBar } = createKeyBar({
  state,
  elements,
  composerPopup,
  chatLens,
  attachedTerminal,
  draftBlocked,
  getDraftPaneId: () => draftPaneId,
  getTerminalInputResizeTimer: () => terminalInputResizeTimer,
  setTerminalInputResizeTimer: (value) => { terminalInputResizeTimer = value; },
  getChatFind: () => chatFind,
  getEnterKeyMode: () => enterKeyMode,
  getPhysicalKeyboardSeen: () => physicalKeyboardSeen,
  getKeyBarItems: () => keyBarItems,
  setModifierPaneId: (value) => { modifierPaneId = value; },
  getStopTarget: () => stopTarget,
  getComposerKeyboardDismissed: () => composerKeyboardDismissed,
  setComposerKeyboardDismissed: (value) => { composerKeyboardDismissed = value; },
  getPhoneKeyboardOpen: () => phoneKeyboardOpen,
  syncComposerExpanded: (...args) => syncComposerExpanded(...args),
  resizeTerminalInput: (...args) => resizeTerminalInput(...args),
  scheduleTerminalInputResize: (...args) => scheduleTerminalInputResize(...args),
  resetInputHistoryNavigation: (...args) => resetInputHistoryNavigation(...args),
  scheduleComposerDraftSave: (...args) => scheduleComposerDraftSave(...args),
  holdComposerDraft: (...args) => holdComposerDraft(...args),
  releaseComposerDraft: (...args) => releaseComposerDraft(...args),
  rememberSentInput: (...args) => rememberSentInput(...args),
  speechStop: (...args) => speechStop(...args),
  setFeedback: (...args) => setFeedback(...args),
  sendText: (...args) => sendText(...args),
  sendKeys: (...args) => sendKeys(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  selectedRecords: (...args) => selectedRecords(...args),
  agentForPane: (...args) => agentForPane(...args),
  refreshAfterSubmission: (...args) => refreshAfterSubmission(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  focusComposer: (...args) => focusComposer(...args),
  usesTouchInputEnvironment: (...args) => usesTouchInputEnvironment(...args),
  hintIfStillWorking: (...args) => hintIfStillWorking(...args),
});


// A moment after an OpenCode Stop: the pane, still selected and still
// working by a fresh snapshot, gets the hint that its Escs may have gone to a
// list or the shell mode instead. Fresh is asked for after this moment: one
// already on its way was asked for before, so it is waited out and another
// asked for (a few tries). A snapshot that could not be had (it failed, or was
// skipped) says nothing: the status from before the Stop is no evidence.
async function hintIfStillWorking(paneId, { afterMs, message }) {
  await new Promise((resolve) => window.setTimeout(resolve, afterMs));
  const asked = Date.now();
  for (let tries = 0; tries < 3 && !(state.snapshotAt >= asked); tries += 1) {
    if (state.snapshotBusy) await snapshotSettled;
    else await refreshSnapshot();
  }
  if (!(state.snapshotAt >= asked)) return;
  if (state.selectedPaneId === paneId && stopTarget.paneId === paneId && stopTarget.status === "working") setFeedback(message);
}
import { createKeyBarEditor } from "./app/key-bar-editor.js?v=1.4.23";
const { openKeyBarDialog } = createKeyBarEditor({
  panePreferenceStorage,
  getKeyBarItems: () => keyBarItems,
  assignKeyBarItems: (items) => { keyBarItems = items; },
  getEnterKeyMode: () => enterKeyMode,
  setEnterKeyMode: (mode) => { enterKeyMode = mode; },
  renderKeyBar: (...args) => renderKeyBar(...args),
  usesTouchInputEnvironment: (...args) => usesTouchInputEnvironment(...args),
});

renderKeyBar();

window.addEventListener("blur", clearKeyModifiers);
import { createProjectDialog } from "./app/project-dialog.js?v=1.4.23";
createProjectDialog({
  state,
  elements,
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  newProjectHerdrSession: (...args) => newProjectHerdrSession(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
});


// Only the last file link pressed is taken to. One still waiting gives way to
// a later link, and to any folder or machine picked by hand meanwhile.
let revealGeneration = 0;
import { createFiles } from "./app/files.js?v=1.4.23";
const {
  applyNavigatorPanels,
  browsePathStorage,
  browseState,
  fetchListing,
  refreshBrowseFolder,
  revealInFiles,
  showNavigatorTab,
  speechStop,
  syncAttachAvailability,
  viewFile,
} = createFiles({
  state,
  elements,
  desktopMedia,
  revealState: {
    get generation() { return revealGeneration; },
    set generation(value) { revealGeneration = value; },
  },
  transferRequest: (...args) => transferRequest(...args),
  setFeedback: (...args) => setFeedback(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  syncComposerExpanded: (...args) => syncComposerExpanded(...args),
  syncSidebar: (...args) => syncSidebar(...args),
});

window.addEventListener("herdr-theme-change", syncThemeItem);

elements.sidebarToggle.addEventListener("click", () => {
  markSidebarAnimating();
  if (desktopMedia.matches) {
    state.desktopSidebarCollapsed = !state.desktopSidebarCollapsed;
  } else {
    state.mobileSidebarOpen = false;
  }
  syncSidebar();
  if (!desktopMedia.matches) elements.mobileSidebarOpen.focus();
});

elements.navigator.addEventListener("transitionend", (event) => {
  if (event.target === elements.navigator && event.propertyName === "transform") {
    clearSidebarAnimationState();
  }
});

elements.mobileSidebarOpen.addEventListener("click", () => {
  state.mobileSidebarOpen = true;
  syncSidebar();
  elements.sidebarToggle.focus();
});

elements.sidebarScrim.addEventListener("click", () => {
  closeMobileSidebar({ restoreFocus: true });
});

elements.terminalPanel.addEventListener("wheel", (event) => {
  if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
  event.preventDefault();
  // Over the Chat lens it sizes the chat's text, not the terminal's.
  if (overChat(event.target)) {
    if (chatFontWheelDelta !== 0 && Math.sign(chatFontWheelDelta) !== Math.sign(event.deltaY)) chatFontWheelDelta = 0;
    chatFontWheelDelta += event.deltaY;
    if (Math.abs(chatFontWheelDelta) < 40) return;
    applyChatFontSize(adjustedChatFontSize(chatPanel.chatFontSize, chatFontWheelDelta < 0 ? "larger" : "smaller"));
    chatFontWheelDelta = 0;
    return;
  }
  if (
    terminalFontWheelDelta !== 0 &&
    Math.sign(terminalFontWheelDelta) !== Math.sign(event.deltaY)
  ) {
    terminalFontWheelDelta = 0;
  }
  terminalFontWheelDelta += event.deltaY;
  if (Math.abs(terminalFontWheelDelta) < 40) return;
  adjustTerminalFont(terminalFontWheelDelta < 0 ? "larger" : "smaller");
  terminalFontWheelDelta = 0;
// Caught on the way down: the attached terminal stops a wheel once a program
// there turns on mouse reports.
}, { passive: false, capture: true });

function activatePaneShortcut(event) {
  if (!state.authenticated || document.querySelector("dialog[open]")) return false;
  const paneButtons = Array.from(
    elements.workspaceList.querySelectorAll(".pane-button[data-pane-id]"),
  );
  const targetPaneId = paneShortcutTarget({
    key: event.key,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    isComposing: event.isComposing,
    paneIds: paneButtons.map((button) => button.dataset.paneId),
    currentPaneId: state.selectedPaneId,
  });
  if (!targetPaneId) return false;

  const targetButton = paneButtons.find(
    (button) => button.dataset.paneId === targetPaneId,
  );
  if (!targetButton) return false;
  event.preventDefault();
  // Within the grid on screen, the shortcut moves the focus between its cells;
  // within the view split, between its tiles.
  if ((shownGridTabId && paneTabId(targetPaneId) === shownGridTabId) ||
      (viewGrid.shown && viewTiles(viewSplit.tree).includes(targetPaneId))) {
    selectPane(targetPaneId, { fromGrid: true });
    shownGrid()?.focus(targetPaneId);
    return true;
  }
  targetButton.click();
  return true;
}

// Mod+J switches the pane between Chat and Terminal. Inside the terminal,
// Ctrl+J stays the program's (a newline); Cmd+J on a Mac switches there too.
function activateLensShortcut(event) {
  if (!state.authenticated || event.isComposing || event.altKey || event.shiftKey ||
      event.key.toLowerCase() !== "j" || document.querySelector("dialog[open]")) return false;
  const mac = /Mac|iPhone|iPad/u.test(navigator.platform);
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  if (!mac && elements.terminalXterm.contains(document.activeElement) && chatLens.lens === "terminal") return false;
  if (!chatLens.paneId) return false;
  event.preventDefault();
  event.stopPropagation();
  chatLens.toggle();
  return true;
}

// Mod+0 puts a Herdr grid's text size back to the largest that fits.
function activateGridFontReset(event) {
  if (!state.authenticated || event.altKey || event.shiftKey || event.key !== "0" ||
      !(event.ctrlKey || event.metaKey) || document.querySelector("dialog[open]") ||
      !paneGrid.adjustable || paneGrid.manualFont === null) return false;
  event.preventDefault();
  event.stopPropagation();
  paneGrid.resetFont();
  return true;
}

document.addEventListener("keydown", activateGridFontReset, { capture: true });

document.addEventListener("keydown", (event) => {
  if (activateLensShortcut(event)) return;
  if (activatePaneShortcut(event)) return;
  if (event.key !== "Escape") return;
  // The settings menu answers Escape on its own; the sidebar stays as it is.
  if (settingsMenu.details?.open) {
    settingsMenu.details.open = false;
    settingsMenu.details.querySelector("summary").focus();
    return;
  }
  document.querySelector("#add-menu").open = false;
  state.openActionMenuId = null;
  for (const menu of elements.workspaceList.querySelectorAll(
    ".sidebar-action-menu[open]",
  )) menu.open = false;
  closeMobileSidebar({ restoreFocus: true });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#add-menu")) document.querySelector("#add-menu").open = false;
  if (event.target.closest(".sidebar-action-menu")) return;
  state.openActionMenuId = null;
  for (const menu of elements.workspaceList.querySelectorAll(
    ".sidebar-action-menu[open]",
  )) menu.open = false;
});

desktopMedia.addEventListener("change", () => {
  state.mobileSidebarOpen = false;
  syncSidebar();
  // The grid is for wide screens; a phone shows one pane and the map. Drawn
  // here too: refreshTerminal does nothing while the page is hidden.
  if (state.authenticated) renderPaneViews();
  void refreshTerminal();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    terminalStream.pause();
    paneGrid.pause();
    viewGrid.pause();
  }
  if (document.hidden || !state.authenticated) return;
  // A chat watching a pane whose terminal was let go still needs the socket.
  terminalStream.resume();
  paneGrid.resume();
  viewGrid.resume();
  void dismissDeliveredNotifications();
  if (notificationNavigation.pendingPaneId) void refreshSnapshot();
  void refreshTerminal();
});

elements.loginScreen.addEventListener("click", (event) => {
  if (event.target.closest("button, a, input, label")) return;
  focusLoginPassword();
});

window.addEventListener("focus", restoreLoginFocus);
window.addEventListener("pageshow", restoreLoginFocus);

elements.loginPassword.addEventListener("input", () => {
  if (elements.loginPassword.value) rememberLoginMethod("password");
});

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  rememberLoginMethod("password");
  setLoginBusy(true);
  elements.loginFeedback.textContent = "Signing in…";
  elements.loginFeedback.dataset.error = "false";
  try {
    const login = await api("/api/auth/login", {
      method: "POST",
      csrf: false,
      body: { password: elements.loginPassword.value },
    });
    state.launchToken = writeLaunchToken(
      launchSessionStorage,
      login.launchToken,
    );
    state.passkeyAvailable = login.passkeyAvailable === true;
    const shouldOfferRegistration = !state.passkeyAvailable && supportsPasskeys();
    elements.loginPassword.value = "";
    await initializeApplication();
    if (shouldOfferRegistration) offerPasskeyRegistration();
  } catch (error) {
    elements.loginFeedback.textContent = error.message;
    elements.loginFeedback.dataset.error = "true";
  } finally {
    setLoginBusy(false);
    if (elements.loginFeedback.dataset.error === "true") {
      elements.loginPassword.focus();
      elements.loginPassword.select();
    }
  }
});

async function startPasskeyLogin() {
  if (state.passkeyBusy || state.authenticated || !state.passkeyAvailable || !supportsPasskeys()) return;
  setLoginBusy(true);
  elements.loginFeedback.textContent = "Verifying passkey…";
  elements.loginFeedback.dataset.error = "false";
  try {
    const ceremony = await api("/api/auth/passkeys/login/options", {
      method: "POST",
      csrf: false,
      body: {},
    });
    const credential = await window.SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: ceremony.options,
    });
    await completePasskeyLogin(ceremony, credential);
  } catch (error) {
    elements.loginFeedback.textContent = passkeyErrorMessage(error);
    elements.loginFeedback.dataset.error = "true";
  } finally {
    setLoginBusy(false);
    if (document.activeElement === document.body) focusLoginMethod();
  }
}

elements.passkeyLogin.addEventListener("click", () => {
  rememberLoginMethod("passkey");
  void startPasskeyLogin();
});
document.addEventListener("visibilitychange", restoreLoginFocus);

elements.passkeyDialogCancel.addEventListener("click", () => {
  if (!state.passkeyBusy) elements.passkeyDialog.close();
});

elements.passkeyDialog.addEventListener("cancel", (event) => {
  if (state.passkeyBusy) event.preventDefault();
});
elements.passkeyDialog.addEventListener("close", () => {
  elements.passkeyDialogPassword.value = "";
});

elements.passkeyRegister.addEventListener("click", async () => {
  if (state.passkeyBusy || !supportsPasskeys()) return;
  let password;
  if (!elements.passkeyDialogPasswordField.hidden) {
    password = enteredPassword(elements.passkeyDialogPassword, elements.passkeyDialogFeedback);
    if (!password) return;
  }
  state.passkeyBusy = true;
  elements.passkeyRegister.disabled = true;
  elements.passkeyDialogCancel.disabled = true;
  elements.passkeyDialogFeedback.textContent = "Follow the prompt on your device…";
  elements.passkeyDialogFeedback.dataset.error = "false";
  try {
    await registerPasskey(password);
    elements.passkeyDialog.close();
  } catch (error) {
    elements.passkeyDialogFeedback.textContent = passkeyErrorMessage(error);
    elements.passkeyDialogFeedback.dataset.error = "true";
    if (error.code === "invalid_password" && elements.passkeyDialogPasswordField.hidden) {
      elements.passkeyDialogPasswordField.hidden = false;
      elements.passkeyDialogFeedback.textContent = "Enter your password to register a passkey.";
      requestAnimationFrame(() => elements.passkeyDialogPassword.focus());
    }
  } finally {
    state.passkeyBusy = false;
    elements.passkeyRegister.disabled = false;
    elements.passkeyDialogCancel.disabled = false;
    renderLoginMethods();
  }
});

async function initializeApplication() {
  const bootstrap = await api("/api/bootstrap");
  state.csrfToken = bootstrap.csrfToken;
  state.pollIntervalMs = bootstrap.pollIntervalMs || state.pollIntervalMs;
  state.maxTransferBytes = Number.isFinite(bootstrap.maxTransferBytes) && bootstrap.maxTransferBytes > 0 ? bootstrap.maxTransferBytes : null;
  state.pushPublicKey = typeof bootstrap.pushPublicKey === "string"
    ? bootstrap.pushPublicKey
    : null;
  document.querySelector("#manage-servers").hidden = bootstrap.servers !== true;
  state.connectPc = bootstrap.connectPc && typeof bootstrap.connectPc.address === "string" ? bootstrap.connectPc : null;
  showApplication();
  showLegacyMachinesNotice(bootstrap.legacyMachines);
  browseState.pinnedServer = readFileServer(browsePathStorage);
  showNavigatorTab(readNavigatorTab(browsePathStorage));
  await refreshSnapshot();
  void resumeAiLogins();
  // Each time the app opens, and on Check: never on a timer.
  void updatePanel.resume().then(() => updatePanel.refresh());
  refreshTerminal();
  if (notificationPanePreference) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("pane");
    window.history.replaceState(null, "", cleanUrl);
  }
  void syncPushSubscription().catch(() => renderNotificationItem());
  void dismissDeliveredNotifications();
  focusComposer();
  if (!state.pollingStarted) {
    state.pollingStarted = true;
    window.setInterval(() => void refreshSnapshot(), state.pollIntervalMs * 2);
    window.setInterval(refreshOutputOnSchedule, Math.min(state.pollIntervalMs, OUTPUT_POLL_TICK_MS));
  }
}
import { createConnectPc } from "./app/connect-pc.js?v=1.4.23";

const { showLegacyMachinesNotice } = createConnectPc({
  api: (...args) => api(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  panePreferenceStorage,
});

async function start() {
  if ("BroadcastChannel" in window) {
    notificationNavigation.relayChannel = new BroadcastChannel("herdr-notification-navigation");
    notificationNavigation.relayChannel.onmessage = ({ data }) => {
      if (data?.type === "notification-target") receiveNotificationRelay(data);
    };
  }
  if (window.launchQueue?.setConsumer) {
    window.launchQueue.setConsumer((launch) => {
      if (launch.targetURL) acceptNotificationTarget(launch.targetURL);
    });
  }
  buildSettingsMenu();
  syncThemeItem();
  renderNotificationItem();
  syncSidebar();
  resizeTerminalInput();
  if ("serviceWorker" in navigator) {
    // Update the existing scope explicitly: the page and notification handler
    // must advance together, even when the browser retains the old script URL.
    void navigator.serviceWorker.register("/sw.js?revision=notification-routing-4", {
      scope: "/", updateViaCache: "none",
    }).then((registration) => {
      registration.waiting?.postMessage({ type: "activate-worker" });
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed") installing.postMessage({ type: "activate-worker" });
      });
    }).catch(() => {});
  }
  try {
    const authStatus = await api("/api/auth/status", { csrf: false });
    state.passkeyAvailable = authStatus.passkeyAvailable === true;
    state.authRequired = authStatus.required === true;
    syncSettingsMenu();
    if (authStatus.required && !authStatus.authenticated) {
      showLogin();
      return;
    }
    await initializeApplication();
  } catch (error) {
    if (error.code === "authentication_required") return;
    document.body.classList.remove("auth-pending", "auth-required");
    document.body.classList.add("auth-ready");
    elements.shell.inert = false;
    setConnection("error", error.message);
    showTerminalMessage(`Could not initialize: ${error.message}`);
  }
}

void start();
