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

import { createSidebarRows } from "./app/sidebar-rows.js?v=1.4.23";

const {
  sidebarActionMenu, adoptMutationSnapshot, closeSession, renameForm, workspaceHeading,
  agentMark, paneButton, attachGroupCollapse, serverRenameForm,
} = createSidebarRows({
  state,
  panePreferenceStorage,
  desktopMedia,
  viewSplit,
  get viewGrid() { return viewGrid; },
  api: (...args) => api(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  syncCreateProjectAvailability: (...args) => syncCreateProjectAvailability(...args),
  agentForPane: (...args) => agentForPane(...args),
  visibleStatusForPane: (...args) => visibleStatusForPane(...args),
  choosePane: (...args) => choosePane(...args),
  renderNavigation: (...args) => renderNavigation(...args),
  selectedRecords: (...args) => selectedRecords(...args),
  renderPaneHeading: (...args) => renderPaneHeading(...args),
  showTerminalMessage: (...args) => showTerminalMessage(...args),
  refreshTerminal: (...args) => refreshTerminal(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  setFeedback: (...args) => setFeedback(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  selectPane: (...args) => selectPane(...args),
  focusComposer: (...args) => focusComposer(...args),
});

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

import { createNavigation } from "./app/navigation.js?v=1.4.23";

// Made before the sidebar rows and split panes it draws with; it calls them
// only when the sidebar is drawn.
const {
  serverActionMenu,
  linkActionMenu,
  tabRenameForm,
  renameIsOpen,
  renderNavigation,
  paneScopedStores,
  followMovedPaneState,
  moveSidebarItem,
} = createNavigation({
  state,
  elements,
  sidebarDrag,
  panePreferenceStorage,
  composerDrafts,
  draftBlocked,
  draftHeld,
  viewSplit,
  api: (...args) => api(...args),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
  setFeedback: (...args) => setFeedback(...args),
  snapshotRecords: (...args) => snapshotRecords(...args),
  selectedRecords: (...args) => selectedRecords(...args),
  renderPaneHeading: (...args) => renderPaneHeading(...args),
  agentForPane: (...args) => agentForPane(...args),
  visibleStatusForPane: (...args) => visibleStatusForPane(...args),
  adoptMutationSnapshot: (...args) => adoptMutationSnapshot(...args),
  saveComposerDraft: (...args) => saveComposerDraft(...args),
  setViewSplit: (...args) => setViewSplit(...args),
  showServerDetails: (...args) => showServerDetails(...args),
  showAiAccounts: (...args) => showAiAccounts(...args),
  sidebarActionMenu: (...args) => sidebarActionMenu(...args),
  renameForm: (...args) => renameForm(...args),
  serverRenameForm: (...args) => serverRenameForm(...args),
  attachGroupCollapse: (...args) => attachGroupCollapse(...args),
  workspaceHeading: (...args) => workspaceHeading(...args),
  paneButton: (...args) => paneButton(...args),
  closeSession: (...args) => closeSession(...args),
  isLocalRecord: (...args) => isLocalRecord(...args),
  splitSessionName: (...args) => splitSessionName(...args),
  splitPaneRow: (...args) => splitPaneRow(...args),
  splitDisclosureButton: (...args) => splitDisclosureButton(...args),
  splitSessionButton: (...args) => splitSessionButton(...args),
  evenOutLayout: (...args) => evenOutLayout(...args),
  separateSplitSession: (...args) => separateSplitSession(...args),
  get navigationRedrawHeld() { return navigationRedrawHeld; },
  set navigationRedrawHeld(value) { navigationRedrawHeld = value; },
  get draftPaneId() { return draftPaneId; },
  set draftPaneId(value) { draftPaneId = value; },
  get chatLens() { return chatLens; },
  get EVEN_ICON() { return EVEN_ICON; },
  get SEPARATE_ICON() { return SEPARATE_ICON; },
});

// Settles when the snapshot on its way (if any) has arrived or failed.
let snapshotSettled = Promise.resolve();

import { createSelection } from "./app/selection.js?v=1.4.23";
// Made before the terminal socket, the attached terminal, the Chat lens and
// the Files tab, which are read through getters (only later, never while this
// is made). Nothing here runs at the top level.
const {
  renderPaneHeading,
  isLinkableTerminalPath,
  openTerminalPath,
  showTerminalMessage,
  selectedRecords,
  selectedRecordsFor,
  choosePane,
  liveStatusUpdates,
  receiveLiveStatus,
  refreshSnapshot,
  refreshTerminal,
  refreshOutputOnSchedule,
  sendText,
  sendKeys,
  refreshAfterSubmission,
  streamPayloadIsCurrent,
  scheduleStreamRender,
} = createSelection({
  state,
  elements,
  notificationNavigation,
  panePreferenceStorage,
  pageOpenedAt,
  PENDING_REMOTE_PANE_MS,
  OUTPUT_SUBMISSION_BURST_MS,
  OUTPUT_SUBMISSION_RETRY_MS,
  snapshotRecords: (...args) => snapshotRecords(...args),
  agentForPane: (...args) => agentForPane(...args),
  acknowledgePaneCompletion: (...args) => acknowledgePaneCompletion(...args),
  pruneAcknowledgedCompletions: (...args) => pruneAcknowledgedCompletions(...args),
  syncCreateProjectAvailability: (...args) => syncCreateProjectAvailability(...args),
  api: (...args) => api(...args),
  transferRequest: (...args) => transferRequest(...args),
  completeNotificationRelay: (...args) => completeNotificationRelay(...args),
  restoreNotificationTarget: (...args) => restoreNotificationTarget(...args),
  resetInputHistoryNavigation: (...args) => resetInputHistoryNavigation(...args),
  syncComposerDraft: (...args) => syncComposerDraft(...args),
  syncAttachAvailability: (...args) => syncAttachAvailability(...args),
  clearKeyModifiers: (...args) => clearKeyModifiers(...args),
  syncSendButton: (...args) => syncSendButton(...args),
  agentMark: (...args) => agentMark(...args),
  viewFile: (...args) => viewFile(...args),
  revealInFiles: (...args) => revealInFiles(...args),
  refreshBrowseFolder: (...args) => refreshBrowseFolder(...args),
  showTerminalView: (...args) => showTerminalView(...args),
  syncTerminalFind: (...args) => syncTerminalFind(...args),
  closeMobileSidebar: (...args) => closeMobileSidebar(...args),
  renameIsOpen: (...args) => renameIsOpen(...args),
  renderNavigation: (...args) => renderNavigation(...args),
  setConnection: (...args) => setConnection(...args),
  pruneViewSplit: (...args) => pruneViewSplit(...args),
  renderPaneViews: (...args) => renderPaneViews(...args),
  renderTerminalStatus: (...args) => renderTerminalStatus(...args),
  get snapshotSettled() { return snapshotSettled; },
  set snapshotSettled(value) { snapshotSettled = value; },
  get stopTarget() { return stopTarget; },
  set stopTarget(value) { stopTarget = value; },
  get modifierPaneId() { return modifierPaneId; },
  get revealGeneration() { return revealGeneration; },
  set revealGeneration(value) { revealGeneration = value; },
  get shownPaneView() { return shownPaneView; },
  get terminalStream() { return terminalStream; },
  get attachedTerminal() { return attachedTerminal; },
  get chatLens() { return chatLens; },
  get promptDock() { return promptDock; },
  get terminalFind() { return terminalFind; },
  get browseState() { return browseState; },
});

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

const GRID_ICON = ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"];

function paneTabId(paneId) {
  const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
  return idOf(pane, "tab_id", "tabId");
}

function panesOfTab(tabId) {
  return snapshotRecords().panes.filter((pane) => idOf(pane, "tab_id", "tabId") === tabId);
}

// Only this machine's panes are split, closed, zoomed or laid out from here:
// a connected PC's split tab opens one pane at a time, with no grid or map.
function isLocalRecord(record) {
  return (record?.server_id || "local") === "local";
}

// The selected pane's tab when it has more than one pane, on this machine, else null.
function selectedSplitTabId() {
  const tabId = paneTabId(state.selectedPaneId);
  const tabPanes = tabId ? panesOfTab(tabId) : [];
  return tabPanes.length > 1 && isLocalRecord(tabPanes[0]) ? tabId : null;
}

// The tab drawn as a grid now: a split tab chosen as one, on a wide screen.
function gridTabId() {
  const tabId = selectedSplitTabId();
  return tabId && desktopMedia.matches && state.paneViews.get(tabId) === "grid" ? tabId : null;
}

// What a cell or a map box says of each pane of `tabId`.
function splitTabPanes(tabId) {
  return panesOfTab(tabId).map((pane) => {
    const paneId = idOf(pane, "pane_id", "id");
    const agent = agentForPane(paneId);
    const status = visibleStatusForPane(paneId, agent, pane);
    return {
      paneId,
      label: paneDisplayTitle("", pane, "Terminal", agent),
      status,
      statusIcon: agentStatusIcon(status),
      statusText: agentStatusLabel(status),
    };
  });
}

// Herdr's layout of the split tab on screen, read again when its panes change
// or it is a few seconds old (a zoom or a split made in Herdr itself). It is
// undefined until first read, and null when it could not be read (a connected
// PC's tab is refused). Each read has its own number, and `latest` holds the
// newest read of each key: an older read of the same tab answering late (asked
// before the user went to another tab and back) is dropped, and so is every
// read begun before forgetPaneLayout (a split, a zoom), which may show the tab
// as it was. `loadingKey` is the read in flight: one for another tab does not
// hold up this tab's read, and its answer, should the tab no longer be
// selected, is dropped.
const PANE_LAYOUT_MAX_AGE_MS = 3_000;
const paneLayout = { key: "", tabId: null, layout: undefined, at: 0, loadingKey: null, reads: 0, latest: new Map() };

function paneLayoutFor(tabId) {
  const paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"));
  const key = `${tabId}|${paneIds.join(",")}`;
  if (paneLayout.loadingKey !== key && (paneLayout.key !== key || Date.now() - paneLayout.at > PANE_LAYOUT_MAX_AGE_MS)) {
    paneLayout.loadingKey = key;
    const read = ++paneLayout.reads;
    paneLayout.latest.set(key, read);
    paneCalls.layout(paneIds[0])
      .then((payload) => payload?.layout ?? null, () => null)
      .then((layout) => {
        if (paneLayout.latest.get(key) !== read) return;
        paneLayout.latest.delete(key);
        if (paneLayout.loadingKey === key) paneLayout.loadingKey = null;
        // The tab on screen is another now: draw it, which reads its layout.
        if (selectedSplitTabId() !== tabId) {
          if (state.authenticated) renderPaneViews();
          return;
        }
        const before = JSON.stringify(paneLayout.tabId === tabId ? paneLayout.layout ?? null : undefined);
        // A failed read keeps what was known of the same tab.
        const known = layout ?? (paneLayout.tabId === tabId ? paneLayout.layout ?? null : null);
        Object.assign(paneLayout, { key, tabId, layout: known, at: Date.now() });
        if (JSON.stringify(known) !== before) renderPaneViews();
      });
  }
  return paneLayout.tabId === tabId ? paneLayout.layout : undefined;
}

function forgetPaneLayout() {
  paneLayout.latest.clear();
  paneLayout.loadingKey = null;
  paneLayout.at = 0;
  paneLayout.key = "";
}

const paneGrid = createPaneGrid({
  host: elements.terminalStage,
  xterm,
  credentials: () => ({ csrf: state.csrfToken, launchToken: state.launchToken }),
  fontSize: state.terminalFontSize,
  fit: readGridFit(panePreferenceStorage),
  manualFont: readGridFont(panePreferenceStorage),
  onFontChange: (font) => {
    writeGridFont(panePreferenceStorage, font);
    syncSettingsMenu();
  },
  menuFor: paneGridMenu,
  onSelect: (paneId) => selectPane(paneId, { fromGrid: true }),
  onExpand: (paneId) => {
    selectPane(paneId, { view: "solo" });
    focusComposer();
  },
  onUnzoom: (paneId) => void paneGridAction(paneId, "zoom", { mode: "toggle" }),
  onRearrange: (drop) => void rearrangeGridPanes(drop),
  canRearrange: () => !state.mutationBusy,
  onAuthenticationRequired: () => showLogin(),
  terminalOptions: {
    // A pinch on a cell that sizes its pane sets the terminal font, as on a pane alone.
    onFontSizeChange: applyTerminalFontSize,
    isLinkablePath: isLinkableTerminalPath,
    onPath: openTerminalPath,
    onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
  },
});

// --- This window's own view split (view-split.js) --------------------------
// Panes of other projects side by side, for this browser window alone: Herdr
// is never asked to move or close anything, other devices never see it.

// The tiles: the Herdr grid's cells in view mode, each its own socket at the
// pane's own size. ⤢ opens a tile's pane alone (with Back to split view), ✕
// takes the tile out of the view and leaves the pane as it is.
const viewGrid = createPaneGrid({
  host: elements.terminalStage,
  xterm,
  credentials: () => ({ csrf: state.csrfToken, launchToken: state.launchToken }),
  fontSize: state.terminalFontSize,
  mode: "view",
  menuFor: viewTileMenu,
  onSelect: (paneId) => selectPane(paneId, { fromGrid: true }),
  onExpand: (paneId) => {
    selectPane(paneId, { view: "solo" });
    focusComposer();
  },
  onRearrange: (drop) => rearrangeViewTiles(drop),
  onAuthenticationRequired: () => showLogin(),
  terminalOptions: {
    isLinkablePath: isLinkableTerminalPath,
    onPath: openTerminalPath,
    onCopy: (ok) => setFeedback(ok ? "Copied." : "Could not copy. Copying needs a secure connection (HTTPS).", !ok),
  },
});

// A tile dragged onto another: the two trade places (its middle) or it goes
// next to that tile on a side. This window's layout alone: Herdr hears
// nothing. The dragged tile stays selected and keeps the typing.
function rearrangeViewTiles({ paneId, targetPaneId, kind, side }) {
  const next = kind === "swap" ? swapTiles(viewSplit.tree, paneId, targetPaneId)
    : moveTile(viewSplit.tree, paneId, targetPaneId, side);
  if (!next || next === viewSplit.tree) return;
  viewSplit.focus = paneId;
  setViewSplit(next, true);
  if (state.selectedPaneId !== paneId) selectPane(paneId, { view: "tiles" });
  else renderPaneViews();
  viewGrid.focus(paneId);
}

// The grid on screen, the Herdr tab's or the view split's, or null.
function shownGrid() {
  return viewGrid.shown ? viewGrid : paneGrid.shown ? paneGrid : null;
}

// Keeps `tree` (null: no view split) and whether it is on screen, here and in
// this window's session storage.
function setViewSplit(tree, shown = viewSplit.shown) {
  viewSplit.tree = tree;
  viewSplit.shown = Boolean(tree) && shown;
  const ids = viewTiles(tree);
  if (!ids.includes(viewSplit.focus)) viewSplit.focus = ids[0] ?? null;
  writeViewSplit(viewSplitStorage, viewSplit);
}

// Whether the view split is on screen now: it is, it was not left for a pane
// alone, the selected pane is one of its tiles, and the screen is wide.
function viewSplitOnScreen() {
  return viewSplit.shown && desktopMedia.matches && viewTiles(viewSplit.tree).includes(state.selectedPaneId);
}

// What each tile says of its pane: as a grid cell, with its project.
function viewTilePanes() {
  const { panes } = snapshotRecords();
  return viewTiles(viewSplit.tree).flatMap((paneId) => {
    const pane = panes.find((item) => idOf(item, "pane_id", "id") === paneId);
    if (!pane) return [];
    const agent = agentForPane(paneId);
    const status = visibleStatusForPane(paneId, agent, pane);
    const records = selectedRecordsFor(paneId);
    return [{
      paneId,
      label: paneDisplayTitle(displayTabLabel(records.tab), pane, "Terminal", agent),
      context: displayRecordLabel(records.workspace, "Project"),
      status,
      statusIcon: agentStatusIcon(status),
      statusText: agentStatusLabel(status),
    }];
  });
}

const REMOVE_TILE_ICON = "M6 6l12 12M18 6 6 18";

// A tile's one action besides ⤢: ✕ takes it out of the view. Nothing in Herdr
// is touched (no split, zoom or close here).
function viewTileMenu(pane) {
  const button = createElement("button", { className: "pane-grid-remove" });
  button.type = "button";
  button.setAttribute("aria-label", `Remove ${pane.label} from view`);
  button.title = "Remove from view";
  button.append(createIcon([REMOVE_TILE_ICON]));
  button.addEventListener("click", () => removeViewTile(pane.paneId));
  return button;
}

// ✕ on a tile. With one tile left, the view split is over and that pane shows alone.
function removeViewTile(paneId) {
  const before = viewTiles(viewSplit.tree);
  const next = removeTile(viewSplit.tree, paneId);
  if (!next) {
    const remaining = before.find((id) => id !== paneId) ?? state.selectedPaneId;
    closeViewSplit(remaining);
    return;
  }
  setViewSplit(next, true);
  if (state.selectedPaneId === paneId || !viewTiles(next).includes(state.selectedPaneId)) {
    selectPane(viewSplit.focus, { view: "tiles" });
  } else renderPaneViews();
}

// Ends the view split; `paneId` (else the selected pane) shows alone.
function closeViewSplit(paneId = state.selectedPaneId) {
  setViewSplit(null, false);
  if (paneId) selectPane(paneId, { view: "solo" });
  else renderPaneViews();
}

// A session dropped on the pane alone or on a tile becomes a tile beside it,
// on the side it was dropped, and is selected there. On the pane alone a view
// split this window still keeps is carried on when that pane is one of its
// tiles; otherwise the two make a new one.
function addViewTile({ tabId, targetPaneId, side }) {
  const pane = panesOfTab(tabId)[0];
  const paneId = idOf(pane, "pane_id", "id");
  if (!paneId) return;
  const base = viewTiles(viewSplit.tree).includes(targetPaneId) ? viewSplit.tree : null;
  const next = addTile(base, targetPaneId, paneId, side);
  if (!next || next === base) {
    setFeedback(viewTiles(base).length >= 6 ? "A split view shows at most 6 panes." : "This pane is in the split view already.", true);
    if (base) selectPane(targetPaneId, { view: "tiles" });
    return;
  }
  setViewSplit(next, true);
  viewSplit.focus = paneId;
  selectPane(paneId, { view: "tiles" });
}

// Tiles whose panes are gone leave the view; with fewer than two left it is
// over. The selected pane, gone with its tile, gives way to another tile.
function pruneViewSplit(paneIds) {
  if (!viewSplit.tree || paneIds.length === 0) return;
  const before = viewTiles(viewSplit.tree);
  const next = pruneViewTiles(viewSplit.tree, paneIds);
  const after = viewTiles(next);
  if (after.length === before.length) return;
  const selectedGone = before.includes(state.selectedPaneId) && !paneIds.includes(state.selectedPaneId);
  const survivor = before.find((id) => paneIds.includes(id)) ?? null;
  setViewSplit(next);
  if (selectedGone && survivor) {
    state.selectedPaneId = next ? viewSplit.focus : survivor;
    syncComposerDraft();
  }
}

elements.viewBack.addEventListener("click", () => {
  if (!viewSplit.tree) return;
  selectPane(viewSplit.focus ?? viewTiles(viewSplit.tree)[0], { view: "tiles" });
});
elements.viewClose.addEventListener("click", () => closeViewSplit());

// Which screen a session dropped from the sidebar lands on.
function paneDropScreen() {
  return viewGrid.shown ? "tiles" : paneGrid.shown ? "grid" : "solo";
}

function paneDropKindFor(tabId, targetPaneId, screen = paneDropScreen()) {
  return paneDropKind(state.snapshot, { tabId, targetPaneId }, {
    screen,
    tileIds: viewTiles(viewSplit.tree),
    paneMoveAllowed: () => Boolean(paneMoveRequest(state.snapshot, { tabId, targetPaneId, side: "right" })),
  });
}

// A session dropped on a pane's edge: Herdr's own merge for a session of the
// pane's project, this window's view split for another project's (or any on
// a view split).
function dropOnPane(drop) {
  const kind = paneDropKindFor(drop.tabId, drop.targetPaneId);
  if (kind === "move") void movePaneIntoSplit(paneMoveRequest(state.snapshot, drop));
  else if (kind === "view") addViewTile(drop);
}

// The split tab whose grid is on screen, what renderPaneViews last answered,
// and what the phone's map last drew.
let shownGridTabId = null;
let shownPaneView = null;
let paneMapKey = "";

// Draws the grid (a Herdr tab's or this window's view split), the map and
// the Back to grid and Back to split view controls for the selected pane, and
// answers what is shown as a grid: the tab's id, "view" for the view split,
// null for one pane alone.
function renderPaneViews() {
  const tilesShown = viewSplitOnScreen();
  const splitTabId = tilesShown ? null : selectedSplitTabId();
  const gridTab = tilesShown ? null : gridTabId();
  const showMap = Boolean(splitTabId) && !desktopMedia.matches;
  // Read only for a grid or a map on screen: a pane shown alone needs none.
  const layout = gridTab || showMap ? paneLayoutFor(splitTabId) : undefined;
  const panes = splitTabId ? splitTabPanes(splitTabId) : [];
  elements.paneMap.hidden = !showMap;
  if (showMap) {
    const key = JSON.stringify([state.selectedPaneId, layout, panes]);
    if (key !== paneMapKey) {
      paneMapKey = key;
      renderPaneMap(elements.paneMap, {
        layout,
        panes,
        selectedPaneId: state.selectedPaneId,
        onPick: (paneId) => selectPane(paneId),
      });
    }
  } else paneMapKey = "";
  // The find bar lies over the terminal's top corner: below the map, not on it.
  elements.terminalStage.style.setProperty("--pane-map-clearance", showMap ? `${elements.paneMap.offsetHeight + 8}px` : "0px");
  elements.gridBack.hidden = !(splitTabId && desktopMedia.matches && !gridTab);
  elements.viewBack.hidden = !(viewSplit.tree && desktopMedia.matches && !tilesShown);
  elements.viewClose.hidden = !tilesShown;
  elements.terminalPanel.classList.toggle("is-grid", Boolean(gridTab) || tilesShown);
  if (gridTab) paneGrid.show({ panes, layout, selectedPaneId: state.selectedPaneId });
  else if (paneGrid.shown) paneGrid.hide();
  if (tilesShown) {
    if (viewSplit.focus !== state.selectedPaneId) {
      viewSplit.focus = state.selectedPaneId;
      writeViewSplit(viewSplitStorage, viewSplit);
    }
    viewGrid.show({ panes: viewTilePanes(), layout: layoutRects(viewSplit.tree), selectedPaneId: state.selectedPaneId });
  } else if (viewGrid.shown) viewGrid.hide();
  shownGridTabId = gridTab;
  // A notification left waiting on a zoomed-out cell is done once a layout
  // read shows that cell.
  if ((gridTab || tilesShown) && state.renderedGrid && notificationNavigation.relayTarget) void completeNotificationRelay();
  shownPaneView = gridTab ?? (tilesShown ? "view" : null);
  return shownPaneView;
}

// Makes `paneId` the selected pane: the sidebar, the heading, the composer and
// the key bar all follow it. `view` ("grid" or "solo") is how its tab shows,
// or "tiles" for this window's view split, which "grid" and "solo" leave (it
// stays kept, with Back to split view); left out, the tab keeps its view.
// From a grid cell or a tile nothing is redrawn but the focus ring, so the
// cell keeps the typing.
function selectPane(paneId, { view = null, fromGrid = false } = {}) {
  const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
  if (!pane) return;
  const changed = state.selectedPaneId !== paneId;
  if (changed) resetInputHistoryNavigation();
  state.selectedPaneId = paneId;
  syncComposerDraft();
  state.preferredPaneId = paneId;
  writePanePreference(panePreferenceStorage, paneId);
  acknowledgePaneCompletion(paneId);
  setFeedback("");
  const tabId = idOf(pane, "tab_id", "tabId");
  if (tabId) state.lastPaneOfTab.set(tabId, paneId);
  if (view === "grid") state.paneViews.set(tabId, "grid");
  else if (view === "solo") state.paneViews.delete(tabId);
  if (viewSplit.tree && view) setViewSplit(viewSplit.tree, view === "tiles");
  renderNavigation();
  const selected = selectedRecords();
  renderPaneHeading(selected.pane, selected.tab, selected.workspace);
  if (fromGrid) {
    shownGrid()?.focus(paneId, { terminal: false });
    void refreshTerminal();
    return;
  }
  const leavingGrid = shownGridTabId || viewGrid.shown;
  if (!gridTabId() && !viewSplitOnScreen() && (changed || leavingGrid)) showTerminalMessage("Loading output…");
  void refreshTerminal();
}

// The pane a split tab opens on, and whose title and mark its row wears: the
// selected pane when it is there, else the one last selected there, else the
// one Herdr has focused, else its first.
function splitTabFocusPaneId(tabId, paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"))) {
  const candidates = [state.selectedPaneId, state.lastPaneOfTab.get(tabId), state.snapshot?.focused_pane_id];
  return candidates.find((paneId) => paneId && paneIds.includes(paneId)) ?? paneIds[0] ?? null;
}

// Opens a split tab as a grid, on its focus pane (see splitTabFocusPaneId).
function openPaneGrid(tabId) {
  const paneId = splitTabFocusPaneId(tabId);
  if (!paneId) return;
  selectPane(paneId, { view: "grid" });
  closeMobileSidebar();
}

// A split session's row: the grid on a wide screen; on a phone, which has no
// grid, its focus pane alone with the pane map over it. A connected PC's
// split tab has no grid here, so it opens that pane alone too.
function openSplitSession(tabId) {
  const tabPanes = panesOfTab(tabId);
  if (tabPanes.length === 0) return;
  if (desktopMedia.matches && isLocalRecord(tabPanes[0])) {
    openPaneGrid(tabId);
    return;
  }
  const paneId = splitTabFocusPaneId(tabId);
  selectPane(paneId, { view: "solo" });
  closeMobileSidebar();
}

elements.gridBack.addEventListener("click", () => {
  const tabId = selectedSplitTabId();
  if (tabId) openPaneGrid(tabId);
});

// A split session's name: its tab's, else its focus pane's title, else "Split session".
function splitSessionName(tabId, tabLabel, tabPanes) {
  if (tabLabel) return tabLabel;
  const paneId = splitTabFocusPaneId(tabId, tabPanes.map((pane) => idOf(pane, "pane_id", "id")));
  const pane = tabPanes.find((item) => idOf(item, "pane_id", "id") === paneId);
  return paneDisplayTitle("", pane, "", agentForPane(paneId)) || "Split session";
}

// A split session is one row in the sidebar, as a one-pane session is: its
// focus pane's mark, its name, the number of panes, and the most urgent status
// of them. It is shown selected while any of its panes is.
function splitSessionButton(tabId, name, tabPanes, workspace) {
  const paneIds = tabPanes.map((pane) => idOf(pane, "pane_id", "id"));
  const focusPaneId = splitTabFocusPaneId(tabId, paneIds);
  const focusPane = tabPanes.find((pane) => idOf(pane, "pane_id", "id") === focusPaneId);
  const status = mostUrgentStatus(tabPanes.map((pane) => {
    const paneId = idOf(pane, "pane_id", "id");
    return visibleStatusForPane(paneId, agentForPane(paneId), pane);
  }));
  const statusText = agentStatusLabel(status);
  const button = createElement("button", { className: "pane-button split-session-button" });
  button.type = "button";
  button.dataset.tabId = tabId;
  button.dataset.status = status;
  button.setAttribute("aria-pressed", String(paneIds.includes(state.selectedPaneId)));
  const where = displayRecordLabel(workspace, "Project");
  button.setAttribute(
    "aria-label",
    `${name}, split session, ${paneIds.length} panes, ${statusText}, ${where}`,
  );
  button.title = `${name} · ${paneIds.length} panes · ${statusText}`;
  // Its mark column holds the arrow (laid over it, see splitDisclosureButton):
  // the focus pane's mark is drawn only in the folded sidebar's rail, which
  // has no arrow.
  button.append(agentMark(paneAgentKind(focusPane, agentForPane(focusPaneId))));
  const copy = createElement("span", { className: "pane-copy" });
  copy.append(createElement("strong", { className: "pane-title", text: name }));
  const subtitle = paneSubtitle(name, focusPane);
  if (subtitle) copy.append(createElement("small", { className: "pane-cwd", text: subtitle }));
  const badge = createElement("span", { className: "split-badge" });
  badge.setAttribute("aria-hidden", "true");
  badge.append(createIcon(GRID_ICON), createElement("span", { text: String(paneIds.length) }));
  const statusMark = createElement("span", {
    className: `pane-status ui-status state-${status}`,
    text: agentStatusIcon(status),
  });
  statusMark.setAttribute("aria-hidden", "true");
  button.append(copy, badge, statusMark);
  button.addEventListener("click", () => openSplitSession(tabId));
  return button;
}

// The arrow at the start of a split session's row, in the column the other
// rows' program marks sit in: shows or hides its panes under it. Folded until
// opened; which are open is kept in this browser. A pane selected in a folded
// session does not open it: the row shows it selected.
function splitDisclosureButton(tabGroup, tabId, name, paneList) {
  const expanded = state.expandedSplitTabIds.has(tabId);
  const labelFor = (open) => `${open ? "Hide" : "Show"} the panes of ${name}`;
  const button = workspaceActionButton({
    className: "split-disclosure",
    label: labelFor(expanded),
    paths: ["M9 18l6-6-6-6"],
  });
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-controls", paneList.id);
  button.addEventListener("click", () => {
    const open = !state.expandedSplitTabIds.has(tabId);
    if (open) state.expandedSplitTabIds.add(tabId);
    else state.expandedSplitTabIds.delete(tabId);
    tabGroup.classList.toggle("is-expanded", open);
    paneList.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", labelFor(open));
    button.title = labelFor(open);
    writeExpandedSplitTabIds(panePreferenceStorage, state.expandedSplitTabIds);
  });
  return button;
}

const SPLIT_RIGHT_ICON = ["M4 5h16v14H4z", "M12 5v14"];
const SPLIT_DOWN_ICON = ["M4 5h16v14H4z", "M4 12h16"];
const ZOOM_ICON = ["M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"];
const UNZOOM_ICON = ["M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"];
const MOVE_OUT_ICON = ["M14 4h6v6", "M20 4l-8 8", "M19 14v5H5V5h5"];
const SEPARATE_ICON = ["M3 5h7v14H3z", "M14 5h7v14h-7z"];
const EVEN_ICON = ["M3 5h18v14H3z", "M9 5v14", "M15 5v14"];

// A pane's actions, the same in a grid cell's ⋯ and a split session's pane
// row in the sidebar.
function paneActions(paneId, zoomed) {
  return [
    { key: "split-right", label: "Split right", paths: SPLIT_RIGHT_ICON,
      onSelect: () => void paneGridAction(paneId, "split", { direction: "right" }) },
    { key: "split-down", label: "Split down", paths: SPLIT_DOWN_ICON,
      onSelect: () => void paneGridAction(paneId, "split", { direction: "down" }) },
    { key: "zoom", label: zoomed ? "Unzoom" : "Zoom", paths: zoomed ? UNZOOM_ICON : ZOOM_ICON,
      onSelect: () => void paneGridAction(paneId, "zoom", { mode: "toggle" }) },
    { key: "even-layout", label: "Even out layout", paths: EVEN_ICON,
      onSelect: () => void evenOutLayout(paneId) },
    { key: "move-out", label: "Move out to its own session", paths: MOVE_OUT_ICON,
      onSelect: () => void movePanesOut([paneId]) },
    { separator: true },
    { key: "close", label: "Close pane", paths: ["M6 6l12 12M18 6 6 18"], danger: true,
      onSelect: () => void closePaneFromGrid(paneId) },
  ];
}

function paneGridMenu(pane, zoomed) {
  return sidebarActionMenu({
    id: `grid-${pane.paneId}`,
    label: `More actions for ${pane.label}`,
    className: "pane-grid-menu",
    escapesOverflow: true,
    actions: paneActions(pane.paneId, zoomed),
  });
}

// A pane of a split session in the sidebar's list: its row, and on this
// machine a ⋯ with the grid cell's actions, laid over the row's right padding
// as every session row's is. Zoom reads Unzoom when the layout last read of
// its tab (the tab on screen) says it is zoomed.
function splitPaneRow(pane, tab, workspace, local) {
  const row = createElement("div", { className: "split-pane-row" });
  const button = paneButton(pane, tab, workspace);
  row.append(button);
  if (!local) return row;
  const paneId = button.dataset.paneId;
  const tabId = idOf(pane, "tab_id", "tabId");
  const layout = paneLayout.tabId === tabId ? paneLayout.layout : null;
  const zoomed = Boolean(layout?.zoomed);
  row.append(sidebarActionMenu({
    id: `split-pane-${paneId}`,
    label: `More actions for ${paneDisplayTitle("", pane, "Terminal", agentForPane(paneId))}`,
    className: "session-action-menu split-pane-menu",
    actions: paneActions(paneId, zoomed),
  }));
  return row;
}

// Takes panes out of their split session, one after another, each into a
// session of its own in the same project. A pane Herdr renames is followed
// (what the page keeps under its id, and the selection). A session left with
// one pane shows it alone again. The first refusal stops the rest and is said
// in the feedback line; the sidebar is read once at the end.
async function movePanesOut(paneIds) {
  if (paneIds.length === 0) return;
  if (state.mutationBusy) {
    setFeedback("Another change is still in progress. Try again in a moment.", true);
    return;
  }
  const fromTabId = paneTabId(paneIds[0]);
  let left = panesOfTab(fromTabId).length;
  state.mutationBusy = true;
  setFeedback("");
  let refusal = "";
  try {
    for (const paneId of paneIds) {
      try {
        const result = await paneCalls.moveOut(paneId);
        left -= 1;
        const movedTo = typeof result?.pane_id === "string" ? result.pane_id : paneId;
        if (movedTo !== paneId) {
          followMovedPaneState([{ from: paneId, to: movedTo }]);
          if (state.selectedPaneId === paneId) {
            state.selectedPaneId = movedTo;
            state.preferredPaneId = movedTo;
            writePanePreference(panePreferenceStorage, movedTo);
          }
        }
      } catch (error) {
        refusal = error.message;
        break;
      }
    }
  } finally {
    state.mutationBusy = false;
  }
  if (fromTabId && left <= 1) state.paneViews.delete(fromTabId);
  await refreshAfterPaneChange();
  void refreshTerminal();
  if (refusal) setFeedback(refusal, true);
}

// "Even out layout": the panes of `paneId`'s split session take equal shares
// of it. Herdr resizes them, so every device sees it; the grid re-reads the
// layout and its cells slide to their new places. Said in the feedback line:
// evened out, or why not (Herdr's reason, or a layout it could only partly
// even out or had to put back).
async function evenOutLayout(paneId) {
  if (state.mutationBusy) {
    setFeedback("Another change is still in progress. Try again in a moment.", true);
    return;
  }
  state.mutationBusy = true;
  setFeedback("");
  let notice;
  let failed = false;
  try {
    const result = await paneCalls.evenLayout(paneId);
    if (result?.even === false) {
      notice = result.message || "Could not even out the layout.";
      failed = true;
    } else notice = result?.changed === false ? "The panes are already even." : "Layout evened out.";
  } catch (error) {
    notice = error.message;
    failed = true;
  } finally {
    state.mutationBusy = false;
  }
  await refreshAfterPaneChange();
  void refreshTerminal();
  setFeedback(notice, failed);
}

// The split session's ⋯ "Separate all panes": every pane but the first to a
// session of its own, once the user says so.
function separateSplitSession(tabId, name) {
  const paneIds = panesOfTab(tabId).map((pane) => idOf(pane, "pane_id", "id"));
  if (paneIds.length < 2) return;
  const count = paneIds.length;
  if (!window.confirm(`Separate the ${count} panes of “${name}” into ${count} sessions? Each pane keeps running; only the split is undone.`)) return;
  void movePanesOut(paneIds.slice(1));
}

function closePaneFromGrid(paneId) {
  const pane = snapshotRecords().panes.find((item) => idOf(item, "pane_id", "id") === paneId);
  if (!pane) return;
  const status = agentStatus(agentForPane(paneId), pane);
  const last = panesOfTab(idOf(pane, "tab_id", "tabId")).length <= 1;
  const label = paneDisplayTitle("", pane, "Terminal", agentForPane(paneId));
  const reason = last ? " It is the session's last pane, so the session closes too."
    : status === "working" ? " Its agent is still working."
    : status === "blocked" ? " Its agent is waiting for your answer." : "";
  if ((last || status === "working" || status === "blocked") &&
      !window.confirm(`Close pane “${label}”?${reason} This stops any running processes in it.`)) return;
  // The server closes a pane only when told the user meant it.
  void paneGridAction(paneId, "close", { confirmed: true });
}

// Runs a pane action from the grid (split, zoom, close) and shows the result:
// a split selects the new pane; a refusal (no room for another pane) is said
// in the feedback line.
async function paneGridAction(paneId, action, body = {}) {
  if (state.mutationBusy) {
    setFeedback("Another change is still in progress. Try again in a moment.", true);
    return;
  }
  state.mutationBusy = true;
  setFeedback("");
  let result = null;
  // Closing the selected pane leaves the selection on a neighbour in its tab,
  // not on whatever pane the page would fall back to.
  const siblings = panesOfTab(paneTabId(paneId)).map((pane) => idOf(pane, "pane_id", "id"));
  const at = siblings.indexOf(paneId);
  const neighbour = siblings[at + 1] ?? siblings[at - 1] ?? null;
  try {
    result = await paneCalls.act(paneId, action, body);
    if (action === "close" && state.selectedPaneId === paneId && neighbour) {
      state.selectedPaneId = neighbour;
      state.preferredPaneId = neighbour;
      writePanePreference(panePreferenceStorage, neighbour);
      syncComposerDraft();
    }
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
  }
  await refreshAfterPaneChange();
  const added = typeof result?.pane_id === "string" ? result.pane_id : null;
  if (action === "split" && added && snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === added)) {
    selectPane(added, { fromGrid: shownGridTabId !== null });
  } else void refreshTerminal();
}

// The panes a session dragged from the sidebar may join now: the grid's cells,
// or the pane shown alone. A phone has neither (its sidebar is a drawer over
// them), and a session that may not join (several panes, another machine or
// Herdr session, the pane itself) gets none.
function paneDropTargets(tabId) {
  if (!desktopMedia.matches || state.mutationBusy) return [];
  const screen = paneDropScreen();
  const targets = screen !== "solo"
    ? [...elements.terminalStage.querySelectorAll(".pane-grid:not([hidden]) .pane-grid-cell:not([hidden])")]
      .map((element) => ({ paneId: element.dataset.paneId, element }))
    : state.selectedPaneId ? [{ paneId: state.selectedPaneId, element: elements.terminalStage }] : [];
  return targets.filter(({ paneId }) => paneDropKindFor(tabId, paneId, screen));
}

// After a pane is split, closed, zoomed or moved: the layout and the snapshot
// are read again. A snapshot already on its way was asked for before the
// change, so it is waited out first.
async function refreshAfterPaneChange() {
  forgetPaneLayout();
  await snapshotSettled;
  await refreshSnapshot();
}

// Moves a session's one pane next to another pane, into that pane's tab. The
// pane comes back under a new id: what the page keeps under its id follows it,
// and it is selected in the grid of the tab it joined. A refusal (Herdr has
// no room there) is said in the feedback line, and so is a pane that moved
// but could not then be swapped to the left or the top (`placed` false).
async function movePaneIntoSplit(request) {
  if (!request || state.mutationBusy) return;
  const targetTabId = paneTabId(request.body.targetPaneId);
  state.mutationBusy = true;
  setFeedback("");
  let movedTo = null;
  let unplaced = null;
  try {
    const result = await paneCalls.move(request.paneId, request.body);
    movedTo = typeof result?.pane_id === "string" ? result.pane_id : null;
    if (movedTo && movedTo !== request.paneId) {
      followMovedPaneState([{ from: request.paneId, to: movedTo }]);
      if (state.selectedPaneId === request.paneId) state.selectedPaneId = movedTo;
    }
    if (movedTo && targetTabId) state.paneViews.set(targetTabId, "grid");
    if (movedTo && result?.placed === false) {
      unplaced = `Moved, but could not put it on the ${request.body.side === "up" ? "top" : "left"}.`;
    }
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    state.mutationBusy = false;
  }
  await refreshAfterPaneChange();
  if (movedTo && snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === movedTo)) {
    selectPane(movedTo, { view: "grid" });
  } else void refreshTerminal();
  // After the selection, which clears the feedback line.
  if (unplaced) setFeedback(unplaced, true);
}

// A cell of a Herdr grid dragged onto another of the same tab: the two swap
// places (dropped in its middle), or it moves next to it on a side (Herdr
// lifts it out of the tab and splits it back in there). The pane stays
// selected in the grid; should Herdr answer it under another id, what the
// page keeps under its id follows it. A relocate that could not finish says
// where the pane is now (`placed` false: put back in its session, or in a
// session of its own).
async function rearrangeGridPanes({ paneId, targetPaneId, kind, side }) {
  if (state.mutationBusy || !shownGridTabId || paneTabId(paneId) !== shownGridTabId || paneTabId(targetPaneId) !== shownGridTabId) return;
  const tabId = shownGridTabId;
  state.mutationBusy = true;
  setFeedback("");
  let finalId = paneId;
  let notice = null;
  try {
    const result = kind === "swap"
      ? await paneCalls.swap(paneId, targetPaneId)
      : await paneCalls.relocate(paneId, targetPaneId, side);
    if (typeof result?.pane_id === "string" && result.pane_id !== paneId) {
      finalId = result.pane_id;
      followMovedPaneState([{ from: paneId, to: finalId }]);
      if (state.selectedPaneId === paneId) state.selectedPaneId = finalId;
    }
    if (result?.placed === false) notice = result.message || "Could not move the pane there.";
  } catch (error) {
    notice = error.message;
  } finally {
    state.mutationBusy = false;
  }
  await refreshAfterPaneChange();
  if (snapshotRecords().panes.some((item) => idOf(item, "pane_id", "id") === finalId)) {
    // Left in a session of its own, it shows there, alone.
    const inGrid = paneTabId(finalId) === tabId;
    selectPane(finalId, inGrid ? { fromGrid: true } : { view: "solo" });
    if (inGrid) paneGrid.focus(finalId);
  } else void refreshTerminal();
  // After the selection, which clears the feedback line.
  if (notice) setFeedback(notice, true);
}

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
